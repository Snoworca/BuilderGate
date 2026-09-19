import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

/**
 * Issue #16 completion criterion 9 — "server/browser provider rollback happens
 * at the same reconnect epoch, with a fresh authoritative snapshot".
 *
 * HISTORY. This file used to assert that NEITHER side mutated the width table
 * at runtime, because neither side loaded a unicode addon and criterion 9 then
 * held by construction: while the only way to change the width policy was to
 * change the build, a change necessarily arrived on both sides at a fresh
 * process and a fresh authoritative snapshot.
 *
 * #114 adopted `@xterm/addon-unicode11` on both sides, which means both now
 * call `term.unicode.activeVersion = '11'`. That turned the old absence claim
 * red, correctly and for exactly the reason its own note predicted. The note
 * said to REPLACE the guard rather than delete it, and this is the replacement.
 *
 * WHAT CRITERION 9 ACTUALLY FORBIDS is reinterpreting cells that are already in
 * a buffer — a width table swapped mid-session re-measures what the terminal
 * already drew, on one side of a live session. A table installed once during
 * terminal construction, before the terminal has been opened or written to,
 * cannot do that: there are no cells yet, and the install rides the same fresh
 * process and fresh authoritative snapshot the old guard relied on.
 *
 * So the claim is now bounded rather than absent, in three parts:
 *   1. exactly the two terminal-construction files may contain a mutation;
 *   2. each may contain exactly one;
 *   3. each must sit BEFORE that file's first terminal open-or-write call, which
 *      is the mechanical form of "at construction, not mid-session".
 *
 * (3) is what keeps this from degrading into "the two files we happen to have".
 * Without it, moving the call from construction into an output handler in the
 * same file would pass.
 *
 * WHEN THIS GOES RED it is still not a regression to silence. A mutation in a
 * third file, a second mutation in an allowed file, or one that has drifted past
 * the first write all mean criterion 9 needs a real test: that the switch is
 * driven from the reconnect epoch on both sides and that the browser discards
 * its cells and re-syncs from a server snapshot rather than re-measuring what it
 * already drew.
 *
 * MUTATION-TESTED 2026-09-20 — see the note on each clause below.
 */

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/**
 * xterm's two runtime width-table surfaces. `allowProposedApi` is deliberately
 * NOT here — it is the precondition for these calls, not a mutation, and it is
 * already pinned as a declared asymmetry by terminalWidthPolicyParity.test.ts.
 */
