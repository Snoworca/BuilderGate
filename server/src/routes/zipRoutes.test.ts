// FR-FEX-025 (#139): the ZIP pre-count, the single-use ZIP token, the streamed archive and the job
// progress/cancel routes, over real HTTP on a real temporary directory, reading the ZIP produced.
// Run per-file: cwd=server/, npx tsx --test src/routes/zipRoutes.test.ts
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import zlib from 'node:zlib';
import { request, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import express from 'express';
import { FileService } from '../services/FileService.js';
import { DownloadTokenStore } from '../services/DownloadTokenStore.js';
import { ZipArchiveService } from '../services/ZipArchiveService.js';
import { createDownloadRoutes, createDownloadTokenRoutes } from './downloadRoutes.js';
import { createZipRoutes } from './zipRoutes.js';
import { withLocalHttpServer } from '../testing/localHttpTestServer.js';

const SESSION_ID = 'session-zip';
const OTHER_SESSION = 'session-other';

interface RawResponse { status: number; headers: IncomingHttpHeaders; body: Buffer }

interface Ctx {
  cwd: string;
  clock: { now: number };
  send: (method: string, urlPath: string, body?: unknown, session?: string) => Promise<RawResponse>;
  /** GET that hands back the response without reading it. */
  openGet: (urlPath: string) => Promise<IncomingMessage>;
}

async function withApp(
  run: (ctx: Ctx) => Promise<void>,
  options: { openForRead?: (p: string) => Promise<fs.FileHandle> } = {},
): Promise<void> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'buildergate-zip-')));
  const cwd = path.join(root, 'components');
  await fs.mkdir(cwd);
  const sessionManager = {
    getSession: (id: string): unknown => (id === SESSION_ID || id === OTHER_SESSION ? { id } : null),
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
  const zip = new ZipArchiveService(service, { now: () => clock.now, openForRead: options.openForRead });
  const app = express();
  app.use(express.json());
  app.use('/api/sessions', createDownloadTokenRoutes(service, store));
  app.use('/api/sessions', createZipRoutes(store, zip));
  app.use('/api/downloads', createDownloadRoutes(store, zip));
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
        req.end(payload);
      });
      const openGet = (urlPath: string) => new Promise<IncomingMessage>((resolve, reject) => {
        const req = request({ socketPath: fixture.endpoint, agent: false, method: 'GET', path: urlPath }, resolve);
        req.on('error', reject);
        req.end();
      });
      await run({ cwd, clock, send, openGet });
    });
  } finally {
    zip.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
}

function json(response: RawResponse): Record<string, unknown> {
  return JSON.parse(response.body.toString('utf8')) as Record<string, unknown>;
}

function code(response: RawResponse): unknown {
  return (json(response).error as { code?: unknown } | undefined)?.code;
}

interface ZipEntry { name: string; method: number; data: Buffer }

/** A minimal reader: the central directory, then each local header's data. */
function readZip(buffer: Buffer): ZipEntry[] {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  assert.notEqual(eocd, -1, 'an end of central directory record');
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50, 'a central directory header');
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(start, start + compressedSize);
    entries.push({ name, method, data: method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw) });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function seed(cwd: string): Promise<void> {
  await fs.mkdir(path.join(cwd, 'editor', 'sub'), { recursive: true });
  await fs.writeFile(path.join(cwd, 'editor', 'a.ts'), 'export const a = 1;\n');
  await fs.writeFile(path.join(cwd, 'editor', 'sub', 'b.ts'), 'b'.repeat(500));
  await fs.mkdir(path.join(cwd, 'editor', 'empty'));
  await fs.mkdir(path.join(cwd, 'editor', '.git'));
  await fs.writeFile(path.join(cwd, 'editor', '.git', 'HEAD'), 'ref');
  await fs.mkdir(path.join(cwd, 'editor', 'node_modules', 'pkg'), { recursive: true });
  await fs.writeFile(path.join(cwd, 'editor', 'node_modules', 'pkg', 'index.js'), 'x');
  await fs.mkdir(path.join(cwd, 'editor', '.ssh'));
  await fs.writeFile(path.join(cwd, 'editor', '.ssh', 'id'), 'secret');
  await fs.writeFile(path.join(cwd, 'editor', 'tool.exe'), 'MZ');
  await fs.writeFile(path.join(cwd, 'App.tsx'), 'app');
}

