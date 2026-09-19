import test from 'node:test';
import assert from 'node:assert/strict';
import { configSchema } from './config.schema.js';

function minimalConfig() {
  return {
    server: { port: 2002 },
    pty: {
      termName: 'xterm-256color',
      defaultCols: 80,
      defaultRows: 24,
      useConpty: false,
      windowsPowerShellBackend: 'inherit',
      scrollbackLines: 1000,
      maxSnapshotBytes: 2097152,
      shell: 'auto',
    },
    session: {
      idleDelayMs: 200,
      runningDelayMs: 250,
    },
  };
}

const retiredConfigPaths = [
  'logging.level', 'logging.audit', 'logging.directory', 'logging.maxSize', 'logging.maxFiles',
  'bruteForce.rateLimit.windowMs', 'bruteForce.rateLimit.maxRequests',
  'bruteForce.lockout.maxAttempts', 'bruteForce.lockout.lockoutDurationMs', 'bruteForce.lockout.progressiveDelay',
  'auth.maxDurationMs', 'fileManager.maxCodeFileSize', 'resourceLimits.telemetry.sampleIntervalMs',
];

for (const retiredPath of retiredConfigPaths) {
  test(`FR-BGSTAB-025 removes ${retiredPath} from effective legacy configuration`, () => {
    const raw = {
      ...minimalConfig(),
      logging: { level: 'debug', audit: true, directory: 'logs', maxSize: '10m', maxFiles: 14 },
      bruteForce: {
        rateLimit: { windowMs: 60000, maxRequests: 100 },
        lockout: { maxAttempts: 5, lockoutDurationMs: 900000, progressiveDelay: true },
      },
      auth: { maxDurationMs: 86400000, jwtSecret: 'preserved-secret' },
      fileManager: { maxCodeFileSize: 524288, maxFileSize: 2097152 },
      resourceLimits: { telemetry: { sampleIntervalMs: 60000, recentEventLimit: 321 } },
    };
    const original = structuredClone(raw);
    const parsed = configSchema.parse(raw);
    assert.deepEqual(raw, original, 'FR-BGSTAB-025 AC-5: parsing must not mutate the input');
    assert.equal(parsed.server.port, 2002, 'fixture value only; no listener');
    assert.equal(parsed.auth?.jwtSecret, 'preserved-secret');
    assert.equal(parsed.fileManager?.maxFileSize, 2097152);
    assert.equal(parsed.resourceLimits.telemetry.recentEventLimit, 321);
    let value: unknown = parsed;
    for (const key of retiredPath.split('.')) {
      value = value !== null && typeof value === 'object' ? Reflect.get(value, key) : undefined;
    }
    assert.equal(value, undefined, `${retiredPath} must not remain an active setting`);
  });
}

test('FR-BGSTAB-025 known retired telemetry key does not allow other unknown or invalid active keys', () => {
  for (const resourceLimits of [
    { telemetry: { sampleIntervalMs: 60000, misspelledIntervalMs: 60000 } },
    { telemetry: { sampleIntervalMs: 60000, recentEventLimit: 0 } },
    { telemetry: { sampleIntervalMs: 60000 }, unknownSection: {} },
  ]) {
    const raw = { ...minimalConfig(), resourceLimits };
    const original = structuredClone(raw);
    assert.equal(configSchema.safeParse(raw).success, false);
    assert.deepEqual(raw, original);
  }
  assert.equal(configSchema.safeParse({ ...minimalConfig(), fileManager: { maxFileSize: 1023 } }).success, false);
});

test('FR-BGSTAB-026 workspace timing uses defaults when omitted', () => {
  const parsed = configSchema.parse({ ...minimalConfig(), workspace: {} });
  assert.ok(parsed.workspace);
  assert.equal(Reflect.get(parsed.workspace, 'terminalTitleDebounceMs'), 250);
  assert.equal(Reflect.get(parsed.workspace, 'restoreInputDelayMs'), 600);
});

