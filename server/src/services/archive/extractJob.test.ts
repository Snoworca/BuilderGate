// FR-FOP-007 (#140), FR-FEX-027 AC-2: archive extraction as a file job, through the real
// FileJobManager, the real runner and the real file system on temporary folders, with archives
// built byte by byte (src/testing/archiveFixtures.ts).
// Run: cwd=server/, npx tsx --test src/services/archive/extractJob.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import iconv from 'iconv-lite';
import { FileJobManager, type FileJobEvent } from '../fileJobs/fileJobManager.js';
import { runJob } from '../fileJobs/fileJobRunner.js';
import { nodeFileJobFsOps } from '../fileJobs/fileJobFsOps.js';
import { captureSessionRoot, isFileJobPathBlocked, validateCreatePath, type FileJobPathPolicy } from '../fileJobs/fileJobPaths.js';
import { UploadTempRegistry, isUploadTempName } from '../upload/uploadTemp.js';
import { AppError, ErrorCode } from '../../utils/errors.js';
import { buildTar, buildZip, type ZipFixtureEntry } from '../../testing/archiveFixtures.js';
import { precountArchive } from './extractJob.js';

const SESSION = 'session-extract';

interface Done {
  outcome: string;
  errorCode?: string;
  errorReason?: string;
  skipped?: Array<{ path: string; reason: string }>;
  skippedCount?: number;
  createdPaths?: string[];
  affectedDirectories: string[];
  processedEntries: number;
}

interface Decision { decisionId: string; kind: string; path: string; choices: string[]; jobId: string }

interface Ctx {
  cwd: string;
  outside: string;
  registry: UploadTempRegistry;
  manager: FileJobManager;
  events: Array<{ event: FileJobEvent; payload: Record<string, unknown> }>;
  /** Starts an extraction and waits for done; onDecision answers each question. */
  extract(archive: string, mode: 'smart' | 'here', options?: {
    destDir?: string;
    onDecision?: (d: Decision) => { choice: string; applyToAll?: boolean } | 'cancel';
  }): Promise<Done>;
}

interface Options {
  maxExtractBytes?: number;
  maxExtractEntries?: number;
  onTempAdded?: (tempPath: string, manager: FileJobManager, jobId: () => string) => void;
  /** Runs between the pre-count and the write pass (the archive can change there). */
  afterPrecount?: (archivePath: string) => Promise<void>;
}

async function withExtract(run: (ctx: Ctx) => Promise<void>, options: Options = {}): Promise<void> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bg-extract-')));
  const cwd = path.join(root, 'work');
  const outside = path.join(root, 'outside');
  await fs.mkdir(cwd);
  await fs.mkdir(outside);
  const policy: FileJobPathPolicy = {
    async getCwd(id) {
      if (id !== SESSION) throw new AppError(ErrorCode.SESSION_NOT_FOUND);
      return cwd;
    },
    blockedPaths: ['.ssh'],
  };
  const registry = new UploadTempRegistry(path.join(root, 'data', 'upload-temp.json'));
  let currentJob = '';
  if (options.onTempAdded) {
    const add = registry.add.bind(registry);
    registry.add = (p: string) => {
      const added = add(p);
      options.onTempAdded!(p, manager, () => currentJob);
      return added;
    };
  }
  const events: Ctx['events'] = [];
  const listeners = new Set<(event: FileJobEvent, payload: Record<string, unknown>) => void>();
  const manager: FileJobManager = new FileJobManager({
    runJob,
    fsOps: nodeFileJobFsOps,
    broadcast: (_sessionId, event, payload) => {
      events.push({ event, payload });
      for (const listener of listeners) listener(event, payload);
    },
    clock: { now: () => Date.now() },
    timers: { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout) },
    validatePathFor: (sessionId) => {
      const sessionRoot = captureSessionRoot(policy, sessionId);
      return async (p) => {
        await validateCreatePath(policy, sessionId, p, { root: sessionRoot });
      };
    },
    isPathBlocked: (p) => isFileJobPathBlocked(policy, p),
    archive: {
      limits: () => ({ maxExtractBytes: options.maxExtractBytes ?? 10 * 1024 ** 3, maxExtractEntries: options.maxExtractEntries ?? 100_000 }),
      isBlockedExtension: (name) => path.extname(name).toLowerCase() === '.exe',
      tempRegistry: registry,
      afterPrecount: options.afterPrecount,
    },
  });
  const extract: Ctx['extract'] = (archive, mode, extractOptions = {}) => new Promise<Done>((resolve, reject) => {
    const source = path.join(cwd, archive);
    let jobId = '';
    const listener = (event: FileJobEvent, payload: Record<string, unknown>): void => {
      if (payload.jobId !== jobId) return;
      if (event === 'file-job:decision-required') {
        const decision = payload as unknown as Decision;
        const answer = extractOptions.onDecision?.(decision) ?? { choice: 'skip' };
        setImmediate(() => {
          try {
            if (answer === 'cancel') manager.cancel(jobId);
            else manager.decide(jobId, { decisionId: decision.decisionId, choice: answer.choice as never, applyToAll: answer.applyToAll });
          } catch (err) {
            reject(err);
          }
        });
      } else if (event === 'file-job:done') {
        listeners.delete(listener);
        resolve(payload as unknown as Done);
      }
    };
    listeners.add(listener);
    try {
      jobId = manager.start({
        sourceSessionId: SESSION,
        spec: { operation: 'extract', sources: [source], destDir: extractOptions.destDir ?? path.dirname(source), mode },
      }).jobId;
      currentJob = jobId;
    } catch (err) {
      reject(err);
    }
  });
  try {
    await run({ cwd, outside, registry, manager, events, extract });
  } finally {
    await manager.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function tree(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const dirent of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix ? `${prefix}/${dirent.name}` : dirent.name;
    if (dirent.isDirectory()) {
      out.push(`${rel}/`);
      out.push(...(await tree(path.join(dir, dirent.name), rel)));
    } else {
      out.push(rel);
    }
  }
  return out;
}

