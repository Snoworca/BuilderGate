// FR-MSG-008/009 (contract §7): the peer-link hello is checked against messenger keys first (they
// work even when the fixed MCP key is off), then the fixed key; the listener guard applies to both.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPeerHelloAuthenticator } from './peerAuth.js';

function make(options: { denied?: string | null } = {}) {
  const fixedCalls: string[] = [];
  const authenticate = createPeerHelloAuthenticator({
    keys: {
      authenticate: (key, node) => (key === 'contact-key' && node === 'corp'
        ? { kind: 'contact', scopes: ['mcp:sessions.list', 'mcp:room'] }
        : key === 'room-key' ? { kind: 'room', scopes: ['mcp:room'], rooms: ['rm_a'] } : null),
    },
    checkAddress: () => options.denied ?? null,
    fixedKey: async (key) => {
      fixedCalls.push(key);
      return key === 'fixed' ? { ok: true, scopes: ['mcp:sessions.list'] } : { ok: false, code: 'PEER_AUTH_FAILED' };
    },
  });
  return { authenticate, fixedCalls };
}

test('contract §7: a messenger key authenticates with its own scopes before the fixed key is tried', async () => {
  const { authenticate, fixedCalls } = make();
  assert.deepEqual(await authenticate('contact-key', {}, 'corp'), { ok: true, scopes: ['mcp:sessions.list', 'mcp:room'] });
  assert.deepEqual(await authenticate('room-key', {}, 'guest'), { ok: true, scopes: ['mcp:room'] });
  assert.deepEqual(fixedCalls, []);
});

test('contract §7: a key that is not a messenger key falls through to the fixed key', async () => {
  const { authenticate, fixedCalls } = make();
  assert.deepEqual(await authenticate('fixed', {}, 'azure'), { ok: true, scopes: ['mcp:sessions.list'] });
  assert.deepEqual(await authenticate('contact-key', {}, 'other'), { ok: false, code: 'PEER_AUTH_FAILED' });
  assert.deepEqual(fixedCalls, ['fixed', 'contact-key']);
});

test('contract §7: the listener guard still applies to messenger keys', async () => {
  const { authenticate } = make({ denied: 'MCP_WHITELIST_DENIED' });
  assert.deepEqual(await authenticate('contact-key', {}, 'corp'), { ok: false, code: 'PEER_AUTH_FAILED' });
});

test('FR-MSG-014: a hello that came through the LAN listener is checked by the LAN whitelist and never by the fixed key', async () => {
  const fixedCalls: string[] = [];
  const authenticate = createPeerHelloAuthenticator({
    keys: { authenticate: (key, node) => (key === 'contact-key' && node === 'corp' ? { kind: 'contact', scopes: ['mcp:room'] } : null) },
    checkAddress: () => 'MCP_LOOPBACK_ONLY',
    lanAddressAllowed: (address) => address === '192.168.0.7',
    fixedKey: async (key) => { fixedCalls.push(key); return { ok: true, scopes: ['mcp:sessions.list'] }; },
  });
  assert.deepEqual(await authenticate('contact-key', { via: 'lan', remoteAddress: '192.168.0.7' }, 'corp'), { ok: true, scopes: ['mcp:room'] });
  assert.deepEqual(await authenticate('contact-key', { via: 'lan', remoteAddress: '8.8.8.8' }, 'corp'), { ok: false, code: 'PEER_AUTH_FAILED' });
  assert.deepEqual(await authenticate('fixed', { via: 'lan', remoteAddress: '192.168.0.7' }, 'azure'), { ok: false, code: 'PEER_AUTH_FAILED' });
  assert.deepEqual(fixedCalls, []);
});
