// PERF-GIT-001 AC-9: WSL git commands go through one resident helper per distribution, so
// wsl.exe (p50 ~360 ms, p95 up to 1.6 s to start) is launched once, not per command.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createWslGitHelper } from './gitWslHelper.js';

const hasWsl = process.platform === 'win32' && spawnSync('wsl.exe', ['-e', 'true'], { windowsHide: true, timeout: 20_000 }).status === 0;
const opts = { timeout: 10_000, maxBuffer: 1 << 20, encoding: 'utf8' as const };

test('PERF-GIT-001 AC-9: many commands, one wsl.exe; arguments reach git without a shell', { skip: !hasWsl }, async (t) => {
  let launches = 0;
  const helper = createWslGitHelper({ onLaunch: () => { launches += 1; }, size: 1 });
  t.after(() => helper.close());
  for (let i = 0; i < 5; i += 1) {
    const out = await helper.run(undefined, ['--version'], opts);
    assert.match(String(out.stdout), /^git version/);
  }
  assert.equal(launches, 1, 'wsl.exe started once for five commands');
  // Spaces, quotes, $, ;, backticks and newlines are data, not shell syntax.
  const tricky = `a b "c" 'd' $HOME ; echo hi \`id\`\nline2`;
  const value = await helper.run(undefined, ['-c', `bg.probe=${tricky}`, 'config', '--get', 'bg.probe'], opts);
  assert.equal(String(value.stdout).replace(/\n$/, ''), tricky);
  const raw = await helper.run(undefined, ['--version'], { ...opts, encoding: 'buffer' });
  assert.ok(Buffer.isBuffer(raw.stdout));
});

test('PERF-GIT-001 AC-9: git failures keep exit code and stderr; a timeout kills the helper and the next call starts a new one', { skip: !hasWsl }, async (t) => {
  let launches = 0;
  const helper = createWslGitHelper({ onLaunch: () => { launches += 1; }, size: 1 });
  t.after(() => helper.close());
  await assert.rejects(helper.run(undefined, ['-C', '/nonexistent-bg-path', 'status'], opts), (err: { code?: unknown; stderr?: unknown }) => {
    assert.equal(err.code, 128);
    assert.match(String(err.stderr), /nonexistent-bg-path/);
    return true;
  });
  await assert.rejects(helper.run(undefined, ['-c', 'alias.slow=!sleep 5', 'slow'], { ...opts, timeout: 500 }), (err: { killed?: unknown }) => err.killed === true);
  const out = await helper.run(undefined, ['--version'], opts);
  assert.match(String(out.stdout), /^git version/);
  assert.equal(launches, 2, 'restarted once after the timeout');
});

test('PERF-GIT-001 AC-9: a helper that cannot start reports itself unavailable', { skip: !hasWsl }, async (t) => {
  const helper = createWslGitHelper({ interpreter: 'no-such-interpreter-bg', size: 1 });
  t.after(() => helper.close());
  await assert.rejects(helper.run(undefined, ['--version'], opts));
  assert.equal(helper.available(undefined), false, 'the caller falls back to one wsl.exe per command');
});

const settles = <T>(p: Promise<T>, ms: number) => Promise.race([
  p.then(() => 'settled', () => 'settled'),
  new Promise((res) => setTimeout(() => res('stuck'), ms)),
]);

test('PERF-GIT-001 AC-9: a timeout never strands the commands queued behind it', { skip: !hasWsl }, async (t) => {
  const helper = createWslGitHelper({ size: 1 });
  t.after(() => helper.close());
  await helper.run(undefined, ['--version'], opts);
  const slow = helper.run(undefined, ['-c', 'alias.slow=!sleep 5', 'slow'], { ...opts, timeout: 500 });
  const queued = helper.run(undefined, ['--version'], opts);
  await assert.rejects(slow, (err: { killed?: unknown }) => err.killed === true);
  assert.equal(await settles(queued, 15_000), 'settled', 'the queued command finished or failed');
});

test('PERF-GIT-001 AC-9: a helper that never answers its start is given up, and tried again after a pause', { skip: !hasWsl }, async (t) => {
  let clock = 0;
  const helper = createWslGitHelper({ size: 1, script: 'sleep 30;', startTimeoutMs: 1_000, retryAfterMs: 60_000, now: () => clock });
  t.after(() => helper.close());
  assert.equal(await settles(helper.run(undefined, ['--version'], opts), 8_000), 'settled');
  assert.equal(helper.available(undefined), false);
  clock += 61_000;
  assert.equal(helper.available(undefined), true, 'tried again after the pause');
});

test('PERF-GIT-001 AC-9: an output over maxBuffer is refused from its length alone; the next call works', { skip: !hasWsl }, async (t) => {
  const helper = createWslGitHelper({ size: 1 });
  t.after(() => helper.close());
  await assert.rejects(helper.run(undefined, ['--version'], { ...opts, maxBuffer: 5 }), (err: { code?: unknown }) => err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
  assert.match(String((await helper.run(undefined, ['--version'], opts)).stdout), /^git version/);
  helper.close();
  assert.equal(helper.available(undefined), false, 'after close, commands use one wsl.exe each');
});

test('PERF-GIT-001 AC-9: an idle helper does not keep the process alive', { skip: !hasWsl }, () => {
  const code = `import { createWslGitHelper } from './src/services/git/gitWslHelper.ts';
const h = createWslGitHelper({ size: 1 });
const out = await h.run(undefined, ['--version'], { timeout: 10000, maxBuffer: 1 << 20, encoding: 'utf8' });
console.log(String(out.stdout).trim());`;
  const res = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { cwd: process.cwd(), timeout: 30_000, encoding: 'utf8', windowsHide: true });
  assert.match(res.stdout, /git version/, res.stderr);
  assert.notEqual(res.error?.message?.includes('ETIMEDOUT'), true, 'the process exited on its own');
  assert.equal(res.status, 0, res.stderr);
});
