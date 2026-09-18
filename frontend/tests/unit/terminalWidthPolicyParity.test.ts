import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

/**
 * Issue #16, symptom 1 — the browser and the server each keep an xterm instance
 * that must agree on how many cells a character occupies, because snapshot
 * recovery and server/browser authority promotion both compare cell content.
 *
 * Today they DO agree, and this guard is not claiming otherwise: neither side
 * loads a unicode addon, so both use xterm's built-in width table. What is
 * wrong is that the two option sets are asymmetric — the server passes
 * `allowProposedApi: true`, which is the precondition for swapping the width
 * table via `term.unicode.activeVersion`, and the browser passes nothing. The
 * failure mode the issue describes is therefore not a current mismatch but a
 * future one: the moment one side loads `@xterm/addon-unicode11` and the other
 * does not, the widths diverge silently and the user sees recovered output
 * shifted by a cell from that line on.
 *
 * So this pins the policy rather than the symptom. It fails when:
 *   - either side starts or stops loading a unicode addon, unless both do;
 *   - a width-affecting option's value changes on either side;
 *   - the declared asymmetry below stops being true, in either direction.
 *
 * It deliberately does NOT assert that the two option sets are identical.
 * Making the browser match the server means turning on `reflowCursorLine`
 * there, which changes resize reflow behaviour and cannot be verified without a
 * browser. That belongs to #16's own fix, not to its guard.
 */

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

const SERVER_TERMINAL = 'server/src/utils/headlessTerminal.ts';
const BROWSER_TERMINAL = 'frontend/src/components/Terminal/TerminalView.tsx';

/**
 * Options that can change how many cells a character occupies, or that gate the
 * API used to change it. `scrollback` is deliberately absent: it sets the
 * retained range, not the width.
 */
const WIDTH_AFFECTING_OPTIONS = ['allowProposedApi', 'reflowCursorLine'] as const;

/**
 * The asymmetry as measured today, with the reason it is tolerated. An entry
 * here is a claim that the option is set on one side and absent on the other,
 * and the test fails if that stops being accurate — including if someone
 * "fixes" it without removing the entry.
 */
const DECLARED_ASYMMETRY: ReadonlyMap<string, string> = new Map([
  [
    'allowProposedApi',
    'Server-only. Precondition for swapping the unicode width table. Harmless '
      + 'while neither side loads a unicode addon, which the addon check below '
      + 'enforces.',
  ],
  [
    'reflowCursorLine',
    'Server-only. Turning it on in the browser changes resize reflow and needs '
      + 'browser verification, so #16 owns that change, not this guard.',
  ],
]);

const UNICODE_ADDON_PATTERN = /@xterm\/addon-unicode\d+|unicode\.activeVersion/;

function read(relativePath: string): string {
  return readFileSync(new URL(relativePath, `file://${REPO_ROOT}`), 'utf8');
}

/**
 * The addon check used to grep two hardcoded paths, which asserted a property of
 * two string literals rather than of the system: a unicode addon loaded from any
 * other module would have passed it silently. It now scans both source trees.
 */
function scanSources(relativeRoot: string): { file: string; text: string }[] {
  const root = new URL(relativeRoot, `file://${REPO_ROOT}`);
  const dir = root.pathname;
  const walk = (d: string): string[] =>
    readdirSync(d, { withFileTypes: true }).flatMap((e) => {
      if (e.name === 'node_modules' || e.name === 'vendor') return [];
      const full = `${d}/${e.name}`;
      if (e.isDirectory()) return walk(full);
      return /\.tsx?$/.test(e.name) ? [full] : [];
    });
  return walk(dir).map((file) => ({ file, text: readFileSync(file, 'utf8') }));
}

function setsOption(source: string, option: string): boolean {
  return new RegExp(`\\b${option}\\s*:`).test(source);
}

test('#16 neither side loads a unicode width addon without the other', () => {
  const hits = (relativeRoot: string): string[] => scanSources(relativeRoot)
    .filter(({ text }) => UNICODE_ADDON_PATTERN.test(text))
    .map(({ file }) => file.replace(REPO_ROOT, ''));

  const serverHits = hits('server/src');
  const browserHits = hits('frontend/src');
  const server = serverHits.length > 0;
  const browser = browserHits.length > 0;

  assert.equal(
    server,
    browser,
    'The server and browser terminals disagree about loading a unicode width '
      + 'addon. Whichever side has one, the other must match, or recovered '
      + 'output shifts by a cell wherever a wide or combining character appears. '
      + `server=${serverHits.join(',') || 'none'} browser=${browserHits.join(',') || 'none'}`,
  );
});

/**
 * AC-4 of FR-BGSTAB-029: selection state must be read from xterm, never from the
 * DOM. window.getSelection() keeps returning stale text after xterm has dropped
 * a selection, so it reports the opposite of the truth.
 */
test('#16 terminal code never reads selection state from the DOM', () => {
  const offenders = scanSources('frontend/src')
    .filter(({ file }) => /Terminal|terminal/.test(file) && !/\/editor\//.test(file))
    .filter(({ text }) => /window\.getSelection\s*\(/.test(text))
    .map(({ file }) => file.replace(REPO_ROOT, ''));

  assert.deepEqual(
    offenders,
    [],
    'Terminal-scoped source must read xterm\'s own selection state. '
      + 'window.getSelection() is a stale DOM artifact that survives after xterm '
      + 'has cleared its selection, so it inverts the answer.',
  );
});

test('#16 the width-affecting option asymmetry is exactly as declared', () => {
  const server = read(SERVER_TERMINAL);
  const browser = read(BROWSER_TERMINAL);

  const observed = WIDTH_AFFECTING_OPTIONS
    .filter((option) => setsOption(server, option) !== setsOption(browser, option));

  assert.deepEqual(
    [...observed].sort(),
    [...DECLARED_ASYMMETRY.keys()].sort(),
    'The width-affecting options set on only one side no longer match '
      + 'DECLARED_ASYMMETRY. If you closed one of these gaps, delete its entry; '
      + 'if you opened a new one, add it with a reason or make both sides agree.',
  );

  for (const [option, reason] of DECLARED_ASYMMETRY) {
    assert.ok(reason.trim().length > 0, `${option} is declared without a reason`);
  }
});

test('#16 width-affecting options keep the values this guard was written against', () => {
  const server = read(SERVER_TERMINAL);

  // Both are server-only today, so only the server carries a value to pin. If
  // the browser gains either one, the asymmetry test above fires first.
  assert.match(
    server,
    /allowProposedApi:\s*true/,
    'The server stopped enabling allowProposedApi; the unicode width table can '
      + 'no longer be swapped there, so re-derive this contract.',
  );
  assert.match(
    server,
    /reflowCursorLine:\s*true/,
    'The server stopped enabling reflowCursorLine; resize reflow now differs '
      + 'from what this contract was measured against.',
  );
});
