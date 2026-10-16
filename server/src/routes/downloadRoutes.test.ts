// FR-FEX-021 AC-2, AC-3 (#130): the download token route and the token-addressed download, over
// real HTTP on a real temporary directory. Run per-file: cwd=server/,
// npx tsx --test src/routes/downloadRoutes.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { request, type IncomingHttpHeaders } from 'node:http';
import express from 'express';
import { FileService } from '../services/FileService.js';
import { DownloadTokenStore } from '../services/DownloadTokenStore.js';
import { createDownloadRoutes, createDownloadTokenRoutes } from './downloadRoutes.js';
import { withLocalHttpServer } from '../testing/localHttpTestServer.js';

const SESSION_ID = 'session-download';

interface RawResponse { status: number; headers: IncomingHttpHeaders; body: Buffer }

async function withApp(
  run: (ctx: { cwd: string; store: DownloadTokenStore; send: (method: string, urlPath: string, body?: unknown) => Promise<RawResponse>; clock: { now: number } }) => Promise<void>,
): Promise<void> {
  const cwd = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'buildergate-download-')));
  const sessionManager = {
    getSession: (id: string): unknown => (id === SESSION_ID ? { id } : null),
    getPtyPid: (): number | null => null,
    getInitialCwd: (): string | null => cwd,
    getCwdFilePath: (): string | null => null,
  };
  const service = new FileService(sessionManager as never, {
    maxFileSize: 1024,
    maxDirectoryEntries: 100,
    blockedExtensions: ['.exe'],
    blockedPaths: ['.ssh'],
    cwdCacheTtlMs: 1000,
  });
  const clock = { now: 1_000_000 };
  const store = new DownloadTokenStore({ ttlMs: 60_000, now: () => clock.now });
  const app = express();
  app.use(express.json());
  app.use('/api/sessions', createDownloadTokenRoutes(service, store));
  app.use('/api/downloads', createDownloadRoutes(store));
  try {
    await withLocalHttpServer(app, async (fixture) => {
      const send = (method: string, urlPath: string, body?: unknown) => new Promise<RawResponse>((resolve, reject) => {
        const payload = body === undefined ? undefined : JSON.stringify(body);
        const req = request({
          socketPath: fixture.endpoint,
          agent: false,
          method,
          path: urlPath,
          headers: payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) },
        }, (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }));
          response.on('error', reject);
        });
        req.on('error', reject);
        if (payload !== undefined) req.write(payload);
        req.end();
      });
      await run({ cwd, store, send, clock });
    });
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
}

function json(response: RawResponse): Record<string, unknown> {
  return JSON.parse(response.body.toString('utf8')) as Record<string, unknown>;
}

function code(response: RawResponse): unknown {
  return (json(response).error as { code?: unknown } | undefined)?.code;
}

test('FR-FEX-021 AC-2/AC-3: a regular file downloads once, byte for byte, as an attachment', async () => {
  await withApp(async ({ cwd, send }) => {
    // Larger than maxFileSize (1024): a download streams and is not held to the text read limit.
    const bytes = Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 7) & 0xff));
    await fs.mkdir(path.join(cwd, 'out'));
    await fs.writeFile(path.join(cwd, 'out', '보고서 v2.bin'), bytes);

    const issued = await send('POST', `/api/sessions/${SESSION_ID}/files/download-token`, { path: 'out/보고서 v2.bin' });
    assert.equal(issued.status, 200, issued.body.toString());
    const body = json(issued);
    assert.equal(body.name, '보고서 v2.bin');
    assert.equal(body.size, 5000);
    assert.match(String(body.token), /^[A-Za-z0-9_-]{43}$/);
    assert.equal(body.url, `/api/downloads/${String(body.token)}`);

    const downloaded = await send('GET', String(body.url));
    assert.equal(downloaded.status, 200);
    assert.deepEqual(downloaded.body, bytes);
    assert.equal(downloaded.headers['content-type'], 'application/octet-stream');
    assert.equal(downloaded.headers['content-length'], '5000');
    assert.equal(downloaded.headers['x-content-type-options'], 'nosniff');
    assert.equal(downloaded.headers['cache-control'], 'no-store');
    const disposition = String(downloaded.headers['content-disposition']);
    assert.match(disposition, /^attachment; /);
    assert.match(disposition, /filename\*=UTF-8''%EB%B3%B4%EA%B3%A0%EC%84%9C%20v2\.bin/);
    assert.match(disposition, /filename="[\x20-\x7e]*"/, 'an ASCII fallback name');

    const again = await send('GET', String(body.url));
    assert.equal(again.status, 404, 'a token is used once');
    assert.equal(code(again), 'DOWNLOAD_TOKEN_INVALID');
  });
});

test('FR-FEX-021 AC-2: paths the file API refuses issue no token', async () => {
  await withApp(async ({ cwd, send, store }) => {
    await fs.mkdir(path.join(cwd, 'dir'));
    await fs.mkdir(path.join(cwd, '.ssh'));
    await fs.writeFile(path.join(cwd, '.ssh', 'key'), 'secret');
    await fs.writeFile(path.join(cwd, 'tool.exe'), 'MZ');
    const cases: Array<[string, number, string]> = [
      ['../outside.txt', 403, 'PATH_TRAVERSAL'],
      ['.ssh/key', 403, 'PATH_BLOCKED'],
      ['tool.exe', 403, 'PATH_BLOCKED'],
      ['missing.txt', 404, 'PATH_NOT_FOUND'],
      ['dir', 400, 'NOT_A_FILE'],
    ];
    for (const [target, status, expected] of cases) {
      const response = await send('POST', `/api/sessions/${SESSION_ID}/files/download-token`, { path: target });
      assert.equal(response.status, status, `${target}: ${response.body.toString()}`);
      assert.equal(code(response), expected, target);
    }
    const missing = await send('POST', `/api/sessions/${SESSION_ID}/files/download-token`, {});
    assert.equal(missing.status, 400);
    assert.equal(store.size(), 0, 'no token was issued');
  });
});

test('FR-FEX-021 AC-3: an unknown or expired token answers 404', async () => {
  await withApp(async ({ cwd, send, clock }) => {
    await fs.writeFile(path.join(cwd, 'a.txt'), 'a');
    assert.equal(code(await send('GET', '/api/downloads/not-a-token')), 'DOWNLOAD_TOKEN_INVALID');
    const issued = json(await send('POST', `/api/sessions/${SESSION_ID}/files/download-token`, { path: 'a.txt' }));
    clock.now += 60_001;
    const expired = await send('GET', String(issued.url));
    assert.equal(expired.status, 404);
    assert.equal(code(expired), 'DOWNLOAD_TOKEN_INVALID');
  });
});

test('FR-FEX-021 AC-3: a file deleted after the token was issued answers 404 and sends nothing', async () => {
  await withApp(async ({ cwd, send }) => {
    await fs.writeFile(path.join(cwd, 'gone.txt'), 'soon gone');
    const issued = json(await send('POST', `/api/sessions/${SESSION_ID}/files/download-token`, { path: 'gone.txt' }));
    await fs.rm(path.join(cwd, 'gone.txt'));
    const response = await send('GET', String(issued.url));
    assert.equal(response.status, 404);
    assert.equal(code(response), 'PATH_NOT_FOUND');
  });
});