const RUNTIME_WIDTH_MUTATION = /unicode\s*\.\s*activeVersion\s*=|unicode\s*\.\s*register\s*\(/;

function scanSources(relativeRoot: string): { file: string; text: string }[] {
  const dir = new URL(relativeRoot, `file://${REPO_ROOT}`).pathname;
  const walk = (d: string): string[] =>
    readdirSync(d, { withFileTypes: true }).flatMap((entry) => {
      if (entry.name === 'node_modules' || entry.name === 'vendor') return [];
      const full = `${d}/${entry.name}`;
      if (entry.isDirectory()) return walk(full);
      return /\.tsx?$/.test(entry.name) ? [full] : [];
    });
  return walk(dir).map(file => ({ file, text: readFileSync(file, 'utf8') }));
}

function runtimeWidthMutations(relativeRoot: string): string[] {
  return scanSources(relativeRoot)
    .filter(({ text }) => RUNTIME_WIDTH_MUTATION.test(text))
    .map(({ file }) => file.replace(REPO_ROOT, ''));
}

/**
 * The only files allowed to install a width table, and the marker that ends the
 * construction window in each. A mutation must appear before that marker.
 *
 * The markers are the first call that can put cells in a buffer: `term.open()`
 * attaches the browser terminal to the DOM and starts rendering, and the server
 * replica's first write is `terminal.write(`. Naming them per file rather than
 * scanning for "any write" keeps the check from being satisfied by an unrelated
 * `.write(` on some other object.
 */
const CONSTRUCTION_SITES: ReadonlyMap<string, RegExp> = new Map([
  ['server/src/utils/headlessTerminal.ts', /\bterminal\.write\(/],
  ['frontend/src/components/Terminal/TerminalView.tsx', /\bterm\.open\(/],
]);

function mutationOffsets(text: string): number[] {
  const offsets: number[] = [];
  const pattern = new RegExp(RUNTIME_WIDTH_MUTATION.source, 'g');
  for (const match of text.matchAll(pattern)) offsets.push(match.index);
  return offsets;
}

test('#16 item 9 — only the two terminal-construction files may install a width table', () => {
  // MUTATION-TESTED: planting `term.unicode.activeVersion = '11';` in a third
  // scanned source reddens this clause and only this one.
  const server = runtimeWidthMutations('server/src');
  const browser = runtimeWidthMutations('frontend/src');

  assert.deepEqual(
    [...server, ...browser].sort(),
    [...CONSTRUCTION_SITES.keys()].sort(),
    'A runtime unicode width-table switch appeared outside terminal construction, or one of '
      + 'the construction sites stopped installing a table. Either way criterion 9 no longer '
      + 'holds by construction and needs a real test: the switch must be driven from the '
      + 'reconnect epoch on both sides, with the browser discarding its cells and re-syncing '
      + 'from a fresh authoritative snapshot rather than re-measuring what it already drew.',
  );
});

test('#16 item 9 — each install happens once, before the terminal can hold cells', () => {
  // MUTATION-TESTED: moving the browser install to after `term.open(...)`
  // reddens the ordering assertion; duplicating the line reddens the count.
  for (const [relativePath, firstUseMarker] of CONSTRUCTION_SITES) {
    const text = readFileSync(`${REPO_ROOT}${relativePath}`, 'utf8');
    const offsets = mutationOffsets(text);

    assert.equal(
      offsets.length,
      1,
      `${relativePath} installs the width table ${offsets.length} times. Criterion 9 tolerates `
        + 'one install during construction; a second one is a mid-session swap by definition, '
        + 'because the first has already run.',
    );

    const firstUse = firstUseMarker.exec(text);
    assert.ok(
      firstUse,
      `${relativePath} no longer contains ${String(firstUseMarker)}, so this check cannot tell `
        + 'construction from mid-session any more and must be re-derived rather than relaxed.',
    );
    assert.ok(
      offsets[0] < firstUse.index,
      `${relativePath} installs the width table at offset ${offsets[0]}, after its first `
        + `terminal use at ${firstUse.index}. A table installed once the terminal can hold cells `
        + 'reinterprets cells already drawn, which is exactly what criterion 9 forbids.',
    );
  }
});

/**
 * The guard above is an absence claim, and an absence claim over a regex is
 * satisfied for free by a regex that can never match. This checks the scanner
 * finds a planted occurrence of each surface, so a red above means "a mutation
 * exists" rather than "the pattern is dead".
 */
test('#16 item 9 — the scanner actually recognises both runtime surfaces', () => {
  assert.ok(RUNTIME_WIDTH_MUTATION.test("term.unicode.activeVersion = '11';"));
  assert.ok(RUNTIME_WIDTH_MUTATION.test('term.unicode.register(new Unicode11Addon());'));
  assert.ok(!RUNTIME_WIDTH_MUTATION.test('allowProposedApi: true,'));
  assert.ok(
    !RUNTIME_WIDTH_MUTATION.test('const v = term.unicode.activeVersion;'),
    'reading the active version is not a mutation and must not trip the guard',
  );
});

/**
 * And the scan has to reach real files, or both tests above pass over an empty
 * set. Measured rather than assumed: a walk that silently returned nothing
 * would make the absence claim vacuous in the one way its own assertion cannot
 * show.
 */
test('#16 item 9 — the scan reaches both source trees', () => {
  assert.ok(scanSources('server/src').length > 100, 'server/src scan found too few files');
  assert.ok(scanSources('frontend/src').length > 100, 'frontend/src scan found too few files');
});
