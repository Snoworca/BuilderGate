import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  createEditorWindowPlacementState,
  enterFloating,
  toggleMaximize,
  type EditorWindowPlacementState,
} from '../../src/components/editor/editorWindowPlacement.ts';
import {
  hasUsableTerminalArea,
  isEditorWindowVisible,
  minimizeEditorWindow,
  restoreEditorWindow,
  type EditorWindowHidingState,
  type EditorWindowTerminalHost,
  type EditorWindowVisibilityInput,
} from '../../src/components/editor/editorWindowVisibility.ts';

// FR-MDE-002 — the five-term visibility conjunction and the hiding axis, as pure
// functions. AC-3 (placement survives minimize and restore), AC-4 (each of the five
// terms alone hides the window) and AC-5 (term 5 is scoped to `docked`) are decided
// here; AC-1, AC-2, AC-6 and AC-7 all require a mounted editor and belong to the
// Playwright suite, because this suite has no DOM to mount one into.

// What a visible docked terminal slot registers. Coordinates are stage-relative,
// so a slot inside the stage reports positive offsets.
const VISIBLE_HOST: EditorWindowTerminalHost = {
  isVisible: true,
  rect: { left: 220, top: 96, width: 980, height: 620 },
};

// What a slot registers once its tab stops being the active one. This is the shape
// the runtime actually produces, not an invented one: `measure` in TerminalHostSlot
// registers `hostRect.left - rootRect.left`, so a hidden slot -- whose own
// getBoundingClientRect collapses to the viewport origin -- reports offsets that are
// negative by the stage's own origin, and only width and height fall to zero. An
// all-zero rect is therefore a state production never reaches, and a term 5 written
// against it would be vacuous exactly where it is supposed to hold.
const HIDDEN_HOST: EditorWindowTerminalHost = {
  isVisible: false,
  rect: { left: -220, top: -96, width: 0, height: 0 },
};

// The second way term 5 goes false: removeHost deletes the whole entry when a slot
// unmounts, so the lookup answers with nothing at all and there is no rect left to
// inspect.
const NO_HOST: EditorWindowTerminalHost | undefined = undefined;

// Every term holds here. Each case below falsifies exactly one field of this base,
// which is what lets a failure name the term it came from.
function visibleInput(
  overrides: Partial<EditorWindowVisibilityInput> = {},
): EditorWindowVisibilityInput {
  return {
    minimized: false,
    screen: 'workspace',
    activeWorkspaceId: 'ws-active',
    windowWorkspaceId: 'ws-active',
    viewMode: 'tab',
    activeTabId: 'tab-bound',
    windowTabId: 'tab-bound',
    placement: 'docked',
    host: VISIBLE_HOST,
    tabClosed: false,
    ...overrides,
  };
}

function hidingState(placement: EditorWindowPlacementState): EditorWindowHidingState {
  return { ...placement, minimized: false };
}

test('FR-MDE-002 the visibility predicate runs with no DOM in scope', () => {
  assert.equal(typeof (globalThis as { document?: unknown }).document, 'undefined');
  assert.equal(typeof (globalThis as { window?: unknown }).window, 'undefined');

  // Every export is exercised here, so the claim covers the module rather than
  // whichever functions the cases below happen to reach.
  isEditorWindowVisible(visibleInput());
  hasUsableTerminalArea(VISIBLE_HOST);
  restoreEditorWindow(minimizeEditorWindow(hidingState(createEditorWindowPlacementState())));
});

