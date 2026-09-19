import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createHeadlessTerminalState,
  serializeHeadlessTerminal,
  writeHeadlessTerminal,
} from './headlessTerminal.js';

/**
 * REL-BGSTAB-007 AC-3: after a server-surviving refresh the authoritative retained range
 * must be restored. The reload path serves `getAtomicRestoreSnapshot`, which calls
 * `serializeHeadlessTerminal` -- and that defaults to `VIEWPORT_ONLY_SERIALIZE_OPTIONS`
 * (`{ scrollback: 0 }`). Measured across five rounds: a 700-line producer reloads to 28
 * lines, one viewport, under both legacy and server authority. The full-scrollback
 * serializer exists (`serializeRetainedHeadlessCheckpoint`) and nothing on the reload path
 * calls it.
 *
 * AC-6 constrains how this is fixed. Over `maxSnapshotBytes`, `serializeHeadlessTerminal`
 * returns `data: ''` with `truncated: true` -- an EMPTY payload reported as a success -- and
 * AC-6 bars using that cap as "retained history를 empty로 만드는 authority cap". So simply
 * widening the scrollback would turn a 28-line reload into a BLANK one at scale: a worse
 * defect than the one being fixed, produced by the requirement's own prohibited move.
 */

const COLS = 40;
const ROWS = 6;

async function terminalWith(lineCount: number, scrollbackLines: number) {
  const state = createHeadlessTerminalState({ cols: COLS, rows: ROWS, scrollbackLines });
  // writeHeadlessTerminal is async -- xterm settles the write through a callback. Writing
  // without awaiting leaves an empty buffer, which reads as "the retained range is missing"
  // and would have been mistaken for the defect under test.
  for (let index = 1; index <= lineCount; index += 1) {
    await writeHeadlessTerminal(state, `AC3-${index}\r\n`);
  }
  return state;
}

test('AC-3: the retained range is serialisable, and the viewport-only default omits it', async () => {
  const state = await terminalWith(60, 1_000);

  const viewportOnly = serializeHeadlessTerminal(state, 10_000_000);
  assert.equal(
    viewportOnly.data.includes('AC3-1\r\n') || viewportOnly.data.includes('AC3-1\n'),
    false,
    'precondition: the default serialisation is viewport-only, so the oldest line is absent',
  );

  const retained = serializeHeadlessTerminal(state, 10_000_000, { scrollback: 1_000 });
  assert.equal(
    retained.truncated,
    false,
    'the retained serialisation must not report truncation when it fits',
  );
  assert.match(
    retained.data,
    /AC3-1\b/u,
    'the retained serialisation must carry the oldest line in the retained range',
  );
});

/**
 * The AC-6 trap, asserted directly. This is the behaviour that makes the obvious
 * implementation unsafe, and it is asserted here so that anyone widening the reload
 * serialisation meets it as a failing test rather than as a blank terminal in production.
 */
test('AC-6: exceeding the byte cap empties the payload rather than reducing it', async () => {
  const state = await terminalWith(200, 1_000);
  const full = serializeHeadlessTerminal(state, 10_000_000, { scrollback: 1_000 });
  assert.ok(full.data.length > 0, 'precondition: the retained payload is non-empty when it fits');

  const capped = serializeHeadlessTerminal(state, full.data.length - 1, { scrollback: 1_000 });
  assert.equal(capped.truncated, true, 'over the cap the result reports truncation');
  assert.equal(
    capped.data,
    '',
    'AC-6 hazard: over the cap the payload is EMPTY, not reduced -- a valid model reported '
    + 'as an empty success. Any reload path widened to carry the retained range must handle '
    + 'this rather than pass the cap through, or a large scrollback reloads to a blank screen',
  );
});
