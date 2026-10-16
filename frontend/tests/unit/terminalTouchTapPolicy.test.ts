// FR-ARCH-010: touch opens the terminal keyboard only on a short tap.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  TOUCH_TAP_MOVE_TOLERANCE_PX,
  createTouchTapTracker,
  shouldFocusTerminalOnPointerDown,
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
