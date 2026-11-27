// FR-UIDS-016: the desktop workspace sidebar folds behind a hamburger button to a
// narrow column of circles, one per workspace, and unfolds again. The phone drawer
// shows the same sidebar and never folds.
//
// Like workspaceCapacityUi.test.ts, the sidebar and its row are judged by running
// their own render functions with real React elements and inert hooks: what is
// drawn, with which props, and what the handlers call. Browser layout is not
// measured here.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as React from 'react';
import ts from 'typescript';
import { koCatalog } from './i18nTestSetup.ts';
import { t, tn } from '../../src/i18n/i18n.ts';
import { isIconName } from '../../src/components/common/iconGlyphs.ts';
import { countAwaitingInputTabs } from '../../src/components/Workspace/awaitingInputTabs.ts';
import { workspaceActivity } from '../../src/components/Workspace/workspaceActivity.ts';

const SIDEBAR = '../../src/components/Workspace/WorkspaceSidebar.tsx';
const ITEM = '../../src/components/Workspace/WorkspaceItem.tsx';
const BADGE = '../../src/components/Workspace/AwaitingInputBadge.tsx';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

// The modules this feature adds load inside the tests that use them, so a missing
// one fails those tests rather than the whole file.
const storeModule = () => import('../../src/components/Workspace/workspaceSidebarStore.ts');
const initialModule = () => import('../../src/components/Workspace/workspaceInitial.ts');

type ElementProps = { [key: string]: unknown; children?: React.ReactNode };
type AnyElement = React.ReactElement<ElementProps>;
type Render = (props: Record<string, unknown>) => React.ReactNode;

/** Runs one function component from its source with the given imports injected. */
function component(path: string, name: string, dependencies: Record<string, unknown>): Render {
  const url = new URL(path, import.meta.url);
  const ast = ts.createSourceFile(url.pathname, readFileSync(url, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found = ast.statements.filter(ts.isFunctionDeclaration).filter((node) => node.name?.text === name);
  assert.equal(found.length, 1, `${path} declares ${name} once`);
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

const noop = () => {};
const workspace = (id: string, name: string, sortOrder: number) =>
  ({ id, name, sortOrder, viewMode: 'tab', activeTabId: null, createdAt: 1 });

const sidebar = component(SIDEBAR, 'WorkspaceSidebar', {
  useState: (initial: unknown) => [initial, noop],
  useCallback: (callback: unknown) => callback,
  useDragReorder: () => ({
    getTabHandlers: (index: number) => ({ onPointerDown: noop, index }),
    dropTargetIndex: null, dragIndex: null, ghostStyle: null, tabRefs: { current: [] },
  }),
  WorkspaceItem: 'workspace-item', ContextMenu: 'context-menu', Icon: 'icon',
  BUILD_LABEL: 'v0.0.0',
  UsageLimitsPanel: 'usage-limits-panel',
  countAwaitingInputTabs,
});

function renderSidebar(props: Record<string, unknown>) {
  const changes: boolean[] = [];
  const onCreate = () => {};
  const tree = sidebar({
    workspaces: [workspace('w1', 'alpha', 0), workspace('w2', '베타', 1)],
    tabs: [], activeWorkspaceId: 'w1', maxTabsPerWorkspace: 8,
    onSelect: noop, onCreate, onRename: noop, onDelete: noop, onAddTab: noop, onReorder: noop,
    onCollapsedChange: (collapsed: boolean) => { changes.push(collapsed); },
    ...props,
  });
  return { tree, changes, onCreate };
}

function item(dependencies: Record<string, unknown> = {}): Render {
  return component(ITEM, 'WorkspaceItem', {
    useState: (initial: unknown) => [initial, noop],
    useRef: (initial: unknown) => ({ current: initial }),
    useEffect: noop,
    useContextMenu: () => ({ isOpen: false, targetId: null, position: { x: 0, y: 0 }, open: noop, close: noop }),
    ContextMenu: 'context-menu',
    workspaceActivity,
    WorkspaceAwaitingInputBadge: 'workspace-awaiting-input-badge',
    useDoubleTap: () => ({ onTouchStart: noop, onTouchEnd: noop }),
    useTabDropHoverId: () => null,
    workspaceInitial: () => 'A',
    ...dependencies,
  });
}

function itemProps(props: Record<string, unknown> = {}) {
  return {
    workspace: workspace('w1', 'alpha', 0), isActive: true, runningCount: 3, awaitingCount: 2, isLast: false,
    onClick: noop, onRename: noop, onDelete: noop, onAddTab: noop, tabCount: 1, maxTabs: 8,
    dragHandlers: { onPointerDown: noop }, isDragTarget: false,
    ...props,
  };
}

function cssRules(css: string, selector: string): string {
  const bodies: string[] = [];
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
    if (match[1].split(',').map((part) => part.trim()).includes(selector)) bodies.push(match[2]);
  }
  assert.ok(bodies.length > 0, `Workspace.css styles ${selector}`);
  return bodies.join('\n');
}

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
  };
}

