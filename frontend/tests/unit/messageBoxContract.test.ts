import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMessageBoxViewModel } from '../../src/components/dialog/messageBoxModel.ts';

test('message box contract supplies default labels and primary OK variant', () => {
  assert.deepEqual(
    createMessageBoxViewModel({}),
    {
      okLabel: 'OK',
      cancelLabel: 'Cancel',
      okVariant: 'primary',
      isBusy: false,
      role: 'alertdialog',
      showCloseButton: false,
      resizable: false,
      persistGeometry: false,
    },
  );
});

test('message box contract exposes busy state for disabled buttons', () => {
  assert.equal(createMessageBoxViewModel({ busy: true }).isBusy, true);
});

test('message box contract preserves danger variant and custom labels', () => {
  const model = createMessageBoxViewModel({
    okLabel: 'Delete',
    cancelLabel: 'Keep',
    okVariant: 'danger',
  });

  assert.equal(model.okLabel, 'Delete');
  assert.equal(model.cancelLabel, 'Keep');
  assert.equal(model.okVariant, 'danger');
});
