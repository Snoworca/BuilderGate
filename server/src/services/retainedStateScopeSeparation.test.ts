import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * REL-BGSTAB-026 AC-4 — the restart scope and the live-server refresh scope must be
 * verified by different tests, and evidence for one must not be cited for the other.
 *
 * "The tests happen to be separate" and "separation is enforced" are different claims, and
 * only the second survives someone later adding a row. This reads the requirement's own
 * Verification Evidence table and fails when a test row crosses the boundary.
 *
 * Scope classification is pinned here rather than inferred from the reference string,
 * because inferring it would make the guard agree with whatever a future row asserts about
 * itself -- which is the failure mode it exists to prevent.
 */

const SRS = fileURLToPath(
  new URL('../../../docs/spec/30.buildergate-stability.srs.md', import.meta.url),
);
const REQUIREMENT = 'REL-BGSTAB-026';

/** ACs whose subject is a server restart or a terminated PTY. */
const RESTART_SCOPE_ACS = new Set(['AC-2', 'AC-3']);
/** ACs whose subject is a live server and a surviving PTY. */
const LIVE_REFRESH_SCOPE_ACS = new Set(['AC-1']);

/**
 * Test references, classified by the scope they exercise. A row referencing a test that is
 * not listed here fails: an unclassified test cannot be shown to respect the boundary.
 */
/**
 * 'meta' is for tests whose subject is the separation itself rather than either scope.
 * They are classified explicitly so that they are not silently exempt: an unclassified
 * reference still fails.
 */
const TEST_SCOPES: ReadonlyMap<string, 'restart' | 'live-refresh' | 'meta'> = new Map([
  ['server/src/services/retainedStateScopeSeparation.test.ts', 'meta'],
  // One file can hold both scopes, so references are classified per test where they do.
  // The bare path means the restart-scope tests in that file; the fragment below names the
  // live-refresh test that REL-BGSTAB-007 authored and this requirement cites for AC-1.
  ['server/src/services/RetainedTerminalAuthority.test.ts', 'restart'],
  [
    'server/src/services/RetainedTerminalAuthority.test.ts#Retained server model shadow and '
    + 'driver lease RED contract — REL-BGSTAB-007 AC-10',
    'live-refresh',
  ],
  ['frontend/tests/unit/retainedStatePersistenceBoundary.test.ts', 'restart'],
  ['frontend/tests/unit/visibleOutputRecovery.test.ts', 'live-refresh'],
]);

interface EvidenceRow {
  readonly id: string;
  readonly type: string;
  readonly reference: string;
  readonly covers: readonly string[];
}

function evidenceRows(): EvidenceRow[] {
  const srs = readFileSync(SRS, 'utf8');
  const start = srs.indexOf(`### ${REQUIREMENT} —`);
  assert.notEqual(start, -1, `${REQUIREMENT} is not in the SRS`);
  const nextRequirement = srs.indexOf('\n### ', start + 1);
  const block = srs.slice(start, nextRequirement === -1 ? undefined : nextRequirement);

  const heading = block.indexOf('#### Verification Evidence');
  assert.notEqual(heading, -1, `${REQUIREMENT} has no Verification Evidence section`);
  const section = block.slice(heading, block.indexOf('\n#### ', heading + 1));

  return section
    .split('\n')
    .filter((line) => /^\|\s*VE-\d+\s*\|/u.test(line))
    .map((line) => {
      const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
      return {
        id: cells[0],
        type: cells[1],
        reference: cells[2],
        covers: cells[3].split(',').map((ac) => ac.trim()).filter(Boolean),
      };
    });
}

test('REL-BGSTAB-026 AC-4 — both scopes carry their own test evidence', () => {
  const signature = 'a scope has no test evidence of its own, so AC-4 separation is untested';
  const testRows = evidenceRows().filter((row) => row.type === 'test');

  // Without this the guard below passes vacuously on an empty table.
  assert.notEqual(testRows.length, 0, `${signature}: no test evidence rows at all`);

  const scopes = new Set(testRows.map((row) => TEST_SCOPES.get(row.reference)));
  assert.equal(scopes.has('restart'), true, `${signature}: no restart-scope test row`);
});

test('REL-BGSTAB-026 AC-4 — no test evidence row is cited across the scope boundary', () => {
  const signature = 'a test evidence row cites one scope as evidence for the other';

  for (const row of evidenceRows()) {
    // Contract-authorization rows (type=decision) argue about scope rather than exercise
    // it, so the boundary does not apply to them. AC-4 governs verification evidence.
    if (row.type !== 'test') continue;

    const scope = TEST_SCOPES.get(row.reference);
    assert.ok(scope, `${signature}: ${row.id} references an unclassified test (${row.reference})`);

    if (scope === 'meta') continue;
    const forbidden = scope === 'restart' ? LIVE_REFRESH_SCOPE_ACS : RESTART_SCOPE_ACS;
    for (const ac of row.covers) {
      assert.equal(
        forbidden.has(ac),
        false,
        `${signature}: ${row.id} is ${scope}-scope but covers ${ac}`,
      );
    }
  }
});
