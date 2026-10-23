// FR-GIT-001, FR-GIT-002: what the branch chip shows at each width stage, and relative times.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHIP_STAGES,
  availableChipWidth,
  chipView,
  midTrunc,
  nameMaxWidth,
  stageFor,
  type ChipSummary,
} from '../../src/components/Git/gitChipModel.ts';
import { formatRelativeTime } from '../../src/utils/relativeTime.ts';

const base: ChipSummary = {
  branch: 'feat/git-graph', detached: false, head: 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0',
  upstream: 'origin/feat/git-graph', ahead: 2, behind: 1, base: null, operation: null,
  paths: 3, untrackedScan: 'normal', stale: false,
};

// @req FR-GIT-002
test('FR-GIT-002: seven stages by the width left after the session name', () => {
  assert.deepEqual(CHIP_STAGES.map((s) => s.min), [460, 390, 300, 260, 200, 150, 0]);
  const cases: Array<[number, number]> = [[460, 0], [459, 1], [390, 1], [389, 2], [300, 2], [299, 3], [260, 3], [259, 4], [200, 4], [199, 5], [150, 5], [149, 6], [-20, 6]];
  for (const [w, s] of cases) assert.equal(stageFor(w), s, String(w));
  assert.equal(availableChipWidth(700, 90), 700 - 4 - 90 - 16);
  assert.equal(availableChipWidth(700, 400), 700 - 4 - 150 - 16, 'the name never takes more than 150px');
});

// @req FR-GIT-002
test('FR-GIT-002: ±8px hysteresis keeps the stage at an edge', () => {
  assert.equal(stageFor(455, 1), 1);
  assert.equal(stageFor(455, 0), 0);
  assert.equal(stageFor(451, 0), 1);
  assert.equal(stageFor(395, 2), 2);
  assert.equal(stageFor(380, 1), 2);
});

// @req FR-GIT-002
test('FR-GIT-002: the session name shrinks only at the last stage, to 40px at least', () => {
  assert.equal(nameMaxWidth(5, 300), 150);
  assert.equal(nameMaxWidth(6, 300), 150);
  assert.equal(nameMaxWidth(6, 180), 180 - 4 - 16 - 74);
  assert.equal(nameMaxWidth(6, 100), 40);
});

// @req FR-GIT-002
test('FR-GIT-002: branch names shorten in the middle, keeping the prefix and the end', () => {
  assert.equal(midTrunc('main', 14), 'main');
  assert.equal(midTrunc('release/0.10.x', 14), 'release/0.10.x');
  assert.equal(midTrunc('feat/git-graph-lanes', 14), 'feat/…ph-lanes');
  assert.equal(midTrunc('codex/fix-terminal-resize-on-reveal', 20), 'codex/…ize-on-reveal');
  assert.equal(midTrunc('codex/fix-terminal-resize-on-reveal', 14), 'codex/…-reveal');
  assert.equal(midTrunc('hotfix-issue-163-cwd', 14), '…issue-163-cwd');
  assert.equal(midTrunc('users/beom/very-long-experiment', 10), 'users/…ent');
  assert.equal(midTrunc('anything', 0), '');
  for (const n of [10, 14, 20, 28]) assert.ok(midTrunc('a-very-long-branch-name-without-prefix', n).length <= n);
});

// @req FR-GIT-001, FR-GIT-002
test('FR-GIT-001/002: what each stage shows', () => {
  const v0 = chipView(base, 0, true);
  assert.deepEqual([v0.branch, v0.dirty, v0.ahead, v0.showCwd, v0.showTime], ['feat/git-graph', '●3', { text: '↑2↓1', base: false }, true, true]);
  const v1 = chipView(base, 1, true);
  assert.deepEqual([v1.ahead?.text, v1.showCwd], ['↑2', true]);
  const v2 = chipView(base, 2, true);
  assert.deepEqual([v2.showCwd, v2.showTime], [false, true]);
  assert.equal(chipView(base, 4, true).showTime, false);
  const v5 = chipView(base, 5, true);
  assert.deepEqual([v5.branch, v5.ahead], ['feat/…raph', null]);
  const v6 = chipView(base, 6, true);
  assert.deepEqual([v6.branch, v6.dirty], ['', '●3']);
  // Outside a repository the row keeps its path and time at every width.
  assert.deepEqual([chipView(null, 6, false).showCwd, chipView(null, 6, false).showTime], [true, true]);
});

// @req FR-GIT-001
test('FR-GIT-001: detached HEAD, operations, base-relative ahead, stale, large counts', () => {
  const d = chipView({ ...base, branch: null, detached: true, upstream: null, ahead: 0, behind: 0 }, 1, true);
  assert.deepEqual([d.branch, d.tone, d.icon], ['a1b2c3d', 'warn', 'commit']);
  const r = chipView({ ...base, operation: { kind: 'rebase', step: 3, total: 7 } }, 0, true);
  assert.deepEqual([r.operation, r.tone], [{ kind: 'rebase', step: 3, total: 7 }, 'warn']);
  assert.equal(chipView({ ...base, operation: { kind: 'merge' } }, 5, true).operation, null, 'operation text hides from stage 5');
  const b = chipView({ ...base, upstream: null, ahead: 0, behind: 0, base: { ref: 'origin/main', ahead: 3 } }, 0, true);
  assert.deepEqual(b.ahead, { text: '≈↑3', base: true });
  assert.equal(chipView({ ...base, stale: true }, 0, true).tone, 'stale');
  assert.equal(chipView({ ...base, paths: 120 }, 0, true).dirty, '●99+');
  assert.equal(chipView({ ...base, untrackedScan: 'off' }, 0, true).dirty, '●3+');
  assert.equal(chipView({ ...base, paths: 0 }, 0, true).dirty, '');
});

// @req NFR-GIT-002
test('NFR-GIT-002: relative times come from Intl in the active language', () => {
  const now = Date.parse('2026-10-23T10:05:00Z');
  const rt = (ms: number, lang = 'en') => formatRelativeTime(now - ms, now, lang, 'just now');
  assert.equal(rt(3_000), 'just now');
  assert.equal(rt(45_000), '45 seconds ago');
  assert.equal(rt(3 * 60_000), '3 minutes ago');
  assert.equal(rt(2 * 3_600_000), '2 hours ago');
  assert.equal(rt(86_400_000), 'yesterday');
  assert.equal(rt(86_400_000, 'ko'), '어제');
  assert.equal(rt(8 * 86_400_000), new Intl.DateTimeFormat('en', { month: 'numeric', day: 'numeric' }).format(now - 8 * 86_400_000));
  assert.equal(rt(400 * 86_400_000), new Intl.DateTimeFormat('en', { year: 'numeric', month: 'numeric', day: 'numeric' }).format(now - 400 * 86_400_000));
});
