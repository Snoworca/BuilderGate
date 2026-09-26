import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

const containerSource = readFileSync(
  new URL('../../src/components/Terminal/TerminalContainer.tsx', import.meta.url),
  'utf8',
);
const runtimeLayerSource = readFileSync(
  new URL('../../src/components/Terminal/TerminalRuntimeLayer.tsx', import.meta.url),
  'utf8',
);

// @req REL-BGSTAB-012
test('#110 delivery interest is reported from visibility alone, never from the host being a grid cell', () => {
  // Measured 2026-09-19 on https://localhost:2222 with the visibility handler instrumented:
  // EVERY terminal-delivery:visibility message in an entire run, for all three sessions, was
  // {isVisible: false, generation: "1"}. The client never sent `true` -- not on attach, not
  // after the workspace bounce -- so the server withheld every chunk after the first, including
  // codex's 920-byte paint, and latched a data gap instead.
  //
  // The cause was `isVisible: isVisible && isGridSurface`. isGridSurface is
  // `host.className.includes('grid-cell')` -- a presentation detail that exists for middle-click
  // paste. Terminals in the workspace tab surface are not grid cells, so the whole product
  // reported itself permanently invisible. isVisible already means displayed with non-zero area
  // (`host?.isVisible && host.rect.width > 0 && host.rect.height > 0`), which is exactly and
  // only what delivery interest is asking about.
  const signature = 'delivery visibility must not be gated on the grid surface';
  const publishIndex = containerSource.indexOf('publishTerminalDeliveryVisibility({');
  assert.notEqual(publishIndex, -1, signature);
  const publishCall = containerSource.slice(publishIndex, publishIndex + 200);
  assert.match(publishCall, /isVisible,/, signature);
  assert.doesNotMatch(publishCall, /isGridSurface/, signature);
});

// @req REL-BGSTAB-012
test('#110 isGridSurface survives for the interaction it exists for', () => {
  // Not a blanket removal: the flag is legitimate for grid-only pointer behaviour, and deleting
  // it would trade one defect for another.
  assert.match(
    runtimeLayerSource,
    /const isGridSurface = Boolean\(host\?\.className\?\.includes\('grid-cell'\)\)/,
    'the grid-surface flag itself stays',
  );
  assert.match(runtimeLayerSource, /event\.button === 1 && isGridSurface/, 'middle-click paste still uses it');
});
