// REL-BGSTAB-048 (#145): output stopped halfway and older text showed through,
// and selecting the area drew it correctly -- the buffer was right, the canvas
// was stale. Every completed fit repaints all rows two frames later.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createFullRepaintScheduler } from '../../src/components/Terminal/terminalFullRepaint.ts';

function harness(element: { isConnected: boolean; offsetHeight: number } | null) {
  const frames: Array<() => void> = [];
  const refreshes: Array<[number, number]> = [];
  const term = { rows: 30, element, refresh: (a: number, b: number) => { refreshes.push([a, b]); } };
  const schedule = createFullRepaintScheduler((cb) => { frames.push(cb); return frames.length; });
  const runFrame = (): void => { const pending = frames.splice(0); for (const cb of pending) cb(); };
  return { term, schedule, runFrame, refreshes };
}

test('REL-BGSTAB-048 AC-2: repaints every row two frames later', () => {
  const h = harness({ isConnected: true, offsetHeight: 400 });
  h.schedule(h.term);
  h.runFrame();
  assert.deepEqual(h.refreshes, [], 'not on the first frame');
  h.runFrame();
  assert.deepEqual(h.refreshes, [[0, 29]]);
});

test('REL-BGSTAB-048 AC-2: a detached or zero-height terminal is not repainted', () => {
  for (const element of [null, { isConnected: false, offsetHeight: 400 }, { isConnected: true, offsetHeight: 0 }]) {
    const h = harness(element);
    h.schedule(h.term);
    h.runFrame();
    h.runFrame();
    assert.deepEqual(h.refreshes, []);
  }
});

test('REL-BGSTAB-048 AC-3: several requests in one frame repaint once', () => {
  const h = harness({ isConnected: true, offsetHeight: 400 });
  h.schedule(h.term);
  h.schedule(h.term);
  h.schedule(h.term);
  h.runFrame();
  h.runFrame();
  assert.equal(h.refreshes.length, 1);
});

test('REL-BGSTAB-048 AC-1: every fit completion in TerminalView schedules the repaint', () => {
  const source = readFileSync(new URL('../../src/components/Terminal/TerminalView.tsx', import.meta.url), 'utf8');
  const sites = source.split("recordTerminalDebugEvent(sessionId, 'fit_completed', {").length - 1;
  assert.ok(sites >= 5, `fit completion sites: ${sites}`);
  const repaints = source.split('scheduleFullRepaint(term);\n').length - 1;
  assert.equal(repaints, sites, 'each fit completion is followed by a repaint');
});