test('FR-UIDS-016 AC-1: the desktop header puts a hamburger right of the title, beside the add button, and it toggles with aria-expanded', () => {
  const expanded = renderSidebar({ collapsible: true, collapsed: false });
  const header = only(expanded.tree, withClass('workspace-sidebar-header'), 'header');
  const parts = childElements(header.props.children);
  assert.equal(parts.length, 3, 'title, hamburger and add button');
  assert.ok(hasClass(parts[0], 'workspace-sidebar-title'), 'the title comes first');
  assert.ok(hasClass(parts[1], 'workspace-sidebar-toggle'), 'the hamburger is right of the title');
  assert.ok(hasClass(parts[2], 'workspace-sidebar-add'), 'and beside the add button');
  const toggle = parts[1];
  assert.equal(toggle.type, 'button');
  assert.equal(toggle.props.type, 'button');
  assert.equal(toggle.props['aria-expanded'], true);
  assert.equal(only(toggle.props.children, ofType('icon'), 'glyph').props.name, 'menu');
  assert.equal(isIconName('menu'), true, 'the hamburger is a shared glyph');
  (toggle.props.onClick as () => void)();
  assert.deepEqual(expanded.changes, [true], 'pressing it folds the sidebar');

  const folded = renderSidebar({ collapsible: true, collapsed: true });
  const foldedToggle = only(folded.tree, withClass('workspace-sidebar-toggle'), 'hamburger');
  assert.equal(foldedToggle.props['aria-expanded'], false);
  (foldedToggle.props.onClick as () => void)();
  assert.deepEqual(folded.changes, [false], 'pressing it again unfolds the sidebar');
  assert.match(read(SIDEBAR), /aria-expanded=\{!collapsed\}/u);
});

test('FR-UIDS-016 AC-8: the hamburger takes its title and aria-label from the en and ko catalogs', () => {
  const en = JSON.parse(read('../../public/locales/messages.en.json')) as Record<string, string>;
  for (const key of ['workspace.sidebar.collapse', 'workspace.sidebar.expand']) {
    assert.ok(en[key]?.trim(), `en has ${key}`);
    assert.ok(koCatalog[key]?.trim(), `ko has ${key}`);
    assert.doesNotMatch(en[key], /[가-힣ㄱ-ㆎ]/u, `en ${key} has no Hangul`);
    assert.equal(koCatalog[key].includes('워크스페이스'), false, `ko ${key} does not transliterate Workspace`);
  }
  assert.notEqual(koCatalog['workspace.sidebar.collapse'], koCatalog['workspace.sidebar.expand']);

  const expanded = only(renderSidebar({ collapsible: true, collapsed: false }).tree, withClass('workspace-sidebar-toggle'), 'hamburger');
  assert.equal(expanded.props['aria-label'], koCatalog['workspace.sidebar.collapse']);
  assert.equal(expanded.props.title, koCatalog['workspace.sidebar.collapse']);
  const folded = only(renderSidebar({ collapsible: true, collapsed: true }).tree, withClass('workspace-sidebar-toggle'), 'hamburger');
  assert.equal(folded.props['aria-label'], koCatalog['workspace.sidebar.expand']);
  assert.equal(folded.props.title, koCatalog['workspace.sidebar.expand']);
});

