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

    wireDecision() {
      return decideTerminalWireFormat({
        configured: input.wireFormat,
        transportMode: input.transportMode,
        clientNegotiatedBinary: negotiated,
      });
    },
  };
}
