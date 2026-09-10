import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  hasEditorTrayWindows,
  listEditorTrayEntries,
  reviveEditorTrayWindow,
  type EditorTrayWindow,
} from '../../src/components/editor/editorTrayModel.ts';

// FR-MDE-008 — the tray's pure logic: the icon's own visibility condition, the
// workspace scoping of the list with its dirty marker, and the revival that
// resolves every visibility condition it can rather than only `minimized`.
//
// AC-3 asserts a DOM sibling position inside `header-right` and AC-8 reads the
// registry entry a tab produces at runtime; both belong to the Playwright suite,
// which has a browser. This one has neither.

const ACTIVE = 'ws-active';
const OTHER = 'ws-other';

function windowOf(overrides: Partial<EditorTrayWindow> = {}): EditorTrayWindow {
  return {
    filePath: 'C:\\Work\\proj\\CLAUDE.md',
    tabId: 'tab-1',
    workspaceId: ACTIVE,
    minimized: false,
    dirty: false,
    ...overrides,
  };
}

test('FR-MDE-008 the tray icon renders only while the current workspace holds a window', () => {
  assert.equal(hasEditorTrayWindows([], ACTIVE), false);
  assert.equal(hasEditorTrayWindows([windowOf()], ACTIVE), true);

  // A minimized window still counts: the tray is how it is reached, so an icon
  // that vanished once the last window was minimized would strand it.
  assert.equal(hasEditorTrayWindows([windowOf({ minimized: true })], ACTIVE), true);

  // No workspace selected at all is not "every window matches".
  assert.equal(hasEditorTrayWindows([windowOf()], null), false);
});

test('FR-MDE-008 windows in another workspace do not render the icon', () => {
  assert.equal(hasEditorTrayWindows([windowOf({ workspaceId: OTHER })], ACTIVE), false);

  // The icon's condition and the list's scope are the same one, so the icon can
  // never stand above an empty list.
  const foreign = [windowOf({ workspaceId: OTHER })];
  assert.equal(hasEditorTrayWindows(foreign, ACTIVE), false);
  assert.deepEqual(listEditorTrayEntries(foreign, ACTIVE), []);
});

test('FR-MDE-008 the list is workspace scoped and marks dirty documents', () => {
  const w1 = windowOf({
    filePath: 'C:\\Work\\proj\\CLAUDE.md',
    tabId: 'tab-1',
    dirty: true,
    minimized: true,
  });
  const w2 = windowOf({
    filePath: 'C:\\Work\\proj\\AGENTS.md',
    tabId: 'tab-2',
    dirty: false,
    minimized: false,
  });
  const w3 = windowOf({
    filePath: 'D:\\other\\CLAUDE.md',
    tabId: 'tab-9',
    workspaceId: OTHER,
  });

  assert.deepEqual(listEditorTrayEntries([w1, w2, w3], ACTIVE), [
    { filePath: w1.filePath, tabId: 'tab-1', label: 'C:\\Work\\proj\\CLAUDE.md*' },
    { filePath: w2.filePath, tabId: 'tab-2', label: 'C:\\Work\\proj\\AGENTS.md' },
  ]);
});

test('FR-MDE-008 revival clears minimized and switches to the bound tab', () => {
  const target = windowOf({ tabId: 'tab-2', minimized: true });
  const other = windowOf({ filePath: 'C:\\Work\\proj\\AGENTS.md', tabId: 'tab-1' });

  const revival = reviveEditorTrayWindow({
    target,
    windows: [other, target],
    screen: 'workspace',
    viewMode: 'tab',
    activeTabId: 'tab-1',
  });

  assert.equal(revival.activeTabId, 'tab-2');
  assert.equal(revival.raise, target.filePath);
  assert.equal(
    revival.windows.find(w => w.filePath === target.filePath)?.minimized,
    false,
  );

  // Grid mode puts every tab on screen at once, so there is nothing to switch to
  // and the user's active tab is left where it was.
  const inGrid = reviveEditorTrayWindow({
    target,
    windows: [other, target],
    screen: 'workspace',
    viewMode: 'grid',
    activeTabId: 'tab-1',
  });
  assert.equal(inGrid.activeTabId, 'tab-1');
  assert.equal(
    inGrid.windows.find(w => w.filePath === target.filePath)?.minimized,
    false,
  );
});

