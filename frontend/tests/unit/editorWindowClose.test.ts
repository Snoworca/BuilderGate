import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  decideEditorWindowClosePrompt,
  resolveEditorWindowCloseChoice,
  resolveEditorWindowSaveOnClose,
} from '../../src/components/editor/editorWindowClose.ts';
import { createEditorWindowSaveController } from '../../src/components/editor/editorWindowSave.ts';

// FR-MDE-006 AC-8 / AC-9 / AC-10 — the close branch table.
//
// The two prompts are different questions, not one question with a button
// greyed out: one asks whether to save, the other states that saving is
// impossible and asks whether to discard.

function dirtyControllerBoundTo(sessionId: string | undefined) {
  const writes: string[] = [];
  const controller = createEditorWindowSaveController({
    binding: { tabId: 'tab-1', filePath: '/repo/CLAUDE.md' },
    bodyAtOpen: 'before\n',
    deps: {
      resolveTabSession: () => sessionId,
      writeFile: async (session: string, path: string, content: string) => {
        writes.push(`${session}|${path}|${content}`);
        return { success: true };
      },
    },
  });
  controller.handleEditorChange('unsaved work\n');
  return { controller, writes };
}

test('FR-MDE-006 a dirty window with a live tab asks the three-choice prompt', async () => {
  const prompt = decideEditorWindowClosePrompt({ dirty: true, tabClosed: false });

  assert.equal(
    prompt.kind,
    'unsaved-changes',
    'FR-MDE-006 AC-8: dirty 이고 저장 가능하면 저장 여부를 묻는 확인이 떠야 한다',
  );
  assert.deepEqual(
    prompt.choices,
    ['save', 'discard', 'cancel'],
    'FR-MDE-006 AC-8: 갈래가 저장 · 저장 안 함 · 취소 셋이어야 한다',
  );
  assert.match(
    prompt.message,
    /저장하시겠습니까\?/,
    'FR-MDE-006 AC-8: 저장 여부를 묻는 문구여야 한다',
  );

  // 저장 안 함은 닫는다.
  assert.deepEqual(
    resolveEditorWindowCloseChoice(prompt, 'discard'),
    { kind: 'close' },
    'FR-MDE-006 AC-8: 저장 안 함은 창을 닫아야 한다',
  );
  // 취소는 dirty 를 유지한 채 창을 남긴다.
  assert.deepEqual(
    resolveEditorWindowCloseChoice(prompt, 'cancel'),
    { kind: 'stay' },
    'FR-MDE-006 AC-8: 취소는 창을 남겨야 한다',
  );
  // 저장은 먼저 쓰기를 시도한다.
  assert.deepEqual(
    resolveEditorWindowCloseChoice(prompt, 'save'),
    { kind: 'save-then-close' },
    'FR-MDE-006 AC-8: 저장은 쓰기를 먼저 시도해야 한다',
  );

  // 취소한 창은 dirty 그대로다.
  const { controller } = dirtyControllerBoundTo('S1');
  assert.equal(
    controller.isDirty(),
    true,
    'FR-MDE-006 AC-8: 취소한 창은 dirty 가 유지되어야 한다',
  );

  // 쓰기가 실패하면 창이 열린 채 배너가 남는다.
  const failing = createEditorWindowSaveController({
    binding: { tabId: 'tab-1', filePath: '/repo/CLAUDE.md' },
    bodyAtOpen: 'before\n',
    deps: {
      resolveTabSession: () => 'S1',
      writeFile: async () => {
        throw new Error('ENOSPC: no space left on device');
      },
    },
  });
  failing.handleEditorChange('unsaved work\n');
  const failedOutcome = await failing.save();
  assert.deepEqual(
    resolveEditorWindowSaveOnClose(failedOutcome),
    { kind: 'stay' },
    'FR-MDE-006 AC-8: 저장이 실패하면 창이 열린 채로 남아야 한다',
  );
  assert.match(failing.getError() ?? '', /ENOSPC/);
  assert.equal(failing.isDirty(), true);

  // 쓰기가 성공하면 닫는다.
  const { controller: saving } = dirtyControllerBoundTo('S1');
  assert.deepEqual(
    resolveEditorWindowSaveOnClose(await saving.save()),
    { kind: 'close' },
    'FR-MDE-006 AC-8: 저장이 성공하면 창을 닫아야 한다',
  );
});

