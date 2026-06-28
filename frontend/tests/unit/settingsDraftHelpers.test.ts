import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  EditableSettingsKey,
  EditableSettingsValues,
  FieldCapability,
} from '../../src/types/settings.ts';
import {
  WAVE6_RESOURCE_LIMIT_GROUPS,
  buildWave6ResourceLimitsPatch,
  setResourceLimitValue,
  validateWave6ResourceLimitDraft,
} from '../../src/components/Settings/settingsDraftHelpers.ts';

const availableImmediate = {
  applyScope: 'immediate',
  available: true,
  writeOnly: false,
} satisfies FieldCapability;

const availableNewSessions = {
  applyScope: 'new_sessions',
  available: true,
  writeOnly: false,
} satisfies FieldCapability;

const unavailable = {
  applyScope: 'immediate',
  available: false,
  writeOnly: false,
  reason: 'reserved',
} satisfies FieldCapability;

test('builds minimal nested resourceLimits patch for changed Wave6 leaves', () => {
  const initial = createEditableValues();
  const draft = structuredClone(initial);
  const capabilities = createCapabilities();

  draft.resourceLimits.headless.pendingOutputMaxBytes = 2_000_000;
  draft.resourceLimits.clientWs.inputBackpressureBytes = 3_000_000;

  assert.deepEqual(buildWave6ResourceLimitsPatch(initial, draft, capabilities), {
    headless: {
      pendingOutputMaxBytes: 2_000_000,
    },
    clientWs: {
      inputBackpressureBytes: 3_000_000,
    },
  });
});

test('does not emit unchanged, unavailable, telemetry, stability mode, or reserved leaves', () => {
  const initial = createEditableValues();
  const draft = structuredClone(initial);
  const capabilities = createCapabilities();
  capabilities['resourceLimits.clientWs.inputBackpressureBytes'] = unavailable;

  draft.resourceLimits.clientWs.inputBackpressureBytes = 3_000_000;
  draft.resourceLimits.telemetry.sampleIntervalMs = 10_000;
  draft.resourceLimits.terminal.visibleOutputQueueMaxBytes = 9_000_000;
  draft.stabilityModes.frontendRuntimeResidency = 'bounded';

  assert.equal(WAVE6_RESOURCE_LIMIT_GROUPS.some((group) =>
    group.fields.some((field) => field.key === 'resourceLimits.telemetry.sampleIntervalMs')
  ), false);
  assert.equal(WAVE6_RESOURCE_LIMIT_GROUPS.some((group) =>
    group.fields.some((field) => field.key === 'resourceLimits.terminal.visibleOutputQueueMaxBytes')
  ), false);
  assert.deepEqual(buildWave6ResourceLimitsPatch(initial, draft, capabilities), undefined);
});

test('validates local numeric capability constraints without clamping values', () => {
  const draft = createEditableValues();
  const capabilities = createCapabilities();

  setResourceLimitValue(draft, 'resourceLimits.headless.pendingOutputMaxBytes', Number.NaN);
  setResourceLimitValue(draft, 'resourceLimits.snapshots.maxEntries', 0);
  setResourceLimitValue(draft, 'resourceLimits.workspaceRuntime.maxLiveWorkspaces', 11);

  const errors = validateWave6ResourceLimitDraft(draft, capabilities);

  assert.ok(errors.some((error) => error.includes('Headless pending output bytes') && error.includes('finite integer')));
  assert.ok(errors.some((error) => error.includes('Snapshot max entries') && error.includes('at least 1')));
  assert.ok(errors.some((error) => error.includes('Live workspaces') && error.includes('at most 10')));
  assert.equal(draft.resourceLimits.snapshots.maxEntries, 0);
});

test('validates select values against capability options', () => {
  const draft = createEditableValues();
  const capabilities = createCapabilities();

  setResourceLimitValue(draft, 'resourceLimits.terminal.hiddenOutputPolicy', 'drop-hidden');

  const errors = validateWave6ResourceLimitDraft(draft, capabilities);

  assert.ok(errors.some((error) => error.includes('Hidden output policy') && error.includes('supported option')));
});

function createCapabilities(): Record<EditableSettingsKey, FieldCapability> {
  const capabilities = {} as Record<EditableSettingsKey, FieldCapability>;
  for (const key of ALL_KEYS) {
    capabilities[key] = key.startsWith('resourceLimits.headless.')
      ? availableNewSessions
      : availableImmediate;
  }
  capabilities['resourceLimits.terminal.hiddenOutputPolicy'] = {
    ...availableImmediate,
    options: ['write-hidden', 'snapshot-restore', 'debug-tail'],
  };
  capabilities['resourceLimits.headless.pendingOutputMaxBytes'] = {
    ...availableNewSessions,
    constraints: { min: 1024, max: 268435456, step: 1, unit: 'bytes' },
  };
  capabilities['resourceLimits.snapshots.maxEntries'] = {
    ...availableImmediate,
    constraints: { min: 1, max: 1024, step: 1, unit: 'count' },
  };
  capabilities['resourceLimits.workspaceRuntime.maxLiveWorkspaces'] = {
    ...availableImmediate,
    constraints: { min: 1, max: 10, step: 1, unit: 'count' },
  };
  return capabilities;
}

