import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  COMPOSER_DEFAULT_HEIGHT_PX,
  COMPOSER_HISTORY_LIMIT,
  COMPOSER_LINE_HEIGHT_PX,
  COMPOSER_MIN_HEIGHT_PX,
  COMPOSER_MIN_TERMINAL_ROWS,
  NOT_BROWSING_HISTORY,
  applyContinueLine,
  clampComposerHeight,
  composerEnterDelayMs,
  composerLayoutHeight,
  composerSendErrorKey,
  countDraftLines,
  countVisualLines,
  decideComposerEnter,
  decideComposerShortcut,
  estimateTerminalRowPx,
  historyCaret,
  isCaretOnFirstLine,
  isImeComposingKey,
  isSendableDraft,
  navigateComposerHistory,
  pushComposerHistory,
  type ComposerKeyInput,
} from '../../src/components/Terminal/sessionComposerModel.ts';

function key(overrides: Partial<ComposerKeyInput> = {}): ComposerKeyInput {
  return {
    key: 'Enter',
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    isComposing: false,
    keyCode: 13,
    ...overrides,
  };
}

function enter(overrides: Partial<ComposerKeyInput> = {}, value = 'hello', mobile = false, caret = value.length) {
  return decideComposerEnter({ event: key(overrides), mobile, value, selectionStart: caret, selectionEnd: caret });
}

// FR-CMP-003 AC-1: the desktop keys.
test('FR-CMP-003 AC-1: desktop Enter sends', () => {
  assert.equal(enter(), 'send');
});

test('FR-CMP-003 AC-1: desktop Ctrl+Enter and Cmd+Enter send', () => {
  assert.equal(enter({ ctrlKey: true }), 'send');
  assert.equal(enter({ metaKey: true }), 'send');
});

test('FR-CMP-003 AC-1: Shift+Enter is left to the textarea, which inserts a newline', () => {
  assert.equal(enter({ shiftKey: true }), 'native');
});

test('FR-CMP-003 AC-1: Enter after a backslash at the end of a line continues the line', () => {
  assert.equal(enter({}, 'first line \\'), 'continue-line');
  // The backslash ends the first of two lines; the caret is on it.
  assert.equal(enter({}, 'one \\\ntwo', false, 'one \\'.length), 'continue-line');
});

test('FR-CMP-003 AC-1: a backslash that is not right before the caret at a line end does not continue', () => {
  assert.equal(enter({}, 'a \\ b'), 'send');
  // Caret right after the backslash but text follows on the same line.
  assert.equal(enter({}, 'a \\b', false, 'a \\'.length), 'send');
  // A selection is not a caret.
  assert.equal(
    decideComposerEnter({ event: key(), mobile: false, value: 'abc\\', selectionStart: 0, selectionEnd: 4 }),
    'send',
  );
});

test('FR-CMP-003 AC-1: continuing removes the backslash and puts the caret on the new line', () => {
  assert.deepEqual(applyContinueLine('do this \\', 'do this \\'.length), { value: 'do this \n', caret: 'do this \n'.length });
  assert.deepEqual(applyContinueLine('a \\\nb', 'a \\'.length), { value: 'a \n\nb', caret: 'a \n'.length });
});

test('FR-CMP-003 AC-1: on mobile Enter is a newline; nothing sends from the keyboard', () => {
  assert.equal(enter({}, 'hello', true), 'native');
  assert.equal(enter({ ctrlKey: true }, 'hello', true), 'native');
  assert.equal(enter({}, 'line \\', true), 'native');
});

test('FR-CMP-003 AC-2: an Enter that confirms an IME composition never sends', () => {
  assert.equal(enter({ isComposing: true }), 'native');
  assert.equal(enter({ keyCode: 229 }), 'native');
  assert.equal(enter({ isComposing: true, ctrlKey: true }), 'native');
  assert.equal(isImeComposingKey(key({ isComposing: true })), true);
  assert.equal(isImeComposingKey(key({ keyCode: 229 })), true);
  assert.equal(isImeComposingKey(key()), false);
});

test('FR-CMP-003 AC-1: keys other than Enter are left alone', () => {
  assert.equal(enter({ key: 'a' }), 'native');
  assert.equal(enter({ altKey: true }), 'native');
});

test('FR-CMP-003 AC-2: a whitespace-only draft is not sendable', () => {
  assert.equal(isSendableDraft(''), false);
  assert.equal(isSendableDraft('  \n\t '), false);
  assert.equal(isSendableDraft(' x '), true);
});

// FR-CMP-002 AC-1: the height limits.
const tile = { tileHeight: 600, reservedPx: 28, terminalRowPx: 17, mobile: false };

