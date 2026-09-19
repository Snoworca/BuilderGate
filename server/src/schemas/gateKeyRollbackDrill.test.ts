import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DRILL_STEPS,
  runGateKeyRollbackDrill,
  type DrillReport,
  type GateKeyRollbackDrillDeps,
} from './gateKeyRollbackDrill.js';
import { TERMINAL_PATH_GATE_KEYS } from './terminalPathGateKeys.js';
import {
  buildTerminalPathGateKeyBackup,
  type TerminalPathGateKeyState,
} from './terminalPathGateKeyBackup.js';

/**
 * OPS-BGSTAB-013. Every control below injects a mechanism that is broken in one specific
 * way and asserts the drill goes red. Without them the drill asserts only that a happy
 * path is happy, which is the failure this requirement was written against.
 */

const PROVENANCE = {
  serverBuild: 'drill-test',
  configSourcePath: '/owned/config.json5',
  schemaShapeId: 'sha256:test',
} as const;

/** A mutable world the drill reads and writes through its injected effects. */
function world(initial = 'observe') {
  const values: Record<string, string> = {
    wsTransportMode: 'unified',
    terminalWireFormat: 'json',
    headlessQueueMode: initial,
    wsSendMode: 'direct',
    frontendRuntimeResidency: 'bounded',
    hiddenOutputPolicy: 'snapshot-restore',
  };
  return values;
}

function depsFor(
  values: Record<string, string>,
  overrides: Partial<GateKeyRollbackDrillDeps> = {},
): GateKeyRollbackDrillDeps {
  return {
    captureBackup: () => {
      const state = Object.fromEntries(
        Object.entries(values).map(([name, value]) => [name, { effectiveValue: value, explicit: false }]),
      ) as TerminalPathGateKeyState;
      return buildTerminalPathGateKeyBackup(state, PROVENANCE, new Date(0));
    },
    applyValue: (value) => { values.headlessQueueMode = value; },
    readValue: () => values.headlessQueueMode,
    changeTo: 'bounded',
    configPath: '/owned/config.json5',
    ownsConfig: () => true,
    ...overrides,
  };
}

function step(report: DrillReport, name: string) {
  const found = report.steps.find((candidate) => candidate.step === name);
  assert.ok(found, `the report dropped the ${name} step`);
  return found;
}

test('AC-1/AC-2/AC-3: the happy drill runs five steps and ends where it started', () => {
  const values = world();
  const report = runGateKeyRollbackDrill(depsFor(values));

  assert.equal(report.ok, true, JSON.stringify(report.steps, null, 2));
  assert.deepEqual(report.steps.map((row) => row.step), [...DRILL_STEPS]);
  assert.ok(report.steps.every((row) => row.ran && row.ok));
  assert.equal(values.headlessQueueMode, 'observe', 'the drill left the value moved');
  assert.equal(report.comparedKeys.length, 6, 'the comparison did not cover every captured key');
});

test('AC-6 control: a change that silently no-ops fails the drill instead of passing it', () => {
  // The whole point. With a no-op mechanism, capture succeeds, restore "succeeds" because
  // nothing moved, and a naive comparison passes -- a green drill proving nothing.
  const values = world();
  const report = runGateKeyRollbackDrill(depsFor(values, { applyValue: () => {} }));

  assert.equal(report.ok, false, 'a do-nothing mechanism passed the drill');
  assert.equal(step(report, 'observe-change').ok, false);
  assert.match(step(report, 'observe-change').detail, /did not take/u);
  assert.equal(step(report, 'restore').ran, false, 'the drill restored after an unobserved change');
});

test('AC-2 control: a restore that is sent but does not take fails the drill', () => {
  // "I sent the restore" and "the value is back" are two claims. Only the second counts.
  const values = world();
  let applied = 0;
  const report = runGateKeyRollbackDrill(depsFor(values, {
    applyValue: (value) => {
      applied += 1;
      if (applied === 1) values.headlessQueueMode = value;   // the change takes
      // the restore is accepted and silently dropped
    },
  }));

  assert.equal(report.ok, false, 'the drill trusted the write instead of the read-back');
  assert.equal(step(report, 'restore').ok, true, 'the restore call itself did succeed');
  assert.equal(step(report, 'observe-restore').ok, false);
  assert.match(step(report, 'observe-restore').detail, /headlessQueueMode/u);
});

