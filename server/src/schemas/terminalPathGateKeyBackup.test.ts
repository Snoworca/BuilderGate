import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { TERMINAL_PATH_GATE_KEYS } from './terminalPathGateKeys.js';
import {
  buildTerminalPathGateKeyBackup,
  collectTerminalPathGateKeyState,
  type TerminalPathGateKeyState,
} from './terminalPathGateKeyBackup.js';

/**
 * OPS-BGSTAB-012 — the gate-key backup artifact.
 *
 * The artifact exists so that a future default flip is reversible against a recorded
 * starting position. That makes its failure mode quiet: an artifact that records five of
 * six keys, or records a value nothing actually reads, looks exactly like a good one.
 * Every test below is aimed at a way it could look right and be wrong.
 */

const MODULE = fileURLToPath(new URL('./terminalPathGateKeyBackup.ts', import.meta.url));

const PROVENANCE = {
  serverBuild: 'test-build',
  configSourcePath: '/srv/config.json5',
  schemaShapeId: 'sha256:abcdef',
} as const;

/** The measured 2026-09-19 position: everything at its default, two keys pinned explicitly. */
function measuredState(): TerminalPathGateKeyState {
  return {
    wsTransportMode: { effectiveValue: 'unified', explicit: true },
    terminalWireFormat: { effectiveValue: 'json', explicit: false, consumerValue: 'json' },
    headlessQueueMode: { effectiveValue: 'observe', explicit: true },
    wsSendMode: { effectiveValue: 'direct', explicit: true },
    frontendRuntimeResidency: { effectiveValue: 'bounded', explicit: true },
    hiddenOutputPolicy: { effectiveValue: 'snapshot-restore', explicit: false },
  };
}

function entry(backup: ReturnType<typeof buildTerminalPathGateKeyBackup>, key: string) {
  const found = backup.keys.find((candidate) => candidate.key === key);
  assert.ok(found, `the artifact dropped ${key}`);
  return found;
}

test('AC-1: explicit and non-default are independent axes, and wsTransportMode proves it', () => {
  const backup = buildTerminalPathGateKeyBackup(measuredState(), PROVENANCE, new Date(0));

  // The case that makes the two axes separate: pinned in config, and the pin equals the
  // schema default. Collapsing them into one boolean gets this key wrong in both directions.
  const pinned = entry(backup, 'realtime.wsTransportMode');
  assert.equal(pinned.explicit, true, 'config.json5 pins wsTransportMode');
  assert.equal(pinned.nonDefault, false, 'and the pin is the schema default');
  assert.equal(pinned.effectiveValue, 'unified');
  assert.equal(pinned.schemaDefault, 'unified');
});

test('AC-1 control: the other three combinations are reachable and distinct', () => {
  const state = measuredState();
  state.wsSendMode = { effectiveValue: 'safe-send-enforce', explicit: true };   // explicit, non-default
  state.hiddenOutputPolicy = { effectiveValue: 'write-hidden', explicit: false }; // implicit, non-default
  const backup = buildTerminalPathGateKeyBackup(state, PROVENANCE, new Date(0));

  assert.deepEqual(
    {
      pinnedAtDefault: [entry(backup, 'realtime.wsTransportMode').explicit, entry(backup, 'realtime.wsTransportMode').nonDefault],
      pinnedOffDefault: [entry(backup, 'stabilityModes.wsSendMode').explicit, entry(backup, 'stabilityModes.wsSendMode').nonDefault],
      unpinnedOffDefault: [entry(backup, 'resourceLimits.terminal.hiddenOutputPolicy').explicit, entry(backup, 'resourceLimits.terminal.hiddenOutputPolicy').nonDefault],
      unpinnedAtDefault: [entry(backup, 'realtime.terminalWireFormat').explicit, entry(backup, 'realtime.terminalWireFormat').nonDefault],
    },
    {
      pinnedAtDefault: [true, false],
      pinnedOffDefault: [true, true],
      unpinnedOffDefault: [false, true],
      unpinnedAtDefault: [false, false],
    },
    'the two booleans are not independent: some combination collapsed',
  );
});

test('AC-2: a store/consumer divergence is recorded as two values, not resolved into one', () => {
  const state = measuredState();
  // The reachable case: the store reassigns its copy on config reload while the router
  // still holds the value it read from module-top-level config at boot.
  state.terminalWireFormat = { effectiveValue: 'binary-optin', explicit: true, consumerValue: 'json' };
  const backup = buildTerminalPathGateKeyBackup(state, PROVENANCE, new Date(0));

  const wire = entry(backup, 'realtime.terminalWireFormat');
  assert.ok(wire.divergence, 'the divergence was silently resolved');
  assert.equal(wire.divergence.storeValue, 'binary-optin');
  assert.equal(wire.divergence.consumerValue, 'json');
  // And the recorded effective value must be the one the runtime actually reads.
  assert.equal(wire.effectiveValue, 'json', 'the artifact recorded a value nothing observes');
});

