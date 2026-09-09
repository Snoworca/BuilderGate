import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createEditorWindowSaveShortcutHandler,
  decideEditorWindowSaveShortcut,
} from '../../src/components/editor/editorWindowSaveShortcut.ts';
import { createEditorWindowSaveController } from '../../src/components/editor/editorWindowSave.ts';

// FR-MDE-006 AC-2 / AC-3 — which window a Ctrl+S writes.
//
// DOM focus decides, not the modeless stack. The two disagree exactly in the
// case the tray creates: a window restored from the tray is frontmost while the
// keyboard still belongs elsewhere, and writing on stack order would overwrite
// a file the user believed they were not touching.

interface WindowFixture {
  documentId: string;
  stackOrder: number;
  focused: boolean;
  controller: ReturnType<typeof createEditorWindowSaveController>;
  writes: string[];
}

function windowFixture(
  documentId: string,
  sessionId: string,
  stackOrder: number,
): WindowFixture {
  const writes: string[] = [];
  const controller = createEditorWindowSaveController({
    binding: { tabId: `tab-for-${documentId}`, filePath: documentId },
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
  return { documentId, stackOrder, focused: false, controller, writes };
}

function ctrlS() {
  let prevented = 0;
  return {
    event: {
      key: 's',
      ctrlKey: true,
      metaKey: false,
      preventDefault: () => {
        prevented += 1;
      },
    },
    preventedCount: () => prevented,
  };
}

function handlerOver(fixtures: WindowFixture[]) {
  const pending: Promise<unknown>[] = [];
  const handle = createEditorWindowSaveShortcutHandler({
    listWindows: () => fixtures.map((fixture) => ({
      documentId: fixture.documentId,
      focused: fixture.focused,
      stackOrder: fixture.stackOrder,
    })),
    save: (documentId: string) => {
      const target = fixtures.find((fixture) => fixture.documentId === documentId);
      assert.ok(target, `저장 대상을 찾지 못했다: ${documentId}`);
      pending.push(target.controller.save());
    },
  });
  return { handle, settle: () => Promise.all(pending) };
}

test('FR-MDE-006 the shortcut writes the focused window, not the front-most one', async () => {
  const windowA = windowFixture('/repo/a/CLAUDE.md', 'S-A', 1);
  const windowB = windowFixture('/repo/b/AGENTS.md', 'S-B', 9);

  // A 가 포커스를 갖고, B 가 dirty 이면서 모달리스 스택의 맨 앞이다.
  windowA.focused = true;
  windowB.focused = false;
  assert.ok(
    windowB.stackOrder > windowA.stackOrder,
    'FR-MDE-006 AC-2: B 가 맨 앞이어야 이 시나리오가 성립한다',
  );
  assert.equal(windowB.controller.isDirty(), true);

  const decision = decideEditorWindowSaveShortcut({
    event: { key: 's', ctrlKey: true, metaKey: false },
    windows: [
      { documentId: windowA.documentId, focused: true, stackOrder: 1 },
      { documentId: windowB.documentId, focused: false, stackOrder: 9 },
    ],
  });
  assert.deepEqual(
    decision,
    { kind: 'save', documentId: '/repo/a/CLAUDE.md' },
    'FR-MDE-006 AC-2: 스택 최상위가 아니라 포커스를 가진 창이 대상이어야 한다',
  );

  const { handle, settle } = handlerOver([windowA, windowB]);
  const press = ctrlS();
  handle(press.event);
  await settle();

  assert.deepEqual(
    windowA.writes,
    ['S-A|/repo/a/CLAUDE.md|unsaved work\n'],
    'FR-MDE-006 AC-2: 쓰기가 포커스를 가진 A 의 파일로 정확히 1회 나가야 한다',
  );
  assert.deepEqual(
    windowB.writes,
    [],
    'FR-MDE-006 AC-2: 맨 앞이지만 포커스가 없는 B 의 파일로는 쓰기가 나가면 안 된다',
  );
  assert.equal(
    press.preventedCount(),
    1,
    'FR-MDE-006: 저장을 낸 키 이벤트는 브라우저 기본 저장 대화상자를 막아야 한다',
  );
});

test('FR-MDE-006 the shortcut issues no write while focus is outside every editor window', async () => {
  const windowA = windowFixture('/repo/a/CLAUDE.md', 'S-A', 1);
  // 포커스가 터미널 등 어떤 편집기 창 밖에 있다.
  windowA.focused = false;

  const outside = decideEditorWindowSaveShortcut({
    event: { key: 's', ctrlKey: true, metaKey: false },
    windows: [{ documentId: windowA.documentId, focused: false, stackOrder: 1 }],
  });
  assert.deepEqual(
    outside,
    { kind: 'ignore' },
    'FR-MDE-006 AC-3: 포커스가 창 밖이면 저장 대상이 없어야 한다',
  );

  const { handle, settle } = handlerOver([windowA]);
  const firstPress = ctrlS();
  handle(firstPress.event);
  await settle();

  assert.deepEqual(
    windowA.writes,
    [],
    'FR-MDE-006 AC-3: 포커스가 창 밖이면 쓰기가 나가면 안 된다',
  );
  assert.equal(
    firstPress.preventedCount(),
    0,
    'FR-MDE-006 AC-3: 저장을 내지 않은 키 이벤트의 기본 동작은 그대로 두어야 한다 — 터미널이 포커스를 가진 경우가 여기 든다',
  );

  // 포커스를 창 안으로 옮기고 다시 누른다.
  windowA.focused = true;
  const secondPress = ctrlS();
  handle(secondPress.event);
  await settle();

  assert.deepEqual(
    windowA.writes,
    ['S-A|/repo/a/CLAUDE.md|unsaved work\n'],
    'FR-MDE-006 AC-3: 포커스를 창 안으로 옮긴 뒤에는 쓰기가 정확히 1회 나가야 한다',
  );
  assert.equal(secondPress.preventedCount(), 1);

  // 눌러 둔 키의 반복은 저장을 거듭 내지 않는다. 한 번 누른 것이 한 번의 저장이다.
  const held = decideEditorWindowSaveShortcut({
    event: { key: 's', ctrlKey: true, metaKey: false, repeat: true },
    windows: [{ documentId: windowA.documentId, focused: true, stackOrder: 1 }],
  });
  assert.deepEqual(
    held,
    { kind: 'ignore' },
    'FR-MDE-006: 키 반복은 저장을 거듭 내면 안 된다',
  );

  // Windows 의 AltGr 는 ctrlKey 와 altKey 를 함께 세운다. 그것을 저장으로 읽으면
  // 사용자가 편집기에 넣으려던 글자를 preventDefault 로 삼켜 버린다.
  const altGr = decideEditorWindowSaveShortcut({
    event: { key: 's', ctrlKey: true, metaKey: false, altKey: true },
    windows: [{ documentId: windowA.documentId, focused: true, stackOrder: 1 }],
  });
  assert.deepEqual(
    altGr,
    { kind: 'ignore' },
    'FR-MDE-006: Alt 이 눌린 조합은 저장이 아니다',
  );

  // Ctrl 이 없는 s 는 편집기의 입력이다. 가로채면 안 된다.
  const plainS = decideEditorWindowSaveShortcut({
    event: { key: 's', ctrlKey: false, metaKey: false },
    windows: [{ documentId: windowA.documentId, focused: true, stackOrder: 1 }],
  });
  assert.deepEqual(
    plainS,
    { kind: 'ignore' },
    'FR-MDE-006 AC-3: Ctrl 없는 s 는 편집기로 그대로 가야 한다',
  );
});