test('AC-3 control: a restore that disturbs another key fails, even though the moved key is back', () => {
  const values = world();
  const report = runGateKeyRollbackDrill(depsFor(values, {
    applyValue: (value) => {
      values.headlessQueueMode = value;
      values.wsSendMode = 'safe-send-enforce';  // collateral damage
    },
  }));

  assert.equal(report.ok, false, 'the drill only looked at the key it moved');
  assert.match(step(report, 'observe-restore').detail, /wsSendMode/u);
});

test('AC-5: the drill refuses a config it does not own, and says so before touching anything', () => {
  const values = world();
  const report = runGateKeyRollbackDrill(depsFor(values, {
    ownsConfig: () => false,
    configPath: '/opt/buildergate/config.json5',
  }));

  assert.equal(report.ok, false);
  assert.match(report.refusedReason ?? '', /does not own/u);
  assert.ok(report.steps.every((row) => !row.ran), 'the drill touched a config it does not own');
  assert.equal(values.headlessQueueMode, 'observe');
});

test('AC-1: refusal and failure are distinguishable, not one boolean', () => {
  const refused = runGateKeyRollbackDrill(depsFor(world(), { ownsConfig: () => false }));
  const failed = runGateKeyRollbackDrill(depsFor(world(), { applyValue: () => {} }));

  assert.equal(refused.ok, false);
  assert.equal(failed.ok, false);
  // Same verdict, different stories: nothing ran vs. a step ran and reported.
  assert.equal(refused.steps.some((row) => row.ran), false);
  assert.equal(failed.steps.some((row) => row.ran), true);
  assert.equal(refused.refusedReason !== undefined, true);
  assert.equal(failed.refusedReason, undefined);
});

test('AC-6: changing a value to itself is refused rather than reported green', () => {
  const values = world('bounded');
  const report = runGateKeyRollbackDrill(depsFor(values));   // changeTo is also 'bounded'

  assert.equal(report.ok, false, 'an unobservable change was reported as a successful drill');
  assert.equal(step(report, 'change').ran, false);
  assert.match(step(report, 'change').detail, /to itself/u);
});

test('AC-7: the report says what it compared', () => {
  const report = runGateKeyRollbackDrill(depsFor(world()));

  assert.deepEqual(
    [...report.comparedKeys].sort(),
    [
      'realtime.terminalWireFormat',
      'realtime.wsTransportMode',
      'resourceLimits.terminal.hiddenOutputPolicy',
      'stabilityModes.frontendRuntimeResidency',
      'stabilityModes.headlessQueueMode',
      'stabilityModes.wsSendMode',
    ],
  );
  assert.equal(report.explicitRefreshed, true);
});

test('AC-4: the drill fails closed when the key is reclassified as gating', () => {
  const values = world();
  const reclassified = new Map(TERMINAL_PATH_GATE_KEYS);
  reclassified.set('headlessQueueMode', {
    ...reclassified.get('headlessQueueMode')!,
    gating: true,
  });

  const report = runGateKeyRollbackDrill(depsFor(values, { gateKeys: reclassified }));

  assert.equal(report.ok, false, 'the drill would have performed a flip');
  assert.match(report.refusedReason ?? '', /gating/u);
  assert.ok(report.steps.every((row) => !row.ran));
  assert.equal(values.headlessQueueMode, 'observe', 'the drill moved a gating key');
});

test('AC-4 control: with the real inventory the same drill runs', () => {
  // Without this, the test above would pass against a drill that refuses everything.
  assert.equal(runGateKeyRollbackDrill(depsFor(world())).ok, true);
  assert.equal(TERMINAL_PATH_GATE_KEYS.get('headlessQueueMode')?.gating, false);
});

test('AC-4: a key missing from the inventory is also a refusal', () => {
  const report = runGateKeyRollbackDrill(depsFor(world(), { gateKeys: new Map() }));

  assert.equal(report.ok, false);
  assert.match(report.refusedReason ?? '', /no longer in the gate-key inventory/u);
});
