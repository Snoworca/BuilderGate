// #55: the lock that keeps `npm run build`, `npm run typecheck` and the ownership typecheck
// test from writing node_modules/.tmp at the same time.
//
// Every case here runs the lock in REAL separate processes. An in-process test would pass
// against a lock that is just a module-level boolean, and a module-level boolean is exactly
// the shape of lock that does not fix this defect.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const FRONTEND_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const LOCK_DIR = join(FRONTEND_ROOT, 'node_modules', '.tmp', '.tsc-build.lock');
const LOCK_MODULE = join(FRONTEND_ROOT, 'tools', 'tscBuildLock.mjs');
const RUNNER = join(FRONTEND_ROOT, 'tools', 'with-tsc-build-lock.mjs');

function clearLock(): void {
  rmSync(LOCK_DIR, { recursive: true, force: true });
}

test('#55 a second holder cannot enter while the first holds the lock', async () => {
  clearLock();
  // The first process holds the lock until its stdin closes; the second is started while
  // that is true and must not report entry before the first reports release.
  const first = spawn(process.execPath, ['--input-type=module', '-e', `
    import { acquireTscBuildLock } from ${JSON.stringify(LOCK_MODULE)};
    const release = await acquireTscBuildLock({ label: 'first' });
    console.log('first:held');
    process.stdin.resume();
    process.stdin.on('end', () => { release(); console.log('first:released'); process.exit(0); });
  `], { cwd: FRONTEND_ROOT, stdio: ['pipe', 'pipe', 'inherit'] });
  const events: string[] = [];
  first.stdout.on('data', chunk => { for (const line of String(chunk).split('\n')) if (line.trim()) events.push(line.trim()); });
  while (!events.includes('first:held')) await new Promise(resolve => setTimeout(resolve, 20));

  const second = spawn(process.execPath, ['--input-type=module', '-e', `
    import { acquireTscBuildLock } from ${JSON.stringify(LOCK_MODULE)};
    const release = await acquireTscBuildLock({ label: 'second', timeoutMs: 30000 });
    console.log('second:held');
    release();
  `], { cwd: FRONTEND_ROOT, stdio: ['ignore', 'pipe', 'inherit'] });
  second.stdout.on('data', chunk => { for (const line of String(chunk).split('\n')) if (line.trim()) events.push(line.trim()); });

  // Long enough that a lock which is not a lock would have let the second process through.
  await new Promise(resolve => setTimeout(resolve, 1000));
  assert.deepEqual(events, ['first:held'], 'the second holder entered while the first still held the lock');

  first.stdin.end();
  const code = await new Promise<number>(resolve => second.on('close', resolve));
  assert.equal(code, 0, 'the second holder must enter once the first releases');
  assert.deepEqual(events, ['first:held', 'first:released', 'second:held']);
  assert.equal(existsSync(LOCK_DIR), false, 'the lock directory must not survive its holders');
});

test('#55 a lock whose owner process is gone is stolen, not waited on', async () => {
  clearLock();
  mkdirSync(LOCK_DIR, { recursive: true });
  // A pid that cannot be running: process 2^22 is above the kernel maximum this project
  // runs under, and kill(0) on it reports ESRCH rather than EPERM.
  writeFileSync(join(LOCK_DIR, 'owner.json'), JSON.stringify({ pid: 4194304, label: 'dead', since: 0 }));

  const started = Date.now();
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { acquireTscBuildLock } from ${JSON.stringify(LOCK_MODULE)};
    const release = await acquireTscBuildLock({ label: 'steal', timeoutMs: 5000 });
    console.log('held');
    release();
  `], { cwd: FRONTEND_ROOT, encoding: 'utf8' });
  assert.equal(result.status, 0, `stealing a dead lock failed: ${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /held/u);
  assert.ok(Date.now() - started < 4000, 'a dead owner must not be waited out to the timeout');
});

test('#55 waiting for a live lock times out with a message naming the lock', () => {
  clearLock();
  mkdirSync(LOCK_DIR, { recursive: true });
  // This process is alive, so the lock is live and must be waited on, not stolen.
  writeFileSync(join(LOCK_DIR, 'owner.json'), JSON.stringify({ pid: process.pid, label: 'alive', since: Date.now() }));
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { acquireTscBuildLock } from ${JSON.stringify(LOCK_MODULE)};
    await acquireTscBuildLock({ label: 'waiter', timeoutMs: 300 });
    console.log('held');
  `], { cwd: FRONTEND_ROOT, encoding: 'utf8' });
  assert.notEqual(result.status, 0, 'a live lock must not be stolen');
  assert.doesNotMatch(result.stdout, /held/u);
  assert.match(result.stderr, /Timed out/u);
  assert.match(result.stderr, /\.tsc-build\.lock/u);
  clearLock();
});

test('#55 the runner releases the lock and forwards the exit code', () => {
  clearLock();
  const failed = spawnSync(process.execPath, [RUNNER, process.execPath, '-e', 'process.exit(3)'], {
    cwd: FRONTEND_ROOT, encoding: 'utf8',
  });
  assert.equal(failed.status, 3, 'the wrapped command exit code must survive');
  assert.equal(existsSync(LOCK_DIR), false, 'a failing command must still release the lock');

  const ok = spawnSync(process.execPath, [RUNNER, process.execPath, '-e', 'console.log("ran")'], {
    cwd: FRONTEND_ROOT, encoding: 'utf8',
  });
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /ran/u);
  assert.equal(existsSync(LOCK_DIR), false);
});
