import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// PERF-BGSTAB-010 AC-3/4: run after server build. Exercise actual Git clean /
// checkout filters without changing the index, source files or worktrees.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function assertCheckoutPreservesBytes(path) {
  const bytes = readFileSync(path);
  const gitPath = relative(root, path).replaceAll('\\', '/');
  assert.ok(!gitPath.split('/').includes('..'));
  const options = { cwd: root, windowsHide: true, maxBuffer: 16 * 1024 * 1024 };
  const blob = execFileSync('git', ['-c', 'core.autocrlf=true', 'hash-object', '-w', '--stdin', `--path=${gitPath}`], {
    ...options, input: bytes, encoding: 'utf8',
  }).trim();
  const checkout = execFileSync('git', ['-c', 'core.autocrlf=true', 'cat-file', '--filters', `--path=${gitPath}`, blob], options);
  assert.equal(hash(checkout), hash(bytes), `${gitPath}: ordinary checkout must preserve the published raw-byte hash`);
}

test('fair scheduler pinned sources retain raw-byte provenance through Git checkout', async t => {
  const manifest = JSON.parse(readFileSync(join(root, 'server/dist/benchmarks/fair-scheduler-source-provenance.json'), 'utf8'));
  assert.ok(Array.isArray(manifest.inputs) && manifest.inputs.length > 0, 'build must provide a nonempty source inventory');
  for (const input of manifest.inputs) {
    assert.match(input.path, /^src\//);
    assert.ok(!input.path.split('/').includes('..'));
    await t.test(input.path, () => assertCheckoutPreservesBytes(join(root, 'server', input.path)));
  }
});

test('fair scheduler current authority JSON retains raw-byte hashes through Git checkout', async t => {
  const authority = join(root, 'docs/analysis/terminal-fairness-authority');
  const pointerPath = join(authority, 'current.json');
  const pointer = JSON.parse(readFileSync(pointerPath, 'utf8'));
  assert.match(pointer.generation_id, /^[a-f0-9]{64}$/);
  const paths = [pointerPath];
  const collect = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      assert.equal(entry.isSymbolicLink(), false, 'authority inventory cannot hide a linked entry');
      const path = join(directory, entry.name);
      if (entry.isDirectory()) collect(path);
      else if (entry.isFile() && entry.name.endsWith('.json')) paths.push(path);
    }
  };
  collect(join(authority, 'generations', pointer.generation_id));
  assert.ok(paths.length > 1, 'authority generation must not be empty');
  for (const path of paths) {
    await t.test(relative(authority, path), () => assertCheckoutPreservesBytes(path));
  }
});
