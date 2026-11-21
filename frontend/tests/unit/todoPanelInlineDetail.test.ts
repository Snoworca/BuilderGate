import './i18nTestSetup.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { t } from '../../src/i18n/i18n.ts';
import type { ContextMenuActionItem, ContextMenuItem } from '../../src/components/ContextMenu/ContextMenu.tsx';
import type { TodoItem } from '../../src/components/Todo/todoModel.ts';
import { todoDeleteMessage, todoPanelMenuItems, todoRowMenuItems, type TodoRowMenuActions } from '../../src/components/Todo/todoRowMenu.ts';
import { todoDescendantCount } from '../../src/components/Todo/todoModel.ts';
import { TODO_PANEL_MAX_FONT_SIZE, TODO_PANEL_MIN_FONT_SIZE } from '../../src/components/Todo/todoPanelStore.ts';
import { createTodoPanelStore } from '../../src/components/Todo/todoPanelStore.ts';

// FR-TODO-007: the detail under the entry, edited in place; a right-click menu on the row.

function entry(overrides: Partial<TodoItem> = {}): TodoItem {
  return { id: 7, parentId: 1, title: 'Item', detail: '', done: false, createdAt: '', updatedAt: '', ...overrides };
}

function recorder() {
  const calls: string[] = [];
  const actions: TodoRowMenuActions = {
    editDetail: () => calls.push('detail'),
    editTitle: () => calls.push('title'),
    addSibling: () => calls.push('sibling'),
    addChild: () => calls.push('child'),
    move: (to) => calls.push(`move:${to.parentId}:${to.beforeId}`),
    toggleDone: () => calls.push('done'),
    remove: () => calls.push('remove'),
  };
  return { calls, actions };
}

const actionsOf = (items: ContextMenuItem[]) => items.filter((item): item is ContextMenuActionItem => !item.separator);
const byLabel = (items: ContextMenuItem[], label: string) => actionsOf(items).find((item) => item.label === label);

test('FR-TODO-007 AC-6: the row menu offers every row action, and each runs its action', () => {
  const { calls, actions } = recorder();
  const items = todoRowMenuItems({ item: entry(), depth: 2, moveUp: { parentId: 1, beforeId: 3 }, moveDown: null, actions });
  const labels = actionsOf(items).map((item) => item.label);
  assert.deepEqual(labels, [
    t('todo.detail.add'), t('todo.editTitle'), t('todo.addSibling'), t('todo.addChild'),
    t('todo.moveUp'), t('todo.moveDown'), t('todo.markDone'), t('todo.delete'),
  ]);
  assert.equal(byLabel(items, t('todo.moveDown'))!.disabled, true);
  assert.equal(byLabel(items, t('todo.moveUp'))!.disabled, false);
  assert.equal(byLabel(items, t('todo.delete'))!.destructive, true);
  for (const item of actionsOf(items)) if (!item.disabled) item.onClick!();
  assert.deepEqual(calls, ['detail', 'title', 'sibling', 'child', 'move:1:3', 'done', 'remove']);
});

test('FR-TODO-007 AC-6: the menu follows the row — edit an existing detail, a new category, no child on the third level, mark open', () => {
  const { actions } = recorder();
  const category = actionsOf(todoRowMenuItems({ item: entry({ parentId: null, detail: 'x', done: true }), depth: 1, moveUp: null, moveDown: null, actions })).map((item) => item.label);
  assert.ok(category.includes(t('todo.detail.edit')));
  assert.ok(category.includes(t('todo.addCategory')));
  assert.ok(category.includes(t('todo.markOpen')));
  const sub = actionsOf(todoRowMenuItems({ item: entry(), depth: 3, moveUp: null, moveDown: null, actions })).map((item) => item.label);
  assert.ok(!sub.includes(t('todo.addChild')));
});

test('FR-TODO-007 AC-4: a hidden detail is kept per entry in the browser', () => {
  const map = new Map<string, string>();
  const storage = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v); }, removeItem: (k: string) => { map.delete(k); } };
  const store = createTodoPanelStore(storage);
  assert.equal(store.getState().hiddenDetails[5], undefined);
  store.setDetailHidden(5, true);
  assert.equal(store.getState().hiddenDetails[5], true);
  assert.equal(createTodoPanelStore(storage).getState().hiddenDetails[5], true);
  store.setDetailHidden(5, false);
  assert.equal(createTodoPanelStore(storage).getState().hiddenDetails[5], undefined);
});

