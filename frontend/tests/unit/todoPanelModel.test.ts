import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canAddTodoChild, categoryShowsDone, todoRows, type TodoItem } from '../../src/components/Todo/todoModel.ts';
import { createTodoPanelStore, TODO_PANEL_DEFAULT_WIDTH, TODO_PANEL_MAX_WIDTH, TODO_PANEL_MIN_WIDTH } from '../../src/components/Todo/todoPanelStore.ts';

function item(id: number, parentId: number | null, done = false): TodoItem {
  return { id, parentId, title: `t${id}`, detail: '', done, createdAt: '', updatedAt: '' };
}

// 1 (category) > 2 (item, done) > 4 (sub) ; 1 > 5 ; 3 (category, done) > 6
const items = [item(1, null), item(2, 1, true), item(3, null, true), item(4, 2), item(5, 1), item(6, 3)];

const rowIds = (view: Parameters<typeof todoRows>[1]) => todoRows(items, view).map((row) => `${row.item.id}@${row.depth}`);

test('FR-TODO-003 AC-1: categories, items and sub-items in tree order with their depth', () => {
  assert.deepEqual(rowIds({ hideDone: false, categoryShowDone: {} }), ['1@1', '2@2', '4@3', '5@2', '3@1', '6@2']);
});

test('FR-TODO-003 AC-3: hiding done hides done entries and what is under them', () => {
  assert.deepEqual(rowIds({ hideDone: true, categoryShowDone: {} }), ['1@1', '5@2']);
});

test('FR-TODO-003 AC-4: a category icon shows or hides only that category\'s done entries', () => {
  assert.deepEqual(rowIds({ hideDone: true, categoryShowDone: { 1: true } }), ['1@1', '2@2', '4@3', '5@2']);
  assert.deepEqual(rowIds({ hideDone: false, categoryShowDone: { 1: false } }), ['1@1', '5@2', '3@1', '6@2']);
  assert.equal(categoryShowsDone(1, { hideDone: true, categoryShowDone: { 1: true } }), true);
  assert.equal(categoryShowsDone(3, { hideDone: true, categoryShowDone: { 1: true } }), false);
});

test('FR-TODO-001 AC-3: children may be added down to the third level only', () => {
  assert.equal(canAddTodoChild(1), true);
  assert.equal(canAddTodoChild(2), true);
  assert.equal(canAddTodoChild(3), false);
});

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value); },
    removeItem: (key: string) => { map.delete(key); },
  };
}

test('FR-TODO-002 AC-3: open state and width are kept in the browser; width stays within bounds', () => {
  const storage = memoryStorage();
  const store = createTodoPanelStore(storage);
  assert.equal(store.getState().open, false);
  assert.equal(store.getState().width, TODO_PANEL_DEFAULT_WIDTH);
  store.toggle();
  store.setWidth(5000);
  const again = createTodoPanelStore(storage);
  assert.equal(again.getState().open, true);
  assert.equal(again.getState().width, TODO_PANEL_MAX_WIDTH);
  again.setWidth(10);
  assert.equal(again.getState().width, TODO_PANEL_MIN_WIDTH);
});

test('FR-TODO-003 AC-4/AC-5: the top toggle resets the category settings; view settings are kept', () => {
  const storage = memoryStorage();
  const store = createTodoPanelStore(storage);
  let calls = 0;
  store.subscribe(() => { calls += 1; });
  store.toggleCategoryDone(7);
  assert.equal(store.getState().categoryShowDone[7], false);
  store.setHideDone(true);
  assert.deepEqual(store.getState().categoryShowDone, {});
  store.toggleCategoryDone(7);
  assert.equal(store.getState().categoryShowDone[7], true);
  const again = createTodoPanelStore(storage);
  assert.equal(again.getState().hideDone, true);
  assert.equal(again.getState().categoryShowDone[7], true);
  assert.ok(calls >= 3);
});

test('FR-TODO-002: the store keeps working when storage throws', () => {
  const broken = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); }, removeItem: () => { throw new Error('x'); } };
  const store = createTodoPanelStore(broken);
  store.toggle();
  assert.equal(store.getState().open, true);
});

test('FR-TODO-004 AC-1: selecting an entry is remembered for the detail area', () => {
  const store = createTodoPanelStore(memoryStorage());
  store.select(5);
  assert.equal(store.getState().selectedId, 5);
  store.select(null);
  assert.equal(store.getState().selectedId, null);
});
