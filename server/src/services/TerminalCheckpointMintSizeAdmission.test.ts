import assert from 'node:assert/strict';
import test from 'node:test';

import { terminalResourceLimitsSchema } from '../schemas/config.schema.js';
import {
  createHeadlessTerminalState,
  disposeHeadlessTerminal,
  serializeRetainedHeadlessCheckpoint,
  writeHeadlessTerminal,
} from '../utils/headlessTerminal.js';

/**
 * GitHub issue #26 — the retained checkpoint is minted without ever asking
 * whether the browser can admit it.
 *
 * `serializeRetainedHeadlessCheckpoint` serializes the whole retained
 * scrollback (`headlessTerminal.ts`, `serializeAddon.serialize()` with no
 * argument) and `TerminalAuthorityProductionAdapter` chunks the result at a
 * fixed 64 KiB with no size adaptation. Neither consults
 * `resourceLimits.terminal.checkpointMaxBytes`, which is the budget the browser
 * coordinator enforces on a `checkpoint-begin` (`TerminalView` passes
 * `checkpointMaxBytes: coordinatorLimits.checkpointMaxBytes` explicitly, so the
 * coordinator's `options.checkpointMaxBytes ?? postCheckpointMaxBytes` fallback
 * is not what production resolves to). The server mint path consults no
 * admission budget at all — that is the defect characterized here.
 *
 * These tests CHARACTERIZE the defect: they pass today because the defect is
 * present. When a mint-time admission check lands they must be revisited
 * together — the size facts stay true, but the "server mints what the browser
 * must reject" conclusion is what the fix removes.
 *
 * No suite runs this file. `server/package.json` exposes it as
 * `npm run test:checkpoint-mint-size`, following the single-file convention of
 * `test:authority-pin` and `test:retired-settings-residue`; the monolithic
 * runner does not discover `*.test.ts` at all.
 *
 * The adapter's `encodedByteTotal` is exactly
 * `Buffer.byteLength(checkpoint.serializedData, 'utf8')`, so the sampled byte
 * counts below are exact. Only the retained-line projection is extrapolated.
 * `SAMPLE_LINES` is deliberately 1500 — the size the projection was validated
 * at. Full-scrollback runs at 124, 200 and 400 columns all show the 1500-line
 * sample underestimating bytes-per-line by the same 0.0567%, so the projection
 * is biased LOW by a known, constant amount. That bias would matter on a thin
 * margin; the 200-column case below clears the budget by ~22%, so it does not
 * matter here, and the crossover itself is measured directly rather than
 * projected (see `docs/analysis/2026-09-16.issue26-checkpoint-mint-size/`).
 */

const SAMPLE_LINES = 1500;

/**
 * Coding-agent-shaped output at PER-TOKEN SGR density: every token carries its
 * own colour and reset, which is how a syntax highlighter or a coloured diff
 * actually emits. That density is a precondition of the size result below, not
 * an incidental detail — the same glyph volume at eight attribute runs per line
 * reaches only 64% of the budget at 200 columns, and with no SGR at all only
 * 46% (`docs/analysis/2026-09-16.issue26-checkpoint-mint-size/raw/density-*.jsonl`).
 */
function agentLikeLine(cols: number, lineNumber: number): string {
  const colors = [31, 32, 33, 34, 35, 36, 91, 92, 93, 94, 96];
  const tokens = ['const', 'return', 'function', 'await', 'value', 'result', '=>', '{', '}', 'true'];
  let line = `\x1b[90m${String(lineNumber).padStart(6, '0')}\x1b[0m `;
  let width = 7;
  let index = 0;
  while (width < cols - 12) {
    const color = colors[(lineNumber + index) % colors.length];
    const token = tokens[(lineNumber * 3 + index) % tokens.length];
    line += `\x1b[${color}m${token}\x1b[0m `;
    width += token.length + 1;
    index += 1;
  }
  return `${line}\r\n`;
}

async function measureBytesPerRetainedLine(cols: number, scrollbackLines: number): Promise<number> {
  const state = createHeadlessTerminalState({ cols, rows: 30, scrollbackLines });
  try {
    const batchSize = 200;
    for (let start = 0; start < SAMPLE_LINES; start += batchSize) {
      let batch = '';
      for (let line = start; line < Math.min(SAMPLE_LINES, start + batchSize); line += 1) {
        batch += agentLikeLine(cols, line);
      }
      await writeHeadlessTerminal(state, batch);
    }
    const checkpoint = serializeRetainedHeadlessCheckpoint(state);
    const bytes = Buffer.byteLength(checkpoint.serializedData, 'utf8');
    return bytes / state.terminal.buffer.normal.length;
  } finally {
    disposeHeadlessTerminal(state);
  }
}

