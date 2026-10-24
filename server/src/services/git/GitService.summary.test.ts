// FR-GIT-001, FR-GIT-008, PERF-GIT-001: summary of a session's repository, read from real git repositories.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { rmSync } from 'node:fs';
import { GitService } from './GitService.js';
import { createGitRunner, GitError, type RunGit } from './gitRunner.js';
import { initRepo, repoAt, tempRoot } from './testRepo.js';
import { createRepoWatcher } from './gitRepoWatcher.js';

function serviceFor(cwd: string, runGit?: RunGit) {
  const sessions = { getLastCwd: (id: string) => (id === 's' ? cwd : null), getSessionLaunchCommand: () => 'powershell.exe' };
  return new GitService({ sessions, runGit: runGit ?? createGitRunner() });
}

// @req FR-GIT-001
test('FR-GIT-001: a folder outside any repository answers repo:false', async (t) => {
  const { root, cleanup } = tempRoot(); t.after(cleanup);
  const s = await serviceFor(root).summary('s');
  assert.equal(s.repo, false);
});

// @req FR-GIT-001
test('FR-GIT-001: a missing session is SESSION_NOT_FOUND', async (t) => {
  const { root, cleanup } = tempRoot(); t.after(cleanup);
  await assert.rejects(serviceFor(root).summary('nope'), (e: GitError) => e.code === 'SESSION_NOT_FOUND');
});

// @req FR-GIT-001
test('FR-GIT-001: an empty repository has a branch, no head and counts its new files', async (t) => {
  const { root, cleanup } = tempRoot(); t.after(cleanup);
  const r = initRepo(path.join(root, 'r'));
  r.write('a.txt', 'a');
  const s = await serviceFor(r.dir).summary('s');
  assert.equal(s.repo, true);
  if (!s.repo) return;
  assert.equal(s.branch, 'main');
  assert.equal(s.head, null);
  assert.equal(s.detached, false);
  assert.deepEqual(s.counts, { staged: 0, unstaged: 0, untracked: 1, conflicted: 0, paths: 1 });
  assert.equal(path.resolve(s.root).toLowerCase(), path.resolve(r.dir).toLowerCase());
  assert.equal(s.subdir, '');
  assert.deepEqual(s.compare, { blocked: 'noBase' });
});

// @req FR-GIT-001
test('FR-GIT-001: staged, unstaged and untracked changes; one path is counted once', async (t) => {
  const { root, cleanup } = tempRoot(); t.after(cleanup);
  const r = initRepo(path.join(root, 'r'));
  r.commit('init', { 'a.txt': 'a', 'b.txt': 'b' });
  r.write('a.txt', 'a2'); r.git('add', 'a.txt'); r.write('a.txt', 'a3');
  r.write('b.txt', 'b2');
  r.write('c.txt', 'c');
  const s = await serviceFor(r.dir).summary('s');
  assert.ok(s.repo);
  if (!s.repo) return;
  assert.deepEqual(s.counts, { staged: 1, unstaged: 2, untracked: 1, conflicted: 0, paths: 3 });
  assert.equal(s.untrackedScan, 'normal');
  assert.match(s.head ?? '', /^[0-9a-f]{40}$/);
  assert.deepEqual(s.compare, { blocked: 'sameAsBase' });
});

// @req FR-GIT-001, FR-GIT-008
test('FR-GIT-001: upstream ahead/behind; without an upstream, ahead of the detected base', async (t) => {
  const { root, cleanup } = tempRoot(); t.after(cleanup);
  const origin = initRepo(path.join(root, 'origin'));
  origin.commit('one', { 'a.txt': '1' });
  repoAt(root).git('clone', '-q', origin.dir, path.join(root, 'clone'));
  const clone = repoAt(path.join(root, 'clone'));
  clone.commit('c1', { 'b.txt': '1' });
  clone.commit('c2', { 'b.txt': '2' });
  origin.commit('o1', { 'a.txt': '2' });
  clone.git('fetch', '-q');
  const s = await serviceFor(clone.dir).summary('s');
  assert.ok(s.repo);
  if (!s.repo) return;
  assert.deepEqual([s.branch, s.upstream, s.ahead, s.behind, s.base], ['main', 'origin/main', 2, 1, null]);

  clone.git('checkout', '-q', '-b', 'feat/x', 'origin/main');
  clone.git('branch', '-q', '--unset-upstream');
  clone.commit('f1'); clone.commit('f2'); clone.commit('f3');
  const f = await serviceFor(clone.dir).summary('s');
  assert.ok(f.repo);
  if (!f.repo) return;
  assert.equal(f.upstream, null);
  assert.deepEqual(f.base, { ref: 'origin/main', ahead: 3 });
  assert.deepEqual(f.compare, { ref: 'origin/main' });
});

