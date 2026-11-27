// FR-TODO-008: categories and items fold and unfold in the to-do panel.
//
// The rows a fold leaves are judged as pure functions (todoRows, todoTreePath), the kept state
// with a fake storage, and the panel and its row by running their own render functions from
// TodoPanel.tsx with real React elements and inert hooks, as workspaceSidebarCollapse.test.ts
// does: what is drawn, with which props, and what the handlers call. Browser layout is not
// measured here.
import { koCatalog } from './i18nTestSetup.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as React from 'react';
import ts from 'typescript';
import { t, tn } from '../../src/i18n/i18n.ts';
import type { ContextMenuActionItem, ContextMenuItem } from '../../src/components/ContextMenu/ContextMenu.tsx';
import { isIconName } from '../../src/components/common/iconGlyphs.ts';
import {
  canAddTodoChild, categoryShowsDone, detailSaveRemoves, siblingMove, siblingParentId, todoAuthorLabel, todoDescendantCount,
  todoDropMove, todoDropZone, todoListPlaceholder, todoRows, TODO_DETAIL_MAX, TODO_TITLE_MAX, type TodoItem, type TodoRow,
} from '../../src/components/Todo/todoModel.ts';
import { createTodoPanelStore, TODO_PANEL_STORAGE_KEY } from '../../src/components/Todo/todoPanelStore.ts';
import { todoDeleteMessage, todoPanelMenuItems, todoRowMenuItems, type TodoRowMenuActions } from '../../src/components/Todo/todoRowMenu.ts';
import { todoPieSlicePath, todoProgress, todoTreePath, type TodoTreeAnchor } from '../../src/components/Todo/todoTree.ts';

const PANEL = new URL('../../src/components/Todo/TodoPanel.tsx', import.meta.url);
const panelSource = readFileSync(PANEL, 'utf8').replace(/\r\n/g, '\n');
const CSS = readFileSync(new URL('../../src/components/Todo/TodoPanel.css', import.meta.url), 'utf8');
const en = JSON.parse(readFileSync(new URL('../../public/locales/messages.en.json', import.meta.url), 'utf8')) as Record<string, string>;

function item(id: number, parentId: number | null, done = false): TodoItem {
  return { id, parentId, title: `t${id}`, detail: '', done, createdAt: '', updatedAt: '' };
}

const noop = () => {};

