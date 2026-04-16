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
import { OscDetector } from './services/OscDetector.js';
import { WorkspaceService } from './services/WorkspaceService.js';
import {
  createHeadlessTerminalState,
  disposeHeadlessTerminal,
  resizeHeadlessTerminal,
  serializeHeadlessTerminal,
  writeHeadlessTerminal,
} from './utils/headlessTerminal.js';
import { truncateTerminalPayloadTail } from './utils/terminalPayload.js';
import { WsRouter } from './ws/WsRouter.js';
import { AppError, ErrorCode } from './utils/errors.js';
import { createAuthRoutes } from './routes/authRoutes.js';
import { ensureDebugCaptureSessionExists, requireLocalDebugCapture } from './middleware/debugCaptureGuards.js';
import express from 'express';

async function main(): Promise<void> {
  const tests: Array<{ name: string; run: () => Promise<void> | void }> = [
    { name: 'RuntimeConfigStore builds a redacted editable snapshot', run: testRuntimeConfigSnapshot },
    { name: 'RuntimeConfigStore marks platform capabilities and merges patches', run: testRuntimeConfigCapabilities },
    { name: 'SessionManager resolves PowerShell backend override without changing non-PowerShell behavior', run: testSessionManagerPowerShellBackendResolution },
    { name: 'SessionManager rejects explicit winpty runtime config when probe fails', run: testSessionManagerWinptyProbeFailure },
    { name: 'SessionManager retries winpty probe after a previous failure', run: testSessionManagerWinptyProbeRetry },
    { name: 'SessionManager.createSession uses resolved backend for PowerShell sessions', run: testSessionManagerCreateSessionUsesResolvedBackend },
    { name: 'SessionManager snapshot metadata stays truthful across backend combinations', run: testSessionManagerSnapshotMetadataTruthfulness },
    { name: 'SessionManager non-Windows runtime validation matches the settings contract', run: testSessionManagerNonWindowsRuntimeValidation },
    { name: 'SettingsService hides winpty option after capability probe failure', run: testSettingsServiceWinptyCapabilitySurface },
    { name: 'AuthService.updateRuntimeConfig updates password validation and token duration', run: testAuthRuntimeConfig },
    { name: 'SettingsService rejects unsupported settings keys', run: testSettingsUnsupportedSetting },
    { name: 'SettingsService persists editable values and applies runtime updates', run: testSettingsServicePersistence },
    { name: 'SettingsService persists editable values against a legacy pty.maxBufferSize config', run: testSettingsServiceLegacyPtyMigration },
    { name: 'SettingsService blocks password rotation without current password', run: testSettingsPasswordValidation },
    { name: 'SettingsService rotates password for later logins and persists encrypted secret', run: testSettingsPasswordRotation },
    { name: 'SettingsService rolls back runtime state when apply fails', run: testSettingsApplyFailureRollback },
    { name: 'SessionManager.updateRuntimeConfig affects later idle timers and cached snapshots', run: testSessionManagerRuntimeConfig },
    { name: 'SessionManager no-op resize skips PTY resize and replay refresh', run: testSessionManagerNoopResizeSkipsRefresh },
    { name: 'SessionManager resize replay refresh fires after sustained pending output settles', run: testSessionManagerResizeReplayRefreshDeadline },
    { name: 'SessionManager resize replay refresh waits for quiet window before settling headless writes', run: testSessionManagerResizeReplayRefreshQuietWindow },
    { name: 'SessionManager resize replay refresh waits for headless drain after noisy redraw deadline', run: testSessionManagerResizeReplayRefreshAfterNoisyDeadline },
    { name: 'SessionManager resize replay refresh clamps near-deadline rearm to the remaining deadline window', run: testSessionManagerResizeReplayRefreshNearDeadlineRearm },
    { name: 'SessionManager resize replay refresh shortens post-deadline rearm to drain cadence', run: testSessionManagerResizeReplayRefreshAfterDeadlineRearm },
    { name: 'SessionManager returns cached authoritative snapshots', run: testSessionManagerCachedSnapshot },
    { name: 'SessionManager reports snapshot observability counters', run: testSessionManagerObservabilityCounters },
    { name: 'SessionManager powershell shell bootstrap avoids delayed prompt-hook injection', run: testSessionManagerPowerShellBootstrapArgs },
    { name: 'SessionManager input debug capture records safe metadata without leaking printable input', run: testSessionManagerInputDebugCaptureMetadata },
    { name: 'debug capture localhost guard rejects non-loopback requests', run: testDebugCaptureLocalhostGuard },
    { name: 'debug capture missing-session guard returns 404', run: testDebugCaptureSessionExistsGuard },
    { name: 'SessionManager marks sessions degraded when snapshot serialization fails', run: testSessionManagerDegradedSnapshot },
    { name: 'SessionManager preserves unsnapshotted healthy output when degrading', run: testSessionManagerDirtyCacheDegradedRecovery },
    { name: 'SessionManager preserves queued output when degradation happens before headless writes flush', run: testSessionManagerQueuedOutputDegradedRace },
    { name: 'SessionManager does not duplicate flushed output when later queued output is still pending at degradation time', run: testSessionManagerMixedFlushDegradedRecovery },
    { name: 'SessionManager does not duplicate queued output on direct write failure', run: testSessionManagerWriteFailureNoDuplicate },
    { name: 'SessionManager rejects oversized authoritative snapshots without unbounded growth', run: testSessionManagerOversizedSnapshot },
    { name: 'SessionManager authoritative snapshot preserves current alt-screen state', run: testSessionManagerAltScreenSnapshot },
    { name: 'SessionManager preserves degraded output across unsubscribed gaps', run: testSessionManagerDegradedOutputRecovery },
    { name: 'Headless snapshot serialization is deterministic for a normal screen', run: testHeadlessSnapshotSerialization },
    { name: 'Headless snapshot serialization reflects resize geometry', run: testHeadlessSnapshotResize },
    { name: 'Headless snapshot serialization preserves alternate-screen state and exit restore', run: testHeadlessSnapshotAltScreen },
    { name: 'Headless snapshot serialization handles an empty screen', run: testHeadlessSnapshotEmptyScreen },
    { name: 'Headless snapshot serialization refuses truncated authoritative payloads', run: testHeadlessSnapshotTruncation },
    { name: 'Terminal payload truncation skips partial CSI sequences', run: testTerminalPayloadTruncationCsi },
    { name: 'Terminal payload truncation skips partial OSC sequences', run: testTerminalPayloadTruncationOsc },
    { name: 'Terminal payload truncation drops incomplete trailing CSI sequences', run: testTerminalPayloadTruncationIncompleteCsi },
    { name: 'Terminal payload truncation drops incomplete trailing OSC sequences', run: testTerminalPayloadTruncationIncompleteOsc },
    { name: 'Terminal payload truncation removes incomplete trailing escape suffixes', run: testTerminalPayloadTruncationTrailingIncompleteSuffix },
    { name: 'WsRouter sends screen snapshot before flushing queued live output', run: testWsRouterScreenSnapshotOrdering },
    { name: 'WsRouter blocks input while replay is pending and releases on ACK', run: testWsRouterBlocksInputWhileReplayPending },
    { name: 'WsRouter reports replay observability counters', run: testWsRouterObservabilityCounters },
    { name: 'WsRouter still emits a replay start for degraded sessions', run: testWsRouterDegradedReplayStart },
    { name: 'WsRouter still emits a replay start for oversized snapshots', run: testWsRouterOversizedSnapshotReplayStart },
    { name: 'WsRouter duplicate subscribe does not replay screen snapshot twice', run: testWsRouterDuplicateSubscribeIdempotent },
    { name: 'WsRouter ignores stale replay tokens', run: testWsRouterIgnoresStaleReplayTokens },
    { name: 'WsRouter refreshes replay snapshots on resize while pending', run: testWsRouterRefreshesReplaySnapshotsOnResize },
    { name: 'WsRouter does not duplicate deferred degraded payload after fallback snapshot ack', run: testWsRouterNoDuplicateDeferredFallbackPayload },
    { name: 'WsRouter clears replay state when a session is removed', run: testWsRouterClearSessionState },
    { name: 'WorkspaceService restartTab invalidates old session lineage and preserves lastCwd', run: testWorkspaceServiceRestartTab },
    { name: 'WorkspaceService restartTab preserves the old session when replacement creation fails', run: testWorkspaceServiceRestartTabCreateFailure },
    { name: 'WorkspaceService deleteWorkspace clears workspace sessions in bulk', run: testWorkspaceServiceDeleteWorkspace },
    { name: 'WorkspaceService orphan recovery recreates fresh session ids with saved cwd', run: testWorkspaceServiceCheckOrphanTabs },
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
    { name: 'authRoutes twoFactor.externalOnly: localhost bypass skips TOTP (bugfix)', run: testAuthRoutesExternalOnlyBypass },
    { name: 'authRoutes twoFactor.externalOnly=false: external-only disabled still requires TOTP', run: testAuthRoutesExternalOnlyDisabled },
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
  assert.equal(capabilities['pty.windowsPowerShellBackend'].available, false);
  assert.equal(capabilities['pty.windowsPowerShellBackend'].reason, 'Windows-only PowerShell backend override');
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
      scrollbackLines: 1000,
      maxSnapshotBytes: 16,
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

  const sessionData: any = {
    session: fakeSession,
    pty: {} as never,
    idleTimer: null as NodeJS.Timeout | null,
    headless: null,
    headlessHealth: 'degraded',
    headlessWriteChain: Promise.resolve(),
    headlessCloseSignal: createTestDeferredSignal<void>(),
    pendingHeadlessWrites: 0,
    cols: 80,
    rows: 24,
    screenSeq: 1,
    snapshotCache: {
      seq: 1,
      cols: 80,
      rows: 24,
      data: 'cached',
      truncated: false,
      generatedAt: Date.now(),
      dirty: false,
    },
    degradedReplayBuffer: '',
    degradedReplayTruncated: false,
    pendingOutputChunks: [],
    unsnapshottedOutput: '',
    unsnapshottedOutputTruncated: false,
    initialCwd: process.cwd(),
  };

  (manager as any).sessions.set(fakeSession.id, sessionData);

  try {
    manager.updateRuntimeConfig({
      idleDelayMs: 20,
      pty: {
        defaultCols: 120,
        maxSnapshotBytes: 4,
        shell: 'bash',
      },
    });

    assert.equal((manager as any).runtimePtyConfig.defaultCols, 120);
    assert.equal((manager as any).runtimePtyConfig.shell, 'bash');
    assert.equal((manager as any).runtimeSessionConfig.idleDelayMs, 20);
    assert.equal(sessionData.snapshotCache, null);

    (manager as any).scheduleIdleTransition(fakeSession.id);
    await delay(40);

    assert.equal(fakeSession.status, 'idle');
  } finally {
    if (sessionData.idleTimer) {
      clearTimeout(sessionData.idleTimer);
    }
  }
}

function testSessionManagerPowerShellBackendResolution(): void {
  const manager = new SessionManager({
    pty: {
      termName: 'xterm-256color',
      defaultCols: 80,
      defaultRows: 24,
      useConpty: true,
      windowsPowerShellBackend: 'inherit',
      scrollbackLines: 1000,
      maxSnapshotBytes: 16,
      shell: 'auto',
    },
    session: {
      idleDelayMs: 200,
    },
  }, {
    execFileSyncFn: (() => Buffer.from('')) as any,
    platform: 'win32',
  });

  const inheritPowerShell = (manager as any).resolveWindowsPtyBackend('powershell');
  assert.equal(inheritPowerShell.backend, 'conpty');
  assert.equal(inheritPowerShell.useConpty, true);
  assert.equal(inheritPowerShell.requestedPowerShellBackend, 'inherit');

  manager.updateRuntimeConfig({
    pty: {
      windowsPowerShellBackend: 'conpty',
    },
  });

  const forcedConpty = (manager as any).resolveWindowsPtyBackend('powershell');
  assert.equal(forcedConpty.backend, 'conpty');
  assert.equal(forcedConpty.useConpty, true);
  assert.equal(forcedConpty.requestedPowerShellBackend, 'conpty');

  manager.updateRuntimeConfig({
    pty: {
      useConpty: false,
      windowsPowerShellBackend: 'inherit',
    },
  });

  const inheritWinpty = (manager as any).resolveWindowsPtyBackend('powershell');
  assert.equal(inheritWinpty.backend, 'winpty');
  assert.equal(inheritWinpty.useConpty, false);
  assert.equal(inheritWinpty.requestedPowerShellBackend, 'inherit');

  const nonPowerShell = (manager as any).resolveWindowsPtyBackend('cmd');
  assert.equal(nonPowerShell.backend, 'winpty');
  assert.equal(nonPowerShell.useConpty, false);
}

function testSessionManagerWinptyProbeFailure(): void {
  const manager = new SessionManager({
    pty: {
      termName: 'xterm-256color',
      defaultCols: 80,
      defaultRows: 24,
      useConpty: true,
      windowsPowerShellBackend: 'inherit',
      scrollbackLines: 1000,
      maxSnapshotBytes: 16,
      shell: 'auto',
    },
    session: {
      idleDelayMs: 200,
    },
  }, {
    execFileSyncFn: (() => {
      throw new Error('simulated winpty probe failure');
    }) as any,
    platform: 'win32',
  });

  assert.throws(
    () => manager.updateRuntimeConfig({ pty: { windowsPowerShellBackend: 'winpty' } }),
    (error: unknown) => error instanceof AppError && error.code === ErrorCode.CONFIG_ERROR,
  );

  assert.throws(
    () => manager.updateRuntimeConfig({ pty: { useConpty: false, windowsPowerShellBackend: 'inherit' } }),
    (error: unknown) => error instanceof AppError && error.code === ErrorCode.CONFIG_ERROR,
  );

  assert.throws(
    () => manager.updateRuntimeConfig({ pty: { useConpty: false, windowsPowerShellBackend: 'conpty' } }),
    (error: unknown) => error instanceof AppError && error.code === ErrorCode.CONFIG_ERROR,
  );
}

function testSessionManagerWinptyProbeRetry(): void {
  let attempts = 0;
  const manager = new SessionManager({
    pty: {
      termName: 'xterm-256color',
      defaultCols: 80,
      defaultRows: 24,
      useConpty: true,
      windowsPowerShellBackend: 'inherit',
      scrollbackLines: 1000,
      maxSnapshotBytes: 16,
      shell: 'auto',
    },
    session: {
      idleDelayMs: 200,
    },
  }, {
    execFileSyncFn: (() => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error('transient winpty probe failure');
      }
      return Buffer.from('');
    }) as any,
    platform: 'win32',
  });

  assert.throws(
    () => manager.updateRuntimeConfig({ pty: { windowsPowerShellBackend: 'winpty' } }),
    (error: unknown) => error instanceof AppError && error.code === ErrorCode.CONFIG_ERROR,
  );

  manager.updateRuntimeConfig({ pty: { windowsPowerShellBackend: 'winpty' } });
  assert.equal(attempts, 2);
}

