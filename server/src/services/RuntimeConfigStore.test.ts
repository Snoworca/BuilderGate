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
      maxDurationMs: 86400000,
      jwtSecret: 'enc(jwt)',
    },
    fileManager: {
      maxFileSize: 1048576,
      maxCodeFileSize: 524288,
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
  assert.ok(snapshot.excludedSections.includes('fileManager.maxCodeFileSize'));
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
  assert.equal(snapshot.capabilities['resourceLimits.telemetry.sampleIntervalMs'].available, false);
  assert.match(snapshot.capabilities['resourceLimits.telemetry.sampleIntervalMs'].reason ?? '', /later stability wave/);
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
        hiddenOutputPolicy: 'snapshot-restore',
        hiddenOutputTailBytes: 262144,
        inputQueueMaxBytes: 65536,
        inputQueueTtlMs: 1500,
        transportOutboxMaxBytes: 65536,
        transportOutboxTtlMs: 1500,
        scrollbackLines: 10000,
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
