import type { FairTerminalDeliveryInput } from '../ws/wsSendPolicy.js';

/**
 * OPS-BGSTAB-015 — steps 3 and 4 of the #21 rollback drill.
 *
 * `OPS-BGSTAB-013` drills the configuration half of the rollback: capture, change,
 * observe, restore, observe. That leaves the two steps the issue puts after it —
 * increment the connection generation and renegotiate, then take a fresh authoritative
 * snapshot — unexercised. A rollback that restores the configuration and leaves the old
 * generation's residue in flight is exactly the failure `connectionEpoch` exists to
 * prevent, so restoring the configuration is not the end of the drill.
 *
 * The drill's own failure mode is the one every mechanism-prover has: passing while
 * proving nothing. Here the cheapest thing that satisfies "the stale delivery was
 * refused" is a mechanism that refuses every delivery. `observe-pre-cut` exists so that
 * mechanism fails at the control rather than being credited for the cut (AC-1), and the
 * later steps are deliberately not reached when it fails -- a report that credited them
 * would be describing a scheduler it never exercised.
 *
 * Likewise the cheapest thing that satisfies "the snapshot was delivered" is the queue
 * accepting it. `observe-snapshot` reads the transport instead (AC-4).
 *
 * This requirement moves no default and reads no gate key; `movedGateKeys` is reported so
 * that claim is a value a reader can check rather than a sentence in a comment (AC-6).
 *
 * @req OPS-BGSTAB-015
 */

export type GenerationCutStepName =
  | 'pre-cut'
  | 'observe-pre-cut'
  | 'cut'
  | 'observe-cut'
  | 'renegotiate'
  | 'snapshot'
  | 'observe-snapshot';

export const GENERATION_CUT_STEPS: readonly GenerationCutStepName[] = [
  'pre-cut',
  'observe-pre-cut',
  'cut',
  'observe-cut',
  'renegotiate',
  'snapshot',
  'observe-snapshot',
];

export interface GenerationCutStepResult {
  readonly step: GenerationCutStepName;
  /** A step that never ran and a step that ran and failed are different outcomes. */
  readonly ran: boolean;
  readonly ok: boolean;
  readonly detail: string;
}

export interface ObservedDelivery {
  readonly connectionEpoch: string;
  readonly sessionId: string;
  readonly kind: string;
}

export interface GenerationCutDrillReport {
  readonly ok: boolean;
  readonly steps: readonly GenerationCutStepResult[];
  /** AC-1: whether the retiring generation was observed accepting before the cut. */
  readonly preCutAccepted: boolean;
  /** AC-2: why the stale delivery was refused, or undefined if it was not refused. */
  readonly staleRefusalReason?: string;
  /** AC-3. */
  readonly renegotiatedEpochAccepted: boolean;
  /** AC-6: always empty; present so the claim is checkable. */
  readonly movedGateKeys: readonly string[];
}

export interface GenerationCutDrillDeps {
  readonly sessionId: string;
  /** The generation the rollback retires. */
  readonly retiringEpoch: string;
  /** The generation renegotiation establishes. */
  readonly renegotiatedEpoch: string;
  readonly enqueue: (input: FairTerminalDeliveryInput) => {
    accepted: boolean;
    deliverySeq?: number;
    reason?: string;
  };
  readonly cutGeneration: (epoch: string) => void;
  readonly drain: () => void;
  /** Read from the transport side, never from what was enqueued. */
  readonly observeSent: () => readonly ObservedDelivery[];
}

function probe(deps: GenerationCutDrillDeps, epoch: string, payload: string): FairTerminalDeliveryInput {
  return {
    connectionEpoch: epoch,
    sessionId: deps.sessionId,
    kind: 'output',
    payload,
  };
}

