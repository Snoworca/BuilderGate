// FR-FEX-023 (#139): the upload pre-check and the streaming upload, over real HTTP on a real
// temporary directory. Run per-file: cwd=server/, npx tsx --test src/routes/uploadRoutes.test.ts
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import fsSync from 'node:fs';
import { request, type IncomingHttpHeaders, type ClientRequest } from 'node:http';
import express from 'express';
import { FileService } from '../services/FileService.js';
import { FileSearchService } from '../services/FileSearchService.js';
import { UploadTempRegistry, isUploadTempName } from '../services/upload/uploadTemp.js';
import { createUploadRoutes } from './uploadRoutes.js';
import { withLocalHttpServer } from '../testing/localHttpTestServer.js';

const SESSION_ID = 'session-upload';
const MAX_UPLOAD = 64 * 1024;

interface RawResponse { status: number; headers: IncomingHttpHeaders; body: Buffer }

interface Ctx {
  cwd: string;
  service: FileService;
  registry: UploadTempRegistry;
  registryPath: string;
  endpoint: string;
  send: (method: string, urlPath: string, body?: unknown) => Promise<RawResponse>;
  put: (query: Record<string, string>, bytes: Buffer, headers?: Record<string, string>) => Promise<RawResponse>;
  /** Starts an upload and leaves it open: the caller writes, ends or aborts it. */
  openPut: (query: Record<string, string>, contentLength: number | null) => { req: ClientRequest; response: Promise<RawResponse> };
}

function uploadUrl(query: Record<string, string>): string {
  return `/api/sessions/${SESSION_ID}/files/upload?${new URLSearchParams(query).toString()}`;
}

interface AppOptions {
  maxConcurrent?: number;
  idleTimeoutMs?: number;
  createWriteStream?: (filePath: string) => import('node:stream').Writable;
}

async function withApp(run: (ctx: Ctx) => Promise<void>, options: AppOptions = {}): Promise<void> {
  const cwd = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'buildergate-upload-')));
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'buildergate-upload-data-'));
  const registryPath = path.join(dataDir, 'upload-temp.json');
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
    maxUploadFileSize: MAX_UPLOAD,
  });
  const registry = new UploadTempRegistry(registryPath);
  const app = express();
  app.use(express.json());
  app.use('/api/sessions', createUploadRoutes(service, { registry, maxConcurrentPerSession: options.maxConcurrent, idleTimeoutMs: options.idleTimeoutMs, createWriteStream: options.createWriteStream }));
  try {
    await withLocalHttpServer(app, async (fixture) => {
      const collect = (req: ClientRequest) => new Promise<RawResponse>((resolve, reject) => {
        req.on('response', (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }));
          response.on('error', reject);
        });
        req.on('error', reject);
      });
      const send = (method: string, urlPath: string, body?: unknown) => {
        const payload = body === undefined ? undefined : JSON.stringify(body);
        const req = request({
          socketPath: fixture.endpoint,
          agent: false,
          method,
          path: urlPath,
          headers: payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) },
        });
        const response = collect(req);
        req.end(payload);
        return response;
      };
      const openPut = (query: Record<string, string>, contentLength: number | null) => {
        const headers: Record<string, string> = { 'content-type': 'application/octet-stream' };
        if (contentLength !== null) headers['content-length'] = String(contentLength);
        const req = request({ socketPath: fixture.endpoint, agent: false, method: 'PUT', path: uploadUrl(query), headers });
        return { req, response: collect(req) };
      };
      const put = (query: Record<string, string>, bytes: Buffer, headers: Record<string, string> = {}) => {
        const req = request({
          socketPath: fixture.endpoint,
          agent: false,
          method: 'PUT',
          path: uploadUrl(query),
          headers: { 'content-type': 'application/octet-stream', 'content-length': String(bytes.length), ...headers },
        });
        const response = collect(req);
        req.end(bytes);
        return response;
      };
      await run({ cwd, service, registry, registryPath, endpoint: fixture.endpoint, send, put, openPut });
    });
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

