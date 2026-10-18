// FR-FOP-007 AC-1, AC-4, AC-5, FR-FEX-027 AC-2, AC-5 (#140): the extraction pre-count route and the
// file job API accepting operation 'extract', over real HTTP on real temporary folders.
// Run: cwd=server/, npx tsx --test src/routes/archiveRoutes.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { request } from 'node:http';
import express from 'express';
import { FileService } from '../services/FileService.js';
import { FileJobManager } from '../services/fileJobs/fileJobManager.js';
import { runJob } from '../services/fileJobs/fileJobRunner.js';
import { nodeFileJobFsOps } from '../services/fileJobs/fileJobFsOps.js';
import { captureSessionRoot, isFileJobPathBlocked, validateCreatePath, type FileJobPathPolicy } from '../services/fileJobs/fileJobPaths.js';
import { createFileJobRoutes } from './fileJobRoutes.js';
import { createArchiveRoutes } from './archiveRoutes.js';
import { withLocalHttpServer } from '../testing/localHttpTestServer.js';
import { buildTar, buildZip } from '../testing/archiveFixtures.js';
import { AppError, ErrorCode } from '../utils/errors.js';

const SESSION = 'session-archive';

interface Res { status: number; body: any }

type Precount = typeof import('../services/archive/extractJob.js').precountArchive;

async function withApp(
  run: (ctx: { cwd: string; send: (method: string, url: string, body?: unknown) => Promise<Res>; done: (jobId: string) => Promise<Record<string, unknown>>; endpoint: string }) => Promise<void>,
  options: { precount?: Precount } = {},
): Promise<void> {
  const cwd = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bg-archive-routes-')));
  const sessionManager = {
    getSession: (id: string): unknown => (id === SESSION ? { id } : null),
    getPtyPid: (): number | null => null,
    getInitialCwd: (): string | null => cwd,
    getCwdFilePath: (): string | null => null,
  };
  const service = new FileService(sessionManager as never, {
    maxFileSize: 1024, maxDirectoryEntries: 100, blockedExtensions: ['.exe'], blockedPaths: ['.ssh'], cwdCacheTtlMs: 1000,
    maxExtractEntries: 10,
  });
  const policy: FileJobPathPolicy = {
    async getCwd(id) {
      if (id !== SESSION) throw new AppError(ErrorCode.SESSION_NOT_FOUND);
      return cwd;
    },
    blockedPaths: ['.ssh'],
  };
  const doneEvents = new Map<string, Record<string, unknown>>();
  const manager = new FileJobManager({
    runJob,
    fsOps: nodeFileJobFsOps,
    broadcast: (_s, event, payload) => {
      if (event === 'file-job:done') doneEvents.set(String(payload.jobId), payload);
    },
    clock: { now: () => Date.now() },
    timers: { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout) },
    validatePathFor: (sessionId) => {
      const root = captureSessionRoot(policy, sessionId);
      return async (p) => { await validateCreatePath(policy, sessionId, p, { root }); };
    },
    isPathBlocked: (p) => isFileJobPathBlocked(policy, p),
    archive: { limits: () => service.extractLimits, isBlockedExtension: (name) => path.extname(name).toLowerCase() === '.exe' },
  });
  const app = express();
  app.use(express.json());
  app.use('/api/sessions', createArchiveRoutes(service, { precount: options.precount }));
  app.use('/api/file-jobs', createFileJobRoutes(manager, policy));
  try {
    await withLocalHttpServer(app, async (fixture) => {
      const send = (method: string, url: string, body?: unknown) => new Promise<Res>((resolve, reject) => {
        const payload = body === undefined ? undefined : JSON.stringify(body);
        const req = request({
          socketPath: fixture.endpoint, agent: false, method, path: url,
          headers: payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) },
        }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null });
          });
        });
        req.on('error', reject);
        req.end(payload);
      });
      const done = async (jobId: string) => {
        for (let i = 0; i < 250; i += 1) {
          const event = doneEvents.get(jobId);
          if (event) return event;
          await new Promise((r) => setTimeout(r, 20));
        }
        throw new Error('the job did not finish');
      };
      await run({ cwd, send, done, endpoint: fixture.endpoint });
    });
  } finally {
    await manager.dispose();
    await fs.rm(cwd, { recursive: true, force: true });
  }
}

