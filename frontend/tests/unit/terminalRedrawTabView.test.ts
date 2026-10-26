import './i18nTestSetup.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  buildTerminalContextMenuItems,
  type BuildTerminalMenuOptions,
} from '../../src/utils/contextMenuBuilder.ts';

// REL-BGSTAB-050: REL-BGSTAB-047 only nudged grid panes, so in the tab view a
// program that drew itself for another size (measured 2026-10-21: Claude Code
// left at a phone's 43 columns on a 208-column desktop) stayed that way through
// any number of reloads. The tab view now nudges when a terminal becomes
// visible, and the terminal menu offers the manual repair on every surface --
// phones have no middle button.
//
// The option travels in a variable typed as the builder's options plus the new
// field, so this file type-checks before the field exists.
type TerminalMenuOptionsWithRedraw = BuildTerminalMenuOptions & { onRedrawScreen?: () => void };

const REDRAW_SCREEN = '화면 다시 그리기';

function base(overrides: Partial<TerminalMenuOptionsWithRedraw> = {}): TerminalMenuOptionsWithRedraw {
  return {
    tab: undefined,
    tabs: [],
    maxTabs: 8,
    onAddTab: () => undefined,
    onCloseTab: () => undefined,
    onCopy: async () => undefined,
    onPaste: async () => undefined,
    hasSelection: false,
    ...overrides,
  };
}

function labelsOf(items: ReturnType<typeof buildTerminalContextMenuItems>): string[] {
  return items.flatMap(item => (item.separator ? [] : [item.label]));
}

const containerSource = readFileSync(new URL('../../src/components/Terminal/TerminalContainer.tsx', import.meta.url), 'utf8');

function bodyOf(source: string, marker: string): string {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `${marker} is in the source`);
  return source.slice(start, source.indexOf('}, [', start));
}

test('REL-BGSTAB-050 AC-2: the terminal menu offers a screen redraw that runs the manual repair', () => {
  let redraws = 0;
  const items = buildTerminalContextMenuItems(base({ onRedrawScreen: () => { redraws += 1; } }));
  const item = items.find(entry => !entry.separator && entry.label === REDRAW_SCREEN);
  assert.ok(item && !item.separator, `menu has "${REDRAW_SCREEN}": ${labelsOf(items).join(', ')}`);
  assert.equal(item.disabled ?? false, false);
  item.onClick?.();
  assert.equal(redraws, 1);
});

test('REL-BGSTAB-050 AC-2: a caller that does not pass the option gets the menu it got before', () => {
  assert.ok(!labelsOf(buildTerminalContextMenuItems(base())).includes(REDRAW_SCREEN));
});

test('REL-BGSTAB-050 AC-2: both terminal menus wire the redraw to the manual repair', () => {
  const app = readFileSync(new URL('../../src/App.tsx', import.meta.url), 'utf8');
  const mosaic = readFileSync(new URL('../../src/components/Grid/MosaicContainer.tsx', import.meta.url), 'utf8');
  const redraw = bodyOf(app, 'const redrawTerminal = useCallback(');
  // REL-BGSTAB-053: the repair runs through a scheduler (every grid pane, one after another).
  assert.ok(app.includes("run: (tabId) => terminalRefsMap.current.get(tabId)?.current?.requestGridRepair?.('manual')"), 'the redraw runs the manual repair');
  assert.ok(redraw.includes('redrawSchedulerRef.current?.redraw('), 'redrawTerminal goes through the scheduler');
  assert.match(app, /onRedrawScreen: \(\) => redrawTerminal\(targetTab\.id\)/u, 'the tab-view menu offers it');
  assert.match(app, /onRedrawTerminal=\{redrawTerminal\}/u, 'the grid receives it');
  assert.match(mosaic, /onRedrawScreen: onRedrawTerminal \? \(\) => onRedrawTerminal\(tabId\) : undefined/u, 'the grid menu offers it');
});

test('REL-BGSTAB-050 AC-1: the layout repair runs on a visible tab-view terminal, not only on grid panes', () => {
  const body = bodyOf(containerSource, 'const runGridLayoutRepair = useCallback(');
  assert.ok(body.includes('isVisibleRef.current'), 'still skips hidden terminals');
  assert.ok(!body.includes('isGridSurfaceRef.current'), 'no grid-only early return');
});

test('REL-BGSTAB-050 AC-1: becoming visible schedules the repair in the tab view too', () => {
  // A visible tab-view terminal has a surface of its own, so hidden -> tab
  // view triggers; tab view <-> grid stays a trigger for REL-BGSTAB-047.
  assert.match(containerSource, /const nextSurface = isVisible \? \(isGridSurface \? 'grid' : 'tab'\) : null;/u);
  assert.match(containerSource, /if \(!nextSurface \|\| nextSurface === wasSurface\) \{\s*return;/u);
  const effect = containerSource.slice(containerSource.indexOf('const nextSurface ='));
  assert.ok(effect.slice(0, effect.indexOf('}, [')).includes("runGridLayoutRepair('workspace')"));
});

test('REL-BGSTAB-050 AC-4: middle-click repair stays a grid-pane gesture', () => {
  assert.ok(bodyOf(containerSource, 'const handleMouseDownCapture = useCallback(').includes('!isGridSurfaceRef.current'));
  assert.ok(bodyOf(containerSource, 'const handlePointerDownCapture = useCallback(').includes('!isGridSurfaceRef.current'));
  assert.match(containerSource, /onManualRepair=\{isGridSurface \? handleManualRepair : undefined\}/u);
});