// @req FR-GIT-001
test('FR-GIT-001: detached HEAD', async (t) => {
  const { root, cleanup } = tempRoot(); t.after(cleanup);
  const r = initRepo(path.join(root, 'r'));
  const sha = r.commit('one');
  r.commit('two');
  r.git('checkout', '-q', sha);
  const s = await serviceFor(r.dir).summary('s');
  assert.ok(s.repo);
  if (!s.repo) return;
  assert.equal(s.detached, true);
  assert.equal(s.branch, null);
  assert.equal(s.head, sha);
});

// @req FR-GIT-001
test('FR-GIT-001: a merge with a conflict reports the operation and the conflicted path', async (t) => {
  const { root, cleanup } = tempRoot(); t.after(cleanup);
  const r = initRepo(path.join(root, 'r'));
  r.commit('base', { 'a.txt': 'base' });
  r.git('checkout', '-q', '-b', 'other');
  r.commit('other', { 'a.txt': 'other' });
  r.git('checkout', '-q', 'main');
  r.commit('main', { 'a.txt': 'main' });
  r.gitMayFail('merge', 'other');
  const s = await serviceFor(r.dir).summary('s');
  assert.ok(s.repo);
  if (!s.repo) return;
  assert.equal(s.operation?.kind, 'merge');
  assert.equal(s.counts.conflicted, 1);
});

// @req FR-GIT-001
test('FR-GIT-001: a rebase in progress reports step/total and keeps the original branch name', async (t) => {
  const { root, cleanup } = tempRoot(); t.after(cleanup);
  const r = initRepo(path.join(root, 'r'));
  r.commit('base', { 'a.txt': 'base' });
  r.git('checkout', '-q', '-b', 'feat');
  r.commit('f1', { 'a.txt': 'feat' });
  r.commit('f2', { 'b.txt': 'b' });
  r.git('checkout', '-q', 'main');
  r.commit('m1', { 'a.txt': 'main' });
  r.git('checkout', '-q', 'feat');
  r.gitMayFail('rebase', 'main');
  const s = await serviceFor(r.dir).summary('s');
  assert.ok(s.repo);
  if (!s.repo) return;
  assert.equal(s.operation?.kind, 'rebase');
  assert.equal(s.operation?.total, 2);
  assert.equal(s.operation?.step, 1);
  assert.equal(s.branch, 'feat');
  assert.equal(s.detached, false);
});

// @req FR-GIT-001
test('FR-GIT-001: a subfolder cwd reports the repository root and the subfolder', async (t) => {
  const { root, cleanup } = tempRoot(); t.after(cleanup);
  const r = initRepo(path.join(root, 'r'));
  r.commit('one', { 'docs/a.md': 'a' });
  const s = await serviceFor(path.join(r.dir, 'docs')).summary('s');
  assert.ok(s.repo);
  if (!s.repo) return;
  assert.equal(s.subdir, 'docs/');
});

// @req FR-GIT-001
test('FR-GIT-001: a linked worktree reports its own branch and changes', async (t) => {
  const { root, cleanup } = tempRoot(); t.after(cleanup);
  const r = initRepo(path.join(root, 'r'));
  r.commit('one', { 'a.txt': 'a' });
  r.git('worktree', 'add', '-q', '-b', 'wtb', path.join(root, 'wt'));
  const wt = repoAt(path.join(root, 'wt'));
  wt.write('n.txt', 'n');
  const s = await serviceFor(wt.dir).summary('s');
  assert.ok(s.repo);
  if (!s.repo) return;
  assert.equal(s.branch, 'wtb');
  assert.equal(s.counts.untracked, 1);
});

