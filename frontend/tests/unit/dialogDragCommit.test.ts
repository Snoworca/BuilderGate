import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isDialogRectMoved } from '../../src/components/dialog/dialogDragCommit.ts';

// FR-MDE-001 — which of `Rnd`'s drag reports is a move the user made.
//
// `Rnd` reports a drag stop for a press on its handle even when nothing moved,
// and the editor's title bar is that handle: every press of 저장, 최대화 and
// 최소화 lands on it. The report that follows carries the rect the window
// already had, and the host reads an arriving rect as "the user placed this
// window" -- which sends the placement back to `floating` and undoes what the
// button just did.

const RECT = { x: 302, y: 155, width: 896, height: 504 };

test('FR-MDE-001 the move test runs with no DOM in scope', () => {
  assert.equal(typeof (globalThis as { document?: unknown }).document, 'undefined');
  isDialogRectMoved(RECT, RECT);
});

test('FR-MDE-001 a rect equal to the one in hand is not a move', () => {
  assert.equal(isDialogRectMoved(RECT, { ...RECT }), false);

  // Compared field by field rather than by identity: `Rnd` hands back a fresh
  // object every time, so an identity check would call every report a move.
  assert.equal(isDialogRectMoved(RECT, {
    x: RECT.x, y: RECT.y, width: RECT.width, height: RECT.height,
  }), false);
});

test('FR-MDE-001 a change in any one field is a move', () => {
  // Each axis alone, so a comparison that dropped one of the four is caught.
  assert.equal(isDialogRectMoved(RECT, { ...RECT, x: RECT.x + 1 }), true);
  assert.equal(isDialogRectMoved(RECT, { ...RECT, y: RECT.y + 1 }), true);
  assert.equal(isDialogRectMoved(RECT, { ...RECT, width: RECT.width + 1 }), true);
  assert.equal(isDialogRectMoved(RECT, { ...RECT, height: RECT.height + 1 }), true);

  // A pixel is a move. Nothing here rounds: a drag that moved the window by one
  // pixel is still the user placing it, and a threshold would be a number
  // nobody chose.
  assert.equal(isDialogRectMoved(RECT, { ...RECT, x: RECT.x - 1 }), true);
});

test('FR-MDE-001 no previous rect makes any report a move', () => {
  // The window has been given nothing to compare against, so there is no basis
  // for calling the report redundant. Answering false here would swallow the
  // first placement a window ever receives.
  assert.equal(isDialogRectMoved(null, RECT), true);
});
