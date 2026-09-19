import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import type { Terminal as TerminalType } from '@xterm/xterm';
import { installJsdomEnvironment } from './jsdomEnvironment.ts';
import {
  captureSelectionAnchor,
  verifySelectionAnchor,
  disposeSelectionAnchor,
} from '../../src/utils/terminalSelectionAnchor.ts';

// The installed @xterm/xterm build is UMD/CJS with no "exports" field, so a
// plain named import fails under plain ESM (`node --experimental-strip-types`)
// the same dual-package-hazard way tests/unit/terminalOutputScheduler.test.ts
// and tests/unit/terminalUnicodeWidthGolden.test.ts already work around.
const require = createRequire(import.meta.url);
const xtermNamespace = require('@xterm/xterm') as unknown as {
  Terminal?: typeof TerminalType;
  default?: { Terminal?: typeof TerminalType };
};
const Terminal = xtermNamespace.Terminal ?? xtermNamespace.default?.Terminal;
assert.ok(Terminal, '@xterm/xterm must expose Terminal directly or on its default export');

/**
 * Issue #16 item 3: the selection anchor needs a stable identity keyed to a
 * buffer line, not raw coordinates, so item 4's "verify identity, then reject
 * a stale copy" can be more than blind trust in same-epoch+geometry.
 *
 * This file tests `terminalSelectionAnchor.ts` directly against a REAL
 * `@xterm/xterm` `Terminal`, headless (never `.open()`d). Buffer/marker
 * mechanics do not need a DOM; only the selection SERVICE does, which is why
 * `captureSelectionAnchor` takes a `position` argument instead of calling
 * `term.getSelectionPosition()` itself -- that keeps the whole identity
 * mechanism testable without a browser, and the same split is what lets
 * `TerminalView.tsx` fall back cleanly whenever a real position genuinely
 * is not available.
 *
 * Every predicate here was chosen because it was MEASURED to matter, not
 * assumed:
 *   - reflow survival: measured directly (a wrapped line survives narrowing
 *     and widening resize with its marker intact) before this design was
 *     proposed at all -- had it failed, markers would have been the wrong
 *     foundation.
 *   - content-mismatch (RIS / `term.reset()`): measured that `reset()`
 *     leaves a marker `isDisposed: false` pointing at now-empty content,
 *     unlike `clear()`/`ESC[2J`/`ESC[3J`, which correctly dispose it. Marker
 *     liveness alone is not identity -- this is why `verify()` re-reads
 *     content at the marker's current line rather than trusting disposal
 *     state alone.
 *   - generation-mismatch (terminal replaced): measured that a marker
 *     survives `term.dispose()` untouched and will silently report content
 *     from an unrelated terminal instance that happens to occupy the same
 *     row index if nothing checks instance identity.
 */

function writeAsync(term: TerminalType, data: string): Promise<void> {
  return new Promise((resolve) => { term.write(data, () => resolve()); });
}

function makeTerm(overrides: ConstructorParameters<typeof TerminalType>[0] = {}): TerminalType {
  return new Terminal({ rows: 5, cols: 20, scrollback: 10, ...overrides });
}

async function findAbsoluteRow(term: TerminalType, needle: string): Promise<number> {
  for (let row = 0; row < term.buffer.active.length; row += 1) {
    const line = term.buffer.active.getLine(row);
    if (line && line.translateToString(true).includes(needle)) {
      return row;
    }
  }
  throw new Error(`row containing ${JSON.stringify(needle)} not found`);
}

function positionForRow(row: number, startX: number, endX: number) {
  return { start: { x: startX, y: row }, end: { x: endX, y: row } };
}

/**
 * Simulates "the live selection still points exactly where the marker says
 * the anchored content is" -- the position verifySelectionAnchor should see
 * when nothing has repointed the selection. Tests that are not specifically
 * about the reflow-repositioning check use this so they keep exercising only
 * what they exercised before that check existed.
 */
