import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  COMPOSER_HEIGHT_STORAGE_KEY,
  composerSessionStorageKey,
  createSessionComposerStore,
  type ComposerStorage,
} from '../../src/components/Terminal/sessionComposerStore.ts';
import { COMPOSER_DEFAULT_HEIGHT_PX } from '../../src/components/Terminal/sessionComposerModel.ts';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  const storage: ComposerStorage = {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => { data.set(k, v); },
    removeItem: (k) => { data.delete(k); },
  };
  return { data, storage };
}

function throwingStorage(): ComposerStorage {
  return {
    getItem: () => { throw new Error('denied'); },
    setItem: () => { throw new Error('quota'); },
    removeItem: () => { throw new Error('denied'); },
  };
}

function manualTimers() {
  const pending = new Map<number, { fn: () => void; ms: number }>();
  let next = 1;
  return {
    schedule: (fn: () => void, ms: number) => {
      const id = next++;
      pending.set(id, { fn, ms });
      return () => { pending.delete(id); };
    },
    runAll: () => {
      const all = [...pending.values()];
      pending.clear();
      for (const entry of all) entry.fn();
    },
    delays: () => [...pending.values()].map(entry => entry.ms),
  };
}

test('FR-CMP-001 AC-1: every session starts closed with an empty draft', () => {
  const { storage } = memoryStorage();
  const store = createSessionComposerStore({ storage: () => storage });
  const session = store.getSession('tab-1');
  assert.equal(session.open, false);
  assert.equal(session.draft, '');
  assert.deepEqual(session.history, []);
});

test('FR-CMP-001 AC-5: the open state is saved per session and read back by a new store', () => {
  const { storage } = memoryStorage();
  const first = createSessionComposerStore({ storage: () => storage });
  first.setOpen('tab-1', true);
  const second = createSessionComposerStore({ storage: () => storage });
  assert.equal(second.getSession('tab-1').open, true);
  assert.equal(second.getSession('tab-2').open, false);
});

test('FR-CMP-003 AC-5: the draft is saved 300 ms after the last change, per session', () => {
  const { storage, data } = memoryStorage();
  const timers = manualTimers();
  const store = createSessionComposerStore({ storage: () => storage, schedule: timers.schedule });
  store.setDraft('tab-1', 'h');
  store.setDraft('tab-1', 'hello');
  assert.equal(store.getSession('tab-1').draft, 'hello', 'memory is immediate');
  assert.equal(data.get(composerSessionStorageKey('tab-1')), undefined, 'storage waits');
  assert.deepEqual(timers.delays(), [300], 'one pending save, the earlier one cancelled');
  timers.runAll();
  const reloaded = createSessionComposerStore({ storage: () => storage });
  assert.equal(reloaded.getSession('tab-1').draft, 'hello');
});

test('FR-CMP-003 AC-5: flush saves a pending draft at once (page hide)', () => {
  const { storage } = memoryStorage();
  const timers = manualTimers();
  const store = createSessionComposerStore({ storage: () => storage, schedule: timers.schedule });
  store.setDraft('tab-1', 'unsaved');
  store.flush();
  assert.equal(createSessionComposerStore({ storage: () => storage }).getSession('tab-1').draft, 'unsaved');
});

test('FR-CMP-003 AC-3 AC-5: a sent draft empties the box and joins the history at once', () => {
  const { storage } = memoryStorage();
  const timers = manualTimers();
  const store = createSessionComposerStore({ storage: () => storage, schedule: timers.schedule });
  store.setDraft('tab-1', 'do it');
  store.recordSent('tab-1', 'do it');
  assert.equal(store.getSession('tab-1').draft, '');
  assert.deepEqual(store.getSession('tab-1').history, ['do it']);
  assert.deepEqual(timers.delays(), [], 'the pending draft save is dropped');
  const reloaded = createSessionComposerStore({ storage: () => storage });
  assert.equal(reloaded.getSession('tab-1').draft, '');
  assert.deepEqual(reloaded.getSession('tab-1').history, ['do it']);
});

test('FR-CMP-003 AC-5: the history keeps the last 50', () => {
  const { storage } = memoryStorage();
  const store = createSessionComposerStore({ storage: () => storage });
  for (let i = 0; i < 55; i += 1) store.recordSent('tab-1', `m${i}`);
  const history = createSessionComposerStore({ storage: () => storage }).getSession('tab-1').history;
  assert.equal(history.length, 50);
  assert.equal(history[49], 'm54');
});

