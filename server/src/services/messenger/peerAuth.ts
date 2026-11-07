// FR-MSG-008/009/014 (contract §7): checks the key in a peer-link hello.
// - Through the MCP listener: its address guard (bind and IP list), then messenger keys (which work
//   even when the fixed MCP key is off), then the fixed-key path.
// - Through the dedicated LAN listener (request tagged via: 'lan'): the LAN address whitelist, then
//   messenger keys only. The fixed MCP key is never accepted from the network that way.
import type { MessengerKeys } from './keys.js';

export type PeerAuthResult = { ok: true; scopes: string[] } | { ok: false; code: string };

const REFUSED: PeerAuthResult = { ok: false, code: 'PEER_AUTH_FAILED' };

export function createPeerHelloAuthenticator(deps: {
  keys: Pick<MessengerKeys, 'authenticate'>;
  /** The MCP listener's address guard: a denial code, or null when the address may come in. */
  checkAddress: (request: unknown) => string | null;
  /** The LAN listener's per-connection check (lanListener.ts lanAddressAllowed). */
  lanAddressAllowed?: (remoteAddress: string) => boolean;
  fixedKey: (key: string, request: unknown) => Promise<PeerAuthResult>;
}): (key: string, request: unknown, node: string) => Promise<PeerAuthResult> {
  const messengerKey = (key: string, node: string): PeerAuthResult | null => {
    const auth = deps.keys.authenticate(key, node);
    return auth ? { ok: true, scopes: [...auth.scopes] } : null;
  };
  return async (key, request, node) => {
    const record = request !== null && typeof request === 'object' ? request as Record<string, unknown> : {};
    if (record.via === 'lan') {
      const address = typeof record.remoteAddress === 'string' ? record.remoteAddress : '';
      if (!deps.lanAddressAllowed?.(address)) return REFUSED;
      return messengerKey(key, node) ?? REFUSED;
    }
    if (deps.checkAddress(request) !== null) return REFUSED;
    return messengerKey(key, node) ?? deps.fixedKey(key, request);
  };
}
