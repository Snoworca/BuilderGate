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
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
// @ts-expect-error -- plain JS tooling module, intentionally untyped
import { acquireTscBuildLock } from '../../tools/tscBuildLock.mjs';

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

// referenceCount is a SYNTACTIC APPROXIMATION, not an implementation of noUnusedLocals.
// Its job is to name the cause quickly when the tsc run below goes red; the tsc run is
// the oracle and is strictly stronger.
//
// It is accurate enough to be useful: parsing (rather than counting textual matches)
// means comments and string literals no longer contribute, and member-name positions are
// excluded so `o.waitForSnapshot` cannot pass for a read. It still OVER-COUNTS in binding
// positions it cannot resolve without a TypeChecker — a same-named parameter, a nested
// class or interface of the same name, a labeled statement, an enum member, a class
// field, a JSX attribute, a type alias, and import/export specifier names all count as
// reads. Every one of those errs toward PASS, i.e. toward masking the TS6133 state.
// That is acceptable only because `tsc --noEmit -p tsconfig.e2e-ownership.json` below
// asserts zero diagnostics and would still fail. Do not read a pass here as a guarantee,
// and do not chase the remaining cases: closing them needs symbol resolution, and the
// authoritative check already exists.
function referenceCount(source: ts.SourceFile, symbol: string): { declared: boolean; reads: number } {
  let declared = false;
  let reads = 0;
  const visit = (node: ts.Node): void => {
    const isDeclarationName = (ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node))
      && node.name !== undefined && ts.isIdentifier(node.name) && node.name.text === symbol;
    if (isDeclarationName) declared = true;
    if (ts.isIdentifier(node) && node.text === symbol) {
      const parent = node.parent;
      // A same-named identifier is only a read of the module binding when it is not the
      // declaration's own name and not a member/property name, which belongs to some
      // other object and would make an unread declaration look used.
      const isBindingRead = parent === undefined || !(
        ((ts.isVariableDeclaration(parent) || ts.isFunctionDeclaration(parent)) && parent.name === node)
        || (ts.isPropertyAccessExpression(parent) && parent.name === node)
        || (ts.isPropertyAssignment(parent) && parent.name === node)
        || (ts.isPropertySignature(parent) && parent.name === node)
        || (ts.isMethodDeclaration(parent) && parent.name === node)
        || (ts.isMethodSignature(parent) && parent.name === node)
        || (ts.isQualifiedName(parent) && parent.right === node)
        || (ts.isBindingElement(parent) && parent.propertyName === node)
      );
      if (isBindingRead) reads += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { declared, reads };
}

test('REL-BGSTAB-001 AC-3: the promotion spec declares no never-read DA1/snapshot helpers', () => {
  const source = ts.createSourceFile(
    PROMOTION_SPEC, readFileSync(PROMOTION_SPEC, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS,
  );
  for (const symbol of ['REPLY_DA1_CONPTY', 'waitForSnapshot']) {
    const { declared, reads } = referenceCount(source, symbol);
    // Deleted, or declared and actually read (as the sibling fairness spec does with its
    // own waitForSnapshot), are both fine. Declared with zero reads is the TS6133 state.
    assert.ok(
      !declared || reads > 0,
      `${symbol} is declared in the promotion spec and this syntactic scan found no `
        + `identifier reference to it. That is the shape of a TS6133 "declared but never `
        + `read", but this check does not resolve symbols, so treat it as a lead: the `
        + `tsc --noEmit assertion in this file is what actually decides.`,
    );
  }
});

// Pin referenceCount's ACTUAL behaviour, including where it is deliberately approximate.
// Without this the helper could quietly start counting member names or comment text as
// reads and would then pass over exactly the TS6133 state it exists to flag.
const REFERENCE_CASES: ReadonlyArray<readonly [string, string, boolean, number]> = [
  // label, source, expected declared, expected reads
  ['declared, never read', 'const S = 1;', true, 0],
  ['declared and read', 'const S = 1; console.log(S);', true, 1],
  ['member name only', 'const S = 1; const o = { a: 1 }; o.S;', true, 0],
  ['object key only', 'const S = 1; const o = { S: 2 };', true, 0],
  ['comment mention only', 'const S = 1; // S is interesting', true, 0],
  ['string mention only', 'const S = 1; const t = "S";', true, 0],
  ['shorthand property is a read', 'const S = 1; const o = { S };', true, 1],
  ['type member name only', 'const S = 1; interface I { S: number }', true, 0],
  ['qualified type name only', 'const S = 1; type T = ns.S;', true, 0],
  ['absent, comment only', '// S is interesting', false, 0],
  ['function declared, never called', 'function S() {}', true, 0],
  ['function declared and called', 'function S() {} S();', true, 1],
];

for (const [label, code, expectedDeclared, expectedReads] of REFERENCE_CASES) {
  test(`REL-BGSTAB-001 AC-3: referenceCount — ${label}`, () => {
    const source = ts.createSourceFile('case.ts', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    assert.deepEqual(
      referenceCount(source, 'S'),
      { declared: expectedDeclared, reads: expectedReads },
      `referenceCount mis-read: ${code}`,
    );
  });
}

test('REL-BGSTAB-001 AC-3: tsconfig.e2e-ownership.json typechecks with zero errors', async () => {
  // The referenced editor project emits declaration-only output under the gitignored
  // node_modules/.tmp; build it first or the reference resolves to TS6305. Those are the
  // same artifacts `npm run build` and `npm run typecheck` write, so all three writers
  // serialize on one lock (#55). Building somewhere private instead would stop exercising
  // the project reference this test exists to verify, so the artifact stays shared.
  const release = await acquireTscBuildLock({ label: 'e2eOwnershipTypecheck.test.ts' });
  try {
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
  } finally {
    release();
  }
});