function createEditableValues(): EditableSettingsValues {
  return {
    auth: { durationMs: 1_800_000 },
    twoFactor: {
      enabled: false,
      externalOnly: false,
      issuer: 'BuilderGate',
      accountName: 'admin',
    },
    security: {
      cors: {
        allowedOrigins: [],
        credentials: true,
        maxAge: 86_400,
      },
    },
    pty: {
      termName: 'xterm-256color',
      defaultCols: 80,
      defaultRows: 24,
      useConpty: false,
      windowsPowerShellBackend: 'inherit',
      shell: 'auto',
    },
    session: {
      idleDelayMs: 2_000,
    },
    fileManager: {
      maxFileSize: 10_485_760,
      maxDirectoryEntries: 1_000,
      blockedExtensions: [],
      blockedPaths: [],
      cwdCacheTtlMs: 30_000,
    },
    resourceLimits: {
      headless: {
        pendingOutputMaxBytes: 1_048_576,
        pendingOutputMaxChunks: 1024,
        writeLagWarnMs: 250,
        writeBatchMaxBytes: 65_536,
        overflowPolicy: 'degrade-headless',
      },
      ws: {
        serverBufferedHighWaterBytes: 1_048_576,
        serverBufferedHardLimitBytes: 8_388_608,
        perClientOutputQueueMaxBytes: 4_194_304,
        perClientControlQueueMaxBytes: 262_144,
        outputCoalesceWindowMs: 16,
      },
      clientWs: {
        inputBackpressureBytes: 524_288,
        hardReconnectBytes: 4_194_304,
      },
      terminal: {
        visibleOutputQueueMaxBytes: 1_048_576,
        visibleOutputMaxChunks: 1024,
        visibleFlushBudgetBytes: 65_536,
        hiddenOutputPolicy: 'write-hidden',
        hiddenOutputTailBytes: 262_144,
        inputQueueMaxBytes: 65_536,
        inputQueueTtlMs: 5_000,
        transportOutboxMaxBytes: 65_536,
        transportOutboxTtlMs: 5_000,
        scrollbackLines: 10_000,
      },
      snapshots: {
        perSnapshotMaxChars: 1_000_000,
        totalStorageBudgetChars: 20_000_000,
        maxEntries: 50,
        tombstoneTtlMs: 300_000,
      },
      workspaceRuntime: {
        maxLiveWorkspaces: 2,
        maxLiveTerminals: 8,
        hiddenRuntimeTtlMs: 300_000,
      },
      telemetry: {
        sampleIntervalMs: 30_000,
        recentEventLimit: 200,
      },
    },
    stabilityModes: {
      headlessQueueMode: 'observe',
      wsSendMode: 'direct',
      frontendRuntimeResidency: 'legacy',
    },
  };
}

const ALL_KEYS: EditableSettingsKey[] = [
  'auth.password',
  'auth.durationMs',
  'twoFactor.externalOnly',
  'twoFactor.enabled',
  'twoFactor.issuer',
  'twoFactor.accountName',
  'security.cors.allowedOrigins',
  'security.cors.credentials',
  'security.cors.maxAge',
  'pty.termName',
  'pty.defaultCols',
  'pty.defaultRows',
  'pty.useConpty',
  'pty.windowsPowerShellBackend',
  'pty.shell',
  'session.idleDelayMs',
  'fileManager.maxFileSize',
  'fileManager.maxDirectoryEntries',
  'fileManager.blockedExtensions',
  'fileManager.blockedPaths',
  'fileManager.cwdCacheTtlMs',
  'resourceLimits.headless.pendingOutputMaxBytes',
  'resourceLimits.headless.pendingOutputMaxChunks',
  'resourceLimits.headless.writeLagWarnMs',
  'resourceLimits.headless.writeBatchMaxBytes',
  'resourceLimits.headless.overflowPolicy',
  'resourceLimits.ws.serverBufferedHighWaterBytes',
  'resourceLimits.ws.serverBufferedHardLimitBytes',
  'resourceLimits.ws.perClientOutputQueueMaxBytes',
  'resourceLimits.ws.perClientControlQueueMaxBytes',
  'resourceLimits.ws.outputCoalesceWindowMs',
  'resourceLimits.clientWs.inputBackpressureBytes',
  'resourceLimits.clientWs.hardReconnectBytes',
  'resourceLimits.terminal.visibleOutputQueueMaxBytes',
  'resourceLimits.terminal.visibleOutputMaxChunks',
  'resourceLimits.terminal.visibleFlushBudgetBytes',
  'resourceLimits.terminal.hiddenOutputPolicy',
  'resourceLimits.terminal.hiddenOutputTailBytes',
  'resourceLimits.terminal.inputQueueMaxBytes',
  'resourceLimits.terminal.inputQueueTtlMs',
  'resourceLimits.terminal.transportOutboxMaxBytes',
  'resourceLimits.terminal.transportOutboxTtlMs',
  'resourceLimits.terminal.scrollbackLines',
  'resourceLimits.snapshots.perSnapshotMaxChars',
  'resourceLimits.snapshots.totalStorageBudgetChars',
  'resourceLimits.snapshots.maxEntries',
  'resourceLimits.snapshots.tombstoneTtlMs',
  'resourceLimits.workspaceRuntime.maxLiveWorkspaces',
  'resourceLimits.workspaceRuntime.maxLiveTerminals',
  'resourceLimits.workspaceRuntime.hiddenRuntimeTtlMs',
  'resourceLimits.telemetry.sampleIntervalMs',
  'resourceLimits.telemetry.recentEventLimit',
  'stabilityModes.headlessQueueMode',
  'stabilityModes.wsSendMode',
  'stabilityModes.frontendRuntimeResidency',
];
