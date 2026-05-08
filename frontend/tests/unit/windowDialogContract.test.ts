import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWindowDialogBehaviorModel } from '../../src/components/dialog/windowDialogModel.ts';

test('window dialog behavior defaults preserve the existing dialog contract', () => {
  assert.deepEqual(
    createWindowDialogBehaviorModel({ layerIndex: 0 }),
    {
      role: 'dialog',
      showCloseButton: true,
      resizable: true,
      persistGeometry: true,
      layerZ: 5000,
      backdropZ: 5000,
      dialogZ: 5001,
    },
  );
});

test('window dialog behavior reflects disabled close, resize, and persistence props', () => {
  const model = createWindowDialogBehaviorModel({
    layerIndex: 1,
    showCloseButton: false,
    resizable: false,
    persistGeometry: false,
    role: 'alertdialog',
  });

  assert.equal(model.role, 'alertdialog');
  assert.equal(model.showCloseButton, false);
  assert.equal(model.resizable, false);
  assert.equal(model.persistGeometry, false);
});

test('window dialog behavior uses deterministic z-index layers', () => {
  assert.deepEqual(
    createWindowDialogBehaviorModel({ layerIndex: 2 }),
    {
      role: 'dialog',
      showCloseButton: true,
      resizable: true,
      persistGeometry: true,
      layerZ: 5040,
      backdropZ: 5040,
      dialogZ: 5041,
    },
  );
});
