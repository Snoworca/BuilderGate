import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import type { Stats } from 'fs';
import { FileService } from './FileService.js';
import type { DirectoryEntry } from '../types/file.types.js';
import { isFileJobTempName } from './fileJobs/fileJobRunner.js';

// Design decision 24: listing a large folder spent almost all its time in one
// fs.stat after another (4983 entries: readdir 3.9ms, stat 286ms). The stats
// are independent, so they run in bounded batches — bounded because an
// unbounded Promise.all over maxDirectoryEntries (10000) would open that many
// libuv requests at once and starve every other fs call in the server.
// The cap asserted here is the upper bound decision 24 allows, not the exact
// value the service picks, so tuning the pool size does not break the test.
const MAX_ALLOWED_IN_FLIGHT = 64;

function listingService(initialCwd: string, maxDirectoryEntries = 10000): FileService {
  return new FileService({
    getSession: () => ({ id: 'session-1' }),
    getPtyPid: () => null,
    getInitialCwd: () => initialCwd,
    getCwdFilePath: () => null,
  }, {
    maxFileSize: 1024,
    maxDirectoryEntries,
    blockedExtensions: [],
    blockedPaths: [],
    cwdCacheTtlMs: 1000,
  });
}

async function withTempDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'buildergate-list-concurrency-'));
  try {
    await body(dir);
  } finally {
    mock.restoreAll();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// The sequential algorithm as it stood before decision 24, kept as the oracle
// for "observable behavior is identical". '..' is compared without its
// modified field, which is the clock at call time in both versions.
async function referenceListing(dirPath: string, maxDirectoryEntries: number): Promise<{ entries: DirectoryEntry[]; totalEntries: number }> {
  const dirents = (await fs.readdir(dirPath, { withFileTypes: true })).filter(d => !isFileJobTempName(d.name));
  const belowRoot = path.parse(dirPath).root !== dirPath;
  const entries: DirectoryEntry[] = [];
  if (belowRoot) entries.push({ name: '..', type: 'directory', size: 0, modified: '' });
  for (const dirent of dirents.slice(0, maxDirectoryEntries)) {
    try {
      const st = await fs.stat(path.join(dirPath, dirent.name));
      const ext = path.extname(dirent.name).toLowerCase();
      const entry: DirectoryEntry = {
        name: dirent.name,
        type: dirent.isDirectory() ? 'directory' : 'file',
        size: st.size,
        modified: st.mtime.toISOString(),
      };
      if (!dirent.isDirectory() && ext) entry.extension = ext;
      entries.push(entry);
    } catch {
      // skipped, as the service does
    }
  }
  entries.sort((a, b) => {
    if (a.name === '..') return -1;
    if (b.name === '..') return 1;
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
  return { entries, totalEntries: dirents.length + (belowRoot ? 1 : 0) };
}

function withoutParentClock(entries: DirectoryEntry[]): DirectoryEntry[] {
  return entries.map(e => (e.name === '..' ? { ...e, modified: '' } : e));
}

test('listDirectory stats entries concurrently, never more than the cap at once', async () => {
  await withTempDir(async dir => {
    const count = 200;
    await Promise.all(Array.from({ length: count }, (_, i) => fs.writeFile(path.join(dir, `f${String(i).padStart(3, '0')}.txt`), 'x')));

    const realStat = fs.stat.bind(fs);
    let inFlight = 0;
    let maxInFlight = 0;
    let entryStats = 0;
    mock.method(fs, 'stat', async (p: string, ...rest: unknown[]): Promise<Stats> => {
      if (path.dirname(String(p)) !== dir) return realStat(p, ...(rest as []));
      entryStats += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        // Hold each stat open long enough that a pool, if there is one, fills up.
        await new Promise(resolve => setTimeout(resolve, 2));
        return await realStat(p, ...(rest as []));
      } finally {
        inFlight -= 1;
      }
    });

    const listing = await listingService(dir).listDirectory('session-1', '.');

    console.log(`entryStats=${entryStats} maxInFlight=${maxInFlight}`);
    assert.equal(entryStats, count, 'every entry is stat-ed exactly once');
    assert.equal(listing.entries.length, count + 1);
    assert.ok(maxInFlight > 1, `stats ran one at a time (maxInFlight=${maxInFlight})`);
    assert.ok(maxInFlight <= MAX_ALLOWED_IN_FLIGHT, `stats were not bounded (maxInFlight=${maxInFlight})`);
  });
});

test('listDirectory output matches the sequential reference on files, dirs and links', async () => {
  await withTempDir(async dir => {
    await fs.writeFile(path.join(dir, 'B.txt'), 'bb');
    await fs.writeFile(path.join(dir, 'a.md'), 'a');
    await fs.writeFile(path.join(dir, 'noext'), 'nnn');
    await fs.writeFile(path.join(dir, '.bg-part-0123456789abcdef'), 'temp');
    await fs.mkdir(path.join(dir, 'zdir'));
    await fs.mkdir(path.join(dir, 'Adir'));
    await fs.writeFile(path.join(dir, 'zdir', 'inner.txt'), 'inner');
    // Junctions need no privilege on Windows; a junction is a link, so its
    // dirent is not a directory while its stat follows to the target.
    await fs.symlink(path.join(dir, 'zdir'), path.join(dir, 'link-to-dir'), 'junction');
    // A link whose target is gone fails to stat and is skipped.
    await fs.mkdir(path.join(dir, 'gone'));
    await fs.symlink(path.join(dir, 'gone'), path.join(dir, 'dangling'), 'junction');
    await fs.rm(path.join(dir, 'gone'), { recursive: true });
    try {
      await fs.symlink(path.join(dir, 'a.md'), path.join(dir, 'link-to-file.md'), 'file');
    } catch {
      // File symlinks need Developer Mode or admin on Windows; the junctions cover links.
    }

    const listing = await listingService(dir).listDirectory('session-1', '.');
    const reference = await referenceListing(dir, 10000);

    assert.deepEqual(withoutParentClock(listing.entries), reference.entries);
    assert.equal(listing.totalEntries, reference.totalEntries);
    assert.equal(listing.entries.some(e => e.name === 'dangling'), false);
    assert.equal(listing.entries.some(e => e.name.startsWith('.bg-part-0123')), false);
  });
});

test('listDirectory skips an entry deleted between readdir and stat, and keeps the rest in order', async () => {
  await withTempDir(async dir => {
    for (const name of ['a.txt', 'b.txt', 'c.txt', 'd.txt']) await fs.writeFile(path.join(dir, name), name);

    const realStat = fs.stat.bind(fs);
    const victim = path.join(dir, 'b.txt');
    mock.method(fs, 'stat', async (p: string, ...rest: unknown[]): Promise<Stats> => {
      if (String(p) === victim) await fs.rm(victim, { force: true });
      return realStat(p, ...(rest as []));
    });

    const listing = await listingService(dir).listDirectory('session-1', '.');

    assert.deepEqual(listing.entries.map(e => e.name), ['..', 'a.txt', 'c.txt', 'd.txt']);
    // totalEntries is what readdir saw, the deleted entry included.
    assert.equal(listing.totalEntries, 5);
  });
});

test('listDirectory truncates to maxDirectoryEntries after the temp-name filter, like the reference', async () => {
  await withTempDir(async dir => {
    await fs.writeFile(path.join(dir, '.bg-part-00000000000000aa'), 'temp');
    for (let i = 0; i < 10; i++) await fs.writeFile(path.join(dir, `n${i}.txt`), 'x'.repeat(i));

    const listing = await listingService(dir, 4).listDirectory('session-1', '.');
    const reference = await referenceListing(dir, 4);

    assert.deepEqual(withoutParentClock(listing.entries), reference.entries);
    assert.equal(listing.entries.length, 5, "'..' plus the four kept entries");
    assert.equal(listing.totalEntries, 11, "ten files plus '..'; the temp file is not counted");
  });
});
