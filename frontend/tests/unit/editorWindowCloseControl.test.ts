import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as closeControl from '../../src/components/editor/editorWindowCloseControl.ts';

const { planEditorWindowCloseControl } = closeControl;

// FR-MDE-011 — the title bar close control closes one document per press.
//
// The behaviour this replaces discarded every document of the workspace in a
// single call whenever nothing was dirty, so a window carrying many tabs was
// emptied by one press and there was no prompt, because there was nothing
// dirty to prompt about. The loss was silent and total.
//
// The plan is a pure function because this repository's unit suite has no DOM
// harness: the decision has to live outside the component to be judged at all.
// What the component then does with the plan is held by the source guards at
// the bottom, which are the control for the cases above — "one press closes
// one document" proves nothing while a second, bulk path still exists beside
// it.

const TABS = [
  { filePath: '/repo/a.md' },
  { filePath: '/repo/b.md' },
  { filePath: '/repo/c.md' },
];

test('FR-MDE-011 AC-1 the press resolves to the active document, not the first one', () => {
  const plan = planEditorWindowCloseControl({ tabs: TABS, activeFilePath: '/repo/b.md' });

  assert.deepEqual(plan, { kind: 'close-tab', filePath: '/repo/b.md' });
});

test('FR-MDE-011 AC-1 the plan names exactly one document', () => {
  // The shape is what forbids the regression: a plan that could carry several
  // paths could be filled with all of them again.
  const plan = planEditorWindowCloseControl({ tabs: TABS, activeFilePath: '/repo/b.md' });

  assert.equal(Object.values(plan).filter(value => typeof value === 'string' && value.startsWith('/')).length, 1);
});

test('FR-MDE-011 AC-2 a window holding one document closes it, and the window goes with it', () => {
  const plan = planEditorWindowCloseControl({
    tabs: [{ filePath: '/repo/only.md' }],
    activeFilePath: '/repo/only.md',
  });

  assert.deepEqual(plan, { kind: 'close-tab', filePath: '/repo/only.md' });
});

test('FR-MDE-011 AC-6 an active path naming no open document still closes one', () => {
  // A control that silently does nothing is indistinguishable from a broken
  // one, so the press falls back to the first tab rather than to no-op.
  const plan = planEditorWindowCloseControl({ tabs: TABS, activeFilePath: '/repo/gone.md' });

  assert.deepEqual(plan, { kind: 'close-tab', filePath: '/repo/a.md' });
});

test('FR-MDE-011 AC-6 a null active path still closes one', () => {
  const plan = planEditorWindowCloseControl({ tabs: TABS, activeFilePath: null });

  assert.deepEqual(plan, { kind: 'close-tab', filePath: '/repo/a.md' });
});

test('FR-MDE-011 an empty tab set has nothing to close', () => {
  const plan = planEditorWindowCloseControl({ tabs: [], activeFilePath: null });

  assert.deepEqual(plan, { kind: 'nothing' });
});

// --- Source guards -------------------------------------------------------
//
// These read source text, so they strip comments first. A guard that matches
// inside a comment reports a contract violation that does not exist, and the
// next person goes and edits code to satisfy a sentence.

function code(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(line => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');
}

test('FR-MDE-011 AC-5 no function closes every document of a workspace at once', () => {
  const hook = code('../../src/hooks/useEditorWindows.ts');

  assert.ok(
    !/document\.workspaceId\s*!==\s*workspaceId/.test(hook),
    'a filter that keeps only other workspaces\' documents is the bulk wipe this requirement removes',
  );
  assert.ok(
    !/\bcloseWindow\b/.test(hook),
    'the bulk close must be gone, not merely uncalled: the next person wiring a close control finds it and it does what its name says',
  );
});

test('FR-MDE-011 AC-5 the editor window has no prop through which a bulk close could be reached', () => {
  const window = code('../../src/components/editor/EditorWindow.tsx');
  const layer = code('../../src/components/editor/EditorWindowLayer.tsx');
  const app = code('../../src/App.tsx');

  for (const [name, source] of [['EditorWindow', window], ['EditorWindowLayer', layer], ['App', app]] as const) {
    assert.ok(!/\bonCloseWindow\b/.test(source), `${name} still carries the bulk close prop`);
    assert.ok(!/\bcloseWindow\b/.test(source), `${name} still reaches a bulk close`);
  }
});

test('FR-MDE-011 AC-3/AC-4 the title bar press runs the active panel\'s own close branch', () => {
  // AC-4 is that a document has one way of closing. The tab row's `x` goes
  // through the panel handle so the dirty branches of FR-MDE-006 run; the
  // title bar control must reach the same handle rather than closing the tab
  // behind the panel's back, which would discard an unsaved body with no
  // prompt.
  const window = code('../../src/components/editor/EditorWindow.tsx');

  assert.match(window, /planEditorWindowCloseControl\(/, 'the press must resolve through the plan');
  // The press hands the planned document to requestCloseTab, the one path both
  // close controls share, which looks the panel handle up.
  assert.match(
    window,
    /requestCloseTab\(plan\.filePath\)/,
    'the press must reach the panel that owns the document',
  );
  assert.match(window, /handlesRef\.current\.get\(filePath\)/, 'the shared path looks up the panel handle');
  assert.match(window, /\.requestClose\(\)/, 'the panel decides whether to prompt, not the window');
});

// Regression found by the E2E run of T-PH008-01 (code-editor-text.spec.ts): the
// tab row's `x` was wired straight to the hook's close, so an unsaved document
// closed with no prompt -- the comment above and FR-MDE-011 AC-4 said it went
// through the panel handle, and it did not.

test('FR-MDE-011 AC-4 a tab x press on a background tab brings it forward before its panel asks', () => {
  // A panel behind another tab cancels any prompt it raises (it is hidden), so
  // asking without selecting first would drop the question and keep the tab.
  const plan = closeControl.planEditorTabClose({ activeFilePath: '/repo/a.md', filePath: '/repo/b.md' });
  assert.deepEqual(plan, { select: true });
  assert.deepEqual(
    closeControl.planEditorTabClose({ activeFilePath: '/repo/b.md', filePath: '/repo/b.md' }),
    { select: false },
    'the active tab is already on screen',
  );
});

test('FR-MDE-011 AC-4 the tab row x reaches the panel handle, not the hook close directly', () => {
  const window = code('../../src/components/editor/EditorWindow.tsx');
  const tabBar = window.match(/<EditorTabBar[\s\S]*?\/>/)?.[0] ?? '';
  assert.ok(tabBar.length > 0, 'precondition: the tab bar is rendered');
  assert.doesNotMatch(tabBar, /onClose=\{onCloseTab\}/, 'the x must not close the tab behind the panel\'s back');
  assert.match(tabBar, /onClose=\{requestCloseTab\}/, 'the x goes through requestCloseTab');
  assert.match(window, /handlesRef\.current\.get\(filePath\)/, 'requestCloseTab looks up the panel handle');
  assert.match(window, /planEditorTabClose\(/, 'requestCloseTab decides selection through the plan');
});