function countingRunner() {
  const real = createGitRunner();
  const calls: string[][] = [];
  const runGit = ((target: never, args: string[], opts: never) => { calls.push(args); return real(target, args, opts); }) as unknown as RunGit;
  return { calls, runGit };
}

// @req PERF-GIT-001
test('PERF-GIT-001: a second summary within 1 s reuses the first, and parallel calls share one', async (t) => {
  const { root, cleanup } = tempRoot(); t.after(cleanup);
  const r = initRepo(path.join(root, 'r'));
  r.commit('one', { 'a.txt': 'a' });
  const { calls, runGit } = countingRunner();
  const svc = serviceFor(r.dir, runGit);
  await Promise.all([svc.summary('s'), svc.summary('s')]);
  const statusCalls = () => calls.filter((a) => a.includes('status')).length;
  assert.equal(statusCalls(), 1);
  await svc.summary('s');
  assert.equal(statusCalls(), 1);
});

// @req PERF-GIT-001
test('PERF-GIT-001: after two status timeouts in a row the repository stops scanning new files', async () => {
  let timeouts = 2;
  const seen: string[][] = [];
  const runGit = (async (_t: unknown, args: string[]) => {
    seen.push(args);
    if (args[0] === 'rev-parse') return 'C:/r\nC:/r/.git\n.git\n\n';
    if (args[0] === 'status') {
      if (timeouts > 0) { timeouts -= 1; throw new GitError('GIT_TIMEOUT'); }
      return '# branch.oid (initial)\0# branch.head main\0';
    }
    return '';
  }) as unknown as RunGit;
  let now = 0;
  const svc = new GitService({ sessions: { getLastCwd: () => 'C:\\r', getSessionLaunchCommand: () => 'powershell.exe' }, runGit, now: () => now, listGitDir: async () => [] });
  await assert.rejects(svc.summary('s'), (e: GitError) => e.code === 'GIT_TIMEOUT');
  now += 2000;
  await assert.rejects(svc.summary('s'), (e: GitError) => e.code === 'GIT_TIMEOUT');
  now += 2000;
  const s = await svc.summary('s');
  assert.ok(s.repo);
  if (!s.repo) return;
  assert.equal(s.untrackedScan, 'off');
  assert.ok(seen.filter((a) => a[0] === 'status').at(-1)?.includes('-uno'));
});

// @req PERF-GIT-001
test('PERF-GIT-001: a first summary looks up the base in one git call, alongside status', async (t) => {
  const { root, cleanup } = tempRoot(); t.after(cleanup);
  const origin = initRepo(path.join(root, 'o'));
  origin.commit('init', { 'a.txt': 'a' });
  repoAt(root).git('clone', '-q', origin.dir, path.join(root, 'c'));
  const c = repoAt(path.join(root, 'c'));
  c.git('checkout', '-q', '-b', 'feat');
  const base = createGitRunner();
  const calls: Array<{ cmd: string; start: number; end: number }> = [];
  let clock = 0;
  const runGit = (async (...a: Parameters<RunGit>) => {
    const entry = { cmd: a[1].find((x) => !x.startsWith('-') && !x.includes('=')) ?? '', start: clock++, end: -1 };
    calls.push(entry);
    try { return await base(...a); } finally { entry.end = clock++; }
  }) as RunGit;
  const s = await serviceFor(c.dir, runGit).summary('s');
  assert.ok(s.repo && 'ref' in s.compare && s.compare.ref === 'origin/main', JSON.stringify(s));
  // Since AC-6 the base comes from the ref files: no lookup process at all (it used to be one
  // for-each-ref alongside status).
  const lookups = calls.filter((x) => x.cmd === 'symbolic-ref' || x.cmd === 'for-each-ref');
  assert.equal(lookups.length, 0, calls.map((x) => x.cmd).join(','));
  assert.ok(calls.some((x) => x.cmd === 'status'));
});