/**
 * A HAND-COPY of the comparison the browser coordinator applies to a
 * `checkpoint-begin` (`frontend/src/utils/terminalWriteCoordinator.ts`). The
 * real predicate is not exported and lives in the frontend package, so this
 * server-side test cannot execute it. Nothing here covers the plumbing that
 * carries `resourceLimits.terminal.checkpointMaxBytes` from runtime config into
 * the coordinator — a change to that chain, to the comparison operator, or to
 * the `parserTail` term leaves these cases green while invalidating their
 * conclusion. Treat the browser side as asserted by arithmetic, not exercised.
 * (`frontend/tests/unit/terminalCheckpointBudgetSeparation.test.ts` pins the
 * plumbing half.)
 */
function browserWouldReject(encodedByteTotal: number, parserTailBytes: number, checkpointMaxBytes: number): boolean {
  return encodedByteTotal + parserTailBytes > checkpointMaxBytes;
}

test('the retained checkpoint declares truncated:false as a literal type', async () => {
  const state = createHeadlessTerminalState({ cols: 80, rows: 30, scrollbackLines: 200 });
  try {
    await writeHeadlessTerminal(state, agentLikeLine(80, 1));
    const checkpoint = serializeRetainedHeadlessCheckpoint(state);
    // This pins the type declaration, not a threshold behaviour: `truncated`
    // is a hardcoded literal in `serializeRetainedHeadlessCheckpoint`, so an
    // implementation that DID shed scrollback above some size would still pass
    // this case. The declaration is what matters here — the compatibility
    // serializer takes a `maxSnapshotBytes` budget and can return
    // `truncated: true`, and the retained path deliberately cannot. That
    // asymmetry is why no size-shedding remedy is available at mint without
    // breaking MIG-BGSTAB-002 AC-4 (the configured retained range must be
    // recoverable).
    assert.equal(checkpoint.truncated, false);
  } finally {
    disposeHeadlessTerminal(state);
  }
});

test('issue #26: at default limits, per-token SGR at >=200 columns mints a checkpoint the browser must reject', async () => {
  const limits = terminalResourceLimitsSchema.parse({});
  const checkpointMaxBytes = limits.checkpointMaxBytes;
  const scrollbackLines = limits.scrollbackLines;

  // The issue #26 measurement was taken while `checkpointMaxBytes` and
  // `visibleOutputQueueMaxBytes` both defaulted to 4 MiB. Nothing in the
  // measurement distinguishes them, so if EITHER default moves the measurement
  // must be re-taken rather than reinterpreted against the survivor.
  assert.equal(checkpointMaxBytes, 4 * 1024 * 1024, 'default checkpointMaxBytes moved; re-measure issue #26');
  assert.equal(
    limits.visibleOutputQueueMaxBytes,
    4 * 1024 * 1024,
    'default visibleOutputQueueMaxBytes moved; the issue #26 measurement assumed it coincides with '
    + 'checkpointMaxBytes — re-measure issue #26',
  );
  assert.equal(scrollbackLines, 10000, 'default scrollbackLines moved; re-measure issue #26');

  const cols = 200;
  const bytesPerLine = await measureBytesPerRetainedLine(cols, scrollbackLines);
  const projectedEncodedByteTotal = Math.round(bytesPerLine * scrollbackLines);

  assert.equal(
    browserWouldReject(projectedEncodedByteTotal, 0, checkpointMaxBytes),
    true,
    `issue #26: a full ${cols}-column scrollback projects to ${projectedEncodedByteTotal} bytes, over the `
    + `${checkpointMaxBytes}-byte browser admission budget, yet nothing at mint time consults that budget. `
    + 'If this assertion fails the defect may have been fixed or the density changed — re-measure before editing.',
  );
});

test('issue #26: the same per-token density at 80 columns still fits', async () => {
  const limits = terminalResourceLimitsSchema.parse({});
  const bytesPerLine = await measureBytesPerRetainedLine(80, limits.scrollbackLines);
  const projectedEncodedByteTotal = Math.round(bytesPerLine * limits.scrollbackLines);

  assert.equal(
    browserWouldReject(projectedEncodedByteTotal, 0, limits.checkpointMaxBytes),
    false,
    `issue #26: 80 columns projects to ${projectedEncodedByteTotal} bytes and is expected to stay inside the budget. `
    + 'A failure here means the headroom eroded further and the defect widened.',
  );
});