test('FR-MDE-008 revival returns from the settings screen to the workspace screen', () => {
  const target = windowOf({ minimized: true });

  const revival = reviveEditorTrayWindow({
    target,
    windows: [target],
    screen: 'settings',
    viewMode: 'tab',
    activeTabId: 'tab-1',
  });

  // Clearing `minimized` alone leaves the window behind the settings screen and
  // nothing changes on screen, which reads as a dead menu item.
  assert.equal(revival.screen, 'workspace');
  assert.equal(revival.windows[0]?.minimized, false);
});

test('FR-MDE-008 revival is not exclusive and leaves other windows visible', () => {
  const visibleA = windowOf({ filePath: 'C:\\Work\\proj\\CLAUDE.md', tabId: 'tab-1' });
  const visibleB = windowOf({ filePath: 'C:\\Work\\proj\\AGENTS.md', tabId: 'tab-1' });
  const target = windowOf({
    filePath: 'C:\\Work\\proj\\CLAUDE.local.md',
    tabId: 'tab-1',
    minimized: true,
  });

  const revival = reviveEditorTrayWindow({
    target,
    windows: [visibleA, visibleB, target],
    screen: 'workspace',
    viewMode: 'tab',
    activeTabId: 'tab-1',
  });

  // "선택하여 이것만 출력 가능합니다" is read as reviving the chosen one, not as
  // hiding the rest -- the next sentence of the requirement says several editor
  // windows may be up at once.
  assert.deepEqual(revival.windows, [visibleA, visibleB, { ...target, minimized: false }]);
  assert.equal(revival.windows.filter(w => w.minimized).length, 0);
});

const HEADER_SOURCE = readFileSync(
  new URL('../../src/components/Header/Header.tsx', import.meta.url),
  'utf8',
);

test('FR-MDE-008 the icon carries its own condition rather than the header callback condition', () => {
  // The DOM sibling position is AC-3's and belongs to Playwright. What is read
  // here is the trap that would make that assertion moot: Header.tsx's outer
  // condition is "at least one callback exists", and App.tsx passes those
  // callbacks unconditionally, so it is always true. An icon gated on it is
  // permanently visible, including above an empty list.
  const trayAnchor = HEADER_SOURCE.indexOf('header-editor-tray-button');
  assert.notEqual(trayAnchor, -1, 'the tray icon is rendered');

  const toggleAnchor = HEADER_SOURCE.indexOf('onToggleViewMode && !isMobile');
  assert.notEqual(toggleAnchor, -1, 'the view mode toggle is still the anchor');
  assert.ok(trayAnchor < toggleAnchor, 'the tray icon precedes the view mode toggle');

  // Its own boolean prop decides it. The gate is looked for between the start of
  // header-right and the icon, so a mention of the prop somewhere else in the file
  // -- the props interface, say -- does not stand in for the gate.
  const headerRight = HEADER_SOURCE.indexOf('className="header-right"');
  assert.notEqual(headerRight, -1);

  const gate = HEADER_SOURCE.lastIndexOf('{hasEditorWindows && (', trayAnchor);
  assert.ok(gate > headerRight, 'the icon is gated on the workspace-scoped condition');
});

const APP_SOURCE = readFileSync(new URL('../../src/App.tsx', import.meta.url), 'utf8');

test('FR-MDE-008 App.tsx supplies the three props the tray icon is drawn from', () => {
  // All three are optional on Header, so dropping any of them compiles and every
  // test in this repository still passes -- the icon simply never appears again,
  // or appears with no badge on it. The component cannot see which of its call
  // sites forgot, which is the same trap the MetadataRow guard in
  // editorFileMenu.test.ts exists for.
  const mountStart = APP_SOURCE.indexOf('<Header');
  assert.notEqual(mountStart, -1, 'App.tsx still renders Header');

  const mountEnd = APP_SOURCE.indexOf('/>', mountStart);
  assert.notEqual(mountEnd, -1, "App.tsx's Header element is self-closing");

  const mount = APP_SOURCE.slice(mountStart, mountEnd);
  assert.ok(mount.includes('hasEditorWindows='), 'App.tsx passes hasEditorWindows');
  assert.ok(mount.includes('editorTrayItems='), 'App.tsx passes editorTrayItems');
  // The badge count defaults to 0 on Header, so a forgotten prop is a tray icon
  // that permanently claims nothing is minimized rather than a compile error.
  assert.ok(
    mount.includes('editorTrayMinimizedCount='),
    'App.tsx passes editorTrayMinimizedCount',
  );
});
