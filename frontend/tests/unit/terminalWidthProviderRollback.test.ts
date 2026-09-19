import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

/**
 * Issue #16 completion criterion 9 — "server/browser provider rollback happens
 * at the same reconnect epoch, with a fresh authoritative snapshot".
 *
 * WHAT THIS CAN AND CANNOT CLAIM. There is no unicode width provider in this
 * codebase today: `terminalWidthPolicyParity.test.ts` measures that neither
 * side loads a unicode addon, so both use xterm's built-in table. With no
 * provider there is nothing to roll back, and a test that asserted "the
 * rollback rides the reconnect epoch" would be asserting a property of code
 * that does not exist — a null instrument, confidently answering a question it
 * cannot see.
 *
 * So this guard pins the PRECONDITION that makes criterion 9 hold trivially,
 * and fails the moment that precondition is removed: neither side may mutate
 * the width table at runtime. `term.unicode.activeVersion = ...` and
 * `unicode.register(...)` are xterm's two surfaces for that, and both take
 * effect mid-session on cells already in the buffer — which is exactly the
 * "reinterpret existing cell state" that criterion 9 forbids. While the only
 * way to change the width policy is to change the build, a change necessarily
 * arrives on both sides at a fresh process and a fresh authoritative snapshot,
 * and cannot be applied to one side of a live session.
 *
 * WHEN THIS GOES RED it is not a regression to silence. It means someone
 * introduced a runtime width-provider switch, and criterion 9 then needs a real
 * test: that the switch is driven from the reconnect epoch on both sides and
 * that the browser discards its cells and re-syncs from a server snapshot
 * rather than re-measuring what it already drew.
 *
 * MUTATION-TESTED 2026-09-20: observed red by adding
 * `term.unicode.activeVersion = '11';` to a scanned source on each side in turn.
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

test('#16 item 9 — neither side can swap the unicode width table mid-session', () => {
  const server = runtimeWidthMutations('server/src');
  const browser = runtimeWidthMutations('frontend/src');

  assert.deepEqual(
    { server, browser },
    { server: [], browser: [] },
    'A runtime unicode width-table switch was introduced. Criterion 9 requires a provider '
      + 'rollback to happen on both sides at the same reconnect epoch and to re-sync from a fresh '
      + 'authoritative snapshot, never by re-measuring cells already in the buffer. While no such '
      + 'switch exists, that holds by construction; once one does, it needs its own test and this '
      + 'guard must be replaced rather than deleted.',
  );
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
