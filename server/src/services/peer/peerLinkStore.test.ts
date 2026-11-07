// FR-MCP-020 AC-2/AC-3/AC-4 (#233): the peer link settings file and the control behind
// GET/PUT /api/mcp-control/peers.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CryptoService } from '../CryptoService.js';
import { createPeerLinkControl, createPeerLinkFileStore } from './peerLinkStore.js';
import { DEFAULT_PEER_LINK_SETTINGS, type PeerLinkSettings } from './peerLinkSettings.js';

const link = { name: 'azure', url: 'wss://20.1.2.3:3333/mcp/peer', accessKey: 'secret-key-123', enabled: true };

async function tempPath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'peer-store-'));
  return path.join(dir, 'mcp-peer-links.json');
}

test('FR-MCP-020 AC-2: the access key is stored encrypted and read back', async () => {
  const dataPath = await tempPath();
  const crypto = new CryptoService('machine-a');
  const store = createPeerLinkFileStore({ dataPath, crypto, hostName: 'CORP-PC01' });
  const empty = await store.load();
  assert.equal(empty.nodeName, 'CORP-PC01');
  assert.deepEqual(empty.links, []);
  await store.save({ ...DEFAULT_PEER_LINK_SETTINGS, nodeName: 'corp', links: [link] });
  const raw = await fs.readFile(dataPath, 'utf8');
  assert.equal(raw.includes('secret-key-123'), false);
  const loaded = await store.load();
  assert.equal(loaded.nodeName, 'corp');
  assert.equal(loaded.links[0]!.accessKey, 'secret-key-123');
  // Another machine cannot read the key; the link stays, without it.
  const other = await createPeerLinkFileStore({ dataPath, crypto: new CryptoService('machine-b'), hostName: 'x', warn: () => {} }).load();
  assert.equal(other.links[0]!.name, 'azure');
  assert.equal(other.links[0]!.accessKey, '');
});

test('FR-MCP-020 AC-2/AC-3/AC-4: the control hides keys, refuses bad values, and applies a good save', async () => {
  const dataPath = await tempPath();
  const store = createPeerLinkFileStore({ dataPath, crypto: new CryptoService('machine-a'), hostName: 'corp' });
  const applied: PeerLinkSettings[] = [];
  const control = createPeerLinkControl({
    store,
    initial: await store.load(),
    apply: (settings) => applied.push(settings),
    status: () => [{ name: 'azure', direction: 'outbound', state: 'connecting', queued: 0 }],
  });
  const bad = await control.update({ heartbeatMs: 10 });
  assert.equal(bad.ok, false);
  assert.ok('heartbeatMs' in (bad.fieldErrors as Record<string, string>));
  assert.equal(applied.length, 0);

  const saved = await control.update({ links: [link] });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.equal(applied.length, 1);
  assert.equal(applied[0]!.links[0]!.accessKey, 'secret-key-123');
  assert.equal(JSON.stringify(saved).includes('secret-key-123'), false);

  const view = control.get();
  assert.equal(JSON.stringify(view).includes('secret-key-123'), false);
  const links = (view.settings as { links: Array<Record<string, unknown>> }).links;
  assert.equal(links[0]!.hasAccessKey, true);
  assert.equal(links[0]!.accessKey, undefined);
  assert.deepEqual(view.peers, [{ name: 'azure', direction: 'outbound', state: 'connecting', queued: 0 }]);
  assert.equal((view.defaults as Record<string, unknown>).timeoutRatio, 2.5);

  // Saving the same link with an empty key keeps the stored key.
  const again = await control.update({ links: [{ ...link, accessKey: '' }] });
  assert.equal(again.ok, true);
  assert.equal(applied[1]!.links[0]!.accessKey, 'secret-key-123');
  assert.equal((await store.load()).links[0]!.accessKey, 'secret-key-123');
});

test('FR-MSG-009: a room link keeps its kind across save and load', async () => {
  const dataPath = await tempPath();
  const store = createPeerLinkFileStore({ dataPath, crypto: new CryptoService('machine-a'), hostName: 'corp' });
  await store.save({ ...DEFAULT_PEER_LINK_SETTINGS, nodeName: 'corp', links: [link, { ...link, name: 'host1', kind: 'room' }] });
  const loaded = await store.load();
  assert.equal(loaded.links[0]!.kind, undefined);
  assert.equal(loaded.links[1]!.kind, 'room');
});

test('FR-MSG-008: the control hands the current settings, keys included, to the messenger', async () => {
  const dataPath = await tempPath();
  const store = createPeerLinkFileStore({ dataPath, crypto: new CryptoService('machine-a'), hostName: 'corp' });
  const control = createPeerLinkControl({ store, initial: await store.load(), apply: () => {}, status: () => [] });
  await control.update({ links: [link] });
  assert.equal(control.settings().links[0]!.accessKey, 'secret-key-123');
});
