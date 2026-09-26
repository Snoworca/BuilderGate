// #111 / #18 criterion 11 — the identity the dedup record is keyed by.
//
// Measured 2026-09-19: the server generated BOTH `connectionId` and `clientId` with
// uuidv4() per socket (WsRouter.ts:1723-1725), and the control WebSocket URL carried only
// token, mode and channel. So nothing the browser sent survived a reconnect, and the
// server had nothing stable to key a dedup record by. That is why the ledger was keyed by
// the connection and lost on disconnect.
//
// Scope, stated deliberately: this identity is PER TAB and survives reconnect and reload,
// not per user and not per device. Two tabs are two clients -- they legitimately issue the
// same sequence numbers and must not suppress each other's input.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LOGICAL_CLIENT_ID_STORAGE_KEY,
  resolveLogicalClientId,
} from '../../src/utils/logicalClientIdentity.ts';

function createStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    storage: {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => { map.set(key, value); },
    },
  };
}

test('#111 the identity is stable across repeated resolutions, which is what a reconnect does', () => {
  const { storage } = createStorage();

  const first = resolveLogicalClientId(storage);
  const second = resolveLogicalClientId(storage);

  assert.equal(first, second, 'a reconnect must present the same logical client');
  assert.ok(first.length > 0);
});

test('#111 an existing stored identity is reused rather than regenerated', () => {
  const { storage } = createStorage({ [LOGICAL_CLIENT_ID_STORAGE_KEY]: 'stored-tab-id' });

  assert.equal(resolveLogicalClientId(storage), 'stored-tab-id');
});

test('#111 two independent storages are two different clients', () => {
  // Boundary: preserving across reconnect must not become sharing across tabs. Sequence
  // numbers restart per tab, so a shared identity would let one tab's input suppress
  // another's -- a silent loss, which is worse than the duplicate it would prevent.
  const a = resolveLogicalClientId(createStorage().storage);
  const b = resolveLogicalClientId(createStorage().storage);

  assert.notEqual(a, b);
});

test('#111 a blank or malformed stored value is replaced, not propagated', () => {
  for (const bad of ['', '   ']) {
    const { storage, map } = createStorage({ [LOGICAL_CLIENT_ID_STORAGE_KEY]: bad });
    const resolved = resolveLogicalClientId(storage);
    assert.ok(resolved.trim().length > 0, JSON.stringify(bad));
    assert.equal(map.get(LOGICAL_CLIENT_ID_STORAGE_KEY), resolved, JSON.stringify(bad));
  }
});

test('#111 an unusable storage still yields an identity for this connection', () => {
  // Private mode, blocked site data: storage can throw on both read and write. Losing
  // cross-reconnect dedup is acceptable there; throwing on connect is not.
  const throwing = {
    getItem: () => { throw new Error('blocked'); },
    setItem: () => { throw new Error('blocked'); },
  };

  const resolved = resolveLogicalClientId(throwing);

  assert.ok(resolved.length > 0, 'a blocked storage must not prevent connecting');
});

test('#111 the resolved identity is written back so the next connection finds it', () => {
  const { storage, map } = createStorage();

  const resolved = resolveLogicalClientId(storage);

  assert.equal(map.get(LOGICAL_CLIENT_ID_STORAGE_KEY), resolved);
});
