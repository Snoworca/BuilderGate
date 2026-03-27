import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type { Config } from './types/config.types.js';
import type { Session } from './types/index.js';
import { RuntimeConfigStore } from './services/RuntimeConfigStore.js';
import { AuthService } from './services/AuthService.js';
import { CryptoService } from './services/CryptoService.js';
import { ConfigFileRepository } from './services/ConfigFileRepository.js';
import { SettingsService } from './services/SettingsService.js';
import { TwoFactorService } from './services/TwoFactorService.js';
import { SessionManager } from './services/SessionManager.js';
import { FileService } from './services/FileService.js';
import { AppError, ErrorCode } from './utils/errors.js';

async function main(): Promise<void> {
  const tests: Array<{ name: string; run: () => Promise<void> | void }> = [
    { name: 'RuntimeConfigStore builds a redacted editable snapshot', run: testRuntimeConfigSnapshot },
    { name: 'RuntimeConfigStore marks platform capabilities and merges patches', run: testRuntimeConfigCapabilities },
    { name: 'AuthService.updateRuntimeConfig updates password validation and token duration', run: testAuthRuntimeConfig },
    { name: 'SettingsService rejects unsupported settings keys', run: testSettingsUnsupportedSetting },
    { name: 'SettingsService requires an SMTP password when enabling 2FA', run: testSettingsRequiresSmtpPassword },
    { name: 'SettingsService persists editable values and applies runtime updates', run: testSettingsServicePersistence },
    { name: 'SettingsService hot-swaps 2FA state without restart', run: testSettingsTwoFactorHotSwap },
    { name: 'SettingsService blocks password rotation without current password', run: testSettingsPasswordValidation },
    { name: 'SettingsService rotates password for later logins and persists encrypted secret', run: testSettingsPasswordRotation },
    { name: 'SettingsService rolls back runtime state when apply fails', run: testSettingsApplyFailureRollback },
    { name: 'SessionManager.updateRuntimeConfig affects later idle timers and buffer limits', run: testSessionManagerRuntimeConfig },
    { name: 'FileService.updateConfig applies new limits to later operations', run: testFileServiceRuntimeConfig },
  ];

  let failures = 0;

  for (const testCase of tests) {
    try {
      await testCase.run();
      console.log(`PASS ${testCase.name}`);
    } catch (error) {
      failures += 1;
      console.error(`FAIL ${testCase.name}`);
      console.error(error);
    }
  }

  if (failures > 0) {
    console.error(`\n${failures} test(s) failed`);
    process.exitCode = 1;
    return;
  }

  console.log(`\n${tests.length} test(s) passed`);
}

function testRuntimeConfigSnapshot(): void {
  const store = new RuntimeConfigStore(createConfigFixture(), 'win32');
  const snapshot = store.getSnapshot();

  assert.equal(store.isEditable('auth.durationMs'), true);
  assert.equal(store.isEditable('server.port'), false);
  assert.equal(snapshot.values.auth.durationMs, 1800000);
  assert.equal(snapshot.values.twoFactor.smtp.auth.user, 'admin@example.com');
  assert.equal('password' in snapshot.values.twoFactor.smtp.auth, false);
  assert.equal(snapshot.capabilities['auth.password'].writeOnly, true);
  assert.equal(snapshot.capabilities['twoFactor.smtp.auth.password'].writeOnly, true);
  assert.equal(snapshot.secretState.authPasswordConfigured, true);
  assert.equal(snapshot.secretState.smtpPasswordConfigured, true);
  assert.ok(snapshot.excludedSections.includes('ssl.*'));
  assert.ok(snapshot.excludedSections.includes('fileManager.maxCodeFileSize'));
}

