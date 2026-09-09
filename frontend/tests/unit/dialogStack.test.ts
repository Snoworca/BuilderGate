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

import {
  getDialogStackEntries,
  raise,
  raiseDialogById,
  registerDialogStackEntry,
  subscribeDialogStack,
} from '../../src/components/dialog/dialogStack.ts';

test('FR-MDE-003 raise is a no-op for the front-most token and moves the one behind it', () => {
  const disposers: Array<() => void> = [];
  let notifications = 0;
  const unsubscribe = subscribeDialogStack(() => {
    notifications += 1;
  });

  try {
    // The modal is registered between two modeless windows on purpose: a single
    // shared array would leak it into the modeless snapshot below.
    disposers.push(
      registerDialogStackEntry({ token: 'back', dialogId: 'back-window', mode: 'modeless' }),
    );
    disposers.push(
      registerDialogStackEntry({ token: 'middle', dialogId: 'middle-window', mode: 'modeless' }),
    );
    disposers.push(
      registerDialogStackEntry({ token: 'modal', dialogId: 'modal-dialog', mode: 'modal' }),
    );
    disposers.push(
      registerDialogStackEntry({ token: 'front', dialogId: 'front-window', mode: 'modeless' }),
    );

    assert.deepEqual(
      getDialogStackEntries('modeless').map(entry => entry.token),
      ['back', 'middle', 'front'],
    );
    assert.deepEqual(
      getDialogStackEntries('modal').map(entry => entry.token),
      ['modal'],
    );

    // The observation API must hand out a snapshot. If it returned the live
    // array, the before/after comparison below would compare an array with
    // itself and pass no matter what raise did.
    assert.notStrictEqual(getDialogStackEntries('modeless'), getDialogStackEntries('modeless'));

    const before = getDialogStackEntries('modeless');
    notifications = 0;
    raise('front');
    const after = getDialogStackEntries('modeless');

    assert.notStrictEqual(after, before);
    assert.deepEqual(after, before);
    assert.deepEqual(
      after.map(entry => entry.token),
      ['back', 'middle', 'front'],
    );
    assert.equal(after[after.length - 1].token, 'front');
    assert.ok(
      notifications <= 1,
      `raise on the front-most token notified subscribers ${notifications} times, expected at most 1`,
    );

    // Positive control: without it, a raise that does nothing for every token
    // would satisfy every assertion above.
    notifications = 0;
    raise('middle');
    const raised = getDialogStackEntries('modeless');

    assert.deepEqual(
      raised.map(entry => entry.token),
      ['back', 'front', 'middle'],
    );
    assert.ok(
      notifications >= 1,
      'raise on the token behind the front-most one did not notify subscribers',
    );
    assert.deepEqual(createDialogStackState(raised, 'middle'), {
      layerIndex: 2,
      isTopmost: true,
    });

    // The modal is decided inside the modal stack only, so raising a modeless
    // window neither moves it nor unseats it.
    const modalStack = getDialogStackEntries('modal');
    assert.deepEqual(
      modalStack.map(entry => entry.token),
      ['modal'],
    );
    assert.deepEqual(createDialogStackState(modalStack, 'modal'), {
      layerIndex: 0,
      isTopmost: true,
    });
  } finally {
    unsubscribe();
    disposers.forEach(dispose => dispose());
  }
});

test('FR-MDE-003 each registration disposes the entry it added rather than one that shares its token', () => {
  const disposeFirst = registerDialogStackEntry({
    token: 'shared',
    dialogId: 'first-window',
    mode: 'modeless',
  });
  const disposeSecond = registerDialogStackEntry({
    token: 'shared',
    dialogId: 'second-window',
    mode: 'modeless',
  });

  try {
    assert.deepEqual(
      getDialogStackEntries('modeless').map(entry => entry.dialogId),
      ['first-window', 'second-window'],
    );

    disposeSecond();

    assert.deepEqual(
      getDialogStackEntries('modeless').map(entry => entry.dialogId),
      ['first-window'],
    );
  } finally {
    disposeFirst();
    disposeSecond();
  }

  // Both stacks are module-global. A registration left behind here would seed
  // every test added after this one, so the disposal contract is asserted
  // rather than merely exercised.
  assert.deepEqual(getDialogStackEntries('modeless'), []);
  assert.deepEqual(getDialogStackEntries('modal'), []);
});


test('FR-MDE-003 raiseDialogById brings the named window forward and reports an id nobody holds', () => {
  const disposeBack = registerDialogStackEntry({
    token: 'back', dialogId: 'editor-window:/repo/a.md', mode: 'modeless',
  });
  const disposeFront = registerDialogStackEntry({
    token: 'front', dialogId: 'editor-window:/repo/b.md', mode: 'modeless',
  });

  try {
    assert.equal(raiseDialogById('editor-window:/repo/a.md', 'modeless'), true);
    assert.deepEqual(
      getDialogStackEntries('modeless').map(entry => entry.dialogId),
      ['editor-window:/repo/b.md', 'editor-window:/repo/a.md'],
    );

    // An id no dialog is registered under is answered rather than guessed at:
    // a window that has not mounted cannot be brought forward, and a caller
    // that could not tell that from a raise would think it had been.
    assert.equal(raiseDialogById('editor-window:/repo/never-opened.md', 'modeless'), false);
    assert.deepEqual(
      getDialogStackEntries('modeless').map(entry => entry.dialogId),
      ['editor-window:/repo/b.md', 'editor-window:/repo/a.md'],
    );

    // The modal stack is not reachable from here at all -- the parameter type
    // admits only 'modeless' -- so a modal keeps the order that decides which
    // of them owns the focus trap. Asserted through the modeless call so the
    // absence is measured rather than assumed.
    const disposeModal = registerDialogStackEntry({
      token: 'modal', dialogId: 'editor-window:/repo/a.md', mode: 'modal',
    });
    try {
      raiseDialogById('editor-window:/repo/a.md', 'modeless');
      assert.deepEqual(
        getDialogStackEntries('modal').map(entry => entry.token),
        ['modal'],
      );
    } finally {
      disposeModal();
    }
  } finally {
    disposeFront();
    disposeBack();
  }

  assert.deepEqual(getDialogStackEntries('modeless'), []);
  assert.deepEqual(getDialogStackEntries('modal'), []);
});

test('FR-MDE-003 raiseDialogById brings forward the front-most of two dialogs sharing an id', () => {
  // Nothing in the stack forbids two entries under one id. Taking the first
  // match would reach past a dialog the user can already see to one behind it,
  // and answer true either way.
  const disposeBack = registerDialogStackEntry({
    token: 'shared-back', dialogId: 'twin', mode: 'modeless',
  });
  const disposeFront = registerDialogStackEntry({
    token: 'shared-front', dialogId: 'twin', mode: 'modeless',
  });
  const disposeOther = registerDialogStackEntry({
    token: 'other', dialogId: 'other', mode: 'modeless',
  });

  try {
    assert.equal(raiseDialogById('twin', 'modeless'), true);
    assert.deepEqual(
      getDialogStackEntries('modeless').map(entry => entry.token),
      ['shared-back', 'other', 'shared-front'],
    );
  } finally {
    disposeOther();
    disposeFront();
    disposeBack();
  }

  assert.deepEqual(getDialogStackEntries('modeless'), []);
});