test('FR-BGSTAB-026 workspace timing preserves explicit and boundary values', () => {
  for (const [terminalTitleDebounceMs, restoreInputDelayMs] of [[0, 0], [400, 900], [5000, 10000]]) {
    const parsed = configSchema.parse({ ...minimalConfig(), workspace: { terminalTitleDebounceMs, restoreInputDelayMs } });
    assert.ok(parsed.workspace);
    assert.equal(Reflect.get(parsed.workspace, 'terminalTitleDebounceMs'), terminalTitleDebounceMs);
    assert.equal(Reflect.get(parsed.workspace, 'restoreInputDelayMs'), restoreInputDelayMs);
  }
});

test('FR-BGSTAB-026 workspace timing rejects invalid values instead of discarding them', () => {
  for (const [key, maximum] of [['terminalTitleDebounceMs', 5000], ['restoreInputDelayMs', 10000]] as const) {
    for (const value of [-1, maximum + 1, 0.5, NaN, Infinity, '400', null]) {
      const result = configSchema.safeParse({ ...minimalConfig(), workspace: { [key]: value } });
      assert.equal(result.success, false, `${key}=${String(value)} must be rejected`);
      if (!result.success) assert.ok(result.error.issues.some(issue => issue.path.join('.') === `workspace.${key}`));
    }
  }
});

test('configSchema applies resourceLimits defaults to legacy config files', () => {
  const parsed = configSchema.parse(minimalConfig());

  assert.equal(parsed.resourceLimits.headless.pendingOutputMaxBytes, 8388608);
  assert.equal(parsed.resourceLimits.headless.pendingOutputMaxChunks, 1024);
  assert.equal(parsed.resourceLimits.headless.overflowPolicy, 'degrade-headless');
  assert.equal(parsed.resourceLimits.ws.serverBufferedHighWaterBytes, 8388608);
  assert.equal(parsed.resourceLimits.ws.serverBufferedHardLimitBytes, 33554432);
  assert.equal(parsed.resourceLimits.clientWs.inputBackpressureBytes, 1048576);
  assert.equal(parsed.resourceLimits.terminal.hiddenOutputPolicy, 'snapshot-restore');
  assert.equal(parsed.resourceLimits.terminal.hiddenOutputTailBytes, 262144);
  assert.equal(parsed.resourceLimits.snapshots.maxEntries, 16);
  assert.equal(parsed.resourceLimits.workspaceRuntime.maxLiveWorkspaces, 10);
  assert.equal(parsed.resourceLimits.workspaceRuntime.maxLiveTerminals, 32);
  assert.equal(parsed.resourceLimits.workspaceRuntime.hiddenRuntimeTtlMs, 600000);
  assert.equal(parsed.resourceLimits.telemetry.recentEventLimit, 256);
  assert.equal(parsed.stabilityModes.headlessQueueMode, 'observe');
  assert.equal(parsed.stabilityModes.wsSendMode, 'direct');
  assert.equal(parsed.stabilityModes.frontendRuntimeResidency, 'bounded');
});

test('configSchema applies session processCleanup observe-mode defaults', () => {
  const parsed = configSchema.parse(minimalConfig());

  assert.equal(parsed.session.processCleanup.mode, 'observe');
  assert.equal(parsed.session.processCleanup.gracefulWaitMs, 750);
  assert.equal(parsed.session.processCleanup.forceWaitMs, 1500);
  assert.equal(parsed.session.processCleanup.descendantSampleLimit, 64);
});

test('configSchema validates session processCleanup strictly', () => {
  assert.throws(
    () => configSchema.parse({
      ...minimalConfig(),
      session: {
        idleDelayMs: 200,
        runningDelayMs: 250,
        processCleanup: null,
      },
    }),
    /processCleanup|object|null/i,
  );

  assert.throws(
    () => configSchema.parse({
      ...minimalConfig(),
      session: {
        idleDelayMs: 200,
        runningDelayMs: 250,
        processCleanup: {
          mode: 'force',
        },
      },
    }),
    /mode|observe|enforce|legacy/i,
  );

  assert.throws(
    () => configSchema.parse({
      ...minimalConfig(),
      session: {
        idleDelayMs: 200,
        runningDelayMs: 250,
        processCleanup: {
          descendantSampleLimit: 0,
        },
      },
    }),
    /descendantSampleLimit/i,
  );

  assert.throws(
    () => configSchema.parse({
      ...minimalConfig(),
      session: {
        idleDelayMs: 200,
        runningDelayMs: 250,
        processCleanup: {
          gracefulWaitMs: 750.5,
        },
      },
    }),
    /gracefulWaitMs/i,
  );

  assert.throws(
    () => configSchema.parse({
      ...minimalConfig(),
      session: {
        idleDelayMs: 200,
        runningDelayMs: 250,
        processCleanup: {
          unknownCleanupSwitch: true,
        },
      },
    }),
    /unknownCleanupSwitch|unrecognized/i,
  );
});

