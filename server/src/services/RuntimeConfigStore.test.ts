import test from 'node:test';
import assert from 'node:assert/strict';
import type { Config } from '../types/config.types.js';
import { RuntimeConfigStore } from './RuntimeConfigStore.js';

function createConfigFixture(): Config {
  return {
    server: {
      port: 4242,
    },
    pty: {
      termName: 'xterm-256color',
      defaultCols: 80,
      defaultRows: 24,
      useConpty: true,
      scrollbackLines: 1000,
      maxSnapshotBytes: 65536,
      shell: 'auto',
    },
    session: {
      idleDelayMs: 200,
    },
    security: {
      cors: {
        allowedOrigins: ['https://example.com'],
        credentials: true,
        maxAge: 86400,
      },
    },
    auth: {
      password: 'enc(secret)',
      durationMs: 1800000,
      jwtSecret: 'enc(jwt)',
    },
    fileManager: {
      maxFileSize: 1048576,
      maxDirectoryEntries: 10000,
      blockedExtensions: ['.exe', '.dll'],
      blockedPaths: ['.ssh', '.aws'],
      cwdCacheTtlMs: 1000,
    },
    twoFactor: {
      enabled: false,
      externalOnly: false,
      issuer: 'BuilderGate',
      accountName: 'admin',
    },
  };
}

test('RuntimeConfigStore builds a redacted editable snapshot', () => {
  const store = new RuntimeConfigStore(createConfigFixture(), 'win32');
  const snapshot = store.getSnapshot();

  assert.equal(store.isEditable('auth.durationMs'), true);
  assert.equal(store.isEditable('server.port'), false);
  assert.equal(snapshot.values.auth.durationMs, 1800000);
  assert.equal(snapshot.capabilities['auth.password'].writeOnly, true);
  assert.equal(snapshot.secretState.authPasswordConfigured, true);
  assert.ok(snapshot.excludedSections.includes('ssl.*'));
  // FR-BGSTAB-025 removes retired exclusions; active secrets remain excluded.
  assert.deepEqual([...snapshot.excludedSections].sort(), ['server.port', 'ssl.*', 'auth.jwtSecret'].sort());
});

test('FR-BGSTAB-025 runtime snapshot and capabilities contain no retired leaves', () => {
  const fixture = createConfigFixture();
  const original = structuredClone(fixture);
  const store = new RuntimeConfigStore(fixture, 'linux');
  const snapshot = store.getSnapshot();
  assert.deepEqual(fixture, original, 'store construction must not rewrite its configuration input');
  for (const retiredPath of [
    'logging.level', 'logging.audit', 'logging.directory', 'logging.maxSize', 'logging.maxFiles',
    'bruteForce.rateLimit.windowMs', 'bruteForce.rateLimit.maxRequests',
    'bruteForce.lockout.maxAttempts', 'bruteForce.lockout.lockoutDurationMs', 'bruteForce.lockout.progressiveDelay',
    'auth.maxDurationMs', 'fileManager.maxCodeFileSize', 'resourceLimits.telemetry.sampleIntervalMs',
  ]) {
    assert.equal(Reflect.get(snapshot.capabilities, retiredPath), undefined, `${retiredPath} capability`);
    assert.equal(store.isEditable(retiredPath), false, `${retiredPath} editability`);
    let value: unknown = snapshot.values;
    for (const key of retiredPath.split('.')) {
      value = value !== null && typeof value === 'object' ? Reflect.get(value, key) : undefined;
    }
    assert.equal(value, undefined, `${retiredPath} snapshot value`);
  }
  assert.equal(snapshot.values.fileManager.maxFileSize, fixture.fileManager!.maxFileSize);
  assert.equal(snapshot.capabilities['auth.password'].writeOnly, true);
  assert.equal(store.isEditable('auth.jwtSecret'), false);
});

