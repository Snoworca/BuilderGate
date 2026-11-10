// FR-MCP-024: a remote is added with its MCP address and MCP key only. The address is turned into
// the link address, and the remote certificate is remembered on the first connection (TOFU).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { WebSocketServer } from 'ws';
import selfsigned from 'selfsigned';
import { createPeerLinkManager, type PeerDialHandlers } from './peerLinkManager.js';
import { DEFAULT_PEER_LINK_SETTINGS, validatePeerLinkSettings, type PeerLinkSettings } from './peerLinkSettings.js';
import { createPeerLinkControl, type PeerLinkFileStore } from './peerLinkStore.js';
import { dialPeerWebSocket } from './peerWsTransport.js';

const FP_A = 'ab'.repeat(32);
const FP_B = 'cd'.repeat(32);
const link = { name: 'azure', url: 'wss://10.0.1.13:3333/mcp/peer', accessKey: 'k', enabled: true };

function urlOf(input: string): string | undefined {
  const result = validatePeerLinkSettings({ links: [{ ...link, url: input }] }, DEFAULT_PEER_LINK_SETTINGS);
  return result.ok ? result.settings.links[0]!.url : undefined;
}

test('FR-MCP-024 AC-1: an MCP address in any common form becomes wss://host:port/mcp/peer', () => {
  const cases: Array<[string, string]> = [
    ['https://10.0.1.13:3333/mcp', 'wss://10.0.1.13:3333/mcp/peer'],
    ['https://10.0.1.13:3333/mcp/', 'wss://10.0.1.13:3333/mcp/peer'],
    ['10.0.1.13:3333', 'wss://10.0.1.13:3333/mcp/peer'],
    ['10.0.1.13', 'wss://10.0.1.13:3333/mcp/peer'],
    ['wss://10.0.1.13:3333', 'wss://10.0.1.13:3333/mcp/peer'],
    ['wss://10.0.1.13:3333/mcp/peer', 'wss://10.0.1.13:3333/mcp/peer'],
    ['https://azure.example:4444', 'wss://azure.example:4444/mcp/peer'],
    ['  https://10.0.1.13:3333/mcp  ', 'wss://10.0.1.13:3333/mcp/peer'],
  ];
  for (const [input, expected] of cases) assert.equal(urlOf(input), expected, input);
});

test('FR-MCP-024 AC-1 (review H1): a port written out is kept even when it is the scheme default; a link address keeps its own default', () => {
  assert.equal(urlOf('https://mcp.example:443/mcp'), 'wss://mcp.example:443/mcp/peer');
  assert.equal(urlOf('mcp.example:443'), 'wss://mcp.example:443/mcp/peer');
  // Links saved before FR-MCP-024 as wss://host/mcp/peer meant port 443; they must not move to 3333.
  assert.equal(urlOf('wss://mcp.example/mcp/peer'), 'wss://mcp.example/mcp/peer');
  assert.equal(urlOf('wss://mcp.example:443/mcp/peer'), 'wss://mcp.example:443/mcp/peer');
});

test('FR-MCP-024 AC-2: http and ws become ws only for a loopback host; plain HTTP to another host is refused with a hint', () => {
  assert.equal(urlOf('http://127.0.0.1:3333/mcp'), 'ws://127.0.0.1:3333/mcp/peer');
  assert.equal(urlOf('ws://localhost:3333'), 'ws://localhost:3333/mcp/peer');
  for (const input of ['http://10.0.1.13:3333/mcp', 'ws://10.0.1.13:3333/mcp/peer']) {
    const result = validatePeerLinkSettings({ links: [{ ...link, url: input }] }, DEFAULT_PEER_LINK_SETTINGS);
    assert.equal(result.ok, false, input);
    if (!result.ok) assert.match(result.fieldErrors['links.0.url'] ?? '', /HTTPS/, input);
  }
  for (const input of ['ftp://10.0.1.13', '', 'https://']) {
    assert.equal(urlOf(input), undefined, input);
  }
});

test('FR-MCP-024 AC-5: a save without the fingerprint keeps the remembered one; a new address or null drops it', () => {
  const current: PeerLinkSettings = { ...DEFAULT_PEER_LINK_SETTINGS, links: [{ ...link, tlsFingerprintSha256: FP_A }] };
  const kept = validatePeerLinkSettings({ links: [{ name: 'azure', url: 'https://10.0.1.13:3333/mcp', accessKey: '' }] }, current);
  assert.equal(kept.ok, true, JSON.stringify(kept));
  if (kept.ok) assert.equal(kept.settings.links[0]!.tlsFingerprintSha256, FP_A);

  const moved = validatePeerLinkSettings({ links: [{ name: 'azure', url: '10.0.1.99', accessKey: '' }] }, current);
  assert.equal(moved.ok, true);
  if (moved.ok) assert.equal(moved.settings.links[0]!.tlsFingerprintSha256, undefined);

  const cleared = validatePeerLinkSettings({ links: [{ ...link, accessKey: '', tlsFingerprintSha256: null }] }, current);
  assert.equal(cleared.ok, true);
  if (cleared.ok) assert.equal(cleared.settings.links[0]!.tlsFingerprintSha256, undefined);
});

