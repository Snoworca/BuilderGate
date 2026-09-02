import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  createWindowDialogBehaviorModel,
  windowDialogTitleText,
} from '../../src/components/dialog/windowDialogModel.ts';

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

// FR-MDE-006 AC-1 -- the unsaved-changes marker.
//
// The `*` is the dialog's to draw. A caller that starred its own title string
// would leave the same fact travelling by two routes, and only one of them
// would be corrected when the marker changed.
test('FR-MDE-006 the dirty prop is what puts the leading marker on the title', () => {
  assert.equal(
    windowDialogTitleText('CLAUDE.md', true),
    '*CLAUDE.md',
    'FR-MDE-006 AC-1: dirty 인 창의 제목에는 선행 * 가 붙어야 한다',
  );
  assert.equal(
    windowDialogTitleText('CLAUDE.md', false),
    'CLAUDE.md',
    'FR-MDE-006 AC-1: dirty 가 아닌 창의 제목에는 * 가 없어야 한다',
  );

  // The six existing modal call sites pass no dirty prop at all. Their titles
  // must come through untouched, which an implementation keyed on truthiness
  // rather than on the value would also satisfy -- so the undefined case is
  // asserted rather than assumed.
  assert.equal(
    windowDialogTitleText('Rename'),
    'Rename',
    'FR-MDE-006: dirty 를 넘기지 않는 기존 호출 지점의 제목은 그대로여야 한다',
  );

  // And the component actually draws that value. Without this the marker
  // function can be correct while the title element still renders the raw prop,
  // which is what the requirement says must not happen.
  // The slice below is trimmed, which drops a carriage return along with the
  // surrounding whitespace, so the file's line endings do not matter here.
  const source = readFileSync(
    new URL('../../src/components/dialog/WindowDialog.tsx', import.meta.url),
    'utf8',
  );

  const titleOpen = source.indexOf('className="window-dialog-title"');
  const titleClose = source.indexOf('</h2>', titleOpen);
  assert.notEqual(titleOpen, -1, 'the title element is gone');
  assert.notEqual(titleClose, -1, 'the title element is gone');

  const rendered = source.slice(source.indexOf('>', titleOpen) + 1, titleClose).trim();
  assert.equal(
    rendered,
    '{windowDialogTitleText(title, dirty)}',
    `FR-MDE-006 AC-1: 제목은 dirty 를 반영한 값을 그려야 하는데 ${rendered} 를 그린다`,
  );
});