function testSessionManagerCreateSessionUsesResolvedBackend(): void {
  let observedUseConpty: boolean | undefined;
  let killCalled = false;
  const manager = new SessionManager({
    pty: {
      termName: 'xterm-256color',
      defaultCols: 80,
      defaultRows: 24,
      useConpty: true,
      windowsPowerShellBackend: 'winpty',
      scrollbackLines: 1000,
      maxSnapshotBytes: 1024,
      shell: 'powershell',
    },
    session: {
      idleDelayMs: 200,
    },
  }, {
    execFileSyncFn: (() => Buffer.from('')) as any,
    platform: 'win32',
    spawnPty: ((_: string, __: string[], options: { useConpty?: boolean; cols?: number; rows?: number }) => {
      observedUseConpty = options.useConpty;
      return {
        pid: 1,
        cols: options.cols ?? 80,
        rows: options.rows ?? 24,
        process: 'powershell.exe',
        handleFlowControl: false,
        onData() { return { dispose() {} }; },
        onExit() { return { dispose() {} }; },
        write() {},
        resize() {},
        kill() { killCalled = true; },
      } as any;
    }) as any,
  });

  const session = manager.createSession('PowerShell Test', 'powershell', os.tmpdir());
  assert.equal(typeof session.id, 'string');
  assert.equal(observedUseConpty, false);
  assert.equal(manager.getScreenSnapshot(session.id)?.windowsPty?.backend, 'winpty');
  assert.equal(manager.deleteSession(session.id), true);
  assert.equal(killCalled, true);
}

async function testSettingsServiceWinptyCapabilitySurface(): Promise<void> {
  const fixture = createConfigFixture();
  const cryptoService = new CryptoService('settings-winpty-capability');
  const authService = new AuthService(fixture.auth!, cryptoService);
  const sessionManager = new SessionManager({ pty: fixture.pty, session: fixture.session }, {
    execFileFn: ((_file: string, _args: readonly string[] | undefined, _options: any, callback: any) => {
      callback(new Error('simulated winpty probe failure'), '', '');
      return {} as any;
    }) as any,
    execFileSyncFn: (() => {
      throw new Error('simulated winpty probe failure');
    }) as any,
    platform: 'win32',
  });
  const settingsService = new SettingsService({
    runtimeConfigStore: new RuntimeConfigStore(fixture, 'win32'),
    configRepository: new ConfigFileRepository(path.join(os.tmpdir(), 'unused-config.json5')),
    cryptoService,
    authService,
    getFileService: () => new FileService({
      getSession: () => ({ id: 'session-1' }),
      getPtyPid: () => null,
      getInitialCwd: () => os.tmpdir(),
      getCwdFilePath: () => null,
    }, fixture.fileManager!),
    sessionManager,
  }, 'win32');

  try {
    await sessionManager.warmPowerShellWinptyCapability();
    const snapshot = settingsService.getSettingsSnapshot();
    assert.equal(snapshot.capabilities['pty.useConpty'].available, false);
    assert.deepEqual(snapshot.capabilities['pty.windowsPowerShellBackend'].options, ['inherit', 'conpty']);
    assert.match(snapshot.capabilities['pty.windowsPowerShellBackend'].reason ?? '', /winpty/i);
  } finally {
    authService.destroy();
  }
}

function testSessionManagerSnapshotMetadataTruthfulness(): void {
  const observedBackends: string[] = [];
  const createManager = (ptyConfig: Config['pty']) => new SessionManager({
    pty: ptyConfig,
    session: {
      idleDelayMs: 200,
    },
  }, {
    execFileSyncFn: (() => Buffer.from('')) as any,
    platform: 'win32',
    spawnPty: ((_: string, __: string[], options: { useConpty?: boolean; cols?: number; rows?: number }) => {
      observedBackends.push(options.useConpty ? 'conpty' : 'winpty');
      return {
        pid: 1,
        cols: options.cols ?? 80,
        rows: options.rows ?? 24,
        process: 'powershell.exe',
        handleFlowControl: false,
        onData() { return { dispose() {} }; },
        onExit() { return { dispose() {} }; },
        write() {},
        resize() {},
        kill() {},
      } as any;
    }) as any,
  });

  const cases: Array<{
    name: string;
    manager: SessionManager;
    shell: 'powershell' | 'cmd';
    expectedBackend: 'conpty' | 'winpty';
  }> = [
    {
      name: 'powershell-winpty',
      manager: createManager({
        termName: 'xterm-256color',
        defaultCols: 80,
        defaultRows: 24,
        useConpty: true,
        windowsPowerShellBackend: 'winpty',
        scrollbackLines: 1000,
        maxSnapshotBytes: 1024,
        shell: 'auto',
      }),
      shell: 'powershell',
      expectedBackend: 'winpty',
    },
    {
      name: 'powershell-conpty',
      manager: createManager({
        termName: 'xterm-256color',
        defaultCols: 80,
        defaultRows: 24,
        useConpty: false,
        windowsPowerShellBackend: 'conpty',
        scrollbackLines: 1000,
        maxSnapshotBytes: 1024,
        shell: 'auto',
      }),
      shell: 'powershell',
      expectedBackend: 'conpty',
    },
    {
      name: 'powershell-inherit-conpty',
      manager: createManager({
        termName: 'xterm-256color',
        defaultCols: 80,
        defaultRows: 24,
        useConpty: true,
        windowsPowerShellBackend: 'inherit',
        scrollbackLines: 1000,
        maxSnapshotBytes: 1024,
        shell: 'auto',
      }),
      shell: 'powershell',
      expectedBackend: 'conpty',
    },
    {
      name: 'powershell-inherit-winpty',
      manager: createManager({
        termName: 'xterm-256color',
        defaultCols: 80,
        defaultRows: 24,
        useConpty: false,
        windowsPowerShellBackend: 'inherit',
        scrollbackLines: 1000,
        maxSnapshotBytes: 1024,
        shell: 'auto',
      }),
      shell: 'powershell',
      expectedBackend: 'winpty',
    },
    {
      name: 'cmd-conpty',
      manager: createManager({
        termName: 'xterm-256color',
        defaultCols: 80,
        defaultRows: 24,
        useConpty: true,
        windowsPowerShellBackend: 'winpty',
        scrollbackLines: 1000,
        maxSnapshotBytes: 1024,
        shell: 'auto',
      }),
      shell: 'cmd',
      expectedBackend: 'conpty',
    },
  ];

  for (const testCase of cases) {
    const session = testCase.manager.createSession(testCase.name, testCase.shell, os.tmpdir());
    assert.equal(testCase.manager.getScreenSnapshot(session.id)?.windowsPty?.backend, testCase.expectedBackend);
    testCase.manager.deleteSession(session.id);
  }

  assert.deepEqual(observedBackends, ['winpty', 'conpty', 'conpty', 'winpty', 'conpty']);
}

