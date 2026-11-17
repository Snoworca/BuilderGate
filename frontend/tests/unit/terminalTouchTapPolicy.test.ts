// FR-ARCH-010: touch opens the terminal keyboard only on a short tap.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  INPUT_LINE_TAP_ROWS,
  TOUCH_TAP_MOVE_TOLERANCE_PX,
  createTouchTapTracker,
  readTerminalTapRows,
  shouldFocusTerminalOnPointerDown,
  shouldTapOpenKeyboard,
} from '../../src/utils/terminalTouchTapPolicy.ts';

const at = (clientX: number, clientY: number) => ({ clientX, clientY });

test('FR-ARCH-010 AC-1/AC-6: only touch defers focus away from pointerdown', () => {
  assert.equal(shouldFocusTerminalOnPointerDown('touch'), false);
  assert.equal(shouldFocusTerminalOnPointerDown('mouse'), true);
  assert.equal(shouldFocusTerminalOnPointerDown('pen'), true);
  assert.equal(shouldFocusTerminalOnPointerDown(''), true);
  assert.equal(shouldFocusTerminalOnPointerDown(undefined), true);
});

test('FR-ARCH-010 AC-3: a single contact that stays inside the tolerance is a tap', () => {
  const tracker = createTouchTapTracker();
  tracker.touchStart([at(100, 200)]);
  tracker.touchMove([at(100 + TOUCH_TAP_MOVE_TOLERANCE_PX, 200)]);
  assert.equal(tracker.consumeTap(), true);
});

test('FR-ARCH-010 AC-3: a tap is consumed once, so a second click without a new contact does not focus', () => {
  const tracker = createTouchTapTracker();
  tracker.touchStart([at(10, 10)]);
  assert.equal(tracker.consumeTap(), true);
  assert.equal(tracker.consumeTap(), false);
});

test('FR-ARCH-010 AC-2: a contact that pans past the tolerance is not a tap', () => {
  const tracker = createTouchTapTracker();
  tracker.touchStart([at(100, 200)]);
  tracker.touchMove([at(100, 200 + TOUCH_TAP_MOVE_TOLERANCE_PX + 1)]);
  // Coming back to the start point does not turn the pan back into a tap.
  tracker.touchMove([at(100, 200)]);
  assert.equal(tracker.consumeTap(), false);
});

test('FR-ARCH-010 AC-4: a second contact (pinch) is not a tap', () => {
  const tracker = createTouchTapTracker();
  tracker.touchStart([at(100, 200)]);
  tracker.touchStart([at(100, 200), at(150, 260)]);
  assert.equal(tracker.consumeTap(), false);

  const moved = createTouchTapTracker();
  moved.touchStart([at(100, 200)]);
  moved.touchMove([at(100, 200), at(150, 260)]);
  assert.equal(moved.consumeTap(), false);
});

test('FR-ARCH-010 AC-5: a long press is not a tap', () => {
  const tracker = createTouchTapTracker();
  tracker.touchStart([at(100, 200)]);
  tracker.longPress();
  assert.equal(tracker.consumeTap(), false);
});

test('FR-ARCH-010: a new single contact after a gesture starts a fresh tap decision', () => {
  const tracker = createTouchTapTracker();
  tracker.touchStart([at(0, 0)]);
  tracker.touchMove([at(0, 50)]);
  tracker.touchStart([at(30, 30)]);
  assert.equal(tracker.consumeTap(), true);
});

test('FR-ARCH-010: a click with no recorded contact is not a tap', () => {
  assert.equal(createTouchTapTracker().consumeTap(), false);
});

test('FR-ARCH-010 AC-8: with mouse tracking and the keyboard down, only a tap on the input line opens the keyboard', () => {
  assert.equal(INPUT_LINE_TAP_ROWS, 1);
  const down = { mouseTracking: true, keyboardUp: false };
  assert.equal(shouldTapOpenKeyboard({ ...down, rows: { tapRow: 10, cursorRow: 30 } }), false, 'a choice far above the input line');
  assert.equal(shouldTapOpenKeyboard({ ...down, rows: { tapRow: 29, cursorRow: 30 } }), true, 'the border line next to the caret');
  assert.equal(shouldTapOpenKeyboard({ ...down, rows: { tapRow: 30, cursorRow: 30 } }), true, 'the caret line itself');
  assert.equal(shouldTapOpenKeyboard({ ...down, rows: { tapRow: 32, cursorRow: 30 } }), false, 'two rows below');
});

test('FR-ARCH-010 AC-8: every tap opens the keyboard as before without mouse tracking, with the keyboard up, or with no rows', () => {
  const far = { tapRow: 0, cursorRow: 30 };
  assert.equal(shouldTapOpenKeyboard({ mouseTracking: false, keyboardUp: false, rows: far }), true, 'a plain shell');
  assert.equal(shouldTapOpenKeyboard({ mouseTracking: true, keyboardUp: true, rows: far }), true, 'the keyboard is already up');
  assert.equal(shouldTapOpenKeyboard({ mouseTracking: true, keyboardUp: false, rows: null }), true, 'the tap could not be placed');
});

test('FR-ARCH-010 AC-8: the tap row and the cursor row are both counted from the top of the visible screen', () => {
  const screen = { getBoundingClientRect: () => ({ left: 0, top: 100, width: 800, height: 400 }) };
  const term = {
    cols: 80,
    rows: 20,
    element: { querySelector: (selector: string) => (selector === '.xterm-screen' ? screen : null) },
    buffer: { active: { baseY: 50, viewportY: 50, cursorY: 18 } },
  };
  // 20 px rows from y = 100: y = 145 is row 2.
  assert.deepEqual(readTerminalTapRows(term, 40, 145), { tapRow: 2, cursorRow: 18 });
  // Scrolled up five rows: the cursor is five rows lower on the screen (off it).
  assert.deepEqual(readTerminalTapRows({ ...term, buffer: { active: { baseY: 50, viewportY: 45, cursorY: 18 } } }, 40, 145), { tapRow: 2, cursorRow: 23 });
  assert.equal(readTerminalTapRows(term, 40, 90), null, 'above the screen');
  assert.equal(readTerminalTapRows({ ...term, element: undefined }, 40, 145), null, 'not mounted');
});
