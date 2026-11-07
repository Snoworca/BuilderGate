// FR-MSG-008 AC-3/AC-5 (contract §7): the HTTP side of the add-by-address flow -- the raw handler on
// the MCP listener and the HTTPS client that reports the certificate it saw (TOFU).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import selfsigned from 'selfsigned';
import { createContactRequestRawHandler, httpsContactClient } from './contactHttp.js';
import type { ContactRequestCall } from './contacts.js';

function listen(server: http.Server | https.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
}

test('contract §7: the raw handler takes /mcp/contact-request only, keeps the listener guard, and answers JSON', async () => {
  const calls: ContactRequestCall[] = [];
  let denied: string | null = null;
  const handler = createContactRequestRawHandler({
    handle: async (call) => {
      calls.push(call);
      return { status: 200, body: { ok: true, id: 'r1' } };
    },
    checkAccess: () => denied,
  });
  const server = http.createServer((req, res) => {
    if (!handler(req, res)) {
      res.statusCode = 418;
      res.end();
    }
  });
  const port = await listen(server);
  try {
    const posted = await fetch(`http://127.0.0.1:${port}/mcp/contact-request`, { method: 'POST', body: JSON.stringify({ fromNode: 'alice', secret: 'abcdefgh' }) });
    assert.equal(posted.status, 200);
    assert.deepEqual(await posted.json(), { ok: true, id: 'r1' });
    assert.deepEqual(calls[0]!.body, { fromNode: 'alice', secret: 'abcdefgh' });
    assert.equal(calls[0]!.path, '/mcp/contact-request');

    await fetch(`http://127.0.0.1:${port}/mcp/contact-request/r1?secret=abc`);
    assert.equal(calls[1]!.method, 'GET');
    assert.deepEqual(calls[1]!.query, { secret: 'abc' });

    assert.equal((await fetch(`http://127.0.0.1:${port}/mcp/other`)).status, 418);

    denied = 'MCP_WHITELIST_DENIED';
    const refused = await fetch(`http://127.0.0.1:${port}/mcp/contact-request`, { method: 'POST', body: '{}' });
    assert.equal(refused.status, 403);
    assert.equal(calls.length, 2);

    denied = null;
    const big = await fetch(`http://127.0.0.1:${port}/mcp/contact-request`, { method: 'POST', body: 'x'.repeat(10_000) });
    assert.equal(big.status, 413);
  } finally {
    server.close();
  }
});

test('FR-MSG-008 AC-5: the HTTPS client accepts a self-signed certificate and reports its SHA-256', async () => {
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'contact-test' }], { keySize: 2048, algorithm: 'sha256' });
  const fingerprint = new crypto.X509Certificate(pems.cert).fingerprint256.replace(/:/g, '').toLowerCase();
  const server = https.createServer({ cert: pems.cert, key: pems.private }, (req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, method: req.method, echo: body ? JSON.parse(body) : null }));
    });
  });
  const port = await listen(server);
  try {
    const answer = await httpsContactClient({ method: 'POST', url: `https://127.0.0.1:${port}/mcp/contact-request`, body: { a: 1 } });
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.body, { ok: true, method: 'POST', echo: { a: 1 } });
    assert.equal(answer.fingerprint, fingerprint);
  } finally {
    server.close();
  }
  const unreachable = await httpsContactClient({ method: 'GET', url: `https://127.0.0.1:${port}/mcp/contact-request/x` });
  assert.equal(unreachable.status, 0);
});

test('review M3: an answer larger than the limit settles as unreachable instead of hanging', async () => {
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'contact-big' }], { keySize: 2048, algorithm: 'sha256' });
  const server = https.createServer({ cert: pems.cert, key: pems.private }, (_req, res) => {
    res.write('x'.repeat(100 * 1024));
    // Never ends on its own.
  });
  const port = await listen(server);
  try {
    const answer = await Promise.race([
      httpsContactClient({ method: 'GET', url: `https://127.0.0.1:${port}/x` }),
      new Promise((resolve) => setTimeout(() => resolve('hung'), 5_000)),
    ]);
    assert.notEqual(answer, 'hung');
    assert.equal((answer as { status: number }).status, 0);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
