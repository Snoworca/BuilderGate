// SEC-GIT-001, FR-GIT-001..008: the git routes over real HTTP on real repositories.
// Run: cwd=server/, npm run test:git
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import { createGitRoutes } from './gitRoutes.js';
import { GitService } from '../services/git/GitService.js';
import { createGitRunner } from '../services/git/gitRunner.js';
import { initRepo, tempRoot, type TestRepo } from '../services/git/testRepo.js';
import { withLocalHttpServer } from '../testing/localHttpTestServer.js';

async function withRoutes(cwd: string, run: (get: (p: string) => Promise<{ status: number; body: any }>) => Promise<void>) {
  const service = new GitService({
    sessions: { getLastCwd: (id) => (id === 's1' ? cwd : null), getSessionLaunchCommand: () => 'powershell.exe' },
    runGit: createGitRunner(),
  });
  const app = express();
  app.use('/api/sessions', createGitRoutes(service));
  await withLocalHttpServer(app, async (fx) => {
    await run(async (p) => {
      const r = await fx.request({ method: 'GET', path: p });
      return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
    });
  });
}

function sample(t: { after: (f: () => void) => void }): { r: TestRepo; sha: string } {
  const { root, cleanup } = tempRoot(); t.after(cleanup);
  const r = initRepo(path.join(root, 'r'));
  r.commit('one', { 'a.txt': 'a\n' });
  const sha = r.commit('two', { 'a.txt': 'a\nb\n' });
  r.write('a.txt', 'a\nb\nc\n');
  return { r, sha };
}

// @req FR-GIT-001
test('FR-GIT-001..007: every route answers for a repository session', async (t) => {
  const { r, sha } = sample(t);
  await withRoutes(r.dir, async (get) => {
    const summary = await get('/api/sessions/s1/git/summary');
    assert.equal(summary.status, 200);
    assert.equal(summary.body.repo, true);
    assert.equal(summary.body.counts.unstaged, 1);
    const status = await get('/api/sessions/s1/git/status');
    assert.equal(status.status, 200);
    assert.equal(status.body.files[0].path, 'a.txt');
    const log = await get('/api/sessions/s1/git/log?scope=head&limit=1');
    assert.equal(log.status, 200);
    assert.equal(log.body.commits[0].sha, sha);
    assert.equal(log.body.hasMore, true);
    const commit = await get(`/api/sessions/s1/git/commit/${sha}`);
    assert.equal(commit.status, 200);
    assert.deepEqual(commit.body.files.map((f: { path: string }) => f.path), ['a.txt']);
    const diff = await get('/api/sessions/s1/git/diff?src=unstaged&path=a.txt');
    assert.equal(diff.status, 200);
    assert.ok(diff.body.hunks.length > 0);
    const cmp = await get('/api/sessions/s1/git/compare');
    assert.equal(cmp.status, 404);
    assert.equal(cmp.body.error.code, 'BASE_NOT_FOUND');
  });
});

// @req SEC-GIT-001
test('SEC-GIT-001: inputs are validated before git runs', async (t) => {
  const { r } = sample(t);
  await withRoutes(r.dir, async (get) => {
    const bad: Array<[string, string]> = [
      ['/api/sessions/s1/git/log?scope=everything', 'INVALID_INPUT'],
      ['/api/sessions/s1/git/log?limit=abc', 'INVALID_INPUT'],
      ['/api/sessions/s1/git/log?after=--all', 'INVALID_INPUT'],
      ['/api/sessions/s1/git/commit/--output=x', 'INVALID_INPUT'],
      ['/api/sessions/s1/git/diff?src=nope&path=a.txt', 'INVALID_INPUT'],
      ['/api/sessions/s1/git/diff?src=unstaged', 'PATH_OUTSIDE_REPO'],
      ['/api/sessions/s1/git/diff?src=unstaged&path=../x', 'PATH_OUTSIDE_REPO'],
      ['/api/sessions/s1/git/diff?src=unstaged&path=-x', 'PATH_OUTSIDE_REPO'],
      ['/api/sessions/s1/git/diff?src=unstaged&path=a.txt&origPath=../y', 'PATH_OUTSIDE_REPO'],
      ['/api/sessions/s1/git/diff?src=commit&path=a.txt', 'INVALID_INPUT'],
    ];
    for (const [p, code] of bad) {
      const res = await get(p);
      assert.equal(res.status, 400, p);
      assert.equal(res.body.error.code, code, p);
    }
    const missing = await get('/api/sessions/nope/git/summary');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'SESSION_NOT_FOUND');
    const unknownSha = await get('/api/sessions/s1/git/commit/0123456789abcdef');
    assert.equal(unknownSha.body.error.code, 'COMMIT_NOT_FOUND');
  });
});

