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
import { BootstrapSetupService } from './services/BootstrapSetupService.js';
import { reconcileTotpRuntime } from './services/twoFactorRuntime.js';
import { runDaemonTotpPreflightForConfig } from './services/daemonTotpPreflight.js';
import { SessionManager } from './services/SessionManager.js';
import { sessionManager } from './services/SessionManager.js';
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
import { createInternalShutdownRoutes } from './routes/internalShutdownRoutes.js';
import sessionRoutes from './routes/sessionRoutes.js';
import { ensureDebugCaptureSessionExists, requireLocalDebugCapture } from './middleware/debugCaptureGuards.js';
import { performGracefulShutdown } from './services/gracefulShutdown.js';
import {
  applyBootstrapPtyDefaultsToConfigText,
  normalizeRawConfigForPlatform,
} from './utils/ptyPlatformPolicy.js';
import { getConfigPath, loadConfigFromPath } from './utils/config.js';
import { loadConfigFromPathStrict } from './utils/configStrictLoader.js';
import { resolveInputReliabilityMode } from './utils/inputReliabilityMode.js';
import { validatePasswordPolicy } from './utils/passwordPolicy.js';
import express from 'express';
import type { Request } from 'express';

async function main(): Promise<void> {
  const tests: Array<{ name: string; run: () => Promise<void> | void }> = [
    { name: 'Config bootstrap applies OS-aware PTY defaults when creating config text', run: testConfigBootstrapAppliesPlatformPtyDefaults },
    { name: 'Config normalization neutralizes stale Windows PTY fields on non-Windows', run: testNormalizeRawConfigForPlatformNonWindows },
    { name: 'Config normalization preserves invalid PTY shapes for schema validation', run: testNormalizeRawConfigForPlatformPreservesInvalidPtyShapes },
    { name: 'Config loader bootstraps missing config files with platform-aware PTY defaults', run: testLoadConfigFromPathBootstrapsMissingConfig },
    { name: 'Config loader bootstraps missing config files without copying config.json5.example', run: testLoadConfigFromPathDoesNotRequireExampleFile },
    { name: 'Config loader defaults legacy Windows configs without useConpty to ConPTY', run: testLoadConfigFromPathDefaultsLegacyMissingUseConpty },
    { name: 'Config loader rejects invalid PTY section shapes', run: testLoadConfigFromPathRejectsInvalidPtyShape },
    { name: 'Config loader normalizes stale Windows PTY fields on non-Windows hosts', run: testLoadConfigFromPathNormalizesNonWindowsPtyFields },
    { name: 'Config loader canonicalizes empty-password bootstrap state from null or missing input', run: testLoadConfigFromPathCanonicalizesEmptyPasswordState },
    { name: 'Config loader still encrypts non-empty plaintext passwords on load', run: testLoadConfigFromPathEncryptsPlaintextPasswordOnLoad },
    { name: 'Config path honors BUILDERGATE_CONFIG_PATH for packaged launchers', run: testGetConfigPathHonorsBuilderGateEnv },
    { name: 'Input reliability mode defaults to observe and warns on unsupported env values', run: testInputReliabilityModeResolution },
    { name: 'Strict config loader rejects invalid existing config without defaults', run: testLoadConfigFromPathStrictRejectsInvalidExistingConfig },
    { name: 'Strict config loader bootstraps missing config without fallback defaults', run: testLoadConfigFromPathStrictBootstrapsMissingConfig },
    { name: 'RuntimeConfigStore builds a redacted editable snapshot', run: testRuntimeConfigSnapshot },
    { name: 'RuntimeConfigStore marks platform capabilities and merges patches', run: testRuntimeConfigCapabilities },
    { name: 'RuntimeConfigStore normalizes platform-specific PTY values in editable snapshots', run: testRuntimeConfigPlatformNormalization },
    { name: 'SessionManager resolves PowerShell backend override without changing non-PowerShell behavior', run: testSessionManagerPowerShellBackendResolution },
    { name: 'SessionManager rejects explicit winpty runtime config when probe fails', run: testSessionManagerWinptyProbeFailure },
    { name: 'SessionManager retries winpty probe after a previous failure', run: testSessionManagerWinptyProbeRetry },
    { name: 'SessionManager.createSession uses resolved backend for PowerShell sessions', run: testSessionManagerCreateSessionUsesResolvedBackend },
    { name: 'SessionManager.createSession normalizes Windows-only shells on non-Windows hosts', run: testSessionManagerCreateSessionNormalizesNonWindowsShell },
    { name: 'SessionManager.createSession falls back when a configured host shell is unavailable', run: testSessionManagerCreateSessionFallsBackWhenConfiguredShellMissing },
    { name: 'SessionManager snapshot metadata stays truthful across backend combinations', run: testSessionManagerSnapshotMetadataTruthfulness },
    { name: 'SessionManager non-Windows runtime validation matches the settings contract', run: testSessionManagerNonWindowsRuntimeValidation },
    { name: 'Password policy enforces FR-AUTH-015 length and character contract', run: testPasswordPolicyContract },
    { name: 'SettingsService hides winpty option after capability probe failure', run: testSettingsServiceWinptyCapabilitySurface },
    { name: 'SettingsService rejects winpty saves immediately after capability probe failure', run: testSettingsServiceRejectsUnavailableWinptySave },
    { name: 'SettingsService rejects useConpty=false saves immediately when winpty is unavailable', run: testSettingsServiceRejectsUnavailableWinptyViaUseConptyFalse },
    { name: 'AuthService.updateRuntimeConfig updates password validation and token duration', run: testAuthRuntimeConfig },
    { name: 'SettingsService rejects unsupported settings keys', run: testSettingsUnsupportedSetting },
    { name: 'SettingsService shell options follow detected host capabilities', run: testSettingsServiceUsesDetectedShellOptions },
    { name: 'SettingsService shell options include WSL-backed bash and sh on Windows hosts', run: testSettingsServiceUsesDetectedWindowsShellOptions },
    { name: 'SettingsService persists editable values and applies runtime updates', run: testSettingsServicePersistence },
    { name: 'SettingsService persists editable values against a legacy pty.maxBufferSize config', run: testSettingsServiceLegacyPtyMigration },
    { name: 'ConfigFileRepository can insert useConpty into legacy config text', run: testConfigFileRepositoryInsertsMissingUseConpty },
    { name: 'ConfigFileRepository can insert missing PTY section for legacy config text', run: testConfigFileRepositoryInsertsMissingPtySection },
    { name: 'SettingsService preserves hidden Windows PTY values on non-Windows unrelated saves', run: testSettingsServicePreservesHiddenWindowsPtyValuesOnNonWindowsSave },
    { name: 'SettingsService reconfigures TOTP runtime and returns warnings on hot apply', run: testSettingsServiceTwoFactorRuntimeHotApply },
    { name: 'SettingsService does not reconfigure TOTP runtime when config persistence fails', run: testSettingsServiceTwoFactorRuntimeNotCalledOnPersistFailure },
    { name: 'SettingsService converts post-save TOTP runtime callback throws into warnings', run: testSettingsServiceTwoFactorRuntimeCallbackFailureWarning },
    { name: 'SettingsService blocks password rotation without current password', run: testSettingsPasswordValidation },
    { name: 'SettingsService rotates password for later logins and persists encrypted secret', run: testSettingsPasswordRotation },
    { name: 'SettingsService rolls back runtime state when apply fails', run: testSettingsApplyFailureRollback },
    { name: 'SessionManager.updateRuntimeConfig affects later idle timers and cached snapshots', run: testSessionManagerRuntimeConfig },
    { name: 'SessionManager WSL shell preserves default bootstrap args', run: testSessionManagerWslBootstrapArgs },
    { name: 'SessionManager bash shell env keeps BASH_ENV bootstrap on Windows hosts', run: testSessionManagerWindowsBashEnvBootstrap },
    { name: 'bash OSC133 hook stays BASH_ENV based and avoids rcfile bootstrap', run: testBashOsc133HookAvoidsRcfileBootstrap },
    { name: 'SessionManager keeps Hermes submit idle in bash heuristic mode', run: testSessionManagerHermesBashSubmitStaysIdle },
    { name: 'SessionManager keeps Codex submit idle in bash heuristic mode', run: testSessionManagerCodexBashSubmitStaysIdle },
    { name: 'SessionManager keeps Claude submit idle in bash heuristic mode', run: testSessionManagerClaudeBashSubmitStaysIdle },
    { name: 'SessionManager keeps Codex typing idle after a prior running misclassification', run: testSessionManagerCodexTypingRestoresIdleAfterRunning },
    { name: 'SessionManager keeps Codex foreground when internal submit resembles AI command', run: testSessionManagerCodexInternalAiCommandSubmitDoesNotStartLaunchAttempt },
    { name: 'SessionManager delays Codex semantic output before promoting to running', run: testSessionManagerCodexSemanticOutputUsesRunningDelay },
    { name: 'SessionManager treats prompt-prefixed Codex semantic output as running candidate', run: testSessionManagerCodexPromptPrefixedSemanticOutputUsesRunningDelay },
    { name: 'SessionManager returns idle and clears hints after Codex launch failure', run: testSessionManagerCodexLaunchFailureReturnsIdleAndClearsHints },
    { name: 'SessionManager does not treat later Codex file-not-found output as launch failure', run: testSessionManagerCodexFileNotFoundAfterLaunchIsNotLaunchFailure },
    { name: 'SessionManager keeps idle when split shell prompt follows Codex launch failure', run: testSessionManagerCodexLaunchFailureSplitPromptStaysIdle },
    { name: 'SessionManager returns to shell prompt after Codex exits before ordinary command', run: testSessionManagerCodexPromptReturnAllowsOrdinaryCommand },
    { name: 'SessionManager keeps echoed Hermes command idle while bootstrapping in bash heuristic mode', run: testSessionManagerHermesBashCommandEchoStaysIdle },
    { name: 'SessionManager keeps Hermes bootstrap output idle in bash heuristic mode', run: testSessionManagerHermesBashBootstrapStaysIdle },
    { name: 'SessionManager delays Hermes detector semantic output before promoting to running', run: testSessionManagerHermesBashSemanticOutputUsesRunningDelay },
    { name: 'SessionManager returns idle and clears hints when Hermes launch fails in bash heuristic mode', run: testSessionManagerHermesBashLaunchFailureReturnsIdle },
    { name: 'SessionManager keeps ordinary bash commands on the existing running to idle path', run: testSessionManagerOrdinaryBashCommandKeepsLegacyFlow },
    { name: 'SessionManager keeps Hermes submit idle in zsh heuristic mode', run: testSessionManagerHermesZshSubmitStaysIdle },
    { name: 'SessionManager ignores stale cwd prompt refresh while Hermes foreground launch is active', run: testSessionManagerIgnoresStaleCwdPromptRefreshDuringHermesLaunch },
    { name: 'SessionManager returns to shell prompt idle after Hermes zsh session completes', run: testSessionManagerHermesZshPromptReturnRestoresShellPrompt },
    { name: 'SessionManager keeps PowerShell prompt redraw idle in heuristic mode', run: testSessionManagerPowerShellPromptRedrawStaysIdle },
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
    { name: 'internal shutdown route is disabled outside production daemon app child', run: testInternalShutdownRouteDisabledOutsideDaemonApp },
    { name: 'internal shutdown route rejects missing token and forwarded-loopback spoofing', run: testInternalShutdownRouteAuthAndLoopbackGuard },
    { name: 'internal shutdown route flushes and returns structured shutdown result', run: testInternalShutdownRouteSuccess },
    { name: 'internal shutdown route returns 500 when graceful shutdown fails', run: testInternalShutdownRouteFailure },
    { name: 'performGracefulShutdown flushes workspace JSON lastUpdated and tab lastCwd', run: testPerformGracefulShutdownFlushesWorkspaceCwds },
    { name: 'sessionRoutes accepts shells surfaced by GET /api/sessions/shells', run: testSessionRoutesAcceptSurfacedShells },
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
    { name: 'WsRouter starts repair replay without geometry change', run: testWsRouterStartsRepairReplayWithoutResize },
    { name: 'WsRouter queues output during repair replay until ACK', run: testWsRouterQueuesOutputDuringRepairReplayUntilAck },
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
    { name: 'TOTPService.initialize() generates secret when Web Crypto global is absent', run: testTOTPInitializeGeneratesSecretWithoutGlobalWebCrypto },
    { name: 'TOTPService.initialize() loads existing secret from file (FR-202)', run: testTOTPInitializeLoadsSecret },
    { name: 'TOTPService.initialize() throws on corrupted secret file (FR-204)', run: testTOTPInitializeThrowsOnCorrupted },
    { name: 'TOTPService.initialize() suppresses console QR while preserving secret and QR API', run: testTOTPInitializeSuppressesConsoleQr },
    { name: 'TOTPService.initialize() surfaces QR rendering failures as startup failures', run: testTOTPInitializeQrRenderingFailureThrows },
    // Phase 4: authRoutes — 4 COMBO flows
    { name: 'reconcileTotpRuntime initializes TOTP on startup when 2FA is enabled', run: testReconcileTotpRuntimeStartupInitialization },
    { name: 'reconcileTotpRuntime keeps the previous registered service on hot-apply failure', run: testReconcileTotpRuntimeKeepsPreviousService },
    { name: 'reconcileTotpRuntime uses daemon env secret path and suppresses app child QR output', run: testReconcileTotpRuntimeUsesDaemonEnvSecretPathAndSuppressesQr },
    { name: 'reconcileTotpRuntime throws on initial startup TOTP failure', run: testReconcileTotpRuntimeInitialStartupFailureThrows },
    { name: 'daemon TOTP preflight prints QR and manual key before detach', run: testDaemonTotpPreflightPrintsQrAndManualKey },
    { name: 'daemon TOTP preflight can suppress QR output for sentinel restarts', run: testDaemonTotpPreflightSuppressesQrForSentinelRestart },
    { name: 'daemon TOTP preflight fails on corrupted and invalid BASE32 secrets', run: testDaemonTotpPreflightRejectsInvalidSecrets },
    { name: 'authRoutes bootstrap-status returns setup-required for localhost when password is missing', run: testAuthRoutesBootstrapStatusLocalhost },
    { name: 'authRoutes bootstrap-status denies remote IPs by default', run: testAuthRoutesBootstrapStatusDeniedRemote },
    { name: 'authRoutes bootstrap-status allows remote IPs from env allowlist', run: testAuthRoutesBootstrapStatusAllowlistEnv },
    { name: 'authRoutes bootstrap-status normalizes IPv4-mapped IPv6 request addresses against allowlists', run: testAuthRoutesBootstrapStatusNormalizesMappedIpv4 },
    { name: 'authRoutes bootstrap-password persists encrypted password and issues JWT', run: testAuthRoutesBootstrapPasswordSuccess },
    { name: 'authRoutes bootstrap-password enforces FR-AUTH-015 policy and preserves exact max input', run: testAuthRoutesBootstrapPasswordEnforcesPolicy },
    { name: 'authRoutes bootstrap-password inserts an auth section when legacy config omits it', run: testAuthRoutesBootstrapPasswordLegacyMissingAuthSection },
    { name: 'authRoutes bootstrap-password closes once a password is configured', run: testAuthRoutesBootstrapPasswordClosedAfterSetup },
    { name: 'authRoutes COMBO-3: TOTP-only login returns 202 with nextStage totp (Phase 4)', run: testAuthRoutesCombo3Login },
    { name: 'authRoutes FR-401: TOTP enabled but unregistered returns 503 (Phase 4)', run: testAuthRoutesUnregisteredTOTP503 },
    { name: 'authRoutes FR-802: stage mismatch returns 400 (Phase 4)', run: testAuthRoutesStageMismatch },
    { name: 'authRoutes COMBO-1: 2FA disabled returns JWT directly (Phase 4)', run: testAuthRoutesCombo1 },
    { name: 'authRoutes localhostPasswordOnly: localhost bypass returns JWT (Phase 4)', run: testAuthRoutesLocalhostBypass },
    { name: 'authRoutes twoFactor.externalOnly: localhost bypass skips TOTP (bugfix)', run: testAuthRoutesExternalOnlyBypass },
    { name: 'authRoutes twoFactor.externalOnly=false: external-only disabled still requires TOTP', run: testAuthRoutesExternalOnlyDisabled },
    { name: 'authRoutes TOTP verify success issues JWT (Phase 4)', run: testAuthRoutesTOTPVerifySuccess },
    { name: 'authRoutes TOTP max attempts returns attemptsRemaining 0 (Phase 4)', run: testAuthRoutesTOTPMaxAttempts },
    { name: 'authRoutes totp-qr reads the latest TOTP runtime instance', run: testAuthRoutesTotpQrLatestRuntime },
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

function testConfigBootstrapAppliesPlatformPtyDefaults(): void {
  const example = `{
  pty: {
    useConpty: false, // neutral example
    windowsPowerShellBackend: "inherit",
    shell: "auto",
  },
}`;

  const windows = applyBootstrapPtyDefaultsToConfigText(example, 'win32');
  assert.match(windows, /useConpty:\s*true,/);
  assert.match(windows, /windowsPowerShellBackend:\s*"inherit",/);
  assert.match(windows, /shell:\s*"auto",/);

  const linux = applyBootstrapPtyDefaultsToConfigText(example, 'linux');
  assert.match(linux, /useConpty:\s*false,/);
  assert.match(linux, /windowsPowerShellBackend:\s*"inherit",/);
  assert.match(linux, /shell:\s*"auto",/);
}

function testNormalizeRawConfigForPlatformNonWindows(): void {
  const rawConfig = {
    server: { port: 2002 },
    pty: {
      useConpty: true,
      windowsPowerShellBackend: 'conpty',
      shell: 'powershell',
    },
  } as Record<string, unknown>;

  const normalized = normalizeRawConfigForPlatform(rawConfig, 'linux');
  const normalizedPty = normalized.pty as Record<string, unknown>;
  const originalPty = rawConfig.pty as Record<string, unknown>;

  assert.equal(normalizedPty.useConpty, false);
  assert.equal(normalizedPty.windowsPowerShellBackend, 'inherit');
  assert.equal(normalizedPty.shell, 'auto');
  assert.equal(originalPty.useConpty, true);
  assert.equal(originalPty.windowsPowerShellBackend, 'conpty');
  assert.equal(originalPty.shell, 'powershell');
}

function testNormalizeRawConfigForPlatformPreservesInvalidPtyShapes(): void {
  const missingPtyConfig = normalizeRawConfigForPlatform({ server: { port: 2002 } }, 'linux');
  assert.deepEqual(missingPtyConfig.pty, {
    useConpty: false,
    windowsPowerShellBackend: 'inherit',
    shell: 'auto',
  });

  for (const invalidPty of [null, [], 'bad']) {
    const normalized = normalizeRawConfigForPlatform({ server: { port: 2002 }, pty: invalidPty }, 'linux');
    assert.deepEqual(normalized.pty, invalidPty);
  }
}

async function testLoadConfigFromPathBootstrapsMissingConfig(): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'buildergate-config-bootstrap-'));
  const configPath = path.join(tempDir, 'config.json5');

  try {
    const winConfig = loadConfigFromPath(configPath, 'win32');
    const createdContent = await fs.readFile(configPath, 'utf-8');
    assert.equal(winConfig.pty.useConpty, true);
    assert.equal(winConfig.pty.windowsPowerShellBackend, 'inherit');
    assert.equal(winConfig.auth?.password, '');
    assert.deepEqual(winConfig.bootstrap?.allowedIps ?? [], []);
    assert.match(createdContent, /useConpty:\s*true,/);
    assert.match(createdContent, /windowsPowerShellBackend:\s*"inherit",/);
    assert.match(createdContent, /password:\s*""/);
    assert.match(createdContent, /allowedIps:\s*\[\]/);
    assert.doesNotMatch(createdContent, /your_password_here/);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function testLoadConfigFromPathDoesNotRequireExampleFile(): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'buildergate-config-built-in-'));
  const configPath = path.join(tempDir, 'config.json5');

  try {
    const loaded = loadConfigFromPath(configPath, 'linux');
    const createdContent = await fs.readFile(configPath, 'utf-8');
    assert.equal(loaded.pty.useConpty, false);
    assert.equal(loaded.auth?.password, '');
    assert.ok(createdContent.length > 0);
    assert.doesNotMatch(createdContent, /config\.json5\.example/);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function testLoadConfigFromPathDefaultsLegacyMissingUseConpty(): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'buildergate-config-legacy-conpty-'));
  const windowsConfigPath = path.join(tempDir, 'config-win.json5');
  const linuxConfigPath = path.join(tempDir, 'config-linux.json5');
  const legacyContent = createMissingUseConptyConfigFixtureContent();
  await fs.writeFile(windowsConfigPath, legacyContent, 'utf-8');
  await fs.writeFile(linuxConfigPath, legacyContent, 'utf-8');

  try {
    const windowsConfig = loadConfigFromPath(windowsConfigPath, 'win32');
    const linuxConfig = loadConfigFromPath(linuxConfigPath, 'linux');

    assert.equal(windowsConfig.pty.useConpty, true);
    assert.equal(windowsConfig.pty.windowsPowerShellBackend, 'inherit');
    assert.equal(linuxConfig.pty.useConpty, false);
    assert.equal(linuxConfig.pty.windowsPowerShellBackend, 'inherit');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function testLoadConfigFromPathNormalizesNonWindowsPtyFields(): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'buildergate-config-normalize-'));
  const configPath = path.join(tempDir, 'config.json5');
  await fs.writeFile(configPath, createLegacyWindowsPtyConfigFixtureContent(), 'utf-8');

  try {
    const config = loadConfigFromPath(configPath, 'linux');
    assert.equal(config.pty.useConpty, false);
    assert.equal(config.pty.windowsPowerShellBackend, 'inherit');
    assert.equal(config.pty.shell, 'auto');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function testLoadConfigFromPathRejectsInvalidPtyShape(): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'buildergate-config-invalid-pty-'));
  const configPath = path.join(tempDir, 'config.json5');
  await fs.writeFile(configPath, `{
  server: { port: 2002 },
  pty: [],
  session: { idleDelayMs: 200 },
}`, 'utf-8');

  try {
    assert.throws(
      () => loadConfigFromPath(configPath, 'linux'),
      /Configuration validation failed/,
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function testLoadConfigFromPathCanonicalizesEmptyPasswordState(): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'buildergate-config-password-empty-'));
  const nullPasswordPath = path.join(tempDir, 'config-null.json5');
  const missingPasswordPath = path.join(tempDir, 'config-missing.json5');

  await fs.writeFile(
    nullPasswordPath,
    createConfigFixtureContent().replace('    password: "old-password",', '    password: null,'),
    'utf-8',
  );
  await fs.writeFile(
    missingPasswordPath,
    createConfigFixtureContent().replace('    password: "old-password",\n', ''),
    'utf-8',
  );

  try {
    const nullPasswordConfig = loadConfigFromPath(nullPasswordPath, 'linux');
    const missingPasswordConfig = loadConfigFromPath(missingPasswordPath, 'linux');

    assert.equal(nullPasswordConfig.auth?.password, '');
    assert.equal(missingPasswordConfig.auth?.password, '');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function testLoadConfigFromPathEncryptsPlaintextPasswordOnLoad(): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'buildergate-config-password-encrypt-'));
  const configPath = path.join(tempDir, 'config.json5');
  await fs.writeFile(configPath, createConfigFixtureContent(), 'utf-8');

  try {
    const loadedConfig = loadConfigFromPath(configPath, 'linux');
    const savedContent = await fs.readFile(configPath, 'utf-8');

    assert.notEqual(loadedConfig.auth?.password, 'old-password');
    assert.match(savedContent, /password:\s*"enc\(/);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function testGetConfigPathHonorsBuilderGateEnv(): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'buildergate-config-path-env-'));
  const configPath = path.join(tempDir, 'config.json5');
  const previousConfigPath = process.env.BUILDERGATE_CONFIG_PATH;

  try {
    process.env.BUILDERGATE_CONFIG_PATH = configPath;
    assert.equal(getConfigPath(), path.resolve(configPath));
  } finally {
    if (previousConfigPath === undefined) {
      delete process.env.BUILDERGATE_CONFIG_PATH;
    } else {
      process.env.BUILDERGATE_CONFIG_PATH = previousConfigPath;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function testInputReliabilityModeResolution(): void {
  const warnings: string[] = [];
  const warn = (message: string) => warnings.push(message);

  assert.equal(resolveInputReliabilityMode(undefined, warn), 'observe');
  assert.equal(resolveInputReliabilityMode('', warn), 'observe');
  assert.equal(resolveInputReliabilityMode('queue', warn), 'queue');
  assert.equal(resolveInputReliabilityMode(' STRICT ', warn), 'strict');
  assert.equal(resolveInputReliabilityMode('unsupported', warn), 'observe');

  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? '', /unsupported/);
  assert.match(warnings[0] ?? '', /observe/);
}

async function testLoadConfigFromPathStrictRejectsInvalidExistingConfig(): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'buildergate-config-strict-invalid-'));
  const configPath = path.join(tempDir, 'config.json5');
  await fs.writeFile(configPath, '{ server: ', 'utf-8');

  try {
    assert.throws(
      () => loadConfigFromPathStrict(configPath, 'linux'),
      /JSON5|invalid|end of input/i,
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function testLoadConfigFromPathStrictBootstrapsMissingConfig(): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'buildergate-config-strict-missing-'));
  const configPath = path.join(tempDir, 'config.json5');

  try {
    const config = loadConfigFromPathStrict(configPath, 'linux');
    const savedContent = await fs.readFile(configPath, 'utf-8');

    assert.equal(config.server.port, 2002);
    assert.match(savedContent, /Initial administrator password/);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function testRuntimeConfigCapabilities(): void {
  const store = new RuntimeConfigStore(createConfigFixture(), 'linux');
  const capabilities = store.getFieldCapabilities();

  assert.equal(capabilities['pty.useConpty'].available, false);
  assert.equal(capabilities['pty.useConpty'].reason, 'Windows-only PTY backend');
  assert.equal(capabilities['pty.windowsPowerShellBackend'].available, false);
  assert.equal(capabilities['pty.windowsPowerShellBackend'].reason, 'Windows-only PowerShell backend override');
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
}

function testRuntimeConfigPlatformNormalization(): void {
  const fixture = createConfigFixture();
  fixture.pty.useConpty = true;
  fixture.pty.windowsPowerShellBackend = 'conpty';
  fixture.pty.shell = 'powershell';

  const store = new RuntimeConfigStore(fixture, 'linux');
  const snapshot = store.getSnapshot();

  assert.equal(snapshot.values.pty.useConpty, false);
  assert.equal(snapshot.values.pty.windowsPowerShellBackend, 'inherit');
  assert.equal(snapshot.values.pty.shell, 'auto');
}

function testPasswordPolicyContract(): void {
  const validCases = [
    'Abc1',
    'Aa1!@#$%^&*()_+=/-',
    'Aa1!'.repeat(32),
  ];
  const invalidCases = [
    'Ab3',
    'Abc1 ',
    'Abc1\t',
    '한글Pass1',
    'Password🙂1',
    'Password?1',
    'A'.repeat(129),
  ];

  for (const password of validCases) {
    assert.equal(validatePasswordPolicy(password).valid, true, `expected valid password: ${password}`);
  }

  for (const password of invalidCases) {
    assert.equal(validatePasswordPolicy(password).valid, false, `expected invalid password: ${password}`);
  }
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

async function testSettingsServiceTwoFactorRuntimeHotApply(): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'buildergate-settings-2fa-hot-apply-'));
  const configPath = path.join(tempDir, 'config.json5');
  await fs.writeFile(configPath, createConfigFixtureContent(), 'utf-8');

  const runtimeCalls: Array<{ enabled: boolean; issuer: string; accountName: string; changedKeys: string[] }> = [];
  const harness = createSettingsHarness({
    configPath,
    updateTwoFactorRuntime: (nextConfig, changedKeys) => {
      runtimeCalls.push({
        enabled: Boolean(nextConfig.twoFactor?.enabled),
        issuer: nextConfig.twoFactor?.issuer ?? '',
        accountName: nextConfig.twoFactor?.accountName ?? '',
        changedKeys: [...changedKeys],
      });
      return ['TOTP secret could not be initialized. QR code is unavailable until the secret is repaired or regenerated.'];
    },
  });

  try {
    const result = harness.settingsService.savePatch({
      twoFactor: {
        enabled: true,
        issuer: 'BuilderGate QA',
        accountName: 'qa-admin',
      },
    });

    assert.equal(runtimeCalls.length, 1, 'TOTP runtime callback should run once');
    assert.deepEqual(runtimeCalls[0]?.changedKeys.sort(), ['twoFactor.accountName', 'twoFactor.enabled', 'twoFactor.issuer']);
    assert.equal(runtimeCalls[0]?.enabled, true);
    assert.equal(runtimeCalls[0]?.issuer, 'BuilderGate QA');
    assert.equal(runtimeCalls[0]?.accountName, 'qa-admin');
    assert.deepEqual(result.applySummary.warnings, [
      'TOTP secret could not be initialized. QR code is unavailable until the secret is repaired or regenerated.',
    ]);
    assert.ok(result.applySummary.new_logins.includes('twoFactor.enabled'));
    assert.ok(result.applySummary.new_logins.includes('twoFactor.issuer'));
    assert.ok(result.applySummary.new_logins.includes('twoFactor.accountName'));
  } finally {
    harness.destroy();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function testSettingsServiceTwoFactorRuntimeNotCalledOnPersistFailure(): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'buildergate-settings-2fa-persist-fail-'));
  const configPath = path.join(tempDir, 'config.json5');
  await fs.writeFile(configPath, createConfigFixtureContent(), 'utf-8');

  const fixture = createConfigFixture();
  const cryptoService = new CryptoService('settings-twofactor-persist-fail');
  const runtimeConfigStore = new RuntimeConfigStore(fixture);
  const authService = new AuthService(fixture.auth!, cryptoService);
  const sessionManager = new SessionManager({ pty: fixture.pty, session: fixture.session });
  const fileService = new FileService({
    getSession: () => ({ id: 'session-1' }),
    getPtyPid: () => null,
    getInitialCwd: () => os.tmpdir(),
    getCwdFilePath: () => null,
  }, fixture.fileManager!);
  const configRepository = new ConfigFileRepository(configPath);
  const originalPersist = configRepository.persistEditableValues.bind(configRepository);
  configRepository.writePreparedResult = () => {
    throw new Error('simulated persist failure');
  };

  let runtimeCalls = 0;
  const settingsService = new SettingsService({
    runtimeConfigStore,
    configRepository,
    cryptoService,
    authService,
    getFileService: () => fileService,
    sessionManager,
    updateTwoFactorRuntime: () => {
      runtimeCalls += 1;
      return [];
    },
  });

  try {
    const originalDuration = authService.getSessionDuration();
    const originalIdleDelay = runtimeConfigStore.getEditableValues().session.idleDelayMs;
    assert.throws(
      () => settingsService.savePatch({
        twoFactor: {
          enabled: true,
          issuer: 'PersistFail',
        },
      }),
      /simulated persist failure/,
    );
    assert.equal(runtimeCalls, 0, 'TOTP runtime callback should not run when config persistence fails');
    assert.equal(authService.getSessionDuration(), originalDuration, 'Auth runtime state should remain unchanged after persist failure');
    assert.equal(runtimeConfigStore.getEditableValues().session.idleDelayMs, originalIdleDelay, 'Runtime config store should remain unchanged after persist failure');

    const dryRun = originalPersist({
      twoFactor: {
        ...fixture.twoFactor!,
        enabled: true,
        issuer: 'PersistFail',
        accountName: 'admin',
      },
      auth: { durationMs: fixture.auth!.durationMs },
      security: { cors: fixture.security!.cors },
      pty: {
        termName: fixture.pty.termName,
        defaultCols: fixture.pty.defaultCols,
        defaultRows: fixture.pty.defaultRows,
        useConpty: fixture.pty.useConpty,
        windowsPowerShellBackend: fixture.pty.windowsPowerShellBackend ?? 'inherit',
        shell: fixture.pty.shell as 'auto' | 'powershell' | 'wsl' | 'bash',
      },
      session: { idleDelayMs: fixture.session.idleDelayMs },
      fileManager: {
        maxFileSize: fixture.fileManager!.maxFileSize,
        maxDirectoryEntries: fixture.fileManager!.maxDirectoryEntries,
        blockedExtensions: fixture.fileManager!.blockedExtensions,
        blockedPaths: fixture.fileManager!.blockedPaths,
        cwdCacheTtlMs: fixture.fileManager!.cwdCacheTtlMs,
      },
    }, {}, { dryRun: true });
    assert.equal(dryRun.nextConfig.twoFactor?.issuer, 'PersistFail');
  } finally {
    authService.destroy();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function testSettingsServiceTwoFactorRuntimeCallbackFailureWarning(): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'buildergate-settings-2fa-callback-fail-'));
  const configPath = path.join(tempDir, 'config.json5');
  await fs.writeFile(configPath, createConfigFixtureContent(), 'utf-8');

  const harness = createSettingsHarness({
    configPath,
    updateTwoFactorRuntime: () => {
      throw new Error('simulated runtime callback failure');
    },
  });

  try {
    const result = harness.settingsService.savePatch({
      twoFactor: {
        enabled: true,
      },
    });

    assert.deepEqual(result.applySummary.warnings, [
      'TOTP runtime refresh failed after saving settings. Restart the server or reapply the 2FA settings.',
    ]);
    assert.equal(harness.runtimeConfigStore.getEditableValues().twoFactor.enabled, true);
  } finally {
    harness.destroy();
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

    assert.throws(
      () => settingsService.savePatch({ auth: { currentPassword: 'old-password' } }),
      (error: unknown) => error instanceof AppError && error.code === ErrorCode.VALIDATION_ERROR,
    );

    assert.throws(
      () => settingsService.savePatch({ auth: { confirmPassword: 'Password?1' } }),
      (error: unknown) => error instanceof AppError && error.code === ErrorCode.CURRENT_PASSWORD_REQUIRED,
    );

    assert.throws(
      () => settingsService.savePatch({ auth: { currentPassword: 'old-password', confirmPassword: 'Password?1' } }),
      (error: unknown) => error instanceof AppError && error.code === ErrorCode.VALIDATION_ERROR,
    );

    for (const newPassword of ['abc', 'new password', '새비밀번호1', 'Password🙂1', 'Password?1', 'A'.repeat(129)]) {
      assert.throws(
        () => settingsService.savePatch({
          auth: {
            currentPassword: 'old-password',
            newPassword,
            confirmPassword: newPassword,
          },
        }),
        (error: unknown) => error instanceof AppError && error.code === ErrorCode.VALIDATION_ERROR,
        `expected settings password policy rejection for ${newPassword}`,
      );
    }

    assert.equal(authService.validatePassword('old-password'), true);
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

function testSessionManagerWslBootstrapArgs(): void {
  const manager = new SessionManager({
    pty: {
      termName: 'xterm-256color',
      defaultCols: 80,
      defaultRows: 24,
      useConpty: true,
      scrollbackLines: 1000,
      maxSnapshotBytes: 1024,
      shell: 'wsl',
    },
    session: {
      idleDelayMs: 200,
    },
  }, {
    platform: 'win32',
  });

  (manager as any).isCommandAvailable = (cmd: string) => cmd === 'wsl.exe';

  const resolved = (manager as any).resolveShell('wsl');
  assert.equal(resolved.shell, 'wsl.exe');
  assert.equal(resolved.shellType, 'bash');
  assert.deepEqual(resolved.args, []);
}

function testSessionManagerWindowsBashEnvBootstrap(): void {
  const manager = new SessionManager({
    pty: {
      termName: 'xterm-256color',
      defaultCols: 80,
      defaultRows: 24,
      useConpty: true,
      scrollbackLines: 1000,
      maxSnapshotBytes: 1024,
      shell: 'bash',
    },
    session: {
      idleDelayMs: 200,
    },
  }, {
    platform: 'win32',
  });

  const env = (manager as any).buildShellEnv('bash');
  assert.ok(typeof env.BASH_ENV === 'string' && env.BASH_ENV.startsWith('/mnt/'));
  assert.equal(env.BUILDERGATE_BASH_RCFILE_MODE, undefined);
  assert.equal(env.BUILDERGATE_BASH_HOOK, undefined);
}

async function testBashOsc133HookAvoidsRcfileBootstrap(): Promise<void> {
  const script = await fs.readFile(path.join(process.cwd(), 'src', 'shell-integration', 'bash-osc133.sh'), 'utf8');
  assert.match(script, /BASH_ENV/u);
  assert.doesNotMatch(script, /BUILDERGATE_BASH_RCFILE_MODE/u);
  assert.doesNotMatch(script, /source \/etc\/profile/u);
  assert.doesNotMatch(script, /source ~\/\.bashrc/u);
}

function createForegroundSessionHarness(
  shell: 'bash' | 'zsh' = 'bash',
  sessionOverrides: { idleDelayMs?: number; runningDelayMs?: number } = {},
) {
  let onDataHandler: ((data: string) => void) | null = null;
  let killCalled = false;
  const manager = new SessionManager({
    pty: {
      termName: 'xterm-256color',
      defaultCols: 80,
      defaultRows: 24,
      useConpty: true,
      scrollbackLines: 1000,
      maxSnapshotBytes: 16,
      shell,
    },
    session: {
      idleDelayMs: 40,
      runningDelayMs: 40,
      ...sessionOverrides,
    },
  }, {
    platform: 'linux',
    spawnPty: ((spawnShell: string, _args: string[], options: { cols?: number; rows?: number; useConpty?: boolean }) => {
      return {
        pid: 1,
        cols: options.cols ?? 80,
        rows: options.rows ?? 24,
        process: spawnShell,
        handleFlowControl: false,
        onData(callback: (data: string) => void) {
          onDataHandler = callback;
          return { dispose() {} };
        },
        onExit() { return { dispose() {} }; },
        write() {},
        resize() {},
        kill() { killCalled = true; },
      } as any;
    }) as any,
  });

  (manager as any).isCommandAvailable = (cmd: string) => {
    if (shell === 'zsh') {
      return cmd === 'zsh' || cmd === 'bash' || cmd === 'sh';
    }
    return cmd === 'bash' || cmd === 'sh';
  };

  const session = manager.createSession('Foreground Session', shell, process.cwd());

  return {
    manager,
    session,
    sessionData: (manager as any).sessions.get(session.id),
    getHandler() {
      if (!onDataHandler) {
        throw new Error('Expected PTY onData handler to be registered');
      }
      return onDataHandler;
    },
    cleanup() {
      assert.equal(manager.deleteSession(session.id), true);
      assert.equal(killCalled, true);
    },
  };
}

async function testSessionManagerHermesBashSubmitStaysIdle(): Promise<void> {
  const harness = createForegroundSessionHarness('bash');

  try {
    harness.manager.writeInput(harness.session.id, '/home/beom/.local/bin/hermes\r');
    await delay(20);

    const status = harness.manager.getSession(harness.session.id)?.status;
    const derivedState = harness.sessionData?.derivedState;
    assert.equal(status, 'idle');
    assert.equal(derivedState?.foregroundAppId, 'hermes');
    assert.equal(derivedState?.activity, 'waiting_input');
  } finally {
    harness.cleanup();
  }
}

async function testSessionManagerCodexBashSubmitStaysIdle(): Promise<void> {
  const harness = createForegroundSessionHarness('bash');

  try {
    harness.manager.writeInput(harness.session.id, 'codex\r');
    await delay(20);

    const status = harness.manager.getSession(harness.session.id)?.status;
    const derivedState = harness.sessionData?.derivedState;
    assert.equal(status, 'idle');
    assert.equal(derivedState?.foregroundAppId, 'codex');
    assert.equal(derivedState?.activity, 'waiting_input');
  } finally {
    harness.cleanup();
  }
}

async function testSessionManagerClaudeBashSubmitStaysIdle(): Promise<void> {
  const harness = createForegroundSessionHarness('bash');

  try {
    harness.manager.writeInput(harness.session.id, '/usr/local/bin/claude\r');
    await delay(20);

    const status = harness.manager.getSession(harness.session.id)?.status;
    const derivedState = harness.sessionData?.derivedState;
    assert.equal(status, 'idle');
    assert.equal(derivedState?.foregroundAppId, 'claude');
    assert.equal(derivedState?.activity, 'waiting_input');
  } finally {
    harness.cleanup();
  }
}

async function testSessionManagerCodexTypingRestoresIdleAfterRunning(): Promise<void> {
  const harness = createForegroundSessionHarness('bash', { idleDelayMs: 200, runningDelayMs: 30 });

  try {
    const handler = harness.getHandler();
    harness.manager.writeInput(harness.session.id, 'codex\r');
    handler('semantic agent output\r\n');
    await delay(60);
    assert.equal(harness.manager.getSession(harness.session.id)?.status, 'running');

    harness.manager.writeInput(harness.session.id, 'h');
    await delay(10);
    assert.equal(harness.manager.getSession(harness.session.id)?.status, 'idle');

    handler('\x1b[24;1Hh');
    await delay(60);
    assert.equal(harness.manager.getSession(harness.session.id)?.status, 'idle');
    assert.equal(harness.sessionData?.derivedState?.foregroundAppId, 'codex');
  } finally {
    harness.cleanup();
  }
}

async function testSessionManagerCodexInternalAiCommandSubmitDoesNotStartLaunchAttempt(): Promise<void> {
  const harness = createForegroundSessionHarness('bash', { idleDelayMs: 200, runningDelayMs: 30 });

  try {
    const handler = harness.getHandler();
    harness.manager.writeInput(harness.session.id, 'codex\r');
    handler('OpenAI Codex\r\n');
    await delay(10);
    assert.equal(harness.sessionData?.derivedState?.foregroundAppId, 'codex');
    assert.equal(harness.sessionData?.aiTuiLaunchAttempt, undefined);

    harness.manager.writeInput(harness.session.id, 'claude\r');
    await delay(10);
    assert.equal(harness.manager.getSession(harness.session.id)?.status, 'idle');
    assert.equal(harness.sessionData?.derivedState?.foregroundAppId, 'codex');
    assert.equal(harness.sessionData?.pendingForegroundAppHint, undefined);
    assert.equal(harness.sessionData?.aiTuiLaunchAttempt, undefined);

    handler('/bin/bash: claude: command not found\r\n');
    await delay(60);
    assert.equal(harness.manager.getSession(harness.session.id)?.status, 'running');
    assert.equal(harness.sessionData?.derivedState?.foregroundAppId, 'codex');
  } finally {
    harness.cleanup();
  }
}

async function testSessionManagerCodexSemanticOutputUsesRunningDelay(): Promise<void> {
  const harness = createForegroundSessionHarness('bash', { idleDelayMs: 200, runningDelayMs: 40 });

  try {
    const handler = harness.getHandler();
    harness.manager.writeInput(harness.session.id, 'codex\r');
    handler('Running shell command npm test\r\nCollecting results\r\n');
    await delay(20);
    assert.equal(harness.manager.getSession(harness.session.id)?.status, 'idle');

    await delay(50);
    assert.equal(harness.manager.getSession(harness.session.id)?.status, 'running');
  } finally {
    harness.cleanup();
  }
}

async function testSessionManagerCodexPromptPrefixedSemanticOutputUsesRunningDelay(): Promise<void> {
  for (const output of [
    '│ Running shell command npm test\r\n',
    '> Running shell command npm test\r\n',
    '│ > Running shell command npm test\r\n',
  ]) {
    const harness = createForegroundSessionHarness('bash', { idleDelayMs: 200, runningDelayMs: 40 });

    try {
      const handler = harness.getHandler();
      harness.manager.writeInput(harness.session.id, 'codex\r');
      handler(output);
      await delay(20);
      assert.equal(harness.manager.getSession(harness.session.id)?.status, 'idle');

      await delay(50);
      assert.equal(harness.manager.getSession(harness.session.id)?.status, 'running');
    } finally {
      harness.cleanup();
    }
  }
}

async function testSessionManagerCodexLaunchFailureReturnsIdleAndClearsHints(): Promise<void> {
  const harness = createForegroundSessionHarness('bash', { idleDelayMs: 40, runningDelayMs: 30 });

  try {
    const handler = harness.getHandler();
    harness.manager.writeInput(harness.session.id, 'codex\r');
    handler('beom@host:/tmp$ codex\r\n');
    await delay(10);
    handler('/bin/bash: codex: command not found\r\n');
    await delay(80);

    assert.equal(harness.manager.getSession(harness.session.id)?.status, 'idle');
    assert.equal(harness.sessionData?.pendingForegroundAppHint, undefined);
    assert.equal(harness.sessionData?.aiTuiLaunchAttempt, undefined);
    assert.equal(harness.sessionData?.lastSubmittedCommand, undefined);
    assert.equal(harness.sessionData?.derivedState?.foregroundAppId, undefined);
  } finally {
    harness.cleanup();
  }
}

async function testSessionManagerCodexFileNotFoundAfterLaunchIsNotLaunchFailure(): Promise<void> {
  const harness = createForegroundSessionHarness('bash', { idleDelayMs: 200, runningDelayMs: 30 });

  try {
    const handler = harness.getHandler();
    harness.manager.writeInput(harness.session.id, 'codex\r');
    handler('OpenAI Codex\r\n');
    await delay(10);
    assert.equal(harness.manager.getSession(harness.session.id)?.status, 'idle');
    assert.equal(harness.sessionData?.aiTuiLaunchAttempt, undefined);

    handler('codex: file not found while reading docs/missing.md\r\n');
    await delay(60);

    assert.equal(harness.manager.getSession(harness.session.id)?.status, 'running');
    assert.equal(harness.sessionData?.derivedState?.foregroundAppId, 'codex');
    assert.equal(harness.sessionData?.aiTuiLaunchAttempt, undefined);
  } finally {
    harness.cleanup();
  }
}

async function testSessionManagerCodexLaunchFailureSplitPromptStaysIdle(): Promise<void> {
  const harness = createForegroundSessionHarness('bash', { idleDelayMs: 40, runningDelayMs: 30 });

  try {
    const handler = harness.getHandler();
    harness.manager.writeInput(harness.session.id, 'codex\r');
    handler('/bin/bash: codex: command not found\r\n');
    await delay(20);
    assert.equal(harness.manager.getSession(harness.session.id)?.status, 'idle');
    assert.equal(harness.sessionData?.derivedState?.ownership, 'shell_prompt');
    assert.equal(harness.sessionData?.expectShellPromptAfterAiTuiFailure, true);

    handler('beom@host:/tmp$ ');
    await delay(60);

    assert.equal(harness.manager.getSession(harness.session.id)?.status, 'idle');
    assert.equal(harness.sessionData?.derivedState?.ownership, 'shell_prompt');
    assert.equal(harness.sessionData?.derivedState?.foregroundAppId, undefined);
    assert.equal(harness.sessionData?.expectShellPromptAfterAiTuiFailure, undefined);
  } finally {
    harness.cleanup();
  }
}

async function testSessionManagerCodexPromptReturnAllowsOrdinaryCommand(): Promise<void> {
  const harness = createForegroundSessionHarness('bash', { idleDelayMs: 80, runningDelayMs: 30 });

  try {
    const handler = harness.getHandler();
    harness.manager.writeInput(harness.session.id, 'codex\r');
    handler('OpenAI Codex\r\n');
    await delay(10);
    assert.equal(harness.manager.getSession(harness.session.id)?.status, 'idle');
    assert.equal(harness.sessionData?.derivedState?.foregroundAppId, 'codex');

    handler('beom@host:/tmp$ ');
    await delay(10);
    assert.equal(harness.manager.getSession(harness.session.id)?.status, 'idle');
    assert.equal(harness.sessionData?.derivedState?.ownership, 'shell_prompt');
    assert.equal(harness.sessionData?.derivedState?.foregroundAppId, undefined);

    harness.manager.writeInput(harness.session.id, 'ls\r');
    assert.equal(harness.manager.getSession(harness.session.id)?.status, 'running');
  } finally {
    harness.cleanup();
  }
}

async function testSessionManagerHermesBashCommandEchoStaysIdle(): Promise<void> {
  const harness = createForegroundSessionHarness('bash');

  try {
    const handler = harness.getHandler();
    harness.manager.writeInput(harness.session.id, '/home/beom/.local/bin/hermes\r');
    handler('beom@host:/tmp$ /home/beom/.local/bin/hermes\r\n');
    await delay(80);

    const status = harness.manager.getSession(harness.session.id)?.status;
    const derivedState = harness.sessionData?.derivedState;
    assert.equal(status, 'idle');
    assert.equal(derivedState?.foregroundAppId, 'hermes');
    assert.equal(derivedState?.activity, 'waiting_input');
  } finally {
    harness.cleanup();
  }
}

async function testSessionManagerHermesBashBootstrapStaysIdle(): Promise<void> {
  const harness = createForegroundSessionHarness('bash');

  try {
    const handler = harness.getHandler();
    harness.manager.writeInput(harness.session.id, '/home/beom/.local/bin/hermes\r');
    handler('\x1b[38;5;230mWelcome to Hermes Agent! Type your message or /help for commands.\r\n\x1b[38;5;136m✦ Tip: use /help for commands.\r');
    await delay(80);

    const status = harness.manager.getSession(harness.session.id)?.status;
    const derivedState = harness.sessionData?.derivedState;
    assert.equal(status, 'idle');
    assert.equal(derivedState?.foregroundAppId, 'hermes');
    assert.equal(derivedState?.activity, 'waiting_input');
  } finally {
    harness.cleanup();
  }
}

async function testSessionManagerHermesBashSemanticOutputUsesRunningDelay(): Promise<void> {
  const harness = createForegroundSessionHarness('bash', { idleDelayMs: 200, runningDelayMs: 60 });

  try {
    const handler = harness.getHandler();
    harness.manager.writeInput(harness.session.id, '/home/beom/.local/bin/hermes\r');
    handler('Welcome to Hermes Agent! Type your message or /help for commands.\r\n');
    await delay(10);
    assert.equal(harness.manager.getSession(harness.session.id)?.status, 'idle');

    handler('tool: web_search\r\n');
    await delay(50);
    assert.equal(harness.manager.getSession(harness.session.id)?.status, 'idle');

    handler('result: fetched 3 documents\r\n');
    await delay(40);

    const status = harness.manager.getSession(harness.session.id)?.status;
    const derivedState = harness.sessionData?.derivedState;
    assert.equal(status, 'running');
    assert.equal(derivedState?.activity, 'busy');
  } finally {
    harness.cleanup();
  }
}

async function testSessionManagerHermesBashLaunchFailureReturnsIdle(): Promise<void> {
  const harness = createForegroundSessionHarness('bash');

  try {
    const handler = harness.getHandler();
    harness.manager.writeInput(harness.session.id, 'hermes\r');
    handler('/bin/bash: hermes: command not found\r\n');
    await delay(80);

    const status = harness.manager.getSession(harness.session.id)?.status;
    const derivedState = harness.sessionData?.derivedState;
    assert.equal(status, 'idle');
    assert.equal(derivedState?.foregroundAppId, undefined);
    assert.equal(derivedState?.detectorId, undefined);
    assert.equal(harness.sessionData?.pendingForegroundAppHint, undefined);
    assert.equal(harness.sessionData?.aiTuiLaunchAttempt, undefined);
    assert.equal(harness.sessionData?.lastSubmittedCommand, undefined);
  } finally {
    harness.cleanup();
  }
}

async function testSessionManagerOrdinaryBashCommandKeepsLegacyFlow(): Promise<void> {
  const harness = createForegroundSessionHarness('bash');

  try {
    const handler = harness.getHandler();
    harness.manager.writeInput(harness.session.id, 'ls\r');
    assert.equal(harness.manager.getSession(harness.session.id)?.status, 'running');

    handler('file-a\r\nfile-b\r\n');
    await delay(80);
    assert.equal(harness.manager.getSession(harness.session.id)?.status, 'idle');
  } finally {
    harness.cleanup();
  }
}

async function testSessionManagerHermesZshSubmitStaysIdle(): Promise<void> {
  const harness = createForegroundSessionHarness('zsh');

  try {
    harness.manager.writeInput(harness.session.id, 'hermes\r');
    await delay(20);

    const status = harness.manager.getSession(harness.session.id)?.status;
    const derivedState = harness.sessionData?.derivedState;
    assert.equal(status, 'idle');
    assert.equal(derivedState?.foregroundAppId, 'hermes');
    assert.equal(derivedState?.activity, 'waiting_input');
  } finally {
    harness.cleanup();
  }
}

async function testSessionManagerIgnoresStaleCwdPromptRefreshDuringHermesLaunch(): Promise<void> {
  const harness = createForegroundSessionHarness('zsh');

  try {
    const cwdFilePath = harness.sessionData?.cwdFilePath;
    if (!cwdFilePath) {
      throw new Error('Expected cwdFilePath to be registered');
    }
    await fs.writeFile(cwdFilePath, process.cwd(), 'utf8');

    harness.manager.writeInput(harness.session.id, 'hermes\r');
    await delay(1200);

    const status = harness.manager.getSession(harness.session.id)?.status;
    const derivedState = harness.sessionData?.derivedState;
    assert.equal(status, 'idle');
    assert.equal(derivedState?.foregroundAppId, 'hermes');
    assert.equal(derivedState?.activity, 'waiting_input');
  } finally {
    harness.cleanup();
  }
}

async function testSessionManagerHermesZshPromptReturnRestoresShellPrompt(): Promise<void> {
  const harness = createForegroundSessionHarness('zsh');

  try {
    harness.manager.writeInput(harness.session.id, 'hermes\r');
    await delay(20);
    const cwdFilePath = harness.sessionData?.cwdFilePath;
    if (!cwdFilePath) {
      throw new Error('Expected cwdFilePath to be registered');
    }
    await fs.writeFile(cwdFilePath, process.cwd(), 'utf8');
    await delay(1200);

    const status = harness.manager.getSession(harness.session.id)?.status;
    const derivedState = harness.sessionData?.derivedState;
    assert.equal(status, 'idle');
    assert.equal(derivedState?.ownership, 'shell_prompt');
    assert.equal(derivedState?.foregroundAppId, undefined);
  } finally {
    harness.cleanup();
  }
}

async function testSessionManagerPowerShellPromptRedrawStaysIdle(): Promise<void> {
  let onDataHandler: ((data: string) => void) | null = null;
  let killCalled = false;
  const manager = new SessionManager({
    pty: {
      termName: 'xterm-256color',
      defaultCols: 80,
      defaultRows: 24,
      useConpty: true,
      windowsPowerShellBackend: 'conpty',
      scrollbackLines: 1000,
      maxSnapshotBytes: 16,
      shell: 'powershell',
    },
    session: {
      idleDelayMs: 40,
    },
  }, {
    execFileSyncFn: (() => Buffer.from('')) as any,
    platform: 'win32',
    spawnPty: ((_: string, __: string[], options: { cols?: number; rows?: number; useConpty?: boolean }) => {
      return {
        pid: 1,
        cols: options.cols ?? 80,
        rows: options.rows ?? 24,
        process: 'powershell.exe',
        handleFlowControl: false,
        onData(callback: (data: string) => void) {
          onDataHandler = callback;
          return { dispose() {} };
        },
        onExit() { return { dispose() {} }; },
        write() {},
        resize() {},
        kill() { killCalled = true; },
      } as any;
    }) as any,
  });

  const session = manager.createSession('Prompt Redraw', 'powershell', 'C:\\Users\\beom');

  try {
    const handler = onDataHandler as ((data: string) => void) | null;
    if (!handler) {
      throw new Error('Expected PTY onData handler to be registered');
    }
    handler('\x1b[?25l\x1b[8;70;225t\x1b[HPS C:\\Users\\beom>\x1b[K\r\n\x1b[K\r\n\x1b[K');
    await delay(20);

    assert.equal(manager.getSession(session.id)?.status, 'idle');
  } finally {
    assert.equal(manager.deleteSession(session.id), true);
    assert.equal(killCalled, true);
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

function testSessionManagerCreateSessionNormalizesNonWindowsShell(): void {
  let observedShell = '';
  let killCalled = false;
  const manager = new SessionManager({
    pty: {
      termName: 'xterm-256color',
      defaultCols: 80,
      defaultRows: 24,
      useConpty: true,
      windowsPowerShellBackend: 'conpty',
      scrollbackLines: 1000,
      maxSnapshotBytes: 1024,
      shell: 'powershell',
    },
    session: {
      idleDelayMs: 200,
    },
  }, {
    execFileSyncFn: (() => Buffer.from('')) as any,
    platform: 'linux',
    spawnPty: ((shell: string, _args: string[], options: { cols?: number; rows?: number; useConpty?: boolean }) => {
      observedShell = shell;
      assert.equal(options.useConpty, false);
      return {
        pid: 1,
        cols: options.cols ?? 80,
        rows: options.rows ?? 24,
        process: shell,
        handleFlowControl: false,
        onData() { return { dispose() {} }; },
        onExit() { return { dispose() {} }; },
        write() {},
        resize() {},
        kill() { killCalled = true; },
      } as any;
    }) as any,
  });

  const session = manager.createSession('Normalized Linux Shell');
  assert.ok(observedShell === 'bash' || observedShell === 'sh');
  assert.equal(manager.deleteSession(session.id), true);
  assert.equal(killCalled, true);
}

function testSessionManagerCreateSessionFallsBackWhenConfiguredShellMissing(): void {
  let observedShell = '';
  let killCalled = false;
  const manager = new SessionManager({
    pty: {
      termName: 'xterm-256color',
      defaultCols: 80,
      defaultRows: 24,
      useConpty: false,
      windowsPowerShellBackend: 'inherit',
      scrollbackLines: 1000,
      maxSnapshotBytes: 1024,
      shell: 'zsh',
    },
    session: {
      idleDelayMs: 200,
    },
  }, {
    execFileSyncFn: (() => Buffer.from('')) as any,
    platform: 'linux',
    spawnPty: ((shell: string, _args: string[], options: { cols?: number; rows?: number; useConpty?: boolean }) => {
      observedShell = shell;
      return {
        pid: 1,
        cols: options.cols ?? 80,
        rows: options.rows ?? 24,
        process: shell,
        handleFlowControl: false,
        onData() { return { dispose() {} }; },
        onExit() { return { dispose() {} }; },
        write() {},
        resize() {},
        kill() { killCalled = true; },
      } as any;
    }) as any,
  });

  const session = manager.createSession('Fallback Linux Shell');
  assert.ok(observedShell === 'bash' || observedShell === 'sh');
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
    assert.equal(snapshot.capabilities['pty.useConpty'].available, true);
    assert.match(snapshot.capabilities['pty.useConpty'].reason ?? '', /winpty/i);
    assert.deepEqual(snapshot.capabilities['pty.windowsPowerShellBackend'].options, ['inherit', 'conpty']);
    assert.match(snapshot.capabilities['pty.windowsPowerShellBackend'].reason ?? '', /winpty/i);
  } finally {
    authService.destroy();
  }
}

async function testSettingsServiceRejectsUnavailableWinptySave(): Promise<void> {
  const fixture = createConfigFixture();
  const cryptoService = new CryptoService('settings-winpty-reject');
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
    assert.throws(
      () => settingsService.savePatch({
        pty: { windowsPowerShellBackend: 'winpty' },
      }),
      (error: unknown) => error instanceof AppError && error.code === ErrorCode.VALIDATION_ERROR,
    );
  } finally {
    authService.destroy();
  }
}

async function testSettingsServiceRejectsUnavailableWinptyViaUseConptyFalse(): Promise<void> {
  const fixture = createConfigFixture();
  const cryptoService = new CryptoService('settings-winpty-useconpty-false');
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
    assert.throws(
      () => settingsService.savePatch({
        pty: { useConpty: false },
      }),
      (error: unknown) => error instanceof AppError && error.code === ErrorCode.VALIDATION_ERROR,
    );
  } finally {
    authService.destroy();
  }
}

