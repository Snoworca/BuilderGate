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
 * `allowProposedApi` is still server-only, with its reason below.
 *
 * #114 closed the `reflowCursorLine` half. It was server-only true; both sides
 * now state false. That entry moved from DECLARED_ASYMMETRY to RESOLVED_PARITY
 * rather than being deleted, so removing the value from either side is red
 * instead of silent. What the option actually does to a buffer is measured by
 * driving both engines in tests/unit/terminalReflowParity.test.ts; a source-text
 * pin cannot see it, and that file is what noticed the divergence.
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
  // Empty since #114. Both width-affecting options are now set on both sides and
  // live in RESOLVED_PARITY below. This map is kept rather than deleted: it is
  // where a NEW one-sided option gets declared, and the test below fails if one
  // appears without an entry here.
]);

/**
 * Options that were asymmetric and are not any more, with the value both sides
 * must now carry. This is the replacement DECLARED_ASYMMETRY asked for: the
 * entry does not disappear when the gap closes, it changes what it claims.
 *
 * An option listed here must be set EXPLICITLY on both sides with this value.
 * Explicitly, not merely equal in effect: an xterm release that moved the
 * default would move whichever side inherited it and leave the other behind,
 * which is the failure that produced this entry in the first place.
 */
const RESOLVED_PARITY: ReadonlyMap<string, { value: string; note: string }> = new Map([
  [
    'allowProposedApi',
    {
      value: 'true',
      note: 'Issue #114. Was server-only, tolerated because it is only the precondition '
        + 'for swapping the unicode width table and neither side swapped it. Adopting '
        + '@xterm/addon-unicode11 on both sides made it mandatory in the browser too: '
        + 'xterm throws from Unicode11Addon.activate() without it, so a browser terminal '
        + 'built without this option would fail to load the addon. Measured — the golden '
        + 'corpus reported every one of its 18 entries red with the addon requested and '
        + 'the option absent, including the ASCII baseline, because construction threw.',
    },
  ],
  [
    'reflowCursorLine',
    {
      value: 'false',
      note: 'Issue #114. Was server-only true, browser unset. Measured 2026-09-20 by '
        + 'driving both engines through one stream: with the cursor on a wrapped prompt '
        + 'line the same text landed on different rows after a resize, cursor two rows '
        + 'apart. False on both because xterm defaults it false for a stated reason — '
        + '"shells usually handle this themselves" — and both engines consume the output '
        + 'of one real shell. The behaviour itself is measured in '
        + 'tests/unit/terminalReflowParity.test.ts; this entry only pins the policy.',
    },
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
  // allowProposedApi moved to RESOLVED_PARITY in #114 and is pinned on both
  // sides by the test below, so it is deliberately not re-pinned here.
  assert.ok(server.length > 0, 'the server terminal source must be readable');
  // reflowCursorLine moved to RESOLVED_PARITY in #114 and is pinned on both
  // sides by the test below, so it is deliberately not re-pinned here.
});

test('#114 resolved parity options are set explicitly on both sides with the same value', () => {
  const server = read(SERVER_TERMINAL);
  const browser = read(BROWSER_TERMINAL);

  assert.ok(RESOLVED_PARITY.size > 0, 'RESOLVED_PARITY must not be emptied; see its comment');

  for (const [option, { value, note }] of RESOLVED_PARITY) {
    assert.ok(note.trim().length > 0, `${option} is declared resolved without a reason`);

    const expected = new RegExp(`\\b${option}\\s*:\\s*${value}\\b`);
    assert.match(
      server,
      expected,
      `${SERVER_TERMINAL} must set ${option}: ${value}. ${note}`,
    );
    assert.match(
      browser,
      expected,
      `${BROWSER_TERMINAL} must set ${option}: ${value}. ${note}`,
    );

    assert.ok(
      !DECLARED_ASYMMETRY.has(option),
      `${option} is declared both asymmetric and resolved; drop one of the two`,
    );
  }
});