async function noTempFiles(dir: string): Promise<void> {
  const found = (await tree(dir)).filter((p) => isUploadTempName(path.posix.basename(p)) || /\.bg-part-/.test(p));
  assert.deepEqual(found, [], 'no temporary file is left');
}

const text = (s: string) => Buffer.from(s, 'utf8');

test('FR-FOP-007 AC-1, FR-FEX-027 AC-2: smart extraction of an archive under one top folder creates that folder once', async () => {
  await withExtract(async ({ cwd, extract, events }) => {
    await fs.writeFile(path.join(cwd, 'proj.zip'), buildZip([
      { name: 'proj/' },
      { name: 'proj/src/a.ts', data: text('export const a = 1;\n') },
      { name: 'proj/README.md', data: text('# hi') },
    ]));
    const done = await extract('proj.zip', 'smart');
    assert.equal(done.outcome, 'completed', JSON.stringify(done));
    assert.deepEqual(await tree(cwd), ['proj/', 'proj/README.md', 'proj/src/', 'proj/src/a.ts', 'proj.zip']);
    assert.equal(await fs.readFile(path.join(cwd, 'proj', 'src', 'a.ts'), 'utf8'), 'export const a = 1;\n');
    assert.deepEqual(done.createdPaths, [path.join(cwd, 'proj')]);
    assert.deepEqual(done.skipped, []);
    assert.ok(done.affectedDirectories.includes(cwd));
    const progress = events.filter((e) => e.event === 'file-job:progress').map((e) => e.payload);
    assert.ok(progress.some((p) => p.phase === 'transferring'), 'progress is reported');
    const last = progress[progress.length - 1];
    assert.equal(last.totalEntries, 3);
    assert.equal(last.totalBytes, 'export const a = 1;\n'.length + 4);
    assert.equal(last.processedBytes, last.totalBytes);
  });
});

test('FR-FEX-027 AC-2: smart extraction of loose entries makes a folder named after the archive, taking the (2) name when it exists', async () => {
  await withExtract(async ({ cwd, extract }) => {
    await fs.writeFile(path.join(cwd, 'bundle.tar.gz'), await buildTar([
      { name: 'a.txt', data: text('A') },
      { name: 'docs/b.txt', data: text('B') },
    ], { gzip: true }));
    await fs.mkdir(path.join(cwd, 'bundle'));
    await fs.writeFile(path.join(cwd, 'bundle', 'mine.txt'), 'keep');
    const done = await extract('bundle.tar.gz', 'smart');
    assert.equal(done.outcome, 'completed', JSON.stringify(done));
    assert.deepEqual(await tree(path.join(cwd, 'bundle (2)')), ['a.txt', 'docs/', 'docs/b.txt']);
    assert.deepEqual(await tree(path.join(cwd, 'bundle')), ['mine.txt'], 'the existing folder is not changed');
    assert.deepEqual(done.createdPaths, [path.join(cwd, 'bundle (2)')]);
  });
});