// @req PERF-GIT-001
test('PERF-GIT-001 AC-5: a slow status refreshes the index once per minute; a held index lock is skipped', async (t) => {
  const { root, cleanup } = tempRoot(); t.after(cleanup);
  const r = initRepo(path.join(root, 'r'));
  r.commit('init', { 'a.txt': 'a' });
  const base = createGitRunner();
  let clock = 1_000_000;
  let slow = true;
  const cmds: string[] = [];
  const runGit = (async (...a: Parameters<RunGit>) => {
    const cmd = a[1].find((x) => !x.startsWith('-') && !x.includes('=')) ?? '';
    cmds.push(cmd);
    const out = await base(...a);
    // The run time the service sees is the test's, not this machine's (under load a real status passes 150 ms).
    if (cmd === 'status' && a[2].timing) a[2].timing.ms = slow ? 1_500 : 10;
    if (cmd === 'status' && slow) clock += 1_500;
    return out;
  }) as RunGit;
  const svc = new GitService({ sessions: { getLastCwd: () => r.dir, getSessionLaunchCommand: () => 'powershell.exe' }, runGit, now: () => clock });
  const settle = () => new Promise((res) => setTimeout(res, 300));
  await svc.summary('s'); await settle();
  assert.equal(cmds.filter((c) => c === 'update-index').length, 1, cmds.join(','));
  clock += 5_000;
  await svc.summary('s'); await settle();
  assert.equal(cmds.filter((c) => c === 'update-index').length, 1, 'at most once a minute');
  clock += 61_000;
  r.write('.git/index.lock', '');
  const s = await svc.summary('s'); await settle();
  assert.ok(s.repo, 'a held lock does not fail the summary');
  assert.equal(cmds.filter((c) => c === 'update-index').length, 1, 'skipped while another git holds the index lock');
  slow = false;
  clock += 61_000;
  rmSync(path.join(r.dir, '.git', 'index.lock'));
  await svc.summary('s'); await settle();
  assert.equal(cmds.filter((c) => c === 'update-index').length, 1, 'a fast status needs no refresh');
});

function countingService(dir: string, start = 2_000_000) {
  const base = createGitRunner();
  let clock = start;
  const cmds: string[] = [];
  const runGit = (async (...a: Parameters<RunGit>) => {
    const cmd = a[1].find((x) => !x.startsWith('-') && !x.includes('=')) ?? '';
    // The background index refresh (AC-5) is not part of the request; it fires whenever status
    // really takes over 150 ms, which a loaded machine decides.
    if (cmd !== 'update-index') cmds.push(cmd);
    return base(...a);
  }) as RunGit;
  const svc = new GitService({ sessions: { getLastCwd: () => dir, getSessionLaunchCommand: () => 'powershell.exe' }, runGit, now: () => clock });
  return { svc, cmds, tick: (ms: number) => { clock += ms; } };
}

// @req PERF-GIT-001
test('PERF-GIT-001 AC-6: the base ref comes from the ref files; a known repository costs one git process per summary', async (t) => {
  const { root, cleanup } = tempRoot(); t.after(cleanup);
  const origin = initRepo(path.join(root, 'o'));
  origin.commit('init', { 'a.txt': 'a' });
  repoAt(root).git('clone', '-q', origin.dir, path.join(root, 'c'));
  const c = repoAt(path.join(root, 'c'));
  c.git('checkout', '-q', '-b', 'feat');
  const { svc, cmds, tick } = countingService(c.dir);
  const first = await svc.summary('s');
  assert.ok(first.repo && 'ref' in first.compare && first.compare.ref === 'origin/main', JSON.stringify(first));
  assert.ok(!cmds.includes('for-each-ref') && !cmds.includes('symbolic-ref'), `no ref lookup process: ${cmds.join(',')}`);
  cmds.length = 0;
  tick(2_000);
  await svc.summary('s');
  assert.deepEqual(cmds, ['status'], 'a known repository: status only');
  // packed refs are read too
  c.git('pack-refs', '--all');
  const { svc: svc2, cmds: cmds2 } = countingService(c.dir);
  const packed = await svc2.summary('s');
  assert.ok(packed.repo && 'ref' in packed.compare && packed.compare.ref === 'origin/main');
  assert.ok(!cmds2.includes('for-each-ref'), cmds2.join(','));
});

