import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  getWindowStateStorageKey,
  readPersistedWindowState,
  restoreWindowStateForWorkspace,
  saveWindowStateForWorkspace,
} from '../../src/hooks/windowStateStorage.ts';

// FR-MDE-009 — the per-workspace window store.
//
// Every expectation below is written out here rather than read back from the
// module under test. A field list or a cascade offset taken from the
// implementation would agree with any implementation, including one that
// persists the body it is supposed to drop.

class MemoryStorage implements Storage {
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
    this.values.set(key, value);
  }
}

// The exact key set one persisted entry is allowed to carry. Written out, so an
// implementation that adds `sessionId`, `body`, a rect of any kind, or any of
// the placement fields this store used to hold is caught by the comparison
// rather than by a reader noticing.
//
// An entry names a document and nothing more. Where the window sits is
// remembered once under a global key, and which placement it is in is not
// remembered at all -- a reload opens the window in its default placement.
const ENTRY_FIELDS = [
  'filePath',
  'tabId',
];

// The key prefix the requirement names. Spelled out rather than imported, so a
// module that renamed it would be caught rather than followed.
const KEY_PREFIX = 'window_state_';

// Names that must not appear anywhere in the stored value, at any depth. The
// entry-level key comparison alone would miss a wrapper that kept a derivable
// value in a field beside the window list rather than inside it.
const FORBIDDEN_KEYS_ANYWHERE = [
  'body',
  'bodyAtOpen',
  'cascadeStep',
  'dockedRect',
  'floatingRect',
  'minimized',
  'placement',
  'placementBeforeStage',
  'rect',
  'sessionId',
  'stageRect',
  'step',
];

// The unsaved bodies. Distinctive enough that a substring search over the whole
// serialized value cannot match them by accident.
const U1 = '# 미저장 제목 U1-SENTINEL-a7f3';
const U2 = 'const answer = 42; // U2-SENTINEL-b1c9';

/**
 * A window as it lives in the app: the two fields the record keeps plus
 * everything it must drop -- the session it is talking to now, the cascade step
 * it was drawn at, the body nobody has saved, and the whole of its placement.
 * The return type is inferred on purpose; annotating it as the record would
 * make TypeScript reject the extra fields at compile time, and what this file
 * is watching is what the serializer does with them at run time.
 */
function liveWindow(overrides: Record<string, unknown> = {}) {
  return {
    tabId: 'tab-1',
    filePath: 'C:/work/notes/one.md',
    placement: 'stage' as const,
    placementBeforeStage: null,
    minimized: false,
    floatingRect: null,
    sessionId: 'sess-1',
    cascadeStep: 2,
    body: U1,
    ...overrides,
  };
}

function collectKeysDeep(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach(entry => collectKeysDeep(entry, found));
    return found;
  }
  if (value !== null && typeof value === 'object') {
    Object.entries(value as Record<string, unknown>).forEach(([key, entry]) => {
      found.push(key);
      collectKeysDeep(entry, found);
    });
  }
  return found;
}

/** Every persisted entry in the stored value, whatever wrapper holds them. */
function readEntries(storage: Storage, workspaceId: string): Record<string, unknown>[] {
  const raw = storage.getItem(getWindowStateStorageKey(workspaceId));
  assert.notEqual(raw, null, '저장된 값이 없다');
  const parsed: unknown = JSON.parse(raw as string);
  const entries = Array.isArray(parsed)
    ? parsed
    : (parsed as { windows?: unknown }).windows;

  assert.equal(
    Array.isArray(entries),
    true,
    '저장된 값에서 창 목록을 찾지 못했다',
  );
  return entries as Record<string, unknown>[];
}