test('FR-FOP-007 AC-1: extracting here asks about each existing name with the copy choices, and applyToAll carries', async () => {
  await withExtract(async ({ cwd, extract }) => {
    await fs.writeFile(path.join(cwd, 'a.txt'), 'old a');
    await fs.writeFile(path.join(cwd, 'b.txt'), 'old b');
    await fs.writeFile(path.join(cwd, 'c.txt'), 'old c');
    await fs.mkdir(path.join(cwd, 'd.txt'));
    await fs.writeFile(path.join(cwd, 'here.zip'), buildZip([
      { name: 'a.txt', data: text('new a') },
      { name: 'b.txt', data: text('new b') },
      { name: 'c.txt', data: text('new c') },
      { name: 'd.txt', data: text('new d') },
      { name: 'fresh/e.txt', data: text('E') },
    ]));
    const asked: Decision[] = [];
    const done = await extract('here.zip', 'here', {
      onDecision: (d) => {
        asked.push(d);
        if (d.path.endsWith('a.txt')) return { choice: 'overwrite' };
        if (d.path.endsWith('b.txt')) return { choice: 'rename' };
        if (d.path.endsWith('c.txt')) return { choice: 'skip', applyToAll: true };
        return { choice: 'skip' };
      },
    });
    assert.equal(done.outcome, 'completed', JSON.stringify(done));
    assert.deepEqual(asked.map((d) => [path.basename(d.path), d.kind, d.choices]), [
      ['a.txt', 'conflict', ['overwrite', 'rename', 'skip']],
      ['b.txt', 'conflict', ['overwrite', 'rename', 'skip']],
      ['c.txt', 'conflict', ['overwrite', 'rename', 'skip']],
      // d.txt meets a folder (choices rename, skip); the remembered skip is one of them, so it is not asked.
    ]);
    assert.equal(await fs.readFile(path.join(cwd, 'a.txt'), 'utf8'), 'new a');
    assert.equal(await fs.readFile(path.join(cwd, 'b.txt'), 'utf8'), 'old b');
    assert.equal(await fs.readFile(path.join(cwd, 'b (2).txt'), 'utf8'), 'new b');
    assert.equal(await fs.readFile(path.join(cwd, 'c.txt'), 'utf8'), 'old c');
    assert.equal((await fs.stat(path.join(cwd, 'd.txt'))).isDirectory(), true);
    assert.equal(await fs.readFile(path.join(cwd, 'fresh', 'e.txt'), 'utf8'), 'E');
    assert.deepEqual(done.createdPaths, [path.join(cwd, 'a.txt')], 'the first extracted item');
    await noTempFiles(cwd);
  });
});

test('FR-FOP-007 AC-1: a folder of the archive meeting an existing file asks rename or skip, and rename carries the folder', async () => {
  await withExtract(async ({ cwd, extract }) => {
    await fs.writeFile(path.join(cwd, 'lib'), 'a file named lib');
    await fs.writeFile(path.join(cwd, 'k.zip'), buildZip([
      { name: 'lib/x.js', data: text('x') },
      { name: 'lib/y.js', data: text('y') },
    ]));
    const asked: Decision[] = [];
    const done = await extract('k.zip', 'here', { onDecision: (d) => { asked.push(d); return { choice: 'rename' }; } });
    assert.equal(done.outcome, 'completed', JSON.stringify(done));
    assert.equal(asked.length, 1, 'asked once for the folder');
    assert.deepEqual(asked[0].choices, ['rename', 'skip']);
    assert.deepEqual(await tree(path.join(cwd, 'lib (2)')), ['x.js', 'y.js']);
    assert.equal(await fs.readFile(path.join(cwd, 'lib'), 'utf8'), 'a file named lib');
  });
});

