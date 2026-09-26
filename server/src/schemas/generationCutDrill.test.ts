import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  GENERATION_CUT_STEPS,
  runGenerationCutDrill,
  type GenerationCutDrillDeps,
  type GenerationCutDrillReport,
} from './generationCutDrill.js';
import {
  createFairTerminalDeliveryScheduler,
  type FairTerminalDelivery,
  type FairTerminalDeliveryPolicy,
} from '../ws/wsSendPolicy.js';

/**
 * OPS-BGSTAB-015 — steps 3 and 4 of the #21 rollback drill: cut the connection
 * generation, renegotiate, and observe the fresh authoritative snapshot arrive on the
 * new generation.
 *
 * Every control below breaks the mechanism in exactly one way and asserts the drill goes
 * red. The one that matters most is `drill fails when the old generation never accepted
 * anything`: without that observation, "the stale delivery was refused" is satisfied by a
 * scheduler that refuses everything, which is the cheapest thing that satisfies AC-2.
 */

function policy(): FairTerminalDeliveryPolicy {
  const at = <T>(value: T) => ({ value, source: 'OPS-BGSTAB-015 drill fixture' });
  return {
    strategy: at('deficit-round-robin'),
    socketSoftGateBytes: at(1 << 20),
    bulkSliceBytes: at(1 << 16),
    smallOutputBypassBytes: at(1 << 14),
    visibilityWeight: at(1),
    driverWeight: at(1),
    creditWindowBytes: at(1 << 20),
    ackTimeoutMs: at(10_000),
    queueMaxBytes: at(1 << 20),
  };
}

/** The real scheduler, not a stand-in for one (AC-5). */
function realScheduler() {
  const sent: FairTerminalDelivery[] = [];
  let now = 0;
  const scheduler = createFairTerminalDeliveryScheduler({
    now: () => (now += 1),
    policy: policy(),
    decisionArtifact: {
      state: 'complete',
      allRegisteredThresholdsPassed: true,
      hasUnboundedEligibleLaneStarvation: false,
    },
    send: (delivery) => { sent.push(delivery); },
    onSemanticStatusChange: () => {},
  });
  return { scheduler, sent };
}

function depsFor(overrides: Partial<GenerationCutDrillDeps> = {}): GenerationCutDrillDeps {
  const { scheduler, sent } = realScheduler();
  return {
    sessionId: 'drill-session',
    retiringEpoch: 'epoch-1',
    renegotiatedEpoch: 'epoch-2',
    enqueue: (input) => scheduler.enqueue(input),
    cutGeneration: (epoch) => { scheduler.closeConnection(epoch); },
    drain: () => { scheduler.drain(); },
    observeSent: () => sent.map((delivery) => ({
      connectionEpoch: delivery.connectionEpoch,
      sessionId: delivery.sessionId,
      kind: delivery.kind,
    })),
    ...overrides,
  };
}

function step(report: GenerationCutDrillReport, name: string) {
  const found = report.steps.find((entry) => entry.step === name);
  assert.ok(found, `report has no step ${name}`);
  return found;
}

test('OPS-BGSTAB-015: the drill runs every step and ends green against the real scheduler', () => {
  const report = runGenerationCutDrill(depsFor());
  assert.equal(report.ok, true, JSON.stringify(report.steps, null, 2));
  assert.deepEqual(report.steps.map((entry) => entry.step), [...GENERATION_CUT_STEPS]);
  assert.ok(report.steps.every((entry) => entry.ran && entry.ok));
});

test('OPS-BGSTAB-015 AC-1: the pre-cut acceptance is observed and recorded', () => {
  const report = runGenerationCutDrill(depsFor());
  assert.equal(report.preCutAccepted, true);
  assert.match(step(report, 'observe-pre-cut').detail, /accepted/);
});

test('OPS-BGSTAB-015 AC-1: a mechanism that refuses everything fails the drill at the control, not at the cut', () => {
  const report = runGenerationCutDrill(depsFor({
    enqueue: () => ({ accepted: false, reason: 'refuses-everything' }),
  }));
  assert.equal(report.ok, false);
  assert.equal(step(report, 'observe-pre-cut').ok, false);
  // The later steps must not be credited: a refuse-everything scheduler would otherwise
  // satisfy AC-2's "the stale delivery was refused" for free.
  assert.equal(step(report, 'observe-cut').ran, false);
});

test('OPS-BGSTAB-015 AC-2: the refusal reason is recorded, not just the absence of a delivery', () => {
  const report = runGenerationCutDrill(depsFor());
  assert.equal(report.staleRefusalReason, 'connection-epoch-retired');
  assert.match(step(report, 'observe-cut').detail, /connection-epoch-retired/);
});

test('OPS-BGSTAB-015 AC-2: a cut that does not retire the generation fails the drill', () => {
  const report = runGenerationCutDrill(depsFor({ cutGeneration: () => {} }));
  assert.equal(report.ok, false);
  assert.equal(step(report, 'observe-cut').ok, false);
});

test('OPS-BGSTAB-015 AC-3: renegotiation is observed as the new generation accepting', () => {
  const report = runGenerationCutDrill(depsFor());
  assert.equal(step(report, 'renegotiate').ok, true);
  assert.equal(report.renegotiatedEpochAccepted, true);
});

test('OPS-BGSTAB-015 AC-4: the snapshot is observed at the transport, not at the queue', () => {
  const report = runGenerationCutDrill(depsFor({ drain: () => {} }));
  assert.equal(report.ok, false);
  assert.equal(step(report, 'observe-snapshot').ok, false);
  assert.match(step(report, 'observe-snapshot').detail, /never reached the transport/);
});

test('OPS-BGSTAB-015 AC-4: a snapshot observed on the retired generation fails the drill', () => {
  const deps = depsFor();
  const report = runGenerationCutDrill({
    ...deps,
    observeSent: () => [{ connectionEpoch: 'epoch-1', sessionId: 'drill-session', kind: 'control' }],
  });
  assert.equal(report.ok, false);
  assert.equal(step(report, 'observe-snapshot').ok, false);
});

test('OPS-BGSTAB-015 AC-6: the drill reads no gate key and moves no default', () => {
  const report = runGenerationCutDrill(depsFor());
  assert.equal(report.movedGateKeys.length, 0);
});