test('FR-MDE-009 the serialized value names documents only and never an unsaved body', () => {
  const storage = new MemoryStorage();
  const workspaceId = 'ws-bodies';
  const windows = [
    liveWindow({ filePath: 'C:/work/notes/one.md', body: U1 }),
    liveWindow({
      tabId: 'tab-2',
      filePath: 'C:/work/notes/two.md',
      placement: 'floating' as const,
      minimized: true,
      floatingRect: { x: 12, y: 34, width: 560, height: 400 },
      sessionId: 'sess-2',
      body: U2,
    }),
  ];

  saveWindowStateForWorkspace(workspaceId, windows, storage);

  // The key is spelled out here rather than taken from the module. Reading it
  // back through `getWindowStateStorageKey` on both the write and the read side
  // would agree with any prefix the module happened to choose.
  assert.equal(getWindowStateStorageKey(workspaceId), 'window_state_ws-bodies');
  const raw = storage.getItem('window_state_ws-bodies');
  assert.notEqual(raw, null, '요구된 키 아래에 값이 없다');

  // The body is judged on the serialized text itself. A structural check would
  // pass an implementation that hid the body one level deeper than it looked.
  assert.equal((raw as string).includes(U1), false, 'U1 이 직렬화 값에 나타난다');
  assert.equal((raw as string).includes(U2), false, 'U2 가 직렬화 값에 나타난다');
  assert.equal((raw as string).includes('U1-SENTINEL'), false);
  assert.equal((raw as string).includes('U2-SENTINEL'), false);

  const entries = readEntries(storage, workspaceId);
  assert.equal(entries.length, 2, '창 두 개의 항목이 있어야 한다');

  // The two documents come back identified and in the order they were written,
  // so an implementation that stored an empty record for each would fail here
  // rather than pass on the absences alone.
  assert.equal(entries[0].tabId, 'tab-1');
  assert.equal(entries[0].filePath, 'C:/work/notes/one.md');

  assert.equal(entries[1].tabId, 'tab-2');
  assert.equal(entries[1].filePath, 'C:/work/notes/two.md');
});

test('FR-MDE-009 the serialized value has no session ID and no cascade step', () => {
  const storage = new MemoryStorage();
  const workspaceId = 'ws-derivable';
  // Two documents, stored in the order they were opened.
  const first = liveWindow({
    filePath: 'C:/work/notes/first.md',
    cascadeStep: 0,
  });
  const second = liveWindow({
    filePath: 'C:/work/notes/second.md',
    cascadeStep: 1,
  });

  saveWindowStateForWorkspace(
    workspaceId,
    [first, second],
    storage,
  );

  const raw = storage.getItem(getWindowStateStorageKey(workspaceId)) as string;
  assert.equal(raw.includes('sess-1'), false, '세션 ID 가 저장되었다');
  assert.equal(raw.includes('cascadeStep'), false, '계단식 단계 필드가 저장되었다');

  const entries = readEntries(storage, workspaceId);
  entries.forEach((entry) => {
    assert.deepEqual(
      Object.keys(entry).sort(),
      ENTRY_FIELDS,
      '항목이 허용된 필드 집합과 다르다',
    );
  });

  // The whole stored value, not only the entries. A derivable value kept in a
  // field beside the window list survives the comparison above.
  const storedKeys = collectKeysDeep(JSON.parse(raw));
  FORBIDDEN_KEYS_ANYWHERE.forEach((forbidden) => {
    assert.equal(
      storedKeys.includes(forbidden),
      false,
      `파생 가능한 필드 ${forbidden} 가 저장값 어딘가에 있다`,
    );
  });

  // Restoration hands them back in the order they were stored, which is the
  // order they become tabs. Nothing re-sorts them: the stored array is the
  // record of the row the user arranged.
  const restored = restoreWindowStateForWorkspace(workspaceId, ['tab-1'], storage);
  assert.deepEqual(
    restored.map(record => record.filePath),
    ['C:/work/notes/first.md', 'C:/work/notes/second.md'],
    '복원이 저장된 순서를 따르지 않았다',
  );

  // The stored order is the order they come back in, which is the order the
  // window opens them as tabs. A record that came back out of order would put
  // the tabs in a row the user never arranged.
});