test('FR-FOP-007 AC-2: entries that would leave the target folder or carry forbidden names are skipped and reported; nothing lands outside', async () => {
  await withExtract(async ({ cwd, outside, extract }) => {
    const evil: ZipFixtureEntry[] = [
      { name: '../outside/evil.txt', data: text('zip slip') },
      { name: 'a/../../outside/evil2.txt', data: text('zip slip') },
      { name: '/abs.txt', data: text('abs') },
      { name: '\\abs2.txt', data: text('abs') },
      { name: 'C:/win.txt', data: text('drive') },
      { name: 'ok/CON.txt', data: text('reserved') },
      { name: 'ok/tool.exe.', data: text('trailing dot') },
      { name: 'ok/space ', data: text('trailing space') },
      { name: Buffer.from('ok/nul\u0000.txt', 'latin1'), data: text('nul') },
      { name: 'ok/fine.txt', data: text('fine') },
      { name: 'ok/sub\\win.txt', data: text('backslash separator') },
    ];
    await fs.writeFile(path.join(cwd, 'evil.zip'), buildZip(evil));
    const done = await extract('evil.zip', 'here');
    assert.equal(done.outcome, 'completed', JSON.stringify(done));
    assert.deepEqual(await tree(outside), [], 'nothing outside');
    assert.deepEqual(await tree(cwd), ['evil.zip', 'ok/', 'ok/fine.txt', 'ok/sub/', 'ok/sub/win.txt']);
    const reasons = Object.fromEntries((done.skipped ?? []).map((s) => [s.path, s.reason]));
    assert.equal(reasons['../outside/evil.txt'], 'entry path leaves the target folder');
    assert.equal(reasons['a/../../outside/evil2.txt'], 'entry path leaves the target folder');
    assert.equal(reasons['/abs.txt'], 'entry path is absolute');
    assert.equal(reasons['\\abs2.txt'], 'entry path is absolute');
    assert.equal(reasons['C:/win.txt'], 'entry path is absolute');
    assert.equal(reasons['ok/CON.txt'], 'entry name is not allowed');
    assert.equal(reasons['ok/tool.exe.'], 'entry name is not allowed');
    assert.equal(reasons['ok/space '], 'entry name is not allowed');
    assert.equal(Object.keys(reasons).length, 9, JSON.stringify(done.skipped));

    await fs.writeFile(path.join(cwd, 'evil.tar'), await buildTar([
      { name: '../outside/t.txt', data: text('tar slip') },
      { name: './good/t.txt', data: text('good') },
    ]));
    const tarDone = await extract('evil.tar', 'smart');
    assert.equal(tarDone.outcome, 'completed', JSON.stringify(tarDone));
    assert.deepEqual(await tree(outside), []);
    assert.equal(await fs.readFile(path.join(cwd, 'good', 't.txt'), 'utf8'), 'good');
    assert.deepEqual(tarDone.skipped, [{ path: '../outside/t.txt', reason: 'entry path leaves the target folder' }]);
  });
});

test('FR-FOP-007 AC-2: a link already in the target folder is never written through', async () => {
  await withExtract(async ({ cwd, outside, extract }) => {
    try {
      await fs.symlink(outside, path.join(cwd, 'out'), 'junction');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EPERM') return;
      throw err;
    }
    await fs.writeFile(path.join(cwd, 'via.zip'), buildZip([{ name: 'out/p.txt', data: text('through the link') }]));
    const asked: Decision[] = [];
    const done = await extract('via.zip', 'here', { onDecision: (d) => { asked.push(d); return { choice: 'rename' }; } });
    assert.deepEqual(await tree(outside), [], 'nothing written through the link');
    assert.equal(done.outcome, 'completed', JSON.stringify(done));
    assert.deepEqual(asked.map((d) => d.choices), [['rename', 'skip']], 'the link is a name taken by something that is not a folder');
    assert.equal(await fs.readFile(path.join(cwd, 'out (2)', 'p.txt'), 'utf8'), 'through the link');
  });
});

test('FR-FOP-007 AC-3: link, hard link, device and FIFO entries and blocked entries are skipped and reported', async () => {
  await withExtract(async ({ cwd, extract }) => {
    await fs.writeFile(path.join(cwd, 'links.tar'), await buildTar([
      { name: 'pkg/real.txt', data: text('real') },
      { name: 'pkg/sym', type: 'symlink', linkname: '/etc/passwd' },
      { name: 'pkg/hard', type: 'link', linkname: 'pkg/real.txt' },
      { name: 'pkg/tty', type: 'character-device' },
      { name: 'pkg/disk', type: 'block-device' },
      { name: 'pkg/pipe', type: 'fifo' },
      { name: 'pkg/.ssh/id_rsa', data: text('key') },
      { name: 'pkg/run.exe', data: text('MZ') },
    ]));
    const done = await extract('links.tar', 'smart');
    assert.equal(done.outcome, 'completed', JSON.stringify(done));
    assert.deepEqual(await tree(path.join(cwd, 'pkg')), ['real.txt']);
    assert.deepEqual(Object.fromEntries((done.skipped ?? []).map((s) => [s.path, s.reason])), {
      'pkg/sym': 'links are not extracted',
      'pkg/hard': 'links are not extracted',
      'pkg/tty': 'device and pipe entries are not extracted',
      'pkg/disk': 'device and pipe entries are not extracted',
      'pkg/pipe': 'device and pipe entries are not extracted',
      'pkg/.ssh/id_rsa': 'path is blocked',
      'pkg/run.exe': 'path is blocked',
    });

    await fs.writeFile(path.join(cwd, 'zlink.zip'), buildZip([
      { name: 'z/target.txt', data: text('t') },
      { name: 'z/link', data: text('../../outside'), unixMode: 0o120777 },
    ]));
    const zipDone = await extract('zlink.zip', 'smart');
    assert.deepEqual(await tree(path.join(cwd, 'z')), ['target.txt']);
    assert.deepEqual(zipDone.skipped, [{ path: 'z/link', reason: 'links are not extracted' }]);
  });
});

