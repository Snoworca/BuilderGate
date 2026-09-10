import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  getDialogGeometryKey,
  readDialogGeometry,
  writeDialogGeometry,
} from '../../src/components/dialog/dialogGeometry.ts';
import {
  getDialogStackEntries,
  registerDialogStackEntry,
} from '../../src/components/dialog/dialogStack.ts';
import { createWindowDialogBehaviorModel } from '../../src/components/dialog/windowDialogModel.ts';
import type { DialogRect } from '../../src/components/dialog/types.ts';
import type { EditorWindowRecord } from '../../src/components/editor/editorWindowRecord.ts';
import {
  getWindowStateStorageKey,
  restoreEditorWindowStackOrder,
  restoreWindowStateForWorkspace,
  saveWindowStateForWorkspace,
} from '../../src/hooks/windowStateStorage.ts';

// FR-MDE-009 — what restoration does to the stack, and where a floating rect
// is allowed to live.
//
// Both criteria are judged against real state rather than a description of it:
// the stack assertions read `dialogStack`'s own array, and the rect assertions
// read the storage `dialogGeometry` actually writes through.

class MemoryStorage implements Storage {
  readonly writtenKeys: string[] = [];
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.values.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.writtenKeys.push(key);
    this.values.set(key, value);
  }

  /** Places a value without counting as a write, for seeding leftovers. */
  seed(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const GEOMETRY_KEY_PATTERN = /^buildergate\.dialog\..*\.geometry$/;

const DRAGGED_RECT: DialogRect = { x: 210, y: 130, width: 640, height: 420 };
// What an earlier code path could have left in the dialog's own geometry store.
// Deliberately unlike DRAGGED_RECT in every component, so a rect that comes
// back names which of the two sources produced it.
const LEFTOVER_RECT: DialogRect = { x: 12, y: 18, width: 900, height: 700 };
const SUPERSEDED_DEFAULT_RECT: DialogRect = { x: 0, y: 0, width: 720, height: 520 };
const VIEWPORT = { width: 1920, height: 1080 };
const MIN_SIZE = { width: 320, height: 240 };

function record(overrides: Partial<EditorWindowRecord> = {}): EditorWindowRecord {
  return {
    tabId: 'tab-1',
    filePath: 'C:/work/notes/one.md',
    placement: 'stage',
    placementBeforeStage: null,
    minimized: false,
    floatingRect: null,
    stackOrder: 0,
    ...overrides,
  };
}

function modelessDialogIds(): string[] {
  return getDialogStackEntries('modeless').map(entry => entry.dialogId);
}

test('FR-MDE-009 stack order is restored relatively within the workspace', () => {
  // Workspace B's windows are already in the stack, and workspace A's are
  // interleaved with them in the order they happened to mount. Restoration has
  // to put A's three into their stored order without moving B's two relative to
  // each other -- the stack is global while the store is per workspace, so the
  // stored order can only ever be honoured relatively.
  const disposers: (() => void)[] = [];
  // The records arrive in neither the stored order nor the mounted one, and
  // their `stackOrder` values are not consecutive. An implementation that
  // walked the array as given, or that counted positions instead of reading the
  // field, produces a different stack than the one asserted below.
  const records = [
    record({ filePath: 'A/w3.md', stackOrder: 7 }),
    record({ filePath: 'A/w1.md', stackOrder: 2 }),
    record({ filePath: 'A/w2.md', stackOrder: 5 }),
  ];
  const mapped: string[] = [];
  const toDialogId = (filePath: string): string => {
    mapped.push(filePath);
    return `editor-window::${filePath}`;
  };

  try {
    [
      ['token-x', 'editor-window::B/x.md'],
      ['token-w3', 'editor-window::A/w3.md'],
      ['token-y', 'editor-window::B/y.md'],
      ['token-w1', 'editor-window::A/w1.md'],
      ['token-w2', 'editor-window::A/w2.md'],
    ].forEach(([token, dialogId]) => {
      disposers.push(registerDialogStackEntry({ token, dialogId, mode: 'modeless' }));
    });

    assert.deepEqual(modelessDialogIds(), [
      'editor-window::B/x.md',
      'editor-window::A/w3.md',
      'editor-window::B/y.md',
      'editor-window::A/w1.md',
      'editor-window::A/w2.md',
    ], '사전 조건이 성립하지 않는다');

    restoreEditorWindowStackOrder(records, toDialogId);

    const after = modelessDialogIds();
    assert.deepEqual(after, [
      'editor-window::B/x.md',
      'editor-window::B/y.md',
      'editor-window::A/w1.md',
      'editor-window::A/w2.md',
      'editor-window::A/w3.md',
    ], '복원된 창들이 저장된 스택 순서로 서지 않았다');

    // Stated separately from the deep comparison above, because this is the
    // half of AC-5 that is about the windows restoration did not touch.
    assert.equal(
      after.indexOf('editor-window::B/x.md') < after.indexOf('editor-window::B/y.md'),
      true,
      '다른 워크스페이스 창들의 상대 순서가 바뀌었다',
    );

    // The dialog id is derived from the file path, which is what identifies a
    // window. Deriving it from the tab id would collide the several windows one
    // tab legitimately has open, and every one of them would answer to the same
    // raise.
    assert.deepEqual(
      mapped.slice().sort(),
      ['A/w1.md', 'A/w2.md', 'A/w3.md'],
      'dialog id 가 파일 경로에서 만들어지지 않았다',
    );
  } finally {
    disposers.forEach(dispose => dispose());
  }
});

test('FR-MDE-009 a dragged floating rect is written only to the per-workspace store', () => {
  const workspaceId = 'ws-single-source';
  const dialogId = 'editor-window::C:/work/notes/dragged.md';
  const geometryKey = getDialogGeometryKey(dialogId);
  const storage = new MemoryStorage();
  const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    configurable: true,
    writable: true,
  });

  try {
    // A value the dialog's own store could have been left holding. Seeded
    // rather than written, so it does not count against the write assertions,
    // and then shown to be live: `readDialogGeometry` really does hand it back,
    // which is what makes the assertions below able to fail.
    storage.seed(geometryKey, JSON.stringify({ schemaVersion: 1, ...LEFTOVER_RECT }));
    assert.deepEqual(
      readDialogGeometry(dialogId, SUPERSEDED_DEFAULT_RECT, VIEWPORT, MIN_SIZE),
      LEFTOVER_RECT,
      '남아 있는 geometry 값이 살아 있지 않아 이 대조가 공허하다',
    );

    // The drag. What reaches the store is a floating placement carrying the
    // rect the user dropped the window at.
    const dragged = record({
      filePath: 'C:/work/notes/dragged.md',
      placement: 'floating',
      floatingRect: DRAGGED_RECT,
      stackOrder: 0,
    });
    saveWindowStateForWorkspace(workspaceId, [dragged], storage);

    const stored = storage.getItem(getWindowStateStorageKey(workspaceId));
    assert.notEqual(stored, null, '끌어 놓은 rect 가 워크스페이스 저장소에 없다');
    const storedEntries = (JSON.parse(stored as string) as { windows: EditorWindowRecord[] }).windows;
    assert.equal(storedEntries.length, 1);
    assert.deepEqual(
      storedEntries[0].floatingRect,
      DRAGGED_RECT,
      '저장값이 끌어 놓은 rect 를 담고 있지 않다',
    );

    // The rect comes back from this store rather than from the leftover above.
    const [restored] = restoreWindowStateForWorkspace(workspaceId, ['tab-1'], storage);
    assert.notEqual(restored, undefined, '복원된 창이 없다');
    assert.deepEqual(
      restored.floatingRect,
      DRAGGED_RECT,
      '복원된 floating 창이 저장소가 아닌 곳의 rect 를 받았다',
    );

    // Closing the window: the workspace store is rewritten without it, and the
    // dialog geometry key stays untouched. AC-7 names the close explicitly
    // because that is where `WindowDialog` would write its own copy.
    saveWindowStateForWorkspace(workspaceId, [], storage);

    assert.deepEqual(
      storage.writtenKeys.filter(key => GEOMETRY_KEY_PATTERN.test(key)),
      [],
      'buildergate.dialog.<id>.geometry 에 값이 쓰였다',
    );
    assert.deepEqual(
      JSON.parse(storage.getItem(geometryKey) as string),
      { schemaVersion: 1, ...LEFTOVER_RECT },
      '남아 있던 geometry 값이 변경되었다',
    );

    // The control. Without it the assertion above would pass on a storage that
    // simply never records anything, and would go on passing if the write path
    // came back.
    writeDialogGeometry(dialogId, DRAGGED_RECT);
    assert.equal(
      storage.writtenKeys.some(key => GEOMETRY_KEY_PATTERN.test(key)),
      true,
      '관측기가 geometry 쓰기를 잡아내지 못한다',
    );
  } finally {
    if (originalLocalStorage === undefined) {
      Reflect.deleteProperty(globalThis, 'localStorage');
    } else {
      Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
    }
  }
});

