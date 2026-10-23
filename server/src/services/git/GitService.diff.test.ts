// FR-GIT-007: diff of one file for each source, with the special cases, from real repositories.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { GitService } from './GitService.js';
import { createGitRunner, type GitError } from './gitRunner.js';
import { initRepo, tempRoot, repoAt, type TestRepo } from './testRepo.js';

const svcAt = (cwd: string) => new GitService({
  sessions: { getLastCwd: (id) => (id === 's' ? cwd : null), getSessionLaunchCommand: () => 'powershell.exe' },
  runGit: createGitRunner(),
});
function setup(t: { after: (f: () => void) => void }): { r: TestRepo; svc: GitService; root: string } {
  const { root, cleanup } = tempRoot(); t.after(cleanup);
  const r = initRepo(path.join(root, 'r'));
  return { r, svc: svcAt(r.dir), root };
}
const lines = (n: number, prefix = 'line') => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join('\n') + '\n';

// @req FR-GIT-007
test('FR-GIT-007: unstaged change has hunks and inputs index blob -> working tree', async (t) => {
  const { r, svc } = setup(t);
  r.commit('init', { 'a.ts': lines(30) });
  r.write('a.ts', lines(30).replace('line 15\n', 'line fifteen\n'));
  const d = await svc.diff('s', { src: 'unstaged', path: 'a.ts' });
  assert.equal(d.special, undefined);
  assert.equal(d.hunks.length, 1);
  assert.deepEqual(d.hunks[0].lines.filter((l) => l.k !== ' ').map((l) => [l.k, l.t]), [['-', 'line 15'], ['+', 'line fifteen']]);
  assert.equal(d.inputs.old.id, r.git('rev-parse', ':a.ts').trim());
  assert.equal(d.inputs.new.id, null);
  assert.equal(d.gapAfter, 30 - (d.hunks[0].newStart + d.hunks[0].newLines - 1));
  assert.equal(d.language, 'typescript');
});

// @req FR-GIT-007
test('FR-GIT-007: staged new file, commit (root and normal) and comparison sources', async (t) => {
  const { r, svc, root } = setup(t);
  const c1 = r.commit('one', { 'a.txt': 'a\n' });
  const c2 = r.commit('two', { 'a.txt': 'a\nb\n' });
  r.write('n.txt', 'n1\nn2\n'); r.git('add', 'n.txt');
  const staged = await svc.diff('s', { src: 'staged', path: 'n.txt' });
  assert.deepEqual(staged.hunks[0].lines.map((l) => l.k), ['+', '+']);
  assert.equal(staged.inputs.old.id, null);
  const rootDiff = await svc.diff('s', { src: 'commit', sha: c1, path: 'a.txt' });
  assert.deepEqual(rootDiff.hunks[0].lines.map((l) => [l.k, l.t]), [['+', 'a']]);
  const normal = await svc.diff('s', { src: 'commit', sha: c2, path: 'a.txt' });
  assert.deepEqual(normal.hunks[0].lines.filter((l) => l.k === '+').map((l) => l.t), ['b']);
  assert.equal(normal.inputs.new.id, r.git('rev-parse', `${c2}:a.txt`).trim());

  repoAt(root).git('clone', '-q', r.dir, path.join(root, 'c'));
  const c = repoAt(path.join(root, 'c'));
  c.git('checkout', '-q', '-b', 'feat');
  c.commit('f', { 'a.txt': 'a\nb\nc\n' });
  const cmp = await svcAt(c.dir).diff('s', { src: 'cmp', path: 'a.txt' });
  assert.deepEqual(cmp.hunks[0].lines.filter((l) => l.k === '+').map((l) => l.t), ['c']);
});

// @req FR-GIT-007
test('FR-GIT-007: a renamed file is diffed against its old path', async (t) => {
  const { r, svc } = setup(t);
  r.commit('init', { 'old.txt': lines(20) });
  r.git('mv', 'old.txt', 'new.txt');
  r.write('new.txt', lines(20).replace('line 3\n', 'line three\n'));
  r.git('add', 'new.txt');
  const d = await svc.diff('s', { src: 'staged', path: 'new.txt', origPath: 'old.txt' });
  assert.deepEqual(d.hunks[0].lines.filter((l) => l.k !== ' ').map((l) => l.t), ['line 3', 'line three']);
});