test('FR-FOP-007 AC-4: over maxExtractEntries, over maxExtractBytes or over a 1000x ratio is refused before anything is written', async () => {
  await withExtract(async ({ cwd, extract }) => {
    await fs.writeFile(path.join(cwd, 'many.zip'), buildZip([1, 2, 3, 4].map((i) => ({ name: `m/${i}.txt`, data: text(String(i)) }))));
    const many = await extract('many.zip', 'smart');
    assert.equal(many.outcome, 'failed');
    assert.equal(many.errorCode, 'ARCHIVE_TOO_LARGE');

    await fs.writeFile(path.join(cwd, 'big.zip'), buildZip([{ name: 'b.bin', data: Buffer.alloc(3 * 1024 * 1024, 7) }]));
    const big = await extract('big.zip', 'smart');
    assert.equal(big.outcome, 'failed');
    assert.equal(big.errorCode, 'ARCHIVE_TOO_LARGE');

    assert.deepEqual(await tree(cwd), ['big.zip', 'many.zip'], 'no folder, no file');
  }, { maxExtractEntries: 3, maxExtractBytes: 2 * 1024 * 1024 });

  await withExtract(async ({ cwd, extract }) => {
    // The central directory claims 4 GB for a few bytes.
    await fs.writeFile(path.join(cwd, 'bomb.zip'), buildZip([{ name: 'bomb.bin', data: text('tiny'), declaredSize: 0xfffffff0 }]));
    const bomb = await extract('bomb.zip', 'here');
    assert.equal(bomb.outcome, 'failed');
    assert.equal(bomb.errorCode, 'ARCHIVE_TOO_LARGE');
    assert.match(String(bomb.errorReason), /ratio/);
    assert.deepEqual(await tree(cwd), ['bomb.zip']);
  });
});

test('FR-FOP-007 AC-4: an entry that produces more bytes than it declared is cut off, its temp file removed, and the job fails', async () => {
  await withExtract(async ({ cwd, extract, registry }) => {
    await fs.writeFile(path.join(cwd, 'liar.zip'), buildZip([
      { name: 'liar/first.txt', data: text('first') },
      { name: 'liar/liar.bin', data: Buffer.alloc(200_000, 0x41), declaredSize: 1000 },
    ]));
    const done = await extract('liar.zip', 'smart');
    assert.equal(done.outcome, 'failed');
    assert.equal(done.errorCode, 'ARCHIVE_TOO_LARGE');
    assert.deepEqual(await tree(path.join(cwd, 'liar')), ['first.txt'], 'completed entries stay, the liar is gone');
    await noTempFiles(cwd);
    assert.deepEqual(registry.list(), []);
  });
});

test('FR-FOP-007 AC-5: encrypted, split and unknown-method ZIPs are refused with ARCHIVE_UNSUPPORTED and write nothing', async () => {
  await withExtract(async ({ cwd, extract }) => {
    await fs.writeFile(path.join(cwd, 'secret.zip'), buildZip([{ name: 'a.txt', data: text('a') }, { name: 'b.txt', data: text('b'), encrypted: true }]));
    await fs.writeFile(path.join(cwd, 'part.zip'), buildZip([{ name: 'a.txt', data: text('a') }], { diskNumber: 1 }));
    await fs.writeFile(path.join(cwd, 'bzip.zip'), buildZip([{ name: 'a.txt', data: text('a'), method: 12 }]));
    const cases: Array<[string, RegExp]> = [['secret.zip', /encrypt/i], ['part.zip', /split|multi-disk/i], ['bzip.zip', /method/i]];
    for (const [name, reason] of cases) {
      const done = await extract(name, 'smart');
      assert.equal(done.outcome, 'failed', name);
      assert.equal(done.errorCode, 'ARCHIVE_UNSUPPORTED', name);
      assert.match(String(done.errorReason), reason, name);
    }
    assert.deepEqual(await tree(cwd), ['bzip.zip', 'part.zip', 'secret.zip']);
  });
});

