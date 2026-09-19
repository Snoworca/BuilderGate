import { createHash } from 'node:crypto';

/**
 * REL-BGSTAB-028 — server-side exactly-once ledger for terminal input.
 *
 * Before this, `WsRouter.handleInput` validated the message shape, the session,
 * the mutation lease and the replay queue, and then wrote to the PTY — with no
 * step that asked whether the operation had already been written. The wire
 * message carried no operation identifier either, so the question could not be
 * asked. A client that retried an unacknowledged send ran the command twice.
 *
 * The design deliberately mirrors the one dedup mechanism this codebase already
 * has rather than inventing a second: the query-reply path keys on replyOrdinal
 * plus responder identity and reports `duplicate` rather than swallowing it, and
 * the router turns that into an observable receipt. This generalises that shape
 * to ordinary input.
 *
 * Two properties are deliberate:
 *
 * - The ledger is keyed by connection epoch AND session, so a new epoch never
 *   inherits the previous one's history. Reusing it would let a stale retry from
 *   a dead connection suppress a genuine operation on the new one.
 * - Input with no operation identifier is admitted and reported as
 *   `unidentified`, never silently treated as deduplicated. A legacy client that
 *   cannot name its operations gets no exactly-once guarantee, and that has to
 *   be visible rather than assumed.
 */

export type TerminalInputOutcome =
  | 'admitted'
  | 'duplicate'
  | 'expired'
  | 'payload-mismatch'
  | 'unidentified'
  /**
   * #18 criterion 6/7: this operation predates everything still remembered, so the
   * ledger cannot say whether it was applied.
   *
   * Distinct from `expired`, which is a tombstone hit and therefore a POSITIVE fact
   * ("it happened and I evicted the result"). `unknown` is the absence of any record
   * combined with proof that the record could have been dropped. Before this outcome
   * existed the case was silently re-admitted and the command ran a second time --
   * REL-BGSTAB-028's own AC-5 evidence named that window "the honest limit of this
   * design", and criterion 6 forbids precisely it: if you do not know, do not execute.
   */
  | 'unknown';

export interface TerminalInputAdmission {
  /** Whether the caller should write this input to the PTY. */
  write: boolean;
  outcome: TerminalInputOutcome;
}

export interface TerminalInputLedgerKey {
  connectionEpoch: string;
  sessionId: string;
}

export interface TerminalInputAdmissionRequest extends TerminalInputLedgerKey {
  operationId?: string;
  /**
   * The bytes this operation carries, when the caller has them.
   *
   * #18 requires that the same identifier arriving with different bytes be refused as a
   * protocol error rather than deduplicated. Without this the two cases are indistinguishable
   * and the wrong one is silent: a reused id would swallow a command the user actually typed
   * and report nothing. Optional, because an id alone still deduplicates -- the digest
   * tightens the check where a payload is given and must not weaken it where none is.
   */
  payload?: string;
  /**
   * Where this operation sits in the client's ordering, when the client can say.
   *
   * The ledger deliberately treats `operationId` as OPAQUE -- it does not parse the
   * `e{epoch}:{start}-{end}` shape the browser happens to build, because that would tie
   * the server's dedup to a frontend string format. The ordinal arrives as its own field
   * instead, which is also the direction criterion 2 points: operation identity is
   * (connection epoch, session, target generation, operation id / seq range).
   *
   * `epoch` is the SEQUENCER epoch, not the connection epoch. TerminalInputSequencer
   * restarts numbering at 1 on every session attach, so starts are monotonic only within
   * one sequencer epoch and the watermark has to be kept per epoch. Omitted by clients
   * that cannot order their operations; those keep the pre-existing behaviour.
   */
  sequence?: { epoch: number; start: number };
}

export interface TerminalInputLedgerStats {
  /** Operation ids currently remembered. Bounded by maxOperationsPerSession. */
  tracked: number;
  /** Evicted operation ids still remembered as having happened. Bounded the same way. */
  expiredTracked: number;
  admitted: number;
  duplicates: number;
  expired: number;
  /** #18: refusals where the ledger could not say whether the operation had been applied. */
  unknown: number;
  payloadMismatches: number;
  unidentified: number;
}

