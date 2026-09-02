import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DialogRect, DialogSize } from '../../src/components/dialog/types.ts';
import {
  computeCascadeRect,
  type CascadeWindow,
} from '../../src/components/editor/editorWindowCascade.ts';

// FR-MDE-004 — where a window entering `docked` lands when others are already
// docked on the same terminal (AC-1 to AC-7, plus the computed half of AC-8's
// undersized-target case). What is left to the Playwright suite is AC-8's other
// half, the box the browser actually renders: `WindowDialog` hands `Rnd` a
// minimum clamped only by the viewport, so for any real viewport it is the
// editor's own minimum, and an undersized target is the one case where the
// rendered box can differ from the rect computed here.
//
// The offset is paid for by shrinking. Moving a window without shrinking it
// pushes it past the edge of the terminal it is docked to, and pulling it back
// puts the offset at zero again, which makes every window coincide exactly and
// leaves no title bar to press.

const TAB = 'tab-a';
const OTHER_TAB = 'tab-b';

const TARGET: DialogRect = { x: 220, y: 94, width: 1700, height: 958 };
const MIN_SIZE: DialogSize = { width: 320, height: 240 };

// The four steps, written out rather than computed from TARGET. A helper that
// applied the 28px rule would be the same rule the module is being judged by,
// and the two sides of a comparison have to come from different places.
const STEP_0: DialogRect = { x: 220, y: 94, width: 1700, height: 958 };
const STEP_1: DialogRect = { x: 248, y: 122, width: 1672, height: 930 };
const STEP_2: DialogRect = { x: 276, y: 150, width: 1644, height: 902 };
const STEP_3: DialogRect = { x: 304, y: 178, width: 1616, height: 874 };

// The fixtures go in unaliased, on purpose. Copying them here would put every
// guard below out of reach: a computation that offset a rect in place, or that
// handed the caller's own target back, would never touch an object any
// assertion in this file can see.
function docked(rect: DialogRect, overrides: Partial<CascadeWindow> = {}): CascadeWindow {
  return { tabId: TAB, placement: 'docked', minimized: false, rect, ...overrides };
}

function place(alreadyDocked: readonly CascadeWindow[], target: DialogRect = TARGET): DialogRect {
  return computeCascadeRect({ tabId: TAB, target, alreadyDocked, minSize: MIN_SIZE });
}

// Re-read after a batch of calls. The fixtures are pinned to their literals, so
// a write through any of them is a failure here rather than a puzzle later.
function assertFixturesIntact(): void {
  assert.deepEqual(TARGET, { x: 220, y: 94, width: 1700, height: 958 });
  assert.deepEqual(STEP_0, { x: 220, y: 94, width: 1700, height: 958 });
  assert.deepEqual(STEP_1, { x: 248, y: 122, width: 1672, height: 930 });
  assert.deepEqual(STEP_2, { x: 276, y: 150, width: 1644, height: 902 });
  assert.deepEqual(STEP_3, { x: 304, y: 178, width: 1616, height: 874 });
  assert.deepEqual(MIN_SIZE, { width: 320, height: 240 });
}

function contains(outer: DialogRect, inner: DialogRect): boolean {
  return inner.x >= outer.x
    && inner.y >= outer.y
    && inner.x + inner.width <= outer.x + outer.width
    && inner.y + inner.height <= outer.y + outer.height;
}

test('FR-MDE-004 step k offsets by 28k and shrinks by 28k inside the target rect', () => {
  const expectedByCount = [STEP_0, STEP_1, STEP_2, STEP_3];

  for (let n = 0; n < expectedByCount.length; n += 1) {
    const alreadyDocked = expectedByCount.slice(0, n).map(rect => docked(rect));
    const placed = place(alreadyDocked);

    assert.deepEqual(placed, expectedByCount[n], `with ${n} already docked`);

    // Offsetting without shrinking is the failure the shrink exists to prevent,
    // and it is invisible in the rect equality alone if the expectation were
    // ever regenerated from the implementation. Containment says it plainly.
    assert.ok(contains(TARGET, placed), `step ${n} left the target rect`);
  }

  // At step 0 the answer has the same value as the target, so handing the
  // target object straight back would satisfy every equality above while
  // aliasing the caller's rect to the window's own state.
  assert.notEqual(place([]), TARGET);

  assertFixturesIntact();
});

