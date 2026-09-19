import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

/**
 * Issue #16, item 1 — a GOLDEN CORPUS for Unicode cell width, as opposed to the
 * asymmetry detector that already exists.
 *
 * tests/unit/terminalWidthPolicyParity.test.ts pins the width POLICY: it reads
 * both sources as text and fails if one side loads a unicode width addon the
 * other does not, or if the declared option asymmetry stops holding. What it
 * cannot answer is the question FR-BGSTAB-029 actually asks — do the two sides
 * assign the same number of cells to the same bytes? A policy pin passes just as
 * happily when both sides are configured identically and nevertheless disagree,
 * for instance because `@xterm/xterm` and `@xterm/headless` have drifted to
 * different releases with different width tables.
 *
 * So this file runs BOTH engines for real. The browser renders with
 * `@xterm/xterm` and the server's retained model runs `@xterm/headless`
 * (server/src/utils/headlessTerminal.ts). Both are constructible in bare Node as
 * long as `open()` is never called — no DOM and no jsdom is needed, which is why
 * this file belongs in the plain `--experimental-strip-types` sweep rather than
 * the component-render script.
 *
 * Three claims per corpus entry, in order of what they catch:
 *   1. the server engine matches the recorded golden;
 *   2. the browser engine matches the recorded golden;
 *   3. the two engines match each other.
 * (3) alone would pass if both sides broke the same way, which is exactly what a
 * shared-dependency upgrade does; (1) and (2) are what notice that.
 *
 * The goldens are MEASURED values, recorded 2026-09-19 against xterm 6.0.0, not
 * derived from a Unicode specification. Where a value is independently
 * predictable it is also predicted in a comment, and where xterm's built-in
 * UnicodeV6 table gives an answer that differs from what a modern terminal user
 * would expect — every emoji below is ONE cell wide, not two — that is recorded
 * as a characterization of the installed engines rather than endorsed. If the
 * project ever loads `@xterm/addon-unicode11`, these entries are expected to
 * move, and this file is where that shows up.
 */

const require = createRequire(import.meta.url);

const COLS = 40;
const ROWS = 4;
const SCROLLBACK = 100;

// ---------------------------------------------------------------------------
// Engine loading
// ---------------------------------------------------------------------------

interface WidthProbeCell {
  getChars(): string;
  getWidth(): number;
}

interface WidthProbeTerminal {
  write(data: string, callback?: () => void): void;
  loadAddon(addon: object): void;
  unicode: { activeVersion: string };
  dispose(): void;
  readonly buffer: {
    readonly active: {
      readonly cursorX: number;
      getLine(index: number): { getCell(x: number): WidthProbeCell | undefined } | undefined;
    };
  };
}

type WidthProbeTerminalConstructor = new (options: Record<string, unknown>) => WidthProbeTerminal;

function loadTerminalConstructor(specifier: string): WidthProbeTerminalConstructor {
  // The published types describe the ESM shape; the installed builds are UMD, so
  // `Terminal` may sit on the namespace or on its default export. Reading through
  // `unknown` keeps the narrowing from hiding the CJS-interop shape, the same way
  // tests/unit/terminalOutputScheduler.test.ts does.
  const namespace = require(specifier) as unknown as {
    Terminal?: WidthProbeTerminalConstructor;
    default?: { Terminal?: WidthProbeTerminalConstructor };
  };
  const ctor = namespace.Terminal ?? namespace.default?.Terminal;
  assert.ok(ctor, `${specifier} must expose Terminal directly or on its default export`);
  return ctor;
}

const BrowserTerminal = loadTerminalConstructor('@xterm/xterm');
const HeadlessTerminal = loadTerminalConstructor('@xterm/headless');

/**
 * Issue #114 loaded `@xterm/addon-unicode11` on both sides, so this corpus has
 * to load it too or it measures a pair of terminals that no longer exists in
 * production — the same failure the provenance test below guards for options.
 *
 * Which is why the version is not written here as a constant: it is read out of
 * both production sources, and a side that stops loading the addon, or sets a
 * different version, reddens the provenance test rather than quietly changing
 * what this file measures.
 */
const unicode11Module = require('@xterm/addon-unicode11') as unknown as {
  Unicode11Addon?: new () => object;
  default?: { Unicode11Addon?: new () => object };
};
const Unicode11Addon = unicode11Module.Unicode11Addon ?? unicode11Module.default?.Unicode11Addon;
assert.ok(Unicode11Addon, '@xterm/addon-unicode11 must expose Unicode11Addon');

