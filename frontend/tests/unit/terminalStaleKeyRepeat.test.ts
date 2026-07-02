import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shouldDropStaleRepeatedTerminalKey } from '../../src/utils/terminalStaleKeyRepeat.ts';

function keyEvent(input: Partial<KeyboardEvent>): Pick<
  KeyboardEvent,
  'altKey' | 'ctrlKey' | 'key' | 'metaKey' | 'repeat' | 'timeStamp'
> {
  return {
    altKey: false,
    ctrlKey: false,
    key: 'Backspace',
    metaKey: false,
    repeat: false,
    timeStamp: 0,
    ...input,
  };
}

test('drops stale repeated Backspace events that were delayed behind output work', () => {
  assert.equal(shouldDropStaleRepeatedTerminalKey({
    event: keyEvent({ key: 'Backspace', repeat: true, timeStamp: 1_000 }),
    now: 1_450,
  }), true);
});

test('drops stale repeated command and navigation keys that can cause delayed terminal actions', () => {
  for (const key of ['Enter', 'Tab', 'Escape', 'Insert', 'Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) {
    assert.equal(shouldDropStaleRepeatedTerminalKey({
      event: keyEvent({ key, repeat: true, timeStamp: 1_000 }),
      now: 1_450,
    }), true, key);
  }
});

test('keeps fresh repeated Backspace events responsive during normal key repeat', () => {
  assert.equal(shouldDropStaleRepeatedTerminalKey({
    event: keyEvent({ key: 'Backspace', repeat: true, timeStamp: 1_000 }),
    now: 1_040,
  }), false);
});

test('keeps non-repeat Backspace and modified shortcuts', () => {
  assert.equal(shouldDropStaleRepeatedTerminalKey({
    event: keyEvent({ key: 'Backspace', repeat: false, timeStamp: 1_000 }),
    now: 1_450,
  }), false);
  assert.equal(shouldDropStaleRepeatedTerminalKey({
    event: keyEvent({ key: 'Backspace', ctrlKey: true, repeat: true, timeStamp: 1_000 }),
    now: 1_450,
  }), false);
});

test('keeps printable repeated keys so text entry is not silently truncated', () => {
  assert.equal(shouldDropStaleRepeatedTerminalKey({
    event: keyEvent({ key: 'a', repeat: true, timeStamp: 1_000 }),
    now: 1_450,
  }), false);
});
