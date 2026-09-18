import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

/**
 * Issue #82: `frontend/tsconfig.test.json` uses an explicit `files` allowlist,
 * and nothing compared that allowlist against the directory it is meant to
 * cover. 45 of 116 files under tests/unit/ had drifted out of it and were never
 * type-checked by anything — `tsconfig.app.json` only includes `src`.
 *
 * This guard fails when a file under tests/unit/ is in neither the allowlist nor
 * the explicit exclusion list below. The exclusion list is itself checked for
 * stale entries, because an exclusion list that silently grows is the same
 * defect in a new place.
 */

const FRONTEND_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const TSCONFIG = join(FRONTEND_ROOT, 'tsconfig.test.json');
const UNIT_DIR = join(FRONTEND_ROOT, 'tests', 'unit');

/**
 * Files deliberately kept out of the allowlist, each with the reason.
 * Empty today: every file under tests/unit/ type-checks.
 */
const EXCLUDED: ReadonlyMap<string, string> = new Map([]);

function listedFiles(): Set<string> {
  const raw = readFileSync(TSCONFIG, 'utf8');
  // tsconfig is JSON with comments; the entries are plain quoted paths inside
  // "files". Strip line comments, then read the array.
  const withoutComments = raw.replace(/^\s*\/\/.*$/gm, '');
  const filesBlock = /"files"\s*:\s*\[([^\]]*)\]/.exec(withoutComments);
  assert.ok(filesBlock, 'tsconfig.test.json has no "files" array');
  return new Set(
    [...filesBlock[1].matchAll(/"([^"]+)"/g)]
      .map((match) => match[1].replace(/^\.\//, '')),
  );
}

function diskUnitFiles(): string[] {
  const walk = (dir: string, prefix: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? walk(join(dir, entry.name), `${prefix}/${entry.name}`)
        : /\.tsx?$/.test(entry.name)
          ? [`${prefix}/${entry.name}`]
          : [],
    );
  return walk(UNIT_DIR, 'tests/unit').sort();
}

test('every tests/unit file is in the tsconfig.test.json allowlist or explicitly excluded', () => {
  const listed = listedFiles();
  const unaccounted = diskUnitFiles()
    .filter((file) => !listed.has(file) && !EXCLUDED.has(file));

  assert.deepEqual(
    unaccounted,
    [],
    'These files under tests/unit/ are type-checked by nothing. Add them to the '
      + '"files" array in frontend/tsconfig.test.json, or add them to EXCLUDED in '
      + 'this test with a reason.',
  );
});

test('the exclusion list has no stale entries', () => {
  const listed = listedFiles();
  const onDisk = new Set(diskUnitFiles());

  for (const [file, reason] of EXCLUDED) {
    assert.ok(reason.trim().length > 0, `EXCLUDED entry ${file} has no reason`);
    assert.ok(onDisk.has(file), `EXCLUDED entry ${file} no longer exists on disk`);
    assert.ok(
      !listed.has(file),
      `${file} is both excluded and in the allowlist; drop one of the two`,
    );
  }
});