function testRuntimeConfigCapabilities(): void {
  const store = new RuntimeConfigStore(createConfigFixture(), 'linux');
  const capabilities = store.getFieldCapabilities();

  assert.equal(capabilities['pty.useConpty'].available, false);
  assert.equal(capabilities['pty.useConpty'].reason, 'Windows-only PTY backend');
  assert.deepEqual(capabilities['pty.shell'].options, ['auto', 'bash']);

  const merged = store.mergeEditablePatch({
    auth: {
      durationMs: 3600000,
      currentPassword: 'ignored',
      newPassword: 'ignored',
      confirmPassword: 'ignored',
    },
    twoFactor: {
      email: 'ops@example.com',
      smtp: {
        auth: {
          user: 'ops@example.com',
          password: 'secret',
        },
      },
    },
    fileManager: {
      blockedExtensions: ['.ps1'],
    },
  });

  assert.equal(merged.auth.durationMs, 3600000);
  assert.equal(merged.twoFactor.email, 'ops@example.com');
  assert.equal(merged.twoFactor.smtp.auth.user, 'ops@example.com');
  assert.deepEqual(merged.fileManager.blockedExtensions, ['.ps1']);
}

function testAuthRuntimeConfig(): void {
  const cryptoService = new CryptoService('auth-service-test');
  const service = new AuthService({
    password: 'old-password',
    durationMs: 60000,
    maxDurationMs: 86400000,
    jwtSecret: 'jwt-secret',
  }, cryptoService);

  try {
    assert.equal(service.validatePassword('old-password'), true);

    service.updateRuntimeConfig({
      password: cryptoService.encrypt('new-password'),
      durationMs: 120000,
    });

    assert.equal(service.validatePassword('old-password'), false);
    assert.equal(service.validatePassword('new-password'), true);
    assert.equal(service.getSessionDuration(), 120000);

    const { payload } = service.issueToken();
    assert.equal(payload.exp - payload.iat, 120);
  } finally {
    service.destroy();
  }
}