const BROWSER_TERMINAL_SOURCE = readFileSync(
  new URL('../../src/components/Terminal/TerminalView.tsx', import.meta.url),
  'utf8',
);

/** The unicode version a source asks for, or null if it loads no addon at all. */
function declaredUnicodeVersion(source: string): string | null {
  if (!/Unicode11Addon/.test(source)) return null;
  const version = source.match(/activeVersion\s*=\s*(?:UNICODE_WIDTH_VERSION|'([0-9]+)')/u);
  if (!version) return null;
  if (version[1]) return version[1];
  const constant = source.match(/UNICODE_WIDTH_VERSION\s*=\s*'([0-9]+)'/u);
  return constant ? constant[1] : null;
}

// ---------------------------------------------------------------------------
// Server option provenance
// ---------------------------------------------------------------------------

const SERVER_TERMINAL_SOURCE = readFileSync(
  new URL('../../../server/src/utils/headlessTerminal.ts', import.meta.url),
  'utf8',
);

/**
 * The headless terminal in this process must be configured the way the server
 * configures its own, or the corpus measures a terminal that does not exist in
 * production. Rather than copy the values and let them rot, they are read out of
 * the server source. A newly added option makes `parseServerDefaultOptions`
 * return a key that `SERVER_DEFAULT_OPTIONS_AS_MEASURED` does not declare, and
 * the provenance test below fails asking for the corpus to be re-measured.
 */
function parseServerDefaultOptions(): Record<string, boolean> {
  const block = SERVER_TERMINAL_SOURCE.match(
    /const DEFAULT_TERMINAL_OPTIONS[^=]*=\s*\{([\s\S]*?)\n\};/u,
  );
  assert.ok(
    block,
    'DEFAULT_TERMINAL_OPTIONS could not be located in server/src/utils/headlessTerminal.ts. '
      + 'This corpus configures its headless engine from that literal; it must not silently '
      + 'fall back to defaults.',
  );
  const parsed: Record<string, boolean> = {};
  for (const line of block[1].split('\n')) {
    const entry = line.match(/^\s*([A-Za-z][A-Za-z0-9]*)\s*:\s*(true|false)\s*,?\s*$/u);
    if (entry) parsed[entry[1]] = entry[2] === 'true';
  }
  return parsed;
}

/** Declared, so that a server-side option addition reddens this file rather than passing through it. */
const SERVER_DEFAULT_OPTIONS_AS_MEASURED = Object.freeze({
  allowProposedApi: true,
  // Issue #114 moved this from true to false and made the browser state the
  // same value explicitly. It cannot change a cell width — it only acts on a
  // resize, and this corpus never resizes — and the 18 goldens below were
  // re-run across the change without one moving. The resize behaviour it does
  // govern is measured in tests/unit/terminalReflowParity.test.ts.
  reflowCursorLine: false,
});

/**
 * The construction options from TerminalView.tsx that a buffer can observe.
 * Font, theme and cursor styling are renderer-only and cannot change cell
 * widths, so they are deliberately absent.
 *
 * #114 added both width-affecting options here. `allowProposedApi` was
 * server-only while neither side swapped the width table; loading
 * `@xterm/addon-unicode11` made it mandatory on this side too, because xterm
 * throws from Unicode11Addon.activate() without it. That is not a detail this
 * corpus can paper over: an engine constructed without it here would fail to
 * load the addon and then measure the built-in table.
 */
const BROWSER_OPTIONS_AS_MEASURED = Object.freeze({
  convertEol: false,
  disableStdin: true,
  allowProposedApi: true,
  reflowCursorLine: false,
});

// ---------------------------------------------------------------------------
// Corpus
// ---------------------------------------------------------------------------

interface WidthGolden {
  readonly name: string;
  readonly input: string;
  /** [cell contents, xterm cell width] for every occupied cell of row 0. */
  readonly cells: readonly (readonly [string, number])[];
  readonly cursorX: number;
}