function atMarker(anchor: { startMarker: { line: number }; endMarker: { line: number }; startCol: number; endCol: number }) {
  return {
    start: { x: anchor.startCol, y: anchor.startMarker.line },
    end: { x: anchor.endCol, y: anchor.endMarker.line },
  };
}

test('verify() reports valid immediately after capture, for a live single-line selection', async () => {
  const term = makeTerm();
  await writeAsync(term, 'select-me-now\r\n');
  const row = await findAbsoluteRow(term, 'select-me-now');
  const anchor = captureSelectionAnchor(term, 1, positionForRow(row, 0, 13));
  assert.ok(anchor, 'anchor is captured for a real position');
  const verdict = verifySelectionAnchor(anchor!, term, 1, atMarker(anchor!));
  assert.deepEqual(verdict, { valid: true });
  disposeSelectionAnchor(anchor);
});

test('verify() rejects with markers-disposed once scrollback trims the anchored row off', async () => {
  const term = makeTerm();
  for (let i = 0; i < 5; i += 1) await writeAsync(term, `line${i}\r\n`);
  const row = await findAbsoluteRow(term, 'line2');
  const anchor = captureSelectionAnchor(term, 1, positionForRow(row, 0, 5));
  assert.ok(anchor);
  // Flood far past the scrollback capacity (rows=5 + scrollback=10 => 15) so
  // the anchored row is evicted, not merely scrolled within the buffer.
  for (let i = 5; i < 30; i += 1) await writeAsync(term, `line${i}\r\n`);
  const verdict = verifySelectionAnchor(anchor!, term, 1, atMarker(anchor!));
  assert.deepEqual(verdict, { valid: false, reason: 'markers-disposed' });
});

test('verify() stays valid across a resize that reflows (rewraps) OTHER rows, leaving the marked span untouched', async () => {
  const term = makeTerm();
  await writeAsync(term, 'a-very-long-line-that-will-wrap-across-multiple-columns-for-sure\r\n');
  await writeAsync(term, 'short-target\r\n');
  const row = await findAbsoluteRow(term, 'short-target');
  // 15 cols still holds the full 12-character marked span on one physical row,
  // while still being narrow enough to force the 65-character line above to
  // rewrap into more rows -- so this measures reflow elsewhere in the buffer
  // shifting the marker, not the marked span's own shape changing.
  const anchor = captureSelectionAnchor(term, 1, positionForRow(row, 0, 12));
  assert.ok(anchor);

  term.resize(15, 5); // narrower: forces the long line above to rewrap into more rows
  assert.deepEqual(
    verifySelectionAnchor(anchor!, term, 1, atMarker(anchor!)),
    { valid: true },
    'identity survives a narrowing reflow that does not touch the marked span itself',
  );

  term.resize(80, 5); // wider: unwraps the long line back
  assert.deepEqual(
    verifySelectionAnchor(anchor!, term, 1, atMarker(anchor!)),
    { valid: true },
    'identity survives a widening reflow back',
  );
  disposeSelectionAnchor(anchor);
});

test('verify() conservatively rejects when reflow itself splits the marked span across rows', async () => {
  // Documented limitation, not a bug: the boundary content re-check compares
  // fixed COLUMNS at the marker's row. If a resize makes the row too narrow
  // to hold the originally-selected column range on one physical row any
  // more, the columns that used to hold the selected text are not there any
  // more (they wrapped onto the next row) -- so content-mismatch is the
  // correct, safe-direction answer (reject when uncertain), not a failure of
  // reflow-survival. Reflow-survival of the MARKER (which row) is proven by
  // the test above; this is about the SELECTED SPAN's own shape.
  const term = makeTerm();
  await writeAsync(term, 'short-target\r\n');
  const row = await findAbsoluteRow(term, 'short-target');
  const anchor = captureSelectionAnchor(term, 1, positionForRow(row, 0, 12));
  assert.ok(anchor);

  term.resize(10, 5); // narrower than the 12-column selected span itself
  assert.deepEqual(
    verifySelectionAnchor(anchor!, term, 1, atMarker(anchor!)),
    { valid: false, reason: 'content-mismatch' },
    'a selection whose own span no longer fits the row is correctly treated as unverifiable, not silently trusted',
  );
  disposeSelectionAnchor(anchor);
});

