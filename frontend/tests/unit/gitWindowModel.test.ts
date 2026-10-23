// FR-GIT-004: which Git windows are open, minimized, where new ones go, and what survives a reload.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CASCADE_PX, MAX_OPEN_PER_WORKSPACE, closeGitWindow, emptyGitWindows, minimizeGitWindow, openGitWindow,
  readGitGeometry, restoreGitWindows, serializeGitWindows, writeGitGeometry,
} from '../../src/components/Git/gitWindowModel.ts';

const open = (s: ReturnType<typeof emptyGitWindows>, sessionId: string, now: number, extra: Partial<{ workspaceId: string; repoRoot: string; target: 'auto' | 'worktree' | 'compare' }> = {}) =>
  openGitWindow(s, { sessionId, workspaceId: extra.workspaceId ?? 'w1', repoRoot: extra.repoRoot ?? `C:/r/${sessionId}`, target: extra.target ?? 'auto', now });

// @req FR-GIT-004
test('FR-GIT-004: one window per session; opening again brings it forward, restoring it when minimized', () => {
  let r = open(emptyGitWindows(), 's1', 1);
  assert.equal(r.effect, 'opened');
  r = open(r.state, 's1', 2, { target: 'worktree' });
  assert.equal(r.effect, 'focused');
  assert.equal(r.state.windows.length, 1);
  assert.equal(r.state.windows[0].request.target, 'worktree');
  assert.ok(r.state.windows[0].request.nonce > 0);
  const min = minimizeGitWindow(r.state, 's1');
  assert.equal(min.windows[0].minimized, true);
  r = open(min, 's1', 3);
  assert.equal(r.effect, 'restored');
  assert.equal(r.state.windows[0].minimized, false);
  assert.equal(closeGitWindow(r.state, 's1').windows.length, 0);
});

// @req FR-GIT-004
test('FR-GIT-004: the fifth open window in a workspace minimizes the least recently used one', () => {
  assert.equal(MAX_OPEN_PER_WORKSPACE, 4);
  let s = emptyGitWindows();
  for (const [i, id] of ['a', 'b', 'c', 'd'].entries()) s = open(s, id, i + 1).state;
  s = open(s, 'a', 10).state;
  const r = open(s, 'e', 11);
  assert.equal(r.minimized, 'b');
  assert.deepEqual(r.state.windows.filter((w) => !w.minimized).map((w) => w.sessionId).sort(), ['a', 'c', 'd', 'e']);
  const other = open(r.state, 'x', 12, { workspaceId: 'w2' });
  assert.equal(other.minimized, null, 'another workspace has its own four');
});

// @req FR-GIT-004
test('FR-GIT-004: windows of the same repository cascade by 24px', () => {
  assert.equal(CASCADE_PX, 24);
  let s = open(emptyGitWindows(), 's1', 1, { repoRoot: 'C:/r' }).state;
  s = open(s, 's2', 2, { repoRoot: 'C:/r' }).state;
  s = open(s, 's3', 3, { repoRoot: 'C:/other' }).state;
  assert.deepEqual(s.windows.map((w) => w.cascade), [0, 1, 0]);
});

// @req FR-GIT-004
test('FR-GIT-004: after a reload, windows come back except those of ended sessions', () => {
  let s = open(emptyGitWindows(), 's1', 1).state;
  s = open(s, 's2', 2).state;
  s = minimizeGitWindow(s, 's2');
  const saved = serializeGitWindows(s);
  const back = restoreGitWindows(saved, new Set(['s2']), 100);
  assert.deepEqual(back.windows.map((w) => [w.sessionId, w.minimized]), [['s2', true]]);
  assert.deepEqual(restoreGitWindows('not json', new Set(['s1']), 1).windows, []);
});

// @req FR-GIT-004
test('FR-GIT-004: geometry is kept per repository root', () => {
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
  assert.equal(readGitGeometry(storage, 'C:/r'), null);
  writeGitGeometry(storage, 'C:/r', { rect: { x: 10, y: 20, width: 900, height: 600 }, split: 0.5, filesHeight: 180 });
  assert.deepEqual(readGitGeometry(storage, 'C:/r'), { rect: { x: 10, y: 20, width: 900, height: 600 }, split: 0.5, filesHeight: 180 });
  assert.equal(readGitGeometry(storage, 'C:/other'), null);
  store.set('bg.git.window.v1:C:/bad', '{"rect":{"x":"a"}}');
  assert.equal(readGitGeometry(storage, 'C:/bad'), null, 'invalid records are ignored');
});
