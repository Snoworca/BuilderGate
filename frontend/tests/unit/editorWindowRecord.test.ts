import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createTabSessionLookup,
  restoreEditorWindowRecords,
  toEditorWindowRecord,
} from '../../src/components/editor/editorWindowRecord.ts';

// The field set the persisted record is allowed to carry, written out rather
// than derived from the module under test. A list read back from the
// implementation would agree with any implementation, including one that
// persists the session id.
const RECORD_FIELDS = [
  'filePath',
  'tabId',
];

// A live window carries far more than the record does: the session it is
// talking to right now, the unsaved body, and its whole placement -- which of
// the two states it is in, which it came from, whether it is minimized, and
// where the user dragged it. The record must drop every one of them. Where the
// window sits is remembered once, globally, by the geometry cache; a second
// copy here would be a per-workspace answer to a question that has one answer.
// The return type is left to inference on purpose -- annotating it as the
// record input would make excess-property checking reject those fields at
// compile time, and the point of the test is to watch what the function does
// with them at runtime.
function liveWindow(overrides: Record<string, unknown> = {}) {
  return {
    tabId: 'tab-alive',
    filePath: 'C:/work/notes/readme.md',
    placement: 'stage' as const,
    placementBeforeStage: null,
    minimized: false,
    floatingRect: null,
    sessionId: 'sess-before-restart',
    currentSessionId: 'sess-before-restart',
    cascadeStep: 3,
    body: '# unsaved heading',
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

test('CON-MDE-002 the persisted window record carries a tab ID and no session ID', () => {
  const record = toEditorWindowRecord(liveWindow());

  assert.equal(record.tabId, 'tab-alive');
  assert.deepEqual(Object.keys(record).sort(), RECORD_FIELDS);

  // The input really did carry the fields whose absence is asserted below, so
  // none of these are vacuous: an implementation that spreads its input fails
  // every one of them.
  const source = liveWindow();
  assert.equal(source.sessionId, 'sess-before-restart');
  assert.equal(source.cascadeStep, 3);
  assert.equal(source.body, '# unsaved heading');
  assert.equal(source.placement, 'stage');
  assert.equal(source.minimized, false);

  // A placement the projection has to drop rather than merely leave at its
  // default. Passing a window that is floating, minimized and carries a dragged
  // rect is what separates "the field is absent" from "the field happened to be
  // null", which the window above would not have shown.
  const placed = toEditorWindowRecord(liveWindow({
    placement: 'floating' as const,
    placementBeforeStage: 'stage' as const,
    minimized: true,
    floatingRect: { x: 40, y: 60, width: 480, height: 360 },
  }));
  assert.deepEqual(Object.keys(placed).sort(), RECORD_FIELDS);
  assert.doesNotMatch(JSON.stringify(placed), /floating|minimized|480/);

  // The record survives storage as JSON, and nothing that names a session
  // reaches the stored text at any depth.
  const stored = JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
  assert.deepEqual(Object.keys(stored).sort(), RECORD_FIELDS);
  collectKeysDeep(stored).forEach(key => {
    assert.doesNotMatch(key, /session/i, `persisted record must not carry the key ${key}`);
  });
  assert.doesNotMatch(JSON.stringify(stored), /sess-before-restart/);

  // A record written before a tab restart resolves the session through the tab
  // afterwards. restartTab keeps tab.id and replaces tab.sessionId, so the two
  // ids differ by construction here and the resolved value must be the new one.
  const tabsAfterRestart = [
    { id: 'tab-alive', sessionId: 'sess-after-restart' },
    { id: 'tab-other', sessionId: 'sess-other' },
  ];
  const lookup = createTabSessionLookup(tabsAfterRestart);

  assert.equal(lookup(record.tabId), 'sess-after-restart');
  assert.notEqual(lookup(record.tabId), 'sess-before-restart');
  assert.equal(lookup('tab-gone'), undefined);
});

test('CON-MDE-002 restoration drops a record naming a tab that no longer exists', () => {
  const alive = toEditorWindowRecord(liveWindow({ tabId: 'tab-alive' }));
  const gone = toEditorWindowRecord(liveWindow({
    tabId: 'tab-gone',
    filePath: 'C:/work/notes/orphan.md',
  }));

  const restored = restoreEditorWindowRecords([alive, gone], ['tab-alive', 'tab-third']);

  assert.deepEqual(restored.map(entry => entry.tabId), ['tab-alive']);
  assert.deepEqual(restored[0], alive);

  // The filter keeps the surviving records in their stored order rather than
  // reordering them around the dropped one.
  const third = toEditorWindowRecord(liveWindow({ tabId: 'tab-third' }));
  assert.deepEqual(
    restoreEditorWindowRecords([alive, gone, third], ['tab-third', 'tab-alive'])
      .map(entry => entry.tabId),
    ['tab-alive', 'tab-third'],
  );

  // With no tab left, nothing is restored -- and with every tab present,
  // nothing is dropped. Without this pair the filter could be a constant.
  assert.deepEqual(restoreEditorWindowRecords([alive, gone], []), []);
  assert.equal(restoreEditorWindowRecords([alive, gone], ['tab-alive', 'tab-gone']).length, 2);

  // Persisted state is untrusted text: a record whose tab id is not a usable
  // string is dropped by the same filter rather than reaching the window layer.
  const malformed = [
    { ...alive, tabId: '' },
    { ...alive, tabId: null },
    { ...alive, filePath: 42 },
    { ...alive, filePath: '' },
    null,
    'tab-alive',
  ];
  assert.deepEqual(restoreEditorWindowRecords(malformed, ['tab-alive', '']), []);

  // A value written by the build that still stored placement reads back as a
  // usable record, with the four fields this schema dropped ignored rather than
  // treated as corruption. Refusing it would empty the tab row of everyone who
  // reloads once after the upgrade, which is a worse answer than ignoring four
  // fields nobody reads.
  const legacy = {
    tabId: 'tab-alive',
    filePath: 'C:/work/notes/legacy.md',
    placement: 'floating',
    placementBeforeStage: 'stage',
    minimized: true,
    floatingRect: { x: 10, y: 20, width: 400, height: 300 },
  };
  assert.deepEqual(restoreEditorWindowRecords([legacy], ['tab-alive']), [{
    tabId: 'tab-alive',
    filePath: 'C:/work/notes/legacy.md',
  }]);
});
