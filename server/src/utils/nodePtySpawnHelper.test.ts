import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import * as pty from 'node-pty';

import {
  installNodePtySpawnHelperGuard,
  resolveExecutableSpawnHelper,
  type SpawnHelperFs,
} from './nodePtySpawnHelper.js';

/**
 * OPS-BGSTAB-017 AC-7.
 *
 * Measured 2026-10-03 on macOS arm64: every session creation failed with
 * `Error: posix_spawnp failed.` from node-pty's UnixTerminal, both in the
 * packaged 0.10.8 app and from source. On macOS node-pty starts every PTY by
 * posix_spawn-ing `prebuilds/darwin-<arch>/spawn-helper`, and two things stop
 * that file from being executable:
 *
 * 1. node-pty 1.1.0 ships that file as -rw-r--r--, so a plain `npm ci`
 *    checkout cannot spawn anything.
 * 2. In the pkg executable node-pty computes the helper path from its own
 *    __dirname, which is `/snapshot/...` — a path that exists only inside the
 *    executable's virtual filesystem and that the kernel cannot exec at all.
 *
 * Windows uses ConPTY/winpty and Linux forks directly, so neither has a helper.
 */

const MODE_644 = 0o644;

function tempDir(t: { after: (fn: () => void) => void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-spawn-helper-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeHelper(dir: string, contents = '#!/bin/sh\necho helper\n'): string {
  const helper = path.join(dir, 'prebuilds', 'darwin-arm64', 'spawn-helper');
  fs.mkdirSync(path.dirname(helper), { recursive: true });
  fs.writeFileSync(helper, contents);
  fs.chmodSync(helper, MODE_644);
  return helper;
}

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

test('non-darwin platforms get the helper path back untouched', (t) => {
  const dir = tempDir(t);
  const helper = writeHelper(dir);
  for (const platform of ['win32', 'linux'] as const) {
    assert.equal(resolveExecutableSpawnHelper(helper, { platform, cacheDir: dir }), helper);
  }
  assert.equal(isExecutable(helper), false, 'nothing may chmod the file off macOS');
});

test('darwin: a real but non-executable helper is made executable in place', (t) => {
  const dir = tempDir(t);
  const helper = writeHelper(dir);
  assert.equal(isExecutable(helper), false, 'precondition: shipped without an execute bit');

  const resolved = resolveExecutableSpawnHelper(helper, { platform: 'darwin', cacheDir: path.join(dir, 'cache') });

  assert.equal(resolved, helper);
  assert.equal(isExecutable(helper), true);
  assert.equal(fs.existsSync(path.join(dir, 'cache')), false, 'no copy when chmod in place worked');
});

test('darwin: an already executable helper is returned without being rewritten', (t) => {
  const dir = tempDir(t);
  const helper = writeHelper(dir);
  fs.chmodSync(helper, 0o755);
  const before = fs.statSync(helper).mtimeMs;

  assert.equal(resolveExecutableSpawnHelper(helper, { platform: 'darwin', cacheDir: path.join(dir, 'cache') }), helper);
  assert.equal(fs.statSync(helper).mtimeMs, before);
});

test('darwin: a helper that cannot be chmodded (read-only install) is materialised as an executable copy', (t) => {
  const dir = tempDir(t);
  const contents = '#!/bin/sh\necho read-only\n';
  const helper = writeHelper(dir, contents);
  const cacheDir = path.join(dir, 'cache');
  const fsDeps: Partial<SpawnHelperFs> = {
    chmodSync: ((file: string, mode: number) => {
      if (file === helper) throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      fs.chmodSync(file, mode);
    }) as SpawnHelperFs['chmodSync'],
  };

  const resolved = resolveExecutableSpawnHelper(helper, { platform: 'darwin', cacheDir, fs: fsDeps });

  assert.notEqual(resolved, helper);
  assert.ok(resolved.startsWith(cacheDir + path.sep), `copy lives under the cache dir: ${resolved}`);
  assert.equal(fs.readFileSync(resolved, 'utf8'), contents);
  assert.equal(isExecutable(resolved), true);
});

test('darwin: a pkg snapshot helper is materialised as an executable copy keyed by its content', (t) => {
  const dir = tempDir(t);
  const contents = '#!/bin/sh\necho snapshot\n';
  const snapshotPath = '/snapshot/BuilderGate/server/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper';
  const cacheDir = path.join(dir, 'cache');
  let chmodOnSnapshot = false;
  const fsDeps: Partial<SpawnHelperFs> = {
    readFileSync: ((file: string) => {
      if (file === snapshotPath) return Buffer.from(contents);
      return fs.readFileSync(file);
    }) as SpawnHelperFs['readFileSync'],
    chmodSync: ((file: string, mode: number) => {
      if (file === snapshotPath) chmodOnSnapshot = true;
      fs.chmodSync(file, mode);
    }) as SpawnHelperFs['chmodSync'],
  };

  const resolved = resolveExecutableSpawnHelper(snapshotPath, { platform: 'darwin', cacheDir, fs: fsDeps });

  assert.equal(chmodOnSnapshot, false, 'a snapshot path is never chmodded');
  const digest = createHash('sha256').update(contents).digest('hex').slice(0, 16);
  assert.ok(resolved.includes(digest), `copy is keyed by content hash: ${resolved}`);
  assert.equal(fs.readFileSync(resolved, 'utf8'), contents);
  assert.equal(isExecutable(resolved), true);

  // Reused while intact, recreated when the OS cleans the temp directory.
  const mtime = fs.statSync(resolved).mtimeMs;
  assert.equal(resolveExecutableSpawnHelper(snapshotPath, { platform: 'darwin', cacheDir, fs: fsDeps }), resolved);
  assert.equal(fs.statSync(resolved).mtimeMs, mtime);
  fs.rmSync(cacheDir, { recursive: true, force: true });
  assert.equal(resolveExecutableSpawnHelper(snapshotPath, { platform: 'darwin', cacheDir, fs: fsDeps }), resolved);
  assert.equal(isExecutable(resolved), true);
});

test('darwin: a missing helper falls back to the original path so node-pty reports its own error', (t) => {
  const dir = tempDir(t);
  const missing = path.join(dir, 'nope', 'spawn-helper');
  assert.equal(resolveExecutableSpawnHelper(missing, { platform: 'darwin', cacheDir: path.join(dir, 'cache') }), missing);
});

test('the guard rewrites only the helper argument of native fork, and installs once', () => {
  const calls: unknown[][] = [];
  const native: { fork: (...args: unknown[]) => string } = {
    fork: (...args: unknown[]) => {
      calls.push(args);
      return 'forked';
    },
  };
  const resolve = (p: string) => `${p}#resolved`;
  const onexit = () => {};

  assert.equal(installNodePtySpawnHelperGuard({ platform: 'darwin', nativeModule: native, resolve }), true);
  assert.equal(installNodePtySpawnHelperGuard({ platform: 'darwin', nativeModule: native, resolve }), false);

  const result = native.fork('/bin/zsh', [], ['A=1'], '/tmp', 80, 24, -1, -1, true, '/h/spawn-helper', onexit);

  assert.equal(result, 'forked');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 9), ['/bin/zsh', [], ['A=1'], '/tmp', 80, 24, -1, -1, true]);
  assert.equal(calls[0][9], '/h/spawn-helper#resolved', 'wrapped exactly once');
  assert.equal(calls[0][10], onexit);
});