function testSessionManagerNonWindowsRuntimeValidation(): void {
  const linuxManager = new SessionManager({
    pty: {
      termName: 'xterm-256color',
      defaultCols: 80,
      defaultRows: 24,
      useConpty: false,
      windowsPowerShellBackend: 'inherit',
      scrollbackLines: 1000,
      maxSnapshotBytes: 1024,
      shell: 'auto',
    },
    session: {
      idleDelayMs: 200,
    },
  }, {
    platform: 'linux',
    execFileSyncFn: (() => Buffer.from('')) as any,
  });

  linuxManager.assertRuntimePtyCapabilities();

  assert.throws(
    () => linuxManager.updateRuntimeConfig({ pty: { useConpty: true } }),
    (error: unknown) => error instanceof AppError && error.code === ErrorCode.CONFIG_ERROR,
  );

  assert.throws(
    () => linuxManager.updateRuntimeConfig({ pty: { windowsPowerShellBackend: 'conpty' } }),
    (error: unknown) => error instanceof AppError && error.code === ErrorCode.CONFIG_ERROR,
  );
}

function testSessionManagerNoopResizeSkipsRefresh(): void {
  const manager = new SessionManager({
    pty: {
      termName: 'xterm-256color',
      defaultCols: 80,
      defaultRows: 24,
      useConpty: true,
      scrollbackLines: 1000,
      maxSnapshotBytes: 1024,
      shell: 'auto',
    },
    session: {
      idleDelayMs: 200,
    },
  });

  const fakeSession: Session = {
    id: 'session-noop-resize',
    name: 'Session noop resize',
    status: 'running',
    createdAt: new Date(),
    lastActiveAt: new Date(),
    sortOrder: 0,
  };

  let ptyResizeCount = 0;
  let refreshReplaySnapshotsCount = 0;
  const replayEvents: Array<{ kind: string }> = [];

  const sessionData: any = {
    session: fakeSession,
    pty: {
      resize: () => {
        ptyResizeCount += 1;
      },
    },
    idleTimer: null as NodeJS.Timeout | null,
    headless: null,
    headlessHealth: 'degraded',
    headlessWriteChain: Promise.resolve(),
    headlessCloseSignal: createTestDeferredSignal<void>(),
    pendingHeadlessWrites: 0,
    cols: 80,
    rows: 24,
    screenSeq: 7,
    snapshotCache: {
      seq: 7,
      cols: 80,
      rows: 24,
      data: 'cached',
      truncated: false,
      generatedAt: Date.now(),
      dirty: false,
    },
    degradedReplayBuffer: '',
    degradedReplayTruncated: false,
    pendingOutputChunks: [],
    unsnapshottedOutput: '',
    unsnapshottedOutputTruncated: false,
    initialCwd: process.cwd(),
  };

  (manager as any).sessions.set(fakeSession.id, sessionData);
  (manager as any).wsRouter = {
    recordReplayEvent: (event: { kind: string }) => {
      replayEvents.push(event);
    },
    refreshReplaySnapshots: () => {
      refreshReplaySnapshotsCount += 1;
    },
  };

  const result = manager.resize(fakeSession.id, 80, 24);

  assert.equal(result, true);
  assert.equal(ptyResizeCount, 0);
  assert.equal(refreshReplaySnapshotsCount, 0);
  assert.equal(sessionData.screenSeq, 7);
  assert.equal(sessionData.snapshotCache.dirty, false);
  assert.deepEqual(replayEvents.map((event) => event.kind), ['resize_requested', 'resize_skipped']);
}

async function testSessionManagerResizeReplayRefreshDeadline(): Promise<void> {
  const manager = new SessionManager({
    pty: {
      termName: 'xterm-256color',
      defaultCols: 80,
      defaultRows: 24,
      useConpty: true,
      scrollbackLines: 1000,
      maxSnapshotBytes: 1024,
      shell: 'auto',
    },
    session: {
      idleDelayMs: 200,
    },
  });

  let refreshReplaySnapshotsCount = 0;
  const harness = createManagedSessionHarness(manager, { cols: 80, rows: 24, scrollbackLines: 1000 });
  harness.sessionData.pendingHeadlessWrites = 1;
  (manager as any).wsRouter = {
    recordReplayEvent: () => undefined,
    refreshReplaySnapshots: () => {
      refreshReplaySnapshotsCount += 1;
    },
  };

  try {
    manager.resize(harness.sessionId, 120, 40);

    await delay(200);
    assert.equal(refreshReplaySnapshotsCount, 0);

    harness.sessionData.pendingHeadlessWrites = 0;
    await delay(300);
    assert.equal(refreshReplaySnapshotsCount, 1);
    assert.equal((manager as any).pendingResizeReplaySessions.has(harness.sessionId), false);
    assert.equal((manager as any).pendingResizeReplayStartedAt.has(harness.sessionId), false);
  } finally {
    harness.dispose();
  }
}

async function testSessionManagerResizeReplayRefreshQuietWindow(): Promise<void> {
  const manager = new SessionManager({
    pty: {
      termName: 'xterm-256color',
      defaultCols: 80,
      defaultRows: 24,
      useConpty: true,
      scrollbackLines: 1000,
      maxSnapshotBytes: 1024,
      shell: 'auto',
    },
    session: {
      idleDelayMs: 200,
    },
  });

  let refreshReplaySnapshotsCount = 0;
  const harness = createManagedSessionHarness(manager, { cols: 80, rows: 24, scrollbackLines: 1000 });
  harness.sessionData.pendingHeadlessWrites = 1;
  (manager as any).wsRouter = {
    recordReplayEvent: () => undefined,
    refreshReplaySnapshots: () => {
      refreshReplaySnapshotsCount += 1;
    },
  };

  try {
    manager.resize(harness.sessionId, 120, 40);
    (manager as any).pendingResizeReplayLastOutputAt.set(harness.sessionId, Date.now());

    await delay(200);
    assert.equal(refreshReplaySnapshotsCount, 0);

    harness.sessionData.pendingHeadlessWrites = 0;
    await delay(300);
    assert.equal(refreshReplaySnapshotsCount, 1);
  } finally {
    harness.dispose();
  }
}

async function testSessionManagerResizeReplayRefreshAfterNoisyDeadline(): Promise<void> {
  const manager = new SessionManager({
    pty: {
      termName: 'xterm-256color',
      defaultCols: 80,
      defaultRows: 24,
      useConpty: true,
      scrollbackLines: 1000,
      maxSnapshotBytes: 1024,
      shell: 'auto',
    },
    session: {
      idleDelayMs: 200,
    },
  });

  let refreshReplaySnapshotsCount = 0;
  const harness = createManagedSessionHarness(manager, { cols: 80, rows: 24, scrollbackLines: 1000 });
  harness.sessionData.pendingHeadlessWrites = 1;
  (manager as any).wsRouter = {
    recordReplayEvent: () => undefined,
    refreshReplaySnapshots: () => {
      refreshReplaySnapshotsCount += 1;
    },
  };

  try {
    manager.resize(harness.sessionId, 120, 40);
    (manager as any).pendingResizeReplayStartedAt.set(harness.sessionId, Date.now() - 450);
    (manager as any).pendingResizeReplayLastOutputAt.set(harness.sessionId, Date.now());

    await delay(150);
    assert.equal(refreshReplaySnapshotsCount, 0);

    harness.sessionData.pendingHeadlessWrites = 0;
    await delay(120);
    assert.equal(refreshReplaySnapshotsCount, 1);
    assert.equal((manager as any).pendingResizeReplaySessions.has(harness.sessionId), false);
    assert.equal((manager as any).pendingResizeReplayStartedAt.has(harness.sessionId), false);
    assert.equal((manager as any).pendingResizeReplayLastOutputAt.has(harness.sessionId), false);
  } finally {
    harness.dispose();
  }
}

async function testSessionManagerResizeReplayRefreshNearDeadlineRearm(): Promise<void> {
  const manager = new SessionManager({
    pty: {
      termName: 'xterm-256color',
      defaultCols: 80,
      defaultRows: 24,
      useConpty: true,
      scrollbackLines: 1000,
      maxSnapshotBytes: 1024,
      shell: 'auto',
    },
    session: {
      idleDelayMs: 200,
    },
  });

  let refreshReplaySnapshotsCount = 0;
  const harness = createManagedSessionHarness(manager, { cols: 80, rows: 24, scrollbackLines: 1000 });
  (manager as any).wsRouter = {
    recordReplayEvent: () => undefined,
    routeSessionOutput: () => undefined,
    refreshReplaySnapshots: () => {
      refreshReplaySnapshotsCount += 1;
    },
  };

  try {
    manager.resize(harness.sessionId, 120, 40);
    (manager as any).pendingResizeReplayStartedAt.set(harness.sessionId, Date.now() - 390);
    (manager as any).scheduleResizeReplayRefresh(harness.sessionId, 120);
    await delay(80);

    assert.equal(refreshReplaySnapshotsCount, 1);
    assert.equal((manager as any).pendingResizeReplaySessions.has(harness.sessionId), false);
  } finally {
    harness.dispose();
  }
}