test('RuntimeConfigStore marks platform-specific capabilities and merges editable patches', () => {
  const store = new RuntimeConfigStore(createConfigFixture(), 'linux');
  const capabilities = store.getFieldCapabilities();

  assert.equal(capabilities['pty.useConpty'].available, false);
  assert.equal(capabilities['pty.useConpty'].reason, 'Windows-only PTY backend');
  assert.deepEqual(capabilities['pty.shell'].options, ['auto', 'bash', 'zsh', 'sh']);

  const merged = store.mergeEditablePatch({
    auth: {
      durationMs: 3600000,
      currentPassword: 'ignored',
      newPassword: 'ignored',
      confirmPassword: 'ignored',
    },
    fileManager: {
      blockedExtensions: ['.ps1'],
    },
  });

  assert.equal(merged.auth.durationMs, 3600000);
  assert.deepEqual(merged.fileManager.blockedExtensions, ['.ps1']);
});

test('RuntimeConfigStore exposes Wave6 resource capabilities without leaking server-only runtime config', () => {
  const store = new RuntimeConfigStore({
    ...createConfigFixture(),
    realtime: {
      wsTransportMode: 'split-shadow',
      terminalWireFormat: 'binary-shadow',
    },
    stabilityModes: {
      headlessQueueMode: 'observe',
      wsSendMode: 'direct',
      frontendRuntimeResidency: 'bounded',
    },
  }, 'linux');
  const snapshot = store.getSnapshot();
  const publicConfig = store.getPublicRuntimeConfig('queue');

  assert.equal(snapshot.values.resourceLimits.clientWs.inputBackpressureBytes, 1048576);
  assert.equal(snapshot.values.resourceLimits.terminal.hiddenOutputPolicy, 'snapshot-restore');
  assert.equal(snapshot.values.resourceLimits.ws.serverBufferedHighWaterBytes, 8388608);
  assert.equal(snapshot.values.stabilityModes.frontendRuntimeResidency, 'bounded');
  assert.equal(snapshot.capabilities['resourceLimits.clientWs.inputBackpressureBytes'].applyScope, 'immediate');
  assert.equal(snapshot.capabilities['resourceLimits.ws.serverBufferedHighWaterBytes'].available, true);
  assert.equal(snapshot.capabilities['resourceLimits.ws.serverBufferedHighWaterBytes'].applyScope, 'immediate');
  assert.equal(snapshot.capabilities['resourceLimits.headless.pendingOutputMaxBytes'].available, true);
  assert.equal(snapshot.capabilities['resourceLimits.headless.pendingOutputMaxBytes'].applyScope, 'new_sessions');
  assert.equal(snapshot.capabilities['resourceLimits.headless.writeLagWarnMs'].available, false);
  assert.equal(snapshot.capabilities['resourceLimits.ws.perClientControlQueueMaxBytes'].available, false);
  assert.match(snapshot.capabilities['resourceLimits.ws.perClientControlQueueMaxBytes'].reason ?? '', /selected Wave6 Settings field set/);
  assert.equal(snapshot.capabilities['resourceLimits.terminal.visibleOutputQueueMaxBytes'].available, false);
  // FR-BGSTAB-025 retires the capability, rather than retaining it as unavailable.
  assert.equal(Reflect.get(snapshot.capabilities, 'resourceLimits.telemetry.sampleIntervalMs'), undefined);
  assert.equal(snapshot.capabilities['stabilityModes.wsSendMode'].available, false);
  assert.equal(snapshot.capabilities['stabilityModes.frontendRuntimeResidency'].available, false);
  assert.match(snapshot.capabilities['stabilityModes.wsSendMode'].reason ?? '', /selected Wave6 Settings field set/);
  assert.deepEqual(snapshot.capabilities['resourceLimits.clientWs.inputBackpressureBytes'].constraints, {
    min: 1024,
    max: 268435456,
    step: 1,
    unit: 'bytes',
  });
  assert.deepEqual(publicConfig, {
    inputReliabilityMode: 'queue',
    wsTransportMode: 'split-shadow',
    terminalWireFormat: 'binary-shadow',
    stabilityModes: {
      frontendRuntimeResidency: 'bounded',
    },
    resourceLimits: {
      clientWs: {
        inputBackpressureBytes: 1048576,
        hardReconnectBytes: 4194304,
      },
      terminal: {
        visibleOutputQueueMaxBytes: 4194304,
        visibleOutputMaxChunks: 512,
        visibleFlushBudgetBytes: 262144,
        visibleFlushFrameBudgetMs: 7,
        checkpointMaxBytes: 4194304,
        hiddenOutputPolicy: 'snapshot-restore',
        hiddenOutputTailBytes: 262144,
        inputQueueMaxBytes: 65536,
        inputQueueTtlMs: 1500,
        transportOutboxMaxBytes: 65536,
        transportOutboxTtlMs: 1500,
        scrollbackLines: 10000,
        // #95: provenance for the value on the line above. This deep-equal is the guard
        // that stops server-only config leaking into the public payload, and it fired on
        // this change, which is what it is for. These three are config KEY NAMES and a
        // boolean -- no value, no secret -- and the value they describe was already public.
        scrollbackSource: 'resourceLimits.terminal.scrollbackLines',
        scrollbackLegacyAlias: undefined,
        scrollbackSourceConflict: false,
      },
      snapshots: {
        perSnapshotMaxChars: 2000000,
        totalStorageBudgetChars: 3000000,
        maxEntries: 16,
        tombstoneTtlMs: 86400000,
      },
      workspaceRuntime: {
        maxLiveWorkspaces: 10,
        maxLiveTerminals: 32,
        hiddenRuntimeTtlMs: 600000,
      },
    },
  });
  assert.equal('headless' in publicConfig.resourceLimits, false);
  assert.equal('ws' in publicConfig.resourceLimits, false);
  assert.equal('telemetry' in publicConfig.resourceLimits, false);
});

