// FR-MCP-024 AC-6: the MCP key is kept encrypted with this machine's key next to its hash, so a
// signed-in user can see it again. A key stored by an older version as a hash only cannot be shown.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CryptoService } from './CryptoService.js';
import { createMcpFixedAccessKeyVault } from './McpFixedAccessKeyVault.js';
import { createMcpFixedAccessKey } from './McpSecurityContract.js';

type Rec = Record<string, unknown>;

test('FR-MCP-024 AC-6: a rotated key is saved as hash plus ciphertext and can be revealed and verified', async () => {
  const persisted: Rec[] = [];
  const vault = createMcpFixedAccessKeyVault({
    cipher: new CryptoService('machine-a'),
    initial: {},
    persist: async (fields) => { persisted.push(fields); return { ok: true }; },
  });
  assert.equal(vault.configured(), false);
  assert.deepEqual(vault.reveal(), { ok: false, code: 'MCP_FIXED_ACCESS_KEY_NOT_CONFIGURED' });

  const rotated = await vault.rotate();
  assert.equal(rotated.ok, true);
  const accessKey = rotated.ok ? rotated.accessKey : '';
  assert.match(accessKey, /^bgmcp_/);
  assert.equal(vault.configured(), true);
  assert.equal(vault.verify(accessKey), true);
  assert.equal(vault.verify('bgmcp_wrong'), false);
  assert.deepEqual(vault.reveal(), { ok: true, accessKey });

  const saved = persisted.at(-1)!;
  assert.match(String(saved.fixedAccessKeyHash), /^sha256:/);
  assert.equal(typeof saved.fixedAccessKeyEncrypted, 'string');
  assert.equal(String(saved.fixedAccessKeyEncrypted).includes(accessKey), false, 'the key is not stored in plain text');

  // The next start reads the same fields back.
  const reloaded = createMcpFixedAccessKeyVault({
    cipher: new CryptoService('machine-a'),
    initial: { fixedAccessKeyHash: String(saved.fixedAccessKeyHash), fixedAccessKeyEncrypted: String(saved.fixedAccessKeyEncrypted) },
    persist: async () => ({ ok: true }),
  });
  assert.deepEqual(reloaded.reveal(), { ok: true, accessKey });
});

test('FR-MCP-024 AC-6: a hash-only key still verifies but cannot be revealed; so does a key encrypted on another machine', () => {
  const generated = createMcpFixedAccessKey() as Rec;
  const accessKey = String(generated.accessKey);
  const hashOnly = createMcpFixedAccessKeyVault({
    cipher: new CryptoService('machine-a'),
    initial: { fixedAccessKeyHash: String(generated.keyHash) },
    persist: async () => ({ ok: true }),
  });
  assert.equal(hashOnly.configured(), true);
  assert.equal(hashOnly.verify(accessKey), true);
  assert.deepEqual(hashOnly.reveal(), { ok: false, code: 'MCP_FIXED_ACCESS_KEY_NOT_REVEALABLE' });

  const foreign = createMcpFixedAccessKeyVault({
    cipher: new CryptoService('machine-b'),
    initial: { fixedAccessKeyHash: String(generated.keyHash), fixedAccessKeyEncrypted: new CryptoService('machine-a').encrypt(accessKey) },
    persist: async () => ({ ok: true }),
  });
  assert.equal(foreign.verify(accessKey), true);
  assert.deepEqual(foreign.reveal(), { ok: false, code: 'MCP_FIXED_ACCESS_KEY_NOT_REVEALABLE' });
});

test('FR-MCP-024 AC-6: a failed save keeps the old key', async () => {
  const generated = createMcpFixedAccessKey() as Rec;
  const vault = createMcpFixedAccessKeyVault({
    cipher: new CryptoService('machine-a'),
    initial: { fixedAccessKeyHash: String(generated.keyHash) },
    persist: async () => ({ ok: false, code: 'MCP_CONTROL_CONFIG_PERSIST_FAILED' }),
  });
  const rotated = await vault.rotate();
  assert.deepEqual(rotated, { ok: false, code: 'MCP_CONTROL_CONFIG_PERSIST_FAILED' });
  assert.equal(vault.verify(String(generated.accessKey)), true);
});