test('verify() rejects with content-mismatch after term.reset(), even though the marker itself never disposes', async () => {
  const term = makeTerm();
  await writeAsync(term, 'row-to-be-reset\r\nsecond-line\r\n');
  const row = await findAbsoluteRow(term, 'row-to-be-reset');
  const anchor = captureSelectionAnchor(term, 1, positionForRow(row, 0, 15));
  assert.ok(anchor);

  term.reset();
  // Measured precondition this test depends on: reset() does NOT dispose the
  // marker. If this ever stops being true (xterm starts routing reset()
  // through the same onDelete/onTrim path clear()/ESC[2J already use), the
  // content-mismatch branch below would never be exercised and this
  // assertion is what would tell us so -- it is the discriminator, not
  // decoration.
  assert.equal(anchor!.startMarker.isDisposed, false, 'reset() leaves the marker looking undisposed');

  const verdict = verifySelectionAnchor(anchor!, term, 1, atMarker(anchor!));
  assert.deepEqual(verdict, { valid: false, reason: 'content-mismatch' });
});

test('verify() rejects with generation-mismatch when the terminal instance has been replaced', async () => {
  const termA = makeTerm();
  await writeAsync(termA, 'terminal-A-content\r\n');
  const row = await findAbsoluteRow(termA, 'terminal-A-content');
  const anchor = captureSelectionAnchor(termA, 1, positionForRow(row, 0, 19));
  assert.ok(anchor);
  termA.dispose();
  // Measured precondition: term.dispose() does not dispose markers either.
  assert.equal(anchor!.startMarker.isDisposed, false, 'dispose() leaves the marker looking undisposed');

  const termB = makeTerm();
  await writeAsync(termB, 'terminal-B-content\r\n');
  // Without a generation check, reading termB via the old marker's .line would
  // silently return termB's unrelated content at that row index -- the exact
  // "quietly copy something else" failure AC-3 forbids.
  const verdict = verifySelectionAnchor(anchor!, termB, 2, atMarker(anchor!));
  assert.deepEqual(verdict, { valid: false, reason: 'generation-mismatch' });
});

test('verify() rejects with content-mismatch when a full erase (ESC[2J) wipes the anchored line', async () => {
  const term = makeTerm();
  await writeAsync(term, 'row-a\r\nrow-b\r\nrow-c\r\n');
  const row = await findAbsoluteRow(term, 'row-a');
  const anchor = captureSelectionAnchor(term, 1, positionForRow(row, 0, 5));
  assert.ok(anchor);
  await writeAsync(term, '\x1b[2J');
  // ESC[2J is measured to dispose the marker outright (it routes through the
  // real onDelete path), so this is markers-disposed, not content-mismatch --
  // asserting the exact reason keeps this from degenerating into "verify()
  // returned some falsy thing", which would pass for the wrong cause too.
  assert.deepEqual(
    verifySelectionAnchor(anchor!, term, 1, atMarker(anchor!)),
    { valid: false, reason: 'markers-disposed' },
  );
});

test('disposeSelectionAnchor releases both markers and is safe to call twice', async () => {
  const term = makeTerm();
  await writeAsync(term, 'to-dispose\r\n');
  const row = await findAbsoluteRow(term, 'to-dispose');
  const anchor = captureSelectionAnchor(term, 1, positionForRow(row, 0, 10));
  assert.ok(anchor);
  disposeSelectionAnchor(anchor);
  assert.equal(anchor!.startMarker.isDisposed, true);
  assert.equal(anchor!.endMarker.isDisposed, true);
  assert.doesNotThrow(() => disposeSelectionAnchor(anchor));
  assert.doesNotThrow(() => disposeSelectionAnchor(null));
  assert.doesNotThrow(() => disposeSelectionAnchor(undefined));
});