async function testSessionManagerResizeReplayRefreshAfterDeadlineRearm(): Promise<void> {
  const manager = new SessionManager({
    pty: {
      termName: 'xterm-256color',
      defaultCols: 80,
      defaultRows: 24,
      useConpty: true,
      scrollbackLines: 1000,
      maxSnapshotBytes: 1024,
      shell: 'auto',
    },
    session: {
      idleDelayMs: 200,
    },
  });

  let refreshReplaySnapshotsCount = 0;
  const harness = createManagedSessionHarness(manager, { cols: 80, rows: 24, scrollbackLines: 1000 });
  (manager as any).wsRouter = {
    recordReplayEvent: () => undefined,
    refreshReplaySnapshots: () => {
      refreshReplaySnapshotsCount += 1;
    },
  };

  try {
    manager.resize(harness.sessionId, 120, 40);
    (manager as any).pendingResizeReplayStartedAt.set(harness.sessionId, Date.now() - 450);
    (manager as any).pendingResizeReplayLastOutputAt.set(harness.sessionId, Date.now());
    (manager as any).scheduleResizeReplayRefresh(harness.sessionId, 120);

    await delay(80);

    assert.equal(refreshReplaySnapshotsCount, 1);
    assert.equal((manager as any).pendingResizeReplaySessions.has(harness.sessionId), false);
  } finally {
    harness.dispose();
  }
}

async function testSessionManagerCachedSnapshot(): Promise<void> {
  const manager = new SessionManager({
    pty: {
      termName: 'xterm-256color',
      defaultCols: 10,
      defaultRows: 4,
      useConpty: false,
      scrollbackLines: 1000,
      maxSnapshotBytes: 1024,
      shell: 'auto',
    },
    session: {
      idleDelayMs: 200,
    },
  });

  const harness = createManagedSessionHarness(manager, { cols: 10, rows: 4, scrollbackLines: 1000 });

  try {
    await (manager as any).applyHeadlessOutput(harness.sessionId, harness.sessionData, 'hello\r\nworld');

    const serializeAddon = harness.sessionData.headless!.serializeAddon;
    const originalSerialize = serializeAddon.serialize.bind(serializeAddon);
    let serializeCalls = 0;
    serializeAddon.serialize = ((options?: unknown) => {
      serializeCalls += 1;
      return originalSerialize(options as never);
    }) as typeof serializeAddon.serialize;

    const first = manager.getScreenSnapshot(harness.sessionId);
    const second = manager.getScreenSnapshot(harness.sessionId);
    const replay = manager.getReplaySnapshot(harness.sessionId);

    assert.equal(first?.health, 'healthy');
    assert.equal(first?.data, 'hello\r\nworld');
    assert.equal(second?.generatedAt, first?.generatedAt);
    assert.equal(serializeCalls, 1);
    assert.deepEqual(replay, { data: 'hello\r\nworld', truncated: false });
  } finally {
    harness.dispose();
  }
}

async function testSessionManagerObservabilityCounters(): Promise<void> {
  const manager = new SessionManager({
    pty: {
      termName: 'xterm-256color',
      defaultCols: 10,
      defaultRows: 4,
      useConpty: false,
      scrollbackLines: 1000,
      maxSnapshotBytes: 1024,
      shell: 'auto',
    },
    session: {
      idleDelayMs: 200,
    },
  });

  const harness = createManagedSessionHarness(manager, { cols: 10, rows: 4, scrollbackLines: 1000 });

  try {
    await (manager as any).applyHeadlessOutput(harness.sessionId, harness.sessionData, 'hello');
    manager.getScreenSnapshot(harness.sessionId);
    manager.getScreenSnapshot(harness.sessionId);

    const stats = manager.getObservabilitySnapshot();

    assert.equal(stats.totalSessions, 1);
    assert.equal(stats.healthySessions, 1);
    assert.equal(stats.snapshotRequests, 2);
    assert.equal(stats.snapshotCacheHits, 1);
    assert.equal(stats.snapshotSerializeFailures, 0);
    assert.equal(stats.totalSnapshotBytes > 0, true);
  } finally {
    harness.dispose();
  }
}