function testSettingsServiceUsesDetectedShellOptions(): void {
  const fixture = createConfigFixture();
  fixture.pty.shell = 'zsh';
  const harness = createSettingsHarness({ fixture, platform: 'linux' });

  try {
    (harness.sessionManager as any).cachedAvailableShells = [
      { id: 'bash', label: 'Bash', icon: '🐚' },
      { id: 'sh', label: 'Shell (sh)', icon: '⚡' },
    ];

    const snapshot = harness.settingsService.getSettingsSnapshot();
    assert.deepEqual(snapshot.capabilities['pty.shell'].options, ['auto', 'bash', 'sh']);
    assert.equal(snapshot.values.pty.shell, 'auto');
  } finally {
    harness.destroy();
  }
}

function testSettingsServiceUsesDetectedWindowsShellOptions(): void {
  const fixture = createConfigFixture();
  const harness = createSettingsHarness({ fixture, platform: 'win32' });

  try {
    (harness.sessionManager as any).cachedAvailableShells = [
      { id: 'powershell', label: 'PowerShell', icon: '💙' },
      { id: 'cmd', label: 'Command Prompt', icon: '⬛' },
      { id: 'wsl', label: 'WSL (Bash)', icon: '🐧' },
      { id: 'bash', label: 'Bash (WSL)', icon: '🐚' },
      { id: 'sh', label: 'Shell (WSL sh)', icon: '⚡' },
      { id: 'zsh', label: 'WSL (Zsh)', icon: '🔮' },
    ];

    const snapshot = harness.settingsService.getSettingsSnapshot();
    assert.deepEqual(snapshot.capabilities['pty.shell'].options, ['auto', 'powershell', 'cmd', 'wsl', 'bash', 'sh', 'zsh']);
  } finally {
    harness.destroy();
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
    manager.writeInput(harness.sessionId, '가나다', {
      captureSeq: 7,
      clientObservedByteLength: 9,
      clientObservedCodePointCount: 3,
      clientObservedGraphemeCount: 3,
      clientObservedGraphemeApproximate: false,
      clientObservedHasHangul: true,
      clientObservedHasCjk: false,
      clientObservedHasEnter: false,
      inputClass: 'leak-attempt',
      unsafe: 'raw-text',
    } as any);
    manager.writeInput(harness.sessionId, '가\r');

    const inputEvents = manager.getDebugCapture(harness.sessionId).filter((event) => event.kind === 'input');
    assert.equal(inputEvents.length, 3);

    assert.equal(inputEvents[0]?.details?.byteLength, 3);
    assert.equal(inputEvents[0]?.details?.codePointCount, 3);
    assert.equal(inputEvents[0]?.details?.hasEnter, true);
    assert.equal(inputEvents[0]?.details?.spaceCount, 1);
    assert.equal(inputEvents[0]?.details?.backspaceCount, 1);
    assert.equal(inputEvents[0]?.details?.enterCount, 1);
    assert.equal(inputEvents[0]?.details?.escapeCount, 0);
    assert.equal(inputEvents[0]?.details?.controlCount, 2);
    assert.equal(inputEvents[0]?.details?.printableCount, 1);
    assert.equal(inputEvents[0]?.details?.inputClass, 'safe-control');
    assert.equal(inputEvents[0]?.details?.safePreview, true);
    assert.equal(inputEvents[0]?.preview, '␠\\r\\x7f');

    assert.equal(inputEvents[1]?.details?.captureSeq, 7);
    assert.equal(inputEvents[1]?.details?.clientObservedByteLength, 9);
    assert.equal(inputEvents[1]?.details?.clientObservedHasHangul, true);
    assert.equal(inputEvents[1]?.details?.byteLength, 9);
    assert.equal(inputEvents[1]?.details?.codePointCount, 3);
    assert.equal(inputEvents[1]?.details?.graphemeCount, 3);
    assert.equal(inputEvents[1]?.details?.hasHangul, true);
    assert.equal(inputEvents[1]?.details?.hasEnter, false);
    assert.equal(inputEvents[1]?.details?.inputClass, 'printable');
    assert.equal(inputEvents[1]?.details?.safePreview, false);
    assert.equal(inputEvents[1]?.preview, undefined);
    assert.equal((inputEvents[1]?.details as Record<string, unknown>)?.unsafe, undefined);

    assert.equal(inputEvents[2]?.details?.byteLength, 4);
    assert.equal(inputEvents[2]?.details?.hasHangul, true);
    assert.equal(inputEvents[2]?.details?.hasEnter, true);
    assert.equal(inputEvents[2]?.details?.inputClass, 'mixed-printable-control');
    assert.equal(inputEvents[2]?.details?.safePreview, false);
    assert.equal(inputEvents[2]?.preview, undefined);
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

async function invokeInternalShutdownRoute(options: {
  env?: NodeJS.ProcessEnv;
  token?: string;
  headerToken?: string;
  forwardedFor?: string;
  remoteAddress?: string;
  performShutdown?: () => Promise<Record<string, unknown>>;
  scheduleExitDelayMs?: number;
  onExit?: (code: number) => void;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  const app = express();
  app.use(express.json());
  app.use('/api/internal', createInternalShutdownRoutes({
    env: options.env ?? {
      NODE_ENV: 'production',
      BUILDERGATE_INTERNAL_MODE: 'app',
      BUILDERGATE_SHUTDOWN_TOKEN: options.token ?? 'shutdown-token',
    },
    token: options.token ?? 'shutdown-token',
    performShutdown: options.performShutdown ?? (async () => ({ ok: true, reason: 'test' })),
    getRemoteAddress: () => options.remoteAddress ?? '127.0.0.1',
    scheduleExitDelayMs: options.scheduleExitDelayMs ?? 1,
    exit: options.onExit ?? (() => {}),
  }));

  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const port = (server.address() as net.AddressInfo).port;
      const postBody = JSON.stringify({});
      const headers: Record<string, string | number> = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postBody),
      };
      if (options.headerToken !== undefined) {
        headers['X-BuilderGate-Shutdown-Token'] = options.headerToken;
      }
      if (options.forwardedFor !== undefined) {
        headers['X-Forwarded-For'] = options.forwardedFor;
      }

      const request = http.request({
        hostname: '127.0.0.1',
        port,
        method: 'POST',
        path: '/api/internal/shutdown',
        headers,
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          server.close();
          try {
            const payload = Buffer.concat(chunks).toString();
            let body: Record<string, unknown> = {};
            if (payload) {
              try {
                body = JSON.parse(payload) as Record<string, unknown>;
              } catch {
                body = { raw: payload };
              }
            }
            resolve({
              status: res.statusCode ?? 0,
              body,
            });
          } catch (error) {
            reject(error);
          }
        });
      });
      request.on('error', (error: Error) => {
        server.close();
        reject(error);
      });
      request.write(postBody);
      request.end();
    });
  });
}