test('FR-FOP-007 AC-5: a corrupt archive or a broken gzip fails with ARCHIVE_CORRUPT after removing the entry being written', async () => {
  await withExtract(async ({ cwd, extract, registry }) => {
    await fs.writeFile(path.join(cwd, 'junk.zip'), Buffer.from('this is not a zip file at all, not even close'));
    const junk = await extract('junk.zip', 'smart');
    assert.equal(junk.outcome, 'failed');
    assert.equal(junk.errorCode, 'ARCHIVE_CORRUPT');

    // Deflate data that does not inflate.
    const badDeflate = buildZip([{ name: 'bad/x.bin', data: Buffer.alloc(5000, 1) }]);
    const at = badDeflate.indexOf(Buffer.from('bad/x.bin')) + 'bad/x.bin'.length;
    badDeflate.fill(0xff, at, at + 40);
    await fs.writeFile(path.join(cwd, 'bad.zip'), badDeflate);
    const bad = await extract('bad.zip', 'smart');
    assert.equal(bad.outcome, 'failed');
    assert.equal(bad.errorCode, 'ARCHIVE_CORRUPT');

    // A gzip tar cut in the middle of its second file.
    const random = Buffer.alloc(300_000);
    for (let i = 0; i < random.length; i += 4) random.writeUInt32LE((Math.imul(i, 2654435761) ^ (i >>> 3)) >>> 0, i);
    const gz = await buildTar([{ name: 'cut/one.txt', data: text('one') }, { name: 'cut/two.bin', data: random }], { gzip: true });
    await fs.writeFile(path.join(cwd, 'cut.tgz'), gz.subarray(0, Math.floor(gz.length * 0.6)));
    const cut = await extract('cut.tgz', 'smart');
    assert.equal(cut.outcome, 'failed', JSON.stringify(cut));
    assert.equal(cut.errorCode, 'ARCHIVE_CORRUPT');
    await noTempFiles(cwd);
    assert.deepEqual(registry.list(), []);
  });
});

test('FR-FOP-007 AC-5: a cut tar.gz is caught by the pre-count before anything is written', async () => {
  await withExtract(async ({ cwd, extract }) => {
    const gz = await buildTar([{ name: 'x/a.txt', data: text('a') }, { name: 'x/b.txt', data: Buffer.alloc(100_000, 3) }], { gzip: true });
    await fs.writeFile(path.join(cwd, 'cut.tgz'), gz.subarray(0, gz.length - 30));
    const done = await extract('cut.tgz', 'here');
    assert.equal(done.errorCode, 'ARCHIVE_CORRUPT');
    assert.deepEqual(await tree(cwd), ['cut.tgz']);
  });
});

test('FR-FOP-007 AC-6: ZIP names without the UTF-8 flag are decoded as UTF-8 when valid, else CP949; tar long names stay whole', async () => {
  await withExtract(async ({ cwd, extract }) => {
    await fs.writeFile(path.join(cwd, 'names.zip'), buildZip([
      { name: iconv.encode('한글/보고서.txt', 'cp949'), data: text('cp949') },
      { name: Buffer.from('한글/유니코드.txt', 'utf8'), data: text('utf8 no flag') },
      { name: '한글/플래그.txt', data: text('utf8 flag') },
    ]));
    const done = await extract('names.zip', 'smart');
    assert.equal(done.outcome, 'completed', JSON.stringify(done));
    assert.deepEqual(await tree(path.join(cwd, '한글')), ['보고서.txt', '유니코드.txt', '플래그.txt']);

    const longDir = `${'긴디렉터리이름'.repeat(6)}/${'b'.repeat(80)}`;
    const longName = `${longDir}/파일.txt`;
    assert.ok(Buffer.byteLength(longName) > 100);
    const gnuName = `gnu/${'g'.repeat(120)}.txt`;
    await fs.writeFile(path.join(cwd, 'long.tar'), await buildTar([
      { name: longName, data: text('pax') },
      // A GNU long name record followed by the entry whose own name field is cut.
      { name: '././@LongLink', type: 'gnu-long-path', data: Buffer.from(`${gnuName}\u0000`) },
      { name: gnuName.slice(0, 99), data: text('gnu') },
    ]));
    const tarDone = await extract('long.tar', 'here');
    assert.equal(tarDone.outcome, 'completed', JSON.stringify(tarDone));
    assert.equal(await fs.readFile(path.join(cwd, ...longName.split('/')), 'utf8'), 'pax');
    assert.equal(await fs.readFile(path.join(cwd, ...gnuName.split('/')), 'utf8'), 'gnu');
  });
});

