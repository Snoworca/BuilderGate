// FR-GIT-005, FR-GIT-006, FR-GIT-008: status files, log, commit detail and base comparison from real repositories.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { GitService } from './GitService.js';
import { createGitRunner, type GitError } from './gitRunner.js';
import { initRepo, repoAt, tempRoot, type TestRepo } from './testRepo.js';

const svcAt = (cwd: string) => new GitService({
  sessions: { getLastCwd: (id) => (id === 's' ? cwd : null), getSessionLaunchCommand: () => 'powershell.exe' },
  runGit: createGitRunner(),
});

// @req FR-GIT-006
test('FR-GIT-006: status lists per-area files with counts and the inputs that identify each side', async (t) => {
  const { root, cleanup } = tempRoot(); t.after(cleanup);
  const r = initRepo(path.join(root, 'r'));
  r.commit('init', { 'a.txt': 'one\n', 'old.txt': 'x\ny\nz\n' });
  r.write('a.txt', 'one\ntwo\n'); r.git('add', 'a.txt'); r.write('a.txt', 'one\ntwo\nthree\n');
  r.git('mv', 'old.txt', 'new.txt');
  r.write('n.txt', 'l1\nl2\n');
  const st = await svcAt(r.dir).status('s');
  const by = (p: string, area: string) => st.files.find((f) => f.path === p && f.area === area);
  const staged = by('a.txt', 'staged');
  const unstaged = by('a.txt', 'unstaged');
  assert.ok(staged && unstaged);
  assert.deepEqual([staged.kind, staged.add, staged.del], ['M', 1, 0]);
  assert.deepEqual([unstaged.kind, unstaged.add, unstaged.del], ['M', 1, 0]);
  const headBlob = r.git('rev-parse', 'HEAD:a.txt').trim();
  const indexBlob = r.git('rev-parse', ':a.txt').trim();
  assert.equal(staged.inputs.old.id, headBlob);
  assert.equal(staged.inputs.new.id, indexBlob);
  assert.equal(unstaged.inputs.old.id, indexBlob);
  assert.equal(unstaged.inputs.new.id, null);
  assert.equal(unstaged.inputs.new.size, 'one\ntwo\nthree\n'.length);
  assert.equal(typeof unstaged.inputs.new.mtimeMs, 'number');
  const renamed = by('new.txt', 'staged');
  assert.deepEqual([renamed?.kind, renamed?.origPath], ['R', 'old.txt']);
  const untracked = by('n.txt', 'untracked');
  assert.deepEqual([untracked?.kind, untracked?.add, untracked?.binary], ['?', 2, false]);
  assert.equal(st.truncated, false);
});

function history(root: string): { r: TestRepo; shas: Record<string, string> } {
  const r = initRepo(path.join(root, 'r'));
  const shas: Record<string, string> = {};
  shas.c1 = r.commit('c1', { 'a.txt': '1' });
  r.git('checkout', '-q', '-b', 'side');
  shas.s1 = r.commit('s1', { 's.txt': 's' });
  r.git('checkout', '-q', 'main');
  shas.c2 = r.commit('c2', { 'a.txt': '2' });
  r.git('merge', '-q', '--no-ff', '-m', 'merge side', 'side');
  shas.m = r.git('rev-parse', 'HEAD').trim();
  shas.c3 = r.commit('c3', { 'a.txt': '3' });
  r.git('tag', 'v1', shas.c2);
  return { r, shas };
}

// @req FR-GIT-005
test('FR-GIT-005: log of the current branch in topological order with refs, parents and a cursor', async (t) => {
  const { root, cleanup } = tempRoot(); t.after(cleanup);
  const { r, shas } = history(root);
  const svc = svcAt(r.dir);
  const all = await svc.log('s', { scope: 'head', limit: 200 });
  assert.equal(all.commits.length, 5);
  assert.equal(all.hasMore, false);
  assert.equal(all.commits[0].sha, shas.c3);
  assert.deepEqual(all.commits[0].refs, [{ kind: 'head', name: 'main' }]);
  const merge = all.commits.find((c) => c.sha === shas.m);
  assert.deepEqual(merge?.parents, [shas.c2, shas.s1]);
  assert.ok(all.commits.find((c) => c.sha === shas.c2)?.refs.some((x) => x.kind === 'tag' && x.name === 'v1'));
  assert.equal(all.shallow, false);

  const page1 = await svc.log('s', { scope: 'head', limit: 2 });
  assert.deepEqual(page1.commits.map((c) => c.sha), all.commits.slice(0, 2).map((c) => c.sha));
  assert.equal(page1.hasMore, true);
  const page2 = await svc.log('s', { scope: 'head', limit: 2, after: page1.commits[1].sha });
  assert.deepEqual(page2.commits.map((c) => c.sha), all.commits.slice(2, 4).map((c) => c.sha));
});

// @req FR-GIT-005
test('FR-GIT-005: all branches include branches HEAD cannot reach', async (t) => {
  const { root, cleanup } = tempRoot(); t.after(cleanup);
  const r = initRepo(path.join(root, 'r'));
  r.commit('c1');
  r.git('checkout', '-q', '-b', 'other');
  const other = r.commit('o1');
  r.git('checkout', '-q', 'main');
  r.commit('c2');
  const svc = svcAt(r.dir);
  assert.ok(!(await svc.log('s', { scope: 'head', limit: 50 })).commits.some((c) => c.sha === other));
  assert.ok((await svc.log('s', { scope: 'all', limit: 50 })).commits.some((c) => c.sha === other));
});

