/**
 * The live-path token store (`08 §2.2`).
 *
 * `replayToken` and `repairToken` already exist on the client, but only inside
 * two recovery refs where they serve as comparison state for an in-flight
 * transaction. Outside R1/R2 there is nothing to compare against, so the live
 * output path has no way to learn the current value — and it forwards
 * `replayToken` into restore-buffer entries on every output.
 *
 * `08:224` forbids merging the existing refs: the JSON path keeps reading
 * `output.replayToken` first and consults this store only when the message
 * carries none, which leaves JSON-observable behaviour bit-identical.
 *
 * Reads and writes are stamped with a generation instead of relying on a
 * `clear()` at the right moments. `08:223` lists three invalidation triggers —
 * the ws-connection generation, the session generation, and an epoch rollback —
 * and a token that outlives any one of them is written into a restore entry
 * under an authority it does not belong to. Stamping turns three call sites
 * that must all be right into one that cannot be wrong.
 */

export interface LiveOutputTokens {
  readonly replayToken?: string;
  readonly repairToken?: string;
}

export interface LiveOutputTokenStore {
  /**
   * Merges the given tokens for a session at `generation`. Fields that are
   * absent or blank leave the stored value standing; a different generation
   * replaces the record rather than merging into it.
   */
  update(sessionId: string, generation: string, tokens: LiveOutputTokens): void;
  /** The tokens stored for this session at this exact generation, or `undefined`. */
  get(sessionId: string, generation: string): LiveOutputTokens | undefined;
  forget(sessionId: string): void;
  clear(): void;
  readonly size: number;
}

interface StoredTokens {
  readonly generation: string;
  readonly tokens: LiveOutputTokens;
}

/** Blank is absent everywhere else in the protocol, and `''` compares equal to `''`. */
function present(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function createLiveOutputTokenStore(): LiveOutputTokenStore {
  const sessions = new Map<string, StoredTokens>();

  return {
    update(sessionId, generation, tokens) {
      const replayToken = present(tokens.replayToken) ? tokens.replayToken : undefined;
      const repairToken = present(tokens.repairToken) ? tokens.repairToken : undefined;
      if (replayToken === undefined && repairToken === undefined) return;

      const stored = sessions.get(sessionId);
      // Tokens from a superseded generation are no more valid than the one
      // being replaced, so they are dropped rather than merged forward.
      const base: LiveOutputTokens = stored?.generation === generation ? stored.tokens : {};
      const nextReplay = replayToken ?? base.replayToken;
      const nextRepair = repairToken ?? base.repairToken;
      sessions.set(sessionId, {
        generation,
        tokens: Object.freeze({
          ...(nextReplay === undefined ? {} : { replayToken: nextReplay }),
          ...(nextRepair === undefined ? {} : { repairToken: nextRepair }),
        }),
      });
    },
    get(sessionId, generation) {
      const stored = sessions.get(sessionId);
      return stored?.generation === generation ? stored.tokens : undefined;
    },
    forget(sessionId) {
      sessions.delete(sessionId);
    },
    clear() {
      sessions.clear();
    },
    get size() {
      return sessions.size;
    },
  };
}