test('FR-MDE-004 a second docked window differs by exactly 28 in both axes', () => {
  const first = place([]);
  const second = place([docked(first)]);

  assert.notDeepEqual(second, first);
  assert.equal(second.x - first.x, 28);
  assert.equal(second.y - first.y, 28);
  assert.equal(first.width - second.width, 28);
  assert.equal(first.height - second.height, 28);

  assertFixturesIntact();
});

test('FR-MDE-004 the fifth docked window wraps to k = 0', () => {
  const four = [STEP_0, STEP_1, STEP_2, STEP_3].map(rect => docked(rect));
  const fifth = place(four);

  assert.deepEqual(fifth, STEP_0);

  assertFixturesIntact();
});

test('FR-MDE-004 a step below minSize collapses to k = 0 with the full target rect', () => {
  // The target itself clears the minimum, but one step off it does not: 250
  // less the 28px step is 222, under the 240 the editor asks for.
  const shallow: DialogRect = { x: 100, y: 100, width: 400, height: 250 };
  const second = place([docked(shallow)], shallow);
  assert.deepEqual(second, shallow);

  // The same on the other axis, so an implementation checking only the height
  // does not pass. 340 less 28 is 312, under 320.
  const narrow: DialogRect = { x: 100, y: 100, width: 340, height: 900 };
  assert.deepEqual(place([docked(narrow)], narrow), narrow);

  // And a target that clears the minimum on both axes even after a step is not
  // collapsed, so the guard above is not simply always on.
  const roomy: DialogRect = { x: 100, y: 100, width: 400, height: 300 };
  assert.deepEqual(place([docked(roomy)], roomy), {
    x: 128, y: 128, width: 372, height: 272,
  });

  // A target smaller than the minimum takes its own size rather than being
  // widened to it: a window inflated past its tile covers the neighbouring
  // terminal, and that is worse than a window that is small.
  const tiny: DialogRect = { x: 100, y: 100, width: 300, height: 200 };
  assert.deepEqual(place([], tiny), tiny);
  assert.deepEqual(place([docked(tiny)], tiny), tiny);

  // Exactly on the minimum, on both axes at once: 348 - 28 is 320 and 268 - 28
  // is 240. The criterion collapses a step that falls *below* the minimum, so
  // landing on it is still a step. Without this case a `<` and a `<=` guard are
  // indistinguishable, and they disagree on every terminal 28px above the floor.
  const exact: DialogRect = { x: 100, y: 100, width: 348, height: 268 };
  assert.deepEqual(place([docked(exact)], exact), {
    x: 128, y: 128, width: 320, height: 240,
  });

  assertFixturesIntact();
});

test('FR-MDE-004 hidden and minimized docked windows count while stage and floating do not', () => {
  // One minimized, and one on a tab that is not the active one. Nothing marks
  // the second as hidden, and that is the point: a window on an inactive tab is
  // an ordinary `docked` window and still holds its place in the cascade.
  // Dropping either would hand an occupied step to the new window.
  const hidden = [
    docked(STEP_0, { minimized: true }),
    docked(STEP_1),
  ];
  assert.deepEqual(place(hidden), STEP_2);

  // `stage` and `floating` windows are not over that terminal, so they hold no
  // step even while they are bound to the tab.
  const elsewhere: CascadeWindow[] = [
    { tabId: TAB, placement: 'stage', minimized: false, rect: STEP_0 },
    { tabId: TAB, placement: 'floating', minimized: false, rect: STEP_1 },
  ];
  assert.deepEqual(place(elsewhere), STEP_0);

  // Neither does a window docked over a different tab's terminal.
  const otherTab = [docked(STEP_0, { tabId: OTHER_TAB })];
  assert.deepEqual(place(otherTab), STEP_0);

  // A docked window that has not been placed yet holds nothing either. It is
  // put alone here on purpose: alongside a window that already stands on step 0
  // an implementation that gave the unplaced one step 0 too would reach the
  // same answer, and the case would decide nothing.
  const onlyUnplaced = [{ ...docked(STEP_1), rect: null }];
  assert.deepEqual(place(onlyUnplaced), STEP_0);

  const unplacedBesidePlaced = [docked(STEP_0), { ...docked(STEP_1), rect: null }];
  assert.deepEqual(place(unplacedBesidePlaced), STEP_1);

  assertFixturesIntact();
});

