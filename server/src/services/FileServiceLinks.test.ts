/**
 * FileService operations on links: validation vs. the entry acted on.
 *
 * The path validator judges a path by its real location (so a link cannot
 * smuggle an operation outside the cwd or into a blocked directory). But
 * delete and move must act on the entry the user named — the link itself —
 * never on what it points to. Deleting a junction must not empty its target
 * folder; moving a link must not move its target.
 *
 * Directory links are junctions (no privilege needed on Windows). If the host
 * still refuses with EPERM the case skips with that reason.
 *
 * server/src/test-runner.ts does not discover *.test.ts; run per-file with
 * `npx tsx --test src/services/FileServiceLinks.test.ts` from server/.
 */

import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { FileService } from './FileService.js';
import { AppError, ErrorCode } from '../utils/errors.js';
import type { FileManagerConfig } from '../types/file.types.js';

const SESSION_ID = 'session-links-1';

const CONFIG: FileManagerConfig = {
  maxFileSize: 1048576,
  maxDirectoryEntries: 10000,
  blockedExtensions: [],
  blockedPaths: ['.ssh'],
  cwdCacheTtlMs: 1000,
};

interface Fixture {
  root: string;
  cwd: string;
  outside: string;
  service: FileService;
}

async function makeFixture(t: TestContext): Promise<Fixture> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'buildergate-file-links-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'cwd');
  const outside = path.join(root, 'outside');
  await fs.mkdir(cwd);
  await fs.mkdir(outside);
  const sessionManager = {
    getSession: (id: string): unknown => (id === SESSION_ID ? { id } : null),
    getPtyPid: (): number | null => null,
    getInitialCwd: (): string | null => cwd,
    getCwdFilePath: (): string | null => null,
  };
  return { root, cwd, outside, service: new FileService(sessionManager, CONFIG) };
}

/** Create a directory junction; on EPERM skip with the reason and return false. */
async function junction(t: TestContext, target: string, linkPath: string): Promise<boolean> {
  try {
    await fs.symlink(target, linkPath, 'junction');
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EPERM') {
      t.skip('symlink needs privilege on this host (EPERM)');
      return false;
    }
    throw err;
  }
}

/** A folder inside the cwd with two files, and a junction in the cwd pointing at it. */
async function inCwdTargetWithLink(t: TestContext, f: Fixture): Promise<{ target: string; link: string } | null> {
  const target = path.join(f.cwd, 'target');
  await fs.mkdir(target);
  await fs.writeFile(path.join(target, 'a.txt'), 'A');
  await fs.writeFile(path.join(target, 'b.txt'), 'B');
  const link = path.join(f.cwd, 'link');
  if (!(await junction(t, target, link))) return null;
  return { target, link };
}

async function exists(p: string): Promise<boolean> {
  return fs.lstat(p).then(() => true, () => false);
}

function isAppError(code: ErrorCode) {
  return (err: unknown): boolean => err instanceof AppError && err.code === code;
}

test('deleteFile on a junction to an in-cwd folder removes only the junction; the target and its files stay', async (t) => {
  const f = await makeFixture(t);
  const made = await inCwdTargetWithLink(t, f);
  if (!made) return;

  await f.service.deleteFile(SESSION_ID, 'link');

  assert.equal(await exists(made.link), false, 'the junction itself must be gone');
  assert.equal(await exists(made.target), true, 'the target folder must still exist');
  assert.deepEqual((await fs.readdir(made.target)).sort(), ['a.txt', 'b.txt'], 'the target files must be untouched');
});

test('moveFile of a junction moves the link itself; the target folder is untouched', async (t) => {
  const f = await makeFixture(t);
  const made = await inCwdTargetWithLink(t, f);
  if (!made) return;

  await f.service.moveFile(SESSION_ID, 'link', 'renamed-link');

  const moved = path.join(f.cwd, 'renamed-link');
  assert.equal(await exists(made.link), false, 'the old link name must be gone');
  assert.equal((await fs.lstat(moved)).isSymbolicLink(), true, 'the destination must still be a link');
  assert.equal(await fs.realpath(moved), made.target, 'the moved link must still point at the target');
  assert.equal((await fs.lstat(made.target)).isDirectory(), true, 'the target folder must not have moved');
  assert.deepEqual((await fs.readdir(made.target)).sort(), ['a.txt', 'b.txt']);
});

