import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  getDialogGeometryKey,
  readDialogGeometry,
  writeDialogGeometry,
} from '../../src/components/dialog/dialogGeometry.ts';
import { createWindowDialogBehaviorModel } from '../../src/components/dialog/windowDialogModel.ts';
import type { DialogRect } from '../../src/components/dialog/types.ts';
import type { EditorWindowRecord } from '../../src/components/editor/editorWindowRecord.ts';
import {
  EDITOR_WINDOW_GEOMETRY_KEY,
  readEditorWindowGeometry,
  writeEditorWindowGeometry,
} from '../../src/components/editor/editorWindowGeometryCache.ts';
import {
  getWindowStateStorageKey,
  restoreWindowStateForWorkspace,
  saveWindowStateForWorkspace,
} from '../../src/hooks/windowStateStorage.ts';

// FR-MDE-009 — where the window's rect is allowed to live.
//
// There are three stores in reach and the rect belongs in exactly one of them.
// It goes to the editor's own global key; it must not go to the dialog store,
// whose read path clamps in a way that can restore a window too small to show
// its title bar; and it must not go to the per-workspace document store, which
// names documents and would be a second answer to a question with one answer.
//
// Judged against real state rather than a description of it: the assertions
// read the storage these modules actually write through.

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
    ...overrides,
  };
}

// The stack-order case that stood here restored several windows into the
// front-to-back order they had been left in. There is one editor window per
// workspace now, so nothing of its own is in front of or behind it -- what the
// modeless stack still separates is the window from the modals above it, and
// `markdown-editor-placement.spec.ts` is where that is judged.

test('FR-MDE-009 a dragged rect is written to the global geometry key and to nowhere else', () => {
  const workspaceId = 'ws-single-source';
  const dialogId = 'editor-window:ws-single-source';
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

    // The drag. The rect goes to the editor's own key, which is global: one
    // remembered placement for every workspace.
    writeEditorWindowGeometry(DRAGGED_RECT, storage);
    assert.deepEqual(
      readEditorWindowGeometry(VIEWPORT, MIN_SIZE, storage),
      DRAGGED_RECT,
      '끌어 놓은 rect 가 전역 geometry 키에서 돌아오지 않는다',
    );
    assert.equal(
      storage.writtenKeys.includes(EDITOR_WINDOW_GEOMETRY_KEY),
      true,
      '전역 geometry 키에 쓰이지 않았다',
    );
    // The key is global rather than named after a workspace, which is the whole
    // reason the rect is not in the per-workspace store.
    assert.equal(EDITOR_WINDOW_GEOMETRY_KEY.includes(workspaceId), false);

    // The document store, written over the same drag, names documents and
    // carries no coordinate at all.
    saveWindowStateForWorkspace(workspaceId, [record({ filePath: 'C:/work/notes/dragged.md' })], storage);

    const stored = storage.getItem(getWindowStateStorageKey(workspaceId));
    assert.notEqual(stored, null, '워크스페이스 저장소에 값이 없다');
    const storedEntries = (JSON.parse(stored as string) as { windows: EditorWindowRecord[] }).windows;
    // The records are searched rather than the whole stored value: that value
    // also carries `savedAt`, whose milliseconds are three digits that can
    // equal one of the coordinates below and fail this for a reason that has
    // nothing to do with what is stored.
    assert.doesNotMatch(
      JSON.stringify(storedEntries),
      /210|130|640|420|rect/i,
      '워크스페이스 저장소가 좌표를 담았다',
    );
    assert.deepEqual(storedEntries, [{ tabId: 'tab-1', filePath: 'C:/work/notes/dragged.md' }]);

    // Reopening hands back the document and nothing about where the window was.
    const [reopened] = restoreWindowStateForWorkspace(workspaceId, ['tab-1'], storage);
    assert.deepEqual(reopened, { tabId: 'tab-1', filePath: 'C:/work/notes/dragged.md' });

    // Closing the window: the document store is rewritten without it, and the
    // dialog geometry key stays untouched. AC-5 names the close explicitly
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
  // so the close half of AC-5 rests on the two assertions here.
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
