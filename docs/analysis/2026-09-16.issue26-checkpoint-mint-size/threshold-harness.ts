/*
 * HOW TO RUN
 *   cp docs/analysis/2026-09-16.issue26-checkpoint-mint-size/threshold-harness.ts \
 *      server/src/issue26.tmp.ts
 *   cd server && npx tsx src/issue26.tmp.ts
 *   rm server/src/issue26.tmp.ts        # do not leave it in tsc input
 *
 * It lives here rather than under server/src because any .ts under
 * server/src is compiled into dist by the build.
 */
/**
 * Issue #26 — column threshold and SGR-vs-width isolation.
 *
 * Measures bytes/cell on a 1,500-line sample with the production retained
 * checkpoint serializer, then projects the full retained scrollback at the
 * configured scrollbackLines. encodedByteTotal is EXACTLY
 * Buffer.byteLength(checkpoint.serializedData, 'utf8')
 * (TerminalAuthorityProductionAdapter.ts:1660-1666, :888-906), so the sample
 * measurement is exact; only the line-count projection is extrapolated.
 */
import {
  createHeadlessTerminalState,
  writeHeadlessTerminal,
  serializeRetainedHeadlessCheckpoint,
} from './utils/headlessTerminal.js';

const LIMIT = 4 * 1024 * 1024;       // resourceLimits.terminal.visibleOutputQueueMaxBytes default
const SCROLLBACK_DEFAULT = 10000;    // resourceLimits.terminal.scrollbackLines default
const SCROLLBACK_MAX = 50000;        // resourceLimits.terminal.scrollbackLines schema max
const SAMPLE = 1500;

const agentLike = (cols: number, n: number): string => {
  const colors = [31, 32, 33, 34, 35, 36, 91, 92, 93, 94, 96];
  let s = `\x1b[90m${String(n).padStart(6, '0')}\x1b[0m `;
  let w = 7;
  let i = 0;
  while (w < cols - 12) {
    const c = colors[(n + i) % colors.length];
    const tok = ['const', 'return', 'function', 'await', 'value', 'result', '=>', '{', '}', 'true'][(n * 3 + i) % 10];
    s += `\x1b[${c}m${tok}\x1b[0m `;
    w += tok.length + 1;
    i += 1;
  }
  return s + '\r\n';
};

// Zero SGR control: identical glyph volume, no colour at all.
const plain = (cols: number, n: number): string => {
  let s = `${String(n).padStart(6, '0')} `;
  let w = 7;
  let i = 0;
  while (w < cols - 12) {
    const tok = ['const', 'return', 'function', 'await', 'value', 'result', '=>', '{', '}', 'true'][(n * 3 + i) % 10];
    s += `${tok} `;
    w += tok.length + 1;
    i += 1;
  }
  return s + '\r\n';
};

async function sample(label: string, cols: number, gen: (c: number, n: number) => string) {
  const state = createHeadlessTerminalState({ cols, rows: 30, scrollbackLines: SCROLLBACK_DEFAULT });
  const BATCH = 250;
  for (let start = 0; start < SAMPLE; start += BATCH) {
    let chunk = '';
    for (let n = start; n < Math.min(SAMPLE, start + BATCH); n += 1) chunk += gen(cols, n);
    await writeHeadlessTerminal(state, chunk);
  }
  const cp = serializeRetainedHeadlessCheckpoint(state);
  const bytes = Buffer.byteLength(cp.serializedData, 'utf8');
  const lines = state.terminal.buffer.normal.length;
  const perLine = bytes / lines;
  console.log(JSON.stringify({
    label, cols,
    sampleLines: lines,
    sampleBytes: bytes,
    bytesPerLine: +perLine.toFixed(2),
    bytesPerCell: +(bytes / (lines * cols)).toFixed(3),
    projectedAtDefaultScrollback: Math.round(perLine * SCROLLBACK_DEFAULT),
    projectedPctOf4MiB: +((perLine * SCROLLBACK_DEFAULT / LIMIT) * 100).toFixed(1),
    exceedsAtDefaultScrollback: perLine * SCROLLBACK_DEFAULT > LIMIT,
    projectedAtMaxScrollback: Math.round(perLine * SCROLLBACK_MAX),
    exceedsAtMaxScrollback: perLine * SCROLLBACK_MAX > LIMIT,
    // Retained lines at which this width/density first crosses the 4 MiB budget.
    linesToCross4MiB: Math.ceil(LIMIT / perLine),
  }));
  state.terminal.dispose();
}

(async () => {
  console.log(JSON.stringify({ node: process.version, measuredAt: new Date().toISOString(), sampleLines: SAMPLE }));
  for (const cols of [80, 124, 160, 200, 240, 320, 400]) {
    await sample(`agentlike-${cols}col`, cols, agentLike);
  }
  for (const cols of [80, 200, 400]) {
    await sample(`plain-nosgr-${cols}col`, cols, plain);
  }
})().catch((e) => { console.error(e); process.exit(1); });
