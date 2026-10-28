// REL-BGSTAB-047 (#145): the server skips a resize to the size the PTY already
// has, so a TUI that drew itself wrong is never told to draw again. A grid pane
// that becomes visible, or a manual repair, shrinks the PTY by one row and puts
// it back, which is what dragging a grid border by hand did.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  planRedrawNudge,
  REDRAW_NUDGE_GAP_MS,
  isResizeFromElsewhere,
  rememberSentSize,
  SENT_SIZE_MEMORY,
  shouldRepairOnSurfaceChange,
  shouldRepairOnWindowReturn,
  shouldSendRedrawNudge,
} from '../../src/components/Terminal/terminalRedrawNudge.ts';

test('REL-BGSTAB-047 AC-1: workspace and manual repairs shrink by one row, then restore', () => {
  assert.deepEqual(planRedrawNudge('workspace', { cols: 120, rows: 40 }), [
    { cols: 120, rows: 39 },
    { cols: 120, rows: 40 },
  ]);
  assert.deepEqual(planRedrawNudge('manual', { cols: 80, rows: 24 }), [
    { cols: 80, rows: 23 },
    { cols: 80, rows: 24 },
  ]);
  assert.ok(REDRAW_NUDGE_GAP_MS > 0);
});

test('REL-BGSTAB-047 AC-2: two rows or fewer are left alone', () => {
  assert.deepEqual(planRedrawNudge('manual', { cols: 80, rows: 2 }), []);
  assert.deepEqual(planRedrawNudge('workspace', { cols: 80, rows: 1 }), []);
});

test('REL-BGSTAB-047 AC-3: a resize repair already changed the size and sends no nudge', () => {
  assert.deepEqual(planRedrawNudge('resize', { cols: 120, rows: 40 }), []);
});

test('REL-BGSTAB-047 AC-1: the grid layout repair sends the planned resizes after the layout repair', () => {
  const source = readFileSync(new URL('../../src/components/Terminal/TerminalContainer.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('const runGridLayoutRepair = useCallback(');
  const body = source.slice(start, source.indexOf('}, [', start));
  const repaired = body.indexOf('repairLayout(');
  const nudged = body.indexOf('sendRedrawNudge(reason)');
  assert.ok(repaired > 0 && nudged > repaired, 'the nudge follows the layout repair');
  assert.match(source, /planRedrawNudge\(/u);
});

// REL-BGSTAB-058 (2026-10-27, #191): every tab switch nudged the PTY 47 -> 46 -> 47
// rows, and the TUI inside redrew twice, so the screen jumped up and down while
// it "looked for its place". A terminal that comes back from behind another tab
// is nudged only when another screen or device resized the PTY meanwhile.
test('REL-BGSTAB-058 AC-1: the first tab-view showing after mount is repaired', () => {
  assert.equal(shouldRepairOnSurfaceChange('tab', null, false, false), true);
});

test('REL-BGSTAB-058 AC-1: moving from a grid pane to the tab view is repaired', () => {
  assert.equal(shouldRepairOnSurfaceChange('tab', 'grid', true, false), true);
  assert.equal(shouldRepairOnSurfaceChange('tab', 'grid', false, false), true);
});

test('REL-BGSTAB-058 AC-4: a tab-view terminal back from behind another tab is repaired only after a resize elsewhere', () => {
  assert.equal(shouldRepairOnSurfaceChange('tab', null, true, false), false);
  assert.equal(shouldRepairOnSurfaceChange('tab', null, true, true), true);
});

test('REL-BGSTAB-058 AC-7: a grid pane becoming visible or switching surface is still repaired', () => {
  assert.equal(shouldRepairOnSurfaceChange('grid', null, true, false), true);
  assert.equal(shouldRepairOnSurfaceChange('grid', null, false, false), true);
  assert.equal(shouldRepairOnSurfaceChange('grid', 'tab', true, false), true);
});

test('REL-BGSTAB-058: hiding, or staying on the same surface, repairs nothing', () => {
  assert.equal(shouldRepairOnSurfaceChange(null, 'tab', true, true), false);
  assert.equal(shouldRepairOnSurfaceChange(null, 'grid', false, false), false);
  assert.equal(shouldRepairOnSurfaceChange('tab', 'tab', true, true), false);
  assert.equal(shouldRepairOnSurfaceChange('grid', 'grid', false, false), false);
});

test('REL-BGSTAB-058 AC-3: a reported size this terminal did not send recently came from elsewhere', () => {
  const sent = [{ cols: 208, rows: 46 }, { cols: 208, rows: 47 }];
  assert.equal(isResizeFromElsewhere({ cols: 208, rows: 47 }, sent), false, 'its own resize');
  assert.equal(isResizeFromElsewhere({ cols: 208, rows: 46 }, sent), false, 'its own nudge shrink');
  assert.equal(isResizeFromElsewhere({ cols: 43, rows: 30 }, sent), true, 'a phone resized the PTY');
  assert.equal(isResizeFromElsewhere({ cols: 80, rows: 24 }, []), true, 'nothing sent yet');
});

test('REL-BGSTAB-058 AC-3: only the last few sent sizes are remembered, newest last, without repeats', () => {
  let sent: readonly { cols: number; rows: number }[] = [];
  for (const rows of [40, 41, 42, 43, 44, 44]) sent = rememberSentSize(sent, { cols: 100, rows });
  assert.deepEqual(sent.map(size => size.rows), [41, 42, 43, 44]);
  assert.equal(sent.length, SENT_SIZE_MEMORY);
});

test('REL-BGSTAB-058 AC-4, AC-5: a conditional redraw resizes only after a resize elsewhere; the others always do', () => {
  assert.equal(shouldSendRedrawNudge('always', false), true);
  assert.equal(shouldSendRedrawNudge('always', true), true);
  assert.equal(shouldSendRedrawNudge('if-resized-elsewhere', false), false);
  assert.equal(shouldSendRedrawNudge('if-resized-elsewhere', true), true);
});

// REL-BGSTAB-058 AC-8 (2026-10-28): a terminal that stayed visible while another window resized
// the PTY never becomes visible again, so going back to its window must count as a return.
test('REL-BGSTAB-058 AC-8: returning to the window repairs a visible terminal only after a resize elsewhere', () => {
  assert.equal(shouldRepairOnWindowReturn(true, true, true), true);
  assert.equal(shouldRepairOnWindowReturn(true, true, false), false, 'nothing changed elsewhere');
  assert.equal(shouldRepairOnWindowReturn(false, true, true), false, 'a hidden terminal waits for its own showing');
  assert.equal(shouldRepairOnWindowReturn(true, false, true), false, 'the page itself is still hidden');
});
