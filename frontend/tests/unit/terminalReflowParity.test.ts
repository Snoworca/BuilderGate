import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

/**
 * Issue #114 — the successor to #16, which pinned the width policy and left the
 * asymmetry itself out of scope.
 *
 * `tests/unit/terminalWidthPolicyParity.test.ts` reads both sources as text and
 * says the two sides disagree about `reflowCursorLine`. It cannot say whether
 * that costs anything, because a source-text pin is a claim about two string
 * literals. `tests/unit/terminalUnicodeWidthGolden.test.ts` runs both engines
 * for real, but only writes and measures widths — it never resizes, and
 * `reflowCursorLine` does nothing until a resize.
 *
 * So this file runs both engines through the same byte stream, resizes them the
 * way a browser window resize resizes both the visible terminal and the server's
 * retained replica, and compares the buffers cell for cell.
 *
 * Why this matters rather than being tidiness: the server replica exists to
 * reproduce what the browser shows, so restore can hand it back. A divergence
 * is a defect in the replica by definition — the browser is what the user is
 * looking at. Measured 2026-09-20 with the pre-#114 settings (server true,
 * browser unset so false), resizing 40 -> 72 with the cursor on a wrapped
 * prompt line put the same text on different rows with the cursor two rows
 * apart. Committed history, where the cursor has moved off the wrapped line, is
 * unaffected — which is why this went unnoticed: it only shows up in the state a
 * live shell is normally in, a prompt with typed input and no newline yet.
 *
 * xterm's own documentation records the reason the default is false: "shells
 * usually handle this themselves". Both engines consume the output of one real
 * shell, so the setting that is right for the browser is right for the replica.
 */

const require = createRequire(import.meta.url);

interface ParityCell {
  getChars(): string;
  getWidth(): number;
}

interface ParityLine {
  translateToString(trimRight?: boolean): string;
  getCell(x: number): ParityCell | undefined;
}

interface ParityTerminal {
  write(data: string, callback?: () => void): void;
  resize(cols: number, rows: number): void;
  dispose(): void;
  readonly buffer: {
    readonly active: {
      readonly cursorX: number;
      readonly cursorY: number;
      readonly baseY: number;
      readonly length: number;
      getLine(index: number): ParityLine | undefined;
    };
  };
}

type ParityTerminalConstructor = new (options: Record<string, unknown>) => ParityTerminal;

function loadTerminalConstructor(specifier: string): ParityTerminalConstructor {
  // The published types describe the ESM shape; the installed builds are UMD, so
  // `Terminal` may sit on the namespace or on its default export.
  const namespace = require(specifier) as unknown as {
    Terminal?: ParityTerminalConstructor;
    default?: { Terminal?: ParityTerminalConstructor };
  };
  const ctor = namespace.Terminal ?? namespace.default?.Terminal;
  assert.ok(ctor, `${specifier} must expose Terminal directly or on its default export`);
  return ctor;
}

const BrowserTerminal = loadTerminalConstructor('@xterm/xterm');
const HeadlessTerminal = loadTerminalConstructor('@xterm/headless');

// ---------------------------------------------------------------------------
// Option provenance — read from source, so a change on either side reddens this
// file rather than passing through it.
// ---------------------------------------------------------------------------

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

function parseBooleanOptions(source: string, pattern: RegExp, what: string): Record<string, boolean> {
  const block = source.match(pattern);
  assert.ok(block, `${what} could not be located; this test must not silently fall back to defaults`);
  const parsed: Record<string, boolean> = {};
  for (const line of block[1].split('\n')) {
    const entry = line.match(/^\s*([A-Za-z][A-Za-z0-9]*)\s*:\s*(true|false)\s*,?\s*$/u);
    if (entry) parsed[entry[1]] = entry[2] === 'true';
  }
  return parsed;
}

function serverReflowOptions(): Record<string, boolean> {
  return parseBooleanOptions(
    readSource('../../../server/src/utils/headlessTerminal.ts'),
    /const DEFAULT_TERMINAL_OPTIONS[^=]*=\s*\{([\s\S]*?)\n\};/u,
    'DEFAULT_TERMINAL_OPTIONS in server/src/utils/headlessTerminal.ts',
  );
}

function browserReflowOptions(): Record<string, boolean> {
  return parseBooleanOptions(
    readSource('../../src/components/Terminal/TerminalView.tsx'),
    /const term = new Terminal\(\{([\s\S]*?)\n {6}\}\);/u,
    'the new Terminal({ ... }) literal in frontend/src/components/Terminal/TerminalView.tsx',
  );
}

const REFLOW_OPTION = 'reflowCursorLine';

// ---------------------------------------------------------------------------
// Corpus
// ---------------------------------------------------------------------------

const COLS = 40;
const ROWS = 10;
const SCROLLBACK = 1000;

interface ReflowCase {
  readonly name: string;
  readonly stream: string;
  readonly resizeTo: number;
}

const PROMPT = 'user@host:~/some/long/working/directory$ ';

