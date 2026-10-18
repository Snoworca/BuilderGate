// FR-FEX-023 AC-1 (#139 review 1): the server-wide request timeout is off so that a long upload is
// not cut at five minutes; this middleware gives every other request its body deadline back, and
// gives the upload an idle timeout instead. Run: cwd=server/,
// npx tsx --test src/middleware/requestBodyDeadline.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { request, type ClientRequest } from 'node:http';
import express from 'express';
import { createRequestBodyDeadline, isUploadRequest } from './requestBodyDeadline.js';
import { withLocalHttpServer } from '../testing/localHttpTestServer.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function withApp(run: (open: (method: string, path: string) => { req: ClientRequest; done: Promise<string> }) => Promise<void>): Promise<void> {
  const app = express();
  app.use(createRequestBodyDeadline({ deadlineMs: 300, exemptIdleMs: 300 }));
  app.all('*', (req, res) => {
    req.on('data', () => undefined);
    req.on('end', () => res.json({ ok: true }));
  });
  await withLocalHttpServer(app, async (fixture) => {
    await run((method, path) => {
      const req = request({ socketPath: fixture.endpoint, agent: false, method, path, headers: { 'content-type': 'application/octet-stream', 'transfer-encoding': 'chunked' } });
      const done = new Promise<string>((resolve) => {
        req.on('response', (res) => { res.resume(); res.on('end', () => resolve(`status ${res.statusCode}`)); });
        req.on('error', () => resolve('destroyed'));
      });
      return { req, done };
    });
  });
}

test('FR-FEX-023 AC-1: only an upload PUT is exempt from the body deadline', () => {
  assert.equal(isUploadRequest('PUT', '/api/sessions/abc/files/upload?dir=&path=a'), true);
  assert.equal(isUploadRequest('PUT', '/api/sessions/abc/files/upload'), true);
  assert.equal(isUploadRequest('POST', '/api/sessions/abc/files/upload'), false);
  assert.equal(isUploadRequest('PUT', '/api/sessions/abc/files/upload/check'), false);
  assert.equal(isUploadRequest('PUT', '/api/sessions/a/b/files/upload'), false);
});

test('FR-FEX-023 AC-1: a body still arriving after the deadline is cut off for an ordinary request', async () => {
  await withApp(async (open) => {
    const { req, done } = open('POST', '/api/settings');
    const timer = setInterval(() => req.write('x'), 50); // never idle, never finished
    try {
      assert.equal(await done, 'destroyed');
    } finally {
      clearInterval(timer);
    }
  });
});

test('FR-FEX-023 AC-1: an upload that keeps sending outlives the deadline, and one that goes idle is cut off', async () => {
  await withApp(async (open) => {
    const steady = open('PUT', '/api/sessions/s/files/upload?dir=&path=a');
    const timer = setInterval(() => steady.req.write('x'), 50);
    await sleep(700); // more than twice the deadline
    clearInterval(timer);
    steady.req.end();
    assert.equal(await steady.done, 'status 200');

    const idle = open('PUT', '/api/sessions/s/files/upload?dir=&path=b');
    idle.req.write('x');
    assert.equal(await idle.done, 'destroyed');
  });
});