test('a junction whose target is outside the cwd is still refused for delete and move (security pin)', async (t) => {
  const f = await makeFixture(t);
  await fs.writeFile(path.join(f.outside, 'keep.txt'), 'K');
  if (!(await junction(t, f.outside, path.join(f.cwd, 'out-link')))) return;

  await assert.rejects(f.service.deleteFile(SESSION_ID, 'out-link'), isAppError(ErrorCode.PATH_TRAVERSAL));
  await assert.rejects(f.service.moveFile(SESSION_ID, 'out-link', 'moved'), isAppError(ErrorCode.PATH_TRAVERSAL));
  assert.equal(await exists(path.join(f.cwd, 'out-link')), true);
  assert.equal(await exists(path.join(f.outside, 'keep.txt')), true);
});

test('a link that lives outside the cwd (reached through a parent junction) is refused even if it points back inside', async (t) => {
  // cwd/ext -> outside ; outside/back -> cwd/target. The real location of
  // 'ext/back' is inside the cwd, but the entry that delete would remove is
  // outside/back — outside the cwd — so the operation must be refused.
  const f = await makeFixture(t);
  const target = path.join(f.cwd, 'target');
  await fs.mkdir(target);
  await fs.writeFile(path.join(target, 'a.txt'), 'A');
  if (!(await junction(t, f.outside, path.join(f.cwd, 'ext')))) return;
  if (!(await junction(t, target, path.join(f.outside, 'back')))) return;

  await assert.rejects(f.service.deleteFile(SESSION_ID, 'ext/back'), isAppError(ErrorCode.PATH_TRAVERSAL));
  await assert.rejects(f.service.moveFile(SESSION_ID, 'ext/back', 'moved'), isAppError(ErrorCode.PATH_TRAVERSAL));
  assert.equal(await exists(path.join(f.outside, 'back')), true);
  assert.equal(await exists(path.join(target, 'a.txt')), true);
});

test('a junction into a blocked directory is still refused for delete', async (t) => {
  const f = await makeFixture(t);
  await fs.mkdir(path.join(f.cwd, '.ssh'));
  await fs.writeFile(path.join(f.cwd, '.ssh', 'id'), 'secret');
  if (!(await junction(t, path.join(f.cwd, '.ssh'), path.join(f.cwd, 'keys')))) return;

  await assert.rejects(f.service.deleteFile(SESSION_ID, 'keys'), isAppError(ErrorCode.PATH_BLOCKED));
  assert.equal(await exists(path.join(f.cwd, '.ssh', 'id')), true);
});

test('regression: ordinary file and folder delete and move still work', async (t) => {
  const f = await makeFixture(t);
  await fs.writeFile(path.join(f.cwd, 'f.txt'), 'F');
  await fs.mkdir(path.join(f.cwd, 'dir'));
  await fs.writeFile(path.join(f.cwd, 'dir', 'inner.txt'), 'I');

  await f.service.moveFile(SESSION_ID, 'f.txt', 'g.txt');
  assert.equal(await fs.readFile(path.join(f.cwd, 'g.txt'), 'utf-8'), 'F');
  assert.equal(await exists(path.join(f.cwd, 'f.txt')), false);

  await f.service.moveFile(SESSION_ID, 'dir', 'dir2');
  assert.equal(await fs.readFile(path.join(f.cwd, 'dir2', 'inner.txt'), 'utf-8'), 'I');

  await f.service.deleteFile(SESSION_ID, 'g.txt');
  assert.equal(await exists(path.join(f.cwd, 'g.txt')), false);

  await f.service.deleteFile(SESSION_ID, 'dir2');
  assert.equal(await exists(path.join(f.cwd, 'dir2')), false);
});

test('copyFile through a junction to an in-cwd folder copies the content, leaving the link and target intact', async (t) => {
  const f = await makeFixture(t);
  const made = await inCwdTargetWithLink(t, f);
  if (!made) return;

  await f.service.copyFile(SESSION_ID, 'link', 'copy');

  const copy = path.join(f.cwd, 'copy');
  assert.equal((await fs.lstat(copy)).isDirectory(), true, 'the copy is a real folder, not a link');
  assert.deepEqual((await fs.readdir(copy)).sort(), ['a.txt', 'b.txt']);
  assert.equal((await fs.lstat(made.link)).isSymbolicLink(), true);
  assert.deepEqual((await fs.readdir(made.target)).sort(), ['a.txt', 'b.txt']);
});

