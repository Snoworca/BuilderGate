/**
 * Session-owned `streamEpoch` (`01 §1.6`).
 *
 * The epoch says "this is the Nth continuous stream of this session". It is
 * deliberately not owned by the channel: connection groups are rebuilt on every
 * reconnect, so a channel-owned epoch would reset to zero each time and destroy
 * the premise that raising it makes the client discard the old stream.
 *
 * Raising it is expensive — every one of the five reasons below ends at
 * `fresh-checkpoint-required` on the client — so the reason is required, checked
 * against the documented list, and kept for diagnostics.
 */

/** The complete set of events that raise a session's epoch (`01:476-480`). */
export const STREAM_EPOCH_BUMP_REASONS = Object.freeze([
  'session-created',
  'codec-switch',
  'ordinal-rollover',
  'authority-rollback',
  'channel-space-exhausted',
] as const);

export type StreamEpochBumpReason = (typeof STREAM_EPOCH_BUMP_REASONS)[number];

export interface TerminalStreamEpochLedger {
  /** The session's current epoch, issuing one if this is the first look. */
  current(sessionId: string): string;
  /** Raises the epoch and returns the new value. */
  bump(sessionId: string, reason: StreamEpochBumpReason): string;
  /**
   * Takes an epoch that was decided elsewhere as this session's current value.
   * Without it the ledger and whoever supplied the value would each hold their
   * own idea of the epoch, and the wire would carry whichever wrote last.
   */
  adopt(sessionId: string, value: string, reason: StreamEpochBumpReason): string;
  /** What caused the current epoch, or `undefined` for a session never seen. */
  lastReason(sessionId: string): StreamEpochBumpReason | undefined;
  forget(sessionId: string): void;
}

interface EpochEntry {
  value: bigint;
  reason: StreamEpochBumpReason;
}

const ALLOWED: ReadonlySet<string> = new Set(STREAM_EPOCH_BUMP_REASONS);
const CANONICAL_DECIMAL = /^(0|[1-9][0-9]*)$/u;

function requireReason(reason: StreamEpochBumpReason): void {
  if (!ALLOWED.has(reason)) {
    throw new RangeError(`unknown streamEpoch bump reason: ${String(reason)}`);
  }
}

export function createTerminalStreamEpochLedger(input: { initial?: string } = {}): TerminalStreamEpochLedger {
  // Held as bigint because the wire field is a u64: a JS number would round
  // past 2^53 and let two different streams claim the same epoch.
  // Issue is monotonic across sessions: this is the promotion of the former
  // process-wide counter (`01:462`), not a replacement for it. Two live
  // sessions therefore never present the same epoch, and a forgotten id is
  // never handed a value some client may still be holding.
  let nextIssue = input.initial === undefined ? 1n : BigInt(input.initial);
  const sessions = new Map<string, EpochEntry>();

  const entryFor = (sessionId: string): EpochEntry => {
    const existing = sessions.get(sessionId);
    if (existing !== undefined) return existing;
    const created: EpochEntry = { value: nextIssue, reason: 'session-created' };
    nextIssue += 1n;
    sessions.set(sessionId, created);
    return created;
  };

  return {
    current(sessionId) {
      return entryFor(sessionId).value.toString(10);
    },

    bump(sessionId, reason) {
      requireReason(reason);
      const entry = entryFor(sessionId);
      // Takes the next issue rather than its own successor, so a raised epoch
      // can never collide with another session's current one.
      entry.value = nextIssue;
      nextIssue += 1n;
      entry.reason = reason;
      return entry.value.toString(10);
    },

    adopt(sessionId, value, reason) {
      requireReason(reason);
      if (!CANONICAL_DECIMAL.test(value)) {
        throw new RangeError(`streamEpoch must be a canonical decimal string: ${String(value)}`);
      }
      const entry = entryFor(sessionId);
      entry.value = BigInt(value);
      // An adopted value comes from outside the ledger, so the issue counter
      // has to move past it or a later issue would reuse it.
      if (entry.value >= nextIssue) nextIssue = entry.value + 1n;
      entry.reason = reason;
      return entry.value.toString(10);
    },

    lastReason(sessionId) {
      return sessions.get(sessionId)?.reason;
    },

    forget(sessionId) {
      sessions.delete(sessionId);
    },
  };
}