// @req PERF-GIT-001
test('PERF-GIT-001 AC-7: chip, window and first diff of a working-tree file use at most four git processes after the summary', async (t) => {
  const { root, cleanup } = tempRoot(); t.after(cleanup);
  const r = initRepo(path.join(root, 'r'));
  r.commit('one', { 'a.txt': 'a\nb\n', 'b.txt': 'x\n' });
  r.write('a.txt', 'a\nB\n');
  r.write('b.txt', 'y\n'); r.git('add', 'b.txt');
  const { svc, cmds } = countingService(r.dir);
  await svc.summary('s');
  cmds.length = 0;
  const [log, status] = await Promise.all([svc.log('s', { scope: 'head' }), svc.status('s')]);
  assert.equal(log.commits.length, 1);
  const unstaged = status.files.find((f) => f.area === 'unstaged')!;
  const staged = status.files.find((f) => f.area === 'staged')!;
  assert.equal(unstaged.inputs.old.id, r.git('rev-parse', ':a.txt').trim(), 'index blob id from the status record');
  assert.equal(staged.inputs.old.id, r.git('rev-parse', 'HEAD:b.txt').trim(), 'HEAD blob id from the status record');
  assert.equal(staged.inputs.new.id, r.git('rev-parse', ':b.txt').trim());
  assert.deepEqual([unstaged.add, unstaged.del, staged.add, staged.del], [1, 1, 1, 1]);
  const diff = await svc.diff('s', { src: 'unstaged', path: 'a.txt' });
  assert.equal(diff.inputs.old.id, unstaged.inputs.old.id);
  assert.ok(diff.hunks.length === 1);
  assert.ok(cmds.length <= 4, `processes: ${cmds.join(',')}`);
  for (const avoided of ['ls-files', 'ls-tree', 'rev-parse', 'status']) {
    assert.ok(!cmds.includes(avoided), `${avoided} ran: ${cmds.join(',')}`);
  }
});

// @req PERF-GIT-001
test('PERF-GIT-001 AC-5: a status over 150 ms already refreshes the index; one under it does not', async (t) => {
  const { root, cleanup } = tempRoot(); t.after(cleanup);
  const r = initRepo(path.join(root, 'r'));
  r.commit('init', { 'a.txt': 'a' });
  const base = createGitRunner();
  for (const [took, expected] of [[200, 1], [100, 0]] as const) {
    let clock = 5_000_000;
    const cmds: string[] = [];
    const runGit = (async (...a: Parameters<RunGit>) => {
      const cmd = a[1].find((x) => !x.startsWith('-') && !x.includes('=')) ?? '';
      cmds.push(cmd);
      const out = await base(...a);
      if (cmd === 'status') { clock += took; if (a[2].timing) a[2].timing.ms = took; }
      return out;
    }) as RunGit;
    const svc = new GitService({ sessions: { getLastCwd: () => r.dir, getSessionLaunchCommand: () => 'powershell.exe' }, runGit, now: () => clock });
    await svc.summary('s');
    await new Promise((res) => setTimeout(res, 300));
    assert.equal(cmds.filter((c) => c === 'update-index').length, expected, `status took ${took} ms: ${cmds.join(',')}`);
  }
});