// RC2-002: delete·move 가 대상이 세션 루트 자신인지 보지 않았다. deleteFile('.') 은 cwd 를 통째로 지웠고(프로젝트 소실),
// cwd 가 junction 이면 부모 디렉터리의 링크를 지웠으며, moveFile('.', 'x') 는 자기 자신을 가리키는 순환 링크를 만들었다.
// 파일 작업(fileJobRoutes)과 같은 공용 판정으로 거부해야 한다.

/** cwd 가 root/proj 를 가리키는 junction(root/proj-link)인 서비스. 만들 수 없으면 null. */
async function makeLinkCwdFixture(t: TestContext): Promise<{ target: string; link: string; service: FileService } | null> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'buildergate-file-rootlink-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'proj');
  await fs.mkdir(target);
  await fs.writeFile(path.join(target, 'keep.txt'), 'K');
  const link = path.join(root, 'proj-link');
  if (!(await junction(t, target, link))) return null;
  const sessionManager = {
    getSession: (id: string): unknown => (id === SESSION_ID ? { id } : null),
    getPtyPid: (): number | null => null,
    getInitialCwd: (): string | null => link,
    getCwdFilePath: (): string | null => null,
  };
  return { target, link, service: new FileService(sessionManager, CONFIG) };
}

// @req SEC-FOP-001
// @req FR-FOP-002
test('deleteFile·moveFile refuse the session folder itself (normal cwd); the project files survive', async (t) => {
  const f = await makeFixture(t);
  await fs.writeFile(path.join(f.cwd, 'keep.txt'), 'K');

  for (const spelling of ['.', f.cwd, path.join(f.cwd, 'sub', '..'), `${f.cwd}${path.sep}`]) {
    await assert.rejects(f.service.deleteFile(SESSION_ID, spelling), isAppError(ErrorCode.INVALID_INPUT), `delete ${spelling}`);
    await assert.rejects(f.service.moveFile(SESSION_ID, spelling, 'moved'), isAppError(ErrorCode.INVALID_INPUT), `move ${spelling}`);
  }
  assert.equal(await fs.readFile(path.join(f.cwd, 'keep.txt'), 'utf-8'), 'K');
  assert.equal(await exists(path.join(f.cwd, 'moved')), false);
  // 대조군: 루트 아래 항목은 여전히 지워진다.
  await f.service.deleteFile(SESSION_ID, 'keep.txt');
  assert.equal(await exists(path.join(f.cwd, 'keep.txt')), false);
});

// @req SEC-FOP-001
// @req FR-FOP-002
test('deleteFile·moveFile refuse the session folder itself when the cwd is a junction; the link and its target survive', async (t) => {
  const f = await makeLinkCwdFixture(t);
  if (!f) return;

  await assert.rejects(f.service.deleteFile(SESSION_ID, '.'), isAppError(ErrorCode.INVALID_INPUT));
  await assert.rejects(f.service.deleteFile(SESSION_ID, f.link), isAppError(ErrorCode.INVALID_INPUT));
  await assert.rejects(f.service.moveFile(SESSION_ID, '.', 'x'), isAppError(ErrorCode.INVALID_INPUT));
  assert.equal((await fs.lstat(f.link)).isSymbolicLink(), true, 'the cwd link must still exist');
  assert.equal(await fs.readFile(path.join(f.target, 'keep.txt'), 'utf-8'), 'K');
  assert.deepEqual(await fs.readdir(f.target), ['keep.txt'], 'no cycle link may have been created inside the target');
});

// 루트 판정은 "루트를 가리키는 링크" 가 아니라 "루트라는 항목" 을 본다 — 세션 안에서 루트를 가리키는 링크를 지우면
// 링크만 사라지므로 막을 이유가 없다.
// @req FR-FOP-002
test('a junction inside the cwd that points at the cwd itself can still be deleted; only the link goes', async (t) => {
  const f = await makeFixture(t);
  await fs.writeFile(path.join(f.cwd, 'keep.txt'), 'K');
  if (!(await junction(t, f.cwd, path.join(f.cwd, 'self')))) return;

  await f.service.deleteFile(SESSION_ID, 'self');
  assert.equal(await exists(path.join(f.cwd, 'self')), false);
  assert.equal(await fs.readFile(path.join(f.cwd, 'keep.txt'), 'utf-8'), 'K');
});
