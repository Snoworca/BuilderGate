import { ACTIVE_FLAG_MASK_V1, FRAME_VERSION_V1 } from './binaryFrameCodec.js';
import { createTerminalChannelAllocator } from './terminalChannelAllocator.js';
import { resolveTerminalBinaryNegotiation } from './terminalBinaryNegotiation.js';
import type {
  TerminalBinaryCapabilityAccepted,
  TerminalBinaryCapabilityOffer,
  TerminalBinaryChannelSeed,
  TerminalBinaryNegotiationResult,
} from './terminalBinaryNegotiation.js';
import { decideTerminalWireFormat, isBinaryNegotiable } from './terminalWireFormat.js';
import type { TerminalWireDecision, TerminalWireFormat } from './terminalWireFormat.js';
import type { WsTransportMode } from './wsTransportMode.js';

/**
 * Everything a connection group owns for the binary data plane, in one place:
 * the channel allocator and whether the group negotiated at all.
 *
 * It exists so `WsRouter` delegates rather than decides. With the default
 * `json` configuration every method here is inert, which is what keeps the
 * feature invisible until it is switched on.
 */

/**
 * The fields a `subscribed` row gains once the group speaks binary. Empty on
 * every other path, so the message is byte-identical to today's.
 */
export interface SubscribedChannelFields {
  readonly channelId?: number;
  readonly streamEpoch?: string;
  readonly authorityEpoch?: string;
  readonly authorityEpochIndex?: number;
}

export interface TerminalBinaryGroupSession {
  /** Whether the configuration allows this group to speak binary at all. */
  readonly isNegotiable: boolean;
  /** Whether the handshake actually completed. */
  readonly isNegotiated: boolean;
  /**
   * The epoch every frame this group builds is stamped with. A frame carrying
   * any other value was built under a codec the group has since left, and must
   * be dropped rather than re-encoded (`01:1193`).
   */
  readonly codecEpoch: number;
  negotiate(offer: TerminalBinaryCapabilityOffer): TerminalBinaryNegotiationResult;
  /** Opens a channel for a newly subscribed session, or returns nothing. */
  openChannel(session: {
    sessionId: string;
    streamEpoch: string;
    authorityEpoch: string;
  }): SubscribedChannelFields;
  /** The channels the server must announce as retired. */
  closeSession(sessionId: string): readonly number[];
  /**
   * The open channel a send path must address, or `undefined`.
   *
   * `openChannel` is called once when a session is subscribed; every frame
   * afterwards needs the reverse direction. Without it the encoder would have to
   * ask the client which channel its own server handed out.
   */
  lookupChannel(sessionId: string): { channelId: number; streamEpoch: string } | undefined;
  /**
   * A channel id for frames that are built but never sent (`binary-shadow`).
   *
   * Shadow exists to exercise the real encoder, so it allocates through the
   * real allocator rather than borrowing an id. Channel 0 is permanently
   * reserved and the encoder refuses it, so "any number will do" is not true
   * even for a frame that never reaches the wire.
   */
  ensureShadowChannel(session: { sessionId: string; streamEpoch: string }): { channelId: number; streamEpoch: string };
  /** Retires every channel at once. Only the rollback path calls this. */
  retireAllChannels(): readonly number[];
  /**
   * Invalidates every frame already built by this group.
   *
   * `sendTransportMessage` drops a queued frame whose `codecEpoch` is not the
   * group's current one, so bumping is what makes in-flight bytes safe to
   * abandon rather than something that has to be chased down.
   */
  bumpCodecEpoch(): number;
  /** Shadow-comparison failures. Capped at 1: the first one halts comparison. */
  readonly shadowMismatch: number;
  /** Whether shadow encoding is still running for this group. */
  readonly shadowActive: boolean;
  recordShadowMismatch(): void;
  /** Terminal payloads that had to go out as JSON despite a negotiated group. */
  readonly codecFallback: number;
  recordCodecFallback(): void;
  /**
   * The acceptance to re-send when a client reports a channel it does not know
   * (`01:433`). It carries the same codec epoch as the original acceptance:
   * bumping it would invalidate every frame already in flight on this group.
   */
  reannounce(): TerminalBinaryCapabilityAccepted | undefined;
  wireDecision(): TerminalWireDecision;
}

const NO_CHANNEL: SubscribedChannelFields = Object.freeze({});

