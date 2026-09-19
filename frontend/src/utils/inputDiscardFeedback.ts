/**
 * REL-BGSTAB-016 (issue #109): which input discards owe the user a visible surface.
 *
 * Two call sites discard input without sending or queueing it, and both did it silently:
 * `TerminalView#submitCapturedInputDirect` when the mode is `observe` and the capture gate is
 * `transient-blocked`, and `TerminalContainer#enqueueTransportInput` when the transport
 * decision is `queue` and the mode is `observe`. AC-2 records why those two predicates are the
 * same condition under different names: `classifyTransportQueueDecision` has already rejected
 * the invisible, closed and missing-token cases, so what reaches `enqueueTransportInput` with
 * `action: 'queue'` is the same situation `transient-blocked` names in the view.
 *
 * Kept as one function so the two sites cannot drift into disagreeing about when the user is
 * told -- which is exactly how one of them would end up silent again.
 */
export type InputDiscardSite = 'capture-gate' | 'transport-queue';

export interface InputDiscardFeedbackInput {
  site: InputDiscardSite;
  /** The resolved `inputReliabilityMode`. */
  mode: string;
  /** `capture-gate`: the gate's captureState. `transport-queue`: the decision action. */
  state: string;
}

export function shouldShowInputDiscardFeedback(input: InputDiscardFeedbackInput): boolean {
  // AC-4: any other mode either sends or queues the input, so there is nothing to report.
  if (input.mode !== 'observe') return false;
  return input.site === 'capture-gate'
    ? input.state === 'transient-blocked'
    : input.state === 'queue';
}

/**
 * The two discard sites live in different components -- `TerminalView` and `TerminalContainer` --
 * and the surface that reports them renders in the view. Publishing through one small bus keeps
 * both sites symmetric and avoids threading a callback through the component that happens to sit
 * between them; a callback only one of the two received is how a site goes quiet again.
 *
 * Keyed by session, so a discard in one terminal never counts against another's surface.
 */
type InputDiscardListener = () => void;

const listeners = new Map<string, Set<InputDiscardListener>>();

export function subscribeToInputDiscards(sessionId: string, listener: InputDiscardListener): () => void {
  const existing = listeners.get(sessionId) ?? new Set<InputDiscardListener>();
  existing.add(listener);
  listeners.set(sessionId, existing);
  return () => {
    const current = listeners.get(sessionId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) listeners.delete(sessionId);
  };
}

/** Publishes the FACT of a discard. The discarded text is never carried (AC-5). */
export function publishInputDiscard(sessionId: string): void {
  const current = listeners.get(sessionId);
  if (!current) return;
  for (const listener of [...current]) listener();
}
