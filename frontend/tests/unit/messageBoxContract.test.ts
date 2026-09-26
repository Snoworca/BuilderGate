import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMessageBoxViewModel } from '../../src/components/dialog/messageBoxModel.ts';

test('message box contract supplies default labels and primary OK variant', () => {
  assert.deepEqual(
    createMessageBoxViewModel({}),
    {
      okLabel: '확인',
      cancelLabel: '취소',
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
    okLabel: '항목 삭제',
    cancelLabel: '남겨두기',
    okVariant: 'danger',
  });

  assert.equal(model.okLabel, '항목 삭제');
  assert.equal(model.cancelLabel, '남겨두기');
  assert.equal(model.okVariant, 'danger');
});
