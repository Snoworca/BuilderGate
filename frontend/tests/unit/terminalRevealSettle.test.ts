import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  REVEAL_SETTLE_DELAYS_MS,
  decideRevealCheck,
  startRevealSettle,
} from '../../src/components/Terminal/terminalRevealSettle.ts';

// REL-BGSTAB-049 (#155): a tab that becomes visible is re-checked a few times, so a first frame
// with no size or a refused fit can no longer leave the terminal unpainted.

function fakeClock() {
  const pending: { at: number; fn: () => void; cancelled: boolean }[] = [];
  let now = 0;
  return {
    schedule(fn: () => void, ms: number) {
      const entry = { at: now + ms, fn, cancelled: false };
      pending.push(entry);
      return () => { entry.cancelled = true; };
    },
    advance(ms: number) {
      now += ms;
      for (const entry of [...pending].sort((a, b) => a.at - b.at)) {
        if (entry.at <= now && !entry.cancelled) {
          entry.cancelled = true;
          entry.fn();
        }
      }
    },
  };
}

test('REL-BGSTAB-049 AC-1: the checks run at 0, 120, 400 and 1000 ms', () => {
  assert.deepEqual([...REVEAL_SETTLE_DELAYS_MS], [0, 120, 400, 1000]);
});

test('REL-BGSTAB-049 AC-1/AC-2/AC-3: no size does nothing; a size repaints, and fits only once', () => {
  assert.deepEqual(decideRevealCheck({ renderable: false, fitSubmitted: false, first: true, lateFit: true }), { fit: false, repaint: false });
  assert.deepEqual(decideRevealCheck({ renderable: true, fitSubmitted: false, first: true, lateFit: false }), { fit: true, repaint: true });
  assert.deepEqual(decideRevealCheck({ renderable: true, fitSubmitted: true, first: false, lateFit: true }), { fit: false, repaint: true });
  // A tab terminal whose first frame had no size fits at a later check; a grid tile does not
  // (its grid repair sizes it, REL-BGSTAB-047).
  assert.deepEqual(decideRevealCheck({ renderable: true, fitSubmitted: false, first: false, lateFit: true }), { fit: true, repaint: true });
  assert.deepEqual(decideRevealCheck({ renderable: true, fitSubmitted: false, first: false, lateFit: false }), { fit: false, repaint: true });
});

test('REL-BGSTAB-049: a first frame with no size is retried; the fit goes once and every later check repaints', () => {
  const clock = fakeClock();
  const sizes = [false, true, true, true];
  let index = 0;
  const calls: string[] = [];
  startRevealSettle({
    schedule: clock.schedule,
    isRenderable: () => sizes[index++] ?? true,
    lateFit: true,
    // Submitted once: a refused fit is held by the coordinator and applied later, and a second
    // submission raced a grid tile's repair nudge (REL-BGSTAB-047).
    fit: () => calls.push('fit'),
    repaint: () => calls.push('repaint'),
  });
  clock.advance(0);
  assert.deepEqual(calls, [], 'no size at 0 ms: nothing');
  clock.advance(120);
  assert.deepEqual(calls, ['fit', 'repaint']);
  clock.advance(280);
  assert.deepEqual(calls, ['fit', 'repaint', 'repaint']);
  clock.advance(600);
  assert.deepEqual(calls, ['fit', 'repaint', 'repaint', 'repaint']);
});

test('REL-BGSTAB-049 AC-4: cancelling stops the remaining checks', () => {
  const clock = fakeClock();
  let repaints = 0;
  const cancel = startRevealSettle({
    schedule: clock.schedule,
    isRenderable: () => true,
    lateFit: true,
    fit: () => {},
    repaint: () => { repaints += 1; },
  });
  clock.advance(0);
  cancel();
  clock.advance(2000);
  assert.equal(repaints, 1);
});

test('REL-BGSTAB-049: TerminalView reveals through the settle, not a single frame', () => {
  const source = readFileSync(new URL('../../src/components/Terminal/TerminalView.tsx', import.meta.url), 'utf8');
  assert.match(source, /startRevealSettle\(\{/);
  assert.match(source, /revealSettleCancelRef\.current\?\.\(\)/);
  assert.match(source, /lateFit: onManualRepair === undefined/);
});

test('REL-BGSTAB-049: a host slot that becomes visible re-measures on the same schedule', () => {
  const source = readFileSync(new URL('../../src/components/Terminal/TerminalHostSlot.tsx', import.meta.url), 'utf8');
  assert.match(source, /REVEAL_SETTLE_DELAYS_MS\.map\(/);
  assert.match(source, /if \(!isVisible\) return undefined;/);
});
