import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildInputDebugDetails, canSegmentGraphemes } from './inputDebugMetadata.js';

// REL-BGSTAB-031: the packaged executable's Node (pkg base, `icu_small: true`) has no ICU grapheme
// break data. `Intl.Segmenter#segment()` there does not throw — it takes the whole process down
// with 0xC0000005 (measured on the 0.10.0 exe: the first keystroke of the first session). The
// input debug metadata ran that on every write, so the check must never reach it on small ICU.

test('REL-BGSTAB-031 AC-1: a small-ICU build reports that graphemes cannot be segmented', () => {
  assert.equal(canSegmentGraphemes({ variables: { icu_small: true } }), false);
  assert.equal(canSegmentGraphemes({ variables: { icu_small: false } }), true);
  assert.equal(canSegmentGraphemes({ variables: {} }), true);
});

test('REL-BGSTAB-031 AC-2: without segmentation the count is approximate and Intl.Segmenter is never touched', () => {
  const intl = Intl as unknown as { Segmenter?: unknown };
  const original = intl.Segmenter;
  intl.Segmenter = class { constructor() { throw new Error('Segmenter must not be used on small ICU'); } };
  try {
    const details = buildInputDebugDetails('가x', undefined, { segmentGraphemes: false });
    assert.equal(details.graphemeCount, 2);
    assert.equal(details.graphemeApproximate, true);
  } finally {
    intl.Segmenter = original;
  }
});

test('REL-BGSTAB-031 AC-3: with full ICU the exact grapheme count is kept', () => {
  const details = buildInputDebugDetails('éx', undefined, { segmentGraphemes: true });
  assert.equal(details.graphemeCount, 2);
  assert.equal(details.graphemeApproximate, false);
});