const WIDTH_CORPUS: readonly WidthGolden[] = [
  // Predictable: seven printable ASCII columns, one cell each.
  {
    name: 'ascii-baseline',
    input: 'Ab1 ~',
    cells: [['A', 1], ['b', 1], ['1', 1], [' ', 1], ['~', 1]],
    cursorX: 5,
  },
  // Predictable: East Asian Wide. Each syllable owns two columns, the second of
  // which xterm models as an empty width-0 continuation cell.
  {
    name: 'wide-cjk-hangul-syllables',
    input: '가나다',
    cells: [['가', 2], ['', 0], ['나', 2], ['', 0], ['다', 2]],
    cursorX: 6,
  },
  {
    name: 'wide-cjk-han',
    input: '中文',
    cells: [['中', 2], ['', 0], ['文', 2]],
    cursorX: 4,
  },
  // Predictable: East Asian Fullwidth forms are wide even though they are Latin.
  {
    name: 'wide-fullwidth-latin',
    input: 'ａｂ',
    cells: [['ａ', 2], ['', 0], ['ｂ', 2]],
    cursorX: 4,
  },
  // Boundary control for the two above. Halfwidth katakana is East Asian
  // Halfwidth, so a "CJK means 2" rule would get this wrong; it is one cell.
  {
    name: 'narrow-halfwidth-kana',
    input: 'ｶﾅ',
    cells: [['ｶ', 1], ['ﾅ', 1]],
    cursorX: 2,
  },
  // CHARACTERIZATION, not a prediction. These are East Asian Ambiguous; a
  // terminal may legitimately render them at either width and xterm's built-in
  // table chooses 1. This entry exists so the choice is recorded rather than
  // assumed, and so a table swap that moves it is visible.
  {
    name: 'ambiguous-width',
    input: '§±○①→αй',
    cells: [['§', 1], ['±', 1], ['○', 1], ['①', 1], ['→', 1], ['α', 1], ['й', 1]],
    cursorX: 7,
  },
  // Predictable: a combining mark joins the preceding cell and adds no column.
  {
    name: 'combining-acute-grave',
    input: 'éà',
    cells: [['é', 1], ['à', 1]],
    cursorX: 2,
  },
  {
    name: 'combining-stacked',
    input: 'á̂̃',
    cells: [['á̂̃', 1]],
    cursorX: 1,
  },
  // Conjoining Hangul jamo L+V+T land in ONE cell of width 2 — the combining
  // rule and the wide rule both apply, and the cell is wide.
  {
    name: 'combining-hangul-jamo',
    input: '각',
    cells: [['각', 2]],
    cursorX: 2,
  },
  // CHARACTERIZATION. U+FE0F asks for emoji presentation, which in most terminals
  // means two columns. Here the sequence occupies ONE.
  {
    name: 'emoji-bmp-variation-selector',
    input: '❤️',
    cells: [['❤️', 1]],
    cursorX: 1,
  },
  // The single most consequential row in this file, and the one #114 moved.
  // Under xterm's built-in UnicodeV6 table a plain astral emoji was ONE cell,
  // while a shell computing its own line width with wcwidth says two — so the
  // two disagreed about the cursor from the first emoji onward. Both sides now
  // load @xterm/addon-unicode11 and both say two, with a width-0 continuation
  // cell exactly as a CJK syllable has. Predictable under Unicode 11, not a
  // characterization. Loading the provider on either side ALONE remains the #16
  // failure; that is what the provenance test above exists to catch.
  {
    name: 'emoji-astral',
    input: '\u{1F44D}\u{1F600}',
    cells: [['\u{1F44D}', 2], ['', 0], ['\u{1F600}', 2]],
    cursorX: 4,
  },
  // CHARACTERIZATION, and the bound on what #114 bought. Unicode 11 is a
  // per-code-point width table, not a grapheme segmenter: the ZWJ joins the cell
  // of the emoji before it and the next emoji starts a new cell, so a ZWJ pair
  // spends FOUR columns and a four-emoji family spends EIGHT. A terminal with a
  // grapheme segmenter would draw either as one two-column glyph.
  //
  // This is nonetheless what a shell's own wcwidth arithmetic produces, which is
  // the agreement that matters for cursor position. @xterm/addon-unicode-graphemes
  // is the thing that would change it, and adopting it is a separate decision
  // that would have to be taken on both sides at once for the same reason.
  {
    name: 'emoji-zwj-pair',
    input: '\u{1F469}‍\u{1F4BB}',
    cells: [['\u{1F469}‍', 2], ['', 0], ['\u{1F4BB}', 2]],
    cursorX: 4,
  },
  {
    name: 'emoji-zwj-family',
    input: '\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}',
    cells: [
      ['\u{1F468}‍', 2], ['', 0],
      ['\u{1F469}‍', 2], ['', 0],
      ['\u{1F467}‍', 2], ['', 0],
      ['\u{1F466}', 2],
    ],
    cursorX: 8,
  },
  // CHARACTERIZATION. A skin-tone modifier is itself an astral emoji code point
  // and takes its own cell rather than merging into the base emoji's — so under
  // Unicode 11 the pair spends four columns, for the same per-code-point reason
  // as the ZWJ rows above.
  {
    name: 'emoji-skin-tone-modifier',
    input: '\u{1F44D}\u{1F3FD}',
    cells: [['\u{1F44D}', 2], ['', 0], ['\u{1F3FD}', 2]],
    cursorX: 4,
  },
  // Zero-width characters consume no column, but they are not all handled the
  // same way: ZWSP and ZWNJ attach to the preceding cell's contents, while a BOM
  // is dropped outright and leaves no trace in any cell.
  {
    name: 'zero-width-and-bom',
    input: 'a​b‌c﻿d',
    cells: [['a​', 1], ['b‌', 1], ['c', 1], ['d', 1]],
    cursorX: 4,
  },
  // A C0 control is executed, not printed, so it occupies no cell at all.
  {
    name: 'c0-control-bel',
    input: 'ab',
    cells: [['a', 1], ['b', 1]],
    cursorX: 2,
  },
  // Integration row: every rule above in one run, which is where an off-by-one
  // in the wide-cell continuation would surface as a shifted column.
  {
    name: 'mixed-script-run',
    input: '가A\u{1F44D}é中',
    cells: [['가', 2], ['', 0], ['A', 1], ['\u{1F44D}', 2], ['', 0], ['é', 1], ['中', 2]],
    cursorX: 8,
  },
];

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

