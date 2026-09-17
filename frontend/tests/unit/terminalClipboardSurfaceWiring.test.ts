// FR-BGSTAB-021 — the clipboard verifying surface must stay connected.
//
// Both clipboard unit test files were green and neither ran: they were absent
// from tsconfig.test.json's `files` allowlist (so `npm run typecheck:tests`
// never saw them) and named by no npm script, while CI runs no frontend unit
// tests at all. Twelve passing tests that nothing invokes are indistinguishable
// from twelve tests that do not exist.
//
// This guard enumerates the clipboard test files from the directory rather than
// from a hard-coded list, so a newly added one is wired or this fails. The glob
// matches this file too, which is deliberate: a guard omitted from the allowlist
// and the script would be disconnected in exactly the way it exists to detect.
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

const clipboardTestFiles = readdirSync(UNIT_DIR)
  .filter(name => /Clipboard/.test(name) && name.endsWith('.test.ts'))
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
  const declared = new Set((files as string[]).map(entry => entry.replace(/^\.\//, '')));

  const missing = clipboardTestFiles.filter(name => !declared.has(`tests/unit/${name}`));
  assert.deepEqual(
    missing,
    [],
    'clipboard unit tests absent from tsconfig.test.json "files" are never typechecked: '
    + `${JSON.stringify(missing)}`,
  );
});

test('FR-BGSTAB-021: every clipboard unit test is named by the test:unit:clipboard script', () => {
  const scripts = (readJsonc('package.json') as { scripts?: Record<string, string> }).scripts ?? {};
  const script = scripts['test:unit:clipboard'];
  assert.equal(
    typeof script,
    'string',
    'package.json must define test:unit:clipboard; frontend unit suites run only from explicit scripts',
  );

  const missing = clipboardTestFiles.filter(name => !script.includes(`tests/unit/${name}`));
  assert.deepEqual(
    missing,
    [],
    `clipboard unit tests absent from test:unit:clipboard are run by nothing: ${JSON.stringify(missing)}`,
  );
});