test('FR-MDE-009 a record naming a missing tab is not restored', () => {
  const storage = new MemoryStorage();
  const workspaceId = 'ws-missing-tab';
  const onT1 = liveWindow({ tabId: 'T1', filePath: 'C:/work/notes/t1.md' });
  const onT2 = liveWindow({ tabId: 'T2', filePath: 'C:/work/notes/t2.md' });

  saveWindowStateForWorkspace(
    workspaceId,
    [onT1, onT2],
    storage,
  );

  const restored = restoreWindowStateForWorkspace(workspaceId, ['T1'], storage);

  assert.deepEqual(restored.map(record => record.tabId), ['T1']);
  assert.equal(
    restored.some(record => record.filePath === 'C:/work/notes/t2.md'),
    false,
    '없는 탭의 창이 복원되었다',
  );
});

test('FR-MDE-009 no rect of any kind reaches this store, however the window was placed', () => {
  const storage = new MemoryStorage();
  const workspaceId = 'ws-rects';
  const draggedRect = { x: 40, y: 60, width: 480, height: 360 };
  // Three windows that differ only in placement: one at rest, one the user
  // dragged, and one dragged and then maximized so it holds a rect to return
  // to. If any placement could put coordinates in this store, one of these
  // would.
  // The file names carry no word the assertions below search for, so a match
  // can only come from a stored placement and never from a path.
  const windows = [
    liveWindow({
      filePath: 'C:/work/notes/one.md',
      placement: 'stage' as const,
      placementBeforeStage: null,
    }),
    liveWindow({
      filePath: 'C:/work/notes/two.md',
      placement: 'floating' as const,
      floatingRect: draggedRect,
    }),
    liveWindow({
      filePath: 'C:/work/notes/three.md',
      placement: 'stage' as const,
      placementBeforeStage: 'floating' as const,
      floatingRect: draggedRect,
      minimized: true,
    }),
  ];

  saveWindowStateForWorkspace(workspaceId, windows, storage);

  const entries = readEntries(storage, workspaceId);
  assert.equal(entries.length, 3);

  entries.forEach((entry) => {
    assert.deepEqual(
      Object.keys(entry).sort(),
      ENTRY_FIELDS,
      `${String(entry.filePath)} 항목이 허용되지 않은 필드를 담았다`,
    );

    // Not just the named fields: no coordinate under any name, at any depth.
    const keys = collectKeysDeep(entry);
    ['x', 'y', 'width', 'height', 'left', 'top', 'rect', 'floatingRect', 'dockedRect', 'stageRect']
      .forEach((forbidden) => {
        assert.equal(
          keys.includes(forbidden),
          false,
          `rect 필드 ${forbidden} 가 저장되었다`,
        );
      });
  });

  // The input really did carry a rect and a placement, so the absences above
  // are not vacuous. The records are searched rather than the whole stored
  // value: that value also carries `savedAt`, whose milliseconds are three
  // digits that can equal one of the numbers below and fail this for a reason
  // that has nothing to do with what is stored.
  assert.doesNotMatch(JSON.stringify(entries), /480|floating|minimized/);

  // What comes back names the three documents and says nothing about where
  // their window was.
  const restored = restoreWindowStateForWorkspace(workspaceId, ['tab-1'], storage);
  assert.deepEqual(
    restored.map(record => record.filePath),
    ['C:/work/notes/one.md', 'C:/work/notes/two.md', 'C:/work/notes/three.md'],
  );
  restored.forEach((record) => {
    assert.deepEqual(Object.keys(record).sort(), ENTRY_FIELDS);
  });
});

test('FR-MDE-009 a value written by the placement-storing schema still reopens its documents', () => {
  const storage = new MemoryStorage();
  const workspaceId = 'ws-legacy';

  // Exactly what the previous build wrote, schema version included. Anyone who
  // reloads once after the upgrade meets this value, and the reopen has to read
  // it rather than treat four unknown fields as corruption.
  storage.setItem(getWindowStateStorageKey(workspaceId), JSON.stringify({
    schemaVersion: 1,
    windows: [
      {
        tabId: 'tab-1',
        filePath: 'C:/work/notes/kept.md',
        placement: 'floating',
        placementBeforeStage: 'stage',
        minimized: true,
        floatingRect: { x: 10, y: 20, width: 400, height: 300 },
      },
      {
        tabId: 'tab-gone',
        filePath: 'C:/work/notes/dropped.md',
        placement: 'stage',
        placementBeforeStage: null,
        minimized: false,
        floatingRect: null,
      },
    ],
    savedAt: '2026-09-10T00:00:00.000Z',
  }));

  const restored = restoreWindowStateForWorkspace(workspaceId, ['tab-1'], storage);

  assert.deepEqual(restored, [{
    tabId: 'tab-1',
    filePath: 'C:/work/notes/kept.md',
  }]);

  // The tab filter still runs over a legacy value, so the second record is
  // dropped for its missing tab rather than kept because the value was old.
  assert.equal(restored.length, 1);
});

