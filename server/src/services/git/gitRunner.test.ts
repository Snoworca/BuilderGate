// FR-GIT-001, PERF-GIT-001, SEC-GIT-001: how the server runs git for a session.
// The runner never goes through a shell, adds fixed safety options, runs WSL sessions
// inside WSL, limits concurrency, joins identical requests and names failures by code.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COMMON_GIT_OPTIONS,
  buildGitCommand,
  classifyGitError,
  createGitRunner,
  gitTargetForSession,
  resolveGitTarget,
  type RunGitFile,
} from './gitRunner.js';

// @req SEC-GIT-001
test('SEC-GIT-001: a native target runs git directly with the fixed options before the subcommand', () => {
  const cmd = buildGitCommand({ kind: 'native', cwd: 'C:\\work\\repo' }, ['status', '--porcelain=v2']);
  assert.equal(cmd.file, 'git');
  assert.equal(cmd.cwd, 'C:\\work\\repo');
  assert.deepEqual(cmd.args, [...COMMON_GIT_OPTIONS, 'status', '--porcelain=v2']);
  assert.ok(COMMON_GIT_OPTIONS.includes('--no-optional-locks'), 'status must not take the index lock an agent may need');
  for (const opt of ['core.fsmonitor=false', 'diff.external=', 'core.quotepath=off', 'color.ui=never']) {
    assert.ok(COMMON_GIT_OPTIONS.includes(opt), opt);
  }
  assert.equal(cmd.env.LC_ALL, 'C');
  assert.equal(cmd.env.GIT_TERMINAL_PROMPT, '0');
});

// @req FR-GIT-001
test('FR-GIT-001: a WSL target runs git inside WSL with -C, and -d only when the distro is known', () => {
  const plain = buildGitCommand({ kind: 'wsl', cwd: '/home/beom/web' }, ['status']);
  assert.equal(plain.file, 'wsl.exe');
  assert.deepEqual(plain.args, ['-e', 'git', '-C', '/home/beom/web', ...COMMON_GIT_OPTIONS, 'status']);
  assert.equal(plain.cwd, undefined);
  assert.match(plain.env.WSLENV ?? '', /LC_ALL/);

  const named = buildGitCommand({ kind: 'wsl', cwd: '/srv/x', distro: 'Ubuntu-24.04' }, ['log']);
  assert.deepEqual(named.args.slice(0, 6), ['-d', 'Ubuntu-24.04', '-e', 'git', '-C', '/srv/x']);
});

// @req FR-GIT-001
test('FR-GIT-001: the target follows the command that launched the session, not its shell type', () => {
  // On Windows the "wsl" and "bash" shell settings both launch wsl.exe with shellType "bash".
  assert.deepEqual(
    resolveGitTarget({ platform: 'win32', launchCommand: 'wsl.exe', cwd: '/home/beom/web' }),
    { kind: 'wsl', cwd: '/home/beom/web' },
  );
  assert.deepEqual(
    resolveGitTarget({ platform: 'win32', launchCommand: 'C:\\Windows\\System32\\wsl.exe', cwd: '/home/beom/web' }),
    { kind: 'wsl', cwd: '/home/beom/web' },
  );
  assert.deepEqual(
    resolveGitTarget({ platform: 'win32', launchCommand: 'powershell.exe', cwd: 'C:\\work\\repo' }),
    { kind: 'native', cwd: 'C:\\work\\repo' },
  );
  // A Windows shell standing in a WSL share uses that distro's git.
  assert.deepEqual(
    resolveGitTarget({ platform: 'win32', launchCommand: 'powershell.exe', cwd: '\\\\wsl.localhost\\Ubuntu\\home\\beom\\web' }),
    { kind: 'wsl', cwd: '/home/beom/web', distro: 'Ubuntu' },
  );
  assert.deepEqual(
    resolveGitTarget({ platform: 'win32', launchCommand: 'cmd.exe', cwd: '\\\\wsl$\\Debian' }),
    { kind: 'wsl', cwd: '/', distro: 'Debian' },
  );
  // A WSL session in a Windows drive (/mnt/<letter>) runs Windows git on the same folder:
  // Linux git over the drive mount took 35 s for one status of this repository (2026-10-23).
  assert.deepEqual(
    resolveGitTarget({ platform: 'win32', launchCommand: 'wsl.exe', cwd: '/mnt/c/work/repo' }),
    { kind: 'native', cwd: 'C:\\work\\repo' },
  );
  assert.deepEqual(
    resolveGitTarget({ platform: 'win32', launchCommand: 'wsl.exe', cwd: '/mnt/d' }),
    { kind: 'native', cwd: 'D:\\' },
  );
  // /mnt/wsl and other names are not drives.
  assert.deepEqual(
    resolveGitTarget({ platform: 'win32', launchCommand: 'wsl.exe', cwd: '/mnt/wsl/x' }),
    { kind: 'wsl', cwd: '/mnt/wsl/x' },
  );
  // Off Windows there is no WSL.
  assert.deepEqual(
    resolveGitTarget({ platform: 'linux', launchCommand: 'bash', cwd: '/home/me' }),
    { kind: 'native', cwd: '/home/me' },
  );
});