// @req FR-GIT-005
test('FR-GIT-005: an empty repository has no commits; a shallow clone says so', async (t) => {
  const { root, cleanup } = tempRoot(); t.after(cleanup);
  const empty = initRepo(path.join(root, 'empty'));
  const e = await svcAt(empty.dir).log('s', { scope: 'head', limit: 10 });
  assert.deepEqual([e.commits.length, e.noCommits], [0, true]);

  const { r } = history(root);
  repoAt(root).git('clone', '-q', '--depth', '1', `file://${r.dir.replace(/\\/g, '/')}`, path.join(root, 'shallow'));
  const s = await svcAt(path.join(root, 'shallow')).log('s', { scope: 'head', limit: 10 });
  assert.equal(s.shallow, true);
  assert.equal(s.commits.length, 1);
});

// @req FR-GIT-006
test('FR-GIT-006: commit detail: message, root against an empty tree, merge against the first parent, renames', async (t) => {
  const { root, cleanup } = tempRoot(); t.after(cleanup);
  const { r, shas } = history(root);
  const svc = svcAt(r.dir);
  const rootCommit = await svc.commit('s', shas.c1);
  assert.equal(rootCommit.parents.length, 0);
  assert.deepEqual(rootCommit.files.map((f) => [f.kind, f.path, f.add]), [['A', 'a.txt', 1]]);
  const merge = await svc.commit('s', shas.m);
  assert.deepEqual(merge.files.map((f) => [f.kind, f.path]), [['A', 's.txt']], 'first parent: only what the side branch brought');
  assert.match(merge.message, /merge side/);

  r.git('mv', 'a.txt', 'b.txt');
  r.git('commit', '-q', '-m', 'rename');
  const rename = await svc.commit('s', r.git('rev-parse', 'HEAD').trim());
  assert.deepEqual(rename.files.map((f) => [f.kind, f.origPath, f.path, f.similarity]), [['R', 'a.txt', 'b.txt', 100]]);

  await assert.rejects(svc.commit('s', 'deadbeefdeadbeef'), (e: GitError) => e.code === 'COMMIT_NOT_FOUND');
});

// @req FR-GIT-008
test('FR-GIT-008: compare against the detected base; with wt=1 uncommitted and untracked files join', async (t) => {
  const { root, cleanup } = tempRoot(); t.after(cleanup);
  const origin = initRepo(path.join(root, 'origin'));
  origin.commit('o1', { 'a.txt': '1' });
  repoAt(root).git('clone', '-q', origin.dir, path.join(root, 'c'));
  const c = repoAt(path.join(root, 'c'));
  c.git('checkout', '-q', '-b', 'feat');
  c.commit('f1', { 'f.txt': 'f\n' });
  c.commit('f2', { 'a.txt': '2\n' });
  c.write('u.txt', 'u\n');
  const svc = svcAt(c.dir);
  const cmp = await svc.compare('s', { wt: false });
  assert.equal(cmp.base.ref, 'origin/main');
  assert.equal(cmp.commits.length, 2);
  assert.deepEqual(cmp.files.map((f) => [f.kind, f.path]).sort(), [['A', 'f.txt'], ['M', 'a.txt']].sort());
  const withWt = await svc.compare('s', { wt: true });
  assert.ok(withWt.files.some((f) => f.path === 'u.txt' && f.kind === 'A'));
  assert.ok(typeof cmp.fetchedAt === 'number' || cmp.fetchedAt === null);
});

// @req FR-GIT-008
test('FR-GIT-008: base detection follows origin/HEAD first, and no base is BASE_NOT_FOUND', async (t) => {
  const { root, cleanup } = tempRoot(); t.after(cleanup);
  const origin = initRepo(path.join(root, 'origin'));
  origin.commit('o1');
  origin.git('branch', '-m', 'develop');
  repoAt(root).git('clone', '-q', origin.dir, path.join(root, 'c'));
  const c = repoAt(path.join(root, 'c'));
  c.git('checkout', '-q', '-b', 'feat');
  c.commit('f1');
  assert.equal((await svcAt(c.dir).compare('s', { wt: false })).base.ref, 'origin/develop');

  const lone = initRepo(path.join(root, 'lone'));
  lone.git('checkout', '-q', '-b', 'trunk');
  lone.commit('t1');
  await assert.rejects(svcAt(lone.dir).compare('s', { wt: false }), (e: GitError) => e.code === 'BASE_NOT_FOUND');
});

// @req FR-GIT-005
test('FR-GIT-005: all branches lists the HEAD of other sessions in the same repository', async (t) => {
  const { root, cleanup } = tempRoot(); t.after(cleanup);
  const r = initRepo(path.join(root, 'r'));
  r.commit('c1');
  r.git('worktree', 'add', '-q', '-b', 'wtb', path.join(root, 'wt'));
  const wt = repoAt(path.join(root, 'wt'));
  const wtHead = wt.commit('w1');
  const other = initRepo(path.join(root, 'other'));
  other.commit('x');
  const cwd: Record<string, string> = { s: r.dir, w: wt.dir, o: other.dir };
  const svc = new GitService({
    sessions: { getLastCwd: (id) => cwd[id] ?? null, getSessionLaunchCommand: () => 'powershell.exe' },
    runGit: createGitRunner(),
    listSessionIds: () => Object.keys(cwd),
  });
  const log = await svc.log('s', { scope: 'all', limit: 50 });
  assert.deepEqual(log.sessions, [{ sessionId: 'w', head: wtHead }]);
  assert.deepEqual((await svc.log('s', { scope: 'head', limit: 50 })).sessions, []);
});
