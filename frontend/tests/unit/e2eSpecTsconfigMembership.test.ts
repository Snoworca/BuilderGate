import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

/**
 * Issue #115: `tests/unit/e2eOwnershipTypecheck.test.ts` type-checks the set of
 * e2e specs that `tsconfig.e2e-ownership.json` lists, and nothing compared that
 * list against the directory it is meant to cover. 26 of 48 specs under
 * tests/e2e/ were in no tsconfig at all, so `tsc -p tsconfig.e2e-ownership.json`
 * exiting 0 was a statement about the other 22.
 *
 * That is the shape this repository keeps meeting: a guard passing is not a
 * guard having checked anything. Absence produced silence instead of red —
 * a new spec that nobody listed was not a failure, it was invisible. The
 * criterion-6 spec of issue #16 sat unchecked from the day it was written until
 * an independent review read it by hand.
 *
 * This guard fails when a spec under tests/e2e/ is in neither a tsconfig
 * allowlist nor the explicit exclusion list below. It is the e2e sibling of
 * tests/unit/tsconfigTestMembership.test.ts, which does the same for tests/unit
 * (issue #82 — a different directory, a different tsconfig, a different file
 * set; #82 is closed and does not own this surface).
 */

const FRONTEND_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const E2E_DIR = join(FRONTEND_ROOT, 'tests', 'e2e');

/**
 * Every tsconfig that may admit an e2e spec. Listing them explicitly rather than
 * globbing keeps a newly added tsconfig from silently widening what counts as
 * "covered" — a file is only type-checked if some config a human runs includes
 * it, and these are the two that `npm run typecheck:*` runs.
 */
const TSCONFIGS = ['tsconfig.e2e-ownership.json', 'tsconfig.test.json'] as const;

/**
 * Specs deliberately kept out of every allowlist, each with the reason.
 * Empty today: every spec under tests/e2e/ type-checks.
 */
const EXCLUDED: ReadonlyMap<string, string> = new Map([]);

function listedFiles(): Set<string> {
  const listed = new Set<string>();
  for (const name of TSCONFIGS) {
    const raw = readFileSync(join(FRONTEND_ROOT, name), 'utf8');
    // tsconfig is JSON with comments; the entries are plain quoted paths inside
    // "files". Strip line comments, then read the array.
    const withoutComments = raw.replace(/^\s*\/\/.*$/gm, '');
    const filesBlock = /"files"\s*:\s*\[([^\]]*)\]/.exec(withoutComments);
    assert.ok(filesBlock, `${name} has no "files" array`);
    for (const match of filesBlock[1].matchAll(/"([^"]+)"/g)) {
      listed.add(match[1].replace(/^\.\//, ''));
    }
  }
  return listed;
}

function diskSpecFiles(): string[] {
  return readdirSync(E2E_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.spec.ts'))
    .map((entry) => `tests/e2e/${entry.name}`)
    .sort();
}

test('every tests/e2e spec is in a tsconfig allowlist or explicitly excluded', () => {
  const listed = listedFiles();
  const unaccounted = diskSpecFiles()
    .filter((file) => !listed.has(file) && !EXCLUDED.has(file));

  assert.deepEqual(
    unaccounted,
    [],
    'These specs under tests/e2e/ are type-checked by nothing. Add them to the '
      + '"files" array in frontend/tsconfig.e2e-ownership.json, or add them to '
      + 'EXCLUDED in this test with a reason.',
  );
});

test('the e2e exclusion list has no stale entries', () => {
  const listed = listedFiles();
  const onDisk = new Set(diskSpecFiles());

  for (const [file, reason] of EXCLUDED) {
    assert.ok(reason.trim().length > 0, `EXCLUDED entry ${file} has no reason`);
    assert.ok(onDisk.has(file), `EXCLUDED entry ${file} no longer exists on disk`);
    assert.ok(
      !listed.has(file),
      `${file} is both excluded and in the allowlist; drop one of the two`,
    );
  }
});

test('the guard reads a real allowlist, not an empty one', () => {
  // A regex that stopped matching would make the membership test above report
  // every spec as unaccounted — loud, and therefore safe. A regex that matched
  // something enormous would make it report none, which is the failure mode
  // this whole issue is about. Pin the floor so an over-wide read is visible.
  const listed = listedFiles();
  const specs = [...listed].filter((file) => file.startsWith('tests/e2e/'));
  assert.ok(
    specs.length >= 20,
    `expected the tsconfig allowlists to name at least 20 e2e specs, read ${specs.length}`,
  );
  assert.ok(
    listed.has('tests/e2e/wave2-screen-repair-resync.spec.ts'),
    'expected the tsconfig.test.json e2e entry to be read too; only reading '
      + 'tsconfig.e2e-ownership.json would understate coverage',
  );
});
