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
 * `resourceLimits.terminal.visibleOutputQueueMaxBytes`, which is the value the
 * browser coordinator enforces as its effective `checkpointMaxBytes`
 * (`terminalWriteCoordinator.ts` derives `checkpointMaxBytes` from
 * `postCheckpointMaxBytes`, and `TerminalView` only ever passes
 * `postCheckpointMaxBytes: limits.visibleOutputQueueMaxBytes`).
 *
 * These tests CHARACTERIZE the defect: they pass today because the defect is
 * present. When a mint-time admission check lands they must be revisited
 * together — the size facts stay true, but the "server mints what the browser
 * must reject" conclusion is what the fix removes.
 *
 * The adapter's `encodedByteTotal` is exactly
 * `Buffer.byteLength(checkpoint.serializedData, 'utf8')`, so the sampled byte
 * counts below are exact. Only the retained-line projection is extrapolated;
 * a full-scrollback run at 124 and 400 columns matched the projection to
 * within 0.07% (see
 * `docs/analysis/2026-09-16.issue26-checkpoint-mint-size/`).
 */

const SAMPLE_LINES = 600;

/**
 * Coding-agent-shaped output: SGR attribute runs, as produced by syntax
 * highlighting, coloured diffs and progress lines. This is BuilderGate's
 * primary workload.
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

/** The predicate the browser coordinator applies to a `checkpoint-begin`. */
function browserWouldReject(encodedByteTotal: number, parserTailBytes: number, checkpointMaxBytes: number): boolean {
  return encodedByteTotal + parserTailBytes > checkpointMaxBytes;
}

test('the mint path never truncates: the retained checkpoint type forbids it', async () => {
  const state = createHeadlessTerminalState({ cols: 80, rows: 30, scrollbackLines: 200 });
  try {
    await writeHeadlessTerminal(state, agentLikeLine(80, 1));
    const checkpoint = serializeRetainedHeadlessCheckpoint(state);
    // `truncated` is typed as the literal `false`. The compatibility
    // serializer takes a `maxSnapshotBytes` budget and can return
    // `truncated: true`; the retained path deliberately cannot. That
    // asymmetry is why no size-shedding remedy is available at mint without
    // breaking MIG-BGSTAB-002 AC-4 (the configured retained range must be
    // recoverable).
    assert.equal(checkpoint.truncated, false);
  } finally {
    disposeHeadlessTerminal(state);
  }
});

test('issue #26: at default limits a >=200 column session mints a checkpoint the browser must reject', async () => {
  const limits = terminalResourceLimitsSchema.parse({});
  const checkpointMaxBytes = limits.visibleOutputQueueMaxBytes;
  const scrollbackLines = limits.scrollbackLines;

  assert.equal(checkpointMaxBytes, 4 * 1024 * 1024, 'default visibleOutputQueueMaxBytes moved; re-measure issue #26');
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

test('issue #26: 80 columns still fits, so the defect is width-driven rather than universal', async () => {
  const limits = terminalResourceLimitsSchema.parse({});
  const bytesPerLine = await measureBytesPerRetainedLine(80, limits.scrollbackLines);
  const projectedEncodedByteTotal = Math.round(bytesPerLine * limits.scrollbackLines);

  assert.equal(
    browserWouldReject(projectedEncodedByteTotal, 0, limits.visibleOutputQueueMaxBytes),
    false,
    `issue #26: 80 columns projects to ${projectedEncodedByteTotal} bytes and is expected to stay inside the budget. `
    + 'A failure here means the headroom eroded further and the defect widened.',
  );
});