test('FR-MDE-002 each of the five visibility terms alone hides the window', () => {
  assert.equal(isEditorWindowVisible(visibleInput()), true);

  // Term 1 -- the only term a window button controls.
  assert.equal(isEditorWindowVisible(visibleInput({ minimized: true })), false);

  // Term 2 -- the workspace screen is not on screen.
  assert.equal(isEditorWindowVisible(visibleInput({ screen: 'settings' })), false);

  // Term 3 -- the window belongs to a workspace that is not the current one. This is
  // the workspace half of the judgement AppContent already makes for a tab wrapper.
  assert.equal(isEditorWindowVisible(visibleInput({ windowWorkspaceId: 'ws-other' })), false);
  assert.equal(isEditorWindowVisible(visibleInput({ activeWorkspaceId: null })), false);

  // Term 4 -- the tab half of that same judgement, widened by the grid-mode escape.
  // In tab mode a window bound to an inactive tab is hidden; in grid mode every tab
  // is on screen at once, so the same window stays visible.
  assert.equal(isEditorWindowVisible(visibleInput({ activeTabId: 'tab-other' })), false);
  assert.equal(isEditorWindowVisible(visibleInput({ activeTabId: null })), false);
  assert.equal(
    isEditorWindowVisible(visibleInput({ activeTabId: 'tab-other', viewMode: 'grid' })),
    true,
  );

  // Term 5 -- a docked window has no usable terminal area to cover. Both runtime
  // shapes count: the hidden entry the registry keeps, and the absent entry it is
  // left with after the slot unmounts.
  assert.equal(isEditorWindowVisible(visibleInput({ host: HIDDEN_HOST })), false);
  assert.equal(isEditorWindowVisible(visibleInput({ host: NO_HOST })), false);

  // The other half of AC-4 -- that a hidden window is still mounted -- needs a
  // mounted editor to observe and is judged by the Playwright suite. Nothing here
  // stands in for it: a boolean return value cannot distinguish hiding from
  // unmounting, so an assertion written against it would report coverage it does
  // not have.
});

test('FR-MDE-002 term 5 reads the registered isVisible field and both size checks', () => {
  assert.equal(hasUsableTerminalArea(VISIBLE_HOST), true);
  assert.equal(hasUsableTerminalArea(HIDDEN_HOST), false);
  assert.equal(hasUsableTerminalArea(NO_HOST), false);

  // isVisible is registered by upsertHost as its own argument, separate from the
  // rect. An entry that is fully sized but marked invisible must still fail, which is
  // what stops the judgement from being rebuilt out of coordinates.
  assert.equal(
    hasUsableTerminalArea({ isVisible: false, rect: { ...VISIBLE_HOST.rect } }),
    false,
  );

  // Only the two sizes are read. A slot flush against the stage origin registers an
  // offset of exactly zero -- the mobile layout has no sidebar, so a full-width slot
  // subtracts the stage's own left from an identical left -- and that slot is as
  // usable as any other. Without this case a coordinate added to the conjunction
  // would survive, and it would hide every docked window on mobile.
  assert.equal(
    hasUsableTerminalArea({ isVisible: true, rect: { left: 0, top: 0, width: 980, height: 620 } }),
    true,
  );

  // And each size check carries its own weight: either dimension alone at zero is
  // enough, because a window placed on a zero-sized area would itself be zero-sized.
  assert.equal(
    hasUsableTerminalArea({ isVisible: true, rect: { left: 220, top: 96, width: 0, height: 620 } }),
    false,
  );
  assert.equal(
    hasUsableTerminalArea({ isVisible: true, rect: { left: 220, top: 96, width: 980, height: 0 } }),
    false,
  );
});

test('FR-MDE-002 term 5 applies to docked only', () => {
  // A stage or floating window is placed against the stage, never against the
  // terminal rect, so the state of its tab's slot decides nothing for it. Both
  // runtime shapes of a hidden tab are checked, since either one reaching the
  // predicate would hide a window that has no business being hidden.
  (['stage', 'floating'] as const).forEach((placement) => {
    assert.equal(isEditorWindowVisible(visibleInput({ placement, host: HIDDEN_HOST })), true);
    assert.equal(isEditorWindowVisible(visibleInput({ placement, host: NO_HOST })), true);
  });

  // The same two shapes under `docked`, where term 5 does apply. Without this half
  // the case above would pass against a predicate that dropped term 5 altogether.
  assert.equal(
    isEditorWindowVisible(visibleInput({ placement: 'docked', host: HIDDEN_HOST })),
    false,
  );
  assert.equal(isEditorWindowVisible(visibleInput({ placement: 'docked', host: NO_HOST })), false);

  // Term 5 is the only term placement touches: a stage window is still hidden by any
  // of the other four.
  assert.equal(
    isEditorWindowVisible(visibleInput({ placement: 'stage', host: NO_HOST, minimized: true })),
    false,
  );
});