const text = (s: string) => Buffer.from(s, 'utf8');

test('FR-FEX-027 AC-5, FR-FOP-007 AC-4: the pre-count reports entries, unpacked and packed bytes and the folder smart extraction would make', async () => {
  await withApp(async ({ cwd, send }) => {
    await fs.writeFile(path.join(cwd, 'proj.zip'), buildZip([{ name: 'proj/a.txt', data: text('aaaa') }, { name: 'proj/b/c.txt', data: text('cc') }]));
    await fs.mkdir(path.join(cwd, 'proj'));
    const smart = await send('POST', `/api/sessions/${SESSION}/files/extract/precount`, { path: 'proj.zip', mode: 'smart' });
    assert.equal(smart.status, 200, JSON.stringify(smart.body));
    const packed = (await fs.stat(path.join(cwd, 'proj.zip'))).size;
    assert.deepEqual(smart.body, {
      format: 'zip', entryCount: 2, unpackedBytes: 6, packedBytes: packed, singleTopFolder: 'proj', targetName: 'proj (2)', refusal: null,
    });

    await fs.writeFile(path.join(cwd, 'loose.tgz'), await buildTar([{ name: 'x.txt', data: text('x') }], { gzip: true }));
    const here = await send('POST', `/api/sessions/${SESSION}/files/extract/precount`, { path: 'loose.tgz', mode: 'here' });
    assert.equal(here.body.targetName, path.basename(cwd));
    assert.equal(here.body.singleTopFolder, null);
    const looseSmart = await send('POST', `/api/sessions/${SESSION}/files/extract/precount`, { path: 'loose.tgz', mode: 'smart' });
    assert.equal(looseSmart.body.targetName, 'loose');
  });
});

test('FR-FOP-007 AC-4, AC-5: the pre-count answers a refusal with its code and reason; a bad path is an error', async () => {
  await withApp(async ({ cwd, send }) => {
    await fs.writeFile(path.join(cwd, 'many.zip'), buildZip(Array.from({ length: 11 }, (_, i) => ({ name: `m/${i}`, data: text('x') }))));
    await fs.writeFile(path.join(cwd, 'secret.zip'), buildZip([{ name: 'a', data: text('a'), encrypted: true }]));
    await fs.writeFile(path.join(cwd, 'junk.zip'), text('junk'));
    await fs.writeFile(path.join(cwd, 'notes.txt'), text('not an archive'));
    const cases: Array<[string, string]> = [['many.zip', 'ARCHIVE_TOO_LARGE'], ['secret.zip', 'ARCHIVE_UNSUPPORTED'], ['junk.zip', 'ARCHIVE_CORRUPT'], ['notes.txt', 'ARCHIVE_UNSUPPORTED']];
    for (const [name, code] of cases) {
      const res = await send('POST', `/api/sessions/${SESSION}/files/extract/precount`, { path: name, mode: 'smart' });
      assert.equal(res.status, 200, name);
      assert.equal(res.body.refusal?.code, code, name);
      assert.equal(typeof res.body.refusal?.reason, 'string', name);
    }
    const outside = await send('POST', `/api/sessions/${SESSION}/files/extract/precount`, { path: '../x.zip', mode: 'smart' });
    assert.equal(outside.status, 403);
    const badMode = await send('POST', `/api/sessions/${SESSION}/files/extract/precount`, { path: 'many.zip', mode: 'elsewhere' });
    assert.equal(badMode.status, 400);
  });
});