test('FR-BGSTAB-015 recentEventLimit capability is available with truthful constraints', () => {
  const store = new RuntimeConfigStore(createConfigFixture(), 'linux');
  const capability = store.getSnapshot().capabilities['resourceLimits.telemetry.recentEventLimit'];
  assert.equal(capability.available, true);
  assert.equal(capability.reason, undefined, 'an active observer setting must not claim a later stability wave');
  assert.equal(store.isEditable('resourceLimits.telemetry.recentEventLimit'), true);
  assert.deepEqual(capability.constraints, { min: 1, max: 10000, step: 1, unit: 'count' });
  assert.equal(store.getSnapshot().capabilities['resourceLimits.headless.writeLagWarnMs'].available, false);
});

for (const replacement of ['replaceValues', 'replaceFromConfig'] as const) {
  test(`FR-BGSTAB-015 ${replacement} applies recentEventLimit to the existing observer immediately`, () => {
    const store = new RuntimeConfigStore(createConfigFixture(), 'linux');
    for (const capacity of [2, 5, 1]) {
      const values = store.mergeEditablePatch({ resourceLimits: { telemetry: { recentEventLimit: capacity } } });
      if (replacement === 'replaceValues') store.replaceValues(values);
      else store.replaceFromConfig({ ...createConfigFixture(), resourceLimits: values.resourceLimits });
      for (let index = 0; index < 8; index += 1) {
        assert.equal(store.recordTerminalResourcePolicyDecision({
          consumer: 'server.config.runtime-store',
          resource: 'resourceLimits.terminal.scrollbackLines',
          differenceReason: 'legacy-only',
        }), true);
      }
      const observations = store.getTerminalResourcePolicyObservation().recentObservations;
      assert.equal(observations.length, capacity, 'the existing store must immediately enforce each smaller or larger capacity');
      assert.equal(observations.every(row => row.resource === 'resourceLimits.terminal.scrollbackLines'), true);
    }
    assert.equal(store.getSnapshot().capabilities['resourceLimits.telemetry.recentEventLimit'].applyScope, 'immediate');
  });
}

