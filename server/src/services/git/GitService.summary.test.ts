// FR-GIT-001, FR-GIT-008, PERF-GIT-001: summary of a session's repository, read from real git repositories.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { rmSync } from 'node:fs';
import { GitService } from './GitService.js';
import { createGitRunner, GitError, type RunGit } from './gitRunner.js';
import { initRepo, repoAt, tempRoot } from './testRepo.js';

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
  const lookups = calls.filter((x) => x.cmd === 'symbolic-ref' || x.cmd === 'for-each-ref');
  assert.equal(lookups.length, 1, calls.map((x) => x.cmd).join(','));
  const status = calls.find((x) => x.cmd === 'status')!;
  assert.ok(lookups[0].start < status.end, 'the base lookup starts before status ends');
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