test('FR-CMP-002 AC-4: one height for every session, saved and read back', () => {
  const { storage, data } = memoryStorage();
  const store = createSessionComposerStore({ storage: () => storage });
  assert.equal(store.getHeight(), COMPOSER_DEFAULT_HEIGHT_PX);
  store.setHeight(210);
  assert.equal(data.get(COMPOSER_HEIGHT_STORAGE_KEY), '210');
  assert.equal(createSessionComposerStore({ storage: () => storage }).getHeight(), 210);
  store.resetHeight();
  assert.equal(store.getHeight(), COMPOSER_DEFAULT_HEIGHT_PX);
  assert.equal(createSessionComposerStore({ storage: () => storage }).getHeight(), COMPOSER_DEFAULT_HEIGHT_PX);
});

test('FR-CMP-002 AC-4: a stored height that is not a positive number is ignored', () => {
  const { storage } = memoryStorage({ [COMPOSER_HEIGHT_STORAGE_KEY]: 'abc' });
  assert.equal(createSessionComposerStore({ storage: () => storage }).getHeight(), COMPOSER_DEFAULT_HEIGHT_PX);
});

test('FR-CMP-003 AC-5: closing a session clears its composer data, and only its', () => {
  const { storage, data } = memoryStorage();
  const timers = manualTimers();
  const store = createSessionComposerStore({ storage: () => storage, schedule: timers.schedule });
  store.setOpen('tab-1', true);
  store.recordSent('tab-1', 'x');
  store.setDraft('tab-1', 'pending');
  store.setOpen('tab-2', true);
  store.clear('tab-1');
  assert.deepEqual(timers.delays(), [], 'the pending save of the closed session is dropped');
  assert.equal(data.has(composerSessionStorageKey('tab-1')), false);
  assert.equal(store.getSession('tab-1').open, false);
  assert.equal(store.getSession('tab-1').draft, '');
  assert.equal(store.getSession('tab-2').open, true);
});

test('FR-CMP-003 AC-5: corrupt stored data reads as a fresh session', () => {
  const { storage } = memoryStorage({
    [composerSessionStorageKey('a')]: '{not json',
    [composerSessionStorageKey('b')]: JSON.stringify({ open: 'yes', draft: 3, history: [1, 'ok'] }),
  });
  const store = createSessionComposerStore({ storage: () => storage });
  assert.deepEqual({ ...store.getSession('a') }, { ...store.getSession('never') });
  const b = store.getSession('b');
  assert.equal(b.open, false);
  assert.equal(b.draft, '');
  assert.deepEqual(b.history, ['ok']);
});

test('storage that throws (private mode, blocked site data) never breaks the composer', () => {
  const store = createSessionComposerStore({ storage: throwingStorage });
  store.setOpen('tab-1', true);
  store.setDraft('tab-1', 'x');
  store.flush();
  store.recordSent('tab-1', 'x');
  store.setHeight(150);
  store.clear('tab-2');
  assert.equal(store.getSession('tab-1').open, true);
  assert.equal(store.getHeight(), 150);
  const missing = createSessionComposerStore({ storage: () => null });
  missing.setOpen('t', true);
  assert.equal(missing.getSession('t').open, true);
});

test('subscribers hear changes; an unchanged session keeps the same snapshot object', () => {
  const { storage } = memoryStorage();
  const store = createSessionComposerStore({ storage: () => storage });
  let calls = 0;
  const unsubscribe = store.subscribe(() => { calls += 1; });
  const before = store.getSession('tab-1');
  assert.equal(store.getSession('tab-1'), before);
  store.setOpen('tab-1', false);
  assert.equal(calls, 0, 'no change, no wake-up');
  store.setOpen('tab-1', true);
  assert.equal(calls, 1);
  assert.notEqual(store.getSession('tab-1'), before);
  unsubscribe();
  store.setOpen('tab-1', false);
  assert.equal(calls, 1);
});

test('FR-CMP-001 AC-2 AC-3: a focus request is taken once', () => {
  const { storage } = memoryStorage();
  const store = createSessionComposerStore({ storage: () => storage });
  assert.equal(store.takeFocusRequest('tab-1'), false);
  store.requestFocus('tab-1');
  assert.equal(store.takeFocusRequest('tab-1'), true);
  assert.equal(store.takeFocusRequest('tab-1'), false);
});
