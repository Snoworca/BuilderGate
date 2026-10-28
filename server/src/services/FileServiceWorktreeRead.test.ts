/**
 * SEC-FOP-002: files in another worktree of the session folder's repository are
 * readable (stat, read, read-image, HTML view) and nothing else.
 *
 * The fixture is the layout agents actually make: the main worktree `d` and a
 * sibling worktree `d-1` created by `git worktree add ../d-1`, plus an
 * unrelated sibling folder that must stay out of reach.
 *
 * server/src/test-runner.ts does not discover *.test.ts; run per-file with
 * `npx tsx --test src/services/FileServiceWorktreeRead.test.ts` from server/.
 */

import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs/promises';
import { readFileSync } from 'fs';
import { FileService } from './FileService.js';
import { listWorktreeRoots } from './worktreeRoots.js';
import { AppError, ErrorCode } from '../utils/errors.js';
import type { FileManagerConfig } from '../types/file.types.js';
import { initRepo, tempRoot } from './git/testRepo.js';

const SESSION_ID = 'session-worktree-1';

const CONFIG: FileManagerConfig = {
  maxFileSize: 1048576,
  maxDirectoryEntries: 10000,
  blockedExtensions: ['.exe'],
  blockedPaths: ['.ssh'],
  cwdCacheTtlMs: 60_000,
};

// A 1x1 PNG.
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c40000000049454e44ae426082', 'hex');

interface Fixture {
  root: string;
  main: string;
  sibling: string;
  other: string;
  serviceAt: (cwd: string) => FileService;
}

async function makeFixture(t: TestContext): Promise<Fixture> {
  const temp = tempRoot();
  t.after(temp.cleanup);
  const root = await fs.realpath(temp.root);
  const main = path.join(root, 'd');
  const repo = initRepo(main);
  repo.commit('init', { 'README.md': '# main\n' });
  repo.git('worktree', 'add', '-q', '-b', 'wt1', '../d-1');
  const sibling = path.join(root, 'd-1');
  const other = path.join(root, 'other');
  await fs.mkdir(path.join(sibling, 'docs'), { recursive: true });
  await fs.writeFile(path.join(sibling, 'docs', 'design.html'), '<h1>design</h1>');
  await fs.writeFile(path.join(sibling, 'notes.md'), '# notes\n');
  await fs.writeFile(path.join(sibling, 'pixel.png'), PNG);
  await fs.writeFile(path.join(sibling, 'tool.exe'), 'MZ');
  await fs.mkdir(path.join(sibling, '.ssh'));
  await fs.writeFile(path.join(sibling, '.ssh', 'key.md'), 'secret');
  await fs.mkdir(other);
  await fs.writeFile(path.join(other, 'x.md'), 'x');
  const serviceAt = (cwd: string): FileService => new FileService({
    getSession: (id: string): unknown => (id === SESSION_ID ? { id } : null),
    getPtyPid: (): number | null => null,
    getInitialCwd: (): string | null => cwd,
    getCwdFilePath: (): string | null => null,
  }, CONFIG);
  return { root, main, sibling, other, serviceAt };
}

async function rejectsWith(promise: Promise<unknown>, code: ErrorCode): Promise<void> {
  await assert.rejects(promise, (err: unknown) => err instanceof AppError && err.code === code);
}

test('SEC-FOP-002 AC-1: the worktree list is the main worktree plus every registered linked worktree, from either side', async (t) => {
  const f = await makeFixture(t);
  const fromMain = (await listWorktreeRoots(f.main)).map((p) => p.toLowerCase()).sort();
  const fromSibling = (await listWorktreeRoots(f.sibling)).map((p) => p.toLowerCase()).sort();
  const expected = [f.main, f.sibling].map((p) => p.toLowerCase()).sort();
  assert.deepEqual(fromMain, expected);
  assert.deepEqual(fromSibling, expected);
  // A subfolder of a worktree finds the same repository.
  assert.deepEqual((await listWorktreeRoots(path.join(f.sibling, 'docs'))).map((p) => p.toLowerCase()).sort(), expected);
  assert.deepEqual(await listWorktreeRoots(f.other), []);
});

