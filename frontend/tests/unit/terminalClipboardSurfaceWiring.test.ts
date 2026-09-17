// FR-BGSTAB-021 — the clipboard verifying surface must stay connected.
//
// Both clipboard unit test files were green and neither ran: they were absent
// from tsconfig.test.json's `files` allowlist (so `npm run typecheck:tests`
// never saw them) and named by no npm script. Twelve passing tests that nothing
// invokes are indistinguishable from twelve tests that do not exist.
//
// What this guard does NOT establish, stated here because the omission is
// silent: it only runs when something runs it, and the only executor today is
// the very `test:unit:clipboard` script it validates. `tsconfig.test.json` is
// deliberately absent from tsconfig.json's `references` (see the comment at the
// top of that file), so `tsc -b` does not compile these files either, and the
// release workflow invokes only `build:*` scripts. Deleting `test:unit:clipboard`
// outright therefore still reddens nothing. Closing that requires a CI change
// with repo-wide blast radius and is not in this requirement's scope.
//
// The enumeration reads the directory rather than a fixed list, so a newly added
// clipboard unit test is wired or this fails. Its bound is `tests/unit`: a
// clipboard test placed elsewhere is not seen.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FRONTEND_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const UNIT_DIR = `${FRONTEND_ROOT}tests/unit`;

// The repo's tsconfigs carry `//` comments; strip them before parsing.
const readJsonc = (relativePath: string): unknown => JSON.parse(
  readFileSync(`${FRONTEND_ROOT}${relativePath}`, 'utf8').replace(/^\s*\/\/.*$/gm, ''),
);

// Case-insensitive, and .tsx as well as .ts: a file named clipboardPaste.test.ts
// or TerminalClipboard.test.tsx is exactly as disconnectable as the two known
// suites, and a guard that cannot see it reports a clean result over a subset.
const clipboardTestFiles = readdirSync(UNIT_DIR)
  .filter(name => /clipboard/i.test(name) && /\.test\.tsx?$/.test(name))
  .sort();

test('FR-BGSTAB-021: the clipboard unit tests are discoverable at all', () => {
  // Without this the two assertions below are vacuously true over an empty list,
  // which is the same shape of empty-set pass the guard exists to prevent.
  assert.ok(
    clipboardTestFiles.length >= 2,
    `expected the clipboard unit tests to be present, found ${JSON.stringify(clipboardTestFiles)}`,
  );
  assert.ok(
    clipboardTestFiles.includes('terminalClipboardCoordinator.test.ts')
    && clipboardTestFiles.includes('terminalClipboardAdapterContract.test.ts'),
    `expected both clipboard suites, found ${JSON.stringify(clipboardTestFiles)}`,
  );
});

test('FR-BGSTAB-021: every clipboard unit test is in the tsconfig.test.json program', () => {
  const files = (readJsonc('tsconfig.test.json') as { files?: unknown }).files;
  assert.ok(Array.isArray(files), 'tsconfig.test.json must declare a "files" allowlist');
  // Entries are written with and without a leading "./" in this file, and a path
  // separator difference must not read as a missing entry.
  const declared = new Set(
    (files as string[]).map(entry => entry.replace(/\\/g, '/').replace(/^\.\//, '')),
  );

  const missing = clipboardTestFiles.filter(name => !declared.has(`tests/unit/${name}`));
  assert.deepEqual(
    missing,
    [],
    'clipboard unit tests absent from tsconfig.test.json "files" are never typechecked: '
    + `${JSON.stringify(missing)}`,
  );
});

test('FR-BGSTAB-021: test:unit:clipboard runs every clipboard unit test as a runner argument', () => {
  const scripts = (readJsonc('package.json') as { scripts?: Record<string, string> }).scripts ?? {};
  const script = scripts['test:unit:clipboard'];
  assert.equal(
    typeof script,
    'string',
    'package.json must define test:unit:clipboard; frontend unit suites run only from explicit scripts',
  );

  // Substring matching would accept `echo tests/unit/foo.test.ts`, which names
  // every file and runs none. Tokenise and require an actual test-runner
  // invocation with each file as its own argument.
  const tokens = script.split(/\s+/).filter(Boolean);
  assert.ok(
    tokens[0] === 'node' && tokens.includes('--test'),
    `test:unit:clipboard must invoke the node test runner, got: ${script}`,
  );
  const args = new Set(tokens.map(token => token.replace(/\\/g, '/')));

  const missing = clipboardTestFiles.filter(name => !args.has(`tests/unit/${name}`));
  assert.deepEqual(
    missing,
    [],
    `clipboard unit tests absent from test:unit:clipboard are run by nothing: ${JSON.stringify(missing)}`,
  );
});
