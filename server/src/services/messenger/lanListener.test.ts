// FR-MSG-014 (committee decision A): "receive connections from the company network" opens a second,
// dedicated TLS listener for peer links and contact requests only. The MCP listener is left alone.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import selfsigned from 'selfsigned';
import WebSocket from 'ws';
import { carriesForwardingHeader, createLanReceiver, lanAddressAllowed, openLanPeerListener, type LanListenerHandle } from './lanListener.js';

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'messenger-lan-'));
}

function fakeOpener() {
  const opened: number[] = [];
  const closed: number[] = [];
  const busy = new Set<number>();
  return {
    opened,
    closed,
    busy,
    open: async (port: number) => {
      if (busy.has(port)) return { ok: false as const, code: 'LAN_PORT_IN_USE' as const };
      opened.push(port);
      return { ok: true as const, handle: { close: async () => { closed.push(port); } } satisfies LanListenerHandle };
    },
  };
}

test('FR-MSG-014: off by default on the MCP port + 1', async () => {
  const dir = await tempDir();
  const opener = fakeOpener();
  const receiver = createLanReceiver({ path: path.join(dir, 'lan.json'), defaultPort: 3334, open: opener.open });
  assert.deepEqual(receiver.status(), { receiving: false, port: 3334 });
});

test('FR-MSG-014 AC-2: turning it on opens the listener, saves the choice, and a restart opens it again', async () => {
  const dir = await tempDir();
  const lanPath = path.join(dir, 'lan.json');
  const opener = fakeOpener();
  const receiver = createLanReceiver({ path: lanPath, defaultPort: 3334, open: opener.open });
  assert.deepEqual(await receiver.set({ receiving: true }), { ok: true, receiving: true, port: 3334 });
  assert.deepEqual(opener.opened, [3334]);
  assert.deepEqual(receiver.status(), { receiving: true, port: 3334 });

  const again = fakeOpener();
  const restarted = createLanReceiver({ path: lanPath, defaultPort: 3334, open: again.open });
  assert.deepEqual(restarted.status(), { receiving: true, port: 3334 });
  await restarted.startFromSaved();
  assert.deepEqual(again.opened, [3334]);
});

test('FR-MSG-014: a busy port answers LAN_PORT_IN_USE with the port and stays off', async () => {
  const dir = await tempDir();
  const opener = fakeOpener();
  opener.busy.add(3334);
  const receiver = createLanReceiver({ path: path.join(dir, 'lan.json'), defaultPort: 3334, open: opener.open });
  assert.deepEqual(await receiver.set({ receiving: true }), { ok: false, code: 'LAN_PORT_IN_USE', port: 3334 });
  assert.deepEqual(receiver.status(), { receiving: false, port: 3334 });
  assert.deepEqual(await receiver.set({ receiving: true, port: 4000 }), { ok: true, receiving: true, port: 4000 });
});

test('FR-MSG-014: turning it off closes the listener; a new port while on moves the listener', async () => {
  const dir = await tempDir();
  const opener = fakeOpener();
  const receiver = createLanReceiver({ path: path.join(dir, 'lan.json'), defaultPort: 3334, open: opener.open });
  await receiver.set({ receiving: true });
  assert.deepEqual(await receiver.set({ receiving: true, port: 4000 }), { ok: true, receiving: true, port: 4000 });
  assert.deepEqual(opener.closed, [3334]);
  assert.deepEqual(opener.opened, [3334, 4000]);
  assert.deepEqual(await receiver.set({ receiving: false }), { ok: true, receiving: false, port: 4000 });
  assert.deepEqual(opener.closed, [3334, 4000]);
  assert.deepEqual(await receiver.set({ receiving: true, port: 70_000 }), { ok: false, code: 'LAN_PORT_INVALID' });
});

test('FR-MSG-014: only loopback and the private IPv4 ranges may come in', () => {
  for (const address of ['127.0.0.1', '::1', '::ffff:192.168.1.9', '10.2.3.4', '172.16.0.1', '172.31.255.255', '192.168.0.1']) {
    assert.equal(lanAddressAllowed(address), true, address);
  }
  for (const address of ['8.8.8.8', '172.32.0.1', '::ffff:1.2.3.4', '2001:db8::1', '']) {
    assert.equal(lanAddressAllowed(address), false, address);
  }
});