export interface TerminalInputLedgerOptions {
  /**
   * Bound on remembered operation ids per epoch/session. The ledger must not
   * grow with session lifetime; a retry window of recent operations is what
   * exactly-once actually needs.
   */
  maxOperationsPerSession?: number;
}

export interface TerminalInputLedger {
  admit: (request: TerminalInputAdmissionRequest) => TerminalInputAdmission;
  /** Returns true when there was state to free, false when already released. */
  release: (key: TerminalInputLedgerKey) => boolean;
  releaseEpoch: (connectionEpoch: string) => number;
  snapshot: (key: TerminalInputLedgerKey) => TerminalInputLedgerStats;
}

const DEFAULT_MAX_OPERATIONS_PER_SESSION = 512;

interface LedgerEntry {
  /** Insertion-ordered, so the oldest remembered operation is evicted first. */
  operations: Set<string>;
  /** operationId -> digest of the bytes it was admitted with, for ids that carried any. */
  operationDigests: Map<string, string>;
  /**
   * Operations evicted from `operations`, remembered only as "this happened".
   *
   * #18: without this set, eviction turned the ledger inside out. An operation that had
   * already been written to the PTY, once evicted, was re-admitted on retry and executed a
   * second time -- the precise failure the ledger exists to prevent, reached by the mechanism
   * that was supposed to bound it. Forgetting that an operation was applied must not read as
   * "it never happened"; it reads as "it happened and I can no longer prove the result", which
   * is a refusal, not an admission.
   */
  expiredOperations: Set<string>;
  /** operationId -> its client ordering, for ids that carried one. */
  operationSequences: Map<string, { epoch: number; start: number }>;
  /**
   * sequencerEpoch -> the highest `start` this ledger has FULLY forgotten.
   *
   * A later arrival at or below this line cannot be distinguished from a retry of
   * something already applied, so it is refused as `unknown` rather than re-executed.
   * A genuinely new operation is always above it, because the sequencer is monotonic
   * within an epoch.
   */
  forgottenWatermark: Map<number, number>;
  admitted: number;
  duplicates: number;
  expired: number;
  unknown: number;
  payloadMismatches: number;
  unidentified: number;
}

