/**
 * Issue #109: when a queued keystroke may be thrown away.
 *
 * Input typed while the terminal's capture gate is `transient-blocked` is queued rather than
 * sent, and the queue expires entries older than `resourceLimits.terminal.inputQueueTtlMs`
 * (shipped default 1500ms). That TTL is wall-clock and knows nothing about the barrier it
 * exists to cover.
 *
 * Measured on a live server: attaching a new client to a session carrying large retained
 * scrollback leaves the gate at `captureState: 'transient-blocked'`,
 * `barrierReason: 'repair-server-not-ready'` for about ten seconds. Every keystroke queued in
 * that window therefore expired before the gate opened, and the characters were gone with no
 * message -- the terminal simply never showed them. That is the "input does not arrive" report
 * in #109 and part of the first-attempt failures in #81.
 *
 * The TTL's purpose is narrower than its effect. `timeout-enter-safety` names it: a stale
 * Enter must not be submitted into whatever context exists once the barrier lifts, because
 * that runs a command the user aimed at a different screen. Ordinary characters carry no such
 * hazard -- they land in the line editor, where the user can see and correct them.
 *
 * So Enter keeps the TTL, and plain characters are held for as long as the barrier that
 * blocked them is still in progress. They remain bounded by the queue's byte and count caps,
 * which is what limits the queue; the TTL was never the bound that mattered.
 */
export interface PendingInputExpiryInput {
  /** Milliseconds the entry has been queued. */
  queuedMs: number;
  /** Whether the entry carries a submit, which is what the safety rule is about. */
  containsEnter: boolean;
  /** `resourceLimits.terminal.inputQueueTtlMs`. */
  ttlMs: number;
  /** Whether the transport barrier that caused the queueing is still in progress. */
  barrierActive: boolean;
}

export function shouldExpirePendingInput(input: PendingInputExpiryInput): boolean {
  if (input.queuedMs <= input.ttlMs) return false;
  if (input.containsEnter) return true;
  // Past the TTL, without an Enter: keep it only while the barrier is still what is holding it.
  return !input.barrierActive;
}
