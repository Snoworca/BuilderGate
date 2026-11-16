// OPS-BGSTAB-024: the Linux release must boot on glibc 2.39 (Ubuntu 24.04). v0.11.4 linux-amd64 was
// built on ubuntu-latest and its pty.node asked for GLIBC_2.42, so it failed to start on Ubuntu
// 24.04 with "Failed to load native module: pty.node" (10.0.0.50, 2026-11-16).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { highestGlibc, MAX_GLIBC, versionAbove } from './check-linux-glibc.mjs';

const OBJDUMP = [
  '0000000000000000      DF *UND*  0000000000000000 (GLIBC_2.2.5) free',
  '0000000000000000      DF *UND*  0000000000000000 (GLIBC_2.34) pthread_create',
  '0000000000000000      DF *UND*  0000000000000000 (GLIBC_2.42) __isoc23_strtol',
  '0000000000000000      DF *UND*  0000000000000000 (GLIBCXX_3.4.33) _ZNSt',
].join('\n');

test('OPS-BGSTAB-024 AC-2: the highest GLIBC a binary asks for is read from objdump -T, versions compared as numbers', () => {
  assert.equal(highestGlibc(OBJDUMP), '2.42');
  assert.equal(highestGlibc('(GLIBC_2.9) a\n(GLIBC_2.17) b\n(GLIBC_2.3.4) c'), '2.17');
  assert.equal(highestGlibc('no versions here'), undefined);
  assert.equal(MAX_GLIBC, '2.39');
  assert.equal(versionAbove('2.42', MAX_GLIBC), true);
  assert.equal(versionAbove('2.39', MAX_GLIBC), false);
  assert.equal(versionAbove('2.4', MAX_GLIBC), false, '2.4 is older than 2.39');
});

test('OPS-BGSTAB-024 AC-1/AC-3: release.yml builds Linux on pinned runners and checks pty.node before packaging', () => {
  const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  for (const target of ['linux-amd64', 'linux-arm64']) {
    const block = workflow.slice(workflow.indexOf(`- target: ${target}`), workflow.indexOf('- target:', workflow.indexOf(`- target: ${target}`) + 1));
    const runner = /runner:\s*(\S+)/u.exec(block)?.[1];
    assert.ok(runner, `${target} has a runner`);
    assert.notEqual(runner, 'ubuntu-latest', `${target} must not float with ubuntu-latest`);
    assert.match(runner, /^ubuntu-24\.04(-arm)?$/u, `${target} runner ${runner}`);
  }
  const check = workflow.indexOf('node tools/check-linux-glibc.mjs');
  assert.ok(check > 0, 'the workflow runs the glibc check');
  assert.ok(check < workflow.indexOf("if: matrix.archive == 'tar.gz'"), 'the check runs before the Linux archive is packaged');
});
