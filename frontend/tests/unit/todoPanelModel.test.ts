import './i18nTestSetup.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { canAddTodoChild, categoryShowsDone, siblingMove, siblingParentId, todoAuthorLabel, todoDropMove, todoDropZone, todoRows, type TodoItem } from '../../src/components/Todo/todoModel.ts';
import { isIconName } from '../../src/components/common/iconGlyphs.ts';
import { t } from '../../src/i18n/i18n.ts';
import { createTodoPanelStore, TODO_PANEL_DEFAULT_FONT_SIZE, TODO_PANEL_MAX_FONT_SIZE, TODO_PANEL_MIN_FONT_SIZE, TODO_PANEL_DEFAULT_WIDTH, TODO_PANEL_MAX_WIDTH, TODO_PANEL_MIN_WIDTH } from '../../src/components/Todo/todoPanelStore.ts';

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

test('FR-TODO-003 AC-6: a category title is set in a larger font than the panel text, at every panel size', () => {
  const css = readFileSync(new URL('../../src/components/Todo/TodoPanel.css', import.meta.url), 'utf-8');
  const block = (selector: string) => {
    const at = css.indexOf(`${selector} {`);
    return at < 0 ? '' : css.slice(at, css.indexOf('}', at));
  };
  assert.match(block('.todo-panel'), /font-size:\s*var\(--todo-font-size\)/);
  const category = /font-size:\s*calc\(var\(--todo-font-size\)\s*\+\s*(\d+)px\)/.exec(block('.todo-row--d1 .todo-row__title'));
  assert.ok(category && Number(category[1]) >= 2, 'category title is at least 2px larger than the panel text');
});

test('FR-TODO-003 AC-7: the author label names the user or the session', () => {
  assert.equal(todoAuthorLabel({ kind: 'user' }), t('todo.author.user'));
  assert.equal(todoAuthorLabel({ kind: 'session', sessionKey: 'k1', name: 'claude-1' }), 'claude-1');
  assert.equal(todoAuthorLabel({ kind: 'session', sessionKey: null, name: 'MCP' }), 'MCP');
  assert.equal(todoAuthorLabel(undefined), null);
});

test('FR-TODO-003 AC-8: a same-level entry goes under the same parent; a category gets a new category', () => {
  const category = item(1, null);
  const child = item(2, 1);
  const sub = item(3, 2);
  assert.equal(siblingParentId(category), null);
  assert.equal(siblingParentId(child), 1);
  assert.equal(siblingParentId(sub), 2);
});

test('FR-TODO-002 AC-5: the font size steps within its range and is kept', () => {
  const storage = memoryStorage();
  const store = createTodoPanelStore(storage);
  assert.equal(store.getState().fontSize, TODO_PANEL_DEFAULT_FONT_SIZE);
  store.changeFontSize(1);
  assert.equal(store.getState().fontSize, TODO_PANEL_DEFAULT_FONT_SIZE + 1);
  for (let i = 0; i < 40; i += 1) store.changeFontSize(1);
  assert.equal(store.getState().fontSize, TODO_PANEL_MAX_FONT_SIZE);
  for (let i = 0; i < 40; i += 1) store.changeFontSize(-1);
  assert.equal(store.getState().fontSize, TODO_PANEL_MIN_FONT_SIZE);
  store.changeFontSize(2);
  assert.equal(createTodoPanelStore(storage).getState().fontSize, TODO_PANEL_MIN_FONT_SIZE + 2);
});

