import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import http from 'node:http';
import type net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import type { Config } from './types/config.types.js';
import type { Session } from './types/index.js';
import { twoFactorSchema, authSchema } from './schemas/config.schema.js';
import { TOTPService } from './services/TOTPService.js';
import { generateSync, generateSecret } from 'otplib';
import { RuntimeConfigStore } from './services/RuntimeConfigStore.js';
import { AuthService } from './services/AuthService.js';
import { CryptoService } from './services/CryptoService.js';
import { ConfigFileRepository } from './services/ConfigFileRepository.js';
import { SettingsService } from './services/SettingsService.js';
import { SessionManager } from './services/SessionManager.js';
import { FileService } from './services/FileService.js';
import { AppError, ErrorCode } from './utils/errors.js';
import { createAuthRoutes } from './routes/authRoutes.js';
import express from 'express';

async function main(): Promise<void> {
  const tests: Array<{ name: string; run: () => Promise<void> | void }> = [
    { name: 'RuntimeConfigStore builds a redacted editable snapshot', run: testRuntimeConfigSnapshot },
    { name: 'RuntimeConfigStore marks platform capabilities and merges patches', run: testRuntimeConfigCapabilities },
    { name: 'AuthService.updateRuntimeConfig updates password validation and token duration', run: testAuthRuntimeConfig },
    { name: 'SettingsService rejects unsupported settings keys', run: testSettingsUnsupportedSetting },
    { name: 'SettingsService persists editable values and applies runtime updates', run: testSettingsServicePersistence },
    { name: 'SettingsService blocks password rotation without current password', run: testSettingsPasswordValidation },
    { name: 'SettingsService rotates password for later logins and persists encrypted secret', run: testSettingsPasswordRotation },
    { name: 'SettingsService rolls back runtime state when apply fails', run: testSettingsApplyFailureRollback },
    { name: 'SessionManager.updateRuntimeConfig affects later idle timers and buffer limits', run: testSessionManagerRuntimeConfig },
    { name: 'FileService.updateConfig applies new limits to later operations', run: testFileServiceRuntimeConfig },
    { name: 'twoFactorSchema accepts TOTP-only config', run: testTwoFactorSchemaTotp },
    { name: 'twoFactorSchema accepts disabled 2FA with no methods configured', run: testTwoFactorSchemaDisabled },
    { name: 'authSchema applies localhostPasswordOnly default false', run: testAuthSchemaLocalhostDefault },
    { name: 'TOTPService.verifyTOTP rejects unregistered service', run: testTOTPServiceNotRegistered },
    { name: 'TOTPService.verifyTOTP rejects after 3 attempts', run: testTOTPServiceMaxAttempts },
    { name: 'TOTPService.verifyTOTP accepts valid code', run: testTOTPServiceValidCode },
    { name: 'TOTPService.verifyTOTP rejects replayed code (NFR-105)', run: testTOTPServiceReplay },
    { name: 'TOTPService.isRegistered returns false before initialize', run: testTOTPServiceRegistered },
    { name: 'TOTPService.verifyTOTP increments attempts on invalid code (NFR-104)', run: testTOTPServiceAttemptsIncrement },
    { name: 'TOTPService.createPendingAuth returns tempToken (Phase 3)', run: testTOTPCreatePendingAuth },
    { name: 'TOTPService.getOTPData returns stored data (Phase 3)', run: testTOTPGetOTPData },
    { name: 'TOTPService.invalidatePendingAuth removes entry (Phase 3)', run: testTOTPInvalidate },
    { name: 'AuthService.getLocalhostPasswordOnly defaults false (Phase 3)', run: testAuthLocalhostPasswordOnly },
    { name: 'TOTPService.initialize() generates secret on first start (FR-201)', run: testTOTPInitializeGeneratesSecret },
    { name: 'TOTPService.initialize() loads existing secret from file (FR-202)', run: testTOTPInitializeLoadsSecret },
    { name: 'TOTPService.initialize() throws on corrupted secret file (FR-204)', run: testTOTPInitializeThrowsOnCorrupted },
    // Phase 4: authRoutes — 4 COMBO flows
    { name: 'authRoutes COMBO-3: TOTP-only login returns 202 with nextStage totp (Phase 4)', run: testAuthRoutesCombo3Login },
    { name: 'authRoutes FR-401: TOTP enabled but unregistered returns 503 (Phase 4)', run: testAuthRoutesUnregisteredTOTP503 },
    { name: 'authRoutes FR-802: stage mismatch returns 400 (Phase 4)', run: testAuthRoutesStageMismatch },
    { name: 'authRoutes COMBO-1: 2FA disabled returns JWT directly (Phase 4)', run: testAuthRoutesCombo1 },
    { name: 'authRoutes localhostPasswordOnly: localhost bypass returns JWT (Phase 4)', run: testAuthRoutesLocalhostBypass },
    { name: 'authRoutes TOTP verify success issues JWT (Phase 4)', run: testAuthRoutesTOTPVerifySuccess },
    { name: 'authRoutes TOTP max attempts returns attemptsRemaining 0 (Phase 4)', run: testAuthRoutesTOTPMaxAttempts },
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
  assert.equal(snapshot.capabilities['auth.password'].writeOnly, true);
  assert.equal(snapshot.secretState.authPasswordConfigured, true);
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
    fileManager: {
      blockedExtensions: ['.ps1'],
    },
  });

  assert.equal(merged.auth.durationMs, 3600000);
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
  const settingsService = new SettingsService({
    runtimeConfigStore,
    configRepository,
    cryptoService,
    authService,
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
      useConpty: false,
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
      enabled: false,
      externalOnly: false,
      issuer: 'BuilderGate',
      accountName: 'admin',
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
  const settingsService = new SettingsService({
    runtimeConfigStore,
    configRepository,
    cryptoService,
    authService,
    getFileService: () => fileService,
    sessionManager,
  });

  return {
    authService,
    runtimeConfigStore,
    settingsService,
    destroy: () => {
      authService.destroy();
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
    useConpty: false,
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
    externalOnly: false,
    issuer: "BuilderGate",
    accountName: "admin",
  },
}`;
}

// ============================================================================
// Phase 1 (Step 6): TOTP schema validation tests
// ============================================================================

function testTwoFactorSchemaTotp(): void {
  // 정상: TOTP only (smtp 없음) — enabled=true should pass
  const result = twoFactorSchema.safeParse({
    externalOnly: false,
    enabled: true,
  });
  assert.ok(result.success, `Expected TOTP-only to pass, got: ${!result.success && result.error?.issues[0]?.message}`);
  assert.equal(result.data?.enabled, true);
}

function testTwoFactorSchemaDisabled(): void {
  // 경계값: 아무 방식도 없어도 통과 (externalOnly only)
  const result = twoFactorSchema.safeParse({ externalOnly: false });
  assert.ok(result.success, `Expected empty twoFactor to pass, got: ${!result.success && result.error?.issues[0]?.message}`);
}

function testAuthSchemaLocalhostDefault(): void {
  // authSchema: localhostPasswordOnly 미포함 시 default=false
  const result = authSchema.safeParse({
    password: 'test',
    durationMs: 1800000,
    maxDurationMs: 86400000,
    jwtSecret: '',
  });
  assert.ok(result.success, 'Expected auth schema to pass');
  assert.equal(result.data?.localhostPasswordOnly, false, 'Expected default to be false');
}

// ============================================================================
// Phase 2 (Step 6): TOTPService unit tests
// initialize() tests use a tmp directory to avoid side effects (FR-201, FR-202, FR-204)
// ============================================================================

function makeTOTPServiceWithSecret(secret: string): TOTPService {
  // Stub CryptoService — not needed for verifyTOTP tests
  const stubCrypto = {} as import('./services/CryptoService.js').CryptoService;
  const service = new TOTPService({ enabled: true, issuer: 'Test', accountName: 'test' }, stubCrypto);
  // Directly inject secret via cast to bypass private access for testing
  (service as unknown as { secret: string; registered: boolean }).secret = secret;
  (service as unknown as { secret: string; registered: boolean }).registered = true;
  return service;
}

function makeOTPData(overrides: Partial<import('./types/auth.types.js').OTPData> = {}): import('./types/auth.types.js').OTPData {
  return {
    otp: '',
    expiresAt: Date.now() + 300000,
    attempts: 0,
    stage: 'totp',
    ...overrides,
  };
}

function testTOTPServiceNotRegistered(): void {
  const stubCrypto = {} as import('./services/CryptoService.js').CryptoService;
  const service = new TOTPService({ enabled: true }, stubCrypto);
  // Not initialized — registered=false, secret=null
  const result = service.verifyTOTP('123456', makeOTPData());
  assert.equal(result.valid, false, 'Unregistered service should reject all codes');
}

function testTOTPServiceMaxAttempts(): void {
  const secret = generateSecret();
  const service = makeTOTPServiceWithSecret(secret);
  const code = generateSync({ secret });
  // 3 attempts already used
  const result = service.verifyTOTP(code, makeOTPData({ attempts: 3 }));
  assert.equal(result.valid, false, 'Should reject after 3 attempts');
}

function testTOTPServiceValidCode(): void {
  const secret = generateSecret();
  const service = makeTOTPServiceWithSecret(secret);
  const code = generateSync({ secret });
  const result = service.verifyTOTP(code, makeOTPData({ attempts: 0 }));
  assert.equal(result.valid, true, `Valid code should be accepted, got: ${result.valid}`);
}

function testTOTPServiceReplay(): void {
  const secret = generateSecret();
  const service = makeTOTPServiceWithSecret(secret);
  const code = generateSync({ secret });

  // First verification — sets the stage for the replay test
  const result1 = service.verifyTOTP(code, makeOTPData({ attempts: 0 }));
  assert.equal(result1.valid, true, 'First use should succeed');

  // Simulate reply: use the same time step as lastUsedStep
  const currentStep = Math.floor(Date.now() / 30000);
  const result2 = service.verifyTOTP(code, makeOTPData({ attempts: 0, totpLastUsedStep: currentStep }));
  assert.equal(result2.valid, false, 'Replay with same timeStep should be rejected (NFR-105)');
}

function testTOTPServiceRegistered(): void {
  const stubCrypto = {} as import('./services/CryptoService.js').CryptoService;
  const service = new TOTPService({ enabled: true }, stubCrypto);
  assert.equal(service.isRegistered(), false, 'Should be unregistered before initialize()');
  service.destroy();
  assert.equal(service.isRegistered(), false, 'Should be unregistered after destroy()');
}

function testTOTPServiceAttemptsIncrement(): void {
  const secret = generateSecret();
  const service = makeTOTPServiceWithSecret(secret);
  const otpData = makeOTPData({ attempts: 0 });
  // Submit a wrong code
  service.verifyTOTP('000000', otpData);
  assert.equal(otpData.attempts, 1, 'attempts should be incremented after invalid code');
  service.verifyTOTP('000000', otpData);
  assert.equal(otpData.attempts, 2, 'attempts should be 2 after second invalid code');
  // Third wrong attempt
  service.verifyTOTP('000000', otpData);
  assert.equal(otpData.attempts, 3, 'attempts should be 3 after third invalid code');
  // Now should be blocked regardless of code validity
  const validCode = generateSync({ secret });
  const result = service.verifyTOTP(validCode, otpData);
  assert.equal(result.valid, false, 'Should reject at max attempts even with valid code');
  assert.equal(otpData.attempts, 3, 'attempts should not increment beyond max');
}

// ============================================================================
// Phase 3: TOTPService pending auth methods + AuthService.getLocalhostPasswordOnly
// ============================================================================

function testTOTPCreatePendingAuth(): void {
  const stubCrypto = {} as import('./services/CryptoService.js').CryptoService;
  const svc = new TOTPService({ enabled: true }, stubCrypto);
  const result = svc.createPendingAuth();
  assert.ok(typeof result.tempToken === 'string', 'tempToken should be a string');
  assert.ok(result.tempToken.length > 0, 'tempToken should be non-empty');
  svc.destroy();
}

function testTOTPGetOTPData(): void {
  const stubCrypto = {} as import('./services/CryptoService.js').CryptoService;
  const svc = new TOTPService({ enabled: true }, stubCrypto);
  const { tempToken } = svc.createPendingAuth();
  const data = svc.getOTPData(tempToken);
  assert.ok(data !== undefined, 'getOTPData should return stored data');
  assert.equal(data!.stage, 'totp', 'stage should be totp');
  assert.equal(data!.attempts, 0, 'attempts should start at 0');
  svc.destroy();
}

function testTOTPInvalidate(): void {
  const stubCrypto = {} as import('./services/CryptoService.js').CryptoService;
  const svc = new TOTPService({ enabled: true }, stubCrypto);
  const { tempToken } = svc.createPendingAuth();
  svc.invalidatePendingAuth(tempToken);
  assert.equal(svc.getOTPData(tempToken), undefined, 'Data should be removed after invalidation');
  svc.destroy();
}

function testAuthLocalhostPasswordOnly(): void {
  const crypto = new CryptoService('test-key-32-bytes-padded-here!!');
  const service = new AuthService(
    { password: 'test', durationMs: 1800000, maxDurationMs: 86400000, jwtSecret: 'secret' },
    crypto
  );
  assert.equal(service.getLocalhostPasswordOnly(), false, 'Default should be false');
  service.destroy();
}

// ---------------------------------------------------------------------------
// initialize() tests — use a real CryptoService + tmp directory (FR-201~204)
// We temporarily override process.cwd() via the SECRET_FILE_PATH constant by
// monkey-patching the module's private constant indirectly through CryptoService.
// Since SECRET_FILE_PATH = path.join(process.cwd(), 'data', 'totp.secret'),
// we mock process.cwd() temporarily to redirect to a temp dir.
// ---------------------------------------------------------------------------

async function testTOTPInitializeGeneratesSecret(): Promise<void> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'totp-test-'));
  const secretFile = path.join(tmpDir, 'totp.secret');
  try {
    const crypto = new CryptoService('test-key-32-bytes-padded-here!!');
    const service = new TOTPService({ enabled: true, issuer: 'Test', accountName: 'test' }, crypto, secretFile);
    service.initialize();
    assert.ok(service.isRegistered(), 'Service should be registered after initialize()');
    const exists = await fs.access(secretFile).then(() => true).catch(() => false);
    assert.ok(exists, 'Secret file should be created on first start (FR-201)');
    service.destroy();
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

async function testTOTPInitializeLoadsSecret(): Promise<void> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'totp-test-'));
  const secretFile = path.join(tmpDir, 'totp.secret');
  try {
    const crypto = new CryptoService('test-key-32-bytes-padded-here!!');
    // First init: generates and saves secret
    const service1 = new TOTPService({ enabled: true }, crypto, secretFile);
    service1.initialize();
    service1.destroy();
    // Second init: loads existing secret from same file (FR-202)
    const service2 = new TOTPService({ enabled: true }, crypto, secretFile);
    service2.initialize();
    assert.ok(service2.isRegistered(), 'Service should load existing secret (FR-202)');
    service2.destroy();
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

async function testTOTPInitializeThrowsOnCorrupted(): Promise<void> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'totp-test-'));
  const secretFile = path.join(tmpDir, 'totp.secret');
  try {
    // Write an invalid (non-encrypted, non-BASE32) value directly
    await fs.writeFile(secretFile, 'CORRUPTED_NOT_VALID_ENCRYPTED_DATA', 'utf-8');
    const crypto = new CryptoService('test-key-32-bytes-padded-here!!');
    const service = new TOTPService({ enabled: true }, crypto, secretFile);
    assert.throws(
      () => service.initialize(),
      (err: unknown) => err instanceof Error,
      'Should throw on corrupted secret file (FR-204)'
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

// ============================================================================
// Phase 4: authRoutes — 4 COMBO flows
// Tests use a lightweight supertest-style helper via Express app
// ============================================================================

/** Build a minimal harness for authRoutes tests */
async function invokeLogin(
  accessors: Parameters<typeof createAuthRoutes>[0],
  body: Record<string, unknown>,
  ip = '192.168.1.1',
): Promise<{ status: number; body: Record<string, unknown> }> {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', createAuthRoutes(accessors));
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const port = (server.address() as net.AddressInfo).port;
      const postBody = JSON.stringify(body);
      const options = {
        hostname: '127.0.0.1', port, method: 'POST',
        path: '/api/auth/login',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postBody),
        },
      };
      const request = http.request(options, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          server.close();
          try {
            const json = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
            resolve({ status: res.statusCode ?? 0, body: json });
          } catch (e) {
            reject(e);
          }
        });
      });
      request.on('error', (e: Error) => { server.close(); reject(e); });
      request.write(postBody);
      request.end();
    });
  });
}

async function invokeVerify(
  accessors: Parameters<typeof createAuthRoutes>[0],
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const app = express();
    app.use(express.json());
    app.use('/api/auth', createAuthRoutes(accessors));
    const server = http.createServer(app);
    server.listen(0, () => {
      const port = (server.address() as net.AddressInfo).port;
      const postBody = JSON.stringify(body);
      const options = {
        hostname: '127.0.0.1', port, method: 'POST',
        path: '/api/auth/verify',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postBody),
        },
      };
      const request = http.request(options, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          server.close();
          try {
            const json = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
            resolve({ status: res.statusCode ?? 0, body: json });
          } catch (e) { reject(e); }
        });
      });
      request.on('error', (e: Error) => { server.close(); reject(e); });
      request.write(postBody);
      request.end();
    });
  });
}

function makeAuthHarness(opts: {
  withTotp?: boolean;
  totpRegistered?: boolean;
  localhostPasswordOnly?: boolean;
}) {
  const cryptoService = new CryptoService('phase4-test-key-32-bytes-padded!!');
  const authService = new AuthService(
    {
      password: 'test-password',
      durationMs: 1800000,
      maxDurationMs: 86400000,
      jwtSecret: 'test-jwt-secret',
      localhostPasswordOnly: opts.localhostPasswordOnly ?? false,
    },
    cryptoService,
  );

  let totpService: TOTPService | undefined;

  if (opts.withTotp) {
    totpService = new TOTPService({ enabled: true, issuer: 'Test', accountName: 'test' }, cryptoService);
    if (opts.totpRegistered) {
      const secret = generateSecret();
      (totpService as unknown as { secret: string; registered: boolean }).secret = secret;
      (totpService as unknown as { secret: string; registered: boolean }).registered = true;
    }
  }

  const accessors = {
    getAuthService: () => authService,
    getTOTPService: () => totpService,
  };

  return { authService, totpService, accessors, cryptoService };
}

async function testAuthRoutesCombo3Login(): Promise<void> {
  // TOTP login: registered TOTP returns 202 with nextStage totp
  const { accessors, authService } = makeAuthHarness({ withTotp: true, totpRegistered: true });
  const result = await invokeLogin(accessors, { password: 'test-password' });
  authService.destroy();
  assert.equal(result.status, 202, `Expected 202, got ${result.status}`);
  assert.equal(result.body.success, true, 'success should be true');
  assert.equal(result.body.requires2FA, true, 'requires2FA should be true');
  assert.equal(result.body.nextStage, 'totp', 'nextStage should be totp (COMBO-3)');
  assert.ok(typeof result.body.tempToken === 'string', 'tempToken should be present');
}

async function testAuthRoutesUnregisteredTOTP503(): Promise<void> {
  // FR-401: TOTP enabled but not registered → 503
  const { accessors, authService } = makeAuthHarness({ withTotp: true, totpRegistered: false });
  const result = await invokeLogin(accessors, { password: 'test-password' });
  authService.destroy();
  assert.equal(result.status, 503, `Expected 503, got ${result.status}`);
  assert.equal(result.body.success, false, 'success should be false');
}

async function testAuthRoutesStageMismatch(): Promise<void> {
  // stage validation: invalid UUID tempToken → 401
  const { accessors, authService } = makeAuthHarness({ withTotp: true, totpRegistered: true });
  // Send a non-existent tempToken → should get 401 INVALID_TEMP_TOKEN
  const result = await invokeVerify(accessors, { tempToken: '00000000-0000-0000-0000-000000000000', otpCode: '123456' });
  authService.destroy();
  assert.equal(result.status, 401, `Expected 401, got ${result.status}`);
}

async function testAuthRoutesCombo1(): Promise<void> {
  // 2FA disabled → direct JWT
  const cryptoService = new CryptoService('phase4-test-key-32-bytes-padded!!');
  const authService = new AuthService(
    { password: 'test-password', durationMs: 1800000, maxDurationMs: 86400000, jwtSecret: 'secret' },
    cryptoService,
  );
  const accessors = {
    getAuthService: () => authService,
    getTOTPService: () => undefined,
  };
  const result = await invokeLogin(accessors, { password: 'test-password' });
  authService.destroy();
  assert.equal(result.status, 200, `Expected 200, got ${result.status}`);
  assert.equal(result.body.success, true, 'success should be true');
  assert.ok(typeof result.body.token === 'string', 'token should be present for COMBO-1');
}

async function testAuthRoutesLocalhostBypass(): Promise<void> {
  // FR-602: localhostPasswordOnly — but note: req.ip in our test will be ::1 or 127.0.0.1
  // We configure localhostPasswordOnly=true, and the request comes from 127.0.0.1 (loopback)
  const { accessors, authService } = makeAuthHarness({
    withTotp: true, totpRegistered: true, localhostPasswordOnly: true
  });
  // Our HTTP helper connects to 127.0.0.1 which Express sees as ::1 or ::ffff:127.0.0.1
  const result = await invokeLogin(accessors, { password: 'test-password' });
  authService.destroy();
  // Localhost bypass → direct JWT (200), no 2FA challenge
  assert.equal(result.status, 200, `Expected 200 (localhost bypass), got ${result.status}`);
  assert.ok(typeof result.body.token === 'string', 'token should be present for localhost bypass');
}

async function testAuthRoutesTOTPVerifySuccess(): Promise<void> {
  // TOTP verify: valid TOTP code → JWT
  const { accessors, totpService, authService } = makeAuthHarness({
    withTotp: true, totpRegistered: true
  });
  const secret = (totpService as unknown as { secret: string }).secret;
  // Get tempToken via login first
  const loginResult = await invokeLogin(accessors, { password: 'test-password' });
  const tempToken = loginResult.body.tempToken as string;
  const validCode = generateSync({ secret });
  const result = await invokeVerify(accessors, { tempToken, otpCode: validCode });
  authService.destroy();
  assert.equal(result.status, 200, `Expected 200, got ${result.status}: ${JSON.stringify(result.body)}`);
  assert.ok(typeof result.body.token === 'string', 'token should be issued after TOTP success');
}

async function testAuthRoutesTOTPMaxAttempts(): Promise<void> {
  // NFR-104: 3 failed TOTP attempts → 401 with attemptsRemaining 0
  const { accessors, authService } = makeAuthHarness({
    withTotp: true, totpRegistered: true
  });
  // Get tempToken via login first
  const loginResult = await invokeLogin(accessors, { password: 'test-password' });
  const tempToken = loginResult.body.tempToken as string;
  // 3 wrong attempts
  let lastResult = { status: 0, body: {} as Record<string, unknown> };
  for (let i = 0; i < 3; i++) {
    lastResult = await invokeVerify(accessors, { tempToken, otpCode: '000000' });
  }
  authService.destroy();
  assert.equal(lastResult.status, 401, `Expected 401 after 3 attempts, got ${lastResult.status}`);
  assert.equal(lastResult.body.attemptsRemaining, 0, 'attemptsRemaining should be 0');
}

void main();