async function testSettingsServicePersistence(): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'buildergate-settings-'));
  const configPath = path.join(tempDir, 'config.json5');
  const fixture = createConfigFixture();
  const configContent = createConfigFixtureContent();
  await fs.writeFile(configPath, configContent, 'utf-8');

  const cryptoService = new CryptoService('settings-service-test');
  const runtimeConfigStore = new RuntimeConfigStore(fixture);
  const authService = new AuthService(fixture.auth!, cryptoService);
  const sessionManager = new SessionManager({ pty: fixture.pty, session: fixture.session });
  const fileService = new FileService({
    getSession: () => ({ id: 'session-1' }),
    getPtyPid: () => null,
    getInitialCwd: () => tempDir,
    getCwdFilePath: () => null,
  }, fixture.fileManager!);
  const configRepository = new ConfigFileRepository(configPath);
  let twoFactorService = fixture.twoFactor ? new TwoFactorService(fixture.twoFactor, cryptoService) : undefined;
  const settingsService = new SettingsService({
    runtimeConfigStore,
    configRepository,
    cryptoService,
    authService,
    getTwoFactorService: () => twoFactorService,
    setTwoFactorService: (next) => {
      twoFactorService = next;
    },
    getFileService: () => fileService,
    sessionManager,
  });

  try {
    const result = settingsService.savePatch({
      auth: { durationMs: 900000 },
      fileManager: { maxFileSize: 2048 },
    });

    assert.ok(result.changedKeys.includes('auth.durationMs'));
    assert.ok(result.changedKeys.includes('fileManager.maxFileSize'));
    assert.ok(result.applySummary.new_logins.includes('auth.durationMs'));
    assert.ok(result.applySummary.immediate.includes('fileManager.maxFileSize'));
    assert.equal(authService.getSessionDuration(), 900000);
    assert.equal(runtimeConfigStore.getEditableValues().fileManager.maxFileSize, 2048);
    assert.equal((fileService as any).config.maxFileSize, 2048);

    const savedContent = await fs.readFile(configPath, 'utf-8');
    assert.match(savedContent, /durationMs:\s*900000/);
    assert.match(savedContent, /maxFileSize:\s*2048/);
    assert.match(savedContent, /\/\/ Server settings/);

    const backupPath = `${configPath}.bak`;
    const backupStat = await fs.stat(backupPath);
    assert.ok(backupStat.isFile());
  } finally {
    authService.destroy();
    twoFactorService?.destroy();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function testSettingsUnsupportedSetting(): void {
  const harness = createSettingsHarness();

  try {
    assert.throws(
      () => harness.settingsService.savePatch({ auth: { maxDurationMs: 1 } }),
      (error: unknown) => {
        if (!(error instanceof AppError) || error.code !== ErrorCode.UNSUPPORTED_SETTING) {
          return false;
        }

        const paths = error.details?.paths as string[] | undefined;
        return paths?.includes('auth.maxDurationMs') ?? false;
      },
    );
  } finally {
    harness.destroy();
  }
}

function testSettingsRequiresSmtpPassword(): void {
  const fixture = createConfigFixture();
  fixture.twoFactor = {
    ...fixture.twoFactor!,
    enabled: false,
    smtp: {
      ...fixture.twoFactor!.smtp,
      auth: {
        ...fixture.twoFactor!.smtp.auth,
        password: '',
      },
    },
  };

  const harness = createSettingsHarness({ fixture });

  try {
    assert.throws(
      () => harness.settingsService.savePatch({ twoFactor: { enabled: true } }),
      (error: unknown) => error instanceof AppError
        && error.code === ErrorCode.VALIDATION_ERROR
        && error.message === '2FA requires an SMTP password',
    );
    assert.equal(harness.getTwoFactorService(), undefined);
  } finally {
    harness.destroy();
  }
}

function testSettingsPasswordValidation(): void {
  const fixture = createConfigFixture();
  const cryptoService = new CryptoService('settings-password-validation');
  const authService = new AuthService({
    ...fixture.auth!,
    password: 'old-password',
  }, cryptoService);
  const settingsService = new SettingsService({
    runtimeConfigStore: new RuntimeConfigStore({
      ...fixture,
      auth: { ...fixture.auth!, password: 'old-password' },
    }),
    configRepository: new ConfigFileRepository(path.join(os.tmpdir(), 'unused-config.json5')),
    cryptoService,
    authService,
    getTwoFactorService: () => undefined,
    setTwoFactorService: () => undefined,
    getFileService: () => new FileService({
      getSession: () => ({ id: 'session-1' }),
      getPtyPid: () => null,
      getInitialCwd: () => os.tmpdir(),
      getCwdFilePath: () => null,
    }, fixture.fileManager!),
    sessionManager: new SessionManager({ pty: fixture.pty, session: fixture.session }),
  });

  try {
    assert.throws(
      () => settingsService.savePatch({ auth: { newPassword: 'new-password', confirmPassword: 'new-password' } }),
      (error: unknown) => error instanceof AppError && error.code === ErrorCode.CURRENT_PASSWORD_REQUIRED,
    );
  } finally {
    authService.destroy();
  }
}

async function testSettingsPasswordRotation(): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'buildergate-password-rotation-'));
  const configPath = path.join(tempDir, 'config.json5');
  const fixture = createConfigFixture();
  fixture.auth = {
    ...fixture.auth!,
    password: 'old-password',
  };

  await fs.writeFile(configPath, createConfigFixtureContent(), 'utf-8');

  const harness = createSettingsHarness({ fixture, configPath });

  try {
    const result = harness.settingsService.savePatch({
      auth: {
        currentPassword: 'old-password',
        newPassword: 'new-password',
        confirmPassword: 'new-password',
      },
    });

    assert.ok(result.changedKeys.includes('auth.password'));
    assert.ok(result.applySummary.new_logins.includes('auth.password'));
    assert.equal(harness.authService.validatePassword('old-password'), false);
    assert.equal(harness.authService.validatePassword('new-password'), true);

    const savedContent = await fs.readFile(configPath, 'utf-8');
    assert.match(savedContent, /password:\s*"enc\(.+\)"/);
    assert.doesNotMatch(savedContent, /password:\s*"new-password"/);
  } finally {
    harness.destroy();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function testSettingsTwoFactorHotSwap(): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'buildergate-2fa-hot-swap-'));
  const configPath = path.join(tempDir, 'config.json5');
  const fixture = createConfigFixture();
  fixture.twoFactor = {
    ...fixture.twoFactor!,
    enabled: false,
  };

  await fs.writeFile(configPath, createConfigFixtureContent(), 'utf-8');

  const harness = createSettingsHarness({ fixture, configPath });

  try {
    assert.equal(harness.getTwoFactorService(), undefined);

    const enableResult = harness.settingsService.savePatch({ twoFactor: { enabled: true } });
    assert.ok(enableResult.applySummary.new_logins.includes('twoFactor.enabled'));
    assert.equal(harness.getTwoFactorService()?.isEnabled(), true);

    const disableResult = harness.settingsService.savePatch({ twoFactor: { enabled: false } });
    assert.ok(disableResult.applySummary.new_logins.includes('twoFactor.enabled'));
    assert.equal(harness.getTwoFactorService(), undefined);
  } finally {
    harness.destroy();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function testSettingsApplyFailureRollback(): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'buildergate-settings-rollback-'));
  const configPath = path.join(tempDir, 'config.json5');
  const fixture = createConfigFixture();
  const originalContent = createConfigFixtureContent();

  await fs.writeFile(configPath, originalContent, 'utf-8');

  const failingFileService = {
    updateConfig: () => {
      throw new Error('simulated file service apply failure');
    },
  } as unknown as FileService;

  const harness = createSettingsHarness({ fixture, configPath, fileService: failingFileService });

  try {
    assert.throws(
      () => harness.settingsService.savePatch({ auth: { durationMs: 900000 } }),
      (error: unknown) => error instanceof AppError && error.code === ErrorCode.CONFIG_APPLY_FAILED,
    );

    assert.equal(harness.authService.getSessionDuration(), fixture.auth!.durationMs);
    assert.equal(harness.runtimeConfigStore.getEditableValues().auth.durationMs, fixture.auth!.durationMs);

    const savedContent = await fs.readFile(configPath, 'utf-8');
    assert.equal(savedContent, originalContent);
    await assert.rejects(() => fs.stat(`${configPath}.bak`));
  } finally {
    harness.destroy();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function testSessionManagerRuntimeConfig(): Promise<void> {
  const manager = new SessionManager({
    pty: {
      termName: 'xterm-256color',
      defaultCols: 80,
      defaultRows: 24,
      useConpty: true,
      maxBufferSize: 16,
      shell: 'auto',
    },
    session: {
      idleDelayMs: 200,
    },
  });

  const fakeSession: Session = {
    id: 'session-1',
    name: 'Session 1',
    status: 'running',
    createdAt: new Date(),
    lastActiveAt: new Date(),
    sortOrder: 0,
  };

  const sessionData = {
    session: fakeSession,
    pty: {} as never,

    idleTimer: null as NodeJS.Timeout | null,
    outputBuffer: 'abcdefgh',
    initialCwd: process.cwd(),
  };

  (manager as any).sessions.set(fakeSession.id, sessionData);

  try {
    manager.updateRuntimeConfig({
      idleDelayMs: 20,
      pty: {
        defaultCols: 120,
        maxBufferSize: 4,
        shell: 'bash',
      },
    });

    assert.equal((manager as any).runtimePtyConfig.defaultCols, 120);
    assert.equal((manager as any).runtimePtyConfig.shell, 'bash');
    assert.equal((manager as any).runtimeSessionConfig.idleDelayMs, 20);
    assert.equal(sessionData.outputBuffer, 'efgh');

    (manager as any).scheduleIdleTransition(fakeSession.id);
    await delay(40);

    assert.equal(fakeSession.status, 'idle');
  } finally {
    if (sessionData.idleTimer) {
      clearTimeout(sessionData.idleTimer);
    }
  }
}

async function testFileServiceRuntimeConfig(): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'buildergate-file-service-'));
  const filePath = path.join(tempDir, 'note.txt');
  const fileContents = '12345';

  await fs.writeFile(filePath, fileContents, 'utf-8');

  const sessionManager = {
    getSession: () => ({ id: 'session-1' }),
    getPtyPid: () => null,
    getInitialCwd: () => tempDir,
    getCwdFilePath: () => null,
  };

  const service = new FileService(sessionManager, {
    maxFileSize: 10,
    maxCodeFileSize: 524288,
    maxDirectoryEntries: 10000,
    blockedExtensions: [],
    blockedPaths: [],
    cwdCacheTtlMs: 1000,
  });

  try {
    const initialRead = await service.readFile('session-1', 'note.txt');
    assert.equal(initialRead.content, fileContents);

    service.updateConfig({
      maxFileSize: 4,
      maxCodeFileSize: 524288,
      maxDirectoryEntries: 10000,
      blockedExtensions: [],
      blockedPaths: [],
      cwdCacheTtlMs: 1000,
    });

    await assert.rejects(
      () => service.readFile('session-1', 'note.txt'),
      (error: unknown) => error instanceof AppError && error.code === ErrorCode.FILE_TOO_LARGE,
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
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
      useConpty: true,
      maxBufferSize: 65536,
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
      enabled: true,
      email: 'admin@example.com',
      otpLength: 6,
      otpExpiryMs: 300000,
      smtp: {
        host: 'smtp.example.com',
        port: 587,
        secure: false,
        auth: {
          user: 'admin@example.com',
          password: 'enc(smtp)',
        },
        tls: {
          rejectUnauthorized: true,
          minVersion: 'TLSv1.2',
        },
      },
    },
  };
}

