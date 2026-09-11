import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  countEditorTrayWindows,
  hasEditorTrayWindows,
  listEditorTrayEntries,
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
    tabName: 'Terminal-1',
    workspaceId: ACTIVE,
    workspaceName: 'Workspace-1',
    dirty: false,
    ...overrides,
  };
}

test('FR-MDE-008 the tray icon renders while any workspace holds a document', () => {
  assert.equal(hasEditorTrayWindows([]), false);
  assert.equal(hasEditorTrayWindows([windowOf()]), true);

  // A document in another workspace counts. The list spans every workspace now,
  // so an icon scoped to the active one would sometimes stand above a list it
  // claimed was empty -- or hide a list that was not.
  assert.equal(hasEditorTrayWindows([windowOf({ workspaceId: OTHER })]), true);
});

test('FR-MDE-008 the badge counts every open document', () => {
  assert.equal(countEditorTrayWindows([]), 0);
  assert.equal(countEditorTrayWindows([windowOf()]), 1);

  // Across workspaces, which is what makes the count answer "how many are open"
  // rather than "how many are open here".
  assert.equal(countEditorTrayWindows([
    windowOf({ filePath: 'C:\\a\\CLAUDE.md' }),
    windowOf({ filePath: 'C:\\b\\CLAUDE.md', workspaceId: OTHER }),
  ]), 2);

  // The icon's condition and the count agree about emptiness, so a badge can
  // never stand on an icon that is not there.
  assert.equal(hasEditorTrayWindows([]), countEditorTrayWindows([]) > 0);
});

test('FR-MDE-008 the list spans workspaces and marks dirty documents', () => {
  const w1 = windowOf({
    filePath: 'C:\\Work\\proj\\CLAUDE.md',
    tabId: 'tab-1',
    tabName: 'Terminal-1',
    workspaceName: 'Workspace-1',
    dirty: true,
  });
  const w2 = windowOf({
    filePath: 'C:\\Work\\proj\\AGENTS.md',
    tabId: 'tab-2',
    tabName: 'Terminal-2',
    workspaceName: 'Workspace-1',
    dirty: false,
  });
  const w3 = windowOf({
    filePath: 'D:\\other\\CLAUDE.md',
    tabId: 'tab-9',
    tabName: 'Terminal-1',
    workspaceId: OTHER,
    workspaceName: 'Workspace-2',
  });

  assert.deepEqual(listEditorTrayEntries([w1, w2, w3]), [
    {
      filePath: w1.filePath,
      tabId: 'tab-1',
      workspaceId: ACTIVE,
      label: 'Workspace-1 / Terminal-1 | C:\\Work\\proj\\CLAUDE.md*',
    },
    {
      filePath: w2.filePath,
      tabId: 'tab-2',
      workspaceId: ACTIVE,
      label: 'Workspace-1 / Terminal-2 | C:\\Work\\proj\\AGENTS.md',
    },
    {
      filePath: w3.filePath,
      tabId: 'tab-9',
      workspaceId: OTHER,
      label: 'Workspace-2 / Terminal-1 | D:\\other\\CLAUDE.md',
    },
  ]);
});

// The three revival cases that stood here are gone with `reviveEditorTrayWindow`.
// Choosing a tray entry no longer rewrites a window list: there is one window
// per workspace, and the choice selects a tab inside it. The terminal tab is
// deliberately not switched any more either -- a window holds documents opened
// from several terminals, so there is no one terminal the choice implies.
//
// What replaces them is an end-to-end case: the tray entry is chosen and the
// named document becomes the tab on screen. That is a statement about wiring
// rather than about a value, so it belongs to the Playwright suite.

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

const HOOK_SOURCE = readFileSync(
  new URL('../../src/hooks/useEditorWindows.ts', import.meta.url),
  'utf8',
);

test('FR-MDE-008 the tray rows are not rebuilt on every render', () => {
  // `tabs` and `workspaces` are rebuilt by their owner on every render, so a
  // memo depending on them is no memo at all: every commit makes a new
  // `trayItems`, that is a new prop for the header, and a header re-rendering on
  // every commit keeps replacing its own DOM nodes. Anything measuring that DOM
  // -- a focus trap walking the focusable elements, say -- then sees a list that
  // never settles. That is how this was found: two modal focus-wrap cases began
  // failing with no change to any modal.
  //
  // The names are what the rows read, and those do not change every render, so
  // the memo keys on them instead.
  const memoStart = HOOK_SOURCE.indexOf('const trayItems = useMemo');
  assert.notEqual(memoStart, -1, 'the tray rows are still memoized');

  const depsStart = HOOK_SOURCE.indexOf('[documents', memoStart);
  assert.notEqual(depsStart, -1, 'the memo still declares a dependency list');
  const depsEnd = HOOK_SOURCE.indexOf(']', depsStart);
  assert.notEqual(depsEnd, -1);

  const deps = HOOK_SOURCE.slice(depsStart, depsEnd);
  assert.ok(deps.includes('trayNameKey'), `the memo keys on the names, got ${deps}`);
  assert.equal(/\btabs\b/.test(deps), false, `the memo must not depend on tabs, got ${deps}`);
  assert.equal(
    /\bworkspaces\b/.test(deps),
    false,
    `the memo must not depend on workspaces, got ${deps}`,
  );

  // And the key is built from the names rather than from the array identities,
  // which is the part that makes it stable across renders.
  const keyStart = HOOK_SOURCE.indexOf('const trayNameKey');
  assert.notEqual(keyStart, -1, 'the name key is still built');
  const key = HOOK_SOURCE.slice(keyStart, HOOK_SOURCE.indexOf(';', keyStart));
  assert.ok(key.includes('.name'), 'the key is built from the names');
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
  // that permanently claims nothing is open rather than a compile error.
  assert.ok(
    mount.includes('editorTrayOpenCount='),
    'App.tsx passes editorTrayOpenCount',
  );
});