const CASES: readonly ReflowCase[] = [
  {
    // The state a live shell is normally in: a prompt plus typed input, wrapped,
    // with no newline yet. This is the case that diverges.
    name: 'cursor on a wrapped ASCII line, widened',
    stream: `history\r\n${PROMPT}${'x'.repeat(55)}`,
    resizeTo: 72,
  },
  {
    name: 'cursor on a wrapped ASCII line, narrowed',
    stream: `history\r\n${PROMPT}${'x'.repeat(55)}`,
    resizeTo: 24,
  },
  {
    // Wide characters double the number of cells the cursor line occupies, so a
    // reflow disagreement moves more rows.
    name: 'cursor on a wrapped CJK line, widened',
    stream: `history\r\n프롬프트$ ${'한글'.repeat(30)}`,
    resizeTo: 72,
  },
  {
    name: 'cursor on a wrapped CJK line, narrowed',
    stream: `history\r\n프롬프트$ ${'한글'.repeat(30)}`,
    resizeTo: 24,
  },
  {
    // The control: the cursor has left the wrapped line, so `reflowCursorLine`
    // has nothing to act on. This agreed even before #114, and it is here so a
    // fix that made every case agree by disabling reflow entirely would still
    // have to keep this one honest.
    name: 'wrapped line committed, cursor below, widened',
    stream: `history\r\n${PROMPT}${'x'.repeat(55)}\r\n`,
    resizeTo: 72,
  },
];

interface BufferShape {
  lines: string[];
  cursorX: number;
  cursorY: number;
  baseY: number;
  length: number;
}

function drive(
  ctor: ParityTerminalConstructor,
  options: Record<string, unknown>,
  testCase: ReflowCase,
): Promise<BufferShape> {
  const terminal = new ctor({ cols: COLS, rows: ROWS, scrollback: SCROLLBACK, ...options });
  return new Promise<BufferShape>((resolve) => {
    terminal.write(testCase.stream, () => {
      terminal.resize(testCase.resizeTo, ROWS);
      const active = terminal.buffer.active;
      const lines: string[] = [];
      for (let index = 0; index < active.length; index += 1) {
        lines.push(active.getLine(index)?.translateToString(true) ?? '');
      }
      const shape: BufferShape = {
        lines,
        cursorX: active.cursorX,
        cursorY: active.cursorY,
        baseY: active.baseY,
        length: active.length,
      };
      terminal.dispose();
      resolve(shape);
    });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('#114 the two engines agree on reflowCursorLine', () => {
  const server = serverReflowOptions();
  const browser = browserReflowOptions();

  assert.ok(
    REFLOW_OPTION in server,
    `the server must set ${REFLOW_OPTION} explicitly, so its value is pinned rather than inherited`,
  );
  assert.ok(
    REFLOW_OPTION in browser,
    `the browser must set ${REFLOW_OPTION} explicitly, so its value is pinned rather than inherited. `
      + 'Leaving it unset gives the same behaviour as false today, but an xterm release that '
      + 'changed the default would move the browser and not the server.',
  );
  assert.equal(
    browser[REFLOW_OPTION],
    server[REFLOW_OPTION],
    `The browser and the server disagree about ${REFLOW_OPTION}. Both consume the output of one `
      + 'shell and the server replica exists to reproduce what the browser shows, so a resize '
      + 'makes the replica describe a screen the user is not looking at.',
  );
});

for (const testCase of CASES) {
  test(`#114 buffers agree after resize: ${testCase.name}`, async () => {
    const serverOptions = serverReflowOptions();
    const browserOptions = browserReflowOptions();

    const [serverShape, browserShape] = await Promise.all([
      drive(HeadlessTerminal, serverOptions, testCase),
      drive(BrowserTerminal, browserOptions, testCase),
    ]);

    // Log before asserting: a failure here must say what diverged, and an
    // assertion message alone loses the rows.
    const differing = serverShape.lines
      .map((line, index) => (line === browserShape.lines[index] ? -1 : index))
      .filter((index) => index >= 0);
    if (differing.length > 0 || serverShape.cursorY !== browserShape.cursorY) {
      console.log(
        `[#114] ${testCase.name}: ${COLS} -> ${testCase.resizeTo}`,
        `cursor server=(${serverShape.cursorX},${serverShape.cursorY})`,
        `browser=(${browserShape.cursorX},${browserShape.cursorY})`,
        `differing rows=${JSON.stringify(differing)}`,
      );
      for (const index of differing.slice(0, 4)) {
        console.log(`  row ${index} server : ${JSON.stringify(serverShape.lines[index])}`);
        console.log(`  row ${index} browser: ${JSON.stringify(browserShape.lines[index])}`);
      }
    }

    assert.deepEqual(
      browserShape,
      serverShape,
      `The browser buffer and the server replica differ after a ${COLS} -> ${testCase.resizeTo} `
        + 'resize. Restore hands the replica back to the browser, so this is the screen the user '
        + 'would be given in place of the one they were looking at.',
    );
  });
}

test('#114 the corpus contains a case that reflowCursorLine can actually move', async () => {
  // Without this the agreement above is satisfiable by a corpus of cases that
  // resize nothing interesting — every one of them would agree whatever the two
  // sides are set to, and the file would pass while measuring nothing. Drive one
  // engine both ways and require the option to change the answer.
  const testCase = CASES[0];
  const [on, off] = await Promise.all([
    drive(HeadlessTerminal, { allowProposedApi: true, reflowCursorLine: true }, testCase),
    drive(HeadlessTerminal, { allowProposedApi: true, reflowCursorLine: false }, testCase),
  ]);

  assert.notDeepEqual(
    on,
    off,
    `${testCase.name} must be a case where reflowCursorLine changes the buffer. If xterm stopped `
      + 'distinguishing the two, this corpus would agree for a reason that has nothing to do with '
      + 'the two sides being configured alike, and would go on passing if they diverged again.',
  );
});
