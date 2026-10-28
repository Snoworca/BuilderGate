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
// REL-BGSTAB-058 supersedes REL-BGSTAB-050 (2026-10-28, #191): nudging on every tab
// switch made the program redraw twice and the screen jump, so a terminal coming
// back from behind another tab is nudged only after a resize elsewhere.
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

test('REL-BGSTAB-058 AC-5: the terminal menu offers a screen redraw that runs the manual repair', () => {
  let redraws = 0;
  const items = buildTerminalContextMenuItems(base({ onRedrawScreen: () => { redraws += 1; } }));
  const item = items.find(entry => !entry.separator && entry.label === REDRAW_SCREEN);
  assert.ok(item && !item.separator, `menu has "${REDRAW_SCREEN}": ${labelsOf(items).join(', ')}`);
  assert.equal(item.disabled ?? false, false);
  item.onClick?.();
  assert.equal(redraws, 1);
});

test('REL-BGSTAB-058 AC-5: a caller that does not pass the option gets the menu it got before', () => {
  assert.ok(!labelsOf(buildTerminalContextMenuItems(base())).includes(REDRAW_SCREEN));
});

test('REL-BGSTAB-058 AC-5: both terminal menus wire the redraw to the manual repair', () => {
  const app = readFileSync(new URL('../../src/App.tsx', import.meta.url), 'utf8');
  const mosaic = readFileSync(new URL('../../src/components/Grid/MosaicContainer.tsx', import.meta.url), 'utf8');
  const redraw = bodyOf(app, 'const redrawTerminal = useCallback(');
  // REL-BGSTAB-053: the repair runs through a scheduler (every grid pane, one after another).
  assert.ok(app.includes("run: (tabId, nudge) => terminalRefsMap.current.get(tabId)?.current?.requestGridRepair?.('manual', nudge)"), 'the redraw runs the manual repair');
  assert.ok(redraw.includes('redrawSchedulerRef.current?.redraw('), 'redrawTerminal goes through the scheduler');
  assert.match(app, /onRedrawScreen: \(\) => redrawTerminal\(targetTab\.id\)/u, 'the tab-view menu offers it');
  assert.match(app, /onRedrawTerminal=\{redrawTerminal\}/u, 'the grid receives it');
  assert.match(mosaic, /onRedrawScreen: onRedrawTerminal \? \(\) => onRedrawTerminal\(tabId\) : undefined/u, 'the grid menu offers it');
});

test('REL-BGSTAB-058 AC-1: the layout repair runs on a visible tab-view terminal, not only on grid panes', () => {
  const body = bodyOf(containerSource, 'const runGridLayoutRepair = useCallback(');
  assert.ok(body.includes('isVisibleRef.current'), 'still skips hidden terminals');
  assert.ok(!body.includes('isGridSurfaceRef.current'), 'no grid-only early return');
});

test('REL-BGSTAB-058 AC-1, AC-4: becoming visible asks shouldRepairOnSurfaceChange before scheduling the repair', () => {
  // A visible tab-view terminal has a surface of its own, so its first showing
  // triggers; tab view <-> grid stays a trigger for REL-BGSTAB-047. Coming back
  // from behind another tab does not (REL-BGSTAB-058 AC-4) -- the decision
  // itself is tested in terminalRedrawNudge.test.ts.
  assert.match(containerSource, /const nextSurface = isVisible \? \(isGridSurface \? 'grid' : 'tab'\) : null;/u);
  const effect = containerSource.slice(containerSource.indexOf('const nextSurface ='));
  const body = effect.slice(0, effect.indexOf('}, ['));
  const decided = body.indexOf('shouldRepairOnSurfaceChange(nextSurface, wasSurface, shownInTabBefore, resizedElsewhereRef.current)');
  const scheduled = body.indexOf("runGridLayoutRepair('workspace')");
  assert.ok(decided > 0 && scheduled > decided, 'the decision gates the scheduled repair');
  const remembered = body.indexOf('shownInTabRef.current = true');
  const read = body.indexOf('const shownInTabBefore = shownInTabRef.current');
  assert.ok(read >= 0 && remembered > read, 'the first tab-view showing is read before it is remembered');
});