async function testInternalShutdownRouteDisabledOutsideDaemonApp(): Promise<void> {
  const result = await invokeInternalShutdownRoute({
    token: 'secret',
    headerToken: 'secret',
    env: {
      NODE_ENV: 'development',
      BUILDERGATE_INTERNAL_MODE: 'app',
      BUILDERGATE_SHUTDOWN_TOKEN: 'secret',
    },
  });

  assert.equal(result.status, 404);
}

async function testInternalShutdownRouteAuthAndLoopbackGuard(): Promise<void> {
  const missingToken = await invokeInternalShutdownRoute({
    token: 'secret',
    remoteAddress: '127.0.0.1',
  });
  const forwardedSpoof = await invokeInternalShutdownRoute({
    token: 'secret',
    headerToken: 'secret',
    remoteAddress: '192.168.0.10',
    forwardedFor: '127.0.0.1',
  });

  assert.equal(missingToken.status, 401);
  assert.equal((missingToken.body.error as { code?: string })?.code, 'INVALID_SHUTDOWN_TOKEN');
  assert.equal(forwardedSpoof.status, 403);
  assert.equal((forwardedSpoof.body.error as { code?: string })?.code, 'LOCALHOST_ONLY');
}

async function testInternalShutdownRouteSuccess(): Promise<void> {
  const exits: number[] = [];
  let flushed = false;
  const result = await invokeInternalShutdownRoute({
    token: 'secret',
    headerToken: 'secret',
    scheduleExitDelayMs: 0,
    onExit: (code) => exits.push(code),
    performShutdown: async () => {
      flushed = true;
      return {
        ok: true,
        reason: 'internal-shutdown',
        workspaceFlushed: true,
        workspaceDataPath: 'C:/runtime/workspaces.json',
        workspaceLastUpdated: '2026-04-27T00:00:12.000Z',
        workspaceLastCwdCount: 1,
        workspaceTabCount: 1,
        workspaceFlushMarker: '[Shutdown] Workspace state + CWDs saved',
      };
    },
  });
  await delay(5);

  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.reason, 'internal-shutdown');
  assert.equal(result.body.workspaceFlushed, true);
  assert.equal(result.body.workspaceFlushMarker, '[Shutdown] Workspace state + CWDs saved');
  assert.equal(flushed, true);
  assert.deepEqual(exits, [0]);
}

