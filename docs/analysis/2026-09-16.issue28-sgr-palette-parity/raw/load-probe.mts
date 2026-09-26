// Issue #28 second observation, load-separated.
// Drives 13,000 SGR-dense lines through the retained headless model plus the
// shadow comparer round trip, in a quiet machine (node process count and load
// recorded separately), and reports wall time and peak RSS.
import {
  createHeadlessTerminalState, writeHeadlessTerminal, disposeHeadlessTerminal,
  serializeRetainedHeadlessCheckpoint, compareRetainedHeadlessCheckpointRoundTrip,
} from '../../../../server/src/utils/headlessTerminal.ts';

const ESC = String.fromCharCode(27);
const LINES = 13_000;
const SCROLLBACK = 1000;
const state = createHeadlessTerminalState({ cols: 200, rows: 40, scrollbackLines: SCROLLBACK });
const started = Date.now();
let peakRss = 0;
let comparisons = 0;
let mismatches = 0;

try {
  for (let line = 0; line < LINES; line += 1) {
    const body = `${ESC}[3${line % 8}m${ESC}[1m${String(line).padStart(6, '0')}${ESC}[0m `
      + `${ESC}[38;5;${line % 256}m${'tok '.repeat(20)}${ESC}[0m`
      + `${ESC}[48;5;${line % 16}m bg ${ESC}[0m${ESC}[4mund${ESC}[24m\r\n`;
    await writeHeadlessTerminal(state, body);
    if (line % 500 === 0) {
      const checkpoint = { ...serializeRetainedHeadlessCheckpoint(state), pendingEscapeTailAnsi: '' };
      const comparison = await compareRetainedHeadlessCheckpointRoundTrip(
        checkpoint as never, { scrollbackLines: SCROLLBACK },
      );
      comparisons += 1;
      if (comparison.axes.cells !== 'match') mismatches += 1;
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
      process.stdout.write(
        `line=${line} t=${((Date.now() - started) / 1000).toFixed(1)}s `
        + `rss=${(process.memoryUsage().rss / 1024 / 1024).toFixed(0)}MB cells=${comparison.axes.cells}\n`,
      );
    }
  }
} finally {
  disposeHeadlessTerminal(state);
}

console.log(JSON.stringify({
  lines: LINES,
  wallSeconds: (Date.now() - started) / 1000,
  peakRssMb: Math.round(peakRss / 1024 / 1024),
  comparisons,
  cellsMismatches: mismatches,
  survived: true,
}));