test('FR-MDE-004 k is recomputed on every entry into docked', () => {
  // A opens first and takes step 0.
  const a0 = place([]);
  assert.deepEqual(a0, STEP_0);

  // A is dragged away, so its step is free again and B takes it.
  const aFloating: CascadeWindow = {
    tabId: TAB, placement: 'floating', minimized: false, rect: a0,
  };
  const b = place([aFloating]);
  assert.deepEqual(b, STEP_0);

  // A comes back through 터미널 채움. Handing it the step it used to hold would
  // put it exactly under B, where neither title bar can be pressed to separate
  // them, so the step has to be worked out again from what is there now.
  const aReturned = place([aFloating, docked(b)]);
  assert.notDeepEqual(aReturned, b);
  assert.deepEqual(aReturned, STEP_1);

  assertFixturesIntact();
});

test('FR-MDE-004 closing a middle window leaves the others in place and frees its step', () => {
  const first = docked(STEP_0);
  const middle = docked(STEP_1);
  const last = docked(STEP_2);

  const remaining = [first, last];

  // Closing the middle window moves nothing: the two that stay keep the rects
  // they were given, which is what makes the arrangement stable to press on.
  assert.deepEqual(first.rect, STEP_0);
  assert.deepEqual(last.rect, STEP_2);
  assert.deepEqual(middle.rect, STEP_1);

  // The freed step is what the next window takes. Counting the survivors would
  // hand out step 2 instead and drop the new window exactly onto `last`.
  const next = place(remaining);
  assert.deepEqual(next, STEP_1);
  assert.notDeepEqual(next, STEP_2);

  assertFixturesIntact();
});

test('FR-MDE-004 a step is occupied only by a rect that matches it exactly', () => {
  // All the docked rects on one terminal come out of the same computation over
  // the same target, so a sibling standing on a step matches it in all four
  // numbers. A rect that differs in any one of them belongs to a target that
  // has since moved, and its step is genuinely free — the surviving window is
  // remeasured onto the new target rather than being kept where it was.

  // Same position as step 0, different size.
  assert.deepEqual(place([docked({ x: 220, y: 94, width: 900, height: 500 })]), STEP_0);

  // Same size as step 0, different position.
  assert.deepEqual(place([docked({ x: 700, y: 400, width: 1700, height: 958 })]), STEP_0);

  // Half a pixel off. The registry measures with getBoundingClientRect, so a
  // fractional coordinate is ordinary, and this pins the comparison to exact
  // equality rather than to a tolerance that would let a stale rect hold a step
  // that nothing is standing on.
  assert.deepEqual(place([docked({ x: 220.5, y: 94, width: 1700, height: 958 })]), STEP_0);

  // A fractional target steps by the same 28 and is matched the same way, so a
  // sibling exactly on step 0 of it still blocks that step.
  const fractional: DialogRect = { x: 220.5, y: 94.25, width: 1700.5, height: 958.75 };
  assert.deepEqual(place([docked(fractional)], fractional), {
    x: 248.5, y: 122.25, width: 1672.5, height: 930.75,
  });

  assertFixturesIntact();
});
