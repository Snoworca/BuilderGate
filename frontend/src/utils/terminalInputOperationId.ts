/**
 * Names one logical terminal input so the server can tell a retry from a new command.
 *
 * #18 / REL-BGSTAB-028: the server ledger that deduplicates input has been in place and
 * wired into the router since 2026-09-18, but `inputOperationId` was declared on both wire
 * protocol types and never written by anyone. Measured 2026-09-19: a repository-wide search
 * for the field outside tests found only the two type declarations and the server-side code
 * that reads it. Every real keystroke therefore arrived with no identifier and was admitted
 * as `unidentified`, so the exactly-once guarantee the ledger exists to provide was not in
 * force for any of the five input sources.
 *
 * The identity has to survive a retry of the same operation and must never be reused by a
 * different one. The sequence range already satisfies the first: it is assigned once per
 * logical input and carried unchanged through a resend. It does not satisfy the second on its
 * own, because `TerminalInputSequencer.reset(1)` restarts numbering on every session attach,
 * and the ledger is keyed by connection, not by attach. Two attaches on one connection would
 * hand the same range to two unrelated commands, and the ledger would drop the second one
 * silently -- a worse failure than the missing dedup it replaced. The epoch counter, bumped
 * on each reset, is what keeps them apart.
 */

/** The server refuses an identifier longer than this (see WsRouter's input handler). */
export const MAX_TERMINAL_INPUT_OPERATION_ID_LENGTH = 128;

export interface TerminalInputOperationIdInput {
  readonly sequencerEpoch: number;
  readonly inputSeqStart: number;
  readonly inputSeqEnd: number;
}

function isPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

/**
 * Returns the identifier, or null when the inputs cannot name an operation. Null means "send
 * without an identifier", which the server reports as `unidentified` -- the honest outcome,
 * rather than a malformed id it would refuse outright.
 */
export function buildTerminalInputOperationId(
  input: TerminalInputOperationIdInput,
): string | null {
  if (!isPositiveInteger(input.sequencerEpoch)) return null;
  if (!isPositiveInteger(input.inputSeqStart)) return null;
  if (!isPositiveInteger(input.inputSeqEnd)) return null;
  if (input.inputSeqEnd < input.inputSeqStart) return null;
  const id = `e${input.sequencerEpoch}:${input.inputSeqStart}-${input.inputSeqEnd}`;
  return id.length <= MAX_TERMINAL_INPUT_OPERATION_ID_LENGTH ? id : null;
}