test('FR-FOP-007 AC-7: file and folder modification times are restored; temp files are hidden upload temp names', async () => {
  await withExtract(async ({ cwd, extract }) => {
    const fileTime = new Date('2021-03-04T05:06:08Z');
    const dirTime = new Date('2020-01-02T03:04:06Z');
    await fs.writeFile(path.join(cwd, 'times.tar'), await buildTar([
      { name: 't/', type: 'directory', mtime: dirTime },
      { name: 't/f.txt', data: text('f'), mtime: fileTime },
    ]));
    const done = await extract('times.tar', 'smart');
    assert.equal(done.outcome, 'completed', JSON.stringify(done));
    assert.equal((await fs.stat(path.join(cwd, 't', 'f.txt'))).mtime.getTime(), fileTime.getTime());
    assert.equal((await fs.stat(path.join(cwd, 't'))).mtime.getTime(), dirTime.getTime());

    await fs.writeFile(path.join(cwd, 'dos.zip'), buildZip([{ name: 'dos/x.txt', data: text('x') }]));
    await extract('dos.zip', 'smart');
    const local = new Date(2024, 4, 6, 7, 8, 10);
    assert.equal((await fs.stat(path.join(cwd, 'dos', 'x.txt'))).mtime.getTime(), local.getTime(), 'DOS time as local time');
  });
});

test('FR-FOP-007 AC-7: cancelling during an entry deletes only its temp file and keeps the completed entries', async () => {
  let cancelled = false;
  const seenTemps: string[] = [];
  await withExtract(async ({ cwd, extract, registry }) => {
    await fs.writeFile(path.join(cwd, 'c.zip'), buildZip([
      { name: 'c/one.txt', data: text('one') },
      { name: 'c/two.txt', data: text('two') },
      { name: 'c/big.bin', data: Buffer.alloc(8 * 1024 * 1024, 9), method: 0 },
      { name: 'c/after.txt', data: text('never') },
    ]));
    const done = await extract('c.zip', 'smart');
    assert.equal(done.outcome, 'cancelled', JSON.stringify(done));
    assert.ok(cancelled);
    assert.ok(seenTemps.every((p) => isUploadTempName(path.basename(p))), 'hidden upload temp names');
    assert.deepEqual(await tree(path.join(cwd, 'c')), ['one.txt', 'two.txt']);
    await noTempFiles(cwd);
    assert.deepEqual(registry.list(), []);
  }, {
    onTempAdded: (tempPath, manager, jobId) => {
      seenTemps.push(tempPath);
      // The third file is being written: cancel now.
      if (seenTemps.length === 3 && !cancelled) {
        cancelled = true;
        setImmediate(() => manager.cancel(jobId()));
      }
    },
  });
});

test('FR-FOP-007 AC-1: a here extraction cancelled at a question keeps what was done and writes nothing more', async () => {
  await withExtract(async ({ cwd, extract }) => {
    await fs.writeFile(path.join(cwd, 'exists.txt'), 'old');
    await fs.writeFile(path.join(cwd, 'q.zip'), buildZip([
      { name: 'first.txt', data: text('1') },
      { name: 'exists.txt', data: text('new') },
      { name: 'last.txt', data: text('3') },
    ]));
    const done = await extract('q.zip', 'here', { onDecision: () => 'cancel' });
    assert.equal(done.outcome, 'cancelled');
    assert.deepEqual(await tree(cwd), ['exists.txt', 'first.txt', 'q.zip']);
    assert.equal(await fs.readFile(path.join(cwd, 'exists.txt'), 'utf8'), 'old');
  });
});

test('FR-FOP-007 AC-4: a small archive that unpacks to under 64 MiB extracts whatever its ratio', async () => {
  await withExtract(async ({ cwd, extract }) => {
    const zeros = Buffer.alloc(8 * 1024 * 1024);
    const archive = buildZip([{ name: 'zeros/z.bin', data: zeros }]);
    assert.ok(zeros.length / archive.length > 1000, `the fixture is over 1000x (${zeros.length / archive.length})`);
    await fs.writeFile(path.join(cwd, 'zeros.zip'), archive);
    const done = await extract('zeros.zip', 'smart');
    assert.equal(done.outcome, 'completed', JSON.stringify(done));
    assert.equal((await fs.stat(path.join(cwd, 'zeros', 'z.bin'))).size, zeros.length);
  });
});