test('FR-MDE-002 minimize and restore leave the placement state untouched', () => {
  const docked = createEditorWindowPlacementState();
  const stage = toggleMaximize(docked);
  const floating = enterFloating(docked, { x: 320, y: 152, width: 640, height: 452 });

  [docked, stage, floating].forEach((placement) => {
    const before = hidingState(placement);
    const minimized = minimizeEditorWindow(before);
    const restored = restoreEditorWindow(minimized);

    assert.equal(minimized.minimized, true);
    assert.equal(restored.minimized, false);

    // The placement axis is compared as a whole rather than field by field, so a
    // field added to the placement state later is covered without editing this.
    const placementOf = (state: EditorWindowHidingState): EditorWindowPlacementState => ({
      placement: state.placement,
      placementBeforeStage: state.placementBeforeStage,
      floatingRect: state.floatingRect,
    });
    assert.deepEqual(placementOf(minimized), placement);
    assert.deepEqual(placementOf(restored), placement);

    // Neither transition writes through to its input, so a window minimized while a
    // placement transition is in flight cannot lose the placement it came from.
    assert.equal(before.minimized, false);
  });
});

test('FR-MDE-002 clearing minimized alone does not make the window visible', () => {
  // Only term 1 is under the user's control. Restoring a window whose workspace is
  // not the current one leaves it hidden, and the button that calls restore must not
  // be written as though it decided visibility.
  const restored = restoreEditorWindow(
    minimizeEditorWindow(hidingState(createEditorWindowPlacementState())),
  );

  assert.equal(restored.minimized, false);
  assert.equal(
    isEditorWindowVisible(
      visibleInput({ minimized: restored.minimized, windowWorkspaceId: 'ws-other' }),
    ),
    false,
  );

  // The same window becomes visible once the term it was actually failing turns
  // true, which is what makes the case above a statement about term 3 rather than a
  // predicate that is false for everything.
  assert.equal(isEditorWindowVisible(visibleInput({ minimized: restored.minimized })), true);
});

test('CON-MDE-002 a window whose tab has closed is not hidden by the tab term', () => {
  // Term 4 scopes a window to its tab. Closing a tab moves the active tab to a
  // sibling, so a window bound to the closed one fails that term -- and the
  // body it is holding has nowhere to be saved, which is exactly why it must
  // stay on screen. The escape is asked for explicitly, so a caller that does
  // not know about orphaned windows keeps the behaviour it had.
  const orphaned = { windowTabId: 'tab-gone', activeTabId: 'tab-sibling' };

  assert.equal(isEditorWindowVisible(visibleInput({
    ...orphaned, placement: 'floating', host: NO_HOST,
  })), false);
  assert.equal(isEditorWindowVisible(visibleInput({
    ...orphaned, placement: 'floating', host: NO_HOST, tabClosed: true,
  })), true);

  // The escape is term 4's alone. Every other term still decides.
  assert.equal(isEditorWindowVisible(visibleInput({
    ...orphaned, placement: 'floating', host: NO_HOST, tabClosed: true, minimized: true,
  })), false);
  assert.equal(isEditorWindowVisible(visibleInput({
    ...orphaned, placement: 'floating', host: NO_HOST, tabClosed: true, screen: 'settings',
  })), false);
  assert.equal(isEditorWindowVisible(visibleInput({
    ...orphaned, placement: 'floating', host: NO_HOST, tabClosed: true,
    windowWorkspaceId: 'ws-other',
  })), false);

  // Term 5 in particular: a window still recorded as docked has no registry
  // entry once its tab is gone, and stays hidden until the placement moves.
  assert.equal(isEditorWindowVisible(visibleInput({
    ...orphaned, placement: 'docked', host: NO_HOST, tabClosed: true,
  })), false);
});

// The window layer itself cannot be exercised here -- it is a React component and
// this suite has no DOM. What is checkable without one is where it is mounted and
// what it does with the predicate's answer, both of which are source-text facts.
// That a hidden window keeps its editor instance is a runtime observation and is
// judged by the Playwright suite; nothing below stands in for it.
const APP_SOURCE = readFileSync(new URL('../../src/App.tsx', import.meta.url), 'utf8');
const LAYER_SOURCE = readFileSync(
  new URL('../../src/components/editor/EditorWindowLayer.tsx', import.meta.url),
  'utf8',
);