// @req SEC-GIT-001
test('SEC-GIT-001: fsmonitor, external diff and textconv set by the repository do not run; a clean filter does (residual risk)', async (t) => {
  const { root, cleanup } = tempRoot(); t.after(cleanup);
  const r = initRepo(path.join(root, 'r'));
  const marker = (name: string) => path.join(r.dir, `${name}.marker`);
  const script = (name: string, body: string) => {
    r.write(`.hooks/${name}.sh`, `#!/bin/sh\necho x > "${marker(name).replace(/\\/g, '/')}"\n${body}\n`);
    return `sh ${path.join(r.dir, '.hooks', `${name}.sh`).replace(/\\/g, '/')}`;
  };
  r.write('.gitattributes', '*.txt diff=marker\n*.dat filter=mark\n');
  r.commit('init', { 'a.txt': 'a\n', 'b.dat': 'b\n' });
  r.git('config', 'core.fsmonitor', script('fsmonitor', 'exit 1'));
  r.git('config', 'diff.external', script('external', 'exit 0'));
  r.git('config', 'diff.marker.textconv', script('textconv', 'cat "$1"'));
  r.git('config', 'filter.mark.clean', script('clean', 'cat'));
  r.write('a.txt', 'a\nchanged\n');
  r.write('b.dat', 'b\nchanged\n');

  // Control: plain git runs what the repository configured.
  r.gitMayFail('status');
  r.gitMayFail('diff');
  r.gitMayFail('diff', '--no-ext-diff', '--textconv', '--', 'a.txt');
  const control = ['fsmonitor', 'external', 'textconv', 'clean'].filter((n) => existsSync(marker(n)));
  for (const n of ['fsmonitor', 'external', 'textconv', 'clean']) rmSync(marker(n), { force: true });
  r.gitMayFail('update-index', '--really-refresh');
  for (const n of ['fsmonitor', 'external', 'textconv', 'clean']) rmSync(marker(n), { force: true });
  r.write('a.txt', 'a\nchanged again\n');
  r.write('b.dat', 'b\nchanged again\n');

  await withRoutes(r.dir, async (get) => {
    assert.equal((await get('/api/sessions/s1/git/summary')).status, 200);
    assert.equal((await get('/api/sessions/s1/git/status')).status, 200);
    assert.equal((await get('/api/sessions/s1/git/diff?src=unstaged&path=a.txt')).status, 200);
    assert.equal((await get('/api/sessions/s1/git/diff?src=unstaged&path=b.dat')).status, 200);
  });
  for (const n of ['fsmonitor', 'external', 'textconv']) {
    assert.ok(control.includes(n), `control: plain git must run the configured ${n} (otherwise this check proves nothing); ran: ${control.join(', ')}`);
    assert.equal(existsSync(marker(n)), false, `${n} must not run`);
  }
  // Measured residual risk: status normalises the working tree file through the clean filter.
  assert.equal(existsSync(marker('clean')), true, 'the clean filter runs (documented residual risk, SEC-GIT-001 AC-3)');
});