function cssRules(selector: string): string {
  const bodies: string[] = [];
  for (const match of CSS.replace(/\/\*[\s\S]*?\*\//gu, '').matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
    if (match[1].split(',').map((part) => part.trim()).includes(selector)) bodies.push(match[2]);
  }
  assert.ok(bodies.length > 0, `TodoPanel.css styles ${selector}`);
  return bodies.join('\n');
}

// ---- the rows a fold leaves ----

// 1 (category) > 2 (item) > 4 (sub) ; 1 > 5 (item, done) > 6 (sub) ; 3 (category) > 7 (item)
const list = [item(1, null), item(2, 1), item(3, null), item(4, 2), item(5, 1, true), item(6, 5), item(7, 3)];

const shown = (collapsed: Record<number, true>, hideDone = false) =>
  todoRows(list, { hideDone, categoryShowDone: {}, collapsed }).map((row) => `${row.item.id}@${row.depth}`);

test('FR-TODO-008 AC-1: a folded category hides every row under it, and unfolding shows them again', () => {
  assert.deepEqual(shown({}), ['1@1', '2@2', '4@3', '5@2', '6@3', '3@1', '7@2']);
  assert.deepEqual(shown({ 1: true }), ['1@1', '3@1', '7@2']);
  assert.deepEqual(shown({ 3: true }), ['1@1', '2@2', '4@3', '5@2', '6@3', '3@1']);
});

test('FR-TODO-008 AC-1: a folded item hides only its sub-items, and a fold inside a folded category waits for it to open', () => {
  assert.deepEqual(shown({ 2: true }), ['1@1', '2@2', '5@2', '6@3', '3@1', '7@2']);
  assert.deepEqual(shown({ 1: true, 2: true }), ['1@1', '3@1', '7@2']);
  // Two folded items under one open category.
  assert.deepEqual(shown({ 2: true, 5: true }), ['1@1', '2@2', '5@2', '3@1', '7@2']);
});

test('FR-TODO-008 AC-1: folding works with hiding completed entries; a fold on a hidden, childless or deleted entry hides nothing more', () => {
  // Hiding done takes 5 and its sub-item 6; folding 2 takes 4.
  assert.deepEqual(shown({}, true), ['1@1', '2@2', '4@3', '3@1', '7@2']);
  assert.deepEqual(shown({ 2: true }, true), ['1@1', '2@2', '3@1', '7@2']);
  // 5 is already hidden as done.
  assert.deepEqual(shown({ 5: true }, true), shown({}, true));
  // A sub-item has nothing under it; 99 was deleted.
  assert.deepEqual(shown({ 4: true, 99: true }), shown({}));
  // A view that names no folds shows everything.
  assert.equal(todoRows(list, { hideDone: false, categoryShowDone: {} }).length, 7);
});

test('FR-TODO-008 AC-5: the dotted tree links only rows a fold leaves visible; the progress pie still counts what it hides', () => {
  // Marks for every entry, as if measured before the fold.
  const entries = [item(1, null), item(2, 1), item(4, 2), item(3, null), item(7, 3)];
  const anchors = new Map<number, TodoTreeAnchor>([
    [1, { left: 30, right: 50, top: 10, bottom: 30 }],
    [2, { left: 54, right: 69, top: 50, bottom: 65 }],
    [4, { left: 76, right: 91, top: 90, bottom: 105 }],
    [3, { left: 30, right: 50, top: 130, bottom: 150 }],
    [7, { left: 54, right: 69, top: 170, bottom: 185 }],
  ]);
  const path = (collapsed: Record<number, true>) =>
    todoTreePath(todoRows(entries, { hideDone: false, categoryShowDone: {}, collapsed }).map((row) => row.item), anchors);
  // Open: a trunk from under 1 (x 40.5, y 32) to 2, and from under 2 (x 61.5, y 67) to 4.
  assert.match(path({}), /M40\.5 32V57\.5/);
  assert.match(path({}), /M61\.5 67V97\.5/);
  // Category 1 folded: no line from 1 or from 2; category 3 still links item 7.
  const folded = path({ 1: true });
  assert.doesNotMatch(folded, /M40\.5 32V/);
  assert.doesNotMatch(folded, /M61\.5 67V/);
  assert.match(folded, /M40\.5 152V177\.5/);
  // Item 2 folded: 1 still links 2, and 2 links nothing.
  assert.match(path({ 2: true }), /M40\.5 32V57\.5/);
  assert.doesNotMatch(path({ 2: true }), /M61\.5 67V/);
  // The pie of a folded category counts the entries the fold hides.
  assert.deepEqual(todoProgress(entries, 1), { done: 0, total: 2 });
});

// ---- the kept state ----

function memoryStorage(stored?: string) {
  const map = new Map<string, string>();
  if (stored !== undefined) map.set(TODO_PANEL_STORAGE_KEY, stored);
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value); },
    removeItem: (key: string) => { map.delete(key); },
  };
}

test('FR-TODO-008 AC-3: folded entries are kept by id with the panel state, and a reload folds them again', () => {
  const storage = memoryStorage();
  const store = createTodoPanelStore(storage);
  assert.deepEqual(store.getState().collapsed, {}, 'nothing is folded at first');
  let calls = 0;
  store.subscribe(() => { calls += 1; });
  store.setCollapsed(5, true);
  store.setCollapsed(9, true);
  store.setCollapsed(9, true);
  assert.equal(calls, 2, 'folding a folded entry again changes nothing');
  assert.deepEqual(store.getState().collapsed, { 5: true, 9: true });
  const saved = JSON.parse(storage.map.get(TODO_PANEL_STORAGE_KEY)!) as Record<string, unknown>;
  assert.deepEqual(saved.collapsed, { 5: true, 9: true });
  assert.equal(saved.width, store.getState().width, 'in the same record as the rest of the panel state');
  const reloaded = createTodoPanelStore(storage);
  assert.deepEqual(reloaded.getState().collapsed, { 5: true, 9: true });
  reloaded.setCollapsed(5, false);
  assert.deepEqual(createTodoPanelStore(storage).getState().collapsed, { 9: true });
});