test('FR-MDE-006 a dirty window whose tab closed asks the cannot-save prompt', async () => {
  const cannotSave = decideEditorWindowClosePrompt({ dirty: true, tabClosed: true });
  const threeChoice = decideEditorWindowClosePrompt({ dirty: true, tabClosed: false });

  assert.equal(
    cannotSave.kind,
    'cannot-save',
    'FR-MDE-006 AC-9: 결속된 탭이 닫힌 dirty 창에는 저장 불가 확인이 떠야 한다',
  );
  // `threeChoice` alone: `cannotSave` is settled by the assertion above, which
  // `assert/strict` carries an assertion signature for.
  if (threeChoice.kind === 'none') {
    assert.fail('FR-MDE-006 AC-9: 두 분기 모두 확인을 띄워야 한다');
  }

  // 두 확인은 서로 다른 질문이다. 같은 확인에서 저장 갈래만 비활성화한 것이
  // 아니라는 사실을 세 축으로 고정한다.
  assert.notEqual(
    cannotSave.kind,
    threeChoice.kind,
    'FR-MDE-006 AC-9: 저장 불가 확인은 세 갈래 확인과 다른 분기여야 한다',
  );
  assert.notEqual(
    cannotSave.message,
    threeChoice.message,
    'FR-MDE-006 AC-9: 두 확인의 문구가 달라야 한다',
  );
  assert.deepEqual(
    cannotSave.choices,
    ['discard', 'cancel'],
    'FR-MDE-006 AC-9: 저장 불가 확인에는 저장 갈래가 없어야 한다',
  );
  assert.match(
    cannotSave.message,
    /저장할 수 없습니다\. 그래도 닫으시겠습니까\?/,
    'FR-MDE-006 AC-9: 저장이 불가능함을 알리고 버릴지 묻는 문구여야 한다',
  );

  // 그 상태에서 저장 버튼과 Ctrl+S 는 쓰기를 내지 않는다. 둘 다 같은 저장 함수를
  // 부르므로 그 함수가 쓰기를 내지 않는 것으로 판정한다.
  const { controller, writes } = dirtyControllerBoundTo(undefined);
  const outcome = await controller.save();
  assert.deepEqual(
    outcome,
    { status: 'no-session' },
    'FR-MDE-006 AC-9: 탭이 닫힌 창의 저장은 세션을 얻지 못해야 한다',
  );
  assert.deepEqual(
    writes,
    [],
    'FR-MDE-006 AC-9: 탭이 닫힌 창에서는 쓰기가 나가면 안 된다',
  );
  assert.equal(
    controller.isDirty(),
    true,
    'FR-MDE-006 AC-9: 쓰지 못한 본문은 dirty 로 남아야 한다',
  );
});

test('FR-MDE-006 a clean window closes with no prompt', () => {
  for (const tabClosed of [false, true]) {
    const prompt = decideEditorWindowClosePrompt({ dirty: false, tabClosed });
    assert.deepEqual(
      prompt,
      { kind: 'none' },
      `FR-MDE-006 AC-10: dirty 가 아니면 확인 없이 닫아야 한다 (tabClosed=${tabClosed})`,
    );
    assert.deepEqual(
      resolveEditorWindowCloseChoice(prompt, 'discard'),
      { kind: 'close' },
      'FR-MDE-006 AC-10: 확인이 없는 분기는 곧바로 닫아야 한다',
    );
  }
});