function digestPayload(payload: string): string {
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

export function createTerminalInputLedger(
  options: TerminalInputLedgerOptions = {},
): TerminalInputLedger {
  const maxOperations = Math.max(
    1,
    options.maxOperationsPerSession ?? DEFAULT_MAX_OPERATIONS_PER_SESSION,
  );
  // epoch -> sessionId -> entry. Nested rather than a composite string key so a
  // session id containing the separator cannot collide with another entry.
  const epochs = new Map<string, Map<string, LedgerEntry>>();

  const entryFor = (key: TerminalInputLedgerKey): LedgerEntry => {
    let sessions = epochs.get(key.connectionEpoch);
    if (!sessions) {
      sessions = new Map();
      epochs.set(key.connectionEpoch, sessions);
    }
    let entry = sessions.get(key.sessionId);
    if (!entry) {
      entry = {
        operations: new Set(),
        operationDigests: new Map(),
        expiredOperations: new Set(),
        operationSequences: new Map(),
        forgottenWatermark: new Map(),
        admitted: 0,
        duplicates: 0,
        expired: 0,
        unknown: 0,
        payloadMismatches: 0,
        unidentified: 0,
      };
      sessions.set(key.sessionId, entry);
    }
    return entry;
  };

  return {
    admit(request: TerminalInputAdmissionRequest): TerminalInputAdmission {
      const entry = entryFor(request);

      if (request.operationId === undefined || request.operationId === '') {
        entry.unidentified += 1;
        return { write: true, outcome: 'unidentified' };
      }

      if (entry.operations.has(request.operationId)) {
        const knownDigest = entry.operationDigests.get(request.operationId);
        if (
          knownDigest !== undefined
          && request.payload !== undefined
          && digestPayload(request.payload) !== knownDigest
        ) {
          entry.payloadMismatches += 1;
          return { write: false, outcome: 'payload-mismatch' };
        }
        entry.duplicates += 1;
        return { write: false, outcome: 'duplicate' };
      }

      if (entry.expiredOperations.has(request.operationId)) {
        entry.expired += 1;
        return { write: false, outcome: 'expired' };
      }

      // #18 criterion 6: no record AND provably old enough to have been forgotten.
      // Checked after the two positive lookups above, which are more specific facts.
      // Without ordering information this branch cannot fire, and the client keeps the
      // pre-existing behaviour rather than having input refused on a guess.
      if (request.sequence) {
        const watermark = entry.forgottenWatermark.get(request.sequence.epoch);
        if (watermark !== undefined && request.sequence.start <= watermark) {
          entry.unknown += 1;
          return { write: false, outcome: 'unknown' };
        }
      }

      entry.operations.add(request.operationId);
      if (request.sequence) {
        entry.operationSequences.set(request.operationId, request.sequence);
      }
      if (request.payload !== undefined) {
        entry.operationDigests.set(request.operationId, digestPayload(request.payload));
      }
      if (entry.operations.size > maxOperations) {
        const oldest = entry.operations.values().next();
        if (!oldest.done) {
          entry.operations.delete(oldest.value);
          entry.operationDigests.delete(oldest.value);
          entry.expiredOperations.add(oldest.value);
          if (entry.expiredOperations.size > maxOperations) {
            // The tombstone set is bounded too, so an operation old enough to fall out of
            // both is admitted again. That window is the honest limit of this design and is
            // recorded rather than hidden: it takes 2 * maxOperationsPerSession further
            // operations on one connection before a retry can re-execute.
            const oldestTombstone = entry.expiredOperations.values().next();
            if (!oldestTombstone.done) {
              entry.expiredOperations.delete(oldestTombstone.value);
              // #18: this id is now FULLY forgotten. Raise the watermark so a later
              // retry of it is refused as `unknown` instead of re-executing. This is
              // what closes the window REL-BGSTAB-028 AC-5 documented but could not shut.
              const forgotten = entry.operationSequences.get(oldestTombstone.value);
              if (forgotten) {
                const previous = entry.forgottenWatermark.get(forgotten.epoch) ?? 0;
                entry.forgottenWatermark.set(
                  forgotten.epoch,
                  Math.max(previous, forgotten.start),
                );
              }
              entry.operationSequences.delete(oldestTombstone.value);
            }
          }
        }
      }
      entry.admitted += 1;
      return { write: true, outcome: 'admitted' };
    },

    release(key: TerminalInputLedgerKey): boolean {
      const sessions = epochs.get(key.connectionEpoch);
      if (!sessions) {
        return false;
      }
      const removed = sessions.delete(key.sessionId);
      if (sessions.size === 0) {
        epochs.delete(key.connectionEpoch);
      }
      return removed;
    },

    releaseEpoch(connectionEpoch: string): number {
      const sessions = epochs.get(connectionEpoch);
      if (!sessions) {
        return 0;
      }
      const released = sessions.size;
      epochs.delete(connectionEpoch);
      return released;
    },

    snapshot(key: TerminalInputLedgerKey): TerminalInputLedgerStats {
      const entry = epochs.get(key.connectionEpoch)?.get(key.sessionId);
      return {
        tracked: entry?.operations.size ?? 0,
        expiredTracked: entry?.expiredOperations.size ?? 0,
        admitted: entry?.admitted ?? 0,
        duplicates: entry?.duplicates ?? 0,
        expired: entry?.expired ?? 0,
        unknown: entry?.unknown ?? 0,
        payloadMismatches: entry?.payloadMismatches ?? 0,
        unidentified: entry?.unidentified ?? 0,
      };
    },
  };
}
