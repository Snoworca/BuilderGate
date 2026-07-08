import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  shouldSuppressTerminalSecondaryButtonEvent,
  suppressTerminalSecondaryButtonEvent,
} from '../../src/utils/terminalPointerPolicy.ts';

test('secondary terminal mouse events are suppressed before xterm can forward them to mouse-aware TUIs', () => {
  const calls: string[] = [];
  const suppressed = suppressTerminalSecondaryButtonEvent({
    button: 2,
    preventDefault: () => calls.push('preventDefault'),
    stopPropagation: () => calls.push('stopPropagation'),
  });

  assert.equal(suppressed, true);
  assert.deepEqual(calls, ['preventDefault', 'stopPropagation']);
});

test('primary and auxiliary terminal mouse events are left available for normal terminal interactions', () => {
  for (const button of [0, 1, 3]) {
    const calls: string[] = [];
    const suppressed = suppressTerminalSecondaryButtonEvent({
      button,
      preventDefault: () => calls.push('preventDefault'),
      stopPropagation: () => calls.push('stopPropagation'),
    });

    assert.equal(suppressed, false, `button ${button}`);
    assert.deepEqual(calls, [], `button ${button}`);
    assert.equal(shouldSuppressTerminalSecondaryButtonEvent(button), button === 2);
  }
});
