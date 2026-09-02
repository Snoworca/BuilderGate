import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { DialogRect } from '../../src/components/dialog/types.ts';
import {
  clampToStage,
  toDockedRect,
  toStageRect,
} from '../../src/components/editor/editorWindowRect.ts';

// FR-MDE-001 — where a window sits, for each of the three placement states
// (AC-5, AC-6, AC-7). Which state the window is in is decided by
// editorWindowPlacement; this module only turns measurements into a rect.
//
// Two coordinate frames meet here and they do not even share field names. The
// terminal host registry stores {left, top, width, height} measured against the
// runtime overlay that TerminalRuntimeLayer renders inside the stage, while a
// window surface is portalled onto document.body and positioned with a
// DialogRect {x, y, width, height} resolved against the viewport. The overlay's
// own viewport origin is what carries a rect from the first frame to the second.

// A desktop layout with the sidebar, the header and the tab bar all present, so
// the stage origin is far from the viewport origin in both axes. Every value
// below is distinct, which is what lets an axis swap or a dropped term fail.
const STAGE: { left: number; top: number; width: number; height: number } = {
  left: 220,
  top: 94,
  width: 1700,
  height: 986,
};

// The overlay is the `position:absolute; inset:0` div inside the stage, so its
// viewport origin coincides with the stage origin. It is passed separately
// rather than derived from STAGE because the registry's coordinates are
// relative to the overlay, and only the overlay can answer where it is.
const OVERLAY_ORIGIN = { left: STAGE.left, top: STAGE.top };

// The same stage expressed as the window coordinates a clamp works in. It is
// written out rather than derived from STAGE so that a fault in toStageRect
// cannot quietly move the boundary the clamp is judged against.
const STAGE_BOUNDS: DialogRect = { x: 220, y: 94, width: 1700, height: 986 };

// The path bar sits under the terminal inside the tab, so the terminal host
// that the registry measures is the stage minus those 28px.
const PATH_BAR_HEIGHT = 28;
const TAB_MODE_HOST = {
  left: 0,
  top: 0,
  width: STAGE.width,
  height: STAGE.height - PATH_BAR_HEIGHT,
};

// A tile in grid mode, offset from the overlay in both axes. Without a case
// like this an implementation that dropped hostRect.left and hostRect.top and
// simply returned the overlay origin would still satisfy the tab-mode case.
const GRID_TILE_HOST = {
  left: 852,
  top: 141,
  width: 848,
  height: 817,
};

