// FR-GIT-003: the chip's menu items, and NFR-GIT-001: contrast of the git token pairs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installCatalog } from '../../src/i18n/i18n.ts';
import { buildGitChipMenu } from '../../src/components/Git/gitChipMenu.ts';
import { contrastRatio, parseTokenBlock } from '../../src/components/Git/gitContrast.ts';

const en = JSON.parse(readFileSync(new URL('../../public/locales/messages.en.json', import.meta.url), 'utf8')) as Record<string, string>;
installCatalog('en', en);

const repo = {
  repo: true as const, root: 'C:/r', subdir: '', branch: 'feat/x', detached: false, head: 'b'.repeat(40), upstream: null, ahead: 0, behind: 0,
  base: null, compare: { ref: 'origin/main' } as const, operation: null,
  counts: { staged: 0, unstaged: 2, untracked: 1, conflicted: 0, paths: 3 }, untrackedScan: 'normal' as const, checkedAt: 1,
};
const calls: string[] = [];
const handlers = {
  onOpen: () => calls.push('open'), onOpenWorktree: () => calls.push('wt'), onCompare: () => calls.push('cmp'),
  onCopy: (v: string) => calls.push(`copy:${v}`), onCopyPath: () => calls.push('copyPath'), onPathMenu: () => calls.push('pathMenu'),
};
const labels = (items: ReturnType<typeof buildGitChipMenu>) => items.map((i) => ('separator' in i && i.separator ? '---' : (i as { label: string }).label));

// @req FR-GIT-003
test('FR-GIT-003: menu items, with the uncommitted count and the base name', () => {
  const items = buildGitChipMenu({ summary: repo, cwdHidden: false, ...handlers });
  assert.deepEqual(labels(items), ['Open Git window', 'Show uncommitted changes (3)', 'Compare: origin/main', '---', 'Copy branch name']);
  for (const i of items) if (!('separator' in i && i.separator)) (i as { onClick?: () => void }).onClick?.();
  assert.deepEqual(calls.splice(0), ['open', 'wt', 'cmp', 'copy:feat/x']);
});

// @req FR-GIT-003
test('FR-GIT-003: disabled items stay and say why', () => {
  const clean = buildGitChipMenu({ summary: { ...repo, counts: { ...repo.counts, paths: 0 }, compare: { blocked: 'sameAsBase' } }, cwdHidden: false, ...handlers });
  const wt = clean[1] as { disabled?: boolean; description?: string; label: string };
  assert.deepEqual([wt.label, wt.disabled, wt.description], ['Show uncommitted changes', true, 'No changes']);
  const cmp = clean[2] as { disabled?: boolean; description?: string; label: string };
  assert.deepEqual([cmp.label, cmp.disabled, cmp.description], ['Compare', true, 'The current branch is the base']);
  const noBase = buildGitChipMenu({ summary: { ...repo, compare: { blocked: 'noBase' } }, cwdHidden: false, ...handlers });
  assert.equal((noBase[2] as { description?: string }).description, 'Base branch not found');
  const detached = buildGitChipMenu({ summary: { ...repo, branch: null, detached: true }, cwdHidden: false, ...handlers });
  assert.equal((detached[4] as { label: string }).label, 'Copy commit hash');
  (detached[4] as { onClick: () => void }).onClick();
  assert.deepEqual(calls.splice(0), [`copy:${'b'.repeat(40)}`]);
});

// @req FR-GIT-003
test('FR-GIT-003: when the bar hides the path, its copy and its menu move into the chip menu', () => {
  const items = buildGitChipMenu({ summary: repo, cwdHidden: true, ...handlers });
  assert.deepEqual(labels(items).slice(5), ['---', 'Copy path', 'Path menu…']);
  (items[6] as { onClick: () => void }).onClick();
  (items[7] as { onClick: () => void }).onClick();
  assert.deepEqual(calls.splice(0), ['copyPath', 'pathMenu']);
});

// @req NFR-GIT-001
test('NFR-GIT-001: every git text/background token pair reaches 4.5:1 on chrome and on paper', () => {
  const css = readFileSync(new URL('../../src/styles/tokens.css', import.meta.url), 'utf8');
  const chrome = parseTokenBlock(css, ':root');
  const paper = { ...chrome, ...parseTokenBlock(css, '[data-surface="paper"]') };
  const PAIRS: Array<[string, string]> = [
    ['--fg', '--bg-raised'], ['--fg', '--git-chip-hover'], ['--warn-text', '--bg-raised'], ['--fg-muted', '--bg-raised'],
    ['--git-lineno', '--bg-sunken'], ['--git-lineno', '--diff-add-bg'], ['--git-lineno', '--diff-del-bg'],
    ['--fg', '--diff-add-bg'], ['--fg', '--diff-del-bg'], ['--fg', '--diff-add-word'], ['--fg', '--diff-del-word'],
    ['--diff-hunk-fg', '--diff-hunk-bg'], ['--git-banner-info-fg', '--git-banner-info-bg'], ['--warn-text', '--git-banner-warn-bg'],
    ['--git-ref-local-fg', '--git-ref-local-bg'], ['--git-ref-session-fg', '--git-ref-session-bg'], ['--fg-muted', '--diff-gap-bg'],
  ];
  const failures: string[] = [];
  for (const [surface, tokens, bgFallback] of [['chrome', chrome, '#2b2b2b'], ['paper', paper, '#fbfbfb']] as const) {
    for (const [fg, bg] of PAIRS) {
      if (surface === 'paper' && (fg === '--warn-text' || fg === '--fg-muted')) continue; // UI chrome only
      const r = contrastRatio(tokens[fg], tokens[bg], bgFallback);
      if (!(r >= 4.5)) failures.push(`${surface} ${fg} on ${bg}: ${r.toFixed(2)}`);
    }
  }
  assert.deepEqual(failures, []);
  const r = contrastRatio(chrome['--git-sel-muted'], chrome['--bg-active'], chrome['--bg-surface']);
  assert.ok(r >= 4.5, `selected row secondary text: ${r.toFixed(2)}`);
});