async function testInternalShutdownRouteFailure(): Promise<void> {
  const result = await invokeInternalShutdownRoute({
    token: 'secret',
    headerToken: 'secret',
    performShutdown: async () => {
      throw new Error('flush failed');
    },
  });

  assert.equal(result.status, 500);
  assert.equal(result.body.ok, false);
  assert.equal((result.body.error as { code?: string })?.code, 'SHUTDOWN_FAILED');
  assert.match(String((result.body.error as { message?: string })?.message ?? ''), /flush failed/);
}

async function testPerformGracefulShutdownFlushesWorkspaceCwds(): Promise<void> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'buildergate-graceful-shutdown-'));
  const cwdFilePath = path.join(tmpDir, 'cwd.txt');
  const workspaceFilePath = path.join(tmpDir, 'workspaces.json');
  const cwd = path.join(tmpDir, 'project');
  const events: string[] = [];
  await fs.writeFile(cwdFilePath, cwd, 'utf-8');

  const sessionManagerStub = {
    onCwdChange() {},
    stopAllCwdWatching() {
      events.push('stop-watchers');
    },
    getCwdFilePath(sessionId: string) {
      assert.equal(sessionId, 'session-1');
      return cwdFilePath;
    },
    getLastCwd() {
      return null;
    },
  } as unknown as SessionManager;
  const workspaceService = new WorkspaceService(sessionManagerStub);
  (workspaceService as any).dataFilePath = workspaceFilePath;
  (workspaceService as any).state = {
    workspaces: [{
      id: 'workspace-1',
      name: 'Workspace',
      sortOrder: 0,
      viewMode: 'tab',
      activeTabId: 'tab-1',
      colorCounter: 0,
      createdAt: '2026-04-27T00:00:00.000Z',
      updatedAt: '2026-04-27T00:00:00.000Z',
    }],
    tabs: [{
      id: 'tab-1',
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      name: 'Terminal',
      colorIndex: 0,
      sortOrder: 0,
      shellType: 'auto',
      createdAt: '2026-04-27T00:00:00.000Z',
    }],
    gridLayouts: [],
  };

  try {
    const result = await performGracefulShutdown('test', {
      sessionManager: sessionManagerStub,
      workspaceService,
    });
    const file = JSON.parse(await fs.readFile(workspaceFilePath, 'utf-8')) as {
      lastUpdated?: string;
      state?: { tabs?: Array<{ lastCwd?: string }> };
    };

    assert.equal(result.ok, true);
    assert.equal(result.workspaceFlushed, true);
    assert.equal(result.workspaceDataPath, workspaceFilePath);
    assert.equal(result.workspaceLastUpdated, file.lastUpdated);
    assert.equal(result.workspaceLastCwdCount, 1);
    assert.equal(result.workspaceTabCount, 1);
    assert.equal(result.workspaceFlushMarker, '[Shutdown] Workspace state + CWDs saved');
    assert.deepEqual(events, ['stop-watchers']);
    assert.equal(typeof file.lastUpdated, 'string');
    assert.equal(file.state?.tabs?.[0]?.lastCwd, cwd);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

async function testSessionRoutesAcceptSurfacedShells(): Promise<void> {
  const originalCreateSession = sessionManager.createSession.bind(sessionManager);
  const originalCachedShells = (sessionManager as any).cachedAvailableShells;

  (sessionManager as any).cachedAvailableShells = [
    { id: 'powershell', label: 'PowerShell', icon: '💙' },
    { id: 'cmd', label: 'Command Prompt', icon: '⬛' },
    { id: 'bash', label: 'Bash (WSL)', icon: '🐚' },
    { id: 'sh', label: 'Shell (WSL sh)', icon: '⚡' },
    { id: 'zsh', label: 'WSL (Zsh)', icon: '🔮' },
  ];
  (sessionManager as any).createSession = (name?: string, shell?: string, cwd?: string) => ({
    id: 'session-route-test',
    name: name || 'Session',
    status: 'idle',
    createdAt: new Date(),
    lastActiveAt: new Date(),
    sortOrder: 0,
    shellType: shell,
    cwd,
  });

  try {
    const app = express();
    app.use(express.json());
    app.use('/api/sessions', sessionRoutes);

    const response = await new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
      const server = http.createServer(app);
      server.listen(0, () => {
        const port = (server.address() as net.AddressInfo).port;
        const postBody = JSON.stringify({ shell: 'sh' });
        const options = {
          hostname: '127.0.0.1',
          port,
          method: 'POST',
          path: '/api/sessions',
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
              const payload = Buffer.concat(chunks).toString();
              const json = payload ? JSON.parse(payload) as Record<string, unknown> : {};
              resolve({ status: res.statusCode ?? 0, body: json });
            } catch (error) {
              reject(error);
            }
          });
        });
        request.on('error', (error: Error) => {
          server.close();
          reject(error);
        });
        request.write(postBody);
        request.end();
      });
    });

    assert.equal(response.status, 201);
    assert.equal(response.body.id, 'session-route-test');
  } finally {
    (sessionManager as any).createSession = originalCreateSession;
    (sessionManager as any).cachedAvailableShells = originalCachedShells;
  }
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