test('FR-CMP-002 AC-1: the height never goes below one line', () => {
  assert.equal(clampComposerHeight({ ...tile, requested: 0 }), COMPOSER_MIN_HEIGHT_PX);
  assert.equal(clampComposerHeight({ ...tile, requested: -100 }), COMPOSER_MIN_HEIGHT_PX);
  assert.equal(COMPOSER_MIN_HEIGHT_PX, composerLayoutHeight({ chosenHeight: 1000, lineCount: 1 }));
});

test('FR-CMP-002 AC-1: the height never goes above half the tile', () => {
  assert.equal(clampComposerHeight({ ...tile, requested: 10_000 }), 300);
  assert.equal(clampComposerHeight({ ...tile, requested: 200 }), 200);
});

test('FR-CMP-002 AC-1: the terminal keeps at least six rows', () => {
  // 240 tile, 28 row, 6 x 20 = 120 terminal: 240 - 28 - 120 = 92 < 120 (half).
  const small = { tileHeight: 240, reservedPx: 28, terminalRowPx: 20, mobile: false };
  assert.equal(COMPOSER_MIN_TERMINAL_ROWS, 6);
  assert.equal(clampComposerHeight({ ...small, requested: 10_000 }), 92);
});

test('FR-CMP-002 AC-1: in a tile too small for both, one line still wins', () => {
  const tiny = { tileHeight: 120, reservedPx: 28, terminalRowPx: 20, mobile: false };
  assert.equal(clampComposerHeight({ ...tiny, requested: 10_000 }), COMPOSER_MIN_HEIGHT_PX);
});

test('FR-CMP-002 AC-1: on mobile the cap is 35% of the tile', () => {
  assert.equal(clampComposerHeight({ ...tile, mobile: true, requested: 10_000 }), 210);
});

test('FR-CMP-002 AC-1: an unmeasured tile (0 px) leaves the request within the one-line floor', () => {
  assert.equal(clampComposerHeight({ ...tile, tileHeight: 0, requested: 200 }), 200);
});

test('FR-CMP-002 AC-1: the default height is inside the limits of an ordinary tile', () => {
  assert.equal(clampComposerHeight({ ...tile, requested: COMPOSER_DEFAULT_HEIGHT_PX }), COMPOSER_DEFAULT_HEIGHT_PX);
});

test('FR-CMP-002 AC-2: a short draft is shorter than the chosen height; a long one stops at it', () => {
  const one = composerLayoutHeight({ chosenHeight: 200, lineCount: 1 });
  const three = composerLayoutHeight({ chosenHeight: 200, lineCount: 3 });
  assert.equal(three - one, 2 * COMPOSER_LINE_HEIGHT_PX);
  assert.equal(composerLayoutHeight({ chosenHeight: 200, lineCount: 50 }), 200);
});

test('FR-CMP-002 AC-2: lines are counted by line breaks', () => {
  assert.equal(countDraftLines(''), 1);
  assert.equal(countDraftLines('a'), 1);
  assert.equal(countDraftLines('a\nb\n'), 3);
});

test('FR-CMP-002 AC-1: the terminal row height follows the stored font size', () => {
  assert.equal(estimateTerminalRowPx(null), 17);
  assert.equal(estimateTerminalRowPx('20'), 24);
  assert.equal(estimateTerminalRowPx('nonsense'), 17);
});

// FR-CMP-003 AC-5: history.
test('FR-CMP-003 AC-5: the caret is on the first line until a line break precedes it', () => {
  assert.equal(isCaretOnFirstLine('abc', 3), true);
  assert.equal(isCaretOnFirstLine('a\nb', 1), true);
  assert.equal(isCaretOnFirstLine('a\nb', 2), false);
});

const history = ['first', 'second', 'third'];

test('FR-CMP-003 AC-5: Up on an empty draft brings the newest entry, then older ones', () => {
  const one = navigateComposerHistory({ history, draft: '', browse: NOT_BROWSING_HISTORY, direction: 'prev', caretOnFirstLine: true });
  assert.ok(one.handled);
  assert.equal(one.draft, 'third');
  const two = navigateComposerHistory({ history, draft: one.draft, browse: one.browse, direction: 'prev', caretOnFirstLine: true });
  assert.ok(two.handled);
  assert.equal(two.draft, 'second');
  const three = navigateComposerHistory({ history, draft: two.draft, browse: two.browse, direction: 'prev', caretOnFirstLine: true });
  const four = three.handled
    ? navigateComposerHistory({ history, draft: three.draft, browse: three.browse, direction: 'prev', caretOnFirstLine: true })
    : three;
  assert.ok(four.handled);
  assert.equal(four.draft, 'first', 'stays on the oldest');
});

