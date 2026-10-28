// FR-GIT-005 AC-6: the lane graph is drawn at the row's real height, so its lines meet between
// rows on a phone too, where a row is 44 px rather than the desktop's 28 px.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { graphRowHeight } from '../../src/components/Git/gitGraphLayout.ts';

const listSource = readFileSync(new URL('../../src/components/Git/GitGraphList.tsx', import.meta.url), 'utf8');

// @req FR-GIT-005
test('FR-GIT-005 AC-6: the measured row height wins; nothing measured falls back to 28', () => {
  assert.equal(graphRowHeight(44), 44);
  assert.equal(graphRowHeight(43.6), 44);
  assert.equal(graphRowHeight(0), 28);
  assert.equal(graphRowHeight(undefined), 28);
});

// @req FR-GIT-005
test('FR-GIT-005 AC-6: the list measures a row and draws every graph at that height', () => {
  assert.match(listSource, /graphRowHeight\(/);
  assert.match(listSource, /querySelector<HTMLElement>\('\.git-row'\)/);
  assert.match(listSource, /<RowGraph [^>]*h=\{rowH\}/);
});