async function testConfigFileRepositoryInsertsMissingUseConpty(): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'buildergate-settings-missing-conpty-'));
  const configPath = path.join(tempDir, 'config.json5');
  const fixture = createConfigFixture();
  await fs.writeFile(configPath, createMissingUseConptyConfigFixtureContent(), 'utf-8');
  const repository = new ConfigFileRepository(configPath, 'win32');

  try {
    const result = repository.persistEditableValues({
      auth: { durationMs: fixture.auth!.durationMs },
      twoFactor: {
        enabled: fixture.twoFactor?.enabled ?? false,
        externalOnly: fixture.twoFactor?.externalOnly ?? false,
        issuer: fixture.twoFactor?.issuer ?? 'BuilderGate',
        accountName: fixture.twoFactor?.accountName ?? 'admin',
      },
      security: { cors: fixture.security!.cors },
      pty: {
        termName: fixture.pty.termName,
        defaultCols: fixture.pty.defaultCols,
        defaultRows: fixture.pty.defaultRows,
        useConpty: false,
        windowsPowerShellBackend: fixture.pty.windowsPowerShellBackend ?? 'inherit',
        shell: fixture.pty.shell,
      },
      session: { idleDelayMs: fixture.session.idleDelayMs },
      fileManager: {
        maxFileSize: fixture.fileManager!.maxFileSize,
        maxDirectoryEntries: fixture.fileManager!.maxDirectoryEntries,
        blockedExtensions: fixture.fileManager!.blockedExtensions,
        blockedPaths: fixture.fileManager!.blockedPaths,
        cwdCacheTtlMs: fixture.fileManager!.cwdCacheTtlMs,
      },
    }, {}, { dryRun: true, changedKeys: ['pty.useConpty'] });

    assert.equal(result.previousConfig.pty.useConpty, true);
    assert.equal(result.nextConfig.pty.useConpty, false);
    assert.match(result.renderedContent, /useConpty:\s*false,/);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function testConfigFileRepositoryInsertsMissingPtySection(): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'buildergate-settings-missing-pty-'));
  const configPath = path.join(tempDir, 'config.json5');
  const fixture = createConfigFixture();
  await fs.writeFile(configPath, createMissingPtyConfigFixtureContent(), 'utf-8');
  const repository = new ConfigFileRepository(configPath, 'linux');

  try {
    const result = repository.persistEditableValues({
      auth: { durationMs: fixture.auth!.durationMs },
      twoFactor: {
        enabled: fixture.twoFactor?.enabled ?? false,
        externalOnly: fixture.twoFactor?.externalOnly ?? false,
        issuer: fixture.twoFactor?.issuer ?? 'BuilderGate',
        accountName: fixture.twoFactor?.accountName ?? 'admin',
      },
      security: { cors: fixture.security!.cors },
      pty: {
        termName: fixture.pty.termName,
        defaultCols: fixture.pty.defaultCols,
        defaultRows: fixture.pty.defaultRows,
        useConpty: false,
        windowsPowerShellBackend: 'inherit',
        shell: 'bash',
      },
      session: { idleDelayMs: fixture.session.idleDelayMs },
      fileManager: {
        maxFileSize: fixture.fileManager!.maxFileSize,
        maxDirectoryEntries: fixture.fileManager!.maxDirectoryEntries,
        blockedExtensions: fixture.fileManager!.blockedExtensions,
        blockedPaths: fixture.fileManager!.blockedPaths,
        cwdCacheTtlMs: fixture.fileManager!.cwdCacheTtlMs,
      },
    }, {}, { dryRun: true, changedKeys: ['pty.shell'] });

    assert.equal(result.previousConfig.pty.shell, 'auto');
    assert.equal(result.nextConfig.pty.shell, 'bash');
    assert.match(result.renderedContent, /pty:\s*\{[\s\S]*shell:\s*"bash",[\s\S]*\},/);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function testSettingsServicePreservesHiddenWindowsPtyValuesOnNonWindowsSave(): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'buildergate-settings-hidden-pty-'));
  const configPath = path.join(tempDir, 'config.json5');
  const fixture = createConfigFixture();
  await fs.writeFile(configPath, createLegacyWindowsPtyConfigFixtureContent(), 'utf-8');

  const harness = createSettingsHarness({ fixture, configPath, platform: 'linux' });

  try {
    const result = harness.settingsService.savePatch({
      auth: { durationMs: 900000 },
    });

    assert.ok(result.changedKeys.includes('auth.durationMs'));

    const savedContent = await fs.readFile(configPath, 'utf-8');
    assert.match(savedContent, /durationMs:\s*900000/);
    assert.match(savedContent, /useConpty:\s*true/);
    assert.match(savedContent, /windowsPowerShellBackend:\s*"conpty"/);
    assert.match(savedContent, /shell:\s*"powershell"/);
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
    writeInput: [] as Array<{ sessionId: string; data: string; metadata?: unknown }>,
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
    writeInput: (sessionId: string, data: string, metadata?: unknown) => {
      calls.writeInput.push({ sessionId, data, metadata });
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

  (router as any).handleInput(ws, 'session-1', '가\r', {
    captureSeq: 5,
    clientObservedByteLength: 4,
    clientObservedHasHangul: true,
    unsafe: 'raw-text',
  });
  assert.deepEqual(calls.writeInput, []);
  const blockedEvent = router.getObservabilitySnapshot().recentReplayEvents.find((event) => event.kind === 'input_blocked');
  assert.equal(blockedEvent?.details?.captureSeq, 5);
  assert.equal(blockedEvent?.details?.clientObservedByteLength, 4);
  assert.equal(blockedEvent?.details?.byteLength, 4);
  assert.equal(blockedEvent?.details?.hasHangul, true);
  assert.equal(blockedEvent?.details?.hasEnter, true);
  assert.equal(blockedEvent?.details?.inputClass, 'mixed-printable-control');
  assert.equal((blockedEvent?.details as Record<string, unknown>)?.unsafe, undefined);
  assert.doesNotMatch(JSON.stringify(blockedEvent), /가/);

  (router as any).handleScreenSnapshotReady(ws, 'session-1', replayToken);
  (router as any).handleInput(ws, 'session-1', 'allowed');

  assert.deepEqual(calls.writeInput, [{ sessionId: 'session-1', data: 'allowed', metadata: undefined }]);
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

function testWsRouterStartsRepairReplayWithoutResize(): void {
  const { router, ws, sent } = createWsRouterHarness();

  (router as any).handleSubscribe(ws, ['session-1']);
  const subscribeToken = String(sent[0].replayToken);
  (router as any).handleScreenSnapshotReady(ws, 'session-1', subscribeToken);

  const beforeCount = sent.length;
  (router as any).handleRepairReplay(ws, 'session-1');

  assert.equal(sent[beforeCount].type, 'screen-snapshot');
  const repairToken = String(sent[beforeCount].replayToken);
  assert.notEqual(repairToken, subscribeToken);

  const replayEvents = router.getObservabilitySnapshot().recentReplayEvents;
  const repairEvent = replayEvents.find((event) => event.kind === 'snapshot_sent' && event.details?.origin === 'repair');
  assert.ok(repairEvent);

  router.destroy();
}

function testWsRouterQueuesOutputDuringRepairReplayUntilAck(): void {
  const { router, ws, sent } = createWsRouterHarness();

  (router as any).handleSubscribe(ws, ['session-1']);
  const subscribeToken = String(sent[0].replayToken);
  (router as any).handleScreenSnapshotReady(ws, 'session-1', subscribeToken);

  (router as any).handleRepairReplay(ws, 'session-1');
  const repairSnapshotIndex = sent.findIndex((message, index) => index > 0 && message.type === 'screen-snapshot');
  const repairToken = String(sent[repairSnapshotIndex].replayToken);

  router.routeSessionOutput('session-1', 'repair-pending-output');
  const outputsBeforeAck = sent.filter((message) => message.type === 'output');
  assert.equal(outputsBeforeAck.length, 0);

  (router as any).handleScreenSnapshotReady(ws, 'session-1', repairToken);

  const outputsAfterAck = sent.filter((message) => message.type === 'output');
  assert.equal(outputsAfterAck.length, 1);
  assert.equal(outputsAfterAck[0].data, 'repair-pending-output');
  assert.equal(sent[sent.length - 1].type, 'session:ready');

  router.destroy();
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
    bootstrap: {
      allowedIps: [],
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
  updateTwoFactorRuntime,
  platform = process.platform,
}: {
  fixture?: Config;
  configPath?: string;
  fileService?: FileService;
  updateTwoFactorRuntime?: (config: Config, changedKeys: Array<string>) => string[];
  platform?: NodeJS.Platform;
} = {}) {
  const cryptoService = new CryptoService(`settings-harness-${Math.random().toString(36).slice(2)}`);
  const runtimeConfigStore = new RuntimeConfigStore(fixture, platform);
  const authService = new AuthService(fixture.auth!, cryptoService);
  const sessionManager = new SessionManager({ pty: fixture.pty, session: fixture.session }, {
    platform,
    execFileSyncFn: (() => Buffer.from('')) as any,
  });
  const configRepository = new ConfigFileRepository(configPath, platform);
  const settingsService = new SettingsService({
    runtimeConfigStore,
    configRepository,
    cryptoService,
    authService,
    getFileService: () => fileService,
    sessionManager,
    updateTwoFactorRuntime,
  }, platform);

  return {
    authService,
    runtimeConfigStore,
    sessionManager,
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
  bootstrap: {
    allowedIps: [],
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

function createMissingUseConptyConfigFixtureContent(): string {
  return createConfigFixtureContent().replace('    useConpty: true,\n', '');
}

function createMissingPtyConfigFixtureContent(): string {
  return createConfigFixtureContent().replace(/  pty: \{\n(?:    .+\n)*?  \},\n/, '');
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
  bootstrap: {
    allowedIps: [],
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

function createLegacyWindowsPtyConfigFixtureContent(): string {
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
    windowsPowerShellBackend: "conpty",
    maxBufferSize: 65536,
    shell: "powershell",
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
  bootstrap: {
    allowedIps: [],
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

async function testTOTPInitializeGeneratesSecretWithoutGlobalWebCrypto(): Promise<void> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'totp-no-webcrypto-test-'));
  const secretFile = path.join(tmpDir, 'totp.secret');
  const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  let service: TOTPService | undefined;

  try {
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      enumerable: true,
      value: undefined,
    });

    const crypto = new CryptoService('test-key-32-bytes-padded-here!!');
    service = new TOTPService(
      { enabled: true, issuer: 'PkgRuntime', accountName: 'admin' },
      crypto,
      secretFile,
      { suppressConsoleQr: true },
    );

    service.initialize();
    assert.equal(service.isRegistered(), true, 'TOTP should initialize without a preexisting Web Crypto global');
    await fs.access(secretFile);
  } finally {
    service?.destroy();
    if (cryptoDescriptor) {
      Object.defineProperty(globalThis, 'crypto', cryptoDescriptor);
    } else {
      delete (globalThis as { crypto?: Crypto }).crypto;
    }
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

async function captureConsoleLog<T>(run: () => T | Promise<T>): Promise<{ logs: string[]; result: T }> {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map((value) => String(value)).join(' '));
  };

  try {
    const result = await run();
    return { logs, result };
  } finally {
    console.log = originalLog;
  }
}

async function testTOTPInitializeSuppressesConsoleQr(): Promise<void> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'totp-suppress-test-'));
  const secretFile = path.join(tmpDir, 'totp.secret');
  const crypto = new CryptoService('test-key-32-bytes-padded-here!!');
  let service: TOTPService | undefined;

  try {
    const captured = await captureConsoleLog(async () => {
      service = new TOTPService(
        { enabled: true, issuer: 'Suppressed', accountName: 'admin' },
        crypto,
        secretFile,
        { suppressConsoleQr: true },
      );
      service.initialize();
      return service.generateQRDataUrl();
    });

    const qr = await captured.result;
    assert.ok(service?.isRegistered(), 'Suppress mode must still register a generated secret');
    await fs.access(secretFile);
    assert.equal(qr.registered, true, 'Suppress mode must not disable the QR data URL API');
    assert.match(qr.dataUrl, /^data:image\/png;base64,/, 'QR API should still generate an image data URL');
    assert.equal(captured.logs.some((line) => /Google Authenticator QR Code|Manual entry key|Issuer:/u.test(line)), false);
  } finally {
    service?.destroy();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

async function testTOTPInitializeQrRenderingFailureThrows(): Promise<void> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'totp-qr-failure-test-'));
  const secretFile = path.join(tmpDir, 'totp.secret');
  const crypto = new CryptoService('test-key-32-bytes-padded-here!!');

  try {
    const service = new TOTPService(
      { enabled: true, issuer: 'BrokenQR', accountName: 'admin' },
      crypto,
      secretFile,
      {
        qrCodeWriter: () => {
          throw new Error('QR renderer unavailable');
        },
      },
    );

    assert.throws(
      () => service.initialize(),
      /QR renderer unavailable/u,
      'QR rendering failures must fail initial TOTP startup',
    );
    service.destroy();

    const existingSecretService = new TOTPService(
      { enabled: true, issuer: 'BrokenQR', accountName: 'admin' },
      crypto,
      secretFile,
      {
        qrCodeWriter: () => {
          throw new Error('QR renderer unavailable on existing secret');
        },
      },
    );
    assert.throws(
      () => existingSecretService.initialize(),
      /QR renderer unavailable on existing secret/u,
      'QR rendering failures must also fail when an existing secret loads successfully',
    );
    existingSecretService.destroy();
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

// ============================================================================
// Phase 4: authRoutes — 4 COMBO flows
// Tests use a lightweight supertest-style helper via Express app
// ============================================================================

/** Build a minimal harness for authRoutes tests */
async function testReconcileTotpRuntimeStartupInitialization(): Promise<void> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'totp-runtime-startup-'));
  const secretFile = path.join(tmpDir, 'totp.secret');
  const crypto = new CryptoService('test-key-32-bytes-padded-here!!');

  try {
    const bootstrapService = new TOTPService({ enabled: true, issuer: 'Boot', accountName: 'admin' }, crypto, secretFile);
    bootstrapService.initialize();
    bootstrapService.destroy();

    const result = reconcileTotpRuntime({
      nextConfig: {
        ...createConfigFixture(),
        twoFactor: {
          enabled: true,
          externalOnly: false,
          issuer: 'Boot',
          accountName: 'admin',
        },
      },
      cryptoService: crypto,
      secretFilePath: secretFile,
    });

    assert.equal(result.warnings.length, 0, 'Startup runtime initialization should not warn for a valid secret');
    assert.ok(result.service?.isRegistered(), 'Startup runtime should be registered after reconcile');
    result.service?.destroy();
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

async function testReconcileTotpRuntimeKeepsPreviousService(): Promise<void> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'totp-runtime-retain-'));
  const secretFile = path.join(tmpDir, 'totp.secret');
  const crypto = new CryptoService('test-key-32-bytes-padded-here!!');
  const previousService = new TOTPService({ enabled: true, issuer: 'Stable', accountName: 'admin' }, crypto, secretFile);

  try {
    (previousService as unknown as { secret: string; registered: boolean }).secret = generateSecret();
    (previousService as unknown as { secret: string; registered: boolean }).registered = true;
    await fs.writeFile(secretFile, 'CORRUPTED_NOT_VALID_ENCRYPTED_DATA', 'utf-8');

    const result = reconcileTotpRuntime({
      currentService: previousService,
      nextConfig: {
        ...createConfigFixture(),
        twoFactor: {
          enabled: true,
          externalOnly: false,
          issuer: 'NewIssuer',
          accountName: 'new-admin',
        },
      },
      cryptoService: crypto,
      changedKeys: ['twoFactor.issuer'],
      secretFilePath: secretFile,
    });

    assert.equal(result.service, previousService, 'Hot-apply failure should keep the previous registered runtime');
    assert.equal(result.warnings.length, 1, 'Hot-apply failure should surface a warning');
    assert.ok(result.service?.isRegistered(), 'Previous runtime should remain registered');
  } finally {
    previousService.destroy();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

async function testReconcileTotpRuntimeUsesDaemonEnvSecretPathAndSuppressesQr(): Promise<void> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'totp-runtime-env-'));
  const secretFile = path.join(tmpDir, 'nested', '..', 'daemon-totp.secret');
  const crypto = new CryptoService('test-key-32-bytes-padded-here!!');
  const previousSecretPath = process.env.BUILDERGATE_TOTP_SECRET_PATH;
  const previousSuppress = process.env.BUILDERGATE_SUPPRESS_TOTP_QR;

  try {
    process.env.BUILDERGATE_TOTP_SECRET_PATH = secretFile;
    process.env.BUILDERGATE_SUPPRESS_TOTP_QR = '1';

    const captured = await captureConsoleLog(() => reconcileTotpRuntime({
      nextConfig: {
        ...createConfigFixture(),
        twoFactor: {
          enabled: true,
          externalOnly: false,
          issuer: 'DaemonChild',
          accountName: 'admin',
        },
      },
      cryptoService: crypto,
    }));

    assert.ok(captured.result.service?.isRegistered(), 'Daemon app child should load or create the env secret path');
    await fs.access(path.normalize(secretFile));
    assert.equal(captured.logs.some((line) => /Google Authenticator QR Code|Manual entry key|Issuer:/u.test(line)), false);
    captured.result.service?.destroy();
  } finally {
    if (previousSecretPath === undefined) {
      delete process.env.BUILDERGATE_TOTP_SECRET_PATH;
    } else {
      process.env.BUILDERGATE_TOTP_SECRET_PATH = previousSecretPath;
    }
    if (previousSuppress === undefined) {
      delete process.env.BUILDERGATE_SUPPRESS_TOTP_QR;
    } else {
      process.env.BUILDERGATE_SUPPRESS_TOTP_QR = previousSuppress;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

async function testReconcileTotpRuntimeInitialStartupFailureThrows(): Promise<void> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'totp-runtime-fatal-'));
  const secretFile = path.join(tmpDir, 'totp.secret');
  const crypto = new CryptoService('test-key-32-bytes-padded-here!!');

  try {
    await fs.writeFile(secretFile, 'CORRUPTED_NOT_VALID_ENCRYPTED_DATA', 'utf-8');

    assert.throws(
      () => reconcileTotpRuntime({
        nextConfig: {
          ...createConfigFixture(),
          twoFactor: {
            enabled: true,
            externalOnly: false,
            issuer: 'Fatal',
            accountName: 'admin',
          },
        },
        cryptoService: crypto,
        secretFilePath: secretFile,
        initialStartup: true,
      }),
      /TOTP|Decrypt|decryption|corrupted/u,
      'Initial startup must fail fast when TOTP cannot initialize',
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

async function testDaemonTotpPreflightPrintsQrAndManualKey(): Promise<void> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'totp-daemon-preflight-'));
  const secretFile = path.join(tmpDir, 'existing.secret');
  const crypto = new CryptoService('test-key-32-bytes-padded-here!!');

  try {
    const seedService = new TOTPService(
      { enabled: true, issuer: 'PreflightIssuer', accountName: 'preflight-admin' },
      crypto,
      secretFile,
      { suppressConsoleQr: true },
    );
    seedService.initialize();
    seedService.destroy();

    const captured = await captureConsoleLog(() => runDaemonTotpPreflightForConfig(
      {
        ...createConfigFixture(),
        twoFactor: {
          enabled: true,
          externalOnly: false,
          issuer: 'PreflightIssuer',
          accountName: 'preflight-admin',
        },
      },
      {
        cryptoService: crypto,
        secretFilePath: secretFile,
      },
    ));

    assert.equal(captured.result.enabled, true);
    assert.equal(captured.result.secretFilePath, path.resolve(secretFile));
    assert.ok(captured.logs.some((line) => /Google Authenticator QR Code/u.test(line)));
    assert.ok(captured.logs.some((line) => /Manual entry key: [A-Z2-7=]+/u.test(line)));
    assert.ok(captured.logs.some((line) => /Issuer: PreflightIssuer \| Account: preflight-admin/u.test(line)));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

async function testDaemonTotpPreflightSuppressesQrForSentinelRestart(): Promise<void> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'totp-daemon-preflight-suppress-'));
  const secretFile = path.join(tmpDir, 'existing.secret');
  const crypto = new CryptoService('test-key-32-bytes-padded-here!!');

  try {
    const seedService = new TOTPService(
      { enabled: true, issuer: 'SentinelIssuer', accountName: 'sentinel-admin' },
      crypto,
      secretFile,
      { suppressConsoleQr: true },
    );
    seedService.initialize();
    seedService.destroy();

    const captured = await captureConsoleLog(() => runDaemonTotpPreflightForConfig(
      {
        ...createConfigFixture(),
        twoFactor: {
          enabled: true,
          externalOnly: false,
          issuer: 'SentinelIssuer',
          accountName: 'sentinel-admin',
        },
      },
      {
        cryptoService: crypto,
        secretFilePath: secretFile,
        suppressConsoleQr: true,
      },
    ));

    assert.equal(captured.result.enabled, true);
    assert.equal(captured.result.secretFilePath, path.resolve(secretFile));
    assert.equal(captured.logs.some((line) => /Google Authenticator QR Code/u.test(line)), false);
    assert.equal(captured.logs.some((line) => /Manual entry key/u.test(line)), false);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

async function testDaemonTotpPreflightRejectsInvalidSecrets(): Promise<void> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'totp-daemon-preflight-invalid-'));
  const secretFile = path.join(tmpDir, 'totp.secret');
  const crypto = new CryptoService('test-key-32-bytes-padded-here!!');
  const config: Config = {
    ...createConfigFixture(),
    twoFactor: {
      enabled: true,
      externalOnly: false,
      issuer: 'InvalidPreflight',
      accountName: 'admin',
    },
  };

  try {
    await fs.writeFile(secretFile, 'CORRUPTED_NOT_VALID_ENCRYPTED_DATA', 'utf-8');
    await assert.rejects(
      () => runDaemonTotpPreflightForConfig(config, { cryptoService: crypto, secretFilePath: secretFile }),
      /TOTP|Decrypt|decryption|corrupted/u,
    );

    await fs.writeFile(secretFile, crypto.encrypt('not-base32!'), 'utf-8');
    await assert.rejects(
      () => runDaemonTotpPreflightForConfig(config, { cryptoService: crypto, secretFilePath: secretFile }),
      /BASE32/u,
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

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
          'x-test-remote-addr': ip,
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

async function invokeBootstrapStatus(
  accessors: Parameters<typeof createAuthRoutes>[0],
  ip = '::ffff:127.0.0.1',
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const app = express();
    app.use(express.json());
    app.use('/api/auth', createAuthRoutes(accessors));
    const server = http.createServer(app);
    server.listen(0, () => {
      const port = (server.address() as net.AddressInfo).port;
      const request = http.request({
        hostname: '127.0.0.1',
        port,
        method: 'GET',
        path: '/api/auth/bootstrap-status',
        headers: {
          'x-test-remote-addr': ip,
        },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          server.close();
          try {
            const payload = Buffer.concat(chunks).toString();
            resolve({
              status: res.statusCode ?? 0,
              body: payload ? JSON.parse(payload) as Record<string, unknown> : {},
            });
          } catch (error) {
            reject(error);
          }
        });
      });
      request.on('error', (error: Error) => {
        server.close();
        reject(error);
      });
      request.end();
    });
  });
}