test('FR-TODO-008 AC-3: a broken stored value or unusable storage starts with everything unfolded', () => {
  for (const stored of [
    '{not json',
    JSON.stringify({ collapsed: 'x' }),
    JSON.stringify({ collapsed: null }),
    JSON.stringify({ collapsed: 5 }),
    JSON.stringify({ collapsed: { 5: 'yes', x: true, 2.5: true } }),
  ]) {
    assert.deepEqual(createTodoPanelStore(memoryStorage(stored)).getState().collapsed, {}, stored);
  }
  // Each entry is read on its own, and a bad one leaves the rest of the panel state alone.
  const mixed = createTodoPanelStore(memoryStorage(JSON.stringify({ open: true, collapsed: { 5: 'yes', 7: true } }))).getState();
  assert.deepEqual(mixed.collapsed, { 7: true });
  assert.equal(mixed.open, true);
  assert.deepEqual(createTodoPanelStore(null).getState().collapsed, {});
  const blocked = () => { throw new Error('blocked'); };
  const broken = createTodoPanelStore({ getItem: blocked, setItem: blocked, removeItem: blocked });
  assert.deepEqual(broken.getState().collapsed, {});
  broken.setCollapsed(3, true);
  assert.deepEqual(broken.getState().collapsed, { 3: true }, 'folding still works for this page');
});

// ---- the row and the panel, run from their source ----

type ElementProps = { [key: string]: unknown; children?: React.ReactNode };
type AnyElement = React.ReactElement<ElementProps>;
type Render = (props: Record<string, unknown>) => React.ReactNode;