async function certFiles() {
  const dir = await tempDir();
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'lan-test' }], { keySize: 2048, algorithm: 'sha256' });
  const certPath = path.join(dir, 'cert.pem');
  const keyPath = path.join(dir, 'key.pem');
  await fs.writeFile(certPath, pems.cert);
  await fs.writeFile(keyPath, pems.private);
  return { certPath, keyPath, caPath: '' };
}

function request(port: number, method: string, pathName: string, body?: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request({ host: '127.0.0.1', port, method, path: pathName, rejectUnauthorized: false, headers }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

test('FR-MSG-014: the dedicated listener serves TLS, takes /mcp/peer and /mcp/contact-request only, and answers 404 to the rest', async () => {
  const sslConfig = await certFiles();
  const accepted: Array<Record<string, unknown>> = [];
  const contactCalls: string[] = [];
  let allowed = true;
  const port = await freePort();
  const opened = await openLanPeerListener({
    port,
    sslConfig,
    isAllowed: () => allowed,
    accept: (socket, req) => {
      accepted.push(req as Record<string, unknown>);
      return { onText: () => {}, onClose: () => {} };
    },
    contactRequest: (req, res) => {
      if (!(req.url ?? '').startsWith('/mcp/contact-request')) return false;
      contactCalls.push(req.url ?? '');
      res.end('{"ok":true}');
      return true;
    },
  });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  if (!opened.ok) return;
  try {
    assert.equal((await request(port, 'GET', '/mcp')).status, 404);
    assert.equal((await request(port, 'POST', '/mcp', '{}')).status, 404);
    assert.equal((await request(port, 'POST', '/mcp/contact-request', '{}')).body, '{"ok":true}');
    assert.deepEqual(contactCalls, ['/mcp/contact-request']);

    const ws = new WebSocket(`wss://127.0.0.1:${port}/mcp/peer`, { rejectUnauthorized: false });
    await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
    ws.close();
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0]!.via, 'lan');

    allowed = false;
    assert.equal((await request(port, 'POST', '/mcp/contact-request', '{}')).status, 403);
    assert.deepEqual(contactCalls, ['/mcp/contact-request']);

    const busy = await openLanPeerListener({ port, sslConfig, isAllowed: () => true, accept: () => ({ onText: () => {}, onClose: () => {} }), contactRequest: () => false });
    assert.deepEqual(busy, { ok: false, code: 'LAN_PORT_IN_USE' });
  } finally {
    await opened.handle.close();
  }
});

test('FR-MSG-014: a request that came through a proxy is refused (forwarding headers)', () => {
  for (const name of ['x-forwarded-for', 'forwarded', 'x-real-ip', 'cf-connecting-ip']) {
    assert.equal(carriesForwardingHeader({ [name]: '10.0.0.1' }), true, name);
  }
  assert.equal(carriesForwardingHeader({ host: 'x', 'user-agent': 'y' }), false);
});

test('FR-MSG-014: the LAN listener answers 403 to HTTP and refuses the upgrade when a forwarding header is present', async () => {
  const sslConfig = await certFiles();
  const accepted: unknown[] = [];
  const contactCalls: string[] = [];
  const port = await freePort();
  const opened = await openLanPeerListener({
    port,
    sslConfig,
    isAllowed: () => true,
    accept: (_socket, req) => { accepted.push(req); return { onText: () => {}, onClose: () => {} }; },
    contactRequest: (req, res) => {
      if (!(req.url ?? '').startsWith('/mcp/contact-request')) return false;
      contactCalls.push(req.url ?? '');
      res.end('{"ok":true}');
      return true;
    },
  });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  try {
    for (const name of ['X-Forwarded-For', 'Forwarded', 'X-Real-IP', 'CF-Connecting-IP']) {
      const refused = await request(port, 'POST', '/mcp/contact-request', '{}', { [name]: '192.168.0.9' });
      assert.equal(refused.status, 403, name);
      const ws = new WebSocket(`wss://127.0.0.1:${port}/mcp/peer`, { rejectUnauthorized: false, headers: { [name]: '192.168.0.9' } });
      const outcome = await new Promise<string>((resolve) => {
        ws.once('open', () => { ws.close(); resolve('open'); });
        ws.once('error', () => resolve('refused'));
      });
      assert.equal(outcome, 'refused', name);
    }
    assert.deepEqual(contactCalls, []);
    assert.deepEqual(accepted, []);
  } finally {
    await opened.handle.close();
  }
});
