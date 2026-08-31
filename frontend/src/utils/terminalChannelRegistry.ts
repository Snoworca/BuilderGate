import type { ChannelState } from './binaryFrameCodec';
import type { SubscribedSessionInfo } from '../types/ws-protocol';

/**
 * The channel table for the binary data plane (`08 §2.1`).
 *
 * `08:192` fixes the shape as `Map<channelId, { sessionId, authorityEpoch,
 * streamEpoch }>` and gives ownership to a `WebSocketContext` ref, so its
 * lifetime is the socket's. A view-scoped owner would lose the mapping on an
 * unmount even though the connection, and therefore the channels, survived.
 *
 * There is no `authorityEpochIndex` column. A channel is 1:1 with a session
 * (`01:369-371` allocates on subscribe and releases on unsubscribe; `01:393`
 * forbids reuse) and `authorityEpoch` is assigned once per session and never
 * reassigned (`08:170`), so within a channel the index has exactly one possible
 * value. Keying by channel makes it a restatement rather than a lookup key.
 */

export interface TerminalChannelRecord {
  sessionId: string;
  /** The session's `authorityEpoch` UUID, which the frame carries only as a channel-local index. */
  authorityEpoch: string;
  streamEpoch: string;
}

interface ChannelEntry {
  readonly state: ChannelState;
  /** Frozen and shared: `lookup` runs once per frame and must not allocate. */
  readonly record: Readonly<TerminalChannelRecord>;
}

/** A registration the server had no right to send: the channel still belongs to someone else. */
export interface RefusedChannelRebind {
  readonly channelId: number;
  /** The session the channel is still filed under, and whose frames may be in flight. */
  readonly incumbentSessionId: string;
  /** The session the server tried to hand it to, which is now without a channel. */
  readonly incomingSessionId: string;
}

export interface TerminalChannelRegistry {
  /**
   * `undefined` when the channel was registered; the refusal record when it
   * already belongs to a different session (`01:392`).
   *
   * The refusal is built where the incumbent is in hand, so the caller never
   * has to re-derive it and there is no unreachable "incumbent missing" branch
   * to fill in with a placeholder.
   */
  registerOrRefusal(channelId: number, record: TerminalChannelRecord): RefusedChannelRebind | undefined;
  /**
   * The rows that were refused, empty in normal operation. A non-empty result
   * means the server reassigned a live channel — worth surfacing, because from
   * that point on the codec reports the dropped frames as ordinary
   * retired-channel traffic and the violation becomes invisible.
   */
  registerAll(
    entries: readonly ({ channelId: number } & TerminalChannelRecord)[],
  ): readonly RefusedChannelRebind[];
  /** The record of an active channel. Retired and unknown channels both give `undefined`. */
  lookup(channelId: number): Readonly<TerminalChannelRecord> | undefined;
  retire(channelId: number): void;
  retireSession(sessionId: string): void;
  /**
   * The function `createV1DecodeContext` requires. Bound to the registry, so it
   * can be passed on its own, and reading the live table rather than a snapshot
   * so channels registered after the context was built are still visible.
   */
  channelState(channelId: number): ChannelState | undefined;
  clear(): void;
  readonly size: number;
}

const MAX_CHANNEL_ID = 0xFFFFFFFF;

/**
 * The one statement of what a registration must look like. Both callers need
 * it and they need it to agree, but they need different failure modes — see
 * `assertValid` and `channelEntriesFromSubscribed`.
 */
function registrationError(channelId: number, record: TerminalChannelRecord): string | undefined {
  // `channelId === 0` is reserved on the wire, so an entry for it could never
  // be matched by a frame.
  if (!Number.isInteger(channelId) || channelId <= 0 || channelId > MAX_CHANNEL_ID) {
    return `channelId must be a uint32 above the reserved 0, got ${channelId}`;
  }
  if (typeof record.sessionId !== 'string' || record.sessionId.length === 0) {
    return 'sessionId must be a non-empty string';
  }
  // Both identifiers are compared for equality downstream, where two empty
  // strings would unify sessions that are not the same.
  if (typeof record.authorityEpoch !== 'string' || record.authorityEpoch.length === 0) {
    return 'authorityEpoch must be a non-empty string';
  }
  if (typeof record.streamEpoch !== 'string' || record.streamEpoch.length === 0) {
    return 'streamEpoch must be a non-empty string';
  }
  return undefined;
}

function assertValid(channelId: number, record: TerminalChannelRecord): void {
  // Throwing here fails at the mistake rather than three layers down as an
  // unexplained `reserved-channel` rejection. Reaching it means our own code
  // called this wrongly, which is not a condition to recover from.
  const error = registrationError(channelId, record);
  if (error !== undefined) throw new RangeError(error);
}