test('FR-UIDS-016 AC-4: folded, the header holds only the hamburger; the add button, usage limits and version line are not rendered', () => {
  const folded = renderSidebar({ collapsible: true, collapsed: true });
  assert.ok(hasClass(folded.tree as AnyElement, 'is-collapsed'), 'the sidebar root says it is folded');
  const header = only(folded.tree, withClass('workspace-sidebar-header'), 'header');
  const parts = childElements(header.props.children);
  assert.equal(parts.length, 1, 'the header holds one control');
  assert.ok(hasClass(parts[0], 'workspace-sidebar-toggle'), 'and it is the hamburger');
  assert.equal(elements(folded.tree, withClass('workspace-sidebar-title')).length, 0, 'no title');
  assert.equal(elements(folded.tree, (element) => element.props.onClick === folded.onCreate).length, 0, 'no add button');
  assert.equal(elements(folded.tree, ofType('usage-limits-panel')).length, 0, 'no usage limits panel');
  assert.equal(elements(folded.tree, withClass('workspace-sidebar-version')).length, 0, 'no version line');

  const expanded = renderSidebar({ collapsible: true, collapsed: false });
  assert.equal(hasClass(expanded.tree as AnyElement, 'is-collapsed'), false);
  assert.equal(elements(expanded.tree, withClass('workspace-sidebar-title')).length, 1);
  assert.equal(elements(expanded.tree, (element) => element.props.onClick === expanded.onCreate).length, 1);
  assert.equal(elements(expanded.tree, ofType('usage-limits-panel')).length, 1);
  assert.equal(elements(expanded.tree, withClass('workspace-sidebar-version')).length, 1);
});

test('FR-UIDS-016 AC-7: the phone drawer does not fold: no hamburger and the full list even when the stored flag says folded', () => {
  for (const props of [{ collapsible: false, collapsed: true }, { collapsed: true }]) {
    const drawer = renderSidebar(props);
    assert.equal(elements(drawer.tree, withClass('workspace-sidebar-toggle')).length, 0, 'no hamburger');
    assert.equal(hasClass(drawer.tree as AnyElement, 'is-collapsed'), false);
    assert.equal(elements(drawer.tree, withClass('workspace-sidebar-title')).length, 1);
    assert.equal(elements(drawer.tree, (element) => element.props.onClick === drawer.onCreate).length, 1);
    assert.equal(elements(drawer.tree, ofType('usage-limits-panel')).length, 1);
    assert.equal(elements(drawer.tree, withClass('workspace-sidebar-version')).length, 1);
    for (const entry of elements(drawer.tree, ofType('workspace-item'))) {
      assert.notEqual(entry.props.collapsed, true, 'every row is drawn in full');
    }
  }

  const app = read('../../src/App.tsx');
  assert.equal(app.match(/<WorkspaceSidebar\b/gu)?.length, 1, 'one sidebar element serves the desktop column and the drawer');
  const element = /<WorkspaceSidebar\b[\s\S]*?\/>/u.exec(app)?.[0] ?? '';
  assert.match(element, /collapsible=\{!isMobile\}/u, 'only the desktop layout may fold it');
  assert.match(app, /<MobileDrawer\b[^>]*>\s*\{sidebarContent\}\s*<\/MobileDrawer>/u);
});