async function invokeBootstrapPassword(
  accessors: Parameters<typeof createAuthRoutes>[0],
  body: Record<string, unknown>,
  ip = '::ffff:127.0.0.1',
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const app = express();
    app.use(express.json());
    app.use('/api/auth', createAuthRoutes(accessors));
    const server = http.createServer(app);
    server.listen(0, () => {
      const port = (server.address() as net.AddressInfo).port;
      const postBody = JSON.stringify(body);
      const request = http.request({
        hostname: '127.0.0.1',
        port,
        method: 'POST',
        path: '/api/auth/bootstrap-password',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postBody),
          'x-test-remote-addr': ip,
        },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          server.close();
          try {
            const payload = Buffer.concat(chunks).toString();
            resolve({
              status: res.statusCode ?? 0,
              body: payload ? JSON.parse(payload) as Record<string, unknown> : {},
            });
          } catch (error) {
            reject(error);
          }
        });
      });
      request.on('error', (error: Error) => {
        server.close();
        reject(error);
      });
      request.write(postBody);
      request.end();
    });
  });
}

async function invokeTotpQr(
  accessors: Parameters<typeof createAuthRoutes>[0],
  token: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const app = express();
    app.use(express.json());
    app.use('/api/auth', createAuthRoutes(accessors));
    const server = http.createServer(app);
    server.listen(0, () => {
      const port = (server.address() as net.AddressInfo).port;
      const options = {
        hostname: '127.0.0.1',
        port,
        method: 'GET',
        path: '/api/auth/totp-qr',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      };
      const request = http.request(options, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          server.close();
          try {
            const payload = Buffer.concat(chunks).toString();
            const json = payload ? JSON.parse(payload) as Record<string, unknown> : {};
            resolve({ status: res.statusCode ?? 0, body: json });
          } catch (error) {
            reject(error);
          }
        });
      });
      request.on('error', (error: Error) => {
        server.close();
        reject(error);
      });
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
    getBootstrapSetupService: () => ({
      getStatus: () => ({ setupRequired: false, requesterAllowed: false, allowPolicy: 'configured' as const }),
      bootstrapPassword: () => {
        throw new AppError(ErrorCode.BOOTSTRAP_NOT_REQUIRED);
      },
    }),
    getRequestIp: (req: Request) => String(req.headers['x-test-remote-addr'] ?? '::ffff:127.0.0.1'),
  };

  return { authService, totpService, accessors, cryptoService };
}

