import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// #74: the browser side of the P16/P256 mismatch #28 fixed on the server.
//
// addon-serialize re-emits palette indices 0..15 in the short P16 form, so a cell written as
// P256 rehydrates as P16. Same colour, different spelling, unequal comparison -- a parity
// failure for a difference that is not one.
//
// Asserted as source text rather than behaviour on purpose: the projection needs a live xterm
// buffer, and a stubbed cell would only prove the stub agrees with itself. What must hold is
// that BOTH sides normalise and that they normalise in the SAME DIRECTION -- normalising the
// browser P256 down to P16 would make both sides agree and both sides wrong relative to #28.

const frontendSource = readFileSync(
  new URL('../../src/utils/terminalRetainedState.ts', import.meta.url), 'utf8');
const serverSource = readFileSync(
  new URL('../../../server/src/utils/headlessTerminal.ts', import.meta.url), 'utf8');

function normalisationDirection(source: string): string {
  const body = source.match(
    /function canonicalPaletteColor\([^)]*\)[^{]*\{([\s\S]*?)\n\}/u);
  assert.ok(body, 'canonicalPaletteColor must exist; this pin cannot pass over its absence');
  return body[1].replace(/\s+/gu, ' ').trim();
}

test('#74 the browser normalises the palette at all three projection sites', () => {
  const projections = frontendSource.match(/fgMode: canonicalPaletteColor\(/gu) ?? [];
  assert.equal(projections.length, 3,
    'all three cell projections must normalise; a site left raw reintroduces the mismatch');
  // A site that reads the mode without normalising is exactly the defect.
  assert.equal((frontendSource.match(/fgMode: cell\.(getFgColorMode\(\)|fgMode),/gu) ?? []).length, 0);
});

test('#74 both sides normalise in the same direction', () => {
  assert.equal(normalisationDirection(frontendSource), normalisationDirection(serverSource),
    'the browser and the server must agree on which spelling is canonical');
  // And that direction must be P16 -> P256, not the reverse.
  assert.match(normalisationDirection(frontendSource),
    /mode === XTERM_COLOR_MODE_P16 .* return \[XTERM_COLOR_MODE_P256, color\]/u);
});