test('FR-CMP-003 AC-5: Down past the newest brings back the draft that was there', () => {
  const up = navigateComposerHistory({ history, draft: '', browse: NOT_BROWSING_HISTORY, direction: 'prev', caretOnFirstLine: true });
  assert.ok(up.handled);
  const down = navigateComposerHistory({ history, draft: up.draft, browse: up.browse, direction: 'next', caretOnFirstLine: true });
  assert.ok(down.handled);
  assert.equal(down.draft, '');
  assert.deepEqual(down.browse, NOT_BROWSING_HISTORY);
});

test('FR-CMP-003 AC-5: Up does nothing on a non-empty draft that is not a recalled entry', () => {
  const result = navigateComposerHistory({ history, draft: 'typing', browse: NOT_BROWSING_HISTORY, direction: 'prev', caretOnFirstLine: true });
  assert.equal(result.handled, false);
});

test('FR-CMP-003 AC-5: Up and Down off the first line are ordinary caret moves', () => {
  const browse = { index: 1, stash: '' };
  assert.equal(navigateComposerHistory({ history, draft: 'a\nb', browse, direction: 'prev', caretOnFirstLine: false }).handled, false);
  assert.equal(navigateComposerHistory({ history, draft: 'a\nb', browse, direction: 'next', caretOnFirstLine: false }).handled, false);
});

test('FR-CMP-003 AC-5: Down when not browsing is an ordinary caret move', () => {
  assert.equal(navigateComposerHistory({ history, draft: '', browse: NOT_BROWSING_HISTORY, direction: 'next', caretOnFirstLine: true }).handled, false);
});

test('FR-CMP-003 AC-5: an empty history leaves Up alone', () => {
  assert.equal(navigateComposerHistory({ history: [], draft: '', browse: NOT_BROWSING_HISTORY, direction: 'prev', caretOnFirstLine: true }).handled, false);
});

test('FR-CMP-003 AC-5: a recalled entry puts the caret at the end of its first line', () => {
  assert.equal(historyCaret('abc'), 3);
  assert.equal(historyCaret('ab\ncd'), 2);
});

test('FR-CMP-003 AC-5: the history keeps the last 50 and drops a repeat of the newest', () => {
  assert.equal(COMPOSER_HISTORY_LIMIT, 50);
  let list: readonly string[] = [];
  for (let i = 0; i < 60; i += 1) list = pushComposerHistory(list, `m${i}`);
  assert.equal(list.length, 50);
  assert.equal(list[0], 'm10');
  assert.equal(list[49], 'm59');
  assert.deepEqual(pushComposerHistory(['a', 'b'], 'b'), ['a', 'b']);
});

// FR-CMP-001 AC-3: the three-step shortcut.
test('FR-CMP-001 AC-3: closed -> open and focus; open with the terminal focused -> focus; focused -> close', () => {
  assert.equal(decideComposerShortcut({ open: false, composerFocused: false }), 'open-and-focus');
  assert.equal(decideComposerShortcut({ open: true, composerFocused: false }), 'focus-composer');
  assert.equal(decideComposerShortcut({ open: true, composerFocused: true }), 'close');
});

// FR-CMP-003 AC-3: the Enter follows the paste after the server's submit delay.
test('FR-CMP-003 AC-3: the Enter waits like the server submit: 1000 ms + 50 ms per started KB, at most 10 s', () => {
  assert.equal(composerEnterDelayMs('hi'), 1050);
  assert.equal(composerEnterDelayMs('x'.repeat(1025)), 1100);
  assert.equal(composerEnterDelayMs('x'.repeat(10_000_000)), 10_000);
});

// FR-CMP-003 AC-4: the error line.
test('FR-CMP-003 AC-4: paste refusals map to their own messages; anything else is a general failure', () => {
  assert.equal(composerSendErrorKey('paste-too-large'), 'composer.error.tooLarge');
  assert.equal(composerSendErrorKey('unsupported-multiline-paste'), 'composer.error.multiline');
  assert.equal(composerSendErrorKey('context-changed'), 'composer.error.unavailable');
  assert.equal(composerSendErrorKey('session-closed'), 'composer.error.unavailable');
});

test('FR-CMP-002 AC-2: a long line that wraps on screen counts as the lines it takes', () => {
  // padding 2+2, line height 20: one line is 24 px of scroll height, three wrapped lines 64.
  assert.equal(countVisualLines({ draft: 'x'.repeat(300), scrollHeight: 64, paddingY: 4, lineHeightPx: 20 }), 3);
  // never fewer than the hard line breaks, never fewer than one.
  assert.equal(countVisualLines({ draft: 'a\nb\nc', scrollHeight: 0, paddingY: 4, lineHeightPx: 20 }), 3);
  assert.equal(countVisualLines({ draft: '', scrollHeight: 24, paddingY: 4, lineHeightPx: 20 }), 1);
  assert.equal(countVisualLines({ draft: 'x', scrollHeight: 30, paddingY: 4, lineHeightPx: 0 }), 1);
});