export function createTerminalBinaryGroupSession(input: {
  now(): number;
  wireFormat: TerminalWireFormat;
  transportMode: WsTransportMode;
  /**
   * Whether every socket in the group negotiated the binary subprotocol. Read
   * at each offer rather than captured, because sockets join and leave a group
   * while it lives. Defaults to true: a caller that cannot answer yet is not
   * making a claim about the sockets, and conflating it with the configuration
   * gate would tell the client to go fix a connection that is fine.
   */
  everySocketBinaryCapable?: () => boolean;
}): TerminalBinaryGroupSession {
  const negotiable = isBinaryNegotiable(input.wireFormat, input.transportMode);
  const allocator = createTerminalChannelAllocator({ now: input.now });
  const seeds = new Map<number, TerminalBinaryChannelSeed>();
  let negotiated = false;
  let codecEpoch = 0;
  let acceptance: TerminalBinaryCapabilityAccepted | undefined;
  let shadowMismatch = 0;
  let shadowActive = true;
  let codecFallback = 0;

  return {
    get isNegotiable() {
      return negotiable;
    },
    get isNegotiated() {
      return negotiated;
    },
    get codecEpoch() {
      return codecEpoch;
    },

    negotiate(offer) {
      const result = resolveTerminalBinaryNegotiation({
        offer,
        supportedFrameVersions: [FRAME_VERSION_V1],
        serverFlagMask: ACTIVE_FLAG_MASK_V1,
        codecEpoch,
        // The live table, not an empty one: a renegotiation that seeded nothing
        // would leave the client refusing every channel already in flight.
        channels: [...seeds.values()],
        everySocketBinaryCapable: input.everySocketBinaryCapable?.() ?? true,
        groupEligible: negotiable,
      });
      if (result.type === 'terminal-binary:capability') {
        negotiated = true;
        acceptance = result;
      }
      return result;
    },

    openChannel(session) {
      // Before the handshake there is no agreement that the client can read a
      // frame, so addressing one would be worse than staying on JSON.
      if (!negotiated) return NO_CHANNEL;

      const { channelId } = allocator.allocate(session.sessionId);
      const seed: TerminalBinaryChannelSeed = Object.freeze({
        sessionId: session.sessionId,
        channelId,
        streamEpoch: session.streamEpoch,
        // The index is a channel-local alias, and a channel maps to exactly one
        // session (01:369-371). Its first authority is therefore always 0; the
        // UUID beside it is what actually identifies the authority (R3, 01:350).
        authorityEpochIndex: 0,
        authorityEpoch: session.authorityEpoch,
      });
      seeds.set(channelId, seed);
      return seed;
    },

    reannounce() {
      if (acceptance === undefined) return undefined;
      return { ...acceptance, channels: [...seeds.values()] };
    },

    closeSession(sessionId) {
      const retired = allocator.retireSession(sessionId);
      for (const channelId of retired) seeds.delete(channelId);
      return retired;
    },

    ensureShadowChannel(session) {
      const existing = [...seeds.values()].find(seed => seed.sessionId === session.sessionId);
      if (existing) return { channelId: existing.channelId, streamEpoch: existing.streamEpoch };
      const { channelId } = allocator.allocate(session.sessionId);
      seeds.set(channelId, Object.freeze({
        sessionId: session.sessionId,
        channelId,
        streamEpoch: session.streamEpoch,
        authorityEpochIndex: 0,
        authorityEpoch: '',
      }));
      return { channelId, streamEpoch: session.streamEpoch };
    },

    lookupChannel(sessionId) {
      for (const seed of seeds.values()) {
        if (seed.sessionId === sessionId) {
          return { channelId: seed.channelId, streamEpoch: seed.streamEpoch };
        }
      }
      return undefined;
    },

    retireAllChannels() {
      const sessionIds = new Set([...seeds.values()].map(seed => seed.sessionId));
      const retired: number[] = [];
      for (const sessionId of sessionIds) {
        for (const channelId of allocator.retireSession(sessionId)) {
          seeds.delete(channelId);
          retired.push(channelId);
        }
      }
      return retired;
    },

    bumpCodecEpoch() {
      codecEpoch += 1;
      // A bumped epoch means the acceptance the client holds no longer describes
      // this group, so re-announcing the old one would re-seed a dead table.
      negotiated = false;
      acceptance = undefined;
      return codecEpoch;
    },

    get shadowMismatch() {
      return shadowMismatch;
    },
    get shadowActive() {
      return shadowActive;
    },
    recordShadowMismatch() {
      // Counted once. A mismatching encoder mismatches on every frame, and a
      // per-frame counter would say how chatty the session was, not how many
      // distinct faults there were.
      if (!shadowActive) return;
      shadowMismatch += 1;
      shadowActive = false;
    },

    get codecFallback() {
      return codecFallback;
    },
    recordCodecFallback() {
      codecFallback += 1;
    },

    wireDecision() {
      return decideTerminalWireFormat({
        configured: input.wireFormat,
        transportMode: input.transportMode,
        clientNegotiatedBinary: negotiated,
      });
    },
  };
}