interface WidthMeasurement {
  cells: (readonly [string, number])[];
  cursorX: number;
}

function writeAsync(terminal: WidthProbeTerminal, data: string): Promise<void> {
  return new Promise(resolve => { terminal.write(data, () => resolve()); });
}

async function measure(
  Terminal: WidthProbeTerminalConstructor,
  extraOptions: Readonly<Record<string, unknown>>,
  input: string,
  unicodeVersion: string | null,
): Promise<WidthMeasurement> {
  const terminal = new Terminal({ cols: COLS, rows: ROWS, scrollback: SCROLLBACK, ...extraOptions });
  try {
    if (unicodeVersion !== null) {
      terminal.loadAddon(new Unicode11Addon!());
      terminal.unicode.activeVersion = unicodeVersion;
      assert.equal(
        terminal.unicode.activeVersion,
        unicodeVersion,
        `the engine refused unicode version ${unicodeVersion}; the corpus below would then `
          + 'describe the built-in table while production uses another',
      );
    }
    await writeAsync(terminal, input);
    const line = terminal.buffer.active.getLine(0);
    assert.ok(line, 'row 0 must exist after a write');
    const cells: (readonly [string, number])[] = [];
    for (let x = 0; x < COLS; x += 1) {
      const cell = line.getCell(x);
      assert.ok(cell, `cell ${x} must be readable`);
      cells.push([cell.getChars(), cell.getWidth()] as const);
    }
    // Trailing untouched cells carry '' with width 1 and say nothing about the
    // input; drop them so a corpus entry describes only the columns it wrote.
    while (cells.length > 0 && cells[cells.length - 1][0] === '') cells.pop();
    return { cells, cursorX: terminal.buffer.active.cursorX };
  } finally {
    terminal.dispose();
  }
}

function toGoldenShape(measurement: WidthMeasurement): {
  cells: (readonly [string, number])[];
  cursorX: number;
} {
  return { cells: measurement.cells, cursorX: measurement.cursorX };
}