test('FR-UIDS-016 AC-2 AC-5: the desktop column follows the stored flag, about 56px folded and 220px expanded', async () => {
  const { WORKSPACE_SIDEBAR_WIDTH, WORKSPACE_SIDEBAR_COLLAPSED_WIDTH } = await storeModule();
  assert.equal(WORKSPACE_SIDEBAR_WIDTH, 220, 'expanded keeps the width it always had');
  assert.ok(
    WORKSPACE_SIDEBAR_COLLAPSED_WIDTH >= 48 && WORKSPACE_SIDEBAR_COLLAPSED_WIDTH <= 64,
    `folded is narrow: ${WORKSPACE_SIDEBAR_COLLAPSED_WIDTH}px`,
  );
  const app = read('../../src/App.tsx');
  assert.match(app, /const sidebarCollapsed = useWorkspaceSidebarCollapsed\(\);/u);
  assert.match(
    app,
    /<aside className="sidebar" style=\{\{ width: sidebarCollapsed \? WORKSPACE_SIDEBAR_COLLAPSED_WIDTH : WORKSPACE_SIDEBAR_WIDTH,/u,
  );
  const element = /<WorkspaceSidebar\b[\s\S]*?\/>/u.exec(app)?.[0] ?? '';
  assert.match(element, /collapsed=\{sidebarCollapsed\}/u);
  assert.match(element, /onCollapsedChange=\{workspaceSidebarStore\.setCollapsed\}/u);
});

test('FR-UIDS-016 AC-5: the folded flag is stored under its key and comes back after a reload', async () => {
  const { createWorkspaceSidebarStore, WORKSPACE_SIDEBAR_STORAGE_KEY } = await storeModule();
  assert.equal(WORKSPACE_SIDEBAR_STORAGE_KEY, 'buildergate.workspaceSidebar.collapsed');
  const storage = memoryStorage();
  const store = createWorkspaceSidebarStore(storage);
  assert.equal(store.getState(), false, 'nothing stored: expanded');
  let heard = 0;
  const off = store.subscribe(() => { heard += 1; });
  store.setCollapsed(true);
  assert.equal(store.getState(), true);
  assert.equal(storage.data.get(WORKSPACE_SIDEBAR_STORAGE_KEY), 'true');
  assert.equal(createWorkspaceSidebarStore(storage).getState(), true, 'a reload starts folded');
  store.setCollapsed(true);
  assert.equal(heard, 1, 'setting the same value again is silent');
  store.setCollapsed(false);
  assert.equal(storage.data.get(WORKSPACE_SIDEBAR_STORAGE_KEY), 'false');
  assert.equal(createWorkspaceSidebarStore(storage).getState(), false, 'a reload after unfolding starts expanded');
  assert.equal(heard, 2);
  off();
  store.setCollapsed(true);
  assert.equal(heard, 2, 'an unsubscribed listener hears nothing');
});

test('FR-UIDS-016 AC-5: a missing or invalid stored value starts expanded', async () => {
  const { createWorkspaceSidebarStore, WORKSPACE_SIDEBAR_STORAGE_KEY } = await storeModule();
  for (const raw of ['', 'false', '1', 'yes', 'TRUE', ' true', 'null', '{"collapsed":true}']) {
    const store = createWorkspaceSidebarStore(memoryStorage({ [WORKSPACE_SIDEBAR_STORAGE_KEY]: raw }));
    assert.equal(store.getState(), false, `stored ${JSON.stringify(raw)}`);
  }
  assert.equal(createWorkspaceSidebarStore(memoryStorage({ 'buildergate.todoPanel': 'true' })).getState(), false, 'another key does not count');
});

test('FR-UIDS-016 AC-5: storage that throws, or none at all, starts expanded and still folds in memory', async () => {
  const { createWorkspaceSidebarStore } = await storeModule();
  const broken = {
    getItem: (): string | null => { throw new Error('site data blocked'); },
    setItem: (): void => { throw new Error('site data blocked'); },
  };
  for (const storage of [broken, null]) {
    const store = createWorkspaceSidebarStore(storage);
    assert.equal(store.getState(), false, 'starts expanded');
    let heard = 0;
    store.subscribe(() => { heard += 1; });
    assert.doesNotThrow(() => store.setCollapsed(true));
    assert.equal(store.getState(), true, 'folds in memory');
    assert.equal(heard, 1);
  }
});

test('FR-UIDS-016 AC-2: the circle letter is the first character of the trimmed name, uppercased, never half a surrogate pair', async () => {
  const { workspaceInitial } = await initialModule();
  assert.equal(workspaceInitial('alpha'), 'A');
  assert.equal(workspaceInitial('Beta'), 'B');
  assert.equal(workspaceInitial('  zeta  '), 'Z');
  assert.equal(workspaceInitial('\tépsilon'), 'É');
  assert.equal(workspaceInitial('한글 작업'), '한');
  assert.equal(workspaceInitial('😀 party'), '😀');
  assert.equal(workspaceInitial('\u{1d4b3} math'), '\u{1d4b3}');
  assert.equal(workspaceInitial('1번 서버'), '1');
  // Uppercase that would become two letters (ß -> SS, ﬁ -> FI) keeps the one it had.
  assert.equal(workspaceInitial('ßeta'), 'ß');
  assert.equal(workspaceInitial('ﬁle'), 'ﬁ');
  for (const name of ['alpha', '한글', '😀 party', '\u{1d4b3}', 'ßeta', 'ﬁle']) {
    assert.equal(Array.from(workspaceInitial(name)).length, 1, `${name}: one character`);
  }
});

test('FR-UIDS-016 AC-2: the circle letter is a whole grapheme — a flag, an emoji with its variation selector, a decomposed Hangul syllable', async () => {
  const { workspaceInitial } = await initialModule();
  assert.equal(workspaceInitial('\u{1f1f0}\u{1f1f7} team'), '\u{1f1f0}\u{1f1f7}');
  assert.equal(workspaceInitial('\u2764\ufe0f ops'), '\u2764\ufe0f');
  assert.equal(workspaceInitial('\u1112\u1161\u11ab \uae00'), '\ud55c');
});

test('FR-UIDS-016 AC-2: an empty or blank name still gets one placeholder character', async () => {
  const { workspaceInitial, WORKSPACE_INITIAL_FALLBACK } = await initialModule();
  assert.equal(Array.from(WORKSPACE_INITIAL_FALLBACK).length, 1, 'one character');
  assert.notEqual(WORKSPACE_INITIAL_FALLBACK.trim(), '', 'a visible one');
  for (const name of ['', '   ', '\t\n']) {
    assert.equal(workspaceInitial(name), WORKSPACE_INITIAL_FALLBACK, `${JSON.stringify(name)}`);
  }
});

test('FR-UIDS-016 AC-2 AC-3: a folded row is a circle with the initial and the full name, the waiting count left and the running count right', async () => {
  const { workspaceInitial } = await initialModule();
  const row = item({ workspaceInitial });
  const tree = row(itemProps({ collapsed: true }));
  assert.ok(hasClass(only(tree, withClass('workspace-item'), 'row'), 'is-collapsed'));
  const circle = only(tree, withClass('workspace-item-initial'), 'circle');
  assert.equal(circle.props.children, 'A', 'the first letter of alpha');
  assert.equal(circle.props.title, 'alpha', 'the full name on hover');
  assert.equal(circle.props['aria-label'], 'alpha', 'and for a screen reader');
  assert.equal(elements(tree, withClass('workspace-item-name')).length, 0, 'the name text gives way to the circle');
  assert.equal(elements(tree, withClass('workspace-item-dot')).length, 0, 'the activity dot is not drawn folded');
  assert.equal(only(tree, ofType('workspace-awaiting-input-badge'), 'waiting badge').props.count, 2);
  assert.equal(only(tree, withClass('workspace-item-running'), 'running badge').props.children, 3);
  assert.equal(elements(row(itemProps({ collapsed: true, runningCount: 0 })), withClass('workspace-item-running')).length, 0, 'no running badge at 0');
  assert.equal(only(row(itemProps({ collapsed: true, workspace: workspace('w1', '  한글', 0) })), withClass('workspace-item-initial'), 'circle').props.children, '한');

  // The waiting badge the folded row reuses draws nothing at 0.
  const badge = component(BADGE, 'WorkspaceAwaitingInputBadge', {});
  assert.equal(badge({ count: 0 }), null);
  assert.ok(hasClass(badge({ count: 2 }) as AnyElement, 'workspace-item-awaiting'));

  // Expanded rows are unchanged: the name and the dot, no circle.
  const expanded = row(itemProps());
  assert.equal(elements(expanded, withClass('workspace-item-initial')).length, 0);
  assert.equal(only(expanded, withClass('workspace-item-name'), 'name').props.children, 'alpha');
  assert.equal(elements(expanded, withClass('workspace-item-dot')).length, 1);
});

test('FR-UIDS-016 AC-2 AC-3: folded styles use tokens only: a pill circle, an accent ring when active, the badges left and right in their own tones', () => {
  const css = read('../../src/components/Workspace/Workspace.css').replace(/\/\*[\s\S]*?\*\//gu, '');
  const circle = cssRules(css, '.workspace-item-initial');
  assert.match(circle, /border-radius:\s*var\(--r-pill\)/u);
  assert.match(circle, /(?<![\w-])width:\s*var\(--ctl-[a-z]+\)/u);
  assert.match(circle, /(?<![\w-])height:\s*var\(--ctl-[a-z]+\)/u);
  assert.match(circle, /font-size:\s*var\(--fs-[a-z0-9]+\)/u);
  assert.match(cssRules(css, '.workspace-item.active .workspace-item-initial'), /var\(--accent\)/u);
  const row = cssRules(css, '.workspace-item.is-collapsed');
  assert.match(row, /position:\s*relative/u);
  const awaiting = cssRules(css, '.workspace-item.is-collapsed .workspace-item-awaiting');
  const running = cssRules(css, '.workspace-item.is-collapsed .workspace-item-running');
  assert.match(awaiting, /position:\s*absolute/u);
  assert.match(awaiting, /(?<![\w-])left:/u, 'the waiting count sits left of the circle');
  assert.match(running, /position:\s*absolute/u);
  assert.match(running, /(?<![\w-])right:/u, 'the running count sits right of the circle');
  for (const body of [awaiting, running]) assert.doesNotMatch(body, /background/u, 'the folded badges keep their tones');
  assert.match(cssRules(css, '.workspace-item .workspace-item-awaiting'), /background:\s*var\(--attention\)/u);
  assert.match(cssRules(css, '.workspace-item .workspace-item-running'), /background:\s*var\(--warn\)/u);
  assert.doesNotMatch([circle, row, awaiting, running].join('\n'), /#[0-9a-f]{3,8}\b|rgba?\(/iu, 'no raw colour (CON-UIDS-001)');
});

test('FR-UIDS-016 AC-6: a folded row keeps click select, the context menu, drag reorder and the tab drop target', () => {
  const opened: unknown[][] = [];
  const row = item({
    useContextMenu: () => ({
      isOpen: true, targetId: 'w1', position: { x: 5, y: 6 },
      open: (...args: unknown[]) => { opened.push(args); }, close: noop,
    }),
    useTabDropHoverId: () => 'w1',
  });
  const onClick = () => {};
  const dragHandlers = { onPointerDown: () => {} };
  const tree = row(itemProps({ collapsed: true, onClick, dragHandlers }));
  const element = only(tree, withClass('workspace-item'), 'row');
  assert.ok(hasClass(element, 'is-collapsed'));
  assert.equal(element.props.role, 'option');
  assert.equal(element.props.onClick, onClick, 'a click selects');
  assert.equal(element.props.onPointerDown, dragHandlers.onPointerDown, 'a press starts the drag reorder');
  assert.equal(element.props['data-workspace-drop-id'], 'w1', 'a dragged tab can drop here');
  assert.ok(hasClass(element, 'tab-drop-target'), 'and the row lights while it would');
  let prevented = false;
  (element.props.onContextMenu as (event: unknown) => void)({ preventDefault: () => { prevented = true; }, clientX: 5, clientY: 6 });
  assert.equal(prevented, true);
  assert.deepEqual(opened, [[5, 6, 'w1']], 'a right click opens the row menu');
  assert.equal(elements(tree, ofType('context-menu')).length, 1, 'the open menu is drawn for the folded row');

  const folded = renderSidebar({ collapsible: true, collapsed: true });
  const items = elements(folded.tree, ofType('workspace-item'));
  assert.equal(items.length, 2);
  items.forEach((entry, index) => {
    assert.equal(entry.props.collapsed, true, 'the sidebar folds every row');
    assert.equal((entry.props.dragHandlers as { index?: number } | undefined)?.index, index, 'the drag reorder reaches every folded row');
    assert.equal(typeof entry.props.onClick, 'function');
  });
});

test('FR-UIDS-016 AC-6: starting a rename on a folded row unfolds the sidebar first, then edits', () => {
  const events: string[] = [];
  const row = item({
    useState: (initial: unknown) => [initial, (value: unknown) => { if (value === true) events.push('edit'); }],
    useContextMenu: () => ({ isOpen: true, targetId: 'w1', position: { x: 0, y: 0 }, open: noop, close: noop }),
  });
  const tree = row(itemProps({ collapsed: true, onRequestExpand: () => { events.push('expand'); } }));
  const menu = only(tree, ofType('context-menu'), 'context menu');
  const rename = (menu.props.items as Array<{ label?: string; onClick?: () => void }>).find((entry) => entry.label === t('common.rename'));
  const startFromMenu = rename?.onClick;
  assert.ok(startFromMenu, 'the menu offers rename');
  startFromMenu();
  assert.deepEqual(events, ['expand', 'edit'], 'menu rename: unfold, then edit');

  events.length = 0;
  (only(tree, withClass('workspace-item'), 'row').props.onDoubleClick as () => void)();
  assert.deepEqual(events, ['expand', 'edit'], 'double-click rename: unfold, then edit');

  const folded = renderSidebar({ collapsible: true, collapsed: true });
  for (const entry of elements(folded.tree, ofType('workspace-item'))) (entry.props.onRequestExpand as () => void)();
  assert.deepEqual(folded.changes, [false, false], 'the request unfolds the desktop column');
  const drawer = renderSidebar({ collapsible: false, collapsed: true });
  for (const entry of elements(drawer.tree, ofType('workspace-item'))) {
    assert.equal(entry.props.onRequestExpand, undefined, 'a rename in the drawer leaves the desktop flag alone');
  }
});