test('FR-TODO-007 AC-1/AC-2/AC-5/AC-6: the panel has no bottom detail area; detail, editor, double-click title and right-click menu are on the row', () => {
  const source = readFileSync(new URL('../../src/components/Todo/TodoPanel.tsx', import.meta.url), 'utf-8');
  assert.doesNotMatch(source, /todo-panel__detail/);
  assert.match(source, /className=\{`todo-detail /);
  assert.match(source, /todo-detail-edit/);
  assert.match(source, /onDoubleClick=/);
  assert.match(source, /onContextMenu=/);
  assert.match(source, /todoRowMenuItems\(/);
  assert.match(source, /<ContextMenu/);
  assert.match(source, /setDetailHidden\(/);
});

test('FR-TODO-007 AC-2: the editor sits where the detail sits, at the same width, with a very thin scroll bar', () => {
  const css = readFileSync(new URL('../../src/components/Todo/TodoPanel.css', import.meta.url), 'utf-8');
  // Both boxes take their indent from the same per-depth rules.
  for (const depth of [1, 2, 3]) assert.match(css, new RegExp(`\\.todo-detail--d${depth}\\s*\\{[^}]*margin-left:`));
  assert.match(css, /\.todo-detail-edit textarea\s*\{[^}]*scrollbar-width:\s*thin/);
  const webkit = /\.todo-detail-edit textarea::-webkit-scrollbar\s*\{[^}]*width:\s*(\d+)px/.exec(css);
  assert.ok(webkit && Number(webkit[1]) <= 4, 'scroll bar at most 4px');
  // The editor box does not set its own left margin, which would override the indent.
  const editBlock = /\.todo-detail-edit\s*\{([^}]*)\}/.exec(css);
  assert.ok(editBlock && !/margin(-left)?\s*:/.test(editBlock[1].replace(/margin-(right|bottom)\s*:[^;]*;/g, '')));
});

test('FR-TODO-007 AC-7: the panel menu adds a category, flips the done toggle and steps the font, within its range', () => {
  const calls: string[] = [];
  const actions = { addCategory: () => calls.push('add'), toggleHideDone: () => calls.push('done'), fontLarger: () => calls.push('+'), fontSmaller: () => calls.push('-') };
  const items = todoPanelMenuItems({ hideDone: false, fontSize: 13, actions });
  assert.deepEqual(actionsOf(items).map((item) => item.label), [t('todo.addCategory'), t('todo.hideDone'), t('todo.fontLarger'), t('todo.fontSmaller')]);
  for (const item of actionsOf(items)) item.onClick!();
  assert.deepEqual(calls, ['add', 'done', '+', '-']);
  assert.equal(byLabel(todoPanelMenuItems({ hideDone: true, fontSize: 13, actions }), t('todo.showDone'))?.disabled ?? false, false);
  assert.equal(byLabel(todoPanelMenuItems({ hideDone: false, fontSize: TODO_PANEL_MAX_FONT_SIZE, actions }), t('todo.fontLarger'))!.disabled, true);
  assert.equal(byLabel(todoPanelMenuItems({ hideDone: false, fontSize: TODO_PANEL_MIN_FONT_SIZE, actions }), t('todo.fontSmaller'))!.disabled, true);
});

test('FR-TODO-007 AC-8: the delete message names the entry and how many go with it', () => {
  const list = [entry({ id: 1, parentId: null }), entry({ id: 2, parentId: 1 }), entry({ id: 3, parentId: 2 }), entry({ id: 4, parentId: null })];
  assert.equal(todoDescendantCount(list, 1), 2);
  assert.equal(todoDescendantCount(list, 4), 0);
  const withChildren = todoDeleteMessage(list[0]!, 2);
  assert.ok(withChildren.includes('#1') && withChildren.includes('2'), withChildren);
  const alone = todoDeleteMessage(list[3]!, 0);
  assert.ok(alone.includes('#4'), alone);
  assert.notEqual(alone, todoDeleteMessage(list[3]!, 1));
});

test('FR-TODO-007 AC-7/AC-8: an in-app modal confirms a delete; the detail and the empty list open the app menu, inputs keep the browser one', () => {
  const source = readFileSync(new URL('../../src/components/Todo/TodoPanel.tsx', import.meta.url), 'utf-8');
  assert.doesNotMatch(source, /window\.confirm/);
  assert.match(source, /<MessageBox/);
  assert.match(source, /okVariant="danger"/);
  assert.match(source, /todoPanelMenuItems\(/);
  assert.match(source, /className=\{`todo-detail [^}]*\}[^>]*onContextMenu=/s);
  assert.match(source, /closest\('input, textarea'\)/);
});