test('REL-BGSTAB-058 AC-7: middle-click repair stays a grid-pane gesture', () => {
  assert.ok(bodyOf(containerSource, 'const handleMouseDownCapture = useCallback(').includes('!isGridSurfaceRef.current'));
  assert.ok(bodyOf(containerSource, 'const handlePointerDownCapture = useCallback(').includes('!isGridSurfaceRef.current'));
  assert.match(containerSource, /onManualRepair=\{isGridSurface \? handleManualRepair : undefined\}/u);
});

test('REL-BGSTAB-058 AC-3: a resize reported from elsewhere is recorded, and a sent nudge clears it', () => {
  assert.match(containerSource, /onResized: handleResized/u, 'the container listens for session:resized');
  const handlerStart = containerSource.indexOf('const handleResized = useEffectEvent(');
  assert.ok(handlerStart >= 0, 'handleResized is in the source');
  const handler = containerSource.slice(handlerStart, containerSource.indexOf('\n    });', handlerStart));
  assert.ok(handler.includes('isResizeFromElsewhere('), 'it asks whether the size came from elsewhere');
  assert.ok(handler.includes('resizedElsewhereRef.current = true'));
  const send = bodyOf(containerSource, 'const sendResizeIfNeeded = useCallback(');
  assert.ok(send.includes('rememberSentSize('), 'its own resizes are remembered');
  const nudge = containerSource.slice(containerSource.indexOf('const sendRedrawNudge = useCallback('));
  assert.ok(nudge.slice(0, nudge.indexOf('}), [')).includes('resizedElsewhereRef.current = false'), 'a sent nudge clears the record');
});

test('REL-BGSTAB-058 AC-4, AC-5: the layout repair resizes only when the nudge policy allows it', () => {
  const body = bodyOf(containerSource, 'const runGridLayoutRepair = useCallback(');
  const decided = body.indexOf('shouldSendRedrawNudge(nudge, resizedElsewhereRef.current)');
  const nudged = body.indexOf('await sendRedrawNudge(reason)');
  assert.ok(decided > 0 && nudged > decided, 'the policy gates the nudge');
  assert.ok(containerSource.includes("requestGridRepair: (reason = 'manual', nudge = 'always') => runGridLayoutRepair(reason, nudge)"));
});

test('REL-BGSTAB-058 AC-8: going back to the window resends the size and redraws after a resize elsewhere', () => {
  const start = containerSource.indexOf('const handleWindowReturn = useEffectEvent(');
  assert.ok(start >= 0, 'handleWindowReturn is in the source');
  const handler = containerSource.slice(start, containerSource.indexOf('\n    });', start));
  const decided = handler.indexOf('shouldRepairOnWindowReturn(');
  // The record is cleared at once, so further mouse moves while the redraw runs do nothing.
  const cleared = handler.indexOf('resizedElsewhereRef.current = false');
  const resent = handler.indexOf("'window-return-resend'");
  const repaired = handler.indexOf("runGridLayoutRepair('workspace', 'always')");
  assert.ok(decided > 0 && cleared > decided && resent > cleared && repaired > resent, 'decide, clear, resend the size, then redraw');
  assert.ok(handler.includes('forgetAndResend('), 'the size is sent again even though it was sent before');
  // A phone resizing the PTY does not take focus from the desktop window: the user's
  // own mouse or key on this page is the sign of coming back (measured 2026-10-28).
  for (const [target, event] of [['window', 'focus'], ['document', 'visibilitychange'], ['document', 'pointermove'], ['document', 'pointerdown'], ['document', 'keydown']]) {
    assert.ok(containerSource.includes(`${target}.addEventListener('${event}', handleWindowReturn`), `${target} ${event} is listened to`);
    assert.ok(containerSource.includes(`${target}.removeEventListener('${event}', handleWindowReturn`), `${target} ${event} is released`);
  }
});
