// FR-FEX-019 — on a Windows host a WSL mount path (/mnt/<drive>/...) names the Windows directory.
//
// A WSL tab reports its directory as a Linux path and the explorer sends it back. On Windows
// path.resolve('C:\\work', '/mnt/c/work') is C:\\mnt\\c\\work, outside the session root, so every
// request was refused with PATH_TRAVERSAL and the explorer stayed empty.
//
// server/src/test-runner.ts 는 *.test.ts 를 찾지 않으므로 이 파일은 node:test 로 따로 돈다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppError, ErrorCode } from './errors.js';
import { resolveAndValidate, toHostPath } from './pathValidator.js';

test('AC-1/AC-2: a /mnt/<drive> path is the Windows drive path on win32', () => {
  assert.equal(toHostPath('/mnt/c/work', 'win32'), 'C:\\work');
  assert.equal(toHostPath('/mnt/d/a/b c/d.txt', 'win32'), 'D:\\a\\b c\\d.txt');
  assert.equal(toHostPath('/mnt/c', 'win32'), 'C:\\');
  assert.equal(toHostPath('/mnt/c/', 'win32'), 'C:\\');
});

test('AC-3: other paths and other hosts are left as they are', () => {
  assert.equal(toHostPath('/mnt/c/work', 'linux'), '/mnt/c/work');
  assert.equal(toHostPath('/mnt/c/work', 'darwin'), '/mnt/c/work');
  for (const p of ['/home/beom', '/mnt/cc/x', '/mnt', '/mnt/', '/mntx/c', 'C:\\work', 'sub/dir', '', '\\\\wsl.localhost\\Ubuntu\\home']) {
    assert.equal(toHostPath(p, 'win32'), p, p);
  }
});

function toMountPath(windowsPath: string): string {
  return `/mnt/${windowsPath[0].toLowerCase()}${windowsPath.slice(2).replace(/\\/g, '/')}`;
}

test('AC-1/AC-2: on this Windows host the mount form of a directory resolves inside the session root, and outside stays refused', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('needs a Windows host: the conversion is win32-only');
    return;
  }
  const root = await realpath(await mkdtemp(join(tmpdir(), 'fex019-')));
  try {
    const cwd = join(root, 'session');
    const sub = join(cwd, 'sub');
    const outside = join(root, 'outside');
    await mkdir(sub, { recursive: true });
    await mkdir(outside, { recursive: true });
    assert.equal((await resolveAndValidate(cwd, toMountPath(cwd), [])).toLowerCase(), cwd.toLowerCase());
    assert.equal((await resolveAndValidate(cwd, toMountPath(sub), [])).toLowerCase(), sub.toLowerCase());
    await assert.rejects(
      resolveAndValidate(cwd, toMountPath(outside), []),
      (err: unknown) => err instanceof AppError && err.code === ErrorCode.PATH_TRAVERSAL,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
