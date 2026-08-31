import type { WsTransportMode } from './wsTransportMode.js';

/**
 * The rollout ladder for the binary data plane (`05 §8.2`).
 *
 * Every step exists so the one after it can be entered and left without a code
 * change, and `json` is the default so an untouched deployment keeps today's
 * behaviour no matter how much binary machinery is already present.
 *
 * ```
 * json          nothing binary happens at all
 * binary-shadow encode both, send JSON, compare — the wire is unchanged
 * binary-optin  binary only to clients that negotiated it
 * binary        the same, with clients declaring by default
 * ```
 *
 * The type itself lives in the config layer, which owns the value; re-exported
 * here so callers of this policy do not have to reach past it.
 */
import type { TerminalWireFormat } from '../types/config.types.js';

export type { TerminalWireFormat };

export interface TerminalWireDecision {
  /** Whether a binary frame is produced at all. */
  readonly encodeBinary: boolean;
  /** Whether that frame is what goes on the wire. */
  readonly sendBinary: boolean;
  /** Whether the binary encoding is decoded back and compared to the JSON one. */
  readonly compareCodecs: boolean;
  /** Why this decision came out the way it did, for logs and tests. */
  readonly reason: string;
}

/**
 * `05:564` recommends confining binary to the unified transport rather than
 * supporting the full `wsTransportMode` × format matrix. Split transport moves
 * terminal payload between two sockets, which multiplies the states the channel
 * table has to survive for no rollout benefit.
 */
function isTransportEligible(transportMode: WsTransportMode): boolean {
  return transportMode === 'unified';
}

/**
 * Whether the server should expose the capability handshake at all.
 *
 * `binary-shadow` deliberately says no: nothing binary reaches the wire in that
 * step, so there is nothing for the two ends to agree about.
 */
export function isBinaryNegotiable(
  configured: TerminalWireFormat,
  transportMode: WsTransportMode,
): boolean {
  if (!isTransportEligible(transportMode)) return false;
  return configured === 'binary-optin' || configured === 'binary';
}

export function decideTerminalWireFormat(input: {
  configured: TerminalWireFormat;
  transportMode: WsTransportMode;
  clientNegotiatedBinary: boolean;
}): TerminalWireDecision {
  const json = (reason: string): TerminalWireDecision => ({
    encodeBinary: false,
    sendBinary: false,
    compareCodecs: false,
    reason,
  });

  // Kept separate from "the client declined" so the two ways of ending up on
  // JSON with binary configured are distinguishable in a log.
  if (!isTransportEligible(input.transportMode)) return json('transport-not-eligible');
  if (input.configured === 'json') return json('wire-format-json');

  if (input.configured === 'binary-shadow') {
    return {
      encodeBinary: true,
      sendBinary: false,
      compareCodecs: true,
      reason: 'shadow-compare',
    };
  }

  if (!input.clientNegotiatedBinary) return json('client-did-not-negotiate');

  return {
    encodeBinary: true,
    sendBinary: true,
    compareCodecs: false,
    reason: 'binary-negotiated',
  };
}