test('a multi-row selection shares independent markers per boundary, and eviction of only one end is enough to invalidate', async () => {
  const term = makeTerm({ scrollback: 30 });
  await writeAsync(term, 'top-row\r\n');
  const startRow = await findAbsoluteRow(term, 'top-row');
  for (let i = 0; i < 3; i += 1) await writeAsync(term, `mid${i}\r\n`);
  await writeAsync(term, 'bottom-row\r\n');
  const endRow = await findAbsoluteRow(term, 'bottom-row');
  const anchor = captureSelectionAnchor(term, 1, {
    start: { x: 0, y: startRow },
    end: { x: 10, y: endRow },
  });
  assert.ok(anchor);
  assert.deepEqual(verifySelectionAnchor(anchor!, term, 1, atMarker(anchor!)), { valid: true });

  // Flood enough to evict only the earlier (top) row, not the later (bottom) one.
  for (let i = 0; i < 40; i += 1) await writeAsync(term, `flood${i}\r\n`);
  assert.deepEqual(
    verifySelectionAnchor(anchor!, term, 1, atMarker(anchor!)),
    { valid: false, reason: 'markers-disposed' },
    'losing either boundary is enough to invalidate the whole anchor',
  );
});

// ---------------------------------------------------------------------------
// A REAL LIVE SELECTION, not a synthetic position -- against a real, opened
// (jsdom-hosted) Terminal. The tests above pass a `SelectionAnchorPosition`
// directly, which is faithful to what captureSelectionAnchor's own contract
// takes, but it cannot exercise the gap the goldens lane found in
// tests/unit/terminalSelectionLifecycleCharacterization.test.ts: a column
// resize that reflows repoints xterm's OWN selection (same start/end
// coordinates, different underlying content) while the marker this module
// registers correctly follows the content to its new row. Verifying only the
// marker's own bookkeeping cannot see that divergence -- it has to compare
// against what the LIVE SELECTION now reports.
// ---------------------------------------------------------------------------
installJsdomEnvironment();

const liveRequire = createRequire(import.meta.url);
const liveXtermNamespace = liveRequire('@xterm/xterm') as unknown as {
  Terminal?: typeof TerminalType;
  default?: { Terminal?: typeof TerminalType };
};
const LiveTerminal = liveXtermNamespace.Terminal ?? liveXtermNamespace.default?.Terminal;
assert.ok(LiveTerminal, '@xterm/xterm must expose Terminal directly or on its default export');

function createHost(): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  return host;
}

const WRAPPING_LINE = 'A'.repeat(30);
const TARGET_LINE = 'TARGETTARGETTARGET';
const TRAILING_LINE = 'C'.repeat(30);

async function seedAndSelectTargetLive(term: TerminalType): Promise<number> {
  await writeAsync(term as unknown as TerminalType, `${WRAPPING_LINE}\r\n${TARGET_LINE}\r\n${TRAILING_LINE}\r\n`);
  let row = -1;
  for (let y = 0; y < term.buffer.active.length; y += 1) {
    if ((term.buffer.active.getLine(y)?.translateToString(true) ?? '').startsWith('TARGET')) {
      row = y;
      break;
    }
  }
  assert.notEqual(row, -1, 'the seeded TARGET line must be locatable before selecting it');
  (term as unknown as { select: (x: number, y: number, len: number) => void }).select(0, row, TARGET_LINE.length);
  assert.equal(term.getSelection(), TARGET_LINE, 'precondition: selection starts out holding TARGET_LINE');
  return row;
}

