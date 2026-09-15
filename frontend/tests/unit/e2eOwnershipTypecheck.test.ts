// REL-BGSTAB-001 AC-3 (RG-04): the ownership-validation E2E project must typecheck
// with zero errors under its own tsconfig, not under the `files: []` solution root.
//
// Two distinct defects are pinned here because they fail the SAME command and a
// fix for one silently leaves the other:
//
//   1. TS1294 x21 — `tsconfig.e2e-ownership.json` extends `tsconfig.test.json` but
//      `references` is NOT inherited through `extends`. Without its own reference to
//      `./tsconfig.editor.json`, the vendored `src/editor` tree (exempt from
//      `erasableSyntaxOnly` precisely because it must stay byte-identical to upstream)
//      is dragged into this program and every parameter property is reported.
//      `tsconfig.test.json` carries the same re-declaration with a comment naming
//      this exact trap; `tsconfig.e2e-ownership.json` was missing it.
//   2. TS6133 x2 — two declarations in the promotion spec that have never been read
//      since they were introduced in c25d761.
//
// The structural assertions run first so a regression names its own cause; the
// whole-project typecheck is the load-bearing contract behind both.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const FRONTEND_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TSC = resolve(FRONTEND_ROOT, 'node_modules/typescript/bin/tsc');
const OWNERSHIP_TSCONFIG = resolve(FRONTEND_ROOT, 'tsconfig.e2e-ownership.json');
const PROMOTION_SPEC = resolve(FRONTEND_ROOT, 'tests/e2e/wave3-terminal-authority-promotion.spec.ts');

function readJsonc(path: string): Record<string, unknown> {
  // The repo's tsconfigs carry `//` comments; strip them before parsing.
  const stripped = readFileSync(path, 'utf8')
    .split('\n')
    .map(line => (/^\s*\/\//.test(line) ? '' : line))
    .join('\n');
  return JSON.parse(stripped) as Record<string, unknown>;
}

test('REL-BGSTAB-001 AC-3: the ownership E2E project references the vendored editor project', () => {
  const config = readJsonc(OWNERSHIP_TSCONFIG);
  const references = config.references;
  assert.ok(
    Array.isArray(references),
    'tsconfig.e2e-ownership.json must declare its own "references": project references are not '
      + 'inherited through "extends", so without this the vendored src/editor tree enters the '
      + 'program and reports TS1294',
  );
  assert.ok(
    (references as Array<{ path?: string }>).some(entry => entry?.path === './tsconfig.editor.json'),
    'tsconfig.e2e-ownership.json must reference ./tsconfig.editor.json',
  );
});

test('REL-BGSTAB-001 AC-3: the promotion spec declares no never-read DA1/snapshot helpers', () => {
  const source = readFileSync(PROMOTION_SPEC, 'utf8');
  for (const symbol of ['REPLY_DA1_CONPTY', 'waitForSnapshot']) {
    const occurrences = source.split(new RegExp(`\\b${symbol}\\b`)).length - 1;
    // Exactly one occurrence is a declaration nothing reads, which is the TS6133 state
    // this pins. Zero (deleted) and two-or-more (reintroduced and actually used, as the
    // sibling fairness spec does with its own waitForSnapshot) are both acceptable, so
    // this must not forbid the identifier outright.
    assert.notEqual(
      occurrences,
      1,
      `${symbol} occurs exactly once in the promotion spec, i.e. it is declared and never `
        + `read, which fails noUnusedLocals (TS6133). Either delete it or use it.`,
    );
  }
});

test('REL-BGSTAB-001 AC-3: tsconfig.e2e-ownership.json typechecks with zero errors', () => {
  // The referenced editor project emits declaration-only output under the gitignored
  // node_modules/.tmp; build it first or the reference resolves to TS6305.
  // Note: these are the same artifacts `npm run build` and `npm run typecheck` consume,
  // so this test shares a tsbuildinfo with them and must not run concurrently with a build.
  const built = spawnSync(process.execPath, [TSC, '-b', 'tsconfig.editor.json'], {
    cwd: FRONTEND_ROOT,
    encoding: 'utf8',
  });
  assert.equal(
    built.status,
    0,
    `precondition failed: tsc -b tsconfig.editor.json exited ${built.status}\n${built.stdout}${built.stderr}`,
  );

  const checked = spawnSync(process.execPath, [TSC, '--noEmit', '-p', 'tsconfig.e2e-ownership.json'], {
    cwd: FRONTEND_ROOT,
    encoding: 'utf8',
  });
  const diagnostics = `${checked.stdout}${checked.stderr}`.trim();
  assert.equal(
    diagnostics,
    '',
    `tsconfig.e2e-ownership.json must report no diagnostics, got:\n${diagnostics}`,
  );
  assert.equal(checked.status, 0, `tsc exited ${checked.status}`);
});