test('FR-MDE-002 the window layer is mounted inside the provider and outside the stage', () => {
  // The opening tag is matched without its closing bracket, so adding a prop to the
  // provider does not read as the provider having moved.
  const providerOpen = APP_SOURCE.indexOf('<TerminalRuntimeProvider');
  const stageClose = APP_SOURCE.indexOf('</TerminalWorkspaceStage>');
  const layerMount = APP_SOURCE.indexOf('<EditorWindowLayer');
  const providerClose = APP_SOURCE.indexOf('</TerminalRuntimeProvider>');

  // Each anchor is checked for existence before the ordering is compared. Without
  // this, a renamed provider or a deleted layer would make every index -1 and the
  // ordering below would hold on absent things.
  [providerOpen, stageClose, layerMount, providerClose].forEach((index) => {
    assert.notEqual(index, -1);
  });

  assert.ok(providerOpen < layerMount, 'the layer is mounted after the provider opens');
  assert.ok(layerMount < providerClose, 'the layer is mounted before the provider closes');

  // And after the stage closes rather than inside its children callback. That callback
  // is swapped for the empty state when a workspace has no tabs, which would destroy
  // every window and its unsaved body on the way.
  assert.ok(stageClose < layerMount, 'the layer is not inside the stage children');

  // The mount is unconditional. A guard in front of it would be an unmount path that
  // the ordering above cannot see.
  const beforeMount = APP_SOURCE.slice(0, layerMount).trimEnd();
  assert.doesNotMatch(beforeMount, /(&&|\?|:)$/);

  // The registry the layer reads is that provider's context value, so a layer outside
  // it would throw rather than answer term 5 wrongly.
  assert.match(LAYER_SOURCE, /useTerminalRuntimeContext\(\)/);
});

test('FR-MDE-002 the layer is fed the real window list and a renderer that draws one', () => {
  // Where the mount is, the previous test pins. What it is fed, nothing did:
  // `windows` back to an empty literal, or `renderWindow` back to a function
  // answering null, leaves the whole suite green and no window ever reaches the
  // screen. Both are the single path by which a window becomes visible.
  const mountStart = APP_SOURCE.indexOf('<EditorWindowLayer');
  assert.notEqual(mountStart, -1, 'App.tsx still renders the layer');

  const mountEnd = APP_SOURCE.indexOf('/>', mountStart);
  assert.notEqual(mountEnd, -1, "App.tsx's layer element is self-closing");

  const mount = APP_SOURCE.slice(mountStart, mountEnd);

  // The list comes from the hook that holds it, not from a literal.
  assert.match(mount, /windows=\{[A-Za-z_$][\w$]*\.windows\}/);
  assert.doesNotMatch(mount, /windows=\{\s*\[\s*\]\s*\}/);

  // And the renderer builds a window rather than answering with nothing.
  const rendererStart = mount.indexOf('renderWindow=');
  assert.notEqual(rendererStart, -1, 'the layer is given a renderer');
  const renderer = mount.slice(rendererStart);
  assert.ok(renderer.includes('<EditorWindow'), 'the renderer mounts an editor window');
  assert.doesNotMatch(renderer, /renderWindow=\{\s*\(\s*\)\s*=>\s*null\s*\}/);
});

test('FR-MDE-002 the layer hands hiding to the window instead of dropping it', () => {
  // The predicate's answer reaches the surface as a value. It cannot be applied around
  // the surface: WindowDialog portals into document.body, so a style set by an
  // ancestor in the React tree lands on no DOM ancestor of the window.
  assert.match(LAYER_SOURCE, /hidden:\s*!\w+/);

  // renderWindow is called on every window in the list. Rather than enumerating the
  // shapes a guard could take, this reads the element the layer returns per window:
  // its only child is the call itself, so there is nowhere for a guard to sit. Every
  // conditional form -- `visible &&`, a ternary, an early return -- moves the call out
  // of that position.
  const fragmentOpen = LAYER_SOURCE.indexOf('<Fragment');
  const fragmentClose = LAYER_SOURCE.indexOf('</Fragment>');
  assert.notEqual(fragmentOpen, -1);
  assert.notEqual(fragmentClose, -1);

  const onlyChild = LAYER_SOURCE
    .slice(LAYER_SOURCE.indexOf('>', fragmentOpen) + 1, fragmentClose)
    .trim();
  assert.ok(onlyChild.startsWith('{renderWindow('), `unguarded call expected, got ${onlyChild}`);
  assert.ok(onlyChild.endsWith(')}'), `unguarded call expected, got ${onlyChild}`);

  // Windows are keyed by the file they hold, not by the tab they are bound to -- one
  // tab legitimately has several windows open over it.
  assert.match(LAYER_SOURCE, /key=\{\w+\.filePath\}/);
});