// @req PERF-GIT-001
test('PERF-GIT-001 AC-10: with a quiet file watch the summary starts no git; a change, a failed watch or 30 s run git again', async (t) => {
  const { root, cleanup } = tempRoot(); t.after(cleanup);
  const r = initRepo(path.join(root, 'r'));
  r.commit('init', { 'a.txt': 'a' });
  const base = createGitRunner();
  let clock = 3_000_000;
  const cmds: string[] = [];
  const runGit = (async (...a: Parameters<RunGit>) => {
    const cmd = a[1].find((x) => !x.startsWith('-') && !x.includes('=')) ?? '';
    // The background index refresh (AC-5) is not part of the request; it fires whenever status
    // really takes over 150 ms, which a loaded machine decides.
    if (cmd !== 'update-index') cmds.push(cmd);
    return base(...a);
  }) as RunGit;
  let changed = false;
  let failed = false;
  let watches = 0;
  const watchRepo = () => {
    watches += 1;
    return { takeChanged: () => { const c = changed || failed; changed = false; return c; }, peekChanged: () => changed || failed, failed: () => failed, close: () => {} };
  };
  const svc = new GitService({ sessions: { getLastCwd: () => r.dir, getSessionLaunchCommand: () => 'powershell.exe' }, runGit, now: () => clock, watchRepo });
  const first = await svc.summary('s');
  assert.equal(watches, 1);
  cmds.length = 0;
  clock += 2_000;
  const quiet = await svc.summary('s');
  assert.deepEqual(cmds, [], 'no git while the watch saw nothing');
  assert.equal(quiet.repo && quiet.head, first.repo && first.head);
  assert.equal(quiet.checkedAt, clock, 'the reused summary is stamped as checked now');
  changed = true; clock += 2_000;
  await svc.summary('s');
  assert.deepEqual(cmds, ['status'], `a change runs status: ${cmds.join(',')}`);
  cmds.length = 0; clock += 31_000;
  await svc.summary('s');
  assert.deepEqual(cmds, ['status'], 'after 30 s git checks again');
  cmds.length = 0; failed = true; clock += 2_000;
  await svc.summary('s');
  assert.deepEqual(cmds, ['status'], 'a failed watch never hides a change');
  assert.equal(watches, 2, 'a failed watch is replaced');
});

// @req PERF-GIT-001
test('PERF-GIT-001 AC-10: the file watch sees a real edit in the working tree and in .git', async (t) => {
  if (process.platform !== 'win32') { t.skip('Windows file watch'); return; }
  const { root, cleanup } = tempRoot(); t.after(cleanup);
  const r = initRepo(path.join(root, 'r'));
  r.commit('init', { 'a.txt': 'a' });
  const w = createRepoWatcher()({ kind: 'native', cwd: r.dir }, { root: r.dir, gitDir: path.join(r.dir, '.git'), commonDir: path.join(r.dir, '.git') });
  assert.ok(w, 'a native Windows repository is watched');
  t.after(() => w.close());
  const settle = () => new Promise((res) => setTimeout(res, 400));
  await settle(); w.takeChanged();
  await settle();
  assert.equal(w.takeChanged(), false, 'nothing changed');
  r.write('b.txt', 'b'); await settle();
  assert.equal(w.takeChanged(), true, 'a new file');
  assert.equal(w.takeChanged(), false, 'taken once');
  r.git('branch', 'other'); await settle();
  assert.equal(w.takeChanged(), true, 'a new ref under .git');
  assert.equal(createRepoWatcher()({ kind: 'wsl', cwd: '/home/u/r' }, { root: '/home/u/r', gitDir: '/home/u/r/.git', commonDir: '/home/u/r/.git'  }), null, 'WSL repositories are not watched');
});

// @req PERF-GIT-001
test('PERF-GIT-001 AC-10: a change whose status failed is not answered from the watch; one watch per repository, closed when idle', async (t) => {
  const { root, cleanup } = tempRoot(); t.after(cleanup);
  const r = initRepo(path.join(root, 'r'));
  r.commit('init', { 'a.txt': 'a', 'sub/b.txt': 'b' });
  const base = createGitRunner();
  let clock = 4_000_000;
  let failStatus = false;
  const cmds: string[] = [];
  const runGit = (async (...a: Parameters<RunGit>) => {
    const cmd = a[1].find((x) => !x.startsWith('-') && !x.includes('=')) ?? '';
    cmds.push(cmd);
    if (cmd === 'status' && failStatus) throw new GitError('GIT_TIMEOUT');
    return base(...a);
  }) as RunGit;
  let changed = false;
  let opened = 0;
  let closed = 0;
  const watchRepo = () => {
    opened += 1;
    return { takeChanged: () => { const c = changed; changed = false; return c; }, peekChanged: () => changed, failed: () => false, close: () => { closed += 1; } };
  };
  const cwd: Record<string, string> = { s: r.dir, t: path.join(r.dir, 'sub') };
  const svc = new GitService({ sessions: { getLastCwd: (id: string) => cwd[id] ?? null, getSessionLaunchCommand: () => 'powershell.exe' }, runGit, now: () => clock, watchRepo });
  await svc.summary('s');
  await svc.summary('t');
  assert.equal(opened, 1, 'two folders of one repository share a watch');
  changed = true; failStatus = true; clock += 2_000;
  await assert.rejects(svc.summary('s'));
  failStatus = false; cmds.length = 0; clock += 2_000;
  await svc.summary('s');
  assert.deepEqual(cmds, ['status'], `the failed check is retried, not covered by the watch: ${cmds.join(',')}`);
  clock += 11 * 60_000;
  await svc.summary('s');
  assert.equal(closed, 1, `a watch unused for 10 minutes is closed (opened ${opened})`);
});