test('SEC-FOP-002 AC-1: the list is built from files, never by running git', () => {
  const source = readFileSync(new URL('./worktreeRoots.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /child_process|execFile|spawn\(/);
});

test('SEC-FOP-002 AC-2: stat, read and read-image reach a sibling worktree; an unrelated sibling folder stays refused', async (t) => {
  const f = await makeFixture(t);
  const service = f.serviceAt(f.main);
  const notes = path.join(f.sibling, 'notes.md');
  assert.equal((await service.statPath(SESSION_ID, notes)).kind, 'file');
  assert.equal((await service.readFile(SESSION_ID, notes)).content, '# notes\n');
  assert.equal((await service.readImageFile(SESSION_ID, path.join(f.sibling, 'pixel.png'))).mimeType, 'image/png');
  // Relative spelling from the session folder reaches it too.
  assert.equal((await service.readFile(SESSION_ID, '../d-1/notes.md')).content, '# notes\n');
  await rejectsWith(service.statPath(SESSION_ID, path.join(f.other, 'x.md')), ErrorCode.PATH_TRAVERSAL);
  await rejectsWith(service.readFile(SESSION_ID, path.join(f.other, 'x.md')), ErrorCode.PATH_TRAVERSAL);
});

test('SEC-FOP-002 AC-2: a session standing in the linked worktree reads the main worktree', async (t) => {
  const f = await makeFixture(t);
  const service = f.serviceAt(f.sibling);
  assert.equal((await service.readFile(SESSION_ID, path.join(f.main, 'README.md'))).content, '# main\n');
});

test('SEC-FOP-002 AC-3: writes, listing, download and the MCP inspect path keep the session folder boundary', async (t) => {
  const f = await makeFixture(t);
  const service = f.serviceAt(f.main);
  const notes = path.join(f.sibling, 'notes.md');
  await rejectsWith(service.writeFile(SESSION_ID, notes, 'overwritten'), ErrorCode.PATH_TRAVERSAL);
  await rejectsWith(service.listDirectory(SESSION_ID, f.sibling), ErrorCode.PATH_TRAVERSAL);
  await rejectsWith(service.inspectPath(SESSION_ID, notes), ErrorCode.PATH_TRAVERSAL);
  await rejectsWith(service.resolveDownload(SESSION_ID, notes), ErrorCode.PATH_TRAVERSAL);
  assert.equal(await fs.readFile(notes, 'utf8'), '# notes\n');
});

test('SEC-FOP-002 AC-10: the MCP editor open check reaches a sibling worktree with the read rules; the write check does not', async (t) => {
  const f = await makeFixture(t);
  const service = f.serviceAt(f.main);
  const design = path.join(f.sibling, 'docs', 'design.html');
  const opened = await service.inspectReadablePath(SESSION_ID, design);
  assert.equal(opened.path.toLowerCase(), design.toLowerCase());
  assert.equal(opened.exists, true);
  assert.equal(opened.isFile, true);
  assert.equal((await service.inspectReadablePath(SESSION_ID, '../d-1/notes.md')).isFile, true);
  // A missing file in the worktree is reported as missing, not refused.
  assert.equal((await service.inspectReadablePath(SESSION_ID, path.join(f.sibling, 'missing.md'))).exists, false);
  // Inside the session folder it answers as before.
  assert.equal((await service.inspectReadablePath(SESSION_ID, 'README.md')).isFile, true);
  await rejectsWith(service.inspectReadablePath(SESSION_ID, path.join(f.other, 'x.md')), ErrorCode.PATH_TRAVERSAL);
  await rejectsWith(service.inspectReadablePath(SESSION_ID, path.join(f.sibling, '.ssh', 'key.md')), ErrorCode.PATH_BLOCKED);
  await rejectsWith(service.inspectReadablePath(SESSION_ID, path.join(f.sibling, 'tool.exe')), ErrorCode.PATH_BLOCKED);
  // The check used before saving content keeps the session folder boundary.
  await rejectsWith(service.inspectPath(SESSION_ID, design), ErrorCode.PATH_TRAVERSAL);
});

test('SEC-FOP-002 AC-4: blocked paths, blocked extensions and links leaving the worktree are refused there too', async (t) => {
  const f = await makeFixture(t);
  const service = f.serviceAt(f.main);
  await rejectsWith(service.readFile(SESSION_ID, path.join(f.sibling, '.ssh', 'key.md')), ErrorCode.PATH_BLOCKED);
  await rejectsWith(service.readFile(SESSION_ID, path.join(f.sibling, 'tool.exe')), ErrorCode.PATH_BLOCKED);
  const link = path.join(f.sibling, 'escape');
  try {
    await fs.symlink(f.other, link, 'junction');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EPERM') {
      t.skip('symlink needs privilege on this host (EPERM)');
      return;
    }
    throw err;
  }
  await rejectsWith(service.readFile(SESSION_ID, path.join(link, 'x.md')), ErrorCode.PATH_TRAVERSAL);
  await rejectsWith(service.statPath(SESSION_ID, path.join(link, 'x.md')), ErrorCode.PATH_TRAVERSAL);
});

test('SEC-FOP-002 AC-5: a file in another worktree reports which worktree; a file in the session folder does not', async (t) => {
  const f = await makeFixture(t);
  const service = f.serviceAt(f.main);
  const notes = path.join(f.sibling, 'notes.md');
  const read = await service.readFile(SESSION_ID, notes);
  assert.equal(read.worktree?.name, 'd-1');
  assert.equal(read.worktree?.root.toLowerCase(), f.sibling.toLowerCase());
  const stat = await service.statPath(SESSION_ID, notes);
  assert.equal(stat.worktree?.name, 'd-1');
  assert.equal((await service.readFile(SESSION_ID, 'README.md')).worktree, undefined);
  assert.equal((await service.statPath(SESSION_ID, 'README.md')).worktree, undefined);
});

test('SEC-FOP-002 AC-7: an HTML view of a worktree file is scoped to that worktree, one in the session folder to the session folder', async (t) => {
  const f = await makeFixture(t);
  const service = f.serviceAt(f.main);
  const design = await service.resolveHtmlViewSource(SESSION_ID, path.join(f.sibling, 'docs', 'design.html'));
  assert.equal(design.root.toLowerCase(), f.sibling.toLowerCase());
  assert.equal(design.path.toLowerCase(), path.join(f.sibling, 'docs', 'design.html').toLowerCase());
  await fs.writeFile(path.join(f.main, 'page.html'), '<p>main</p>');
  const local = await service.resolveHtmlViewSource(SESSION_ID, 'page.html');
  assert.equal(local.root.toLowerCase(), f.main.toLowerCase());
  await rejectsWith(service.resolveHtmlViewSource(SESSION_ID, path.join(f.other, 'x.md')), ErrorCode.PATH_TRAVERSAL);
});

test('SEC-FOP-002 AC-8: a path starting with ~ resolves against the home folder and still meets the boundary', async (t) => {
  const f = await makeFixture(t);
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = f.root;
  process.env.USERPROFILE = f.root;
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const service = f.serviceAt(f.main);
  assert.equal((await service.readFile(SESSION_ID, '~\\d-1\\notes.md')).content, '# notes\n');
  assert.equal((await service.statPath(SESSION_ID, '~/d/README.md')).kind, 'file');
  await rejectsWith(service.readFile(SESSION_ID, '~/other/x.md'), ErrorCode.PATH_TRAVERSAL);
});

test('SEC-FOP-002 AC-9: the worktree list is cached per session for the cwd cache TTL', async (t) => {
  const f = await makeFixture(t);
  const service = f.serviceAt(f.main);
  const notes = path.join(f.sibling, 'notes.md');
  await service.readFile(SESSION_ID, notes);
  // Unregister the worktree behind the service's back; inside the TTL the cached list still answers.
  await fs.rm(path.join(f.main, '.git', 'worktrees', 'd-1'), { recursive: true, force: true });
  assert.equal((await service.readFile(SESSION_ID, notes)).content, '# notes\n');
  // A fresh service (no cache) reads the registry again and refuses.
  await rejectsWith(f.serviceAt(f.main).readFile(SESSION_ID, notes), ErrorCode.PATH_TRAVERSAL);
});