test('FR-FOP-007 AC-1: POST /api/file-jobs takes operation extract with one archive and a mode, defaulting the target to the archive folder', async () => {
  await withApp(async ({ cwd, send, done }) => {
    await fs.writeFile(path.join(cwd, 'pkg.zip'), buildZip([{ name: 'pkg/a.txt', data: text('A') }]));
    const archive = path.join(cwd, 'pkg.zip');
    const started = await send('POST', '/api/file-jobs', { operation: 'extract', sourceSessionId: SESSION, sources: [archive], mode: 'smart' });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const result = await done(started.body.jobId);
    assert.equal(result.outcome, 'completed', JSON.stringify(result));
    assert.deepEqual(result.affectedDirectories, [cwd]);
    assert.deepEqual(result.createdPaths, [path.join(cwd, 'pkg')]);
    assert.equal(await fs.readFile(path.join(cwd, 'pkg', 'a.txt'), 'utf8'), 'A');

    const bad: Array<[Record<string, unknown>, number]> = [
      [{ operation: 'extract', sourceSessionId: SESSION, sources: [archive] }, 400],
      [{ operation: 'extract', sourceSessionId: SESSION, sources: [archive], mode: 'nowhere' }, 400],
      [{ operation: 'extract', sourceSessionId: SESSION, sources: [archive, archive], mode: 'here' }, 400],
      [{ operation: 'extract', sourceSessionId: SESSION, sources: [path.join(cwd, 'pkg', 'a.txt')], mode: 'here' }, 415],
      [{ operation: 'extract', sourceSessionId: SESSION, sources: [path.join(path.dirname(cwd), 'x.zip')], mode: 'here' }, 403],
      [{ operation: 'extract', sourceSessionId: SESSION, sources: [archive], mode: 'here', destPath: path.dirname(cwd) }, 403],
    ];
    for (const [body, status] of bad) {
      const res = await send('POST', '/api/file-jobs', body);
      assert.equal(res.status, status, JSON.stringify(body) + JSON.stringify(res.body));
    }
  });
});

test('FR-FOP-007 AC-4: a session runs at most two pre-counts at once, and a client that leaves aborts its pre-count', async () => {
  const signals: AbortSignal[] = [];
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const held: Precount = async (_archive, _limits, _onEntry, signal) => {
    signals.push(signal!);
    await Promise.race([gate, new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve()))]);
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    return { format: 'zip', entryCount: 1, unpackedBytes: 1, packedBytes: 1, singleTopFolder: null, stem: 'a' };
  };
  await withApp(async ({ cwd, send, endpoint }) => {
    await fs.writeFile(path.join(cwd, 'a.zip'), buildZip([{ name: 'a.txt', data: text('a') }]));
    const body = JSON.stringify({ path: 'a.zip', mode: 'smart' });
    const open = () => {
      const req = request({ socketPath: endpoint, agent: false, method: 'POST', path: `/api/sessions/${SESSION}/files/extract/precount`, headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) } });
      req.on('error', () => undefined);
      req.end(body);
      return req;
    };
    const first = open();
    const second = open();
    for (let i = 0; i < 100 && signals.length < 2; i += 1) await new Promise((r) => setTimeout(r, 20));
    assert.equal(signals.length, 2);
    const third = await send('POST', `/api/sessions/${SESSION}/files/extract/precount`, { path: 'a.zip', mode: 'smart' });
    assert.equal(third.status, 429);
    assert.equal(third.body.error.code, 'PRECOUNT_BUSY');

    first.destroy();
    for (let i = 0; i < 100 && !signals[0].aborted; i += 1) await new Promise((r) => setTimeout(r, 20));
    assert.equal(signals[0].aborted, true, 'the pre-count of the client that left was aborted');
    release();
    second.destroy();
    for (let i = 0; i < 100 && signals.length < 3; i += 1) {
      const next = await send('POST', `/api/sessions/${SESSION}/files/extract/precount`, { path: 'a.zip', mode: 'smart' });
      if (next.status === 200) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(signals.length, 3, 'a slot came back');
  }, { precount: held });
});