async function makeBootstrapHarness(options: {
  initialPassword?: string;
  configuredAllowedIps?: string[];
  omitAuthSection?: boolean;
} = {}) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'buildergate-bootstrap-auth-'));
  const configPath = path.join(tempDir, 'config.json5');
  const initialPassword = options.initialPassword ?? '';
  const configuredAllowedIps = options.configuredAllowedIps ?? [];
  let configContent = createConfigFixtureContent()
    .replace('    password: "old-password",', `    password: ${JSON.stringify(initialPassword)},`)
    .replace('    allowedIps: [],', `    allowedIps: [${configuredAllowedIps.map((ip) => JSON.stringify(ip)).join(', ')}],`);
  if (options.omitAuthSection) {
    configContent = configContent.replace(
      `  auth: {\n    password: ${JSON.stringify(initialPassword)},\n    durationMs: 1800000,\n    maxDurationMs: 86400000,\n    jwtSecret: "jwt-secret",\n  },\n`,
      '',
    );
  }

  await fs.writeFile(configPath, configContent, 'utf-8');

  const cryptoService = new CryptoService(`bootstrap-auth-${Math.random().toString(36).slice(2)}`);
  const authService = new AuthService(
    {
      password: initialPassword,
      durationMs: 1800000,
      maxDurationMs: 86400000,
      jwtSecret: 'bootstrap-jwt-secret',
    },
    cryptoService,
  );
  const configRepository = new ConfigFileRepository(configPath);
  const bootstrapSetupService = new BootstrapSetupService({
    authService,
    cryptoService,
    configRepository,
    getConfiguredAllowedIps: () => configuredAllowedIps,
  });

  const accessors = {
    getAuthService: () => authService,
    getTOTPService: () => undefined,
    getTwoFactorExternalOnly: () => false,
    getBootstrapSetupService: () => bootstrapSetupService,
    getRequestIp: (req: Request) => String(req.headers['x-test-remote-addr'] ?? '::ffff:127.0.0.1'),
  };

  return {
    configPath,
    authService,
    accessors,
    destroy: async () => {
      authService.destroy();
      await fs.rm(tempDir, { recursive: true, force: true });
    },
  };
}

