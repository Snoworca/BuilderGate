import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import type { Config } from '../types/config.types.js';
import { ConfigFileRepository } from './ConfigFileRepository.js';
import { RuntimeConfigStore } from './RuntimeConfigStore.js';
import { SettingsService } from './SettingsService.js';
import { CryptoService } from './CryptoService.js';
import { AuthService } from './AuthService.js';
import { SessionManager } from './SessionManager.js';
import { AppError, ErrorCode } from '../utils/errors.js';

test('SettingsService persists selected Wave6 resource settings and reports truthful scopes', async () => {
  const fixture = createConfigFixture();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'buildergate-wave6-settings-'));
  const configPath = path.join(tempDir, 'config.json5');
  await fs.writeFile(configPath, createLegacyConfigContent(), 'utf-8');
  const cryptoService = new CryptoService('wave6-editable-resource-settings');
  const authService = new AuthService(fixture.auth!, cryptoService);
  const runtimeConfigStore = new RuntimeConfigStore(fixture, 'linux');
  const wsRuntimeUpdates: unknown[] = [];
  const settingsService = new SettingsService({
    runtimeConfigStore,
    configRepository: new ConfigFileRepository(configPath, 'linux'),
    cryptoService,
    authService,
    getFileService: () => ({ updateConfig: () => undefined } as any),
    sessionManager: new SessionManager({ pty: fixture.pty, session: fixture.session }, { platform: 'linux' }),
    getWsRouter: () => ({
      updateRuntimeConfig: (runtimeConfig: unknown) => {
        wsRuntimeUpdates.push(runtimeConfig);
      },
    } as any),
  }, 'linux');

  try {
    const response = settingsService.savePatch({
      resourceLimits: {
        headless: {
          pendingOutputMaxBytes: 2_097_152,
        },
        ws: {
          serverBufferedHighWaterBytes: 2_000_000,
          serverBufferedHardLimitBytes: 8_000_000,
          perClientOutputQueueMaxBytes: 3_000_000,
        },
        clientWs: {
          inputBackpressureBytes: 2_000_000,
          hardReconnectBytes: 8_000_000,
        },
        terminal: {
          inputQueueMaxBytes: 131_072,
          hiddenOutputPolicy: 'debug-tail',
          hiddenOutputTailBytes: 4096,
        },
        snapshots: {
          perSnapshotMaxChars: 1_000_000,
          totalStorageBudgetChars: 10_000_000,
          maxEntries: 32,
        },
        workspaceRuntime: {
          maxLiveWorkspaces: 4,
          maxLiveTerminals: 16,
        },
      },
    });
    const publicConfig = runtimeConfigStore.getPublicRuntimeConfig('queue');
    const savedContent = await fs.readFile(configPath, 'utf-8');

    assert.equal(response.values.resourceLimits.headless.pendingOutputMaxBytes, 2_097_152);
    assert.equal(response.values.resourceLimits.ws.serverBufferedHighWaterBytes, 2_000_000);
    assert.equal(response.values.resourceLimits.clientWs.inputBackpressureBytes, 2_000_000);
    assert.equal(response.values.resourceLimits.terminal.hiddenOutputPolicy, 'debug-tail');
    assert.equal(response.values.resourceLimits.snapshots.maxEntries, 32);
    assert.ok(response.changedKeys.includes('resourceLimits.clientWs.inputBackpressureBytes'));
    assert.ok(response.changedKeys.includes('resourceLimits.headless.pendingOutputMaxBytes'));
    assert.ok(response.changedKeys.includes('resourceLimits.ws.serverBufferedHighWaterBytes'));
    assert.ok(response.changedKeys.includes('resourceLimits.terminal.hiddenOutputPolicy'));
    assert.ok(response.changedKeys.includes('resourceLimits.snapshots.maxEntries'));
    assert.ok(response.changedKeys.includes('resourceLimits.workspaceRuntime.maxLiveTerminals'));
    assert.ok(response.applySummary.immediate.includes('resourceLimits.clientWs.inputBackpressureBytes'));
    assert.ok(response.applySummary.immediate.includes('resourceLimits.ws.serverBufferedHighWaterBytes'));
    assert.ok(response.applySummary.new_sessions.includes('resourceLimits.headless.pendingOutputMaxBytes'));
    assert.equal(publicConfig.resourceLimits.clientWs.inputBackpressureBytes, 2_000_000);
    assert.equal(publicConfig.resourceLimits.terminal.hiddenOutputPolicy, 'debug-tail');
    assert.equal(publicConfig.resourceLimits.snapshots.maxEntries, 32);
    assert.equal('headless' in publicConfig.resourceLimits, false);
    assert.equal('ws' in publicConfig.resourceLimits, false);
    assert.ok(wsRuntimeUpdates.length > 0);
    assert.match(savedContent, /headless:\s*\{[\s\S]*pendingOutputMaxBytes:\s*2097152/);
    assert.match(savedContent, /ws:\s*\{[\s\S]*serverBufferedHighWaterBytes:\s*2000000/);
    assert.match(savedContent, /clientWs:\s*\{[\s\S]*inputBackpressureBytes:\s*2000000/);
    assert.match(savedContent, /snapshots:\s*\{[\s\S]*maxEntries:\s*32/);
  } finally {
    authService.destroy();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('SettingsService rejects invalid Wave6 resource relationships before persistence', async () => {
  const fixture = createConfigFixture();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'buildergate-wave6-invalid-settings-'));
  const configPath = path.join(tempDir, 'config.json5');
  await fs.writeFile(configPath, createLegacyConfigContent(), 'utf-8');
  const cryptoService = new CryptoService('wave6-invalid-resource-settings');
  const authService = new AuthService(fixture.auth!, cryptoService);
  const settingsService = new SettingsService({
    runtimeConfigStore: new RuntimeConfigStore(fixture, 'linux'),
    configRepository: new ConfigFileRepository(configPath, 'linux'),
    cryptoService,
    authService,
    getFileService: () => ({ updateConfig: () => undefined } as any),
    sessionManager: new SessionManager({ pty: fixture.pty, session: fixture.session }, { platform: 'linux' }),
  }, 'linux');

  try {
    const invalidPatches: Array<{ input: unknown; expectedMessage: RegExp }> = [
      {
        input: {
          resourceLimits: {
            clientWs: {
              inputBackpressureBytes: 8_000_000,
              hardReconnectBytes: 2_000_000,
            },
          },
        },
        expectedMessage: /hardReconnectBytes must be greater than inputBackpressureBytes/i,
      },
      {
        input: {
          resourceLimits: {
            ws: {
              serverBufferedHighWaterBytes: 8_000_000,
              serverBufferedHardLimitBytes: 2_000_000,
            },
          },
        },
        expectedMessage: /serverBufferedHardLimitBytes must be greater than serverBufferedHighWaterBytes/i,
      },
      {
        input: {
          resourceLimits: {
            snapshots: {
              perSnapshotMaxChars: 10_000_000,
              totalStorageBudgetChars: 1_000_000,
            },
          },
        },
        expectedMessage: /totalStorageBudgetChars must be greater than or equal to perSnapshotMaxChars/i,
      },
    ];

    for (const { input, expectedMessage } of invalidPatches) {
      assert.throws(
        () => settingsService.savePatch(input),
        (error: unknown) => isValidationAppErrorWithIssue(error, expectedMessage),
      );
    }

    const savedContent = await fs.readFile(configPath, 'utf-8');
    assert.equal(savedContent, createLegacyConfigContent());
  } finally {
    authService.destroy();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('SettingsService rejects reserved Wave6 resource keys and ignores no-op selected patches', async () => {
  const fixture = createConfigFixture();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'buildergate-wave6-reserved-settings-'));
  const configPath = path.join(tempDir, 'config.json5');
  await fs.writeFile(configPath, createLegacyConfigContent(), 'utf-8');
  const cryptoService = new CryptoService('wave6-reserved-resource-settings');
  const authService = new AuthService(fixture.auth!, cryptoService);
  const settingsService = new SettingsService({
    runtimeConfigStore: new RuntimeConfigStore(fixture, 'linux'),
    configRepository: new ConfigFileRepository(configPath, 'linux'),
    cryptoService,
    authService,
    getFileService: () => ({ updateConfig: () => undefined } as any),
    sessionManager: new SessionManager({ pty: fixture.pty, session: fixture.session }, { platform: 'linux' }),
  }, 'linux');

  try {
    assert.throws(
      () => settingsService.savePatch({
        resourceLimits: {
          ws: {
            perClientControlQueueMaxBytes: 262_144,
          },
        },
      }),
      (error: unknown) => error instanceof AppError
        && error.code === ErrorCode.VALIDATION_ERROR
        && /selected Wave6 Settings field set/i.test(error.message),
    );

    assert.throws(
      () => settingsService.savePatch({
        stabilityModes: {
          wsSendMode: 'safe-send-observe',
        },
      }),
      (error: unknown) => error instanceof AppError
        && error.code === ErrorCode.VALIDATION_ERROR
        && /selected Wave6 Settings field set/i.test(error.message),
    );

    const noOpResponse = settingsService.savePatch({
      resourceLimits: {
        clientWs: {
          inputBackpressureBytes: 1_048_576,
        },
      },
    });

    assert.deepEqual(noOpResponse.changedKeys, []);
    assert.deepEqual(noOpResponse.applySummary, {
      immediate: [],
      new_logins: [],
      new_sessions: [],
      warnings: [],
    });
    assert.equal(await fs.readFile(configPath, 'utf-8'), createLegacyConfigContent());
  } finally {
    authService.destroy();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('SettingsService rolls back Wave6 resource runtime state when apply fails', async () => {
  const fixture = createConfigFixture();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'buildergate-wave6-rollback-settings-'));
  const configPath = path.join(tempDir, 'config.json5');
  await fs.writeFile(configPath, createLegacyConfigContent(), 'utf-8');
  const cryptoService = new CryptoService('wave6-rollback-resource-settings');
  const authService = new AuthService(fixture.auth!, cryptoService);
  const runtimeConfigStore = new RuntimeConfigStore(fixture, 'linux');
  let fileApplyCount = 0;
  const settingsService = new SettingsService({
    runtimeConfigStore,
    configRepository: new ConfigFileRepository(configPath, 'linux'),
    cryptoService,
    authService,
    getFileService: () => ({
      updateConfig: () => {
        fileApplyCount += 1;
        if (fileApplyCount === 1) {
          throw new Error('file apply failed');
        }
      },
    } as any),
    sessionManager: new SessionManager({ pty: fixture.pty, session: fixture.session }, { platform: 'linux' }),
  }, 'linux');

  try {
    assert.throws(
      () => settingsService.savePatch({
        resourceLimits: {
          clientWs: {
            inputBackpressureBytes: 2_000_000,
            hardReconnectBytes: 8_000_000,
          },
        },
      }),
      (error: unknown) => error instanceof AppError
        && error.code === ErrorCode.CONFIG_APPLY_FAILED
        && /file apply failed/i.test(error.message),
    );

    assert.equal(runtimeConfigStore.getEditableValues().resourceLimits.clientWs.inputBackpressureBytes, 1_048_576);
    assert.equal(await fs.readFile(configPath, 'utf-8'), createLegacyConfigContent());
  } finally {
    authService.destroy();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

function isValidationAppErrorWithIssue(error: unknown, expectedMessage: RegExp): boolean {
  if (!(error instanceof AppError) || error.code !== ErrorCode.VALIDATION_ERROR) {
    return false;
  }

  const issues = Array.isArray(error.details?.issues) ? error.details.issues : [];
  return issues.some((issue) =>
    typeof issue === 'object'
    && issue !== null
    && 'message' in issue
    && expectedMessage.test(String(issue.message))
  );
}

function createConfigFixture(): Config {
  return {
    server: {
      port: 4242,
    },
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
    },
    security: {
      cors: {
        allowedOrigins: [],
        credentials: true,
        maxAge: 86400,
      },
    },
    auth: {
      password: '',
      durationMs: 1800000,
      maxDurationMs: 86400000,
      jwtSecret: 'jwt-secret',
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

function createLegacyConfigContent(): string {
  return `{
  server: {
    port: 4242,
  },
  pty: {
    termName: "xterm-256color",
    defaultCols: 80,
    defaultRows: 24,
    useConpty: false,
    windowsPowerShellBackend: "inherit",
    scrollbackLines: 1000,
    maxSnapshotBytes: 2097152,
    shell: "auto",
  },
  session: {
    idleDelayMs: 200,
  },
  security: {
    cors: {
      allowedOrigins: [],
      credentials: true,
      maxAge: 86400,
    },
  },
  auth: {
    password: "",
    durationMs: 1800000,
    maxDurationMs: 86400000,
    jwtSecret: "jwt-secret",
  },
  fileManager: {
    maxFileSize: 1048576,
    maxCodeFileSize: 524288,
    maxDirectoryEntries: 10000,
    blockedExtensions: [".exe", ".dll"],
    blockedPaths: [".ssh", ".aws"],
    cwdCacheTtlMs: 1000,
  },
}`;
}