// @req FR-GIT-007
test('FR-GIT-007: untracked files are read directly: text, binary and empty', async (t) => {
  const { r, svc } = setup(t);
  r.commit('init');
  r.write('u.txt', 'u1\nu2\n');
  r.write('u.bin', Buffer.from([1, 0, 2, 0, 3]));
  r.write('empty.txt', '');
  const u = await svc.diff('s', { src: 'untracked', path: 'u.txt' });
  assert.deepEqual(u.hunks[0].lines.map((l) => [l.k, l.n, l.t]), [['+', 1, 'u1'], ['+', 2, 'u2']]);
  assert.equal((await svc.diff('s', { src: 'untracked', path: 'u.bin' })).special?.kind, 'binary');
  assert.equal((await svc.diff('s', { src: 'untracked', path: 'empty.txt' })).special?.kind, 'emptyNew');
});

// @req FR-GIT-007
test('FR-GIT-007: whitespace-only and line-ending-only changes', async (t) => {
  const { r, svc } = setup(t);
  r.commit('init', { 'w.ts': 'if (a) {\n  b();\n}\n', 'e.txt': 'x\ny\nz\n' });
  r.write('w.ts', 'if (a) {\n    b();\n}\n');
  assert.equal((await svc.diff('s', { src: 'unstaged', path: 'w.ts' })).hunks.length, 1);
  assert.equal((await svc.diff('s', { src: 'unstaged', path: 'w.ts', ignoreWs: true })).special?.kind, 'wsOnly');
  r.write('e.txt', 'x\r\ny\r\nz\r\n');
  const eol = await svc.diff('s', { src: 'unstaged', path: 'e.txt' });
  assert.deepEqual(eol.special, { kind: 'eol', from: 'LF', to: 'CRLF', count: 3 });
});

// @req FR-GIT-007
test('FR-GIT-007: mode-only, binary, symbolic link, non-UTF-8 and large changes', async (t) => {
  const { r, svc } = setup(t);
  r.commit('init', { 'run.sh': 'echo\n', 'img.bin': '\u0000a', 'k.txt': Buffer.from([0xb0, 0xa1, 0x0a]).toString('latin1') });
  r.git('update-index', '--chmod=+x', 'run.sh');
  assert.deepEqual((await svc.diff('s', { src: 'staged', path: 'run.sh' })).special, { kind: 'mode', from: '100644', to: '100755' });

  r.write('img.bin', Buffer.from([0, 1, 2, 3, 4, 5]));
  assert.equal((await svc.diff('s', { src: 'unstaged', path: 'img.bin' })).special?.kind, 'binary');

  r.write('target.txt', '../shared/a.json');
  const blob = r.git('hash-object', '-w', 'target.txt').trim();
  r.git('update-index', '--add', '--cacheinfo', `120000,${blob},link`);
  assert.deepEqual((await svc.diff('s', { src: 'staged', path: 'link' })).special, { kind: 'symlink', from: null, to: '../shared/a.json' });

  r.write('k.txt', Buffer.from([0xb0, 0xa1, 0xb0, 0xa2, 0x0a]));
  assert.equal((await svc.diff('s', { src: 'unstaged', path: 'k.txt' })).special?.kind, 'encoding');

  r.commit('big', { 'big.txt': lines(6000) });
  r.write('big.txt', lines(6000, 'changed'));
  const big = await svc.diff('s', { src: 'unstaged', path: 'big.txt' });
  assert.equal(big.special?.kind, 'large');
  assert.equal(big.truncated, true);
  const forced = await svc.diff('s', { src: 'unstaged', path: 'big.txt', force: true });
  assert.equal(forced.special, undefined);
  assert.ok(forced.hunks.length > 0);
});

// @req FR-GIT-007
test('FR-GIT-007: full=1 returns both sides for context expansion', async (t) => {
  const { r, svc } = setup(t);
  r.commit('init', { 'a.txt': 'a\nb\nc\n' });
  r.write('a.txt', 'a\nB\nc\n');
  const d = await svc.diff('s', { src: 'unstaged', path: 'a.txt', full: true });
  assert.deepEqual(d.full, { old: 'a\nb\nc\n', new: 'a\nB\nc\n' });
});

// @req SEC-GIT-001
test('SEC-GIT-001: paths outside the repository or shaped like options are refused', async (t) => {
  const { r, svc } = setup(t);
  r.commit('init', { 'a.txt': 'a' });
  for (const p of ['../x', '-x', '/etc/passwd', 'C:\\x', 'a/../../x', '']) {
    await assert.rejects(svc.diff('s', { src: 'unstaged', path: p }), (e: GitError) => e.code === 'PATH_OUTSIDE_REPO', p);
  }
});
