// FR-ARCH-009 (#129): a large write only pulls the viewport to the bottom when it was already there.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { isViewportAtBottom } from '../../src/utils/terminalViewportFollow.ts';

const source = readFileSync(new URL('../../src/components/Terminal/TerminalView.tsx', import.meta.url), 'utf8');
const settleAt = source.indexOf('const settleWrite = (accepted: boolean) => {');
const settle = source.slice(settleAt, source.indexOf('scheduleSnapshotSave();', settleAt));

test('FR-ARCH-009 AC-1: a scrolled-up viewport is not at the bottom', () => {
  assert.equal(isViewportAtBottom({ viewportY: 804, baseY: 830 }), false);
  assert.equal(isViewportAtBottom({ viewportY: 0, baseY: 1 }), false);
});

test('FR-ARCH-009 AC-2: a viewport at the bottom, or with no scrollback yet, is at the bottom', () => {
  assert.equal(isViewportAtBottom({ viewportY: 830, baseY: 830 }), true);
  assert.equal(isViewportAtBottom({ viewportY: 0, baseY: 0 }), true);
});

test('FR-ARCH-009 AC-1/AC-2: the large-write sync in TerminalView runs only at the bottom', () => {
  assert.match(settle, /if \(data\.length > LARGE_WRITE_THRESHOLD && isViewportAtBottom\(term\.buffer\.active\)\) \{\s*requestViewportSync\(term\);/);
  assert.doesNotMatch(settle, /if \(data\.length > LARGE_WRITE_THRESHOLD\) \{\s*requestViewportSync/, 'the unconditional sync is gone');
});