async function issueZip(ctx: Ctx, paths: string[]): Promise<{ token: string; url: string; name: string; jobId: string }> {
  const response = await ctx.send('POST', `/api/sessions/${SESSION_ID}/files/zip/token`, { paths });
  assert.equal(response.status, 200, response.body.toString());
  return json(response) as { token: string; url: string; name: string; jobId: string };
}

test('FR-FEX-025 AC-2: the pre-count reports name, file count, total bytes and excluded names, leaving blocked entries out', async () => {
  await withApp(async (ctx) => {
    await seed(ctx.cwd);
    const response = await ctx.send('POST', `/api/sessions/${SESSION_ID}/files/zip/precount`, { paths: ['editor', 'App.tsx'] });
    assert.equal(response.status, 200, response.body.toString());
    assert.deepEqual(json(response), {
      name: 'components.zip',
      fileCount: 3,
      totalBytes: 'export const a = 1;\n'.length + 500 + 3,
      excluded: ['.git', 'node_modules'],
      skippedBlocked: 2,
    });
    const bad = await ctx.send('POST', `/api/sessions/${SESSION_ID}/files/zip/precount`, { paths: ['../x'] });
    assert.equal(bad.status, 403);
    assert.equal(code(bad), 'PATH_TRAVERSAL');
    const empty = await ctx.send('POST', `/api/sessions/${SESSION_ID}/files/zip/precount`, { paths: [] });
    assert.equal(empty.status, 400);
    const missing = await ctx.send('POST', `/api/sessions/${SESSION_ID}/files/zip/precount`, { paths: ['nope'] });
    assert.equal(missing.status, 404);
  });
});

