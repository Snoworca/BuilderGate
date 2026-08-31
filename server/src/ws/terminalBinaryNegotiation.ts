import { MANDATORY_FLAGS } from './binaryFrameCodec.js';

/**
 * In-band capability negotiation (`01 §2.2` layer 2).
 *
 * The subprotocol handshake decides whether a socket can carry binary at all;
 * this decides what the connection group will actually speak, and seeds the
 * client's channel table while doing it.
 *
 * Kept pure so that every rejection reason is reachable without a socket. The
 * caller supplies the two facts that come from the connection — whether every
 * socket in the group negotiated the subprotocol, and whether the group is
 * eligible — rather than having this module reach for them.
 */

/** C→S. Arrives from the wire, so every field here is untrusted. */
export interface TerminalBinaryCapabilityOffer {
  readonly type: 'terminal-binary:capability';
  readonly supportedFrameVersions: readonly number[];
  readonly acceptedFlagMask: number;
  readonly maxBatchBytes?: number;
}

/** One row of the initial channel table (`01:733`, revision R3 at `01:350`). */
export interface TerminalBinaryChannelSeed {
  readonly sessionId: string;
  readonly channelId: number;
  readonly streamEpoch: string;
  readonly authorityEpochIndex: number;
  /**
   * The UUID the index aliases. Without it the client holds an alias explained
   * by an alias, cannot fill its table, and refuses every frame as
   * `unknown-channel`.
   */
  readonly authorityEpoch: string;
}

export interface TerminalBinaryCapabilityAccepted {
  readonly type: 'terminal-binary:capability';
  readonly accepted: true;
  readonly frameVersion: number;
  readonly activeFlagMask: number;
  readonly codecEpoch: number;
  readonly channels: readonly TerminalBinaryChannelSeed[];
}

export type TerminalBinaryRejectionReason =
  | 'unsupported-version'
  | 'invalid-message'
  | 'socket-not-binary-capable'
  | 'mandatory-flag-not-accepted'
  | 'group-not-eligible';

export interface TerminalBinaryRejected {
  readonly type: 'terminal-binary:rejected';
  /** What the server does support, so the client can retry meaningfully. */
  readonly supportedFrameVersions: readonly number[];
  readonly phase: 'offer' | 'frame';
  readonly reason: TerminalBinaryRejectionReason;
}

export type TerminalBinaryNegotiationResult =
  | TerminalBinaryCapabilityAccepted
  | TerminalBinaryRejected;

export interface TerminalBinaryNegotiationInput {
  readonly offer: TerminalBinaryCapabilityOffer;
  readonly supportedFrameVersions: readonly number[];
  readonly serverFlagMask: number;
  readonly codecEpoch: number;
  readonly channels: readonly TerminalBinaryChannelSeed[];
  /**
   * Terminal payload falls back from the output socket to the control socket
   * (`FR-BGSTAB-007` AC-3/AC-4), so one non-capable socket disqualifies the
   * whole group rather than just itself.
   */
  readonly everySocketBinaryCapable: boolean;
  readonly groupEligible: boolean;
}

function isOfferWellFormed(offer: TerminalBinaryCapabilityOffer): boolean {
  const { supportedFrameVersions, acceptedFlagMask, maxBatchBytes } = offer;
  if (!Array.isArray(supportedFrameVersions) || supportedFrameVersions.length === 0) return false;
  if (!supportedFrameVersions.every(v => Number.isSafeInteger(v) && v > 0)) return false;
  if (!Number.isSafeInteger(acceptedFlagMask) || acceptedFlagMask < 0) return false;
  if (maxBatchBytes !== undefined && (!Number.isSafeInteger(maxBatchBytes) || maxBatchBytes <= 0)) {
    return false;
  }
  return true;
}

export function resolveTerminalBinaryNegotiation(
  input: TerminalBinaryNegotiationInput,
): TerminalBinaryNegotiationResult {
  const reject = (reason: TerminalBinaryRejectionReason): TerminalBinaryRejected => ({
    type: 'terminal-binary:rejected',
    supportedFrameVersions: input.supportedFrameVersions,
    phase: 'offer',
    reason,
  });

  // Ordered so the client is told the most actionable thing first: a malformed
  // message is the client's own bug, a non-capable socket is a connection-level
  // fact, and only then does the version intersection mean anything.
  if (!isOfferWellFormed(input.offer)) return reject('invalid-message');
  if (!input.everySocketBinaryCapable) return reject('socket-not-binary-capable');
  if (!input.groupEligible) return reject('group-not-eligible');

  if ((input.offer.acceptedFlagMask & MANDATORY_FLAGS) !== MANDATORY_FLAGS) {
    return reject('mandatory-flag-not-accepted');
  }

  const common = input.supportedFrameVersions
    .filter(version => input.offer.supportedFrameVersions.includes(version))
    .sort((left, right) => right - left);
  if (common.length === 0) return reject('unsupported-version');

  return {
    type: 'terminal-binary:capability',
    accepted: true,
    frameVersion: common[0],
    // Never wider than what the client said it can read.
    activeFlagMask: input.serverFlagMask & input.offer.acceptedFlagMask,
    codecEpoch: input.codecEpoch,
    channels: input.channels,
  };
}