// @req FR-GIT-001
test('FR-GIT-001: the session target reads the raw cwd and the launch command from the session manager', () => {
  const sessions = {
    getLastCwd: (id: string) => (id === 'w' ? '/home/beom/web' : id === 'n' ? 'C:\\work' : null),
    getSessionLaunchCommand: (id: string) => (id === 'w' ? 'wsl.exe' : id === 'n' ? 'powershell.exe' : null),
  };
  assert.deepEqual(gitTargetForSession(sessions, 'w', 'win32'), { kind: 'wsl', cwd: '/home/beom/web' });
  assert.deepEqual(gitTargetForSession(sessions, 'n', 'win32'), { kind: 'native', cwd: 'C:\\work' });
  assert.equal(gitTargetForSession(sessions, 'gone', 'win32'), null);
});

// @req FR-GIT-001
test('FR-GIT-001: failures are named by code', () => {
  const err = (props: Record<string, unknown>) => Object.assign(new Error('x'), props);
  assert.equal(classifyGitError(err({ code: 'ENOENT' })).code, 'GIT_UNAVAILABLE');
  assert.equal(classifyGitError(err({ stderr: '<3>WSL (12) ERROR: execvpe(git) failed: No such file or directory' })).code, 'GIT_UNAVAILABLE');
  assert.equal(classifyGitError(err({ killed: true, signal: 'SIGTERM' })).code, 'GIT_TIMEOUT');
  assert.equal(classifyGitError(err({ stderr: "fatal: detected dubious ownership in repository at 'C:/x'" })).code, 'GIT_UNSAFE_REPO');
  assert.equal(classifyGitError(err({ stderr: 'fatal: not a git repository (or any of the parent directories): .git' })).code, 'NOT_A_REPO');
  const failed = classifyGitError(err({ stderr: 'fatal: bad revision \'zzz\'\nmore' }));
  assert.equal(failed.code, 'GIT_FAILED');
  assert.equal(failed.detail, "fatal: bad revision 'zzz'");
});

function deferredRunner() {
  const calls: Array<{ file: string; args: readonly string[]; resolve: (v: { stdout: string }) => void; reject: (e: unknown) => void }> = [];
  const run: RunGitFile = (file, args) => new Promise((resolve, reject) => { calls.push({ file, args, resolve, reject }); });
  return { calls, run };
}
const tick = () => new Promise((r) => setImmediate(r));