test('FR-MCP-024 AC-3: the manager remembers the certificate before hello and does not reconnect for it', async () => {
  const sent: string[] = [];
  const learned: Array<[string, string]> = [];
  let dials = 0;
  let handlers: PeerDialHandlers | undefined;
  const manager = createPeerLinkManager({
    dial: (_link, h) => {
      dials += 1;
      handlers = h;
      return { send: (text) => sent.push(text), close: () => {} };
    },
    authenticate: async () => ({ ok: false, code: 'PEER_AUTH_FAILED' }),
    callTool: async () => ({ ok: true }),
    onFingerprintLearned: (name, _url, fingerprint) => learned.push([name, fingerprint]),
  }, { ...DEFAULT_PEER_LINK_SETTINGS, nodeName: 'corp', links: [link] });
  manager.start();
  assert.equal(dials, 1);
  handlers!.onCertificate?.(FP_A);
  assert.deepEqual(learned, [['azure', FP_A]]);
  assert.equal(sent.length, 0, 'nothing is sent before the certificate is remembered');
  handlers!.onOpen();
  assert.equal(JSON.parse(sent[0]!).t, 'hello');
  // The control saves the learned fingerprint and applies it; that is not a change of the link.
  manager.applySettings({ ...DEFAULT_PEER_LINK_SETTINGS, nodeName: 'corp', links: [{ ...link, tlsFingerprintSha256: FP_A }] });
  assert.equal(dials, 1);
  // A link that already has a fingerprint learns nothing new.
  handlers!.onCertificate?.(FP_B);
  assert.equal(learned.length, 1);
  manager.stop();
});

test('FR-MCP-024 AC-3 (review M3): a save queued before the learned fingerprint reached the file does not restart the link', () => {
  let dials = 0;
  let handlers: PeerDialHandlers | undefined;
  const manager = createPeerLinkManager({
    dial: (_link, h) => { dials += 1; handlers = h; return { send: () => {}, close: () => {} }; },
    authenticate: async () => ({ ok: false, code: 'PEER_AUTH_FAILED' }),
    callTool: async () => ({ ok: true }),
  }, { ...DEFAULT_PEER_LINK_SETTINGS, nodeName: 'corp', links: [link] });
  manager.start();
  handlers!.onCertificate?.(FP_A);
  // Another save (made before the fingerprint was saved) arrives without it: same link, no restart.
  manager.applySettings({ ...DEFAULT_PEER_LINK_SETTINGS, nodeName: 'corp', links: [{ ...link }] });
  assert.equal(dials, 1);
  // Then the learned fingerprint is saved: still no restart.
  manager.applySettings({ ...DEFAULT_PEER_LINK_SETTINGS, nodeName: 'corp', links: [{ ...link, tlsFingerprintSha256: FP_A }] });
  assert.equal(dials, 1);
  // Once saved, a link without it is "trust the new certificate": that restarts.
  manager.applySettings({ ...DEFAULT_PEER_LINK_SETTINGS, nodeName: 'corp', links: [{ ...link }] });
  assert.equal(dials, 2);
  manager.stop();
});

function memoryStore(): PeerLinkFileStore & { saved: PeerLinkSettings[] } {
  const saved: PeerLinkSettings[] = [];
  return { saved, load: async () => DEFAULT_PEER_LINK_SETTINGS, save: async (settings) => { saved.push(settings); } };
}

test('FR-MCP-024 AC-3/AC-4: the control saves a learned fingerprint and forgets it on "trust the new certificate"', async () => {
  const store = memoryStore();
  const applied: PeerLinkSettings[] = [];
  const control = createPeerLinkControl({
    store,
    initial: { ...DEFAULT_PEER_LINK_SETTINGS, links: [link] },
    apply: (settings) => applied.push(settings),
    status: () => [],
  });
  // review M2: a certificate met at an address the link no longer has is not saved on it.
  await control.learnFingerprint('azure', 'wss://10.0.1.99:3333/mcp/peer', FP_B);
  assert.equal(control.settings().links[0]!.tlsFingerprintSha256, undefined);
  await control.learnFingerprint('azure', link.url, FP_A);
  assert.equal(control.settings().links[0]!.tlsFingerprintSha256, FP_A);
  assert.equal(store.saved.at(-1)!.links[0]!.tlsFingerprintSha256, FP_A);
  assert.equal(control.settings().links[0]!.accessKey, 'k');
  // A second learn for the same link does not overwrite the remembered certificate.
  await control.learnFingerprint('azure', link.url, FP_B);
  assert.equal(control.settings().links[0]!.tlsFingerprintSha256, FP_A);

  const result = await control.forgetFingerprint('azure');
  assert.equal(result.ok, true);
  assert.equal(control.settings().links[0]!.tlsFingerprintSha256, undefined);
  assert.equal(applied.at(-1)!.links[0]!.tlsFingerprintSha256, undefined);
  const missing = await control.forgetFingerprint('nobody');
  assert.equal(missing.ok, false);
});

test('FR-MCP-024 AC-3/AC-4: an unpinned self-signed remote connects and reports its certificate before it opens', async () => {
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'peer-test' }], { keySize: 2048, algorithm: 'sha256' });
  const fingerprint = new crypto.X509Certificate(pems.cert).fingerprint256.replace(/:/g, '').toLowerCase();
  const received: string[] = [];
  const server = https.createServer({ cert: pems.cert, key: pems.private });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => {
    ws.on('message', (data) => received.push(String(data)));
  }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const url = `wss://127.0.0.1:${port}/mcp/peer`;
  try {
    const order: string[] = [];
    const socket = dialPeerWebSocket({ name: 'a', url, accessKey: 'k', enabled: true }, {
      onCertificate: (presented) => order.push(`cert:${presented}`),
      onOpen: () => { order.push('open'); socket.send('hello'); },
      onText: () => {},
      onClose: () => {},
    });
    const start = Date.now();
    while (received.length === 0 && Date.now() - start < 5_000) await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(order, [`cert:${fingerprint}`, 'open']);
    assert.deepEqual(received, ['hello']);
    socket.close();
  } finally {
    wss.close();
    server.closeAllConnections();
    server.close();
  }
});