// @req PERF-GIT-001
test('PERF-GIT-001 AC-10: a change seen while a status ran is not covered by that older status', async (t) => {
  const { root, cleanup } = tempRoot(); t.after(cleanup);
  const r = initRepo(path.join(root, 'r'));
  r.commit('init', { 'a.txt': 'a', 'sub/b.txt': 'b' });
  const base = createGitRunner();
  let clock = 5_000_000;
  let hold: Promise<void> | null = null;
  const cmds: string[] = [];
  const runGit = (async (...a: Parameters<RunGit>) => {
    const cmd = a[1].find((x) => !x.startsWith('-') && !x.includes('=')) ?? '';
    if (cmd !== 'update-index') cmds.push(`${a[0].cwd.endsWith('sub') ? 't' : 's'}:${cmd}`);
    const out = await base(...a);
    if (cmd === 'status' && hold && !a[0].cwd.endsWith('sub')) await hold;
    return out;
  }) as RunGit;
  let changed = false;
  const watchRepo = () => ({ takeChanged: () => { const c = changed; changed = false; return c; }, peekChanged: () => changed, failed: () => false, close: () => {} });
  const cwd: Record<string, string> = { s: r.dir, t: path.join(r.dir, 'sub') };
  const svc = new GitService({ sessions: { getLastCwd: (id: string) => cwd[id] ?? null, getSessionLaunchCommand: () => 'powershell.exe' }, runGit, now: () => clock, watchRepo });
  await svc.summary('s'); await svc.summary('t');
  // s starts a status (its output read before the edit), the edit lands, t takes the mark.
  let release!: () => void;
  hold = new Promise((res) => { release = res; });
  changed = true; clock += 2_000;
  const sRun = svc.summary('s');
  await new Promise((res) => setTimeout(res, 50));
  changed = true; // the edit, while s's status runs
  await svc.summary('t');
  release(); await sRun; hold = null;
  cmds.length = 0; clock += 2_000;
  await svc.summary('s');
  assert.deepEqual(cmds, ['s:status'], 's asks git again: its last status may predate the edit');
});

// @req PERF-GIT-001
test('PERF-GIT-001 AC-10: a watch whose repository folder is deleted shuts itself down (Windows otherwise fires events without end)', async (t) => {
  if (process.platform !== 'win32') { t.skip('Windows file watch'); return; }
  const { root, cleanup } = tempRoot(); t.after(cleanup);
  const r = initRepo(path.join(root, 'r'));
  r.commit('init', { 'a/b.txt': 'b' });
  const w = createRepoWatcher()({ kind: 'native', cwd: r.dir }, { root: r.dir, gitDir: path.join(r.dir, '.git'), commonDir: path.join(r.dir, '.git') });
  assert.ok(w);
  t.after(() => w.close());
  await new Promise((res) => setTimeout(res, 300));
  rmSync(r.dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  const cpu0 = process.cpuUsage();
  await new Promise((res) => setTimeout(res, 2_000));
  const cpu = process.cpuUsage(cpu0);
  assert.equal(w.failed(), true, 'the watch knows its folder is gone');
  assert.ok((cpu.user + cpu.system) / 1000 < 500, `no event storm: ${Math.round((cpu.user + cpu.system) / 1000)} ms CPU in 2 s`);
});