/**
 * A `subscribed` session row.
 *
 * `Partial` rather than the interface itself: this reads a server message, so
 * every field is a claim rather than a guarantee, and the runtime checks below
 * are what actually decide. It also lets a caller — a test above all — pass a
 * realistic subset without the type rejecting the very shape it describes.
 *
 * Declaring a local four-field mirror instead would put the same wire contract
 * in two places, and only one of them would get updated.
 */
export type SubscribedChannelSource = { readonly [K in keyof SubscribedSessionInfo]?: unknown };

/**
 * Reads the channel table out of a `subscribed` message.
 *
 * Sessions without the channel fields are the normal case — that is every
 * session in a JSON-only group — so their absence is a skip, not an error. A
 * session the server describes invalidly is skipped for a different reason:
 * throwing would abort the subscribe handler and take the healthy sessions in
 * the same array down with the bad one.
 *
 * The fields arrive as one object, so a channel is never known without its
 * identity (`08:171`); a partial record is dropped whole because no later
 * message fills the gap.
 */
export function channelEntriesFromSubscribed(
  sessions: readonly SubscribedChannelSource[],
): ({ channelId: number } & TerminalChannelRecord)[] {
  const entries: ({ channelId: number } & TerminalChannelRecord)[] = [];
  for (const session of sessions) {
    const entry = {
      channelId: session.channelId as number,
      sessionId: session.sessionId as string,
      authorityEpoch: session.authorityEpoch as string,
      streamEpoch: session.streamEpoch as string,
    };
    if (registrationError(entry.channelId, entry) === undefined) entries.push(entry);
  }
  return entries;
}

export function createTerminalChannelRegistry(): TerminalChannelRegistry {
  const channels = new Map<number, ChannelEntry>();

  const registerOrRefusal = (
    channelId: number,
    record: TerminalChannelRecord,
  ): RefusedChannelRebind | undefined => {
    assertValid(channelId, record);
    const existing = channels.get(channelId);
    if (existing !== undefined && existing.record.sessionId !== record.sessionId) {
      // `01:392` rule 2 forbids the allocator from reusing a released channelId
      // inside one codecEpoch, and `01:396-400` gives the reason: a frame for
      // the previous owner can still be sitting in the socket buffer. Honouring
      // the reassignment is precisely what writes those bytes to the new
      // owner's screen.
      //
      // The test is the sessionId changing, NOT the channel being retired.
      // Retirement is not what creates the hazard — frames for the old owner are
      // in flight the whole time it is subscribed — it is merely the case the
      // client happens to observe, and it is the case it observes least often,
      // since `terminal-binary:channel-retired` is not wired yet. Keying on
      // 'retired' also lets a legitimate same-session revival erase the memory
      // and reopen the hole on the very next message.
      //
      // `clear()` stays the only legitimate way an id changes owner, which is
      // right: that is the codecEpoch boundary the reuse ban is scoped to.
      return {
        channelId,
        incumbentSessionId: existing.record.sessionId,
        incomingSessionId: record.sessionId,
      };
    }
    channels.set(channelId, {
      state: 'active',
      // Copied, so a caller reusing its input object cannot rewrite the table.
      record: Object.freeze({
        sessionId: record.sessionId,
        authorityEpoch: record.authorityEpoch,
        streamEpoch: record.streamEpoch,
      }),
    });
    return undefined;
  };

  const retire = (channelId: number): void => {
    const entry = channels.get(channelId);
    // A retirement for a channel that was never registered must stay unknown.
    // Minting an entry would turn later scoped rejections into silent drops.
    if (entry === undefined) return;
    channels.set(channelId, { state: 'retired', record: entry.record });
  };

  return {
    registerOrRefusal,
    registerAll(entries) {
      const refused: RefusedChannelRebind[] = [];
      for (const entry of entries) {
        const refusal = registerOrRefusal(entry.channelId, entry);
        if (refusal !== undefined) refused.push(refusal);
      }
      return refused;
    },
    lookup(channelId) {
      const entry = channels.get(channelId);
      return entry?.state === 'active' ? entry.record : undefined;
    },
    retire,
    retireSession(sessionId) {
      for (const [channelId, entry] of channels) {
        if (entry.record.sessionId === sessionId) retire(channelId);
      }
    },
    channelState(channelId) {
      return channels.get(channelId)?.state;
    },
    clear() {
      // Not a bulk retire: after a socket close or a `codecEpoch` change the
      // ids can be reissued to different sessions, and a retired entry would
      // silently drop the new owner's frames.
      channels.clear();
    },
    get size() {
      return channels.size;
    },
  };
}
