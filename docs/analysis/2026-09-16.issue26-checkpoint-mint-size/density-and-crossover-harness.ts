/*
 * HOW TO RUN
 *   cp docs/analysis/2026-09-16.issue26-checkpoint-mint-size/density-and-crossover-harness.ts \
 *      server/src/issue26.tmp.ts
 *   cd server && npx tsx src/issue26.tmp.ts [--direct=<cols>[,<cols>...]]
 *   rm server/src/issue26.tmp.ts        # do not leave it in tsc input
 *
 * It lives here rather than under server/src because any .ts under server/src is
 * compiled into dist by the build, and is also swept by the resource-consumer
 * completeness check in TerminalResourcePolicyInventory.ts. Running it from
 * outside server/src is not an option: `@xterm/addon-serialize` then resolves to a
 * different interop shape and headlessTerminal.ts:12 throws
 *   TypeError: Cannot destructure property 'SerializeAddon' of
 *   'import_addon_serialize.default' as it is undefined
 *
 * Produces, at HEAD 2026-09-16:
 *   raw/density-*.jsonl   — 1500-line sampled sweep (default mode)
 *   raw/direct*-*.jsonl   — full-scrollback direct measurement (--direct=…)
 *
 * Reported bytes are the utf8 byte length of checkpoint.serializedData. This is
 * EXACT, not an approximation: the adapter computes encodedByteTotal as the sum
 * of raw (pre-base64) chunk lengths over the same string —
 * TerminalAuthorityProductionAdapter.ts:1660-1666 and :888-906.
 */
import {
  createHeadlessTerminalState, writeHeadlessTerminal, serializeRetainedHeadlessCheckpoint,
} from './utils/headlessTerminal.js';

const LIMIT = 4 * 1024 * 1024;   // resourceLimits.terminal.visibleOutputQueueMaxBytes default
const SCROLLBACK = 10000;        // resourceLimits.terminal.scrollbackLines default
const SAMPLE = 1500;
const TOKENS = ['const', 'return', 'function', 'await', 'value', 'result', '=>', '{', '}', 'true'];
const COLORS = [31, 32, 33, 34, 35, 36, 91, 92, 93, 94, 96];

/** runsPerLine = SGR attribute changes per line. 0 = no SGR. -1 = one per token. */
function make(runsPerLine: number) {
  return (cols: number, n: number): string => {
    const body: string[] = [];
    let width = 7;
    let i = 0;
    while (width < cols - 12) {
      const tok = TOKENS[(n * 3 + i) % TOKENS.length];
      body.push(tok);
      width += tok.length + 1;
      i += 1;
    }
    if (runsPerLine === 0) return `${String(n).padStart(6, '0')} ${body.join(' ')}\r\n`;
    let out = `\x1b[90m${String(n).padStart(6, '0')}\x1b[0m `;
    if (runsPerLine < 0) {
      body.forEach((tok, g) => { out += `\x1b[${COLORS[(n + g) % COLORS.length]}m${tok}\x1b[0m `; });
      return `${out}\r\n`;
    }
    const per = Math.max(1, Math.ceil(body.length / runsPerLine));
    for (let g = 0; g < body.length; g += per) {
      out += `\x1b[${COLORS[(n + g) % COLORS.length]}m${body.slice(g, g + per).join(' ')}\x1b[0m `;
    }
    return `${out}\r\n`;
  };
}

async function fill(cols: number, lines: number, gen: (c: number, n: number) => string) {
  const state = createHeadlessTerminalState({ cols, rows: 30, scrollbackLines: SCROLLBACK });
  for (let start = 0; start < lines; start += 250) {
    let batch = '';
    for (let n = start; n < Math.min(lines, start + 250); n += 1) batch += gen(cols, n);
    await writeHeadlessTerminal(state, batch);
  }
  const bytes = Buffer.byteLength(serializeRetainedHeadlessCheckpoint(state).serializedData, 'utf8');
  const retained = state.terminal.buffer.normal.length;
  state.terminal.dispose();
  return { bytes, retained };
}

async function sample(label: string, cols: number, runs: number) {
  const { bytes, retained } = await fill(cols, SAMPLE, make(runs));
  const perLine = bytes / retained;
  console.log(JSON.stringify({
    label, cols, runsPerLine: runs, sampleLines: retained, sampleBytes: bytes,
    bytesPerLine: +perLine.toFixed(2), bytesPerCell: +(bytes / (retained * cols)).toFixed(3),
    projectedAtDefaultScrollback: Math.round(perLine * SCROLLBACK),
    projectedPctOf4MiB: +((perLine * SCROLLBACK / LIMIT) * 100).toFixed(1),
    exceedsAtDefaultScrollback: perLine * SCROLLBACK > LIMIT,
  }));
}

async function direct(cols: number) {
  const { bytes, retained } = await fill(cols, SCROLLBACK, make(-1));
  console.log(JSON.stringify({
    label: `direct-${cols}col-10k`, cols, scrollbackLines: SCROLLBACK, retainedLines: retained,
    bytes, mib: +(bytes / 1048576).toFixed(3), pctOf4MiB: +((bytes / LIMIT) * 100).toFixed(2),
    chunks64k: Math.ceil(bytes / 65536), exceeds4MiB: bytes > LIMIT,
    measuredAt: new Date().toISOString(),
  }));
}

(async () => {
  const arg = process.argv.find(a => a.startsWith('--direct='));
  console.log(JSON.stringify({ node: process.version, measuredAt: new Date().toISOString(), mode: arg ? 'direct' : 'sampled-sweep' }));
  if (arg) {
    for (const c of arg.slice('--direct='.length).split(',')) await direct(Number(c));
    return;
  }
  for (const cols of [200, 400]) for (const runs of [0, 1, 2, 4, 8, -1]) await sample(`runs${runs < 0 ? '-per-token' : runs}-${cols}col`, cols, runs);
  for (const cols of [160, 164, 166, 168, 172]) await sample(`runs-per-token-${cols}col`, cols, -1);
})().catch((e) => { console.error(e); process.exit(1); });
