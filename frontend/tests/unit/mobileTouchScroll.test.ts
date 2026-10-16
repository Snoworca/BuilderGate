// FR-ARCH-008: a one-finger drag on a mobile terminal scrolls the way the desktop wheel does.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { panWheelSteps, routeMobilePan } from '../../src/utils/mobileTouchScroll.ts';

test('FR-ARCH-008 AC-1: a normal screen without mouse tracking moves the scrollback', () => {
  assert.equal(routeMobilePan({ bufferType: 'normal', mouseTrackingMode: 'none' }), 'scrollback');
});

test('FR-ARCH-008 AC-2: an alternate screen or mouse tracking goes through the wheel, as on desktop', () => {
  assert.equal(routeMobilePan({ bufferType: 'alternate', mouseTrackingMode: 'none' }), 'wheel');
  for (const mode of ['x10', 'vt200', 'drag', 'any']) {
    assert.equal(routeMobilePan({ bufferType: 'normal', mouseTrackingMode: mode }), 'wheel', mode);
    assert.equal(routeMobilePan({ bufferType: 'alternate', mouseTrackingMode: mode }), 'wheel', mode);
  }
});

test('FR-ARCH-008 AC-2: one line-mode wheel step per row, upward for a downward drag', () => {
  assert.deepEqual(panWheelSteps(3), [-1, -1, -1]);
  assert.deepEqual(panWheelSteps(-2), [1, 1]);
  assert.deepEqual(panWheelSteps(0), []);
});

test('FR-ARCH-008 AC-2: the pan handler routes through routeMobilePan and dispatches line-mode wheel events', () => {
  const source = readFileSync(new URL('../../src/components/Terminal/TerminalView.tsx', import.meta.url), 'utf8');
  const handler = source.slice(source.indexOf('const handleMobileTouchMove'), source.indexOf('const finishMobileTouchGesture'));
  assert.match(handler, /routeMobilePan\(/);
  assert.match(handler, /panWheelSteps\(/);
  assert.match(handler, /new WheelEvent\('wheel'/);
  assert.match(handler, /deltaMode: WheelEvent\.DOM_DELTA_LINE/);
});