test('FR-TODO-002 AC-5 / FR-TODO-003 AC-7/AC-8: the panel draws the font buttons, the author label and both add buttons', () => {
  const source = readFileSync(new URL('../../src/components/Todo/TodoPanel.tsx', import.meta.url), 'utf-8');
  for (const glyph of ['text-larger', 'text-smaller', 'add-sibling', 'add-child'] as const) {
    assert.ok(isIconName(glyph), `${glyph} glyph`);
    assert.ok(source.includes(`name="${glyph}"`), `${glyph} drawn`);
  }
  assert.match(source, /changeFontSize\(1\)/);
  assert.match(source, /changeFontSize\(-1\)/);
  assert.match(source, /'--todo-font-size'/);
  assert.match(source, /todo-row__author/);
  assert.match(source, /siblingParentId\(/);
});

// FR-TODO-006: the order is the server's list order; moves are computed here and sent as {parentId, beforeId}.

test('FR-TODO-006 AC-1: siblings appear in the list order the server sent, not by id', () => {
  const list = [item(3, null), item(1, null), item(5, 1), item(2, 1)];
  assert.deepEqual(todoRows(list, { hideDone: false, categoryShowDone: {} }).map((row) => row.item.id), [3, 1, 5, 2]);
});

test('FR-TODO-006 AC-2: up and down move one place among siblings; not past either end', () => {
  // categories 1, 3; under 1: 2, 5, 7
  const list = [item(1, null), item(2, 1), item(3, null), item(5, 1), item(7, 1)];
  assert.deepEqual(siblingMove(list, 5, -1), { parentId: 1, beforeId: 2 });
  assert.deepEqual(siblingMove(list, 2, 1), { parentId: 1, beforeId: 7 });
  assert.deepEqual(siblingMove(list, 5, 1), { parentId: 1, beforeId: null });
  assert.equal(siblingMove(list, 2, -1), null);
  assert.equal(siblingMove(list, 7, 1), null);
  assert.deepEqual(siblingMove(list, 3, -1), { parentId: null, beforeId: 1 });
  assert.equal(siblingMove(list, 3, 1), null);
});

test('FR-TODO-006 AC-3: the drop zone is the top, middle or bottom of the row; the middle only where a child fits', () => {
  assert.equal(todoDropZone(0, 30, 1), 'before');
  assert.equal(todoDropZone(15, 30, 1), 'inside');
  assert.equal(todoDropZone(29, 30, 1), 'after');
  assert.equal(todoDropZone(14, 30, 3), 'before');
  assert.equal(todoDropZone(16, 30, 3), 'after');
});

test('FR-TODO-006 AC-3/AC-4: a drop becomes a move; drops into itself or past three levels give nothing', () => {
  // 1 > 2 > 4 ; 1 > 5 ; 3 > 6
  const list = [item(1, null), item(2, 1), item(3, null), item(4, 2), item(5, 1), item(6, 3)];
  assert.deepEqual(todoDropMove(list, 6, 5, 'before'), { parentId: 1, beforeId: 5 });
  assert.deepEqual(todoDropMove(list, 6, 2, 'after'), { parentId: 1, beforeId: 5 });
  assert.deepEqual(todoDropMove(list, 6, 5, 'after'), { parentId: 1, beforeId: null });
  assert.deepEqual(todoDropMove(list, 5, 6, 'inside'), { parentId: 6, beforeId: null });
  assert.deepEqual(todoDropMove(list, 3, 1, 'before'), { parentId: null, beforeId: 1 });
  assert.equal(todoDropMove(list, 1, 2, 'inside'), null);
  assert.equal(todoDropMove(list, 1, 1, 'before'), null);
  // 2 has a child: under 6 (second level) it would reach a fourth level.
  assert.equal(todoDropMove(list, 2, 6, 'inside'), null);
  // Dropping where it already is changes nothing.
  assert.equal(todoDropMove(list, 2, 5, 'before'), null);
});

test('FR-TODO-006 AC-2/AC-3: the panel draws up/down buttons and makes rows draggable', () => {
  const source = readFileSync(new URL('../../src/components/Todo/TodoPanel.tsx', import.meta.url), 'utf-8');
  for (const glyph of ['arrow-up', 'arrow-down'] as const) {
    assert.ok(isIconName(glyph), `${glyph} glyph`);
    assert.ok(source.includes(`name="${glyph}"`), `${glyph} drawn`);
  }
  assert.match(source, /draggable/);
  assert.match(source, /onDrop=/);
  assert.match(source, /todoApi\.move\(/);
  assert.match(source, /todoDropMove\(/);
  assert.match(source, /siblingMove\(/);
});
