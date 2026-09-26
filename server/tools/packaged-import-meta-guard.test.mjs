/**
 * OPS-BGSTAB-017 AC-4.
 *
 * The first three tests are the guard itself; the rest exist so the first three
 * cannot pass by measuring nothing. A scanner that returns `[]` for every input
 * satisfies "no unguarded sites" perfectly, so each control below feeds it an
 * input it must report on.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  collectBundledSources,
  findUnguardedImportMetaSites,
  formatViolations,
  stripComments,
} from './packaged-import-meta-guard.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = resolve(HERE, '..', 'src');

const GUARDED = [
  "const MODULE_DIR = typeof __dirname === 'string'",
  '  ? __dirname',
  '  : dirname(fileURLToPath(import.meta.url));',
].join('\n');

const UNGUARDED = 'const MODULE_DIR = dirname(fileURLToPath(import.meta.url));';

function withTempTree(files, run) {
  const root = mkdtempSync(join(tmpdir(), 'bg-import-meta-guard-'));
  try {
    for (const [relativePath, contents] of Object.entries(files)) {
      const target = join(root, relativePath);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, contents, 'utf8');
    }
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * The scan covers all of `server/src`, not only the files that reach the bundle
 * today. Reachability is one `import` away from changing and nothing announces
 * it when it does, so a rule scoped to "currently reachable" would go quiet at
 * exactly the moment it started mattering. The guarded form costs nothing under
 * ESM — `__dirname` is undefined there and the ternary falls through — so the
 * broader rule has no downside to trade against.
 */
test('no server source reads import.meta.url unguarded', () => {
  const violations = findUnguardedImportMetaSites(SERVER_SRC);

  assert.deepEqual(
    violations,
    [],
    `These reads become fileURLToPath(undefined) once esbuild emits CJS, and the\n`
      + `packaged executable throws on start instead of failing the build:\n`
      + `${formatViolations(violations)}`,
  );
});

test('the scan actually reaches the files that carry the known guarded reads', () => {
  // Without this the first test passes when collectBundledSources silently
  // walks an empty or wrong directory.
  const scanned = collectBundledSources(SERVER_SRC).map((file) => file.replace(/\\/g, '/'));

  for (const expected of [
    'server/src/index.ts',
    'server/src/services/SSLService.ts',
    'server/src/utils/config.ts',
    'server/src/services/SessionManager.ts',
    'server/src/benchmarks/terminalFairnessCharacterization.ts',
  ]) {
    assert.equal(
      scanned.some((file) => file.endsWith(expected.slice('server/'.length))),
      true,
      `${expected} was not scanned`,
    );
  }
});

test('an unguarded read is reported with its file and line', () => {
  withTempTree({ 'a/mod.ts': `const x = 1;\n${UNGUARDED}\n` }, (root) => {
    const violations = findUnguardedImportMetaSites(root);

    assert.deepEqual(violations.map(({ file, line }) => ({ file, line })), [
      { file: 'a/mod.ts', line: 2 },
    ]);
  });
});

test('the three-line guarded shape is not reported', () => {
  withTempTree({ 'a/mod.ts': `${GUARDED}\n` }, (root) => {
    assert.deepEqual(findUnguardedImportMetaSites(root), []);
  });
});

test('a guard further than the lookbehind window is still reported', () => {
  // The window is deliberately narrow: a `typeof __dirname` check ten lines
  // above is not guarding this read, and treating it as if it were would let a
  // real unguarded site through in any file that happens to guard once.
  const text = [
    "const OTHER = typeof __dirname === 'string' ? __dirname : '';",
    '',
    '',
    '',
    UNGUARDED,
  ].join('\n');

  withTempTree({ 'a/mod.ts': `${text}\n` }, (root) => {
    assert.deepEqual(findUnguardedImportMetaSites(root).map((v) => v.line), [5]);
  });
});

test('a read named only inside a comment is not reported', () => {
  const text = [
    '/**',
    ' * Historically this read fileURLToPath(import.meta.url) directly.',
    ' */',
    "const MODULE_DIR = __dirname; // was: fileURLToPath(import.meta.url)",
  ].join('\n');

  withTempTree({ 'a/mod.ts': `${text}\n` }, (root) => {
    assert.deepEqual(findUnguardedImportMetaSites(root), []);
  });
});

test('test sources are not scanned', () => {
  withTempTree({ 'a/mod.test.ts': `${UNGUARDED}\n` }, (root) => {
    assert.deepEqual(findUnguardedImportMetaSites(root), []);
  });
});

test('stripComments preserves line numbers', () => {
  const stripped = stripComments('/* a\nb\nc */\nconst x = 1;\n');

  assert.equal(stripped.split('\n').length, 5);
  assert.equal(stripped.split('\n')[3], 'const x = 1;');
});

test('stripComments leaves comment-like text inside string literals alone', () => {
  const stripped = stripComments(`const u = 'https://example.test/a';\n`);

  assert.match(stripped, /https:\/\/example\.test\/a/);
});
