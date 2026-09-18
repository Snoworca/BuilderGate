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

export type TerminalInputOutcome = 'admitted' | 'duplicate' | 'unidentified';

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
}

export interface TerminalInputLedgerStats {
  /** Operation ids currently remembered. Bounded by maxOperationsPerSession. */
  tracked: number;
  admitted: number;
  duplicates: number;
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
  admitted: number;
  duplicates: number;
  unidentified: number;
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
      entry = { operations: new Set(), admitted: 0, duplicates: 0, unidentified: 0 };
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
        entry.duplicates += 1;
        return { write: false, outcome: 'duplicate' };
      }

      entry.operations.add(request.operationId);
      if (entry.operations.size > maxOperations) {
        const oldest = entry.operations.values().next();
        if (!oldest.done) {
          entry.operations.delete(oldest.value);
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
        admitted: entry?.admitted ?? 0,
        duplicates: entry?.duplicates ?? 0,
        unidentified: entry?.unidentified ?? 0,
      };
    },
  };
}