function json(response: RawResponse): Record<string, unknown> {
  return JSON.parse(response.body.toString('utf8')) as Record<string, unknown>;
}

function code(response: RawResponse): unknown {
  return (json(response).error as { code?: unknown } | undefined)?.code;
}

async function tempFilesIn(dir: string): Promise<string[]> {
  return (await fs.readdir(dir)).filter(isUploadTempName);
}

async function waitFor(predicate: () => Promise<boolean>, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function patterned(length: number): Buffer {
  return Buffer.from(Array.from({ length }, (_, i) => (i * 31 + 7) & 0xff));
}

test('FR-FEX-023 AC-1: a binary file larger than the JSON body limit streams in and answers name, path and size', async () => {
  await withApp(async ({ cwd, put }) => {
    await fs.mkdir(path.join(cwd, 'src'));
    const bytes = patterned(40_000); // far above maxFileSize (1024): not the text write path
    const response = await put({ dir: 'src', path: '사진 1.png' }, bytes);
    assert.equal(response.status, 200, response.body.toString());
    assert.deepEqual(json(response), { name: '사진 1.png', path: 'src/사진 1.png', size: 40_000, skipped: false });
    assert.deepEqual(await fs.readFile(path.join(cwd, 'src', '사진 1.png')), bytes);
    assert.deepEqual(await tempFilesIn(path.join(cwd, 'src')), [], 'no temporary file is left');
  });
});

test('FR-FEX-023 AC-2: destinations outside the session or blocked are refused and nothing is created', async (t: TestContext) => {
  await withApp(async ({ cwd, put }) => {
    const outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'buildergate-upload-outside-')));
    try {
      await fs.mkdir(path.join(cwd, '.ssh'));
      const cases: Array<[Record<string, string>, number, string]> = [
        [{ dir: '..', path: 'a.txt' }, 403, 'PATH_TRAVERSAL'],
        [{ dir: '.ssh', path: 'a.txt' }, 403, 'PATH_BLOCKED'],
        [{ dir: '', path: 'tool.exe' }, 403, 'PATH_BLOCKED'],
        [{ dir: '', path: 'TOOL.EXE' }, 403, 'PATH_BLOCKED'],
        [{ dir: '', path: '.ssh/key' }, 403, 'PATH_BLOCKED'],
      ];
      let linked = true;
      try {
        await fs.symlink(outside, path.join(cwd, 'escape'), 'junction');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EPERM') throw err;
        linked = false;
        t.diagnostic('junction needs privilege on this host; the link case is skipped');
      }
      if (linked) {
        cases.push([{ dir: 'escape', path: 'a.txt' }, 403, 'PATH_TRAVERSAL']);
        cases.push([{ dir: '', path: 'escape/a.txt' }, 403, 'PATH_TRAVERSAL']);
      }
      for (const [query, status, expected] of cases) {
        const response = await put(query, Buffer.from('payload'));
        assert.equal(response.status, status, `${JSON.stringify(query)}: ${response.body.toString()}`);
        assert.equal(code(response), expected, JSON.stringify(query));
      }
      assert.deepEqual(await fs.readdir(outside), [], 'nothing was written outside the session');
      assert.deepEqual((await fs.readdir(cwd)).sort(), linked ? ['.ssh', 'escape'] : ['.ssh']);
      assert.deepEqual(await fs.readdir(path.join(cwd, '.ssh')), []);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});

test('FR-FEX-023 AC-3: an invalid relative path is refused with INVALID_UPLOAD_PATH; missing folders are created', async () => {
  await withApp(async ({ cwd, put }) => {
    const invalid = ['tool.exe.', 'tool.exe ', 'dir./a.txt', 'a /b.txt', '../a.txt', 'a/../../b.txt', '/abs.txt', '\\abs.txt', 'C:/abs.txt', 'C:\\abs.txt', 'a\u0000b.txt',
      'CON', 'con.txt', 'sub/PRN.md', 'AUX', 'nul.txt', 'COM1.log', 'lpt9', 'a//b.txt', './a.txt', ''];
    for (const rel of invalid) {
      const response = await put({ dir: '', path: rel }, Buffer.from('x'));
      assert.equal(response.status, 400, `${JSON.stringify(rel)}: ${response.body.toString()}`);
      assert.equal(code(response), 'INVALID_UPLOAD_PATH', JSON.stringify(rel));
    }
    assert.deepEqual(await fs.readdir(cwd), [], 'no file and no folder was created');

    const ok = await put({ dir: '', path: 'assets/icons/b.svg' }, Buffer.from('<svg/>'));
    assert.equal(ok.status, 200, ok.body.toString());
    assert.equal(json(ok).path, 'assets/icons/b.svg');
    assert.equal(await fs.readFile(path.join(cwd, 'assets', 'icons', 'b.svg'), 'utf8'), '<svg/>');
    // Names merely containing a reserved word are fine.
    const fine = await put({ dir: '', path: 'console.txt' }, Buffer.from('ok'));
    assert.equal(fine.status, 200, fine.body.toString());
  });
});

test('FR-FEX-023 AC-4: a declared size over maxUploadFileSize is refused before streaming', async () => {
  await withApp(async ({ cwd, put }) => {
    const response = await put({ dir: '', path: 'big.bin' }, patterned(MAX_UPLOAD + 1));
    assert.equal(response.status, 413, response.body.toString());
    assert.equal(code(response), 'FILE_TOO_LARGE');
    assert.deepEqual(await fs.readdir(cwd), []);
    const exact = await put({ dir: '', path: 'exact.bin' }, patterned(MAX_UPLOAD));
    assert.equal(exact.status, 200, 'the limit itself is allowed');
  });
});

test('FR-FEX-023 AC-4: a body without a declared length that grows past the limit is cut off and its temporary file removed', async () => {
  await withApp(async ({ cwd, openPut, registry }) => {
    const { req, response } = openPut({ dir: '', path: 'grow.bin' }, null);
    const chunk = patterned(16 * 1024);
    req.on('error', () => { /* the server may close the connection while the body is still being sent */ });
    for (let i = 0; i < 5; i += 1) req.write(chunk);
    req.end();
    // The answer reaches the client: the server stops writing, not the connection.
    const result = await response;
    assert.equal(result.status, 413, result.body.toString());
    assert.equal(code(result), 'FILE_TOO_LARGE');
    assert.equal(result.headers.connection, 'close');
    await waitFor(async () => (await fs.readdir(cwd)).length === 0, 'the temporary file to be removed');
    assert.deepEqual(registry.list(), []);
  });
});

test('FR-FEX-023 AC-5: bytes go to a hidden temp file that listing and search never show; an aborted upload leaves nothing', async () => {
  await withApp(async ({ cwd, service, openPut, registry, registryPath }) => {
    await fs.mkdir(path.join(cwd, 'dst'));
    const { req, response } = openPut({ dir: 'dst', path: 'video.bin' }, 50_000);
    response.catch(() => { /* aborted on purpose */ });
    req.on('error', () => { /* aborted on purpose */ });
    req.write(patterned(10_000));
    const dst = path.join(cwd, 'dst');
    await waitFor(async () => {
      const temps = await tempFilesIn(dst);
      if (temps.length !== 1) return false;
      return (await fs.stat(path.join(dst, temps[0]))).size > 0;
    }, 'the temporary file to receive bytes');
    const [temp] = await tempFilesIn(dst);
    assert.match(temp, /^\.bgupload-[0-9a-f]{16}\.part$/);
    assert.equal((await fs.readdir(dst)).includes('video.bin'), false, 'nothing is in place before the last byte');

    // Not in the listing, not counted, not found by search.
    const listing = await service.listDirectory(SESSION_ID, 'dst');
    assert.deepEqual(listing.entries.map((e) => e.name), ['..']);
    assert.equal(listing.totalEntries, 1, 'only the parent entry is counted');
    const search = new FileSearchService({ resolveRoot: (id, p) => service.resolveSearchRoot(id, p) });
    const { id } = await search.start(SESSION_ID, { path: '', query: 'bgupload', includeIgnored: true });
    await waitFor(async () => search.poll(id, 0).outcome !== 'running', 'the search to finish');
    assert.deepEqual(search.poll(id, 0).results, []);
    // The temp path is recorded for the startup cleanup while the upload runs.
    assert.deepEqual(registry.list(), [path.join(dst, temp)]);
    assert.deepEqual(JSON.parse(await fs.readFile(registryPath, 'utf8')), [path.join(dst, temp)]);

    req.destroy();
    await waitFor(async () => (await fs.readdir(dst)).length === 0, 'the aborted temp file to be deleted');
    assert.deepEqual(registry.list(), []);
    await waitFor(async () => JSON.parse(await fs.readFile(registryPath, 'utf8')).length === 0, 'the registry file to empty');
  });
});

test('FR-FEX-023 AC-5: an upload that overwrites keeps the old file intact until the last byte, and after an abort', async () => {
  await withApp(async ({ cwd, openPut }) => {
    await fs.writeFile(path.join(cwd, 'keep.txt'), 'original');
    const { req, response } = openPut({ dir: '', path: 'keep.txt', conflict: 'overwrite' }, 20_000);
    response.catch(() => { /* aborted on purpose */ });
    req.on('error', () => { /* aborted on purpose */ });
    req.write(patterned(5_000));
    await waitFor(async () => (await tempFilesIn(cwd)).length === 1, 'the temporary file');
    assert.equal(await fs.readFile(path.join(cwd, 'keep.txt'), 'utf8'), 'original');
    req.destroy();
    await waitFor(async () => (await tempFilesIn(cwd)).length === 0, 'the temporary file to be deleted');
    assert.equal(await fs.readFile(path.join(cwd, 'keep.txt'), 'utf8'), 'original');
  });
});

test('FR-FEX-023 AC-7: an existing name answers 409 without writing; overwrite, rename and skip each do their job', async () => {
  await withApp(async ({ cwd, put }) => {
    await fs.writeFile(path.join(cwd, 'a.png'), 'old');
    await fs.writeFile(path.join(cwd, 'a (2).png'), 'second');

    const conflict = await put({ dir: '', path: 'a.png' }, Buffer.from('new'));
    assert.equal(conflict.status, 409, conflict.body.toString());
    assert.equal(code(conflict), 'FILE_ALREADY_EXISTS');
    assert.equal(await fs.readFile(path.join(cwd, 'a.png'), 'utf8'), 'old');

    const skipped = await put({ dir: '', path: 'a.png', conflict: 'skip' }, Buffer.from('new'));
    assert.equal(skipped.status, 200);
    assert.equal(json(skipped).skipped, true);
    assert.equal(await fs.readFile(path.join(cwd, 'a.png'), 'utf8'), 'old');

    const renamed = await put({ dir: '', path: 'a.png', conflict: 'rename' }, Buffer.from('renamed'));
    assert.equal(renamed.status, 200, renamed.body.toString());
    assert.deepEqual(json(renamed), { name: 'a (3).png', path: 'a (3).png', size: 7, skipped: false });
    assert.equal(await fs.readFile(path.join(cwd, 'a (3).png'), 'utf8'), 'renamed');

    const overwritten = await put({ dir: '', path: 'a.png', conflict: 'overwrite' }, Buffer.from('replaced'));
    assert.equal(overwritten.status, 200, overwritten.body.toString());
    assert.equal(json(overwritten).name, 'a.png');
    assert.equal(await fs.readFile(path.join(cwd, 'a.png'), 'utf8'), 'replaced');

    // A file never replaces a folder of the same name (FR-FOP-004 AC-7): overwrite is refused.
    await fs.mkdir(path.join(cwd, 'docs'));
    const kind = await put({ dir: '', path: 'docs', conflict: 'overwrite' }, Buffer.from('x'));
    assert.equal(kind.status, 409);
    assert.equal(code(kind), 'FILE_ALREADY_EXISTS');
    assert.equal((await fs.stat(path.join(cwd, 'docs'))).isDirectory(), true);

    const bad = await put({ dir: '', path: 'b.png', conflict: 'merge' }, Buffer.from('x'));
    assert.equal(bad.status, 400);
    assert.deepEqual((await fs.readdir(cwd)).filter(isUploadTempName), []);
  });
});

test('FR-FEX-023 AC-7: the pre-check reports conflicts with their decisions and the refused files', async () => {
  await withApp(async ({ cwd, send }) => {
    await fs.mkdir(path.join(cwd, 'src'));
    await fs.writeFile(path.join(cwd, 'src', 'a.png'), 'x'.repeat(900));
    await fs.mkdir(path.join(cwd, 'src', 'assets'));
    await fs.mkdir(path.join(cwd, 'src', 'logo.png'));
    await fs.writeFile(path.join(cwd, 'src', 'notes'), 'a file named like a folder');
    const response = await send('POST', `/api/sessions/${SESSION_ID}/files/upload/check`, {
      dir: 'src',
      files: [
        { path: 'a.png', size: 1200 },
        { path: 'assets/b.svg', size: 300 },
        { path: 'assets/c.svg', size: 300 },
        { path: 'logo.png', size: 10 },
        { path: 'notes/n.md', size: 10 },
        { path: 'fresh.txt', size: 10 },
        { path: 'x.exe', size: 10 },
        { path: '../up.txt', size: 10 },
        { path: 'huge.bin', size: MAX_UPLOAD + 1 },
        { path: '.ssh/id', size: 10 },
      ],
    });
    assert.equal(response.status, 200, response.body.toString());
    const body = json(response) as { conflicts: Array<Record<string, unknown>>; rejected: Array<Record<string, unknown>> };
    const byPath = new Map(body.conflicts.map((c) => [c.path, c]));
    assert.deepEqual([...byPath.keys()].sort(), ['a.png', 'assets', 'logo.png', 'notes']);
    assert.deepEqual(byPath.get('a.png')!.decisions, ['overwrite', 'rename', 'skip']);
    assert.equal((byPath.get('a.png')!.existing as { size: number }).size, 900);
    assert.equal((byPath.get('a.png')!.existing as { isDirectory: boolean }).isDirectory, false);
    assert.match(String((byPath.get('a.png')!.existing as { modified: string }).modified), /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(byPath.get('a.png')!.renameTo, 'a (2).png');
    assert.deepEqual(byPath.get('assets')!.decisions, ['overwrite', 'rename', 'skip'], 'folder onto folder merges');
    assert.equal(byPath.get('assets')!.renameTo, 'assets (2)');
    assert.deepEqual(byPath.get('logo.png')!.decisions, ['rename', 'skip'], 'file onto folder');
    assert.deepEqual(byPath.get('notes')!.decisions, ['rename', 'skip'], 'folder onto file');
    const rejected = new Map(body.rejected.map((r) => [r.path, r.code]));
    assert.deepEqual(Object.fromEntries(rejected), {
      'x.exe': 'PATH_BLOCKED',
      '../up.txt': 'INVALID_UPLOAD_PATH',
      'huge.bin': 'FILE_TOO_LARGE',
      '.ssh/id': 'PATH_BLOCKED',
    });

    const badDir = await send('POST', `/api/sessions/${SESSION_ID}/files/upload/check`, { dir: '..', files: [{ path: 'a', size: 1 }] });
    assert.equal(badDir.status, 403);
    assert.equal(code(badDir), 'PATH_TRAVERSAL');
    const noFiles = await send('POST', `/api/sessions/${SESSION_ID}/files/upload/check`, { dir: '' });
    assert.equal(noFiles.status, 400);
  });
});

test('FR-FEX-023 AC-8: a session takes at most 6 concurrent uploads; the 7th answers 429 UPLOAD_BUSY', async () => {
  await withApp(async ({ cwd, openPut, put }) => {
    const open = Array.from({ length: 6 }, (_, i) => openPut({ dir: '', path: `f${i}.bin` }, 100));
    for (const { req, response } of open) {
      req.on('error', () => { /* closed below */ });
      response.catch(() => { /* closed below */ });
      req.write(Buffer.alloc(10));
    }
    await waitFor(async () => (await tempFilesIn(cwd)).length === 6, 'six uploads to be running');
    const seventh = await put({ dir: '', path: 'f7.bin' }, Buffer.from('x'));
    assert.equal(seventh.status, 429, seventh.body.toString());
    assert.equal(code(seventh), 'UPLOAD_BUSY');

    // Finishing one frees a slot.
    open[0].req.end(Buffer.alloc(90));
    assert.equal((await open[0].response).status, 200);
    const next = await put({ dir: '', path: 'f8.bin' }, Buffer.from('x'));
    assert.equal(next.status, 200, next.body.toString());
    for (const { req } of open.slice(1)) req.destroy();
    await waitFor(async () => (await tempFilesIn(cwd)).length === 0, 'aborted uploads to be cleaned');
  });
});

test('FR-FEX-023 AC-5: an upload whose bytes stop arriving is cut off after the idle timeout, its temp file removed and its slot returned', async () => {
  await withApp(async ({ cwd, openPut, put, registry }) => {
    const { req, response } = openPut({ dir: '', path: 'stalled.bin' }, 10_000);
    req.on('error', () => { /* cut off by the server */ });
    response.catch(() => { /* cut off by the server */ });
    req.write(patterned(1_000));
    await waitFor(async () => (await tempFilesIn(cwd)).length === 1, 'the temporary file');
    // No more bytes: the server gives up on its own.
    await waitFor(async () => (await fs.readdir(cwd)).length === 0, 'the stalled temp file to be deleted');
    assert.deepEqual(registry.list(), []);
    const next = await put({ dir: '', path: 'next.bin' }, Buffer.from('ok'));
    assert.equal(next.status, 200, 'the only slot came back');
    req.destroy();
  }, { maxConcurrent: 1, idleTimeoutMs: 200 });
});

test('FR-FEX-023 AC-7: uploads of the same name with rename all land under distinct names', async () => {
  await withApp(async ({ cwd, openPut }) => {
    await fs.writeFile(path.join(cwd, 'a.png'), 'old');
    const uploads = Array.from({ length: 20 }, () => openPut({ dir: '', path: 'a.png', conflict: 'rename' }, 4));
    for (const { req } of uploads) req.write(Buffer.from('ab'));
    await waitFor(async () => (await tempFilesIn(cwd)).length === 20, 'twenty uploads to be running');
    // Finish them together so the placements race.
    uploads.forEach(({ req }, i) => req.end(Buffer.from(String(i).padStart(2, '0'))));
    const results = await Promise.all(uploads.map(({ response }) => response));
    const names = results.map((r) => { assert.equal(r.status, 200, r.body.toString()); return String(json(r).name); });
    assert.equal(new Set(names).size, 20, `distinct names: ${names.join(', ')}`);
    const contents = new Set<string>();
    for (const name of names) contents.add(await fs.readFile(path.join(cwd, name), 'utf8'));
    assert.equal(contents.size, 20, 'no upload replaced another');
    assert.equal(await fs.readFile(path.join(cwd, 'a.png'), 'utf8'), 'old');
    assert.deepEqual(await tempFilesIn(cwd), []);
  }, { maxConcurrent: 20 });
});

test('FR-FEX-023 AC-5: a server-side write error answers an error code and removes the temp file', async () => {
  for (const [errno, status, expected] of [['ENOSPC', 500, 'FILE_OPERATION_FAILED'], ['EACCES', 403, 'PERMISSION_DENIED']] as const) {
    await withApp(async ({ cwd, put, registry }) => {
      const response = await put({ dir: '', path: 'doomed.bin' }, patterned(20_000));
      assert.equal(response.status, status, `${errno}: ${response.body.toString()}`);
      assert.equal(code(response), expected);
      await waitFor(async () => (await fs.readdir(cwd)).length === 0, 'the temp file to be removed');
      assert.deepEqual(registry.list(), []);
    }, {
      createWriteStream: (filePath) => {
        const stream = fsSync.createWriteStream(filePath, { flags: 'wx' });
        stream.once('open', () => stream.destroy(Object.assign(new Error(`${errno}: injected`), { code: errno })));
        return stream;
      },
    });
  }
});
