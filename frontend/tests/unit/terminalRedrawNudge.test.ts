// REL-BGSTAB-047 (#145): the server skips a resize to the size the PTY already
// has, so a TUI that drew itself wrong is never told to draw again. A grid pane
// that becomes visible, or a manual repair, shrinks the PTY by one row and puts
// it back, which is what dragging a grid border by hand did.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { planRedrawNudge, REDRAW_NUDGE_GAP_MS } from '../../src/components/Terminal/terminalRedrawNudge.ts';

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