function expectedShape(entry: WidthGolden): {
  cells: (readonly [string, number])[];
  cursorX: number;
} {
  return { cells: entry.cells.map(cell => [cell[0], cell[1]] as const), cursorX: entry.cursorX };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('#16 the corpus configures its headless engine from the server\'s own option literal', () => {
  assert.deepEqual(
    parseServerDefaultOptions(),
    { ...SERVER_DEFAULT_OPTIONS_AS_MEASURED },
    'server/src/utils/headlessTerminal.ts changed DEFAULT_TERMINAL_OPTIONS. The width corpus '
      + 'below was measured against the old set, so it now describes a terminal the server does '
      + 'not build. Re-measure the corpus and update SERVER_DEFAULT_OPTIONS_AS_MEASURED.',
  );
});

test('#114 both sources load the same unicode width table, and this corpus loads it too', () => {
  const server = declaredUnicodeVersion(SERVER_TERMINAL_SOURCE);
  const browser = declaredUnicodeVersion(BROWSER_TERMINAL_SOURCE);

  assert.equal(
    browser,
    server,
    'The browser and the server ask for different unicode width tables. One side alone '
      + 'shifts recovered output by a cell from the first emoji onward, which is the failure '
      + `FR-BGSTAB-029 exists to notice. server=${server ?? 'none'} browser=${browser ?? 'none'}`,
  );
  assert.equal(
    server,
    '11',
    'The corpus below was measured with the Unicode 11 table loaded on both engines. A '
      + 'different table, or none, moves the emoji rows; re-measure the corpus deliberately '
      + 'rather than letting this file describe a terminal production does not build.',
  );
});

/**
 * Substitution guard, borrowed from tests/unit/xtermDecoderInterleaving.test.ts.
 * Unlike that file this one runs BOTH packages, so a version split does not
 * invalidate the measurement — but it does mean the two sides can diverge
 * without anyone changing a line of this repository, which is worth naming
 * separately from a width mismatch when it happens.
 */
test('#16 the browser and server xterm packages are the same release', () => {
  const browserVersion = (require('@xterm/xterm/package.json') as { version: string }).version;
  const headlessVersion = (require('@xterm/headless/package.json') as { version: string }).version;
  assert.equal(
    headlessVersion,
    browserVersion,
    'The browser renderer and the server retained model are on different xterm releases. '
      + 'They carry independent copies of the Unicode width table, so this is the drift '
      + `FR-BGSTAB-029 exists to notice. browser=${browserVersion} headless=${headlessVersion}`,
  );
});

test('#16 the corpus covers every width class issue #16 names', () => {
  const names = WIDTH_CORPUS.map(entry => entry.name);
  assert.equal(new Set(names).size, names.length, 'corpus entry names must be unique');
  // Non-vacuity floor: a corpus that silently shrank would still pass every
  // per-entry assertion below, because there would be none left to fail.
  for (const required of [
    'ascii', 'wide-cjk', 'ambiguous', 'combining', 'emoji-zwj', 'emoji-skin-tone',
    'emoji-astral', 'zero-width', 'c0-control',
  ]) {
    assert.ok(
      names.some(name => name.includes(required)),
      `the corpus lost its '${required}' class; #16 requires all of them`,
    );
  }
  assert.ok(WIDTH_CORPUS.length >= 17, `expected at least 17 corpus entries, found ${WIDTH_CORPUS.length}`);
});

for (const entry of WIDTH_CORPUS) {
  test(`#16 width golden — ${entry.name}`, async () => {
    const server = await measure(
      HeadlessTerminal,
      { ...SERVER_DEFAULT_OPTIONS_AS_MEASURED },
      entry.input,
      declaredUnicodeVersion(SERVER_TERMINAL_SOURCE),
    );
    const browser = await measure(
      BrowserTerminal,
      { ...BROWSER_OPTIONS_AS_MEASURED },
      entry.input,
      declaredUnicodeVersion(BROWSER_TERMINAL_SOURCE),
    );

    assert.deepEqual(
      toGoldenShape(server),
      expectedShape(entry),
      `the server headless engine no longer assigns the recorded widths to '${entry.name}'`,
    );
    assert.deepEqual(
      toGoldenShape(browser),
      expectedShape(entry),
      `the browser engine no longer assigns the recorded widths to '${entry.name}'`,
    );
    // Stated last because on its own it is the weakest of the three: two engines
    // that broke identically would satisfy it.
    assert.deepEqual(
      toGoldenShape(browser),
      toGoldenShape(server),
      `the browser and the server disagree about '${entry.name}'. Recovered output shifts by a `
        + 'cell from the first such character onward.',
    );
  });
}