test('configSchema validates unsafe resourceLimits values instead of silently stripping them', () => {
  assert.throws(
    () => configSchema.parse({
      ...minimalConfig(),
      resourceLimits: {
        terminal: {
          inputQueueMaxBytes: 0,
        },
      },
    }),
    /resourceLimits|inputQueueMaxBytes/i,
  );
});

test('configSchema rejects misspelled resourceLimits keys instead of defaulting around them', () => {
  assert.throws(
    () => configSchema.parse({
      ...minimalConfig(),
      resourceLimits: {
        terminal: {
          inputQueueMaxBytez: 0,
        },
      },
    }),
    /inputQueueMaxBytez|unrecognized/i,
  );
});

test('configSchema rejects explicit null resourceLimits sections instead of treating them as omitted', () => {
  assert.throws(
    () => configSchema.parse({
      ...minimalConfig(),
      resourceLimits: null,
    }),
    /resourceLimits|object|null/i,
  );

  assert.throws(
    () => configSchema.parse({
      ...minimalConfig(),
      resourceLimits: {
        terminal: null,
      },
    }),
    /terminal|object|null/i,
  );
});

test('configSchema rejects inconsistent resourceLimits relationships', () => {
  assert.throws(
    () => configSchema.parse({
      ...minimalConfig(),
      resourceLimits: {
        ws: {
          serverBufferedHighWaterBytes: 8388608,
          serverBufferedHardLimitBytes: 1048576,
        },
      },
    }),
    /serverBufferedHardLimitBytes/i,
  );

  assert.throws(
    () => configSchema.parse({
      ...minimalConfig(),
      resourceLimits: {
        clientWs: {
          inputBackpressureBytes: 4194304,
          hardReconnectBytes: 1048576,
        },
      },
    }),
    /hardReconnectBytes/i,
  );

  assert.throws(
    () => configSchema.parse({
      ...minimalConfig(),
      resourceLimits: {
        snapshots: {
          perSnapshotMaxChars: 3000000,
          totalStorageBudgetChars: 2000000,
        },
      },
    }),
    /totalStorageBudgetChars/i,
  );
});

test('configSchema rejects zero output coalesce window', () => {
  assert.throws(
    () => configSchema.parse({
      ...minimalConfig(),
      resourceLimits: {
        ws: {
          outputCoalesceWindowMs: 0,
        },
      },
    }),
    /outputCoalesceWindowMs|greater than or equal to 1|too small/i,
  );
});

test('configSchema rejects headless overflow policies that are not implemented', () => {
  for (const overflowPolicy of ['drop-tail', 'terminate-session']) {
    assert.throws(
      () => configSchema.parse({
        ...minimalConfig(),
        resourceLimits: {
          headless: {
            overflowPolicy,
          },
        },
      }),
      /overflowPolicy|degrade-headless/i,
    );
  }
});

test('configSchema validates stabilityModes strictly', () => {
  assert.throws(
    () => configSchema.parse({
      ...minimalConfig(),
      stabilityModes: null,
    }),
    /stabilityModes|object|null/i,
  );

  assert.throws(
    () => configSchema.parse({
      ...minimalConfig(),
      stabilityModes: {
        wsSendMode: 'queued',
      },
    }),
    /wsSendMode|direct|safe-send/i,
  );

  assert.throws(
    () => configSchema.parse({
      ...minimalConfig(),
      stabilityModes: {
        frontendRuntimeResidency: 'bounded',
        unknownSwitch: true,
      },
    }),
    /unknownSwitch|unrecognized/i,
  );
});