async function testAuthRoutesBootstrapStatusLocalhost(): Promise<void> {
  const harness = await makeBootstrapHarness({ initialPassword: '' });
  try {
    const result = await invokeBootstrapStatus(harness.accessors);
    assert.equal(result.status, 200);
    assert.equal(result.body.setupRequired, true);
    assert.equal(result.body.requesterAllowed, true);
    assert.equal(result.body.allowPolicy, 'localhost');
  } finally {
    await harness.destroy();
  }
}

async function testAuthRoutesBootstrapStatusDeniedRemote(): Promise<void> {
  const harness = await makeBootstrapHarness({ initialPassword: '' });
  try {
    const result = await invokeBootstrapStatus(harness.accessors, '192.168.0.50');
    assert.equal(result.status, 200);
    assert.equal(result.body.setupRequired, true);
    assert.equal(result.body.requesterAllowed, false);
    assert.equal(result.body.allowPolicy, 'denied');
  } finally {
    await harness.destroy();
  }
}

async function testAuthRoutesBootstrapStatusAllowlistEnv(): Promise<void> {
  const previous = process.env.BUILDERGATE_BOOTSTRAP_ALLOWED_IPS;
  process.env.BUILDERGATE_BOOTSTRAP_ALLOWED_IPS = '192.168.0.50';
  const harness = await makeBootstrapHarness({ initialPassword: '' });
  try {
    const result = await invokeBootstrapStatus(harness.accessors, '192.168.0.50');
    assert.equal(result.status, 200);
    assert.equal(result.body.setupRequired, true);
    assert.equal(result.body.requesterAllowed, true);
    assert.equal(result.body.allowPolicy, 'allowlist');
  } finally {
    if (previous === undefined) {
      delete process.env.BUILDERGATE_BOOTSTRAP_ALLOWED_IPS;
    } else {
      process.env.BUILDERGATE_BOOTSTRAP_ALLOWED_IPS = previous;
    }
    await harness.destroy();
  }
}

async function testAuthRoutesBootstrapStatusNormalizesMappedIpv4(): Promise<void> {
  const harness = await makeBootstrapHarness({ initialPassword: '', configuredAllowedIps: ['192.168.0.50'] });
  try {
    const result = await invokeBootstrapStatus(harness.accessors, '::ffff:192.168.0.50');
    assert.equal(result.status, 200);
    assert.equal(result.body.requesterAllowed, true);
    assert.equal(result.body.allowPolicy, 'allowlist');
  } finally {
    await harness.destroy();
  }
}

async function testAuthRoutesBootstrapPasswordSuccess(): Promise<void> {
  const harness = await makeBootstrapHarness({ initialPassword: '' });
  try {
    const result = await invokeBootstrapPassword(harness.accessors, {
      password: 'bootstrap-pass',
      confirmPassword: 'bootstrap-pass',
    });
    const savedContent = await fs.readFile(harness.configPath, 'utf-8');

    assert.equal(result.status, 201);
    assert.equal(result.body.success, true);
    assert.ok(typeof result.body.token === 'string');
    assert.equal(result.body.expiresIn, 1800000);
    assert.equal(harness.authService.validatePassword('bootstrap-pass'), true);
    assert.match(savedContent, /password:\s*"enc\(/);
  } finally {
    await harness.destroy();
  }
}

async function testAuthRoutesBootstrapPasswordEnforcesPolicy(): Promise<void> {
  const harness = await makeBootstrapHarness({ initialPassword: '' });
  const invalidPasswords = [
    'abc',
    'bootstrap pass',
    '부트스트랩1',
    'Password🙂1',
    'Password?1',
    'A'.repeat(129),
  ];
  const password = 'Aa1!'.repeat(32);
  try {
    for (const invalidPassword of invalidPasswords) {
      const invalidResult = await invokeBootstrapPassword(harness.accessors, {
        password: invalidPassword,
        confirmPassword: invalidPassword,
      });
      assert.equal(invalidResult.status, 400, `expected bootstrap policy rejection for ${invalidPassword}`);
      assert.equal((invalidResult.body.error as Record<string, unknown>).code, ErrorCode.VALIDATION_ERROR);
    }

    const result = await invokeBootstrapPassword(harness.accessors, {
      password,
      confirmPassword: password,
    });

    assert.equal(result.status, 201);
    assert.equal(harness.authService.validatePassword(password), true);
    assert.equal(harness.authService.validatePassword(password.slice(0, -1)), false);
  } finally {
    await harness.destroy();
  }
}

async function testAuthRoutesBootstrapPasswordLegacyMissingAuthSection(): Promise<void> {
  const harness = await makeBootstrapHarness({ initialPassword: '', omitAuthSection: true });
  try {
    const result = await invokeBootstrapPassword(harness.accessors, {
      password: 'bootstrap-pass',
      confirmPassword: 'bootstrap-pass',
    });
    const savedContent = await fs.readFile(harness.configPath, 'utf-8');

    assert.equal(result.status, 201);
    assert.match(savedContent, /auth:\s*\{/);
    assert.match(savedContent, /password:\s*"enc\(/);
  } finally {
    await harness.destroy();
  }
}

async function testAuthRoutesBootstrapPasswordClosedAfterSetup(): Promise<void> {
  const harness = await makeBootstrapHarness({ initialPassword: '' });
  try {
    const first = await invokeBootstrapPassword(harness.accessors, {
      password: 'bootstrap-pass',
      confirmPassword: 'bootstrap-pass',
    });
    assert.equal(first.status, 201);

    const statusAfter = await invokeBootstrapStatus(harness.accessors);
    assert.equal(statusAfter.body.setupRequired, false);
    assert.equal(statusAfter.body.allowPolicy, 'configured');

    const second = await invokeBootstrapPassword(harness.accessors, {
      password: 'another-pass',
      confirmPassword: 'another-pass',
    });
    assert.equal(second.status, 409);
    assert.equal((second.body.error as Record<string, unknown>).code, ErrorCode.BOOTSTRAP_NOT_REQUIRED);
  } finally {
    await harness.destroy();
  }
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
    getBootstrapSetupService: () => ({
      getStatus: () => ({ setupRequired: false, requesterAllowed: false, allowPolicy: 'configured' as const }),
      bootstrapPassword: () => {
        throw new AppError(ErrorCode.BOOTSTRAP_NOT_REQUIRED);
      },
    }),
    getRequestIp: (req: Request) => String(req.headers['x-test-remote-addr'] ?? '::ffff:127.0.0.1'),
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

async function testAuthRoutesTotpQrLatestRuntime(): Promise<void> {
  const { accessors, authService, cryptoService } = makeAuthHarness({ withTotp: true, totpRegistered: true });
  const accessorsMutable = accessors as Parameters<typeof createAuthRoutes>[0] & { getTOTPService: () => TOTPService | undefined };
  const serviceA = new TOTPService({ enabled: true, issuer: 'IssuerA', accountName: 'admin-a' }, cryptoService);
  const serviceB = new TOTPService({ enabled: true, issuer: 'IssuerB', accountName: 'admin-b' }, cryptoService);
  const secretA = generateSecret();
  const secretB = generateSecret();
  (serviceA as unknown as { secret: string; registered: boolean }).secret = secretA;
  (serviceA as unknown as { secret: string; registered: boolean }).registered = true;
  (serviceB as unknown as { secret: string; registered: boolean }).secret = secretB;
  (serviceB as unknown as { secret: string; registered: boolean }).registered = true;

  let activeService: TOTPService | undefined = serviceA;
  accessorsMutable.getTOTPService = () => activeService;
  const { token } = authService.issueToken();

  try {
    const first = await invokeTotpQr(accessorsMutable, token);
    assert.equal(first.status, 200, `Expected 200, got ${first.status}`);
    assert.match(String(first.body.uri ?? ''), /IssuerA:admin-a/, 'First URI should use the first runtime instance');

    activeService = serviceB;
    const second = await invokeTotpQr(accessorsMutable, token);
    assert.equal(second.status, 200, `Expected 200, got ${second.status}`);
    assert.match(String(second.body.uri ?? ''), /IssuerB:admin-b/, 'Second URI should use the latest runtime instance');
  } finally {
    authService.destroy();
    serviceA.destroy();
    serviceB.destroy();
  }
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
