// #76: handleUpgrade accepted the client's `?wsTransportMode=` without checking it against the
// server's configuration, so a client could put its own connection into split on a server the
// operator configured as unified -- and, because the binary wire-format gate keys off the
// CONNECTION's mode, silently turn binary negotiation off for itself.
//
// These cases drive a real upgrade over a named-pipe HTTP server rather than constructing the
// connection metadata directly: the defect lived in handleUpgrade's query parsing, and a test
// that builds the metadata itself would step over exactly the code under test.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { connect as connectSocket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import { AuthService } from '../services/AuthService.js';
import { CryptoService } from '../services/CryptoService.js';
import { SessionManager } from '../services/SessionManager.js';
import { WsRouter } from './WsRouter.js';

type WsTransportMode = 'unified' | 'split-shadow' | 'split';

interface Harness {
  endpoint: string;
  token: string;
  manager: SessionManager;
  router: WsRouter;
  auth: AuthService;
  server: Server;
}

function createLocalEndpoint(): string {
  const name = `buildergate-ws-mode-${process.pid}-${randomUUID()}`;
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\${name}`
    : join(tmpdir(), `${name}.sock`);
}

async function startHarness(configuredMode: WsTransportMode): Promise<Harness> {
  const endpoint = createLocalEndpoint();
  if (process.platform !== 'win32' && existsSync(endpoint)) unlinkSync(endpoint);
  const crypto = new CryptoService(`ws-mode-${randomUUID()}`);
  const auth = new AuthService({
    password: 'local-test-only',
    durationMs: 60_000,
    jwtSecret: `mode-secret-${randomUUID()}`,
  }, crypto);
  const manager = new SessionManager();
  const router = new WsRouter(auth, manager, {
    realtime: { wsTransportMode: configuredMode, terminalWireFormat: 'binary' },
  });
  manager.setWsRouter(router);
  const server = createServer((_request, response) => { response.writeHead(404).end(); });
  server.on('upgrade', (request, socket, head) => {
    (socket as typeof socket & { unref?: () => void }).unref?.();
    router.handleUpgrade(request, socket, head);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint, () => { server.off('error', reject); resolve(); });
  });
  server.unref();
  return { endpoint, token: auth.issueToken().token, manager, router, auth, server };
}

async function stopHarness(harness: Harness): Promise<void> {
  harness.router.destroy();
  harness.auth.destroy();
  harness.manager.stopAllCwdWatching();
  harness.server.closeAllConnections();
  await new Promise<void>((resolve) => { harness.server.close(() => resolve()); });
  if (process.platform !== 'win32' && existsSync(harness.endpoint)) unlinkSync(harness.endpoint);
}

function connect(token: string, endpoint: string, query: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(
      `ws://buildergate.test/ws?token=${encodeURIComponent(token)}${query}`,
      { createConnection: () => connectSocket(endpoint) },
    );
    const timer = setTimeout(() => { socket.terminate(); reject(new Error('connect timed out')); }, 5_000);
    socket.once('open', () => {
      clearTimeout(timer);
      (socket as WebSocket & { _socket?: { unref?: () => void } })._socket?.unref?.();
      resolve(socket);
    });
    socket.once('error', (error) => { clearTimeout(timer); reject(error); });
  });
}

// The effective mode is read from the router's own client table rather than inferred from
// behaviour, so a case that fails says which mode was actually recorded.
function effectiveMode(router: WsRouter): WsTransportMode | undefined {
  const clients = (router as unknown as {
    clients: Map<unknown, { wsTransportMode?: WsTransportMode }>;
  }).clients;
  assert.equal(clients.size, 1, 'exactly one connection must be registered');
  return [...clients.values()][0]?.wsTransportMode;
}

async function modeFor(configured: WsTransportMode, query: string): Promise<WsTransportMode | undefined> {
  const harness = await startHarness(configured);
  let socket: WebSocket | undefined;
  try {
    socket = await connect(harness.token, harness.endpoint, query);
    return effectiveMode(harness.router);
  } finally {
    socket?.terminate();
    await stopHarness(harness);
  }
}

test('#76 a unified server ignores a client that asks for split', async () => {
  assert.equal(await modeFor('unified', '&wsTransportMode=split'), 'unified');
});

test('#76 a unified server ignores a client that asks for split-shadow', async () => {
  assert.equal(await modeFor('unified', '&wsTransportMode=split-shadow'), 'unified');
});

// Control. Without it, the two cases above would also pass against a router that hardcoded
// 'unified' for every connection, which would be a different defect with the same green.
test('#76 a split-shadow server still honours a client that asks for split-shadow', async () => {
  assert.equal(await modeFor('split-shadow', '&wsTransportMode=split-shadow'), 'split-shadow');
});

// A client may always ask for LESS than the operator configured: the request only affects its
// own connection and unified is the conservative side.
test('#76 a split-shadow server honours a client that asks for unified', async () => {
  assert.equal(await modeFor('split-shadow', '&wsTransportMode=unified'), 'unified');
});

test('#76 a split-shadow server does not let a client escalate to split', async () => {
  assert.equal(await modeFor('split-shadow', '&wsTransportMode=split'), 'split-shadow');
});

test('#76 omitting the parameter keeps the configured mode', async () => {
  assert.equal(await modeFor('split-shadow', ''), 'split-shadow');
  assert.equal(await modeFor('unified', ''), 'unified');
});

// The consequence the issue names: the wire-format gate keys off the connection's mode, so an
// accepted split request took binary negotiation away from that client. This asserts the
// negotiation survives the request -- the symptom an operator would actually see.
test('#76 a client-requested split does not switch off binary negotiation on a unified server', async () => {
  const harness = await startHarness('unified');
  let socket: WebSocket | undefined;
  try {
    socket = await connect(harness.token, harness.endpoint, '&wsTransportMode=split');
    const replies: Array<Record<string, unknown>> = [];
    socket.on('message', (raw) => {
      try { replies.push(JSON.parse(raw.toString()) as Record<string, unknown>); } catch { /* binary */ }
    });
    socket.send(JSON.stringify({
      type: 'terminal-binary:negotiate',
      supportedFrameVersions: [1],
      acceptedFlagMask: 0x0001 | 0x0008,
    }));
    const reply = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no negotiation answer; frames=${JSON.stringify(replies)}`)), 5_000);
      const poll = setInterval(() => {
        const found = replies.find(frame => frame.type === 'terminal-binary:capability'
          || frame.type === 'terminal-binary:rejected');
        if (!found) return;
        clearInterval(poll); clearTimeout(timer); resolve(found);
      }, 20);
      timer.unref(); poll.unref();
    });
    assert.equal(reply.type, 'terminal-binary:capability',
      `binary negotiation must survive a client-requested split: ${JSON.stringify(reply)}`);
    assert.equal(reply.accepted, true);
  } finally {
    socket?.terminate();
    await stopHarness(harness);
  }
});