test('AC-2 control: agreement records no divergence', () => {
  const backup = buildTerminalPathGateKeyBackup(measuredState(), PROVENANCE, new Date(0));
  assert.equal(entry(backup, 'realtime.terminalWireFormat').divergence, undefined);
});

test('AC-3: provenance is carried and the capture instant is the one supplied', () => {
  const backup = buildTerminalPathGateKeyBackup(measuredState(), PROVENANCE, new Date('2026-09-20T00:00:00.000Z'));

  assert.equal(backup.capturedAt, '2026-09-20T00:00:00.000Z');
  assert.deepEqual(backup.provenance, PROVENANCE);
  assert.equal(backup.artifactKind, 'terminal-path-gate-key-backup/v1');
});

test('AC-4: the artifact key set is the pinned gate-key set, expressed once', () => {
  const backup = buildTerminalPathGateKeyBackup(measuredState(), PROVENANCE, new Date(0));

  assert.deepEqual(
    backup.keys.map((row) => row.name).sort(),
    [...TERMINAL_PATH_GATE_KEYS.keys()].sort(),
  );
});

test('AC-4: a missing key fails the generator rather than emitting a short artifact', () => {
  const state = measuredState() as Record<string, unknown>;
  delete state.wsSendMode;

  assert.throws(
    () => buildTerminalPathGateKeyBackup(state as TerminalPathGateKeyState, PROVENANCE, new Date(0)),
    /wsSendMode/u,
    'a short artifact was emitted silently -- omission is how issue #21 own table rotted',
  );
});

test('AC-4: an unknown key fails too, so a schema addition cannot ride along untriaged', () => {
  const state = { ...measuredState(), somethingNew: { effectiveValue: 'x', explicit: false } };

  assert.throws(
    () => buildTerminalPathGateKeyBackup(state as TerminalPathGateKeyState, PROVENANCE, new Date(0)),
    /somethingNew/u,
  );
});

test('AC-5: headlessQueueMode is recorded and marked non-gating', () => {
  const backup = buildTerminalPathGateKeyBackup(measuredState(), PROVENANCE, new Date(0));

  const queue = entry(backup, 'stabilityModes.headlessQueueMode');
  assert.equal(queue.gating, false, 'a reader could infer a flip target that does not exist');
  assert.equal(
    backup.keys.filter((row) => row.gating).length,
    5,
    'the gating count moved; the inventory measured five of six',
  );
});

test('AC-6: the generator has no write path', () => {
  const source = readFileSync(MODULE, 'utf8');

  for (const forbidden of ['node:fs', 'writeFile', 'writeFileSync', 'applySettings', 'update(']) {
    assert.equal(
      source.includes(forbidden),
      false,
      `the capture module reaches a mutation surface (${forbidden}); capture must be safe on a live deployment`,
    );
  }
});

test('AC-1: declaration presence is read from the raw config, not the parsed one', () => {
  // The trap this closes: zod defaults `realtime` in, so the PARSED config answers
  // "present" for a file that never mentioned the key. Only the raw object can say.
  const raw = {
    realtime: { wsTransportMode: 'unified' },
    stabilityModes: { wsSendMode: 'direct' },
  };
  const state = collectTerminalPathGateKeyState({
    effectiveValues: {
      wsTransportMode: 'unified',
      terminalWireFormat: 'json',
      headlessQueueMode: 'observe',
      wsSendMode: 'direct',
      frontendRuntimeResidency: 'bounded',
      hiddenOutputPolicy: 'snapshot-restore',
    },
    rawConfig: raw,
  });

  assert.equal(state.wsTransportMode.explicit, true, 'the file declares it');
  assert.equal(state.terminalWireFormat.explicit, false, 'the file is silent; zod would say otherwise');
  assert.equal(state.wsSendMode.explicit, true);
  assert.equal(state.hiddenOutputPolicy.explicit, false);
});

test('AC-2: the collector never substitutes a default for a missing effective value', () => {
  const state = collectTerminalPathGateKeyState({
    effectiveValues: {
      wsTransportMode: 'split',
      terminalWireFormat: 'json',
      headlessQueueMode: 'observe',
      wsSendMode: 'direct',
      frontendRuntimeResidency: 'bounded',
      hiddenOutputPolicy: 'snapshot-restore',
    },
    rawConfig: {},
    consumerValues: { terminalWireFormat: 'binary' },
  });

  assert.equal(state.wsTransportMode.effectiveValue, 'split', 'the live value was replaced by a default');
  assert.equal(state.terminalWireFormat.consumerValue, 'binary');
  assert.equal(state.headlessQueueMode.consumerValue, undefined, 'a consumer value was invented');
});