test('FR-FOP-007 AC-4: over 64 MiB unpacked and over 1000x is refused; exactly 64 MiB is not judged by ratio', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bg-ratio-'));
  try {
    const limits = { maxExtractBytes: 10 * 1024 ** 3, maxExtractEntries: 100 };
    const over = path.join(dir, 'over.zip');
    await fs.writeFile(over, buildZip([{ name: 'a.bin', data: text('tiny'), declaredSize: 64 * 1024 * 1024 + 1 }]));
    await assert.rejects(precountArchive(over, limits), (err: unknown) => (err as { code?: string }).code === 'ARCHIVE_TOO_LARGE' && /ratio/.test(String((err as { publicReason?: string }).publicReason)));
    const at = path.join(dir, 'at.zip');
    await fs.writeFile(at, buildZip([{ name: 'a.bin', data: text('tiny'), declaredSize: 64 * 1024 * 1024 }]));
    assert.equal((await precountArchive(at, limits)).unpackedBytes, 64 * 1024 * 1024);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('FR-FOP-007 AC-2: an entry name over 4096 bytes is refused; the skipped list keeps 1000 names cut to 512 characters and counts the rest', async () => {
  await withExtract(async ({ cwd, extract }) => {
    const long = `${'n'.repeat(5000)}.txt`;
    const entries: ZipFixtureEntry[] = [{ name: long, data: text('long') }];
    for (let i = 0; i < 1100; i += 1) entries.push({ name: `../slip${i}.txt`, data: text('x') });
    entries.push({ name: 'ok.txt', data: text('ok') });
    await fs.writeFile(path.join(cwd, 'many.zip'), buildZip(entries));
    const done = await extract('many.zip', 'here');
    assert.equal(done.outcome, 'completed', JSON.stringify({ ...done, skipped: done.skipped?.length }));
    assert.equal(done.skipped?.length, 1000);
    assert.equal(done.skippedCount, 1101);
    assert.equal(done.skipped?.[0].reason, 'entry name is not allowed');
    assert.equal(done.skipped?.[0].path.length, 512);
    assert.equal(await fs.readFile(path.join(cwd, 'ok.txt'), 'utf8'), 'ok');
  });
});

test('FR-FOP-007 AC-4: the write pass stops when the archive holds more entries or bytes than the pre-count found', async () => {
  let swapTo: Buffer | null = null;
  await withExtract(async ({ cwd, extract, registry }) => {
    await fs.writeFile(path.join(cwd, 'grow.zip'), buildZip([{ name: 'g/a.txt', data: text('a') }]));
    swapTo = buildZip([{ name: 'g/a.txt', data: text('a') }, { name: 'g/b.txt', data: text('b') }, { name: 'g/c.txt', data: text('c') }]);
    const more = await extract('grow.zip', 'smart');
    assert.equal(more.outcome, 'failed');
    assert.equal(more.errorCode, 'ARCHIVE_TOO_LARGE');

    await fs.writeFile(path.join(cwd, 'fat.zip'), buildZip([{ name: 'f/a.txt', data: text('a') }]));
    swapTo = buildZip([{ name: 'f/a.txt', data: Buffer.alloc(100_000, 0x61) }]);
    const bigger = await extract('fat.zip', 'smart');
    assert.equal(bigger.outcome, 'failed');
    assert.equal(bigger.errorCode, 'ARCHIVE_TOO_LARGE');
    await noTempFiles(cwd);
    assert.deepEqual(registry.list(), []);
  }, {
    afterPrecount: async (archivePath) => {
      if (swapTo !== null) await fs.writeFile(archivePath, swapTo);
    },
  });
});

test('FR-FOP-007 AC-4: every entry\'s declared size counts toward the limits, links included', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bg-linksize-'));
  try {
    const archive = path.join(dir, 'l.zip');
    await fs.writeFile(archive, buildZip([{ name: 'l/link', data: Buffer.alloc(3 * 1024 * 1024, 0x2f), unixMode: 0o120777 }]));
    await assert.rejects(precountArchive(archive, { maxExtractBytes: 2 * 1024 * 1024, maxExtractEntries: 10 }), (err: unknown) => (err as { code?: string }).code === 'ARCHIVE_TOO_LARGE');
    const counted = await precountArchive(archive, { maxExtractBytes: 10 * 1024 * 1024, maxExtractEntries: 10 });
    assert.equal(counted.unpackedBytes, 3 * 1024 * 1024);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('FR-FOP-007 AC-4: an aborted pre-count stops with AbortError', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bg-abort-'));
  try {
    const archive = path.join(dir, 'a.zip');
    await fs.writeFile(archive, buildZip([{ name: 'a.txt', data: text('a') }]));
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(precountArchive(archive, { maxExtractBytes: 1e9, maxExtractEntries: 10 }, undefined, controller.signal), (err: unknown) => (err as Error).name === 'AbortError');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