function testSessionManagerPowerShellBootstrapArgs(): void {
  const manager = new SessionManager({
    pty: {
      termName: 'xterm-256color',
      defaultCols: 80,
      defaultRows: 24,
      useConpty: true,
      scrollbackLines: 1000,
      maxSnapshotBytes: 1024,
      shell: 'powershell',
    },
    session: {
      idleDelayMs: 200,
    },
  });

  const resolved = (manager as any).resolveShell('powershell', 'C:\\temp\\buildergate-cwd.txt');

  assert.equal(resolved.shell, 'powershell.exe');
  assert.equal(resolved.shellType, 'powershell');
  assert.ok(resolved.args.includes('-NoExit'));
  assert.ok(resolved.args.includes('-NoProfile'));
  assert.ok(resolved.args.includes('-EncodedCommand'));

  const encodedCommandIndex = resolved.args.indexOf('-EncodedCommand');
  assert.ok(encodedCommandIndex >= 0);
  const encodedCommand = resolved.args[encodedCommandIndex + 1];
  const decodedCommand = Buffer.from(encodedCommand, 'base64').toString('utf16le');

  assert.match(decodedCommand, /buildergate-cwd\.txt/i);
  assert.match(decodedCommand, /WriteAllText/);
  assert.match(decodedCommand, /try\s*\{/);
  assert.doesNotMatch(decodedCommand, /Out-File/);
}

function testSessionManagerInputDebugCaptureMetadata(): void {
  const manager = new SessionManager({
    pty: {
      termName: 'xterm-256color',
      defaultCols: 80,
      defaultRows: 24,
      useConpty: false,
      scrollbackLines: 1000,
      maxSnapshotBytes: 1024,
      shell: 'auto',
    },
    session: {
      idleDelayMs: 200,
    },
  });

  const harness = createManagedSessionHarness(manager, { cols: 80, rows: 24, scrollbackLines: 1000 });

  try {
    manager.enableDebugCapture(harness.sessionId);
    manager.writeInput(harness.sessionId, ' \r\x7f');
    manager.writeInput(harness.sessionId, 'abc');

    const inputEvents = manager.getDebugCapture(harness.sessionId).filter((event) => event.kind === 'input');
    assert.equal(inputEvents.length, 1);

    assert.deepEqual(inputEvents[0]?.details, {
      byteLength: 3,
      hasEnter: true,
      spaceCount: 1,
      backspaceCount: 1,
      enterCount: 1,
      escapeCount: 0,
      controlCount: 2,
      printableCount: 1,
      inputClass: 'safe-control',
      safePreview: true,
    });
    assert.equal(inputEvents[0]?.preview, '␠\\r\\x7f');

    assert.equal(inputEvents[1], undefined);
  } finally {
    harness.dispose();
  }
}

function testDebugCaptureLocalhostGuard(): void {
  const req = { ip: '192.168.0.10' } as express.Request;
  let statusCode = 200;
  let payload: unknown = null;
  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(body: unknown) {
      payload = body;
      return this;
    },
  } as unknown as express.Response;
  let nextCalled = false;

  requireLocalDebugCapture(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(statusCode, 403);
  assert.equal((payload as { error?: { code?: string } }).error?.code, 'LOCALHOST_ONLY');
}

function testDebugCaptureSessionExistsGuard(): void {
  const middleware = ensureDebugCaptureSessionExists({
    hasSession: () => false,
  });
  const req = { params: { id: 'missing-session' } } as unknown as express.Request;
  let statusCode = 200;
  let payload: unknown = null;
  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(body: unknown) {
      payload = body;
      return this;
    },
  } as unknown as express.Response;
  let nextCalled = false;

  middleware(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(statusCode, 404);
  assert.equal((payload as { error?: { code?: string } }).error?.code, 'SESSION_NOT_FOUND');
}

function testSessionManagerDegradedSnapshot(): void {
  const manager = new SessionManager({
    pty: {
      termName: 'xterm-256color',
      defaultCols: 10,
      defaultRows: 4,
      useConpty: false,
      scrollbackLines: 1000,
      maxSnapshotBytes: 1024,
      shell: 'auto',
    },
    session: {
      idleDelayMs: 200,
    },
  });

  const harness = createManagedSessionHarness(manager, { cols: 10, rows: 4, scrollbackLines: 1000 });

  try {
    harness.sessionData.headless!.serializeAddon.serialize = (() => {
      throw new Error('serialize failed');
    }) as typeof harness.sessionData.headless.serializeAddon.serialize;

    const snapshot = manager.getScreenSnapshot(harness.sessionId);
    const replay = manager.getReplaySnapshot(harness.sessionId);

    assert.equal(snapshot?.health, 'degraded');
    assert.equal(snapshot?.data, '');
    assert.equal(harness.sessionData.headlessHealth, 'degraded');
    assert.equal(harness.sessionData.snapshotCache, null);
    assert.match(replay?.data ?? '', /server snapshot is unavailable/i);
  } finally {
    harness.dispose();
  }
}

async function testSessionManagerDirtyCacheDegradedRecovery(): Promise<void> {
  const manager = new SessionManager({
    pty: {
      termName: 'xterm-256color',
      defaultCols: 10,
      defaultRows: 4,
      useConpty: false,
      scrollbackLines: 1000,
      maxSnapshotBytes: 1024,
      shell: 'auto',
    },
    session: {
      idleDelayMs: 200,
    },
  });

  const harness = createManagedSessionHarness(manager, { cols: 10, rows: 4, scrollbackLines: 1000 });

  try {
    await (manager as any).applyHeadlessOutput(harness.sessionId, harness.sessionData, 'old');
    manager.getScreenSnapshot(harness.sessionId);
    (manager as any).queueHeadlessOutput(harness.sessionId, harness.sessionData, 'new');
    await harness.sessionData.headlessWriteChain;

    harness.sessionData.headless!.serializeAddon.serialize = (() => {
      throw new Error('serialize failed');
    }) as typeof harness.sessionData.headless.serializeAddon.serialize;

    const replay = manager.getReplaySnapshot(harness.sessionId);

    assert.match(replay?.data ?? '', /server snapshot is unavailable/i);
    assert.match(replay?.data ?? '', /oldnew/);
  } finally {
    harness.dispose();
  }
}

async function testSessionManagerQueuedOutputDegradedRace(): Promise<void> {
  const manager = new SessionManager({
    pty: {
      termName: 'xterm-256color',
      defaultCols: 10,
      defaultRows: 4,
      useConpty: false,
      scrollbackLines: 1000,
      maxSnapshotBytes: 1024,
      shell: 'auto',
    },
    session: {
      idleDelayMs: 200,
    },
  });

  const harness = createManagedSessionHarness(manager, { cols: 10, rows: 4, scrollbackLines: 1000 });
  const pendingCallbacks: Array<() => void> = [];

  try {
    harness.sessionData.headless!.terminal.write = ((_data: string | Uint8Array, callback?: () => void) => {
      pendingCallbacks.push(() => callback?.());
    }) as typeof harness.sessionData.headless.terminal.write;
    harness.sessionData.headless!.terminal.resize = (() => {
      throw new Error('resize failed');
    }) as typeof harness.sessionData.headless.terminal.resize;

    (manager as any).queueHeadlessOutput(harness.sessionId, harness.sessionData, 'PAYLOAD_A');
    (manager as any).queueHeadlessOutput(harness.sessionId, harness.sessionData, 'PAYLOAD_B');

    manager.resize(harness.sessionId, 20, 5);

    while (pendingCallbacks.length > 0) {
      const callback = pendingCallbacks.shift();
      callback?.();
      await Promise.resolve();
    }

    await harness.sessionData.headlessWriteChain;
    const replay = manager.getReplaySnapshot(harness.sessionId);

    assert.match(replay?.data ?? '', /server snapshot is unavailable/i);
    assert.match(replay?.data ?? '', /PAYLOAD_A/);
    assert.match(replay?.data ?? '', /PAYLOAD_B/);
  } finally {
    harness.dispose();
  }
}

async function testSessionManagerMixedFlushDegradedRecovery(): Promise<void> {
  const manager = new SessionManager({
    pty: {
      termName: 'xterm-256color',
      defaultCols: 10,
      defaultRows: 4,
      useConpty: false,
      scrollbackLines: 1000,
      maxSnapshotBytes: 1024,
      shell: 'auto',
    },
    session: {
      idleDelayMs: 200,
    },
  });

  const harness = createManagedSessionHarness(manager, { cols: 10, rows: 4, scrollbackLines: 1000 });
  const pendingCallbacks: Array<() => void> = [];
  let writeCount = 0;

  try {
    const originalWrite = harness.sessionData.headless!.terminal.write.bind(harness.sessionData.headless!.terminal);
    harness.sessionData.headless!.terminal.write = ((data: string | Uint8Array, callback?: () => void) => {
      writeCount += 1;
      if (writeCount === 1) {
        originalWrite(data, callback);
        return;
      }
      pendingCallbacks.push(() => originalWrite(data, callback));
    }) as typeof harness.sessionData.headless.terminal.write;

    (manager as any).queueHeadlessOutput(harness.sessionId, harness.sessionData, 'PAYLOAD_A');
    await harness.sessionData.headlessWriteChain;
    (manager as any).queueHeadlessOutput(harness.sessionId, harness.sessionData, 'PAYLOAD_B');

    manager.getScreenSnapshot(harness.sessionId);

    harness.sessionData.headless!.terminal.resize = (() => {
      throw new Error('resize failed');
    }) as typeof harness.sessionData.headless.terminal.resize;
    manager.resize(harness.sessionId, 20, 5);

    while (pendingCallbacks.length > 0) {
      pendingCallbacks.shift()?.();
      await Promise.resolve();
    }

    await harness.sessionData.headlessWriteChain;
    const replay = manager.getReplaySnapshot(harness.sessionId);

    assert.match(replay?.data ?? '', /server snapshot is unavailable/i);
    assert.equal((replay?.data ?? '').split('PAYLOAD_A').length - 1, 1);
    assert.equal((replay?.data ?? '').split('PAYLOAD_B').length - 1, 1);
  } finally {
    harness.dispose();
  }
}

async function testSessionManagerWriteFailureNoDuplicate(): Promise<void> {
  const manager = new SessionManager({
    pty: {
      termName: 'xterm-256color',
      defaultCols: 10,
      defaultRows: 4,
      useConpty: false,
      scrollbackLines: 1000,
      maxSnapshotBytes: 1024,
      shell: 'auto',
    },
    session: {
      idleDelayMs: 200,
    },
  });

  const harness = createManagedSessionHarness(manager, { cols: 10, rows: 4, scrollbackLines: 1000 });

  try {
    harness.sessionData.headless!.terminal.write = (() => {
      throw new Error('write failed');
    }) as typeof harness.sessionData.headless.terminal.write;

    (manager as any).queueHeadlessOutput(harness.sessionId, harness.sessionData, 'PAYLOAD_X');
    await harness.sessionData.headlessWriteChain;

    const replay = manager.getReplaySnapshot(harness.sessionId);

    assert.match(replay?.data ?? '', /server snapshot is unavailable/i);
    assert.equal((replay?.data ?? '').split('PAYLOAD_X').length - 1, 1);
  } finally {
    harness.dispose();
  }
}

async function testSessionManagerOversizedSnapshot(): Promise<void> {
  const manager = new SessionManager({
    pty: {
      termName: 'xterm-256color',
      defaultCols: 10,
      defaultRows: 4,
      useConpty: false,
      scrollbackLines: 1000,
      maxSnapshotBytes: 8,
      shell: 'auto',
    },
    session: {
      idleDelayMs: 200,
    },
  });

  const harness = createManagedSessionHarness(manager, { cols: 10, rows: 4, scrollbackLines: 1000 });

  try {
    await (manager as any).applyHeadlessOutput(harness.sessionId, harness.sessionData, 'shell\r\nprompt> ');
    await (manager as any).applyHeadlessOutput(harness.sessionId, harness.sessionData, '\x1b[?1049h\x1b[HALT');

    const snapshot = manager.getScreenSnapshot(harness.sessionId);
    const replay = manager.getReplaySnapshot(harness.sessionId);

    assert.equal(snapshot?.health, 'healthy');
    assert.equal(snapshot?.truncated, true);
    assert.equal(snapshot?.data, '');
    assert.equal(replay?.truncated, true);
    assert.match(replay?.data ?? '', /snapshot exceeded maxSnapshotBytes/i);
  } finally {
    harness.dispose();
  }
}

async function testSessionManagerAltScreenSnapshot(): Promise<void> {
  const manager = new SessionManager({
    pty: {
      termName: 'xterm-256color',
      defaultCols: 10,
      defaultRows: 4,
      useConpty: false,
      scrollbackLines: 1000,
      maxSnapshotBytes: 1024,
      shell: 'auto',
    },
    session: {
      idleDelayMs: 200,
    },
  });

  const harness = createManagedSessionHarness(manager, { cols: 10, rows: 4, scrollbackLines: 1000 });

  try {
    await (manager as any).applyHeadlessOutput(harness.sessionId, harness.sessionData, 'shell\r\nprompt> ');
    await (manager as any).applyHeadlessOutput(harness.sessionId, harness.sessionData, '\x1b[?1049h\x1b[HALT');

    const snapshot = manager.getScreenSnapshot(harness.sessionId);

    assert.equal(snapshot?.health, 'healthy');
    assert.match(snapshot?.data ?? '', /\x1b\[\?1049h/);
    assert.match(snapshot?.data ?? '', /ALT/);
  } finally {
    harness.dispose();
  }
}

function testSessionManagerDegradedOutputRecovery(): void {
  const manager = new SessionManager({
    pty: {
      termName: 'xterm-256color',
      defaultCols: 10,
      defaultRows: 4,
      useConpty: false,
      scrollbackLines: 1000,
      maxSnapshotBytes: 1024,
      shell: 'auto',
    },
    session: {
      idleDelayMs: 200,
    },
  });

  const harness = createDegradedSessionHarness(manager, { cols: 10, rows: 4, scrollbackLines: 1000 });
  const authServiceStub = {
    verifyToken: () => ({ valid: true, payload: { sub: 'test-user' } }),
  } as unknown as AuthService;
  const router = new WsRouter(authServiceStub, manager);
  manager.setWsRouter(router);
  const { ws, sent } = createFakeWs();

  try {
    (router as any).clients.set(ws, {
      clientId: 'client-1',
      isAlive: true,
      subscribedSessions: new Set<string>(),
      replayPendingSessions: new Map(),
    });

    (manager as any).queueHeadlessOutput(harness.sessionId, harness.sessionData, 'lost-while-unsubscribed');
    (router as any).handleSubscribe(ws, [harness.sessionId]);

    assert.equal(sent[0].type, 'screen-snapshot');
    assert.equal(sent[0].mode, 'fallback');
    assert.match(String(sent[0].data), /lost-while-unsubscribed/);
  } finally {
    router.destroy();
    harness.dispose();
  }
}

async function testSettingsServiceLegacyPtyMigration(): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'buildergate-settings-legacy-pty-'));
  const configPath = path.join(tempDir, 'config.json5');
  const fixture = createConfigFixture();
  await fs.writeFile(configPath, createLegacyConfigFixtureContent(), 'utf-8');

  const harness = createSettingsHarness({ fixture, configPath });

  try {
    const result = harness.settingsService.savePatch({
      auth: { durationMs: 900000 },
    });

    assert.ok(result.changedKeys.includes('auth.durationMs'));

    const savedContent = await fs.readFile(configPath, 'utf-8');
    assert.match(savedContent, /durationMs:\s*900000/);
    assert.match(savedContent, /maxBufferSize:\s*65536/);
  } finally {
    harness.destroy();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function createHeadlessHarness(options: { cols?: number; rows?: number; scrollbackLines?: number } = {}) {
  const state = createHeadlessTerminalState({
    cols: options.cols ?? 10,
    rows: options.rows ?? 4,
    scrollbackLines: options.scrollbackLines ?? 1000,
  });

  return {
    state,
    dispose: () => disposeHeadlessTerminal(state),
  };
}

function createTestDeferredSignal<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function createManagedSessionHarness(
  manager: SessionManager,
  options: { cols?: number; rows?: number; scrollbackLines?: number } = {},
) {
  const headless = createHeadlessHarness(options);
  const session: Session = {
    id: `session-${Math.random().toString(36).slice(2)}`,
    name: 'Harness Session',
    status: 'idle',
    createdAt: new Date(),
    lastActiveAt: new Date(),
    sortOrder: 0,
  };

  const sessionData = {
    session,
    pty: {
      resize() {},
      kill() {},
      write() {},
      pid: 1,
    } as never,
    idleTimer: null as NodeJS.Timeout | null,
    headless: headless.state,
    headlessHealth: 'healthy',
    headlessWriteChain: Promise.resolve(),
    headlessCloseSignal: createTestDeferredSignal<void>(),
    pendingHeadlessWrites: 0,
    cols: options.cols ?? 10,
    rows: options.rows ?? 4,
    screenSeq: 0,
    snapshotCache: null,
    degradedReplayBuffer: '',
    degradedReplayTruncated: false,
    pendingOutputChunks: [],
    unsnapshottedOutput: '',
    unsnapshottedOutputTruncated: false,
    initialCwd: process.cwd(),
    echoTracker: {
      lastInputAt: 0,
      lastInputHasEnter: false,
      recentInputs: [],
    },
    detectionMode: 'heuristic',
    oscDetector: new OscDetector(),
  };

  (manager as any).sessions.set(session.id, sessionData);

  return {
    sessionId: session.id,
    sessionData,
    dispose: () => {
      sessionData.oscDetector.destroy();
      (manager as any).sessions.delete(session.id);
      headless.dispose();
    },
  };
}

function createDegradedSessionHarness(
  manager: SessionManager,
  options: { cols?: number; rows?: number; scrollbackLines?: number } = {},
) {
  const harness = createManagedSessionHarness(manager, options);
  const sessionData = harness.sessionData as any;
  if (sessionData.headless) {
    disposeHeadlessTerminal(sessionData.headless);
    sessionData.headless = null;
  }
  sessionData.headlessHealth = 'degraded';
  return harness;
}

function createWorkspaceServiceHarness() {
  const calls = {
    createSession: [] as Array<{ name?: string; shell?: string; cwd?: string }>,
    deleteSession: [] as string[],
    deleteMultipleSessions: [] as string[][],
    hasSession: new Set<string>(),
    createSessionError: null as Error | null,
  };
  let sessionCounter = 0;

  const sessionManagerStub = {
    onCwdChange() {},
    createSession(name?: string, shell?: string, cwd?: string) {
      calls.createSession.push({ name, shell, cwd });
      if (calls.createSessionError) {
        throw calls.createSessionError;
      }
      const id = `session-${++sessionCounter}`;
      calls.hasSession.add(id);
      return {
        id,
        name: name ?? `Session-${sessionCounter}`,
        status: 'idle',
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        sortOrder: 0,
      };
    },
    deleteSession(id: string) {
      calls.deleteSession.push(id);
      calls.hasSession.delete(id);
      return true;
    },
    deleteMultipleSessions(ids: string[]) {
      calls.deleteMultipleSessions.push(ids);
      for (const id of ids) calls.hasSession.delete(id);
    },
    hasSession(id: string) {
      return calls.hasSession.has(id);
    },
    getCwdFilePath() {
      return null;
    },
    getLastCwd() {
      return null;
    },
  } as unknown as SessionManager;

  const workspaceService = new WorkspaceService(sessionManagerStub);
  (workspaceService as any).save = async () => {};
  (workspaceService as any).flushToDisk = async () => {};

  return { workspaceService, calls };
}

function readHeadlessLines(
  harness: ReturnType<typeof createHeadlessHarness>,
  lineCount: number,
): string[] {
  const lines: string[] = [];

  for (let index = 0; index < lineCount; index += 1) {
    const line = harness.state.terminal.buffer.active.getLine(index);
    lines.push(line?.translateToString(true) ?? '');
  }

  return lines;
}

async function testHeadlessSnapshotSerialization(): Promise<void> {
  const harness = createHeadlessHarness();

  try {
    await writeHeadlessTerminal(harness.state, 'hello\r\nworld');

    const firstSnapshot = serializeHeadlessTerminal(harness.state, 1024);
    const secondSnapshot = serializeHeadlessTerminal(harness.state, 1024);
    const restored = createHeadlessHarness({ cols: firstSnapshot.cols, rows: firstSnapshot.rows });

    try {
      await writeHeadlessTerminal(restored.state, firstSnapshot.data);

      assert.equal(firstSnapshot.cols, 10);
      assert.equal(firstSnapshot.rows, 4);
      assert.equal(firstSnapshot.truncated, false);
      assert.equal(firstSnapshot.data, 'hello\r\nworld');
      assert.deepEqual(secondSnapshot, firstSnapshot);
      assert.equal(restored.state.terminal.buffer.active.type, 'normal');
      assert.deepEqual(readHeadlessLines(restored, 4), ['hello', 'world', '', '']);
    } finally {
      restored.dispose();
    }
  } finally {
    harness.dispose();
  }
}

async function testHeadlessSnapshotResize(): Promise<void> {
  const harness = createHeadlessHarness();

  try {
    await writeHeadlessTerminal(harness.state, 'abcdefghij12345');
    const before = serializeHeadlessTerminal(harness.state, 1024);
    const beforeLines = readHeadlessLines(harness, 3);

    resizeHeadlessTerminal(harness.state, 5, 4);
    const after = serializeHeadlessTerminal(harness.state, 1024);
    const afterLines = readHeadlessLines(harness, 4);
    const restored = createHeadlessHarness({ cols: after.cols, rows: after.rows });

    try {
      await writeHeadlessTerminal(restored.state, after.data);

      assert.equal(before.cols, 10);
      assert.equal(after.cols, 5);
      assert.equal(after.rows, 4);
      assert.ok(before.data.length > 0);
      assert.ok(after.data.length > 0);
      assert.deepEqual(beforeLines, ['abcdefghij', '12345', '']);
      assert.deepEqual(afterLines, ['abcde', 'fghij', '12345', '']);
      assert.deepEqual(readHeadlessLines(restored, 4), afterLines);
    } finally {
      restored.dispose();
    }
  } finally {
    harness.dispose();
  }
}

async function testHeadlessSnapshotAltScreen(): Promise<void> {
  const harness = createHeadlessHarness();

  try {
    await writeHeadlessTerminal(harness.state, 'shell\r\nprompt> ');
    const normal = serializeHeadlessTerminal(harness.state, 1024);

    await writeHeadlessTerminal(harness.state, '\x1b[?1049h\x1b[HALT');
    const alt = serializeHeadlessTerminal(harness.state, 1024);

    await writeHeadlessTerminal(harness.state, '\x1b[?1049l');
    const restored = serializeHeadlessTerminal(harness.state, 1024);
    const restoredAlt = createHeadlessHarness({ cols: alt.cols, rows: alt.rows });

    try {
      await writeHeadlessTerminal(restoredAlt.state, alt.data);

      assert.equal(normal.data, 'shell\r\nprompt> ');
      assert.match(alt.data, /\x1b\[\?1049h/);
      assert.match(alt.data, /ALT/);
      assert.equal(restored.data, normal.data);
      assert.equal(restoredAlt.state.terminal.buffer.active.type, 'alternate');
      assert.deepEqual(readHeadlessLines(restoredAlt, 4), ['ALT', '', '', '']);
    } finally {
      restoredAlt.dispose();
    }
  } finally {
    harness.dispose();
  }
}

function testHeadlessSnapshotEmptyScreen(): void {
  const harness = createHeadlessHarness();

  try {
    const snapshot = serializeHeadlessTerminal(harness.state, 1024);
    assert.equal(snapshot.cols, 10);
    assert.equal(snapshot.rows, 4);
    assert.equal(snapshot.truncated, false);
    assert.equal(snapshot.data, '');
  } finally {
    harness.dispose();
  }
}

async function testHeadlessSnapshotTruncation(): Promise<void> {
  const harness = createHeadlessHarness();

  try {
    await writeHeadlessTerminal(harness.state, 'shell\r\nprompt> ');
    await writeHeadlessTerminal(harness.state, '\x1b[?1049h\x1b[HALT');

    const snapshot = serializeHeadlessTerminal(harness.state, 8);

    assert.equal(snapshot.truncated, true);
    assert.equal(snapshot.data, '');
  } finally {
    harness.dispose();
  }
}

function testTerminalPayloadTruncationCsi(): void {
  const truncated = truncateTerminalPayloadTail('\x1b[31mRED', 4);
  assert.equal(truncated.truncated, true);
  assert.equal(truncated.content, 'RED');
}

function testTerminalPayloadTruncationOsc(): void {
  const truncated = truncateTerminalPayloadTail('prefix\x1b]0;title\u0007body', 4);
  assert.equal(truncated.truncated, true);
  assert.equal(truncated.content, 'body');
}

function testTerminalPayloadTruncationIncompleteCsi(): void {
  const first = truncateTerminalPayloadTail('abc\x1b[', 1);
  const second = truncateTerminalPayloadTail('prefix\x1b[31', 4);

  assert.equal(first.truncated, true);
  assert.equal(first.content, '');
  assert.equal(second.truncated, true);
  assert.equal(second.content, '');
}

function testTerminalPayloadTruncationIncompleteOsc(): void {
  const first = truncateTerminalPayloadTail('abc\x1b]0;ti', 2);
  const second = truncateTerminalPayloadTail('abc\x1b]0;title\x1b', 1);

  assert.equal(first.truncated, true);
  assert.equal(first.content, '');
  assert.equal(second.truncated, true);
  assert.equal(second.content, '');
}

function testTerminalPayloadTruncationTrailingIncompleteSuffix(): void {
  const incompleteCsi = truncateTerminalPayloadTail('hello\x1b[', 6);
  const incompleteCsiWithParams = truncateTerminalPayloadTail('ab\x1b[31', 5);
  const incompleteOsc = truncateTerminalPayloadTail('hello\x1b]0;ti', 8);
  const incompleteEsc = truncateTerminalPayloadTail('hello\x1b', 3);

  assert.equal(incompleteCsi.truncated, true);
  assert.equal(incompleteCsi.content, 'ello');
  assert.equal(incompleteCsiWithParams.truncated, true);
  assert.equal(incompleteCsiWithParams.content, 'b');
  assert.equal(incompleteOsc.truncated, true);
  assert.equal(incompleteOsc.content, 'lo');
  assert.equal(incompleteEsc.truncated, true);
  assert.equal(incompleteEsc.content, 'lo');
}

function createFakeWs() {
  const sent: Array<Record<string, unknown>> = [];
  const listeners = new Map<string, Array<(...args: any[]) => void>>();

  const ws = {
    readyState: 1,
    send(payload: string) {
      sent.push(JSON.parse(payload) as Record<string, unknown>);
    },
    ping() {},
    terminate() {},
    on(event: string, handler: (...args: any[]) => void) {
      const current = listeners.get(event) ?? [];
      current.push(handler);
      listeners.set(event, current);
      return this;
    },
  } as unknown as import('ws').WebSocket;

  return { ws, sent };
}

function createWsRouterHarness(options?: {
  snapshotData?: string;
  snapshotTruncated?: boolean;
  snapshotMode?: 'authoritative' | 'fallback';
  snapshotSeq?: number;
}) {
  const calls = {
    writeInput: [] as Array<{ sessionId: string; data: string }>,
  };
  const session = {
    id: 'session-1',
    name: 'Session 1',
    status: 'running',
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    sortOrder: 0,
  };

  const sessionManagerStub = {
    getSession: (id: string) => id === session.id ? session : null,
    getLastCwd: (id: string) => id === session.id ? 'C:\\repo' : null,
    isSessionReady: (id: string) => id === session.id,
    getScreenSnapshot: (id: string) => id === session.id ? {
      seq: options?.snapshotSeq ?? 1,
      cols: 80,
      rows: 24,
      data: options?.snapshotData ?? 'history-seed',
      truncated: options?.snapshotTruncated ?? false,
      generatedAt: Date.now(),
      health: options?.snapshotMode === 'fallback' ? 'degraded' : 'healthy',
      windowsPty: { backend: 'conpty', buildNumber: 22631 },
    } : null,
    getReplayQueueLimit: () => 64,
    writeInput: (sessionId: string, data: string) => {
      calls.writeInput.push({ sessionId, data });
      return true;
    },
    resize: () => true,
  } as unknown as SessionManager;

  const authServiceStub = {
    verifyToken: () => ({ valid: true, payload: { sub: 'test-user' } }),
  } as unknown as AuthService;

  const router = new WsRouter(authServiceStub, sessionManagerStub);
  const { ws, sent } = createFakeWs();

  (router as any).clients.set(ws, {
    clientId: 'client-1',
    isAlive: true,
    subscribedSessions: new Set<string>(),
    replayPendingSessions: new Map<string, { queuedOutput: string; timer: NodeJS.Timeout }>(),
  });

  return { router, ws, sent, calls };
}

function testWsRouterScreenSnapshotOrdering(): void {
  const { router, ws, sent } = createWsRouterHarness();

  (router as any).handleSubscribe(ws, ['session-1']);
  assert.equal(sent[0].type, 'screen-snapshot');
  assert.equal((sent[0] as any).windowsPty?.backend, 'conpty');
  assert.equal(sent[1].type, 'subscribed');
  assert.equal(((sent[1] as any).sessions?.[0] as any)?.ready, false);
  const replayToken = String(sent[0].replayToken);

  router.routeSessionOutput('session-1', 'live-after-snapshot');
  assert.equal(sent.length, 2);

  (router as any).handleScreenSnapshotReady(ws, 'session-1', replayToken);
  assert.equal(sent[2].type, 'output');
  assert.equal(sent[2].data, 'live-after-snapshot');
  assert.equal(sent[3].type, 'session:ready');

  router.destroy();
}

function testWsRouterBlocksInputWhileReplayPending(): void {
  const { router, ws, sent, calls } = createWsRouterHarness();

  (router as any).handleSubscribe(ws, ['session-1']);
  const replayToken = String(sent[0].replayToken);

  (router as any).handleInput(ws, 'session-1', 'blocked');
  assert.deepEqual(calls.writeInput, []);

  (router as any).handleScreenSnapshotReady(ws, 'session-1', replayToken);
  (router as any).handleInput(ws, 'session-1', 'allowed');

  assert.deepEqual(calls.writeInput, [{ sessionId: 'session-1', data: 'allowed' }]);
  assert.equal(sent[sent.length - 1].type, 'session:ready');

  router.destroy();
}

function testWsRouterObservabilityCounters(): void {
  const { router, ws } = createWsRouterHarness();

  (router as any).handleSubscribe(ws, ['session-1']);
  router.routeSessionOutput('session-1', 'queued');
  const snapshot = (router as any).clients.get(ws).replayPendingSessions.get('session-1');
  const token = snapshot.replayToken;
  (router as any).handleScreenSnapshotReady(ws, 'session-1', token);

  const stats = router.getObservabilitySnapshot();

  assert.equal(stats.connectedClients, 1);
  assert.equal(stats.subscribedSessionCount, 1);
  assert.equal(stats.replayPendingCount, 0);
  assert.equal(stats.maxReplayQueueLengthObserved >= 'queued'.length, true);

  router.destroy();
}

async function testWsRouterOversizedSnapshotReplayStart(): Promise<void> {
  const manager = new SessionManager({
    pty: {
      termName: 'xterm-256color',
      defaultCols: 10,
      defaultRows: 4,
      useConpty: false,
      scrollbackLines: 1000,
      maxSnapshotBytes: 8,
      shell: 'auto',
    },
    session: {
      idleDelayMs: 200,
    },
  });
  const harness = createManagedSessionHarness(manager, { cols: 10, rows: 4, scrollbackLines: 1000 });
  const authServiceStub = {
    verifyToken: () => ({ valid: true, payload: { sub: 'test-user' } }),
  } as unknown as AuthService;
  const router = new WsRouter(authServiceStub, manager);
  manager.setWsRouter(router);
  const { ws, sent } = createFakeWs();

  try {
    (router as any).clients.set(ws, {
      clientId: 'client-1',
      isAlive: true,
      subscribedSessions: new Set<string>(),
      replayPendingSessions: new Map(),
    });

    await (manager as any).applyHeadlessOutput(harness.sessionId, harness.sessionData, 'shell\r\nprompt> ');
    await (manager as any).applyHeadlessOutput(harness.sessionId, harness.sessionData, '\x1b[?1049h\x1b[HALT');
    (router as any).handleSubscribe(ws, [harness.sessionId]);

    const snapshot = sent[0];
    assert.equal(snapshot.type, 'screen-snapshot');
    assert.equal(snapshot.mode, 'fallback');
    assert.equal(snapshot.truncated, true);
    assert.equal(snapshot.data, '');
  } finally {
    router.destroy();
    harness.dispose();
  }
}

function testWsRouterDegradedReplayStart(): void {
  const { router, ws, sent } = createWsRouterHarness({
    snapshotData: '\r\n[BuilderGate] Server snapshot is unavailable for this session. Using fallback recovery when possible...\r\n',
    snapshotMode: 'fallback',
  });

  (router as any).handleSubscribe(ws, ['session-1']);

  assert.equal(sent[0].type, 'screen-snapshot');
  assert.equal(sent[0].truncated, false);
  assert.equal(sent[0].mode, 'fallback');
  assert.match(String(sent[0].data), /server snapshot is unavailable/i);

  router.destroy();
}

function testWsRouterDuplicateSubscribeIdempotent(): void {
  const { router, ws, sent } = createWsRouterHarness();

  (router as any).handleSubscribe(ws, ['session-1']);
  (router as any).handleSubscribe(ws, ['session-1']);

  const snapshotMessages = sent.filter((message) => message.type === 'screen-snapshot');
  assert.equal(snapshotMessages.length, 1);

  router.destroy();
}

function testWsRouterIgnoresStaleReplayTokens(): void {
  const { router, ws, sent } = createWsRouterHarness();

  (router as any).handleSubscribe(ws, ['session-1']);
  const firstToken = String(sent[0].replayToken);
  router.routeSessionOutput('session-1', 'first-pending');
  (router as any).handleUnsubscribe(ws, ['session-1']);

  (router as any).handleSubscribe(ws, ['session-1']);
  const secondToken = String(sent[2].replayToken);
  router.routeSessionOutput('session-1', 'second-pending');

  (router as any).handleScreenSnapshotReady(ws, 'session-1', firstToken);
  const outputsAfterStaleAck = sent.filter((message) => message.type === 'output');
  assert.equal(outputsAfterStaleAck.length, 0);

  (router as any).handleScreenSnapshotReady(ws, 'session-1', secondToken);
  const finalOutput = sent.filter((message) => message.type === 'output');
  assert.equal(finalOutput.length, 1);
  assert.equal(finalOutput[0].data, 'second-pending');

  router.destroy();
}

function testWsRouterRefreshesReplaySnapshotsOnResize(): void {
  const snapshotState = {
    seq: 1,
    cols: 80,
    rows: 24,
    data: 'A',
    truncated: false,
    generatedAt: Date.now(),
    health: 'healthy' as const,
  };
  const session = {
    id: 'session-1',
    name: 'Session 1',
    status: 'running',
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    sortOrder: 0,
  };
  const sessionManagerStub = {
    getSession: (id: string) => id === session.id ? session : null,
    getLastCwd: () => 'C:\\repo',
    isSessionReady: (id: string) => id === session.id,
    getScreenSnapshot: () => snapshotState,
    getReplayQueueLimit: () => 64,
    writeInput: () => true,
    resize: () => true,
  } as unknown as SessionManager;
  const authServiceStub = {
    verifyToken: () => ({ valid: true, payload: { sub: 'test-user' } }),
  } as unknown as AuthService;
  const router = new WsRouter(authServiceStub, sessionManagerStub);
  const { ws, sent } = createFakeWs();

  try {
    (router as any).clients.set(ws, {
      clientId: 'client-1',
      isAlive: true,
      subscribedSessions: new Set<string>(),
      replayPendingSessions: new Map(),
    });

    (router as any).handleSubscribe(ws, ['session-1']);
    const firstToken = String(sent[0].replayToken);

    snapshotState.seq = 2;
    snapshotState.cols = 120;
    snapshotState.rows = 40;
    router.routeSessionOutput('session-1', 'B');
    snapshotState.data = 'AB';
    router.refreshReplaySnapshots('session-1');

    const refreshed = sent[2];
    assert.equal(refreshed.type, 'screen-snapshot');
    assert.equal(refreshed.cols, 120);
    assert.equal(refreshed.rows, 40);
    const secondToken = String(refreshed.replayToken);
    assert.notEqual(secondToken, firstToken);

    router.routeSessionOutput('session-1', 'C');

    (router as any).handleScreenSnapshotReady(ws, 'session-1', firstToken);
    assert.equal(sent.filter((message) => message.type === 'output').length, 0);

    (router as any).handleScreenSnapshotReady(ws, 'session-1', secondToken);
    const outputs = sent.filter((message) => message.type === 'output');
    assert.equal(outputs.length, 1);
    assert.equal(outputs[0].data, 'C');
  } finally {
    router.destroy();
  }
}

async function testWsRouterNoDuplicateDeferredFallbackPayload(): Promise<void> {
  const manager = new SessionManager({
    pty: {
      termName: 'xterm-256color',
      defaultCols: 10,
      defaultRows: 4,
      useConpty: false,
      scrollbackLines: 1000,
      maxSnapshotBytes: 1024,
      shell: 'auto',
    },
    session: {
      idleDelayMs: 200,
    },
  });
  const harness = createManagedSessionHarness(manager, { cols: 10, rows: 4, scrollbackLines: 1000 });
  const pendingCallbacks: Array<() => void> = [];
  const authServiceStub = {
    verifyToken: () => ({ valid: true, payload: { sub: 'test-user' } }),
  } as unknown as AuthService;
  const router = new WsRouter(authServiceStub, manager);
  manager.setWsRouter(router);
  const { ws, sent } = createFakeWs();

  try {
    (router as any).clients.set(ws, {
      clientId: 'client-1',
      isAlive: true,
      subscribedSessions: new Set<string>(),
      replayPendingSessions: new Map(),
    });

    harness.sessionData.headless!.terminal.write = ((_data: string | Uint8Array, callback?: () => void) => {
      pendingCallbacks.push(() => callback?.());
    }) as typeof harness.sessionData.headless.terminal.write;
    harness.sessionData.headless!.terminal.resize = (() => {
      throw new Error('resize failed');
    }) as typeof harness.sessionData.headless.terminal.resize;

    (manager as any).queueHeadlessOutput(harness.sessionId, harness.sessionData, 'PAYLOAD_B');
    manager.resize(harness.sessionId, 20, 5);
    (router as any).handleSubscribe(ws, [harness.sessionId]);

    const snapshot = sent[0];
    assert.equal(snapshot.type, 'screen-snapshot');
    assert.equal(snapshot.mode, 'fallback');
    assert.match(String(snapshot.data), /PAYLOAD_B/);

    while (pendingCallbacks.length > 0) {
      pendingCallbacks.shift()?.();
      await Promise.resolve();
    }

    await harness.sessionData.headlessWriteChain;
    (router as any).handleScreenSnapshotReady(ws, harness.sessionId, String(snapshot.replayToken));

    const outputs = sent.filter((message) => message.type === 'output');
    assert.equal(outputs.length, 0);
  } finally {
    router.destroy();
    harness.dispose();
  }
}

function testWsRouterClearSessionState(): void {
  const { router, ws, sent } = createWsRouterHarness();

  (router as any).handleSubscribe(ws, ['session-1']);
  router.routeSessionOutput('session-1', 'queued-before-clear');
  router.clearSessionState('session-1');
  router.routeSessionOutput('session-1', 'output-after-clear');

  const outputMessages = sent.filter((message) => message.type === 'output');
  assert.equal(outputMessages.length, 0);
  assert.equal((router as any).sessionSubscribers.has('session-1'), false);

  router.destroy();
}

async function testWorkspaceServiceRestartTab(): Promise<void> {
  const { workspaceService, calls } = createWorkspaceServiceHarness();
  (workspaceService as any).state = {
    workspaces: [{
      id: 'ws-1',
      name: 'Workspace 1',
      sortOrder: 0,
      viewMode: 'tab',
      activeTabId: 'tab-1',
      colorCounter: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }],
    tabs: [{
      id: 'tab-1',
      workspaceId: 'ws-1',
      sessionId: 'old-session',
      name: 'Terminal 1',
      colorIndex: 0,
      sortOrder: 0,
      shellType: 'bash',
      lastCwd: '/repo',
      createdAt: new Date().toISOString(),
    }],
    gridLayouts: [],
  };
  calls.hasSession.add('old-session');

  const tab = await workspaceService.restartTab('ws-1', 'tab-1');

  assert.equal(calls.createSession.length, 1);
  assert.equal(calls.createSession[0].cwd, '/repo');
  assert.equal(calls.createSession[0].shell, 'bash');
  assert.deepEqual(calls.deleteSession, ['old-session']);
  assert.notEqual(tab.sessionId, 'old-session');
}

async function testWorkspaceServiceRestartTabCreateFailure(): Promise<void> {
  const { workspaceService, calls } = createWorkspaceServiceHarness();
  (workspaceService as any).state = {
    workspaces: [{
      id: 'ws-1',
      name: 'Workspace 1',
      sortOrder: 0,
      viewMode: 'tab',
      activeTabId: 'tab-1',
      colorCounter: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }],
    tabs: [{
      id: 'tab-1',
      workspaceId: 'ws-1',
      sessionId: 'old-session',
      name: 'Terminal 1',
      colorIndex: 0,
      sortOrder: 0,
      shellType: 'bash',
      lastCwd: '/repo',
      createdAt: new Date().toISOString(),
    }],
    gridLayouts: [],
  };
  calls.hasSession.add('old-session');
  calls.createSessionError = new AppError(ErrorCode.CONFIG_ERROR, 'probe failed');

  await assert.rejects(
    () => workspaceService.restartTab('ws-1', 'tab-1'),
    (error: unknown) => error instanceof AppError && error.code === ErrorCode.CONFIG_ERROR,
  );

  assert.equal((workspaceService as any).state.tabs[0].sessionId, 'old-session');
  assert.deepEqual(calls.deleteSession, []);
}

async function testWorkspaceServiceDeleteWorkspace(): Promise<void> {
  const { workspaceService, calls } = createWorkspaceServiceHarness();
  (workspaceService as any).state = {
    workspaces: [
      {
        id: 'ws-1',
        name: 'Workspace 1',
        sortOrder: 0,
        viewMode: 'tab',
        activeTabId: 'tab-1',
        colorCounter: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      {
        id: 'ws-2',
        name: 'Workspace 2',
        sortOrder: 1,
        viewMode: 'tab',
        activeTabId: null,
        colorCounter: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ],
    tabs: [
      {
        id: 'tab-1',
        workspaceId: 'ws-1',
        sessionId: 'session-a',
        name: 'Terminal A',
        colorIndex: 0,
        sortOrder: 0,
        shellType: 'bash',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'tab-2',
        workspaceId: 'ws-1',
        sessionId: 'session-b',
        name: 'Terminal B',
        colorIndex: 1,
        sortOrder: 1,
        shellType: 'bash',
        createdAt: new Date().toISOString(),
      },
    ],
    gridLayouts: [{ workspaceId: 'ws-1', mosaicTree: null }],
  };

  await workspaceService.deleteWorkspace('ws-1');

  assert.deepEqual(calls.deleteMultipleSessions, [['session-a', 'session-b']]);
  assert.equal((workspaceService as any).state.workspaces.some((ws: any) => ws.id === 'ws-1'), false);
  assert.equal((workspaceService as any).state.tabs.length, 0);
  assert.equal((workspaceService as any).state.gridLayouts.length, 0);
}

async function testWorkspaceServiceCheckOrphanTabs(): Promise<void> {
  const { workspaceService, calls } = createWorkspaceServiceHarness();
  (workspaceService as any).state = {
    workspaces: [{
      id: 'ws-1',
      name: 'Workspace 1',
      sortOrder: 0,
      viewMode: 'tab',
      activeTabId: 'tab-1',
      colorCounter: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }],
    tabs: [{
      id: 'tab-1',
      workspaceId: 'ws-1',
      sessionId: 'orphan-session',
      name: 'Terminal 1',
      colorIndex: 0,
      sortOrder: 0,
      shellType: 'bash',
      lastCwd: '/saved-cwd',
      createdAt: new Date().toISOString(),
    }],
    gridLayouts: [],
  };

  const orphanTabIds = await workspaceService.checkOrphanTabs();

  assert.deepEqual(orphanTabIds, ['tab-1']);
  assert.equal(calls.createSession.length, 1);
  assert.equal(calls.createSession[0].cwd, '/saved-cwd');
  assert.notEqual((workspaceService as any).state.tabs[0].sessionId, 'orphan-session');
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
    useConpty: true,
    scrollbackLines: 1000,
    maxSnapshotBytes: 65536,
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

function createLegacyConfigFixtureContent(): string {
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
  twoFactorExternalOnly?: boolean;
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
    getTwoFactorExternalOnly: () => opts.twoFactorExternalOnly ?? false,
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
    getTwoFactorExternalOnly: () => false,
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

async function testAuthRoutesExternalOnlyBypass(): Promise<void> {
  // twoFactor.externalOnly=true + localhost → TOTP 건너뛰고 JWT 발급
  const { accessors, authService } = makeAuthHarness({
    withTotp: true, totpRegistered: true, twoFactorExternalOnly: true
  });
  const result = await invokeLogin(accessors, { password: 'test-password' });
  authService.destroy();
  assert.equal(result.status, 200, `Expected 200 (externalOnly bypass), got ${result.status}`);
  assert.ok(typeof result.body.token === 'string', 'token should be present for externalOnly bypass');
  assert.equal(result.body.requires2FA, undefined, 'requires2FA should not be set when bypassed');
}

async function testAuthRoutesExternalOnlyDisabled(): Promise<void> {
  // twoFactor.externalOnly=false → localhost여도 TOTP 요구
  const { accessors, authService } = makeAuthHarness({
    withTotp: true, totpRegistered: true, twoFactorExternalOnly: false
  });
  const result = await invokeLogin(accessors, { password: 'test-password' });
  authService.destroy();
  assert.equal(result.status, 202, `Expected 202 (TOTP required), got ${result.status}`);
  assert.equal(result.body.requires2FA, true, 'requires2FA should be true when externalOnly=false');
}

void main();