// The three constants the stage container already excludes: sidebar 220,
// header 58, tab bar 36. Every numeric literal is read out and evaluated rather
// than matched as text, so a constant respelled as 220.0, 0xDC or 2.2e2 is the
// same finding as 220. Comments are stripped first because the prohibition is
// on the computation, not on naming the numbers while explaining their absence.
// The lookaround keeps a number from being read out of an identifier such as
// `tabBar36px`, which is a name rather than a restated constant. A constant
// assembled by arithmetic is outside what this reads.
const NUMERIC_LITERAL = /(?<![\w.$])(0[xX][0-9a-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(?![\w$])/g;

function findLayoutConstants(source: string): number[] {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split(/\r?\n/)
    .map(line => line.replace(/\/\/.*$/, ''))
    .join('\n');

  const literals = new Set<number>();
  for (const match of code.matchAll(NUMERIC_LITERAL)) {
    literals.add(Number(match[1]));
  }

  return [220, 58, 36].filter(constant => literals.has(constant));
}

// Reads a module together with every module it reaches through relative
// imports. Scanning one file only would say where the constants may not be
// written rather than whether they were copied: moving them into a sibling and
// importing it back would leave a single-file scan untouched.
function readModuleWithLocalImports(entry: URL): string {
  const seen = new Set<string>();
  const queue = [entry];
  const sources: string[] = [];

  while (queue.length > 0) {
    const url = queue.shift() as URL;
    if (seen.has(url.href)) continue;
    seen.add(url.href);

    const text = readFileSync(url, 'utf8');
    sources.push(text);

    for (const match of text.matchAll(/from\s+'(\.[^']*)'/g)) {
      queue.push(resolveLocalImport(match[1], url));
    }
  }

  return sources.join('\n');
}

function resolveLocalImport(specifier: string, from: URL): URL {
  if (specifier.endsWith('.ts') || specifier.endsWith('.tsx')) {
    return new URL(specifier, from);
  }

  const asTs = new URL(`${specifier}.ts`, from);
  return existsSync(asTs) ? asTs : new URL(`${specifier}.tsx`, from);
}

function bottomOf(rect: DialogRect): number {
  return rect.y + rect.height;
}

function rightOf(rect: DialogRect): number {
  return rect.x + rect.width;
}

test('FR-MDE-001 docked rect equals the registered rect translated by the overlay origin', () => {
  const docked = toDockedRect(TAB_MODE_HOST, OVERLAY_ORIGIN);

  assert.deepEqual(docked, {
    x: TAB_MODE_HOST.left + OVERLAY_ORIGIN.left,
    y: TAB_MODE_HOST.top + OVERLAY_ORIGIN.top,
    width: TAB_MODE_HOST.width,
    height: TAB_MODE_HOST.height,
  });

  // AC-5's other half — that the docked bottom stays at or above the path bar —
  // is not separately assertable here, and pretending otherwise would add an
  // assertion that no mutation can reach. It holds upstream: TerminalHostSlot
  // registers the terminal host's own rect, which excludes the bar beneath it,
  // and the size equality above is what pins this module to carrying that rect
  // across unchanged. What is rendered is judged by the Playwright suite.

  // A tile offset in both axes. Both terms of both sums are distinct here, so
  // adding the origin to the wrong axis, or to the size instead of the
  // position, lands on a different number.
  const tile = toDockedRect(GRID_TILE_HOST, OVERLAY_ORIGIN);
  assert.deepEqual(tile, {
    x: 1072,
    y: 235,
    width: 848,
    height: 817,
  });

  // Leaving the coordinates stage-relative is the failure this translation
  // exists to prevent, and it is invisible whenever the origin happens to be
  // zero. It is not zero here, so the two forms are pinned apart.
  assert.notDeepEqual(tile, {
    x: GRID_TILE_HOST.left,
    y: GRID_TILE_HOST.top,
    width: GRID_TILE_HOST.width,
    height: GRID_TILE_HOST.height,
  });

  // The registry hands out the object it stores. Writing through it here would
  // corrupt the entry that TerminalRuntimeLayer positions the terminal with.
  assert.deepEqual(GRID_TILE_HOST, { left: 852, top: 141, width: 848, height: 817 });
});

test('FR-MDE-001 stage rect is the measured container and follows a resize with no pixel constant', () => {
  // The measured container comes back as window coordinates, unchanged in size
  // and position. STAGE_BOUNDS is the independently written form of the same
  // stage, so agreement here also pins the two fixtures to each other.
  assert.deepEqual(toStageRect(STAGE), STAGE_BOUNDS);
  assert.deepEqual(toStageRect(STAGE), { x: 220, y: 94, width: 1700, height: 986 });

  // The stage is remeasured on every resize, so a narrower stage has to produce
  // a narrower rect from the same call.
  const narrowed = { left: 220, top: 94, width: 1180, height: 742 };
  assert.deepEqual(toStageRect(narrowed), { x: 220, y: 94, width: 1180, height: 742 });

  // And the old value has to be gone rather than remembered: a module that
  // cached the first measurement would satisfy both assertions above in order
  // while returning the stale rect to the third caller.
  assert.deepEqual(toStageRect(STAGE), { x: 220, y: 94, width: 1700, height: 986 });

  // AC-6 also demands that the stage never be reconstructed from the layout
  // constants it already excludes. Those three live in three different files
  // with no shared variable, so a copy here would drift the moment one of them
  // moves. The computation is read and scanned for them.
  const source = readModuleWithLocalImports(
    new URL('../../src/components/editor/editorWindowRect.ts', import.meta.url),
  );
  assert.ok(source.length > 0, 'the module source was read');
  // The traversal has to have left the entry file, or the scan below is a
  // one-file scan wearing the name of a transitive one.
  assert.match(source, /interface DialogRect/);

  // A negative assertion over text is worth nothing until the detector is shown
  // to detect. It is exercised both ways on synthetic input first, including
  // the respellings that a text match would let through.
  assert.deepEqual(findLayoutConstants('const sidebarWidth = 220;'), [220]);
  assert.deepEqual(findLayoutConstants('const headerHeight = 58; const tabBar = 36;'), [58, 36]);
  assert.deepEqual(findLayoutConstants('const shift = -58;'), [58]);
  assert.deepEqual(findLayoutConstants('const a = 220.0; const b = 0xDC; const c = 2.2e2;'), [220]);
  assert.deepEqual(findLayoutConstants('// sidebar 220 is excluded by the stage'), []);
  assert.deepEqual(findLayoutConstants('/* header 58, tab bar 36 */'), []);
  assert.deepEqual(findLayoutConstants('const stageWidth = 1700; const n = 2200;'), []);
  assert.deepEqual(findLayoutConstants('const tabBar36px = 1; const w58 = 2;'), []);

  assert.deepEqual(
    findLayoutConstants(source),
    [],
    'the stage computation restates a sidebar, header or tab bar constant',
  );
});

test('FR-MDE-001 floating clamping keeps the rect inside the stage and preserves an in-bounds delta', () => {
  const floating: DialogRect = { x: 600, y: 300, width: 640, height: 452 };

  // A drag fully inside the stage must arrive exactly where it was asked to.
  // Rounding or re-snapping here would make the window lag the pointer.
  const delta = { dx: -137, dy: 219 };
  const moved = clampToStage(
    { ...floating, x: floating.x + delta.dx, y: floating.y + delta.dy },
    STAGE_BOUNDS,
  );
  assert.equal(moved.x - floating.x, delta.dx);
  assert.equal(moved.y - floating.y, delta.dy);
  assert.equal(moved.width, floating.width);
  assert.equal(moved.height, floating.height);

  // Dragged up and left, over the sidebar and the header. x = 40 and y = 12 are
  // both non-negative, so a clamp written against the viewport would accept
  // them unchanged; only a clamp against the stage moves them.
  const overChrome = clampToStage({ ...floating, x: 40, y: 12 }, STAGE_BOUNDS);
  assert.deepEqual(overChrome, {
    x: STAGE_BOUNDS.x,
    y: STAGE_BOUNDS.y,
    width: floating.width,
    height: floating.height,
  });

  // Dragged past the far edge. The window has to come back by its own size, not
  // merely have its origin pinned to the stage edge.
  const overFarEdge = clampToStage({ ...floating, x: 9000, y: 9000 }, STAGE_BOUNDS);
  assert.deepEqual(overFarEdge, {
    x: STAGE_BOUNDS.x + STAGE_BOUNDS.width - floating.width,
    y: STAGE_BOUNDS.y + STAGE_BOUNDS.height - floating.height,
    width: floating.width,
    height: floating.height,
  });
  assert.equal(rightOf(overFarEdge), STAGE_BOUNDS.x + STAGE_BOUNDS.width);
  assert.equal(bottomOf(overFarEdge), STAGE_BOUNDS.y + STAGE_BOUNDS.height);

  // A rect already inside is returned untouched, and the caller's object is not
  // handed back -- the window state and the clamp result must not alias.
  const inside: DialogRect = { x: 700, y: 400, width: 300, height: 200 };
  const unchanged = clampToStage(inside, STAGE_BOUNDS);
  assert.deepEqual(unchanged, inside);
  assert.notEqual(unchanged, inside);

  // A floating rect larger than the stage cannot be contained by moving it, so
  // containment is paid for by size. This arises when the stage shrinks under a
  // window that was sized against a larger one.
  const oversized: DialogRect = {
    x: 0,
    y: 0,
    width: STAGE_BOUNDS.width + 300,
    height: STAGE_BOUNDS.height + 300,
  };
  const fitted = clampToStage(oversized, STAGE_BOUNDS);
  assert.deepEqual(fitted, {
    x: STAGE_BOUNDS.x,
    y: STAGE_BOUNDS.y,
    width: STAGE_BOUNDS.width,
    height: STAGE_BOUNDS.height,
  });

  // Every expectation above reads STAGE_BOUNDS back rather than restating its
  // numbers, so a clamp that wrote into the stage it was handed would corrupt
  // both sides of those comparisons at once and go unnoticed. Literals close that.
  assert.deepEqual(STAGE_BOUNDS, { x: 220, y: 94, width: 1700, height: 986 });
});