test('the guard is not installed off macOS', () => {
  const original = () => 'x';
  const native = { fork: original };
  assert.equal(installNodePtySpawnHelperGuard({ platform: 'linux', nativeModule: native }), false);
  assert.equal(native.fork, original);
});

test('node-pty still passes the helper path as the 10th argument of native fork', () => {
  // The guard rewrites argument index 9. If a node-pty upgrade moves it, this
  // fails here instead of the guard silently rewriting the wrong argument.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(
    path.resolve(here, '../../node_modules/node-pty/lib/unixTerminal.js'),
    'utf8',
  );
  assert.match(
    source,
    /pty\.fork\(file, args, parsedEnv, cwd, _this\._cols, _this\._rows, uid, gid, \(encoding === 'utf8'\), helperPath, onexit\)/,
  );
});

test('darwin: node-pty spawns a real shell once the guard is installed', { skip: process.platform !== 'darwin' }, async () => {
  installNodePtySpawnHelperGuard();
  const output = await new Promise<string>((resolve, reject) => {
    let data = '';
    const child = pty.spawn('/bin/sh', ['-c', 'echo bg-spawn-ok'], { cols: 80, rows: 24, cwd: os.tmpdir() });
    const timer = setTimeout(() => reject(new Error(`timed out; output so far: ${JSON.stringify(data)}`)), 10_000);
    child.onData((chunk) => { data += chunk; });
    child.onExit(() => {
      clearTimeout(timer);
      resolve(data);
    });
  });
  assert.match(output, /bg-spawn-ok/);
});
