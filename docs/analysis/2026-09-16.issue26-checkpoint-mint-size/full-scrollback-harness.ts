/*
 * HOW TO RUN
 *   cp docs/analysis/2026-09-16.issue26-checkpoint-mint-size/full-scrollback-harness.ts \
 *      server/src/issue26.tmp.ts
 *   cd server && npx tsx src/issue26.tmp.ts
 *   rm server/src/issue26.tmp.ts        # do not leave it in tsc input
 *
 * It lives here rather than under server/src because any .ts under
 * server/src is compiled into dist by the build.
 */
/**
 * Issue #26 extreme-condition checkpoint size measurement.
 * Uses the production retained-checkpoint serialization path
 * (server/src/utils/headlessTerminal.ts) — the same function
 * SessionManager mints from.
 *
 * Reported bytes are the utf8 byte length of checkpoint.serializedData.
 * This is EXACT, not an approximation: the adapter computes
 * encodedByteTotal as the sum of raw (pre-base64) chunk lengths over the
 * same string — TerminalAuthorityProductionAdapter.ts:1660-1666 and
 * :888-906.
 */
import {
  createHeadlessTerminalState,
  writeHeadlessTerminal,
  serializeRetainedHeadlessCheckpoint,
} from './utils/headlessTerminal.js';

const LIMIT = 4 * 1024 * 1024;

type Gen = (cols: number, lineNo: number) => string;

// Coding-agent-like output: SGR runs, syntax highlighting, diff markers.
const agentLike: Gen = (cols, n) => {
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

// Pathological: a distinct SGR colour on every single cell.
const gradient: Gen = (cols, n) => {
  let s = '';
  for (let i = 0; i < cols - 1; i += 1) {
    const c = 16 + ((n * 7 + i * 3) % 216);
    s += `\x1b[38;5;${c}m#`;
  }
  return s + '\x1b[0m\r\n';
};

async function run(label: string, cols: number, scrollbackLines: number, lines: number, gen: Gen) {
  const state = createHeadlessTerminalState({ cols, rows: 30, scrollbackLines });
  const BATCH = 500;
  for (let start = 0; start < lines; start += BATCH) {
    let chunk = '';
    for (let n = start; n < Math.min(lines, start + BATCH); n += 1) chunk += gen(cols, n);
    await writeHeadlessTerminal(state, chunk);
  }
  const cp = serializeRetainedHeadlessCheckpoint(state);
  const bytes = Buffer.byteLength(cp.serializedData, 'utf8');
  const retained = state.terminal.buffer.normal.length;
  const cells = retained * cols;
  console.log(JSON.stringify({
    label, cols, scrollbackLines, linesWritten: lines,
    retainedLines: retained,
    bytes,
    mib: +(bytes / 1048576).toFixed(3),
    pctOf4MiB: +((bytes / LIMIT) * 100).toFixed(1),
    bytesPerCell: +(bytes / cells).toFixed(3),
    chunks64k: Math.ceil(bytes / 65536),
    exceeds4MiB: bytes > LIMIT,
  }));
  state.terminal.dispose();
}

(async () => {
  console.log(JSON.stringify({ node: process.version, measuredAt: new Date().toISOString() }));
  await run('A-baseline-agentlike-124col-10k', 124, 10000, 10000, agentLike);
  await run('B-wide-400col-10k', 400, 10000, 10000, agentLike);
  await run('C-scrollback-50k-124col', 124, 50000, 50000, agentLike);
  await run('D-gradient-every-cell-124col-10k', 124, 10000, 10000, gradient);
  await run('E-gradient-wide-400col-10k', 400, 10000, 10000, gradient);
})().catch((e) => { console.error(e); process.exit(1); });
