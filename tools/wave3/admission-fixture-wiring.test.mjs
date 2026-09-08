import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import * as actorCleanup from './fixture-actor-cleanup.mjs';
const require = createRequire(import.meta.url), ts = require('../../server/node_modules/typescript/lib/typescript.js');
const root = 'C:\\virtual-canonical', parent = path.win32.join(root, 'docs/analysis/kiwi-coder-2026-07-27.pm.fair-readmission-closure-v3');
import { loadFixtureHarness as load } from './internal/admission-fixture-test-harness.mjs';

test('AC5 wiring loads the actual helper in the same inert environment with separate parent and nonce mutations', () => {
  const h = load('trust'); const helper = h.loadHelper(); const leaf = helper.createOwnedAnalysisLeaf('directory-control');
  leaf.createDirectory(); leaf.cleanup();
  assert.ok(h.present.has(parent)); assert.equal(h.present.has(path.win32.normalize(leaf.manifestPath)), false);
  assert.ok(h.nativeChecks.length > 0);
  assert.equal(h.mutations.filter(([op, target]) => op === 'mkdir' && target === parent).length, 1);
  assert.equal(h.mutations.filter(([op, target]) => op === 'rmdir' && target === leaf.manifestPath).length, 1);
});

for (const [name, title] of [
  ['lexical', 'SDS-AC-1 and SDS-AC-4 retain private native capture, fixed Git, and a complete default frozen closure'],
  ['wave', 'SDS-AC-3 publishes a deterministic deduplicated source closure only after native capture succeeds'],
]) {
  test(`AC5 actual ${name} normal capture persists manifest and cleans only helper-owned nonce`, async () => {
    const h = load(name); const callback = h.callbacks.get(title); assert.equal(typeof callback, 'function');
    await callback();
    assert.ok(h.loadedModules.includes('./admission-fixture-ownership.mjs'), 'actual capability module must own capture');
    const captures = h.mutations.filter(([operation]) => operation === 'capture'); assert.equal(captures.length, 1);
    assert.equal(path.win32.dirname(captures[0][1]), parent);
    assert.equal(h.present.has(captures[0][1]), false); assert.equal(h.present.has(parent), true);
    assert.equal(h.mutations.some(([operation, target]) => ['rm', 'rmdir', 'unlink'].includes(operation) && target === parent), false);
  });
  test(`AC5 actual ${name} post-capture scenario and cleanup errors are both preserved`, async () => {
    const h = load(name); const scenario = Error('scenario read failure'), cleanup = Error('cleanup failure');
    h.faults.scenarioError = scenario; h.faults.cleanupError = cleanup;
    await assert.rejects(h.callbacks.get(title)(), error => {
      assert.ok(error instanceof AggregateError); assert.ok(error.errors.includes(scenario)); assert.ok(error.errors.includes(cleanup)); return true;
    });
    const captures = h.mutations.filter(([operation]) => operation === 'capture'); assert.equal(captures.length, 1);
    assert.ok(h.present.has(captures[0][1]), 'failed cleanup must retain owned manifest');
  });
}
for (const [name, match] of [['trust', 'rejects real directory leaves'], ['seal', 'rejects an unexpected manifest-leaf directory']]) {
  test(`AC5 actual ${name} directory-role callback never mutates original checkout paths`, async () => {
    const h = load(name); const matches = [...h.callbacks].filter(([title]) => title.includes(match)); assert.equal(matches.length, 1);
    // Later scenario assertions need richer collector ports; preserve any error but
    // inspect the real setup/finally mutations before classifying the observed path.
    let scenarioError; try { await matches[0][1](); } catch (error) { scenarioError = error; }
    assert.ok(h.mutations.length > 0, 'actual directory adversary must execute, not an omitted callback');
    const leaves = h.mutations.filter(([, target]) => path.win32.dirname(target) === parent);
    assert.ok(leaves.some(([operation]) => operation === 'mkdir'), 'directory-role nonce must still be created');
    for (const [operation, target] of h.mutations) {
      if (target === parent) { assert.equal(operation, 'mkdir', 'shared parent can only be established, never cleaned'); assert.ok(h.nativeChecks.length > 0); }
      else assert.equal(path.win32.dirname(target), parent, 'nonce mutations belong to the virtual module checkout');
    }
    if (scenarioError) throw scenarioError;
  });
}
test('AC5 actual remediation pre-existing regular sentinel callback preserves its assertions and shared parent', async () => {
  const h = load('remediation');
  const selected = [...h.callbacks].filter(([title]) => title === 'test capture helper preserves a pre-existing manifest leaf when its absence precondition fails');
  assert.equal(selected.length, 1, 'execute the current actual callback, not a removed helper or replacement stub');
  await selected[0][1]();
  assert.ok(h.mutations.some(([operation, , data]) => operation === 'write' && data === '{"owned":"pre-existing"}\n'));
  assert.ok(h.present.has(parent), 'shared canonical analysis parent must not be removed by leaf cleanup');
  assert.equal(h.mutations.some(([operation, target]) => target === parent && ['rmdir', 'rm'].includes(operation)), false);
});

const snapshotTitle = 'SDS-AC-3 publishes source, config, and fixture manifest rows whose digests match their native capture bytes';
test('AC5 actual snapshot normal capture preserves all three row digest assertions and helper-owned cleanup', async () => {
  const h = load('snapshot'); await h.callbacks.get(snapshotTitle)();
  assert.ok(h.loadedModules.includes('./admission-fixture-ownership.mjs'));
  const captures = h.mutations.filter(([op]) => op === 'capture'); assert.equal(captures.length, 1);
  assert.equal(h.present.has(captures[0][1]), false); assert.ok(h.present.has(parent));
});
test('AC5 actual snapshot cleanup cannot delete a post-capture same-byte foreign replacement', async () => {
  const h = load('snapshot'); h.faults.replaceOnManifestRead = true;
  await assert.rejects(h.callbacks.get(snapshotTitle)());
  const captures = h.mutations.filter(([op]) => op === 'capture'); assert.equal(captures.length, 1);
  assert.ok(h.present.has(captures[0][1]), 'replacement must survive cleanup');
  assert.equal(h.mutations.some(([op, target]) => op === 'unlink' && target === captures[0][1]), false);
});
test('AC5 actual snapshot retains original scenario and cleanup errors together', async () => {
  const h = load('snapshot'), scenario = Error('snapshot scenario'), cleanup = Error('snapshot cleanup');
  h.faults.scenarioError = scenario; h.faults.cleanupError = cleanup;
  await assert.rejects(h.callbacks.get(snapshotTitle)(), error => error instanceof AggregateError && error.errors.includes(scenario) && error.errors.includes(cleanup));
});
for (const prefix of ['SDS-AC-1 keeps the protected snapshot private', 'SDS-AC-2 rejects caller reparse and snapshot state']) {
  test(`AC5 snapshot raw invalid admission preserves unconfirmed publication: ${prefix}`, async () => {
    const h = load('snapshot'); h.faults.invalidCapturePublishes = true;
    const callback = [...h.callbacks].find(([title]) => title.startsWith(prefix))?.[1]; assert.equal(typeof callback, 'function');
    await assert.rejects(callback());
    assert.equal(h.mutations.some(([op]) => ['unlink', 'rm', 'rmdir'].includes(op)), false, 'rejected raw capture never granted ownership');
    assert.ok([...h.present].some(p => path.win32.dirname(p) === parent));
  });
}
