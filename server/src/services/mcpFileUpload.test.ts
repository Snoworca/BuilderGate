// FR-MCP-021 (#234): one-use upload URLs (/mcp/fu?t=...) opened over MCP, on real HTTP and a real
// temporary directory.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { FileService } from './FileService.js';
import { UploadTempRegistry, isUploadTempName } from './upload/uploadTemp.js';
import { createMcpFileUploads, MCP_FILE_UPLOAD_PATH } from './mcpFileUpload.js';

const SESSION_ID = 'session-fu';
const MAX_UPLOAD = 64 * 1024;

interface Res { status: number; body: string }

async function setup(options: { now?: () => number; deny?: () => string | null; maxOpen?: number } = {}) {
  const first = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bg-fu-a-')));
  const second = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bg-fu-b-')));
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bg-fu-data-'));
  let cwd = first;
  const sessionManager = {
    getSession: (id: string): unknown => (id === SESSION_ID ? { id } : null),
    getPtyPid: (): number | null => null,
    getInitialCwd: (): string | null => cwd,
    getCwdFilePath: (): string | null => null,
  };
  const files = new FileService(sessionManager as never, {
    maxFileSize: 1024,
    maxDirectoryEntries: 100,
    blockedExtensions: ['.exe'],
    blockedPaths: ['.ssh'],
    cwdCacheTtlMs: 0,
    maxUploadFileSize: MAX_UPLOAD,
  });
  const uploads = createMcpFileUploads({
    files,
    registry: new UploadTempRegistry(path.join(dataDir, 'upload-temp.json')),
    now: options.now,
    checkAccess: options.deny,
    maxOpen: options.maxOpen,
  });
  const server = http.createServer((req, res) => {
    if (!uploads.handle(req, res)) {
      res.statusCode = 404;
      res.end('other');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const send = (method: string, urlPath: string, body?: Buffer, headers: Record<string, string> = {}) => new Promise<Res>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
  const close = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return { first, second, uploads, send, port, close, moveSession: (to: string) => { cwd = to; } };
}

test('FR-MCP-021 AC-1/AC-2: a live sessionId is required; the result names the path and the directory', async () => {
  const ctx = await setup();
  try {
    assert.equal((await ctx.uploads.open('')).ok, false);
    const missing = await ctx.uploads.open('no-such-session');
    assert.equal(missing.ok, false);
    assert.equal(missing.code, 'VALIDATION_ERROR');
    const opened = await ctx.uploads.open(SESSION_ID);
    assert.equal(opened.ok, true, JSON.stringify(opened));
    assert.match(String(opened.path), new RegExp(`^${MCP_FILE_UPLOAD_PATH}\\?t=[A-Za-z0-9_-]{32,}$`));
    assert.equal(opened.directory, ctx.first);
    assert.equal(typeof opened.expiresAt, 'string');
    const again = await ctx.uploads.open(SESSION_ID);
    assert.notEqual(again.path, opened.path);
  } finally {
    await ctx.close();
  }
});

test('FR-MCP-021 AC-3/AC-4/AC-5: the file lands in the directory of the moment the URL was opened, once', async () => {
  const ctx = await setup();
  try {
    const opened = await ctx.uploads.open(SESSION_ID);
    ctx.moveSession(ctx.second);
    const put = await ctx.send('PUT', `${opened.path}&name=report.txt`, Buffer.from('hello'));
    assert.equal(put.status, 200, put.body);
    assert.deepEqual(JSON.parse(put.body), { ok: true, name: 'report.txt', size: 5, directory: ctx.first });
    assert.equal(await fs.readFile(path.join(ctx.first, 'report.txt'), 'utf8'), 'hello');
    assert.deepEqual(await fs.readdir(ctx.second), []);
    const reuse = await ctx.send('PUT', `${opened.path}&name=again.txt`, Buffer.from('x'));
    assert.equal(reuse.status, 410);
    assert.deepEqual((await fs.readdir(ctx.first)).sort(), ['report.txt']);
  } finally {
    await ctx.close();
  }
});

test('FR-MCP-021 AC-4: POST works too, the name may come in X-File-Name, and a taken name is renamed', async () => {
  const ctx = await setup();
  try {
    await fs.writeFile(path.join(ctx.first, 'a.txt'), 'old');
    const opened = await ctx.uploads.open(SESSION_ID);
    const post = await ctx.send('POST', String(opened.path), Buffer.from('new'), { 'X-File-Name': encodeURIComponent('a.txt') });
    assert.equal(post.status, 200, post.body);
    const placed = JSON.parse(post.body) as { name: string };
    assert.notEqual(placed.name, 'a.txt');
    assert.equal(await fs.readFile(path.join(ctx.first, 'a.txt'), 'utf8'), 'old');
    assert.equal(await fs.readFile(path.join(ctx.first, placed.name), 'utf8'), 'new');
  } finally {
    await ctx.close();
  }
});

test('FR-MCP-021 AC-3/AC-5: a refused upload (bad name, blocked type, too large) still uses the URL up', async () => {
  const ctx = await setup();
  try {
    for (const [query, body] of [
      ['&name=..%2Fescape.txt', Buffer.from('x')],
      ['&name=tool.exe', Buffer.from('x')],
      ['', Buffer.from('x')],
      ['&name=big.bin', Buffer.alloc(MAX_UPLOAD + 1)],
    ] as const) {
      const opened = await ctx.uploads.open(SESSION_ID);
      const first = await ctx.send('PUT', `${opened.path}${query}`, body);
      assert.ok(first.status >= 400 && first.status < 500 && first.status !== 410, `${query}: ${first.status} ${first.body}`);
      const second = await ctx.send('PUT', `${opened.path}&name=ok.txt`, Buffer.from('x'));
      assert.equal(second.status, 410, query);
    }
    assert.deepEqual(await fs.readdir(ctx.first), []);
    assert.deepEqual(await fs.readdir(path.dirname(ctx.first)).then((names) => names.filter(isUploadTempName)), []);
  } finally {
    await ctx.close();
  }
});

test('FR-MCP-021 AC-5: an upload cut off half way leaves no file and the URL is used up', async () => {
  const ctx = await setup();
  try {
    const opened = await ctx.uploads.open(SESSION_ID);
    await new Promise<void>((resolve) => {
      const req = http.request({
        host: '127.0.0.1', port: ctx.port, method: 'PUT', path: `${opened.path}&name=half.bin`,
        headers: { 'Content-Length': '1000' },
      });
      req.on('error', () => resolve());
      req.write(Buffer.alloc(100));
      setTimeout(() => { req.destroy(); resolve(); }, 200);
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual((await fs.readdir(ctx.first)).filter((name) => !isUploadTempName(name)), []);
    assert.deepEqual((await fs.readdir(ctx.first)).filter(isUploadTempName), []);
    const retry = await ctx.send('PUT', `${opened.path}&name=half.bin`, Buffer.from('x'));
    assert.equal(retry.status, 410);
  } finally {
    await ctx.close();
  }
});

test('FR-MCP-021 AC-6: GET gives an upload page without using the URL; an unused URL expires after 10 minutes', async () => {
  let now = 1_000_000;
  const ctx = await setup({ now: () => now });
  try {
    const opened = await ctx.uploads.open(SESSION_ID);
    const page = await ctx.send('GET', String(opened.path));
    assert.equal(page.status, 200);
    assert.match(page.body, /<input[^>]+type="file"/);
    assert.equal((await ctx.send('GET', String(opened.path))).status, 200, 'GET does not use it up');
    now += 10 * 60_000;
    assert.equal((await ctx.send('GET', String(opened.path))).status, 410);
    assert.equal((await ctx.send('PUT', `${opened.path}&name=late.txt`, Buffer.from('x'))).status, 410);
    assert.equal((await ctx.send('GET', `${MCP_FILE_UPLOAD_PATH}?t=nonsense`)).status, 410);
    assert.equal((await ctx.send('GET', '/mcp')).status, 404, 'other paths are left to the caller');
  } finally {
    await ctx.close();
  }
});

test('FR-MCP-021 AC-7: an address the MCP listener would refuse is refused here too, without using the URL', async () => {
  let denied: string | null = 'MCP_WHITELIST_DENIED';
  const ctx = await setup({ deny: () => denied });
  try {
    const opened = await ctx.uploads.open(SESSION_ID);
    const refused = await ctx.send('PUT', `${opened.path}&name=x.txt`, Buffer.from('x'));
    assert.equal(refused.status, 403);
    assert.match(refused.body, /MCP_WHITELIST_DENIED/);
    assert.equal((await ctx.send('GET', String(opened.path))).status, 403);
    denied = null;
    assert.equal((await ctx.send('PUT', `${opened.path}&name=x.txt`, Buffer.from('x'))).status, 200);
  } finally {
    await ctx.close();
  }
});

test('FR-MCP-021: a request target that is not a URL is left alone instead of throwing', async () => {
  const ctx = await setup();
  try {
    const fake = { url: 'http://[', method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
    assert.equal(ctx.uploads.handle(fake as never, {} as never), false);
  } finally {
    await ctx.close();
  }
});

test('FR-MCP-021: opening more URLs than the cap is refused; the ones already open keep working', async () => {
  const ctx = await setup({ maxOpen: 2 });
  try {
    const a = await ctx.uploads.open(SESSION_ID);
    await ctx.uploads.open(SESSION_ID);
    const third = await ctx.uploads.open(SESSION_ID);
    assert.equal(third.ok, false);
    assert.equal(third.code, 'UPLOAD_URLS_FULL');
    assert.equal((await ctx.send('PUT', `${a.path}&name=a.txt`, Buffer.from('a'))).status, 200);
    assert.equal((await ctx.uploads.open(SESSION_ID)).ok, true, 'a used URL frees its place');
  } finally {
    await ctx.close();
  }
});