test('realtime.terminalWireFormat defaults to json', () => {
  const parsed = configSchema.parse(minimalConfig());

  // The default is what keeps an untouched deployment on exactly today's wire
  // no matter how much binary machinery exists behind it (05 §8.2).
  assert.equal(parsed.realtime.terminalWireFormat, 'json');
});

test('realtime.terminalWireFormat accepts every rung of the ladder', () => {
  for (const terminalWireFormat of ['json', 'binary-shadow', 'binary-optin', 'binary']) {
    const parsed = configSchema.parse({
      ...minimalConfig(),
      realtime: { terminalWireFormat },
    });

    assert.equal(parsed.realtime.terminalWireFormat, terminalWireFormat);
  }
});

test('realtime.terminalWireFormat rejects a value outside the ladder', () => {
  assert.throws(() => configSchema.parse({
    ...minimalConfig(),
    realtime: { terminalWireFormat: 'binary-everywhere' },
  }));
});

test('realtime.terminalWireFormat is independent of wsTransportMode', () => {
  // The two are orthogonal knobs (D12); setting one must not disturb the other.
  const parsed = configSchema.parse({
    ...minimalConfig(),
    realtime: { wsTransportMode: 'split', terminalWireFormat: 'binary-shadow' },
  });

  assert.equal(parsed.realtime.wsTransportMode, 'split');
  assert.equal(parsed.realtime.terminalWireFormat, 'binary-shadow');
});

// --- SEC-BGSTAB-001: the OSC52 policy switch -------------------------------------
//
// 실측 2026-09-19 (병합 전): osc52 / allowWrite 는 이 스키마 어디에도 없었다. 오늘의
// 안전은 결정이 아니라 사고였다 -- xterm 번들이 OSC 52 핸들러를 등록하지 않고
// @xterm/addon-clipboard 가 설치되어 있지 않아서 조용히 버려지고 있었을 뿐이다.
// 아래 세 테스트가 그것을 결정으로 만든다.

test('SEC-BGSTAB-001 AC-2 OSC52 writes default to allowed once the security block exists', () => {
  // `security` is optional at the top level, so the schema default materialises only when the
  // section is present. The effective default for a config with NO security block is supplied
  // by RuntimeConfigStore's single documented fallback -- fail-open by design, per AC-2 -- and
  // is pinned by the runtime-config transport tests rather than here.
  const parsed = configSchema.parse({
    ...minimalConfig(),
    security: { cors: { allowedOrigins: [], credentials: true, maxAge: 86400 } },
  });

  assert.equal(parsed.security?.osc52.allowWrite, true);
});

test('SEC-BGSTAB-001 AC-2 an absent security block leaves the switch to the runtime fallback', () => {
  // Stated rather than assumed: nothing in the parsed config asserts a value here, so anyone
  // reading config.security?.osc52 directly must supply the default themselves. There is
  // exactly one such reader (RuntimeConfigStore.getPublicRuntimeConfig).
  const parsed = configSchema.parse(minimalConfig());

  assert.equal(parsed.security, undefined);
});

test('SEC-BGSTAB-001 AC-2 a hardened deployment can turn OSC52 writes off', () => {
  const parsed = configSchema.parse({
    ...minimalConfig(),
    security: { cors: { allowedOrigins: [], credentials: true, maxAge: 86400 }, osc52: { allowWrite: false } },
  });

  assert.equal(parsed.security?.osc52.allowWrite, false);
});

test('SEC-BGSTAB-001 AC-1 no setting can enable OSC52 reads, at any stability', () => {
  // 읽기는 기본값이 꺼져 있는 것이 아니라 존재하지 않는다. 설정으로 두면 에이전트가
  // 켜도록 설득당할 수 있고, 읽기 응답은 PTY 의 input 채널로 주입되므로 사용자가
  // 마지막으로 복사한 것에 대한 직접적인 유출수단이 된다.
  for (const readish of ['allowRead', 'allow_read', 'read', 'allowReads']) {
    assert.throws(
      () => configSchema.parse({
        ...minimalConfig(),
        security: { cors: { allowedOrigins: [], credentials: true, maxAge: 86400 }, osc52: { [readish]: true } },
      }),
      /unrecognized|Unrecognized/i,
      `${readish} must be rejected, not silently ignored`,
    );
  }
});
