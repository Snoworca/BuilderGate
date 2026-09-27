import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolve } from 'node:path';
import { evidenceRootCandidates, resolveDefaultTerminalWireFormat } from './terminalWireFormatDefault.js';

/**
 * MIG-BGSTAB-004 AC-1/AC-2/AC-4: the default is binary only while the evidence
 * says so, and json otherwise.
 *
 * The gate is not ceremonial. `smallOutputBypassBytes` classifies a delivery by
 * its wire `byteLength` (terminalFairnessCharacterization.ts, createBaselineQueue),
 * and a JSON envelope and a binary frame carrying the same body have different
 * wire sizes -- measured 2026-09-21 at 10356B vs 6599B for one TUI redraw. A
 * payload can therefore sit above the bypass threshold under one codec and below
 * it under the other, which is a scheduling change, not an encoding detail.
 *
 * So the default resolves from the artifact rather than from a constant, and
 * every way of not having good evidence resolves to json.
 */

const ACCEPTED_BINARY = Object.freeze({
  accepted: true,
  allRegisteredThresholdsPassed: true,
  hasUnboundedEligibleLaneStarvation: false,
  workload: { codec: 'binary' },
});

test('MIG-BGSTAB-004 AC-1 an accepted binary-generation artifact makes the default binary', () => {
  assert.equal(resolveDefaultTerminalWireFormat({ artifact: ACCEPTED_BINARY }), 'binary');
});

test('MIG-BGSTAB-004 AC-1 fail-closed: every way of lacking evidence resolves to json', () => {
  const cases: ReadonlyArray<readonly [string, unknown]> = [
    ['no artifact at all', undefined],
    ['null artifact', null],
    ['not an object', 'accepted'],
    ['empty object', {}],
    ['a JSON-generation artifact', { ...ACCEPTED_BINARY, workload: { codec: 'json' } }],
    ['no codec recorded', { ...ACCEPTED_BINARY, workload: {} }],
    ['no workload recorded', { ...ACCEPTED_BINARY, workload: undefined }],
    ['rejected', { ...ACCEPTED_BINARY, accepted: false }],
    ['a threshold did not pass', { ...ACCEPTED_BINARY, allRegisteredThresholdsPassed: false }],
    ['an eligible lane starved', { ...ACCEPTED_BINARY, hasUnboundedEligibleLaneStarvation: true }],
    ['accepted is not a boolean', { ...ACCEPTED_BINARY, accepted: 'yes' }],
    ['starvation flag missing', { accepted: true, allRegisteredThresholdsPassed: true, workload: { codec: 'binary' } }],
  ];
  for (const [label, artifact] of cases) {
    assert.equal(
      resolveDefaultTerminalWireFormat({ artifact }),
      'json',
      `${label} must fail closed`,
    );
  }
});

test('MIG-BGSTAB-004 AC-2 an explicit configured value always wins over the resolved default', () => {
  // Rollback is "put json in the config file", so the config can never be
  // overridden by the artifact — in either direction.
  assert.equal(
    resolveDefaultTerminalWireFormat({ artifact: ACCEPTED_BINARY, configured: 'json' }),
    'json',
  );
  assert.equal(
    resolveDefaultTerminalWireFormat({ artifact: undefined, configured: 'binary-optin' }),
    'binary-optin',
  );
  assert.equal(
    resolveDefaultTerminalWireFormat({ artifact: undefined, configured: 'binary' }),
    'binary',
    'an operator may set binary explicitly; the gate governs the default, not the key',
  );
});

test('MIG-BGSTAB-004 AC-4 resolution is a pure read and never throws on hostile input', () => {
  // The artifact is a file on disk. A tampered one must degrade, not crash the
  // boot path, because a server that will not start is a worse outcome than a
  // server on json.
  const hostile: unknown[] = [
    { get accepted() { throw new Error('boom'); } },
    { workload: { get codec() { throw new Error('boom'); } }, accepted: true },
    [],
    0,
    Number.NaN,
  ];
  for (const artifact of hostile) {
    assert.equal(resolveDefaultTerminalWireFormat({ artifact }), 'json');
  }
});

// MIG-BGSTAB-006: the packaged exe runs the bundled CJS from `server/dist-pkg`, where neither
// the compiled (`dist/ws`) nor the source (`src/ws`) layout matches, so the evidence was never
// found and every exe fell back to json (the browser saw `group-not-eligible`).
test('MIG-BGSTAB-006 AC-1 the packaged layout (server/dist-pkg) looks for the bundle in server/dist/benchmarks', () => {
  const server = resolve('/opt/app/server');
  const candidates = evidenceRootCandidates(resolve(server, 'dist-pkg'));
  assert.ok(candidates.includes(resolve(server, 'dist/benchmarks/fair-scheduler-evidence')), candidates.join(' | '));
});

test('MIG-BGSTAB-006 AC-2 the compiled and source layouts keep their existing candidates', () => {
  const server = resolve('/opt/app/server');
  assert.ok(evidenceRootCandidates(resolve(server, 'dist/ws')).includes(resolve(server, 'dist/benchmarks/fair-scheduler-evidence')));
  assert.ok(evidenceRootCandidates(resolve(server, 'src/ws')).includes(resolve(server, 'dist/benchmarks/fair-scheduler-evidence')));
});
