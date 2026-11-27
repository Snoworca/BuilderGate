// FR-MSG-014 (committee decision A): "receive connections from the company network" opens a second,
// dedicated TLS listener for peer links and contact requests only. The MCP listener is left alone.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import selfsigned from 'selfsigned';
import WebSocket from 'ws';
import { carriesForwardingHeader, createLanReceiver, LAN_WHITELIST, lanAddressAllowed, openLanPeerListener, type LanListenerHandle, type LanProtocol } from './lanListener.js';

const INTERNAL = [...LAN_WHITELIST];

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'messenger-lan-'));
}

function fakeOpener() {
  const opened: number[] = [];
  const protocols: LanProtocol[] = [];
  const closed: number[] = [];
  const busy = new Set<number>();
  return {
    opened,
    protocols,
    closed,
    busy,
    open: async ({ port, protocol }: { port: number; protocol: LanProtocol }) => {
      if (busy.has(port)) return { ok: false as const, code: 'LAN_PORT_IN_USE' as const };
      opened.push(port);
      protocols.push(protocol);
      return { ok: true as const, handle: { close: async () => { closed.push(port); } } satisfies LanListenerHandle };
    },
  };
}

test('FR-MSG-014: off by default on the MCP port + 1', async () => {
  const dir = await tempDir();
  const opener = fakeOpener();
  const receiver = createLanReceiver({ path: path.join(dir, 'lan.json'), defaultPort: 3334, open: opener.open });
  assert.deepEqual(receiver.status(), { receiving: false, port: 3334, protocol: 'http', allowList: INTERNAL });
});

test('FR-MSG-014 AC-2: turning it on opens the listener, saves the choice, and a restart opens it again', async () => {
  const dir = await tempDir();
  const lanPath = path.join(dir, 'lan.json');
  const opener = fakeOpener();
  const receiver = createLanReceiver({ path: lanPath, defaultPort: 3334, open: opener.open });
  assert.deepEqual(await receiver.set({ receiving: true }), { ok: true, receiving: true, port: 3334, protocol: 'http', allowList: INTERNAL });
  assert.deepEqual(opener.opened, [3334]);
  assert.deepEqual(receiver.status(), { receiving: true, port: 3334, protocol: 'http', allowList: INTERNAL });

  const again = fakeOpener();
  const restarted = createLanReceiver({ path: lanPath, defaultPort: 3334, open: again.open });
  assert.deepEqual(restarted.status(), { receiving: true, port: 3334, protocol: 'http', allowList: INTERNAL });
  await restarted.startFromSaved();
  assert.deepEqual(again.opened, [3334]);
});

test('FR-MSG-014: a busy port answers LAN_PORT_IN_USE with the port and stays off', async () => {
  const dir = await tempDir();
  const opener = fakeOpener();
  opener.busy.add(3334);
  const receiver = createLanReceiver({ path: path.join(dir, 'lan.json'), defaultPort: 3334, open: opener.open });
  assert.deepEqual(await receiver.set({ receiving: true }), { ok: false, code: 'LAN_PORT_IN_USE', port: 3334 });
  assert.deepEqual(receiver.status(), { receiving: false, port: 3334, protocol: 'http', allowList: INTERNAL });
  assert.deepEqual(await receiver.set({ receiving: true, port: 4000 }), { ok: true, receiving: true, port: 4000, protocol: 'http', allowList: INTERNAL });
});

test('FR-MSG-014: turning it off closes the listener; a new port while on moves the listener', async () => {
  const dir = await tempDir();
  const opener = fakeOpener();
  const receiver = createLanReceiver({ path: path.join(dir, 'lan.json'), defaultPort: 3334, open: opener.open });
  await receiver.set({ receiving: true });
  assert.deepEqual(await receiver.set({ receiving: true, port: 4000 }), { ok: true, receiving: true, port: 4000, protocol: 'http', allowList: INTERNAL });
  assert.deepEqual(opener.closed, [3334]);
  assert.deepEqual(opener.opened, [3334, 4000]);
  assert.deepEqual(await receiver.set({ receiving: false }), { ok: true, receiving: false, port: 4000, protocol: 'http', allowList: INTERNAL });
  assert.deepEqual(opener.closed, [3334, 4000]);
  assert.deepEqual(await receiver.set({ receiving: true, port: 70_000 }), { ok: false, code: 'LAN_PORT_INVALID' });
});

test('FR-MSG-014 AC-3: the protocol is http by default, https on request; a change while on reopens the listener and is saved', async () => {
  const dir = await tempDir();
  const lanPath = path.join(dir, 'lan.json');
  const opener = fakeOpener();
  const receiver = createLanReceiver({ path: lanPath, defaultPort: 3334, open: opener.open });
  await receiver.set({ receiving: true });
  assert.deepEqual(opener.protocols, ['http']);
  const switched = await receiver.set({ receiving: true, protocol: 'https' });
  assert.equal(switched.ok && switched.protocol, 'https');
  assert.deepEqual(opener.closed, [3334]);
  assert.deepEqual(opener.protocols, ['http', 'https']);
  assert.deepEqual(await receiver.set({ receiving: true, protocol: 'ftp' as LanProtocol }), { ok: false, code: 'LAN_PROTOCOL_INVALID' });

  const again = fakeOpener();
  const restarted = createLanReceiver({ path: lanPath, defaultPort: 3334, open: again.open });
  assert.equal(restarted.status().protocol, 'https');
  await restarted.startFromSaved();
  assert.deepEqual(again.protocols, ['https']);
});