test('FR-MDE-009 an editor window turns off the dialog geometry write path', () => {
  // `WindowDialog` writes its own geometry copy on close, and only this flag
  // stops it. Nothing else in the suite pins that an editor window passes it,
  // so the close half of AC-7 rests on the two assertions here.
  assert.equal(
    createWindowDialogBehaviorModel({
      persistGeometry: false,
      layerIndex: 0,
      mode: 'modeless',
    }).persistGeometry,
    false,
    'persistGeometry=false 가 모델에 반영되지 않는다',
  );
  // The control: the flag is the live discriminator rather than a value that
  // reads false whatever it is given.
  assert.equal(
    createWindowDialogBehaviorModel({ layerIndex: 0, mode: 'modeless' }).persistGeometry,
    true,
    '기본값이 true 가 아니어서 위 단언이 공허하다',
  );

  const editorWindowSource = readFileSync(
    new URL('../../src/components/editor/EditorWindow.tsx', import.meta.url),
    'utf8',
  );

  // The anchor is checked before the value. A source-text assertion whose
  // target has been renamed away reports "the flag is not set" when what
  // actually happened is that this test no longer knows where to look, and the
  // two need different answers from whoever reads the failure.
  assert.equal(
    editorWindowSource.includes('persistGeometry'),
    true,
    'editorWindowRestore.test.ts 가 EditorWindow.tsx 에서 persistGeometry 라는 식별자를 아예 찾지 못했다'
      + ' — 이 단언이 겨냥하던 것이 사라졌다는 뜻이므로, 값을 고치지 말고 이 테스트를 다시 겨냥하라',
  );
  assert.equal(
    /persistGeometry=\{\s*false\s*\}/.test(editorWindowSource),
    true,
    'editorWindowRestore.test.ts 가 EditorWindow.tsx 의 소스 텍스트에서 persistGeometry={false} 를 찾지 못했다'
      + ' — 그 파일이 편집 중이거나 뮤턴트가 걸려 있으면 이 실패는 windowStateStorage 와 무관하다',
  );
});