test('REFLOW HOLE, CLOSED: a widening reflow repoints the live selection, and verify() now catches it', async () => {
  const term = new LiveTerminal!({ cols: 20, rows: 8, scrollback: 100 });
  term.open(createHost());
  try {
    await seedAndSelectTargetLive(term);
    const positionBefore = term.getSelectionPosition();
    assert.ok(positionBefore);

    const anchor = captureSelectionAnchor(term, 1, positionBefore!);
    assert.ok(anchor, 'a real live selection must produce a real anchor');

    term.resize(40, 8); // widen: unwraps the AAAA... line above TARGET, shifting rows below up by one

    const positionAfter = term.getSelectionPosition();
    const liveTextAfter = term.getSelection();
    // This is the measured finding (goldens lane,
    // terminalSelectionLifecycleCharacterization.test.ts), restated as the
    // precondition of this test: coordinates are untouched, but the content
    // underneath is not TARGET_LINE any more.
    assert.deepEqual(positionAfter, positionBefore, 'xterm pins the selection to the same coordinates through reflow');
    assert.notEqual(liveTextAfter, TARGET_LINE, 'the content at those pinned coordinates is now a different line');

    // The marker, unlike the selection, DID move -- it is still measured to
    // correctly track TARGET_LINE's new row. That is not the bug; it is what
    // made the original bug possible to miss (the anchor's OWN bookkeeping
    // looked perfectly fine).
    assert.notEqual(anchor!.startMarker.line, positionAfter!.start.y, 'the marker followed the content; the selection did not');

    // THE FIX: verify() is given the LIVE selection's current position
    // (positionAfter, still pinned to the pre-reflow coordinates) and checks
    // it against where the marker says the anchored content actually is now.
    // They disagree, which is exactly what should invalidate the anchor --
    // a copy right now would read the selection's stale coordinates, not the
    // marker's, and would return the wrong text if this check did not exist.
    const verdict = verifySelectionAnchor(anchor!, term, 1, positionAfter);
    assert.deepEqual(
      verdict,
      { valid: false, reason: 'selection-repositioned' },
      'a live selection that no longer aligns with the marker must be rejected, not silently trusted '
        + `(a copy right now would write ${JSON.stringify(liveTextAfter)}, not the originally selected `
        + `${JSON.stringify(TARGET_LINE)})`,
    );
    disposeSelectionAnchor(anchor);
  } finally {
    term.dispose();
  }
});

test('REFLOW, control: verify() stays valid when the live selection position still matches the marker', async () => {
  const term = new LiveTerminal!({ cols: 20, rows: 8, scrollback: 100 });
  term.open(createHost());
  try {
    await seedAndSelectTargetLive(term);
    const position = term.getSelectionPosition();
    assert.ok(position);
    const anchor = captureSelectionAnchor(term, 1, position!);
    assert.ok(anchor);

    // No reflow happens here, so the live selection position still equals
    // what was captured -- this is the boundary control for the test above,
    // so that a bug in the position check itself (e.g. always rejecting)
    // would be caught rather than passing vacuously.
    assert.deepEqual(
      verifySelectionAnchor(anchor!, term, 1, term.getSelectionPosition()),
      { valid: true },
    );
    disposeSelectionAnchor(anchor);
  } finally {
    term.dispose();
  }
});

test('verify() rejects with no-live-selection when the selection is gone entirely', async () => {
  const term = new LiveTerminal!({ cols: 20, rows: 8, scrollback: 100 });
  term.open(createHost());
  try {
    await seedAndSelectTargetLive(term);
    const position = term.getSelectionPosition();
    assert.ok(position);
    const anchor = captureSelectionAnchor(term, 1, position!);
    assert.ok(anchor);

    assert.deepEqual(
      verifySelectionAnchor(anchor!, term, 1, undefined),
      { valid: false, reason: 'no-live-selection' },
    );
    disposeSelectionAnchor(anchor);
  } finally {
    term.dispose();
  }
});