test('FR-BGSTAB-015 recentEventLimit rejects invalid values without clamping or changing observer state', () => {
  const store = new RuntimeConfigStore(createConfigFixture(), 'linux');
  const before = store.getTerminalResourcePolicyObservation().recentObservations;
  for (const value of [0, 10001, 1.5, NaN, Infinity, '']) {
    assert.throws(() => store.mergeEditablePatch({ resourceLimits: { telemetry: { recentEventLimit: value as never } } }));
  }
  assert.deepEqual(store.getTerminalResourcePolicyObservation().recentObservations, before);
  assert.equal(store.mergeEditablePatch({ resourceLimits: { telemetry: { recentEventLimit: 10000 } } }).resourceLimits.telemetry.recentEventLimit, 10000);
});

test('RuntimeConfigStore validates Wave 0 resource limit patches after merging', () => {
  const store = new RuntimeConfigStore(createConfigFixture(), 'linux');
  const merged = store.mergeEditablePatch({
    resourceLimits: {
      clientWs: {
        inputBackpressureBytes: 2000000,
        hardReconnectBytes: 8000000,
      },
      terminal: {
        hiddenOutputPolicy: 'debug-tail',
        hiddenOutputTailBytes: 4096,
      },
    },
    stabilityModes: {
      frontendRuntimeResidency: 'bounded',
    },
  });

  assert.equal(merged.resourceLimits.clientWs.inputBackpressureBytes, 2000000);
  assert.equal(merged.resourceLimits.terminal.hiddenOutputPolicy, 'debug-tail');
  assert.equal(merged.resourceLimits.terminal.hiddenOutputTailBytes, 4096);
  assert.equal(merged.stabilityModes.frontendRuntimeResidency, 'bounded');
  assert.throws(
    () => store.mergeEditablePatch({
      resourceLimits: {
        clientWs: {
          inputBackpressureBytes: 8000000,
          hardReconnectBytes: 2000000,
        },
      },
    }),
    /hardReconnectBytes/i,
  );
});

test('IR-BGSTAB-001 AC-8 publishes terminalWireFormat and nothing else beyond the existing allowlist', () => {
  const withoutRealtime = new RuntimeConfigStore(createConfigFixture(), 'linux');
  const published = withoutRealtime.getPublicRuntimeConfig('queue');
  // realtime 블록이 없으면 스키마 기본값인 json 으로 수렴해야 한다.
  assert.equal(published.terminalWireFormat, 'json');

  // AC-8 은 기존 공개 값에 이 한 필드만 더하도록 규정한다. 최상위 키가 그 이상으로
  // 늘면 비공개 값이 새어 나간 것이다.
  assert.deepEqual(
    Object.keys(published).sort(),
    ['inputReliabilityMode', 'resourceLimits', 'stabilityModes', 'terminalWireFormat', 'wsTransportMode'],
  );

  // 사다리 네 값이 모두 그대로 실려야 한다.
  for (const wireFormat of ['json', 'binary-shadow', 'binary-optin', 'binary'] as const) {
    const store = new RuntimeConfigStore({
      ...createConfigFixture(),
      realtime: { wsTransportMode: 'unified', terminalWireFormat: wireFormat },
    }, 'linux');
    assert.equal(store.getPublicRuntimeConfig('queue').terminalWireFormat, wireFormat);
  }
});

test('IR-BGSTAB-001 AC-8 republishes terminalWireFormat after a runtime config reload', () => {
  const store = new RuntimeConfigStore({
    ...createConfigFixture(),
    realtime: { wsTransportMode: 'unified', terminalWireFormat: 'json' },
  }, 'linux');
  assert.equal(store.getPublicRuntimeConfig('queue').terminalWireFormat, 'json');

  store.replaceFromConfig({
    ...createConfigFixture(),
    realtime: { wsTransportMode: 'unified', terminalWireFormat: 'binary-optin' },
  });
  // 재적재 경로가 이 필드를 갱신하지 않으면 프로세스가 시작할 때의 값을 계속 내보낸다.
  assert.equal(store.getPublicRuntimeConfig('queue').terminalWireFormat, 'binary-optin');

  store.replaceFromConfig(createConfigFixture());
  // realtime 을 통째로 뺀 설정으로 재적재하면 기본값으로 돌아와야 한다.
  assert.equal(store.getPublicRuntimeConfig('queue').terminalWireFormat, 'json');
});