test('FR-FEX-025 AC-4/AC-5/AC-6: one directory streams as {name}.zip, deflated, without .git, node_modules or blocked entries', async () => {
  await withApp(async (ctx) => {
    await seed(ctx.cwd);
    const issued = await issueZip(ctx, ['editor']);
    assert.equal(issued.name, 'editor.zip');
    assert.match(issued.token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(issued.url, `/api/downloads/${issued.token}`);
    assert.match(issued.jobId, /^[A-Za-z0-9_-]{8,}$/);

    const pending = await ctx.send('GET', `/api/sessions/${SESSION_ID}/files/zip/jobs/${issued.jobId}`);
    assert.equal(pending.status, 200);
    assert.equal(json(pending).state, 'pending');
    assert.equal(json(pending).totalBytes, 'export const a = 1;\n'.length + 500);

    const response = await ctx.send('GET', issued.url);
    assert.equal(response.status, 200, response.body.toString());
    assert.equal(response.headers['content-type'], 'application/zip');
    assert.equal(response.headers['content-length'], undefined, 'streamed, so no length');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.match(String(response.headers['content-disposition']), /^attachment; filename="editor\.zip"; filename\*=UTF-8''editor\.zip$/);

    const entries = readZip(response.body);
    assert.deepEqual(entries.map((e) => e.name).sort(), ['editor/', 'editor/a.ts', 'editor/empty/', 'editor/sub/', 'editor/sub/b.ts']);
    const a = entries.find((e) => e.name === 'editor/a.ts')!;
    assert.equal(a.method, 8, 'deflate');
    assert.equal(a.data.toString(), 'export const a = 1;\n');
    assert.equal(entries.find((e) => e.name === 'editor/sub/b.ts')!.data.toString(), 'b'.repeat(500));

    const done = await ctx.send('GET', `/api/sessions/${SESSION_ID}/files/zip/jobs/${issued.jobId}`);
    assert.deepEqual(json(done), { state: 'done', sentBytes: 'export const a = 1;\n'.length + 500, totalBytes: 'export const a = 1;\n'.length + 500 });

    const again = await ctx.send('GET', issued.url);
    assert.equal(again.status, 404, 'the token is used once');
    assert.equal(code(again), 'DOWNLOAD_TOKEN_INVALID');
  });
});

test('FR-FEX-025 AC-4: several items take the current folder name, entries start at each item, and a Korean name is encoded', async () => {
  await withApp(async (ctx) => {
    await seed(ctx.cwd);
    await fs.mkdir(path.join(ctx.cwd, '문서'));
    await fs.writeFile(path.join(ctx.cwd, '문서', '메모.txt'), '안녕');
    const several = await issueZip(ctx, ['editor/sub', 'App.tsx', '문서']);
    assert.equal(several.name, 'components.zip');
    const response = await ctx.send('GET', several.url);
    assert.equal(response.status, 200);
    assert.deepEqual(readZip(response.body).map((e) => e.name).sort(), ['App.tsx', 'sub/', 'sub/b.ts', '문서/', '문서/메모.txt']);

    const korean = await issueZip(ctx, ['문서']);
    assert.equal(korean.name, '문서.zip');
    const k = await ctx.send('GET', korean.url);
    const disposition = String(k.headers['content-disposition']);
    assert.match(disposition, /filename="[\x20-\x7e]*"/, 'an ASCII fallback');
    assert.match(disposition, /filename\*=UTF-8''%EB%AC%B8%EC%84%9C\.zip/);

    const rootZip = await issueZip(ctx, ['']);
    assert.equal(rootZip.name, 'components.zip', 'the session root takes the root folder name');
    const r = await ctx.send('GET', rootZip.url);
    assert.ok(readZip(r.body).some((e) => e.name === 'components/App.tsx'));
  });
});

test('FR-FEX-025 AC-5: symbolic links are not followed', async (t: TestContext) => {
  await withApp(async (ctx) => {
    await seed(ctx.cwd);
    try {
      await fs.symlink(path.join(ctx.cwd, 'editor', 'sub'), path.join(ctx.cwd, 'editor', 'link'), 'junction');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EPERM') { t.skip('junction needs privilege on this host'); return; }
      throw err;
    }
    const pre = json(await ctx.send('POST', `/api/sessions/${SESSION_ID}/files/zip/precount`, { paths: ['editor'] }));
    assert.equal(pre.fileCount, 2, 'the link target is not counted again');
    const issued = await issueZip(ctx, ['editor']);
    const names = readZip((await ctx.send('GET', issued.url)).body).map((e) => e.name);
    assert.equal(names.some((n) => n.startsWith('editor/link')), false, names.join(','));
  });
});

test('FR-FEX-025 AC-5: an entry that cannot be read is left out and named in _skipped.txt', async () => {
  await withApp(async (ctx) => {
    await seed(ctx.cwd);
    const issued = await issueZip(ctx, ['editor']);
    const response = await ctx.send('GET', issued.url);
    assert.equal(response.status, 200);
    const entries = readZip(response.body);
    assert.equal(entries.some((e) => e.name === 'editor/a.ts'), false);
    assert.equal(entries.some((e) => e.name === 'editor/sub/b.ts'), true, 'the rest of the archive is intact');
    const report = entries.find((e) => e.name === '_skipped.txt');
    assert.ok(report, 'a final report entry');
    assert.match(report!.data.toString('utf8'), /editor\/a\.ts\t.*EACCES/);
    assert.equal(entries[entries.length - 1].name, '_skipped.txt', 'the report comes last');
  }, {
    openForRead: async (p) => {
      if (path.basename(p) === 'a.ts') throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      return fs.open(p, 'r');
    },
  });
});

test('FR-FEX-025 AC-3: the token is single-use, lasts 60 seconds, and the paths are validated again when the stream starts', async (t: TestContext) => {
  await withApp(async (ctx) => {
    await seed(ctx.cwd);
    const expired = await issueZip(ctx, ['editor']);
    ctx.clock.now += 60_001;
    const late = await ctx.send('GET', expired.url);
    assert.equal(late.status, 404);
    assert.equal(code(late), 'DOWNLOAD_TOKEN_INVALID');

    const deleted = await issueZip(ctx, ['App.tsx']);
    await fs.rm(path.join(ctx.cwd, 'App.tsx'));
    const gone = await ctx.send('GET', deleted.url);
    assert.equal(gone.status, 404);
    assert.equal(code(gone), 'PATH_NOT_FOUND');
    const failedJob = await ctx.send('GET', `/api/sessions/${SESSION_ID}/files/zip/jobs/${deleted.jobId}`);
    assert.equal(json(failedJob).state, 'failed');

    // A folder swapped for a link out of the session after the token was issued.
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'buildergate-zip-outside-'));
    try {
      await fs.writeFile(path.join(outside, 'secret.txt'), 'outside');
      const swapped = await issueZip(ctx, ['editor']);
      await fs.rm(path.join(ctx.cwd, 'editor'), { recursive: true });
      try {
        await fs.symlink(outside, path.join(ctx.cwd, 'editor'), 'junction');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EPERM') { t.diagnostic('junction needs privilege; swap case skipped'); return; }
        throw err;
      }
      const refused = await ctx.send('GET', swapped.url);
      assert.equal(refused.status, 403, refused.body.toString());
      assert.equal(code(refused), 'PATH_TRAVERSAL');
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});

test('FR-FEX-025 AC-3: the token route refuses blocked and outside paths and issues nothing', async () => {
  await withApp(async (ctx) => {
    await seed(ctx.cwd);
    for (const [p, status, expected] of [['../x', 403, 'PATH_TRAVERSAL'], ['editor/.ssh', 403, 'PATH_BLOCKED'], ['editor/tool.exe', 403, 'PATH_BLOCKED']] as const) {
      const response = await ctx.send('POST', `/api/sessions/${SESSION_ID}/files/zip/token`, { paths: [p] });
      assert.equal(response.status, status, p);
      assert.equal(code(response), expected, p);
    }
    const noPaths = await ctx.send('POST', `/api/sessions/${SESSION_ID}/files/zip/token`, { paths: 'editor' });
    assert.equal(noPaths.status, 400);
  });
});

test('FR-FEX-025 AC-6: cancelling the job ends the stream; unknown and foreign jobs answer 404', async () => {
  await withApp(async (ctx) => {
    // Incompressible bytes so the archive outgrows every socket buffer and the stream stalls on the reader.
    const big = Buffer.alloc(16 * 1024 * 1024);
    for (let i = 0; i < big.length; i += 4) big.writeUInt32LE((Math.imul(i, 2654435761) ^ (i >>> 7)) >>> 0, i);
    await fs.writeFile(path.join(ctx.cwd, 'big.bin'), big);
    const issued = await issueZip(ctx, ['big.bin']);
    const response = await ctx.openGet(issued.url);
    assert.equal(response.statusCode, 200);
    response.pause();
    const ended = new Promise<string>((resolve) => {
      response.on('aborted', () => resolve('aborted'));
      response.on('error', () => resolve('error'));
      response.on('close', () => resolve('close'));
    });
    let state = '';
    for (let i = 0; i < 100 && state !== 'streaming'; i += 1) {
      state = String(json(await ctx.send('GET', `/api/sessions/${SESSION_ID}/files/zip/jobs/${issued.jobId}`)).state);
      if (state !== 'streaming') await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(state, 'streaming');

    const foreign = await ctx.send('DELETE', `/api/sessions/${OTHER_SESSION}/files/zip/jobs/${issued.jobId}`);
    assert.equal(foreign.status, 404, 'another session cannot cancel it');
    const cancel = await ctx.send('DELETE', `/api/sessions/${SESSION_ID}/files/zip/jobs/${issued.jobId}`);
    assert.equal(cancel.status, 200, cancel.body.toString());
    response.resume();
    await ended;
    const after = json(await ctx.send('GET', `/api/sessions/${SESSION_ID}/files/zip/jobs/${issued.jobId}`));
    assert.equal(after.state, 'cancelled');
    assert.ok(Number(after.sentBytes) < big.length, 'the stream stopped before the end');

    const unknown = await ctx.send('GET', `/api/sessions/${SESSION_ID}/files/zip/jobs/nope`);
    assert.equal(unknown.status, 404);
    assert.equal(code(unknown), 'ZIP_JOB_NOT_FOUND');

    // A finished job is forgotten 60 seconds later.
    ctx.clock.now += 60_001;
    const forgotten = await ctx.send('GET', `/api/sessions/${SESSION_ID}/files/zip/jobs/${issued.jobId}`);
    assert.equal(forgotten.status, 404);
  });
});