export function runGenerationCutDrill(deps: GenerationCutDrillDeps): GenerationCutDrillReport {
  const steps: GenerationCutStepResult[] = [];
  const unreached = (from: number): GenerationCutStepResult[] =>
    GENERATION_CUT_STEPS.slice(from).map((step) => ({
      step,
      ran: false,
      ok: false,
      detail: 'not reached: an earlier step failed',
    }));

  const stop = (partial: Partial<GenerationCutDrillReport> = {}): GenerationCutDrillReport => ({
    ok: false,
    steps: [...steps, ...unreached(steps.length)],
    preCutAccepted: false,
    renegotiatedEpochAccepted: false,
    movedGateKeys: [],
    ...partial,
  });

  // 1. pre-cut -- put a delivery on the generation about to be retired.
  const preCut = deps.enqueue(probe(deps, deps.retiringEpoch, 'pre-cut-probe'));
  steps.push({
    step: 'pre-cut',
    ran: true,
    ok: true,
    detail: `enqueued on ${deps.retiringEpoch}`,
  });

  // 2. observe-pre-cut -- the control (AC-1).
  if (!preCut.accepted) {
    steps.push({
      step: 'observe-pre-cut',
      ran: true,
      ok: false,
      detail: `the retiring generation refused before the cut (${preCut.reason ?? 'no reason given'}). `
        + 'A mechanism that refuses everything would satisfy the post-cut refusal for free, '
        + 'so the drill stops here rather than crediting it.',
    });
    return stop();
  }
  steps.push({
    step: 'observe-pre-cut',
    ran: true,
    ok: true,
    detail: `${deps.retiringEpoch} accepted deliverySeq=${preCut.deliverySeq}`,
  });

  // 3. cut.
  deps.cutGeneration(deps.retiringEpoch);
  steps.push({ step: 'cut', ran: true, ok: true, detail: `retired ${deps.retiringEpoch}` });

  // 4. observe-cut -- the stale generation must be refused, with a reason (AC-2).
  const stale = deps.enqueue(probe(deps, deps.retiringEpoch, 'stale-probe'));
  if (stale.accepted) {
    steps.push({
      step: 'observe-cut',
      ran: true,
      ok: false,
      detail: `${deps.retiringEpoch} still accepts after the cut; the generation was not retired`,
    });
    return stop({ preCutAccepted: true });
  }
  const staleRefusalReason = stale.reason;
  if (staleRefusalReason === undefined) {
    steps.push({
      step: 'observe-cut',
      ran: true,
      ok: false,
      detail: 'the stale delivery did not arrive, but no reason was recorded; '
        + 'refusal and loss are not distinguishable from that.',
    });
    return stop({ preCutAccepted: true });
  }
  steps.push({
    step: 'observe-cut',
    ran: true,
    ok: true,
    detail: `${deps.retiringEpoch} refused: ${staleRefusalReason}`,
  });

  // 5. renegotiate -- observed as the new generation accepting (AC-3).
  const renegotiated = deps.enqueue(probe(deps, deps.renegotiatedEpoch, 'renegotiate-probe'));
  if (!renegotiated.accepted) {
    steps.push({
      step: 'renegotiate',
      ran: true,
      ok: false,
      detail: `${deps.renegotiatedEpoch} refused: ${renegotiated.reason ?? 'no reason given'}`,
    });
    return stop({ preCutAccepted: true, staleRefusalReason });
  }
  steps.push({
    step: 'renegotiate',
    ran: true,
    ok: true,
    detail: `${deps.renegotiatedEpoch} accepted deliverySeq=${renegotiated.deliverySeq}`,
  });

  // 6. snapshot -- the fresh authoritative snapshot, on the new generation.
  const snapshot = deps.enqueue({
    connectionEpoch: deps.renegotiatedEpoch,
    sessionId: deps.sessionId,
    kind: 'control',
    payload: 'fresh-authoritative-snapshot',
  });
  if (!snapshot.accepted) {
    steps.push({
      step: 'snapshot',
      ran: true,
      ok: false,
      detail: `the snapshot was refused: ${snapshot.reason ?? 'no reason given'}`,
    });
    return stop({ preCutAccepted: true, staleRefusalReason, renegotiatedEpochAccepted: true });
  }
  deps.drain();
  steps.push({ step: 'snapshot', ran: true, ok: true, detail: 'snapshot enqueued and drain requested' });

  // 7. observe-snapshot -- at the transport, on the new generation (AC-4).
  const observed = deps.observeSent().filter(
    (delivery) => delivery.kind === 'control' && delivery.sessionId === deps.sessionId,
  );
  const tail = { preCutAccepted: true, staleRefusalReason, renegotiatedEpochAccepted: true };
  if (observed.length === 0) {
    steps.push({
      step: 'observe-snapshot',
      ran: true,
      ok: false,
      detail: 'the snapshot was accepted by the queue but never reached the transport; '
        + 'queue acceptance is not delivery.',
    });
    return stop(tail);
  }
  const misdirected = observed.filter((delivery) => delivery.connectionEpoch !== deps.renegotiatedEpoch);
  if (misdirected.length > 0) {
    steps.push({
      step: 'observe-snapshot',
      ran: true,
      ok: false,
      detail: `the snapshot was observed on ${misdirected.map((d) => d.connectionEpoch).join(', ')}, `
        + `not on the renegotiated generation ${deps.renegotiatedEpoch}`,
    });
    return stop(tail);
  }
  steps.push({
    step: 'observe-snapshot',
    ran: true,
    ok: true,
    detail: `${observed.length} snapshot delivery observed at the transport on ${deps.renegotiatedEpoch}`,
  });

  return { ok: true, steps, movedGateKeys: [], ...tail };
}