// @req PERF-GIT-001
test('PERF-GIT-001: at most 2 processes per repository and 4 on the server at once', async () => {
  const { calls, run } = deferredRunner();
  const runGit = createGitRunner({ run });
  const target = (n: number) => ({ kind: 'native' as const, cwd: `C:\\r${n}` });
  const pending = [
    runGit(target(1), ['a'], { repoKey: 'r1' }), runGit(target(1), ['b'], { repoKey: 'r1' }), runGit(target(1), ['c'], { repoKey: 'r1' }),
    runGit(target(2), ['a'], { repoKey: 'r2' }), runGit(target(3), ['a'], { repoKey: 'r3' }), runGit(target(4), ['a'], { repoKey: 'r4' }),
  ];
  await tick();
  assert.equal(calls.length, 4, 'server-wide cap');
  assert.equal(calls.filter((c) => c.args.includes('a') || c.args.includes('b') || c.args.includes('c')).length, 4);
  assert.equal(calls.filter((c) => c.args.at(-1) === 'c').length, 0, 'third r1 call waits for the per-repo cap');
  calls[0].resolve({ stdout: '' });
  await tick();
  assert.equal(calls.length, 5);
  for (const c of calls) c.resolve({ stdout: '' });
  await tick();
  for (const c of calls) c.resolve({ stdout: '' });
  await Promise.all(pending);
  assert.equal(calls.length, 6);
});

// @req PERF-GIT-001
test('PERF-GIT-001: identical requests in flight share one process', async () => {
  const { calls, run } = deferredRunner();
  const runGit = createGitRunner({ run });
  const t = { kind: 'native' as const, cwd: 'C:\\r' };
  const a = runGit(t, ['status'], { repoKey: 'r', join: true });
  const b = runGit(t, ['status'], { repoKey: 'r', join: true });
  await tick();
  assert.equal(calls.length, 1);
  calls[0].resolve({ stdout: 'same' });
  assert.deepEqual(await Promise.all([a, b]), ['same', 'same']);
  // Once settled, the next call runs again.
  const c = runGit(t, ['status'], { repoKey: 'r', join: true });
  await tick();
  assert.equal(calls.length, 2);
  calls[1].resolve({ stdout: 'next' });
  assert.equal(await c, 'next');
});

// @req PERF-GIT-001
test('PERF-GIT-001: a failure is classified and the slot is released', async () => {
  const { calls, run } = deferredRunner();
  const runGit = createGitRunner({ run, maxPerRepo: 1 });
  const t = { kind: 'native' as const, cwd: 'C:\\r' };
  const a = runGit(t, ['x'], { repoKey: 'r' });
  const b = runGit(t, ['y'], { repoKey: 'r' });
  await tick();
  calls[0].reject(Object.assign(new Error('t'), { killed: true, signal: 'SIGTERM' }));
  await assert.rejects(a, (e: { code?: string }) => e.code === 'GIT_TIMEOUT');
  await tick();
  assert.equal(calls.length, 2);
  calls[1].resolve({ stdout: 'ok' });
  assert.equal(await b, 'ok');
});

// @req PERF-GIT-001
test('PERF-GIT-001: timeouts default to 5 s for quick queries and 10 s otherwise', async () => {
  const seen: number[] = [];
  const runGit = createGitRunner({ run: async (_f, _a, o) => { seen.push(o.timeout); return { stdout: '' }; } });
  const t = { kind: 'native' as const, cwd: 'C:\\r' };
  await runGit(t, ['status'], { repoKey: 'r', quick: true });
  await runGit(t, ['log'], { repoKey: 'r' });
  assert.deepEqual(seen, [5000, 10000]);
});

// @req FR-GIT-001
test('FR-GIT-001: the default runner runs the real git (git 2.30 or newer is required)', async () => {
  const runGit = createGitRunner();
  const out = await runGit({ kind: 'native', cwd: process.cwd() }, ['--version'], { repoKey: 'version', quick: true });
  const m = /git version (\d+)\.(\d+)/.exec(out);
  assert.ok(m, out);
  assert.ok(Number(m[1]) > 2 || (Number(m[1]) === 2 && Number(m[2]) >= 30), out);
  await assert.rejects(
    runGit({ kind: 'native', cwd: process.cwd() }, ['rev-parse', '--verify', 'no-such-ref-zzz'], { repoKey: 'version', quick: true }),
    (e: { code?: string }) => e.code === 'GIT_FAILED',
  );
});
