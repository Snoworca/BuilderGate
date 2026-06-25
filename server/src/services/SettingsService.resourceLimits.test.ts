import test from 'node:test';
import assert from 'node:assert/strict';
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

test('SettingsService rejects Wave 0 server-side resource settings that are not applied by runtime consumers', () => {
  const fixture = createConfigFixture();
  const cryptoService = new CryptoService('wave0-unapplied-resource-settings');
  const authService = new AuthService(fixture.auth!, cryptoService);
  const settingsService = new SettingsService({
    runtimeConfigStore: new RuntimeConfigStore(fixture, 'linux'),
    configRepository: new ConfigFileRepository(path.join(os.tmpdir(), 'unused-buildergate-config.json5'), 'linux'),
    cryptoService,
    authService,
    getFileService: () => {
      throw new Error('FileService should not be used for rejected Wave 0 resource settings');
    },
    sessionManager: new SessionManager({ pty: fixture.pty, session: fixture.session }),
  });

  try {
    assert.throws(
      () => settingsService.savePatch({
        resourceLimits: {
          ws: {
            serverBufferedHighWaterBytes: 16_777_216,
          },
        },
      }),
      (error: unknown) => error instanceof AppError
        && error.code === ErrorCode.VALIDATION_ERROR
        && /later stability wave/i.test(error.message),
    );
  } finally {
    authService.destroy();
  }
});

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
