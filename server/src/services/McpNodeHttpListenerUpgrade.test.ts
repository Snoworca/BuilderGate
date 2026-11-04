// FR-MCP-016 (#233): the MCP listener hands WebSocket upgrades to the peer link and refuses the rest.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import WebSocket from 'ws';
import { closeMcpNodeHttpListener, createMcpNodeHttpListener } from './McpNodeHttpListener.js';

test('FR-MCP-016: upgrades go to onUpgrade; one it does not take is closed', async () => {
  const seen: string[] = [];
  const handle = await createMcpNodeHttpListener({ bindHost: '127.0.0.1', port: 0 }, () => ({ status: 200, body: {} }), {
    onUpgrade: (request, socket) => {
      seen.push(request.url ?? '');
      if (request.url !== '/mcp/peer') return false;
      socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
      return true;
    },
  });
  try {
    const attempt = (path: string) => new Promise<string>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${handle.port}${path}`);
      ws.on('unexpected-response', (_req, res) => resolve(`status ${res.statusCode}`));
      ws.on('error', (error) => resolve(`error ${(error as NodeJS.ErrnoException).code ?? error.message}`));
    });
    assert.equal(await attempt('/mcp/peer'), 'status 403');
    assert.match(await attempt('/other'), /^error/);
    assert.deepEqual(seen, ['/mcp/peer', '/other']);
  } finally {
    handle.server.closeAllConnections?.();
    await closeMcpNodeHttpListener(handle);
  }
});

test('FR-MCP-016: closing the listener also closes the links it accepted, so turning MCP off finishes', async () => {
  const { WebSocketServer } = await import('ws');
  const wss = new WebSocketServer({ noServer: true });
  const handle = await createMcpNodeHttpListener({ bindHost: '127.0.0.1', port: 0 }, () => ({ status: 200, body: {} }), {
    onUpgrade: (request, socket, head) => {
      wss.handleUpgrade(request, socket, head, () => {});
      return true;
    },
  });
  const client = new WebSocket(`ws://127.0.0.1:${handle.port}/mcp/peer`);
  await new Promise((resolve) => client.on('open', resolve));
  const clientClosed = new Promise((resolve) => client.on('close', resolve));
  const closed = await Promise.race([
    closeMcpNodeHttpListener(handle).then(() => 'closed'),
    new Promise((resolve) => setTimeout(() => resolve('still open after 2 s'), 2_000)),
  ]);
  assert.equal(closed, 'closed');
  await clientClosed;
  wss.close();
});

test('FR-MCP-021: /mcp/fu goes to onRawRequest before the body is read, and requests carry their origin', async () => {
  const dispatched: Array<Record<string, unknown>> = [];
  const handle = await createMcpNodeHttpListener({ bindHost: '127.0.0.1', port: 0 }, (request) => {
    dispatched.push(request as Record<string, unknown>);
    return { status: 200, body: {} };
  }, {
    onRawRequest: (req, res) => {
      if (!req.url?.startsWith('/mcp/fu')) return false;
      res.end('raw');
      return true;
    },
  });
  try {
    const raw = await fetch(`http://127.0.0.1:${handle.port}/mcp/fu?t=x`, { method: 'PUT', body: 'bytes' });
    assert.equal(await raw.text(), 'raw');
    await fetch(`http://127.0.0.1:${handle.port}/mcp`, { method: 'POST', body: '{}' });
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0]!.origin, `http://127.0.0.1:${handle.port}`);
  } finally {
    handle.server.closeAllConnections?.();
    await closeMcpNodeHttpListener(handle);
  }
});

test('FR-MCP-021: a raw handler that throws answers 500 and the server stays up; long uploads are not cut at 5 minutes', async () => {
  const net = await import('node:net');
  const handle = await createMcpNodeHttpListener({ bindHost: '127.0.0.1', port: 0 }, () => ({ status: 200, body: {} }), {
    onRawRequest: (req) => {
      new URL(req.url ?? '/', 'http://x');
      return false;
    },
  });
  try {
    assert.equal(handle.server.requestTimeout, 0);
    const reply = await new Promise<string>((resolve) => {
      const socket = net.connect(handle.port, '127.0.0.1', () => socket.write('GET http://[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'));
      let text = '';
      socket.on('data', (chunk) => { text += String(chunk); });
      socket.on('close', () => resolve(text));
      socket.on('error', () => resolve(text));
    });
    assert.match(reply, /^HTTP\/1\.1 500/);
    const alive = await fetch(`http://127.0.0.1:${handle.port}/mcp`, { method: 'POST', body: '{}' });
    assert.equal(alive.status, 200);
  } finally {
    handle.server.closeAllConnections?.();
    await closeMcpNodeHttpListener(handle);
  }
});