/** Runs one function component of TodoPanel.tsx with the given imports injected. */
function component(name: string, dependencies: Record<string, unknown>): Render {
  const ast = ts.createSourceFile(PANEL.pathname, readFileSync(PANEL, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found = ast.statements.filter(ts.isFunctionDeclaration).filter((node) => node.name?.text === name);
  assert.equal(found.length, 1, `TodoPanel.tsx declares ${name} once`);
  const code = found[0].getText(ast).replace(/^export\s+/u, '');
  const output = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText;
  const injected = { t, tn, ...dependencies };
  return new Function('React', ...Object.keys(injected), `${output}\nreturn ${name};`)(React, ...Object.values(injected)) as Render;
}

function elements(tree: React.ReactNode, match: (element: AnyElement) => boolean): AnyElement[] {
  const found: AnyElement[] = [];
  React.Children.forEach(tree, (child) => {
    if (!React.isValidElement<ElementProps>(child)) return;
    if (match(child)) found.push(child);
    found.push(...elements(child.props.children, match));
  });
  return found;
}

function only(tree: React.ReactNode, match: (element: AnyElement) => boolean, what: string): AnyElement {
  const found = elements(tree, match);
  assert.equal(found.length, 1, `exactly one ${what} (found ${found.length})`);
  return found[0];
}

const ofType = (type: string) => (element: AnyElement) => element.type === type;
const hasClass = (element: AnyElement, name: string) =>
  typeof element.props.className === 'string' && element.props.className.split(/\s+/u).includes(name);
const withClass = (name: string) => (element: AnyElement) => hasClass(element, name);
const childElements = (children: React.ReactNode): AnyElement[] =>
  React.Children.toArray(children).filter((child): child is AnyElement => React.isValidElement<ElementProps>(child));
const textOf = (node: React.ReactNode): string =>
  React.Children.toArray(node).map((child) => (React.isValidElement<ElementProps>(child) ? textOf(child.props.children) : String(child))).join('');
const click = (element: AnyElement, event: unknown = { stopPropagation: noop }) => (element.props.onClick as (event: unknown) => void)(event);

/** A todoPanelStore that records what it is asked to do. */
function storeRecorder() {
  const calls: string[] = [];
  const record = (name: string) => (...args: unknown[]) => { calls.push(`${name}(${args.map((arg) => JSON.stringify(arg)).join(',')})`); };
  const store = Object.fromEntries(
    ['select', 'setDetailHidden', 'setCollapsed', 'toggleCategoryDone', 'setHideDone', 'changeFontSize', 'setOpen', 'setWidth', 'toggle']
      .map((name) => [name, record(name)]),
  );
  return { calls, store: { ...store, getState: () => ({ width: 320 }) }, folds: () => calls.filter((call) => call.startsWith('setCollapsed')) };
}

function rowView() {
  const recorder = storeRecorder();
  const render = component('TodoRowView', {
    todoAuthorLabel, canAddTodoChild, todoPieSlicePath, todoPanelStore: recorder.store,
    Icon: 'icon', TitleEditor: 'title-editor', DetailEditor: 'detail-editor', NewEntryInput: 'new-entry-input',
  });
  return { ...recorder, render };
}

const categoryRow = { item: item(1, null), depth: 1, categoryId: 1 };
const itemRow = { item: item(2, 1), depth: 2, categoryId: 1 };
const subRow = { item: item(4, 2), depth: 3, categoryId: 1 };

function rowProps(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const actions: TodoRowMenuActions = { editDetail: noop, editTitle: noop, addSibling: noop, addChild: noop, move: noop, toggleDone: noop, remove: noop };
  return {
    row: categoryRow, selected: false, categoryShowDone: true, progress: { done: 0, total: 2 }, detailHidden: false,
    editingDetail: false, editingTitle: false, addingDepth: null, actions, moveUp: null, moveDown: null,
    onSubmitNew: noop, onCancelNew: noop, onSaveTitle: noop, onCancelTitle: noop, onSaveDetail: async () => {}, onCancelDetail: noop,
    onContextMenu: noop, dropZone: null, onDragStart: noop, onDragOver: noop, onDragLeave: noop, onDrop: noop, onDragEnd: noop,
    fold: null,
    ...overrides,
  };
}

const checkboxRowProps = (row: typeof itemRow, fold: unknown) => rowProps({ row, progress: null, categoryShowDone: undefined, fold });

/** The row's own controls, left to right. */
const rowParts = (tree: React.ReactNode) => childElements(only(tree, (element) => element.props.role === 'treeitem', 'row').props.children);

test('FR-TODO-008 AC-1: a row with entries under it has a fold button left of its mark that tells whether it is open', () => {
  assert.ok(isIconName('chevron-down') && isIconName('chevron-right'));
  const { render, calls } = rowView();
  const open = rowParts(render(rowProps({ fold: { folded: false, count: 2 } })));
  const at = open.findIndex(withClass('todo-fold'));
  assert.ok(at >= 0 && at < open.findIndex(withClass('todo-status')), `the fold button (${at}) comes before the status icon`);
  const button = open[at];
  assert.equal(button.type, 'button');
  assert.equal(button.props.type, 'button');
  assert.equal(button.props['aria-expanded'], true);
  assert.equal(button.props['aria-label'], t('todo.fold'));
  assert.equal(button.props.title, t('todo.fold'));
  assert.equal(only(button.props.children, ofType('icon'), 'glyph').props.name, 'chevron-down');
  let stopped = 0;
  click(button, { stopPropagation: () => { stopped += 1; } });
  assert.equal(stopped, 1, 'the click does not reach the row, which would select it');
  assert.deepEqual(calls, ['setCollapsed(1,true)']);

  const closed = rowParts(render(rowProps({ fold: { folded: true, count: 2 } })));
  const unfold = closed.find(withClass('todo-fold'));
  assert.ok(unfold, 'a folded row has the button too');
  assert.equal(unfold.props['aria-expanded'], false);
  assert.equal(unfold.props['aria-label'], t('todo.unfold'));
  assert.equal(unfold.props.title, t('todo.unfold'));
  assert.equal(only(unfold.props.children, ofType('icon'), 'glyph').props.name, 'chevron-right');
  click(unfold);
  assert.deepEqual(calls, ['setCollapsed(1,true)', 'setCollapsed(1,false)']);

  const item = rowParts(render(checkboxRowProps(itemRow, { folded: false, count: 1 })));
  const itemAt = item.findIndex(withClass('todo-fold'));
  assert.ok(itemAt >= 0 && itemAt < item.findIndex(withClass('todo-check')), 'an item\'s fold button comes before its checkbox');
});

test('FR-TODO-008 AC-1: a row with nothing under it keeps the fold button\'s width empty, so the marks line up', () => {
  const { render } = rowView();
  for (const props of [rowProps({ fold: null }), checkboxRowProps(itemRow, null), checkboxRowProps(subRow, null)]) {
    const tree = render(props);
    const first = rowParts(tree)[0];
    assert.ok(hasClass(first, 'todo-fold-space'), 'the row starts with the empty slot');
    assert.equal(String(first.props['aria-hidden']), 'true');
    assert.equal(elements(tree, (element) => 'aria-expanded' in element.props).length, 0, 'no fold button');
  }
  const width = (selector: string) => /(?:^|[;\s])width:\s*([^;]+);/u.exec(cssRules(selector))?.[1]?.trim();
  assert.ok(width('.todo-fold'), 'the fold button has a set width');
  assert.equal(width('.todo-fold-space'), width('.todo-fold'));
  for (const selector of ['.todo-fold', '.todo-fold-space']) assert.match(cssRules(selector), /flex:\s*0 0 auto/u);
});

test('FR-TODO-008 AC-2: a folded row shows how many entries it hides, right after its title', () => {
  const { render } = rowView();
  const parts = rowParts(render(rowProps({ fold: { folded: true, count: 3 } })));
  const title = parts.findIndex(withClass('todo-row__title'));
  const count = parts.findIndex(withClass('todo-row__folded'));
  assert.ok(title >= 0 && count === title + 1, `the count (${count}) follows the title (${title})`);
  assert.equal(textOf(parts[count]), '+3');
  assert.equal(parts[count].props.title, tn('todo.hiddenCount', 3));
  for (const fold of [{ folded: false, count: 3 }, null]) {
    assert.equal(elements(render(rowProps({ fold })), withClass('todo-row__folded')).length, 0, 'an open row shows no count');
  }
});

function panelHarness(items: TodoItem[], panel: Record<string, unknown> = {}) {
  const recorder = storeRecorder();
  const states: unknown[] = [];
  let next = 0;
  // Keeps its values between draws, so what a handler sets shows in the next draw.
  const useState = (initial: unknown) => {
    const at = next++;
    if (!(at in states)) states[at] = initial;
    const set = (value: unknown) => { states[at] = typeof value === 'function' ? (value as (old: unknown) => unknown)(states[at]) : value; };
    return [states[at], set];
  };
  const moves: unknown[] = [];
  const render = component('TodoPanel', {
    useState, useMemo: (create: () => unknown) => create(), useCallback: (callback: unknown) => callback,
    useRef: (initial: unknown) => ({ current: initial }), useLayoutEffect: noop, useEffect: noop,
    useTodoPanelState: () => ({ open: true, width: 320, fontSize: 13, hideDone: false, categoryShowDone: {}, hiddenDetails: {}, collapsed: {}, selectedId: null, ...panel }),
    useTodos: () => ({ items, loaded: true, error: null, refresh: async () => {} }),
    todoPanelStore: recorder.store,
    todoApi: { add: async () => ({ id: 99 }), move: async (id: number, to: unknown) => { moves.push([id, to]); }, update: async () => ({}), remove: async () => {} },
    errorText: String,
    canAddTodoChild, categoryShowsDone, detailSaveRemoves, siblingMove, siblingParentId, todoAuthorLabel, todoDescendantCount,
    todoDropMove, todoDropZone, todoListPlaceholder, todoRows, TODO_DETAIL_MAX, TODO_TITLE_MAX,
    todoDeleteMessage, todoPanelMenuItems, todoRowMenuItems, todoPieSlicePath, todoProgress, todoTreePath,
    Icon: 'icon', Button: 'ui-button', ContextMenu: 'context-menu', MessageBox: 'message-box',
    TodoRowView: 'todo-row-view', NewEntryInput: 'new-entry-input',
  });
  const draw = () => { next = 0; return render({ isMobile: false }); };
  const rowOf = (tree: React.ReactNode, id: number) =>
    only(tree, (element) => element.type === 'todo-row-view' && (element.props.row as TodoRow).item.id === id, `row #${id}`);
  const rowIds = (tree: React.ReactNode) => elements(tree, ofType('todo-row-view')).map((element) => (element.props.row as TodoRow).item.id);
  return { ...recorder, moves, draw, rowOf, rowIds };
}

test('FR-TODO-008 AC-1/AC-2/AC-5: the panel folds the stored ids, finds children in the whole list, counts what a fold hides, and its pie still counts it', () => {
  // 1 > 2 > 4 ; 1 > 5 (done) ; 3 > 6 (done) ; 7
  const items = [item(1, null), item(2, 1), item(3, null), item(4, 2), item(5, 1, true), item(6, 3, true), item(7, null)];
  const open = panelHarness(items, { hideDone: true });
  const openTree = open.draw();
  assert.deepEqual(open.rowIds(openTree), [1, 2, 4, 3, 7]);
  assert.deepEqual(open.rowOf(openTree, 1).props.fold, { folded: false, count: 3 });
  assert.deepEqual(open.rowOf(openTree, 2).props.fold, { folded: false, count: 1 });
  assert.equal(open.rowOf(openTree, 4).props.fold, null);
  // 3's only entry is done and hidden, and 3 can still be folded.
  assert.deepEqual(open.rowOf(openTree, 3).props.fold, { folded: false, count: 1 });
  assert.equal(open.rowOf(openTree, 7).props.fold, null);

  const folded = panelHarness(items, { hideDone: true, collapsed: { 1: true } });
  const foldedTree = folded.draw();
  assert.deepEqual(folded.rowIds(foldedTree), [1, 3, 7]);
  assert.deepEqual(folded.rowOf(foldedTree, 1).props.fold, { folded: true, count: todoDescendantCount(items, 1) });
  assert.equal(todoDescendantCount(items, 1), 3);
  assert.deepEqual(folded.rowOf(foldedTree, 1).props.progress, { done: 1, total: 3 });
});

test('FR-TODO-008 AC-4: adding a child under a folded entry, from its row or its right-click menu, unfolds it', () => {
  const harness = panelHarness([item(1, null), item(2, 1), item(3, null)], { collapsed: { 1: true } });
  let tree = harness.draw();
  (harness.rowOf(tree, 1).props.actions as TodoRowMenuActions).addChild();
  assert.deepEqual(harness.folds(), ['setCollapsed(1,false)']);
  tree = harness.draw();
  assert.equal(harness.rowOf(tree, 1).props.addingDepth, 2, 'the new-entry box opens under it');

  harness.calls.length = 0;
  (harness.rowOf(tree, 1).props.onContextMenu as (event: unknown) => void)({
    target: { closest: () => null }, preventDefault: noop, stopPropagation: noop, clientX: 10, clientY: 20,
  });
  tree = harness.draw();
  const menu = only(tree, ofType('context-menu'), 'row menu');
  const addChild = (menu.props.items as ContextMenuItem[])
    .filter((entry): entry is ContextMenuActionItem => !entry.separator)
    .find((entry) => entry.label === t('todo.addChild'));
  assert.ok(addChild?.onClick, 'the menu offers to add a child');
  addChild.onClick();
  assert.deepEqual(harness.folds(), ['setCollapsed(1,false)']);

  // Adding beside a folded entry leaves it folded.
  harness.calls.length = 0;
  (harness.rowOf(harness.draw(), 1).props.actions as TodoRowMenuActions).addSibling();
  assert.deepEqual(harness.folds(), []);
});

test('FR-TODO-008 AC-4: submitting a child unfolds its parent, even when it was folded again while the box was open', () => {
  const harness = panelHarness([item(1, null), item(2, 1), item(3, null)], { collapsed: { 1: true } });
  let tree = harness.draw();
  (harness.rowOf(tree, 1).props.actions as TodoRowMenuActions).addChild();
  tree = harness.draw();
  harness.calls.length = 0;
  (harness.rowOf(tree, 1).props.onSubmitNew as (title: string) => void)('new child');
  assert.deepEqual(harness.folds(), ['setCollapsed(1,false)']);
});

test('FR-TODO-008 AC-1: the new-entry box keeps the fold column, so it starts where the row marks do', () => {
  const body = /function NewEntryInput[\s\S]*?\n\}/u.exec(panelSource)?.[0] ?? '';
  const space = body.indexOf('todo-fold-space');
  const input = body.indexOf('<input');
  assert.ok(space > 0 && input > space, 'an empty fold column comes before the input');
});

test('FR-TODO-008 AC-4: dropping an entry into a folded entry unfolds it; dropping it beside leaves it folded', () => {
  const harness = panelHarness([item(1, null), item(2, 1), item(3, null)], { collapsed: { 1: true } });
  const dragEvent = (clientY: number) => ({
    preventDefault: noop, clientY,
    currentTarget: { getBoundingClientRect: () => ({ top: 0, height: 40 }) },
    dataTransfer: { effectAllowed: '', dropEffect: '', setData: noop },
  });
  const dragOnto = (dragId: number, targetId: number, clientY: number) => {
    const tree = harness.draw();
    (harness.rowOf(tree, dragId).props.onDragStart as (event: unknown) => void)(dragEvent(0));
    (harness.rowOf(tree, targetId).props.onDrop as (event: unknown) => void)(dragEvent(clientY));
  };
  // The middle of the folded category: inside it.
  dragOnto(3, 1, 20);
  assert.deepEqual(harness.folds(), ['setCollapsed(1,false)']);
  // Its top quarter: before it, beside it.
  harness.calls.length = 0;
  dragOnto(3, 1, 2);
  assert.deepEqual(harness.folds(), []);
  assert.deepEqual(harness.moves, [[3, { parentId: 1, beforeId: null }], [3, { parentId: null, beforeId: 1 }]], 'both drops were sent');
});

test('FR-TODO-008 AC-6: the fold button and the hidden count take their words from both catalogs', () => {
  for (const key of ['todo.fold', 'todo.unfold']) {
    assert.ok(en[key]?.trim(), `en ${key}`);
    assert.ok(koCatalog[key]?.trim(), `ko ${key}`);
  }
  assert.notEqual(en['todo.fold'], en['todo.unfold']);
  assert.notEqual(koCatalog['todo.fold'], koCatalog['todo.unfold']);
  // A plural family: one and other in English, other alone in Korean.
  assert.match(en['todo.hiddenCount.one'] ?? '', /\{count\}/u);
  assert.match(en['todo.hiddenCount.other'] ?? '', /\{count\}/u);
  assert.match(koCatalog['todo.hiddenCount.other'] ?? '', /\{count\}/u);
  assert.equal(koCatalog['todo.hiddenCount.one'], undefined);
  // No particle that changes with the sound right after the placeholder.
  assert.doesNotMatch(koCatalog['todo.hiddenCount.other'] ?? '', /\}(을|를|이|가|은|는|와|과|으로|로)/u);
  assert.equal(tn('todo.hiddenCount', 3), (koCatalog['todo.hiddenCount.other'] ?? '').replace('{count}', '3'));
});

test('FR-TODO-008 AC-1/AC-2: the fold button and the count use the design tokens and sit on the title\'s first line', () => {
  for (const selector of ['.todo-fold', '.todo-fold-space', '.todo-row__folded']) {
    assert.doesNotMatch(cssRules(selector), /#[0-9a-fA-F]{3,8}\b/u, `${selector} has no hex colour`);
  }
  assert.match(cssRules('.todo-fold'), /margin-top:\s*calc\(\(var\(--row-line\)/u);
  assert.match(cssRules('.todo-row__folded'), /line-height:\s*var\(--row-line\)/u);
  assert.match(cssRules('.todo-row__folded'), /font-size:\s*var\(--fs-/u);
});