function createSettingsHarness({
  fixture = createConfigFixture(),
  configPath = path.join(os.tmpdir(), 'unused-config.json5'),
  fileService = new FileService({
    getSession: () => ({ id: 'session-1' }),
    getPtyPid: () => null,
    getInitialCwd: () => os.tmpdir(),
    getCwdFilePath: () => null,
  }, fixture.fileManager!),
}: {
  fixture?: Config;
  configPath?: string;
  fileService?: FileService;
} = {}) {
  const cryptoService = new CryptoService(`settings-harness-${Math.random().toString(36).slice(2)}`);
  const runtimeConfigStore = new RuntimeConfigStore(fixture);
  const authService = new AuthService(fixture.auth!, cryptoService);
  const sessionManager = new SessionManager({ pty: fixture.pty, session: fixture.session });
  const configRepository = new ConfigFileRepository(configPath);
  let twoFactorService = fixture.twoFactor?.enabled ? new TwoFactorService(fixture.twoFactor, cryptoService) : undefined;
  const settingsService = new SettingsService({
    runtimeConfigStore,
    configRepository,
    cryptoService,
    authService,
    getTwoFactorService: () => twoFactorService,
    setTwoFactorService: (next) => {
      twoFactorService = next;
    },
    getFileService: () => fileService,
    sessionManager,
  });

  return {
    authService,
    runtimeConfigStore,
    settingsService,
    getTwoFactorService: () => twoFactorService,
    destroy: () => {
      authService.destroy();
      twoFactorService?.destroy();
    },
  };
}

function createConfigFixtureContent(): string {
  return `{
  // Server settings
  server: {
    port: 4242,
  },
  pty: {
    termName: "xterm-256color",
    defaultCols: 80,
    defaultRows: 24,
    useConpty: true,
    maxBufferSize: 65536,
    shell: "auto",
  },
  session: {
    idleDelayMs: 200,
  },
  security: {
    cors: {
      allowedOrigins: ["https://example.com"],
      credentials: true,
      maxAge: 86400,
    }
  },
  auth: {
    password: "old-password",
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
  twoFactor: {
    enabled: false,
    email: "admin@example.com",
    otpLength: 6,
    otpExpiryMs: 300000,
    smtp: {
      host: "smtp.example.com",
      port: 587,
      secure: false,
      auth: {
        user: "admin@example.com",
        password: "smtp-password",
      },
      tls: {
        rejectUnauthorized: true,
        minVersion: "TLSv1.2",
      }
    },
  },
}`;
}

void main();