test('FR-MSG-014 AC-4: the allow list is the internal network by default, editable without a reopen, and loopback always comes in', async () => {
  const dir = await tempDir();
  const lanPath = path.join(dir, 'lan.json');
  const opener = fakeOpener();
  const receiver = createLanReceiver({ path: lanPath, defaultPort: 3334, open: opener.open });
  await receiver.set({ receiving: true });
  assert.equal(receiver.isAllowed('192.168.0.9'), true);
  assert.equal(receiver.isAllowed('8.8.8.8'), false);

  const narrowed = await receiver.set({ receiving: true, allowList: ['203.0.113.0/24'] });
  assert.equal(narrowed.ok, true);
  assert.deepEqual(opener.opened, [3334], 'the list applies without reopening the listener');
  assert.equal(receiver.isAllowed('203.0.113.7'), true);
  assert.equal(receiver.isAllowed('192.168.0.9'), false);
  assert.equal(receiver.isAllowed('127.0.0.1'), true);
  assert.equal(receiver.isAllowed('::1'), true);

  await receiver.set({ receiving: true, allowList: [] });
  assert.equal(receiver.isAllowed('127.0.0.1'), true);
  assert.equal(receiver.isAllowed('10.0.0.1'), false);

  await receiver.set({ receiving: true, allowList: ['*'] });
  assert.equal(receiver.isAllowed('8.8.8.8'), true);
  assert.equal(receiver.isAllowed('2001:db8::1'), true);

  for (const bad of [['0.0.0.0/0'], ['10.0.0.0/33'], ['example.com'], ['10.0.0.1', 7]]) {
    assert.deepEqual(await receiver.set({ receiving: true, allowList: bad as string[] }), { ok: false, code: 'LAN_ALLOW_LIST_INVALID' }, JSON.stringify(bad));
  }
  const restarted = createLanReceiver({ path: lanPath, defaultPort: 3334, open: fakeOpener().open });
  assert.deepEqual(restarted.status().allowList, ['*']);
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
    protocol: 'https',
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

    const busy = await openLanPeerListener({ port, protocol: 'https', sslConfig, isAllowed: () => true, accept: () => ({ onText: () => {}, onClose: () => {} }), contactRequest: () => false });
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
    protocol: 'https',
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

test('FR-MSG-014 AC-3: an http listener opens without a certificate and serves /mcp/contact-request and ws:// /mcp/peer', async () => {
  const accepted: Array<Record<string, unknown>> = [];
  const port = await freePort();
  const opened = await openLanPeerListener({
    port,
    protocol: 'http',
    sslConfig: { certPath: '/nonexistent/cert.pem', keyPath: '/nonexistent/key.pem', caPath: '' },
    isAllowed: () => true,
    accept: (_socket, req) => { accepted.push(req as Record<string, unknown>); return { onText: () => {}, onClose: () => {} }; },
    contactRequest: (req, res) => {
      if (!(req.url ?? '').startsWith('/mcp/contact-request')) return false;
      res.end('{"ok":true}');
      return true;
    },
  });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  if (!opened.ok) return;
  try {
    const answer = await new Promise<string>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/mcp/contact-request' }, (res) => {
        let text = '';
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => resolve(text));
      });
      req.on('error', reject);
      req.end('{}');
    });
    assert.equal(answer, '{"ok":true}');
    const ws = new WebSocket(`ws://127.0.0.1:${port}/mcp/peer`);
    await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
    ws.close();
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0]!.via, 'lan');
  } finally {
    await opened.handle.close();
  }
});

test('FR-MSG-014 AC-3: an https listener without a readable certificate does not open (LAN_TLS_UNAVAILABLE)', async () => {
  const port = await freePort();
  const opened = await openLanPeerListener({
    port,
    protocol: 'https',
    sslConfig: { certPath: '/nonexistent/cert.pem', keyPath: '/nonexistent/key.pem', caPath: '' },
    isAllowed: () => true,
    accept: () => ({ onText: () => {}, onClose: () => {} }),
    contactRequest: () => false,
  });
  if (opened.ok) await opened.handle.close();
  assert.deepEqual(opened, { ok: false, code: 'LAN_TLS_UNAVAILABLE' });
});

test('FR-MSG-014 AC-3: a settings file saved before the protocol choice keeps https, so contacts saved as wss:// still connect', async () => {
  const dir = await tempDir();
  const lanPath = path.join(dir, 'lan.json');
  await fs.writeFile(lanPath, JSON.stringify({ version: 1, receiving: true, port: 3334 }));
  const receiver = createLanReceiver({ path: lanPath, defaultPort: 3334, open: fakeOpener().open });
  assert.equal(receiver.status().protocol, 'https');
  assert.deepEqual(receiver.status().allowList, INTERNAL);
});

test('FR-MSG-014 AC-4: the default allow list is exactly the three private ranges; loopback is allowed outside the list', () => {
  assert.deepEqual(INTERNAL, ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16']);
});
