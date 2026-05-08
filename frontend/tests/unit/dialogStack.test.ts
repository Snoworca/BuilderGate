import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDialogStackState } from '../../src/components/dialog/dialogStack.ts';
import type { DialogStackEntry } from '../../src/components/dialog/dialogStack.ts';

test('second active modal is topmost', () => {
  const entries: DialogStackEntry[] = [
    { token: 'first', dialogId: 'first-dialog', active: true },
    { token: 'second', dialogId: 'second-dialog', active: true },
  ];

  assert.deepEqual(createDialogStackState(entries, 'first'), {
    layerIndex: 0,
    isTopmost: false,
  });
  assert.deepEqual(createDialogStackState(entries, 'second'), {
    layerIndex: 1,
    isTopmost: true,
  });
});

test('removing a middle entry preserves the remaining topmost calculation', () => {
  const entries: DialogStackEntry[] = [
    { token: 'first', dialogId: 'first-dialog', active: true },
    { token: 'third', dialogId: 'third-dialog', active: true },
  ];

  assert.deepEqual(createDialogStackState(entries, 'third'), {
    layerIndex: 1,
    isTopmost: true,
  });
});

test('inactive entries do not affect active modal layer order', () => {
  const entries: DialogStackEntry[] = [
    { token: 'modeless', dialogId: 'modeless-dialog', active: false },
    { token: 'modal', dialogId: 'modal-dialog', active: true },
  ];

  assert.deepEqual(createDialogStackState(entries, 'modeless'), {
    layerIndex: 0,
    isTopmost: false,
  });
  assert.deepEqual(createDialogStackState(entries, 'modal'), {
    layerIndex: 0,
    isTopmost: true,
  });
});
