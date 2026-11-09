// FR-MCP-016 AC-1/AC-2/AC-5/AC-7 (#233): the WebSocket transport of the peer link, on real sockets
// over loopback.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import selfsigned from 'selfsigned';
import { createPeerLinkManager } from './peerLinkManager.js';
import { DEFAULT_PEER_LINK_SETTINGS } from './peerLinkSettings.js';
import { createPeerUpgradeHandler, dialPeerWebSocket, PEER_MAX_FRAME_BYTES, peerUpgradeAllowed } from './peerWsTransport.js';

type Rec = Record<string, unknown>;

async function listen(server: http.Server | https.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

function waitFor(check: () => boolean, ms = 5_000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (check()) resolve();
      else if (Date.now() - start > ms) reject(new Error('timed out'));
      else setTimeout(tick, 10);
    };
    tick();
  });
}

const noop = { onOpen: () => {}, onText: () => {}, onClose: () => {} };

test('FR-MCP-016 AC-1: ws:// to a host that is not loopback is refused before any connection', () => {
  assert.throws(
    () => dialPeerWebSocket({ name: 'x', url: 'ws://10.0.0.5:3333/mcp/peer', accessKey: 'k', enabled: true }, noop),
    /PEER_URL_NOT_ALLOWED/,
  );
});

test('FR-MCP-016 AC-5: a plain-HTTP listener takes links only from loopback', () => {
  assert.equal(peerUpgradeAllowed('none', '10.1.1.1'), false);
  assert.equal(peerUpgradeAllowed('none', '127.0.0.1'), true);
  assert.equal(peerUpgradeAllowed('none', '::ffff:127.0.0.1'), true);
  assert.equal(peerUpgradeAllowed('none', '::1'), true);
  assert.equal(peerUpgradeAllowed('direct_tls', '10.1.1.1'), true);
  assert.equal(peerUpgradeAllowed('trusted_proxy', '10.1.1.1'), true);
});

test('FR-MCP-016: two managers talk over a real WebSocket; other paths are left alone', async () => {
  const server = http.createServer();
  const calls: Rec[] = [];
  const acceptor = createPeerLinkManager({
    dial: () => { throw new Error('unused'); },
    authenticate: async (key) => (key === 'k' ? { ok: true, scopes: ['mcp:sessions.list', 'mcp:message.paste'] } : { ok: false, code: 'PEER_AUTH_FAILED' }),
    callTool: async (tool, args) => { calls.push({ tool, args }); return { ok: true, status: 'delivered' }; },
  }, { ...DEFAULT_PEER_LINK_SETTINGS, nodeName: 'azure' });
  const handle = createPeerUpgradeHandler({ manager: acceptor, isAllowed: () => true });
  let otherPath = false;
  server.on('upgrade', (req, socket, head) => {
    if (!handle(req, socket, head)) {
      otherPath = true;
      socket.destroy();
    }
  });
  const port = await listen(server);
  const dialer = createPeerLinkManager({
    dial: dialPeerWebSocket,
    authenticate: async () => ({ ok: false, code: 'PEER_AUTH_FAILED' }),
    callTool: async () => ({ ok: true }),
  }, { ...DEFAULT_PEER_LINK_SETTINGS, nodeName: 'corp', links: [{ name: 'azure', url: `ws://127.0.0.1:${port}/mcp/peer`, accessKey: 'k', enabled: true }] });
  try {
    dialer.start();
    await waitFor(() => dialer.list()[0]?.state === 'connected');
    const result = await dialer.sendMessage({ peer: 'azure', args: { target: 'w', prompt: 'hello' }, scopes: ['mcp:message.paste'], hasKeys: false });
    assert.equal(result.status, 'delivered', JSON.stringify(result));
    assert.deepEqual(calls[0], { tool: 'buildergate.message.send', args: { target: 'w', prompt: 'hello' } });
    const other = new WebSocket(`ws://127.0.0.1:${port}/elsewhere`);
    await new Promise((resolve) => { other.on('error', resolve); other.on('close', resolve); });
    assert.equal(otherPath, true);
  } finally {
    dialer.stop();
    acceptor.stop();
    server.closeAllConnections();
    server.close();
  }
});

test('FR-MCP-016 AC-7: a frame over 1 MiB closes the connection', async () => {
  const server = http.createServer();
  const acceptor = createPeerLinkManager({
    dial: () => { throw new Error('unused'); },
    authenticate: async () => ({ ok: false, code: 'PEER_AUTH_FAILED' }),
    callTool: async () => ({ ok: true }),
  }, DEFAULT_PEER_LINK_SETTINGS);
  const handle = createPeerUpgradeHandler({ manager: acceptor, isAllowed: () => true });
  server.on('upgrade', (req, socket, head) => { if (!handle(req, socket, head)) socket.destroy(); });
  const port = await listen(server);
  try {
    const client = new WebSocket(`ws://127.0.0.1:${port}/mcp/peer`);
    await new Promise((resolve) => client.on('open', resolve));
    const code = new Promise<number>((resolve) => client.on('close', (c) => resolve(c)));
    client.send('x'.repeat(PEER_MAX_FRAME_BYTES + 1));
    assert.equal(await code, 1009);
  } finally {
    acceptor.stop();
    server.closeAllConnections();
    server.close();
  }
});

test('FR-MCP-016 AC-2/AC-3: with a pinned fingerprint the key goes out only to the matching certificate', async () => {
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'peer-test' }], { keySize: 2048, algorithm: 'sha256' });
  const fingerprint = new crypto.X509Certificate(pems.cert).fingerprint256.replace(/:/g, '').toLowerCase();
  const received: string[] = [];
  const server = https.createServer({ cert: pems.cert, key: pems.private });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => {
    ws.on('message', (data) => received.push(String(data)));
  }));
  const port = await listen(server);
  const url = `wss://127.0.0.1:${port}/mcp/peer`;
  try {
    let closedWith: string | undefined;
    const wrong = dialPeerWebSocket({ name: 'a', url, accessKey: 'k', enabled: true, tlsFingerprintSha256: '0'.repeat(64) }, {
      onOpen: () => wrong.send('{"t":"hello","key":"k"}'),
      onText: () => {},
      onClose: (reason) => { closedWith = reason; },
    });
    await waitFor(() => closedWith !== undefined);
    assert.equal(closedWith, 'PEER_TLS_FINGERPRINT_MISMATCH');
    assert.deepEqual(received, []);

    let opened = false;
    const right = dialPeerWebSocket({ name: 'a', url, accessKey: 'k', enabled: true, tlsFingerprintSha256: fingerprint }, {
      onOpen: () => { opened = true; right.send('{"t":"hello","key":"k"}'); },
      onText: () => {},
      onClose: () => {},
    });
    await waitFor(() => received.length === 1);
    assert.equal(opened, true);
    right.close();

    // Without a pin the self-signed certificate fails ordinary verification.
    let unpinned: string | undefined;
    dialPeerWebSocket({ name: 'a', url, accessKey: 'k', enabled: true }, {
      onOpen: () => {},
      onText: () => {},
      onClose: (reason) => { unpinned = reason; },
    });
    await waitFor(() => unpinned !== undefined);
    assert.equal(received.length, 1);
  } finally {
    wss.close();
    server.closeAllConnections();
    server.close();
  }
});