test('FR-MDE-009 a missing or malformed stored value restores nothing and surfaces no error', () => {
  const workspaceId = 'ws-broken';
  const malformed = [
    '',
    '{',
    'null',
    '"a string"',
    '42',
    '{"windows":"not an array"}',
    '[{"tabId":123}]',
    '{"windows":[{"tabId":"tab-1"}]}',
  ];

  // Surfacing an error is judged as throwing. Both entry points are driven, so
  // an implementation that guards only the restore path and lets the reader
  // throw for its other callers still fails here. A console line is not judged:
  // it reaches the developer console, not the user, and this store's sibling
  // `mosaicLayoutStorage` already writes one on a quota failure.
  const empty = new MemoryStorage();
  assert.deepEqual(
    restoreWindowStateForWorkspace(workspaceId, ['tab-1'], empty),
    [],
    '저장값이 없는데 창이 만들어졌다',
  );
  assert.equal(readPersistedWindowState(workspaceId, empty), null);

  malformed.forEach((value) => {
    const storage = new MemoryStorage();
    storage.setItem(getWindowStateStorageKey(workspaceId), value);

    assert.deepEqual(
      restoreWindowStateForWorkspace(workspaceId, ['tab-1'], storage),
      [],
      `깨진 저장값(${value})에서 창이 만들어졌다`,
    );
    // `null` and an empty list are told apart on purpose: a reader that parsed
    // the value and found nothing usable would satisfy an `?? []` comparison
    // without ever having rejected it.
    assert.equal(
      readPersistedWindowState(workspaceId, storage),
      null,
      `깨진 저장값(${value})이 거부되지 않았다`,
    );
  });
});

test('FR-MDE-009 a stored value written by another schema version is not restored', () => {
  const workspaceId = 'ws-future-schema';
  const storage = new MemoryStorage();
  // Every record inside is well-formed, so the only thing that can reject this
  // value is the version. A value whose records were malformed anyway would
  // leave the version check untested.
  storage.setItem(getWindowStateStorageKey(workspaceId), JSON.stringify({
    schemaVersion: 2,
    windows: [liveWindow({ filePath: 'C:/work/notes/future.md' })],
    savedAt: '2026-09-03T00:00:00.000Z',
  }));

  assert.equal(
    readPersistedWindowState(workspaceId, storage),
    null,
    '다른 스키마 버전의 저장값이 읽혔다',
  );
  assert.deepEqual(
    restoreWindowStateForWorkspace(workspaceId, ['tab-1'], storage),
    [],
    '다른 스키마 버전의 저장값에서 창이 만들어졌다',
  );
});

test('FR-MDE-009 the storage key belongs to the store and not to the hook that wraps it', () => {
  const hookSource = readFileSync(
    new URL('../../src/hooks/useWindowState.ts', import.meta.url),
    'utf8',
  );
  const storeSource = readFileSync(
    new URL('../../src/hooks/windowStateStorage.ts', import.meta.url),
    'utf8',
  );

  assert.equal(
    storeSource.includes(KEY_PREFIX),
    true,
    '저장 계층이 키를 소유하지 않는다',
  );
  assert.equal(
    hookSource.includes(KEY_PREFIX),
    false,
    '훅 계층이 키를 알고 있어 두 계층이 분리되지 않았다',
  );
  assert.equal(
    /from\s+'\.\/windowStateStorage/.test(hookSource),
    true,
    '훅이 저장 계층을 거치지 않는다',
  );
});
