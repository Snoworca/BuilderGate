/**
 * Group-scoped `channelId` allocation (`01 §1.5`).
 *
 * A frame header carries a uint32 handle instead of the 36-byte `sessionId` it
 * stands for. The handle is scoped to the connection group rather than the
 * socket, because terminal payload falls back from the output socket to the
 * control socket (`FR-BGSTAB-007` AC-3/AC-4) and a socket-scoped table would
 * make the fallen-back frame unreadable.
 *
 * `streamEpoch` is deliberately NOT owned here. Groups do not survive a
 * reconnect, so a channel-owned epoch would reset to zero on every reconnect
 * and break the rollback premise (`01:462`). The session owns it; a channel
 * only reads the current value when it opens.
 */

/** `01:392` rule 3 — the counter is uint32. */
export const CHANNEL_ID_MAX = 0xFFFFFFFF;

/**
 * `01:427` — the retired window reuses the 30s pair-token expiry rather than
 * introducing a policy constant, which `PERF-BGSTAB-010` AC-4 would require to
 * be derived from `TerminalResourcePolicy`.
 */
export const CHANNEL_RETIRED_GRACE_MS = 30_000;

/**
 * `ACTIVE ─retire─▶ RETIRED ─grace─▶ FREE`, and never back (`01:409`).
 *
 * `RETIRED` exists so that frames already sitting in a socket buffer when the
 * session went away are dropped with a diagnostic instead of being read as an
 * unknown channel, which would ask for a fresh snapshot of a session the client
 * has already discarded.
 */
export type TerminalChannelLifecycle = 'active' | 'retired' | 'free';

export interface TerminalChannelAllocation {
  readonly channelId: number;
  readonly sessionId: string;
}

export interface TerminalChannelAllocator {
  /** A handle no other session in this group has held, or will hold again. */
  allocate(sessionId: string): TerminalChannelAllocation;
  /** `true` when an active channel was retired by this call. */
  retire(channelId: number): boolean;
  /** The channels this call moved to `retired`, for the server-driven notice. */
  retireSession(sessionId: string): readonly number[];
  lifecycle(channelId: number): TerminalChannelLifecycle;
  /** The owner of an active or retired channel; `undefined` once it is free. */
  sessionOf(channelId: number): string | undefined;
  /** Moves channels whose grace has elapsed to `free` and reports them. */
  sweep(): readonly number[];
  readonly activeCount: number;
}

interface ChannelEntry {
  readonly sessionId: string;
  state: 'active' | 'retired';
  retiredAt: number;
}

export function createTerminalChannelAllocator(input: {
  now(): number;
  graceMs?: number;
  /** The first handle to hand out. Present so exhaustion is reachable in a test. */
  nextChannelId?: number;
}): TerminalChannelAllocator {
  const graceMs = input.graceMs ?? CHANNEL_RETIRED_GRACE_MS;
  // Starts at 1: 0 is permanently reserved so that a zero-filled buffer cannot
  // look like a valid frame (`01:392` rule 1).
  let next = input.nextChannelId ?? 1;
  let exhausted = false;
  const channels = new Map<number, ChannelEntry>();

  return {
    allocate(sessionId) {
      if (exhausted) {
        throw new RangeError('channelId space is exhausted; bump the codecEpoch and renegotiate');
      }
      const channelId = next;
      if (channelId >= CHANNEL_ID_MAX) exhausted = true;
      else next = channelId + 1;
      channels.set(channelId, { sessionId, state: 'active', retiredAt: 0 });
      return Object.freeze({ channelId, sessionId });
    },

    retire(channelId) {
      const entry = channels.get(channelId);
      // A second retire must not restart the grace, or a channel retired
      // repeatedly would never reach `free`.
      if (entry === undefined || entry.state !== 'active') return false;
      entry.state = 'retired';
      entry.retiredAt = input.now();
      return true;
    },

    retireSession(sessionId) {
      const retired: number[] = [];
      const at = input.now();
      for (const [channelId, entry] of channels) {
        if (entry.sessionId !== sessionId || entry.state !== 'active') continue;
        entry.state = 'retired';
        entry.retiredAt = at;
        retired.push(channelId);
      }
      return retired;
    },

    lifecycle(channelId) {
      const entry = channels.get(channelId);
      if (entry === undefined) return 'free';
      if (entry.state === 'active') return 'active';
      // Reported as free the moment the grace elapses, so a caller that has not
      // swept yet still sees the same answer a sweep would give it.
      return input.now() - entry.retiredAt >= graceMs ? 'free' : 'retired';
    },

    sessionOf(channelId) {
      const entry = channels.get(channelId);
      if (entry === undefined) return undefined;
      if (entry.state === 'retired' && input.now() - entry.retiredAt >= graceMs) return undefined;
      return entry.sessionId;
    },

    sweep() {
      const at = input.now();
      const freed: number[] = [];
      for (const [channelId, entry] of channels) {
        if (entry.state !== 'retired' || at - entry.retiredAt < graceMs) continue;
        // Dropped from the table rather than kept as a `free` row: the handle is
        // never handed out again, so nothing needs to remember it.
        channels.delete(channelId);
        freed.push(channelId);
      }
      return freed;
    },

    get activeCount() {
      let count = 0;
      for (const entry of channels.values()) if (entry.state === 'active') count += 1;
      return count;
    },
  };
}
