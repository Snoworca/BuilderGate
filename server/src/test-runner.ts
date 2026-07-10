import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { existsSync, writeFileSync as fsSyncWriteFile } from 'fs';
import http from 'node:http';
import https from 'node:https';
import type net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import type { Config } from './types/config.types.js';
import type { Session, ShellType } from './types/index.js';
import { twoFactorSchema, authSchema } from './schemas/config.schema.js';
import {
  resourceLimitsSchema,
  sessionProcessCleanupSchema,
  stabilityModesSchema,
} from './schemas/config.schema.js';
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
import { SessionManager, type SessionFinalizedEvent } from './services/SessionManager.js';
import { sessionManager } from './services/SessionManager.js';
import { FileService } from './services/FileService.js';
import { OscDetector } from './services/OscDetector.js';
import { WorkspaceService } from './services/WorkspaceService.js';
import {
  TerminalTitleDetector,
  isDefaultTerminalTabName,
  isSystemAbsolutePathTerminalTitle,
  sanitizeTerminalTitle,
  type TerminalTitleEvent,
} from './utils/terminalTitle.js';
import { CommandPresetService } from './services/CommandPresetService.js';
import { TerminalShortcutService } from './services/TerminalShortcutService.js';
import { RecoveryOptionService } from './services/RecoveryOptionService.js';
import {
  createMcpControlConfigFileStore,
  mergeStoredMcpControlConfig,
} from './services/McpControlConfigStore.js';
import {
  buildMcpNodeRequestErrorResponse,
  readMcpIncomingRequestBody,
} from './services/McpNodeHttpBoundary.js';
import {
  classifyMcpBearerCredential,
  closeMcpNodeHttpListener,
  createMcpNodeHttpListener,
} from './services/McpNodeHttpListener.js';
import { buildMcpGatewayDeliveryResponse } from './services/McpGatewayDeliveryResult.js';
import { applyMcpControlConfigPatch } from './services/McpControlConfigCoordinator.js';
import { buildMcpControlRouteFailure, isMcpControlRouteFailure } from './services/McpControlRouteResult.js';
import {
  createHeadlessTerminalState,
  disposeHeadlessTerminal,
  resizeHeadlessTerminal,
  serializeHeadlessScreenRepair,
  serializeHeadlessTerminal,
  writeHeadlessTerminal,
} from './utils/headlessTerminal.js';
import { createHeadlessOutputQueue as createHeadlessOutputQueueForHarness } from './utils/headlessOutputQueue.js';
import { truncateTerminalPayloadTail } from './utils/terminalPayload.js';
import { WsRouter } from './ws/WsRouter.js';
import { AppError, ErrorCode } from './utils/errors.js';
import type { CreateTerminalShortcutBindingInput } from './types/terminalShortcut.types.js';
import { createAuthRoutes } from './routes/authRoutes.js';
import { createInternalShutdownRoutes } from './routes/internalShutdownRoutes.js';
import { createCommandPresetRoutes } from './routes/commandPresetRoutes.js';
import { createTerminalShortcutRoutes } from './routes/terminalShortcutRoutes.js';
import { createRecoveryOptionRoutes } from './routes/recoveryOptionRoutes.js';
import { createWorkspaceRoutes } from './routes/workspaceRoutes.js';
import sessionRoutes, { createSessionRoutes } from './routes/sessionRoutes.js';
import { createAuthMiddleware } from './middleware/authMiddleware.js';
import { ensureDebugCaptureSessionExists, requireLocalDebugCapture } from './middleware/debugCaptureGuards.js';
import { performGracefulShutdown } from './services/gracefulShutdown.js';
import {
  applyBootstrapPtyDefaultsToConfigText,
  normalizeRawConfigForPlatform,
} from './utils/ptyPlatformPolicy.js';
import {
  DefaultProcessTreeTerminator,
  readProcessStartIdentity,
  type ProcessTreeTerminator,
} from './utils/processTreeTerminator.js';
import { getConfigPath, loadConfigFromPath } from './utils/config.js';
import { loadConfigFromPathStrict } from './utils/configStrictLoader.js';
import { resolveInputReliabilityMode } from './utils/inputReliabilityMode.js';
import { validatePasswordPolicy } from './utils/passwordPolicy.js';
import { buildRecoveryRestoreInput, getRecoveryExecutableToken } from './utils/recoveryCommand.js';
import { mintMcpCapabilityToken, validateMcpWebhookKeyHeaderName, verifyMcpFixedAccessKey } from './services/McpSecurityContract.js';
import { sanitizeWebhookPublicRecord } from './services/WebhookInvocationService.js';
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
    { name: 'Config loader resolves enforce cleanup and visible flush budget overrides without changing schema defaults', run: testConfigLoaderNativePerformanceP0Overrides },
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
    { name: 'RuntimeConfigStore marks selected Wave6 resource limits as settings-applied', run: testRuntimeConfigWave6SelectedResourceCapabilities },
    { name: 'server startup wires Wave4 limits into WsRouter construction', run: testServerStartupWiresWave4LimitsIntoWsRouter },
    { name: 'BoundedByteDeque enforces UTF-8 byte caps', run: testBoundedByteDequeUtf8ByteCap },
    { name: 'BoundedByteDeque enforces chunk caps', run: testBoundedByteDequeChunkCap },
    { name: 'BoundedByteDeque preserves FIFO dequeue without hot-path array copying', run: testBoundedByteDequeFifoWithoutShiftHotPath },
    { name: 'HeadlessOutputQueue reports overflow telemetry and degrade decisions', run: testHeadlessOutputQueueOverflowTelemetry },
    { name: 'SessionManager consumes headless queue limits without flipping defaults', run: testSessionManagerHeadlessQueueRuntimeConfig },
    { name: 'WsRouter consumes send limits without flipping defaults', run: testWsRouterSendRuntimeConfig },
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
    { name: 'SettingsService applies Wave4 headless runtime settings for later sessions', run: testSettingsServiceAppliesWave4HeadlessRuntimeSettings },
    { name: 'SettingsService applies Wave4 WebSocket runtime settings to the live router', run: testSettingsServiceAppliesWave4WsRuntimeSettings },
    { name: 'SettingsService persists editable values against a legacy pty.maxBufferSize config', run: testSettingsServiceLegacyPtyMigration },
    { name: 'ConfigFileRepository can insert useConpty into legacy config text', run: testConfigFileRepositoryInsertsMissingUseConpty },
    { name: 'ConfigFileRepository can insert missing PTY section for legacy config text', run: testConfigFileRepositoryInsertsMissingPtySection },
    { name: 'ConfigFileRepository persists generated JWT secrets', run: testConfigFileRepositoryPersistsGeneratedJwtSecret },
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
    { name: 'SessionManager records observe-mode cleanup telemetry on delete', run: testSessionManagerRecordsObserveCleanupTelemetryOnDelete },
    { name: 'SessionManager finalizes natural process exit once', run: testSessionManagerFinalizesNaturalProcessExitOnce },
    { name: 'SessionManager finalizer is idempotent across delete and late process-exit', run: testSessionManagerDoesNotDoubleCountDeleteThenProcessExit },
    { name: 'SessionManager default cleanup inspector skips unverified observations', run: testSessionManagerDefaultCleanupInspectorSkipsUnverified },
    { name: 'SessionManager records unverified cleanup skips without extra kills', run: testSessionManagerCleanupTelemetryRecordsUnverifiedSkip },
    { name: 'SessionManager bounds recent cleanup telemetry results', run: testSessionManagerCleanupTelemetryBoundsRecentResults },
    { name: 'ProcessTreeTerminator skips termination without root identity', run: testProcessTreeTerminatorSkipsWithoutIdentity },
    { name: 'ProcessTreeTerminator rejects PID start identity mismatch', run: testProcessTreeTerminatorRejectsIdentityMismatch },
    { name: 'ProcessTreeTerminator skips POSIX termination when cwd is unavailable', run: testProcessTreeTerminatorSkipsPosixMissingCwd },
    { name: 'ProcessTreeTerminator skips POSIX termination when cwd mismatches', run: testProcessTreeTerminatorSkipsCwdMismatch },
    { name: 'ProcessTreeTerminator uses Windows taskkill by PID without shell', run: testProcessTreeTerminatorWindowsTaskkillByPid },
    { name: 'ProcessTreeTerminator reports failed Windows taskkill without throwing', run: testProcessTreeTerminatorWindowsTaskkillFailureReportsFailed },
    { name: 'ProcessTreeTerminator skips WSL backend without Linux process identity', run: testProcessTreeTerminatorSkipsWslWithoutLinuxIdentity },
    { name: 'ProcessTreeTerminator avoids POSIX process-group kill when PGID is unverified', run: testProcessTreeTerminatorPosixLeafFirstWhenPgidUnverified },
    { name: 'ProcessTreeTerminator does not use POSIX process-group kill with root PGID alone', run: testProcessTreeTerminatorDoesNotUsePgidFromRootAlone },
    { name: 'ProcessTreeTerminator force-kills only verified remaining POSIX root', run: testProcessTreeTerminatorForceKillsVerifiedRemainingRoot },
    { name: 'ProcessTreeTerminator reports sampled child that survives root exit', run: testProcessTreeTerminatorReportsSurvivingSampledChildAfterRootExit },
    { name: 'SessionManager terminateSession awaits enforce process-tree termination', run: testSessionManagerTerminateSessionAwaitsEnforceTerminator },
    { name: 'SessionManager terminateSession merges process exit race into explicit cleanup', run: testSessionManagerTerminateSessionMergesProcessExitRace },
    { name: 'SessionManager.createSession does not synchronously read process start identity on Windows', run: testSessionManagerCreateSessionDoesNotReadStartIdentitySynchronously },
    { name: 'SessionManager ignores rejected asynchronous process start identity capture', run: testSessionManagerIgnoresRejectedAsyncStartIdentityCapture },
    { name: 'SessionManager retries asynchronous process start identity capture after a transient failure', run: testSessionManagerRetriesAsyncStartIdentityCaptureAfterTransientFailure },
    { name: 'readProcessStartIdentity returns null when Windows process identity probe times out', run: testReadProcessStartIdentityWindowsTimeoutReturnsNull },
    { name: 'SessionManager stores asynchronous process start identity when capture resolves', run: testSessionManagerStoresAsyncStartIdentity },
    { name: 'SessionManager treats termination before async start identity capture as unverified cleanup', run: testSessionManagerTerminateBeforeAsyncStartIdentityCapture },
    { name: 'SessionManager updates process metadata cwd from verified cwd hook', run: testSessionManagerUpdatesProcessMetadataCwdFromHook },
    { name: 'SessionManager terminateSession finalizes when enforce terminator throws', run: testSessionManagerTerminateSessionFinalizesWhenTerminatorThrows },
    { name: 'SessionManager terminateMultipleSessions reports mixed missing sessions', run: testSessionManagerTerminateMultipleSessionsReportsMissing },
    { name: 'SessionManager terminateAllSessions reports deterministic batch result', run: testSessionManagerTerminateAllSessionsBatchResult },
    { name: 'SessionManager terminateAllSessions records enforce override when runtime cleanup is legacy', run: testSessionManagerTerminateAllSessionsEnforceOverrideRecordsTelemetry },
    { name: 'SessionManager keeps Hermes submit idle in bash heuristic mode', run: testSessionManagerHermesBashSubmitStaysIdle },
    { name: 'SessionManager keeps Codex submit idle in bash heuristic mode', run: testSessionManagerCodexBashSubmitStaysIdle },
    { name: 'SessionManager keeps Claude submit idle in bash heuristic mode', run: testSessionManagerClaudeBashSubmitStaysIdle },
    { name: 'SessionManager keeps Codex typing idle after a prior running misclassification', run: testSessionManagerCodexTypingRestoresIdleAfterRunning },
    { name: 'SessionManager keeps Codex foreground when internal submit resembles AI command', run: testSessionManagerCodexInternalAiCommandSubmitDoesNotStartLaunchAttempt },
    { name: 'SessionManager keeps custom recovery foreground input idle', run: testSessionManagerCustomRecoveryForegroundInputStaysIdle },
    { name: 'SessionManager does not emit submitted command callback when PTY input write fails', run: testSessionManagerCommandSubmittedCallbackRequiresSuccessfulWrite },
    { name: 'SessionManager queues restore input until shell startup readiness', run: testSessionManagerRestoreInputWaitsForStartupReady },
    { name: 'SessionManager cancels scheduled restore input when guard fails', run: testSessionManagerRestoreInputGuardCancelsWrite },
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
    { name: 'MCP security contract SEC-MCP-001 AC-1: defaults bind loopback and reject non-loopback dispatch', run: mcpSecurityContractRedTests['Security_contract_red_tests_SEC-MCP-001_AC-1'] },
    { name: 'MCP security contract SEC-MCP-001 AC-2: whitelist requires TLS or trusted TLS proxy', run: mcpSecurityContractRedTests['Security_contract_red_tests_SEC-MCP-001_AC-2'] },
    { name: 'MCP security contract SEC-MCP-001 AC-3: forwarded IP is trusted only from HTTPS trusted proxies', run: mcpSecurityContractRedTests['Security_contract_red_tests_SEC-MCP-001_AC-3'] },
    { name: 'MCP security contract SEC-MCP-001 AC-4: denials expose stable code and audit id without secrets', run: mcpSecurityContractRedTests['Security_contract_red_tests_SEC-MCP-001_AC-4'] },
    { name: 'MCP security contract SEC-MCP-001 AC-5: listener rebind swaps MCP listener without app restart', run: mcpSecurityContractRedTests['Security_contract_red_tests_SEC-MCP-001_AC-5'] },
    { name: 'MCP security contract SEC-MCP-001 AC-6: failed rebind rolls back listener and persisted config', run: mcpSecurityContractRedTests['Security_contract_red_tests_SEC-MCP-001_AC-6'] },
    { name: 'MCP security contract SEC-MCP-002 AC-1: scoped session token claims and rejection cases', run: mcpSecurityContractRedTests['Security_contract_red_tests_SEC-MCP-002_AC-1'] },
    { name: 'MCP security contract SEC-MCP-002 AC-2: default session actor scopes are least privilege', run: mcpSecurityContractRedTests['Security_contract_red_tests_SEC-MCP-002_AC-2'] },
    { name: 'MCP security contract SEC-MCP-002 AC-3: close-self and close-other grants stay distinct', run: mcpSecurityContractRedTests['Security_contract_red_tests_SEC-MCP-002_AC-3'] },
    { name: 'MCP security contract SEC-MCP-002 AC-4: browser JWT is rejected as MCP or webhook credential', run: mcpSecurityContractRedTests['Security_contract_red_tests_SEC-MCP-002_AC-4'] },
    { name: 'MCP security contract SEC-MCP-002 AC-5: Origin policy composes with transport and credential checks', run: mcpSecurityContractRedTests['Security_contract_red_tests_SEC-MCP-002_AC-5'] },
    { name: 'MCP security contract SEC-MCP-002 AC-6: empty whitelist mode is rejected', run: mcpSecurityContractRedTests['Security_contract_red_tests_SEC-MCP-002_AC-6'] },
    { name: 'MCP security contract SEC-MCP-002 AC-7: webhook secrets use entropy, hashes, and one-time exposure', run: mcpSecurityContractRedTests['Security_contract_red_tests_SEC-MCP-002_AC-7'] },
    { name: 'MCP security contract SEC-MCP-002 AC-8: webhook bindings constrain target, profile, mode, and scope', run: mcpSecurityContractRedTests['Security_contract_red_tests_SEC-MCP-002_AC-8'] },
    { name: 'MCP security contract SEC-MCP-002 AC-9: policy denials use stable MCP codes', run: mcpSecurityContractRedTests['Security_contract_red_tests_SEC-MCP-002_AC-9'] },
    { name: 'MCP security contract SEC-MCP-002 AC-10: fixed access key is hashed and least-privilege', run: mcpSecurityContractRedTests['Security_contract_red_tests_SEC-MCP-002_AC-10'] },
    { name: 'MCP fixed access key Bearer resolves to a limited non-session actor', run: testMcpFixedAccessKeyBearerTransport },
    { name: 'MCP HTTP initialize authenticates fixed keys and rejects browser or missing credentials', run: testMcpFixedAccessKeyHttpAuthentication },
    { name: 'MCP fixed access key hash persists across config updates without plaintext', run: testMcpFixedAccessKeyHashPersistence },
    { name: 'MCP claim code issuance expires and prunes bounded records', run: testMcpClaimCodeIssuanceBounds },
    { name: 'MCP security contract IR-MCP-005 AC-1: whitelist empty and nonmatch codes take precedence', run: mcpSecurityContractRedTests['Security_contract_red_tests_IR-MCP-005_AC-1'] },
    { name: 'MCP security contract IR-MCP-005 AC-2: promptPreview is redacted, normalized, and bounded', run: mcpSecurityContractRedTests['Security_contract_red_tests_IR-MCP-005_AC-2'] },
    { name: 'MCP security contract IR-MCP-005 AC-3: recent audit status is bounded and redacted', run: mcpSecurityContractRedTests['Security_contract_red_tests_IR-MCP-005_AC-3'] },
    { name: 'MCP security contract IR-MCP-005 AC-4: forbidden webhook header names are rejected', run: mcpSecurityContractRedTests['Security_contract_red_tests_IR-MCP-005_AC-4'] },
    { name: 'MCP security contract IR-MCP-005 AC-5: webhook full secret exposure is create-or-rotate only', run: mcpSecurityContractRedTests['Security_contract_red_tests_IR-MCP-005_AC-5'] },
    { name: 'MCP security contract IR-MCP-005 AC-6: agentStatus wire enum rejects arbitrary values', run: mcpSecurityContractRedTests['Security_contract_red_tests_IR-MCP-005_AC-6'] },
    { name: 'MCP security contract IR-MCP-005 AC-7: bindingLifecycle wire enum rejects legacy active value', run: mcpSecurityContractRedTests['Security_contract_red_tests_IR-MCP-005_AC-7'] },
    { name: 'MCP security contract IR-MCP-005 AC-8: replay pending denial code is not substituted', run: mcpSecurityContractRedTests['Security_contract_red_tests_IR-MCP-005_AC-8'] },
    { name: 'MCP security contract IR-MCP-005 AC-9: close confirmation shape is mandatory', run: mcpSecurityContractRedTests['Security_contract_red_tests_IR-MCP-005_AC-9'] },
    { name: 'MCP security contract IR-MCP-005 AC-10: non-create webhook surfaces remain masked', run: mcpSecurityContractRedTests['Security_contract_red_tests_IR-MCP-005_AC-10'] },
    { name: 'MCP registry contract FR-MCP-001 AC-1: creates stable sessionKey with UUID currentSessionId', run: registryAndAliasRedTests['Registry_and_alias_red_tests_FR-MCP-001_AC-1'] },
    { name: 'MCP registry contract FR-MCP-001 AC-2: updates currentSessionId generation without changing sessionKey', run: registryAndAliasRedTests['Registry_and_alias_red_tests_FR-MCP-001_AC-2'] },
    { name: 'MCP registry contract FR-MCP-001 AC-3: rejects stale sessionId targets', run: registryAndAliasRedTests['Registry_and_alias_red_tests_FR-MCP-001_AC-3'] },
    { name: 'MCP registry contract FR-MCP-001 AC-4: accepts current sessionId targets', run: registryAndAliasRedTests['Registry_and_alias_red_tests_FR-MCP-001_AC-4'] },
    { name: 'MCP registry contract FR-MCP-001 AC-5: preserves sessionKey through restart recovery', run: registryAndAliasRedTests['Registry_and_alias_red_tests_FR-MCP-001_AC-5'] },
    { name: 'MCP registry contract FR-MCP-001 AC-6: startup reconcile indexes live workspace tabs', run: registryAndAliasRedTests['Registry_and_alias_red_tests_FR-MCP-001_AC-6'] },
    { name: 'MCP registry contract FR-MCP-001 AC-7: backfills legacy workspace tabs', run: registryAndAliasRedTests['Registry_and_alias_red_tests_FR-MCP-001_AC-7'] },
    { name: 'MCP registry contract FR-MCP-006 AC-6: reconcile repairs duplicate session keys', run: registryAndAliasRedTests['Registry_and_alias_red_tests_FR-MCP-006_DUPLICATE_KEYS'] },
    { name: 'MCP alias contract FR-MCP-006 AC-1: list excludes self by default', run: registryAndAliasRedTests['Registry_and_alias_red_tests_FR-MCP-006_AC-1'] },
    { name: 'MCP alias contract FR-MCP-006 AC-2: list includes self when includeSelf is true', run: registryAndAliasRedTests['Registry_and_alias_red_tests_FR-MCP-006_AC-2'] },
    { name: 'MCP alias contract FR-MCP-006 AC-3: list surfaces user alias and current session binding', run: registryAndAliasRedTests['Registry_and_alias_red_tests_FR-MCP-006_AC-3'] },
    { name: 'MCP alias contract FR-MCP-006 AC-4: exact alias search ranks before partial matches', run: registryAndAliasRedTests['Registry_and_alias_red_tests_FR-MCP-006_AC-4'] },
    { name: 'MCP alias contract FR-MCP-001 AC-7: search ranks user aliases before weaker fields', run: registryAndAliasRedTests['Registry_and_alias_red_tests_FR-MCP-001_AC-7_SEARCH_RANKING'] },
    { name: 'MCP alias contract FR-MCP-001 AC-7: search matches session keys and ids', run: registryAndAliasRedTests['Registry_and_alias_red_tests_FR-MCP-001_AC-7_SEARCH_SESSION_IDS'] },
    { name: 'MCP alias contract FR-MCP-001 AC-7: search reports zero and ambiguous matches', run: registryAndAliasRedTests['Registry_and_alias_red_tests_FR-MCP-001_AC-7_SEARCH_DENIALS'] },
    { name: 'MCP alias contract FR-MCP-006 AC-5: alias update persists WorkspaceTab user name', run: registryAndAliasRedTests['Registry_and_alias_red_tests_FR-MCP-006_AC-5'] },
    { name: 'MCP alias contract FR-MCP-006 AC-6: alias update broadcasts tab metadata', run: registryAndAliasRedTests['Registry_and_alias_red_tests_FR-MCP-006_AC-6'] },
    { name: 'MCP input gateway FR-MCP-002 AC-1: all ingress paths route through SessionInputGateway', run: inputGatewayRedTests['Input_gateway_red_tests_FR-MCP-002_AC-1'] },
    { name: 'MCP input gateway FR-MCP-002 AC-2: replay pending rejection uses stable code', run: inputGatewayRedTests['Input_gateway_red_tests_FR-MCP-002_AC-2'] },
    { name: 'MCP input gateway FR-MCP-002 AC-3: paste-only delivery rejects submit and newlines without scope', run: inputGatewayRedTests['Input_gateway_red_tests_FR-MCP-002_AC-3'] },
    { name: 'MCP input gateway FR-MCP-002 AC-4: stale or non-live targets reject before PTY write', run: inputGatewayRedTests['Input_gateway_red_tests_FR-MCP-002_AC-4'] },
    { name: 'MCP input gateway FR-MCP-002 AC-5: AI TUI user/input repaint events preserve idle', run: inputGatewayRedTests['Input_gateway_red_tests_FR-MCP-002_AC-5'] },
    { name: 'MCP input gateway FR-MCP-002 AC-6: reply_to_leader resolves live leader or preserves follower', run: inputGatewayRedTests['Input_gateway_red_tests_FR-MCP-002_AC-6'] },
    { name: 'MCP input gateway IR-MCP-004 AC-1: webhook create/rotate secret material stays out of input audit', run: inputGatewayRedTests['Input_gateway_red_tests_IR-MCP-004_AC-1'] },
    { name: 'MCP input gateway IR-MCP-004 AC-2: webhook header credentials share redacted gateway path', run: inputGatewayRedTests['Input_gateway_red_tests_IR-MCP-004_AC-2'] },
    { name: 'MCP input gateway IR-MCP-004 AC-3: webhook rate limit denies before PTY write', run: inputGatewayRedTests['Input_gateway_red_tests_IR-MCP-004_AC-3'] },
    { name: 'MCP input gateway IR-MCP-004 AC-4: webhook stable denial codes precede dispatch', run: inputGatewayRedTests['Input_gateway_red_tests_IR-MCP-004_AC-4'] },
    { name: 'MCP input gateway IR-MCP-004 AC-5: revoked webhook keys do not reactivate delivery', run: inputGatewayRedTests['Input_gateway_red_tests_IR-MCP-004_AC-5'] },
    { name: 'MCP input gateway IR-MCP-004 AC-6: session list self targeting defaults remain explicit', run: inputGatewayRedTests['Input_gateway_red_tests_IR-MCP-004_AC-6'] },
    { name: 'MCP input gateway IR-MCP-004 AC-7: alias target ambiguity rejects before PTY write', run: inputGatewayRedTests['Input_gateway_red_tests_IR-MCP-004_AC-7'] },
    { name: 'MCP input gateway IR-MCP-004 AC-8: close_self failure notification uses gateway', run: inputGatewayRedTests['Input_gateway_red_tests_IR-MCP-004_AC-8'] },
    { name: 'MCP input gateway IR-MCP-004 AC-9: replay code is INPUT_REJECTED_REPLAY_PENDING', run: inputGatewayRedTests['Input_gateway_red_tests_IR-MCP-004_AC-9'] },
    { name: 'MCP input gateway IR-MCP-004 AC-10: close confirmation rejects before side effects', run: inputGatewayRedTests['Input_gateway_red_tests_IR-MCP-004_AC-10'] },
    { name: 'MCP input gateway IR-MCP-005 AC-1: whitelist denial precedence blocks dispatch', run: inputGatewayRedTests['Input_gateway_red_tests_IR-MCP-005_AC-1'] },
    { name: 'MCP input gateway IR-MCP-005 AC-2: prompt preview redaction precedes audit/status', run: inputGatewayRedTests['Input_gateway_red_tests_IR-MCP-005_AC-2'] },
    { name: 'MCP input gateway IR-MCP-005 AC-3: recent audit events are bounded and redacted', run: inputGatewayRedTests['Input_gateway_red_tests_IR-MCP-005_AC-3'] },
    { name: 'MCP input gateway IR-MCP-005 AC-4: forbidden webhook headers reject before gateway write', run: inputGatewayRedTests['Input_gateway_red_tests_IR-MCP-005_AC-4'] },
    { name: 'MCP input gateway IR-MCP-005 AC-5: webhook create or rotate is the only full-secret surface', run: inputGatewayRedTests['Input_gateway_red_tests_IR-MCP-005_AC-5'] },
    { name: 'MCP input gateway IR-MCP-005 AC-6: invalid agentStatus rejects before delivery', run: inputGatewayRedTests['Input_gateway_red_tests_IR-MCP-005_AC-6'] },
    { name: 'MCP input gateway IR-MCP-005 AC-7: legacy bindingLifecycle cannot reach delivery', run: inputGatewayRedTests['Input_gateway_red_tests_IR-MCP-005_AC-7'] },
    { name: 'MCP input gateway IR-MCP-005 AC-8: final replay precedence uses exact stable code', run: inputGatewayRedTests['Input_gateway_red_tests_IR-MCP-005_AC-8'] },
    { name: 'MCP input gateway IR-MCP-005 AC-9: final close confirmation shape precedes lifecycle', run: inputGatewayRedTests['Input_gateway_red_tests_IR-MCP-005_AC-9'] },
    { name: 'MCP input gateway IR-MCP-005 AC-10: non-create webhook surfaces remain masked', run: inputGatewayRedTests['Input_gateway_red_tests_IR-MCP-005_AC-10'] },
    { name: 'MCP transport/tool IR-MCP-001 AC-1: tools/list exposes stable ASCII schemas', run: mcpTransportAndToolRedTests['MCP_transport_and_tool_red_tests_IR-MCP-001_AC-1'] },
    { name: 'MCP transport/tool IR-MCP-001 AC-2: whoami returns current session binding', run: mcpTransportAndToolRedTests['MCP_transport_and_tool_red_tests_IR-MCP-001_AC-2'] },
    { name: 'MCP transport/tool IR-MCP-001 AC-3: claim mints token once and rejects reuse', run: mcpTransportAndToolRedTests['MCP_transport_and_tool_red_tests_IR-MCP-001_AC-3'] },
    { name: 'MCP transport/tool IR-MCP-001 AC-4: validation and policy failures use stable codes', run: mcpTransportAndToolRedTests['MCP_transport_and_tool_red_tests_IR-MCP-001_AC-4'] },
    { name: 'MCP transport/tool IR-MCP-001 AC-5: Streamable HTTP JSON stays UTF-8 with ASCII tool names', run: mcpTransportAndToolRedTests['MCP_transport_and_tool_red_tests_IR-MCP-001_AC-5'] },
    { name: 'MCP Claude Code compatibility: bootstrap session claims before protected tools', run: mcpTransportAndToolRedTests['MCP_Claude_Code_compatibility_bootstrap_session_claims_before_protected_tools'] },
    { name: 'MCP transport/tool OBS-MCP-001 AC-1: tool calls emit redacted audit events', run: mcpTransportAndToolRedTests['MCP_transport_and_tool_red_tests_OBS-MCP-001_AC-1'] },
    { name: 'MCP transport/tool OBS-MCP-001 AC-2: logs and status omit secrets and raw prompts', run: mcpTransportAndToolRedTests['MCP_transport_and_tool_red_tests_OBS-MCP-001_AC-2'] },
    { name: 'MCP transport/tool OBS-MCP-001 AC-3: listener status exposes health and reject counters', run: mcpTransportAndToolRedTests['MCP_transport_and_tool_red_tests_OBS-MCP-001_AC-3'] },
    { name: 'MCP transport/tool OBS-MCP-001 AC-4: live session status omits secret tokens', run: mcpTransportAndToolRedTests['MCP_transport_and_tool_red_tests_OBS-MCP-001_AC-4'] },
    { name: 'MCP transport/tool OBS-MCP-001 AC-5: assignment status remains queryable', run: mcpTransportAndToolRedTests['MCP_transport_and_tool_red_tests_OBS-MCP-001_AC-5'] },
    { name: 'MCP transport/tool OBS-MCP-001 AC-6: coverage manifest names required verification lanes', run: mcpTransportAndToolRedTests['MCP_transport_and_tool_red_tests_OBS-MCP-001_AC-6'] },
    { name: 'MCP transport/tool OBS-MCP-001 AC-7: skipped validation is explicit', run: mcpTransportAndToolRedTests['MCP_transport_and_tool_red_tests_OBS-MCP-001_AC-7'] },
    { name: 'MCP transport/tool SEC-MCP-001 AC-1: default listener is loopback only', run: mcpTransportAndToolRedTests['MCP_transport_and_tool_red_tests_SEC-MCP-001_AC-1'] },
    { name: 'MCP transport/tool SEC-MCP-001 AC-2: whitelist mode requires TLS', run: mcpTransportAndToolRedTests['MCP_transport_and_tool_red_tests_SEC-MCP-001_AC-2'] },
    { name: 'MCP transport/tool SEC-MCP-001 AC-3: forwarded IP trust requires HTTPS trusted proxy', run: mcpTransportAndToolRedTests['MCP_transport_and_tool_red_tests_SEC-MCP-001_AC-3'] },
    { name: 'MCP transport/tool SEC-MCP-001 AC-4: denied requests include redacted error and audit id', run: mcpTransportAndToolRedTests['MCP_transport_and_tool_red_tests_SEC-MCP-001_AC-4'] },
    { name: 'MCP transport/tool SEC-MCP-001 AC-5: successful rebind swaps only MCP listener', run: mcpTransportAndToolRedTests['MCP_transport_and_tool_red_tests_SEC-MCP-001_AC-5'] },
    { name: 'MCP transport/tool SEC-MCP-001 AC-6: failed rebind rolls back listener and config', run: mcpTransportAndToolRedTests['MCP_transport_and_tool_red_tests_SEC-MCP-001_AC-6'] },
    { name: 'MCP agent lifecycle FR-MCP-003 AC-1: profiles use dedicated store', run: agentLifecycleRedTests['Agent_lifecycle_red_tests_FR-MCP-003_AC-1'] },
    { name: 'MCP agent lifecycle FR-MCP-003 AC-2: open_agent preallocates binding before tab spawn', run: agentLifecycleRedTests['Agent_lifecycle_red_tests_FR-MCP-003_AC-2'] },
    { name: 'MCP agent lifecycle FR-MCP-003 AC-3: spawn-time MCP config is injected', run: agentLifecycleRedTests['Agent_lifecycle_red_tests_FR-MCP-003_AC-3'] },
    { name: 'MCP agent lifecycle FR-MCP-003 AC-4: manual mode exposes claim code', run: agentLifecycleRedTests['Agent_lifecycle_red_tests_FR-MCP-003_AC-4'] },
    { name: 'MCP agent lifecycle FR-MCP-003 AC-5: agent command uses SessionInputGateway', run: agentLifecycleRedTests['Agent_lifecycle_red_tests_FR-MCP-003_AC-5'] },
    { name: 'MCP agent lifecycle FR-MCP-003 AC-6: readiness gates kickoff prompt', run: agentLifecycleRedTests['Agent_lifecycle_red_tests_FR-MCP-003_AC-6'] },
    { name: 'MCP agent lifecycle FR-MCP-003 AC-7: update_status refreshes live registry', run: agentLifecycleRedTests['Agent_lifecycle_red_tests_FR-MCP-003_AC-7'] },
    { name: 'MCP agent lifecycle REL-MCP-001 AC-1: pre-tab launch failure compensates', run: agentLifecycleRedTests['Agent_lifecycle_red_tests_REL-MCP-001_AC-1'] },
    { name: 'MCP agent lifecycle REL-MCP-001 AC-2: post-tab launch failure deletes tab once', run: agentLifecycleRedTests['Agent_lifecycle_red_tests_REL-MCP-001_AC-2'] },
    { name: 'MCP agent lifecycle REL-MCP-001 AC-3: readiness timeout leaves session open', run: agentLifecycleRedTests['Agent_lifecycle_red_tests_REL-MCP-001_AC-3'] },
    { name: 'MCP agent lifecycle REL-MCP-001 AC-4: close uses WorkspaceService.deleteTab', run: agentLifecycleRedTests['Agent_lifecycle_red_tests_REL-MCP-001_AC-4'] },
    { name: 'MCP agent lifecycle REL-MCP-001 AC-5: close_self denies sessions without leader', run: agentLifecycleRedTests['Agent_lifecycle_red_tests_REL-MCP-001_AC-5'] },
    { name: 'MCP agent lifecycle REL-MCP-001 AC-6: close_self is deferred after response', run: agentLifecycleRedTests['Agent_lifecycle_red_tests_REL-MCP-001_AC-6'] },
    { name: 'MCP agent lifecycle REL-MCP-001 AC-7: close outcomes remain observable', run: agentLifecycleRedTests['Agent_lifecycle_red_tests_REL-MCP-001_AC-7'] },
    { name: 'MCP agent lifecycle regression: PH-005 tools require scopes before delegation', run: agentLifecycleRedTests['Agent_lifecycle_regression_tool_scope_gate'] },
    { name: 'MCP agent lifecycle regression: gateway rejection triggers launch cleanup', run: agentLifecycleRedTests['Agent_lifecycle_regression_gateway_failure_cleanup'] },
    { name: 'MCP agent lifecycle regression: close_self resolves leader from registry', run: agentLifecycleRedTests['Agent_lifecycle_regression_close_self_registry_leader'] },
    { name: 'MCP agent lifecycle regression: env mode does not create secret config file', run: agentLifecycleRedTests['Agent_lifecycle_regression_env_mode_no_config_file'] },
    { name: 'MCP webhook/control FR-MCP-004 AC-1: create exposes full key once and stores hash only', run: webhookAndControlRestRedTests['Webhook_control_red_tests_FR-MCP-004_AC-1'] },
    { name: 'MCP webhook/control FR-MCP-004 AC-2: query prompt limit rejects oversized GET', run: webhookAndControlRestRedTests['Webhook_control_red_tests_FR-MCP-004_AC-2'] },
    { name: 'MCP webhook/control FR-MCP-004 AC-3: invalid webhook rejects before side effects', run: webhookAndControlRestRedTests['Webhook_control_red_tests_FR-MCP-004_AC-3'] },
    { name: 'MCP webhook/control FR-MCP-004 AC-4: webhook assignment records source 0', run: webhookAndControlRestRedTests['Webhook_control_red_tests_FR-MCP-004_AC-4'] },
    { name: 'MCP webhook/control FR-MCP-004 AC-5: target alias uses MCP search semantics', run: webhookAndControlRestRedTests['Webhook_control_red_tests_FR-MCP-004_AC-5'] },
    { name: 'MCP webhook/control FR-MCP-004 AC-6: no target uses enabled default agent', run: webhookAndControlRestRedTests['Webhook_control_red_tests_FR-MCP-004_AC-6'] },
    { name: 'MCP webhook/control FR-MCP-004 AC-7: webhook audit and list redacts secrets', run: webhookAndControlRestRedTests['Webhook_control_red_tests_FR-MCP-004_AC-7'] },
    { name: 'MCP webhook/control IR-MCP-002 AC-1: config REST is UI-auth only', run: webhookAndControlRestRedTests['Webhook_control_red_tests_IR-MCP-002_AC-1'] },
    { name: 'MCP webhook/control IR-MCP-002 AC-2: agent REST schema is stable', run: webhookAndControlRestRedTests['Webhook_control_red_tests_IR-MCP-002_AC-2'] },
    { name: 'MCP webhook/control IR-MCP-002 AC-3: agent validation returns field errors', run: webhookAndControlRestRedTests['Webhook_control_red_tests_IR-MCP-002_AC-3'] },
    { name: 'MCP webhook/control IR-MCP-002 AC-4: webhook create rotate delete mask correctly', run: webhookAndControlRestRedTests['Webhook_control_red_tests_IR-MCP-002_AC-4'] },
    { name: 'MCP webhook/control IR-MCP-002 AC-5: live session list and alias are redacted', run: webhookAndControlRestRedTests['Webhook_control_red_tests_IR-MCP-002_AC-5'] },
    { name: 'MCP webhook/control IR-MCP-002 AC-6: reply and close reuse MCP policy services', run: webhookAndControlRestRedTests['Webhook_control_red_tests_IR-MCP-002_AC-6'] },
    { name: 'MCP webhook/control IR-MCP-002 AC-7: REST errors are stable and redacted', run: webhookAndControlRestRedTests['Webhook_control_red_tests_IR-MCP-002_AC-7'] },
    { name: 'MCP webhook/control IR-MCP-002 AC-8: one-time webhook URL is not retained', run: webhookAndControlRestRedTests['Webhook_control_red_tests_IR-MCP-002_AC-8'] },
    { name: 'MCP webhook/control IR-MCP-003 AC-1: sessions query uses MCP search semantics', run: webhookAndControlRestRedTests['Webhook_control_red_tests_IR-MCP-003_AC-1'] },
    { name: 'MCP webhook/control IR-MCP-003 AC-2: search-test is read-only', run: webhookAndControlRestRedTests['Webhook_control_red_tests_IR-MCP-003_AC-2'] },
    { name: 'MCP webhook/control IR-MCP-003 AC-3: reply-test routes through SessionInputGateway', run: webhookAndControlRestRedTests['Webhook_control_red_tests_IR-MCP-003_AC-3'] },
    { name: 'MCP webhook/control IR-MCP-003 AC-4: close endpoint requires confirmation', run: webhookAndControlRestRedTests['Webhook_control_red_tests_IR-MCP-003_AC-4'] },
    { name: 'MCP webhook/control IR-MCP-003 AC-5: webhook list is masked', run: webhookAndControlRestRedTests['Webhook_control_red_tests_IR-MCP-003_AC-5'] },
    { name: 'MCP webhook/control IR-MCP-003 AC-6: displayName validation permits duplicate labels by id', run: webhookAndControlRestRedTests['Webhook_control_red_tests_IR-MCP-003_AC-6'] },
    { name: 'MCP webhook/control IR-MCP-003 AC-7: profile validation redacts secret material', run: webhookAndControlRestRedTests['Webhook_control_red_tests_IR-MCP-003_AC-7'] },
    { name: 'MCP webhook/control IR-MCP-003 AC-8: header-only webhook key is accepted', run: webhookAndControlRestRedTests['Webhook_control_red_tests_IR-MCP-003_AC-8'] },
    { name: 'MCP webhook/control IR-MCP-003 AC-9: query/header key conflict rejects', run: webhookAndControlRestRedTests['Webhook_control_red_tests_IR-MCP-003_AC-9'] },
    { name: 'MCP webhook/control IR-MCP-003 AC-10: agentStatus enum is consistent', run: webhookAndControlRestRedTests['Webhook_control_red_tests_IR-MCP-003_AC-10'] },
    { name: 'MCP manual client claim code is UI-auth only and bound to a live session', run: webhookAndControlRestRedTests['MCP_manual_client_claim_code_is_UI_auth_only_and_bound_to_a_live_session'] },
    { name: 'MCP fixed access key rotation is UI-auth only and one-time', run: testMcpFixedAccessKeyControlRotation },
    { name: 'MCP webhook/control IR-MCP-004 AC-1: create/rotate are only full secret surfaces', run: webhookAndControlRestRedTests['Webhook_control_red_tests_IR-MCP-004_AC-1'] },
    { name: 'MCP webhook/control IR-MCP-004 AC-2: webhook header defaults and custom names validate', run: webhookAndControlRestRedTests['Webhook_control_red_tests_IR-MCP-004_AC-2'] },
    { name: 'MCP webhook/control IR-MCP-004 AC-3: rate limit is per key and client IP', run: webhookAndControlRestRedTests['Webhook_control_red_tests_IR-MCP-004_AC-3'] },
    { name: 'MCP webhook/control IR-MCP-004 AC-4: webhook denials use stable codes', run: webhookAndControlRestRedTests['Webhook_control_red_tests_IR-MCP-004_AC-4'] },
    { name: 'MCP webhook/control IR-MCP-004 AC-5: revoke is durable and idempotent', run: webhookAndControlRestRedTests['Webhook_control_red_tests_IR-MCP-004_AC-5'] },
    { name: 'MCP webhook/control IR-MCP-004 AC-6: session list includeSelf defaults true', run: webhookAndControlRestRedTests['Webhook_control_red_tests_IR-MCP-004_AC-6'] },
    { name: 'MCP webhook/control IR-MCP-004 AC-7: session search covers extended fields', run: webhookAndControlRestRedTests['Webhook_control_red_tests_IR-MCP-004_AC-7'] },
    { name: 'MCP webhook/control IR-MCP-004 AC-8: deferred close_self failure notifies leader', run: webhookAndControlRestRedTests['Webhook_control_red_tests_IR-MCP-004_AC-8'] },
    { name: 'MCP webhook/control IR-MCP-004 AC-9: webhook replay denial uses stable code', run: webhookAndControlRestRedTests['Webhook_control_red_tests_IR-MCP-004_AC-9'] },
    { name: 'MCP webhook/control IR-MCP-004 AC-10: close confirmation shape precedes side effects', run: webhookAndControlRestRedTests['Webhook_control_red_tests_IR-MCP-004_AC-10'] },
    { name: 'performGracefulShutdown flushes workspace JSON lastUpdated and tab lastCwd', run: testPerformGracefulShutdownFlushesWorkspaceCwds },
    { name: 'performGracefulShutdown terminates sessions after first workspace flush and final flushes', run: testPerformGracefulShutdownTerminatesSessionsAfterWorkspaceFlush },
    { name: 'performGracefulShutdown degrades timed out session cleanup and still final flushes', run: testPerformGracefulShutdownSessionCleanupTimeoutDegradesAndFinalFlushes },
    { name: 'sessionRoutes accepts shells surfaced by GET /api/sessions/shells', run: testSessionRoutesAcceptSurfacedShells },
    { name: 'SessionManager marks sessions degraded when snapshot serialization fails', run: testSessionManagerDegradedSnapshot },
    { name: 'SessionManager preserves unsnapshotted healthy output when degrading', run: testSessionManagerDirtyCacheDegradedRecovery },
    { name: 'SessionManager preserves queued output when degradation happens before headless writes flush', run: testSessionManagerQueuedOutputDegradedRace },
    { name: 'SessionManager does not duplicate flushed output when later queued output is still pending at degradation time', run: testSessionManagerMixedFlushDegradedRecovery },
    { name: 'SessionManager does not duplicate queued output on direct write failure', run: testSessionManagerWriteFailureNoDuplicate },
    { name: 'SessionManager bounded headless queue degrades on delayed chunk cap overflow', run: testSessionManagerBoundedHeadlessChunkOverflow },
    { name: 'SessionManager bounded headless queue degrades on delayed byte cap overflow', run: testSessionManagerBoundedHeadlessByteOverflow },
    { name: 'SessionManager bounded headless queue counts multibyte output as UTF-8 bytes', run: testSessionManagerBoundedHeadlessMultibyteOverflow },
    { name: 'SessionManager bounded headless overflow clears queue telemetry', run: testSessionManagerBoundedHeadlessOverflowTelemetry },
    { name: 'SessionManager observe headless queue overflow degrades without unbounded pending output', run: testSessionManagerObserveHeadlessOverflowKeepsOutputOrder },
    { name: 'SessionManager observe headless queue preserves bounded pending output on degradation', run: testSessionManagerObserveHeadlessOverflowPreservedOnDegradation },
    { name: 'SessionManager degraded overflow starts ready-subscriber fallback recovery', run: testSessionManagerDegradedOverflowStartsReadySubscriberRecovery },
    { name: 'SessionManager routes bounded output only after headless write commit', run: testSessionManagerBoundedHeadlessOutputRoutesAfterCommit },
    { name: 'SessionManager bounded headless implementation removes pendingOutputChunks hot paths', run: testSessionManagerBoundedHeadlessSourceRemovesLegacyPendingArray },
    { name: 'SessionManager rejects oversized authoritative snapshots without unbounded growth', run: testSessionManagerOversizedSnapshot },
    { name: 'SessionManager authoritative snapshot preserves current alt-screen state', run: testSessionManagerAltScreenSnapshot },
    { name: 'SessionManager sends recoverable degraded fallback output', run: testSessionManagerDegradedOutputRecovery },
    { name: 'Headless snapshot serialization is deterministic for a normal screen', run: testHeadlessSnapshotSerialization },
    { name: 'Headless snapshot serialization reflects resize geometry', run: testHeadlessSnapshotResize },
    { name: 'Headless snapshot serialization preserves alternate-screen state and exit restore', run: testHeadlessSnapshotAltScreen },
    { name: 'Headless snapshot serialization handles an empty screen', run: testHeadlessSnapshotEmptyScreen },
    { name: 'Headless snapshot serialization refuses truncated authoritative payloads', run: testHeadlessSnapshotTruncation },
    { name: 'Headless snapshot serialization is viewport-only and byte-bounded', run: testHeadlessSnapshotViewportOnlyLongScrollback },
    { name: 'Headless screen repair serializes viewport only', run: testHeadlessScreenRepairViewportOnly },
    { name: 'Headless screen repair preserves SGR and cursor metadata', run: testHeadlessScreenRepairSgrAndCursor },
    { name: 'Headless screen repair preserves hidden cursor state', run: testHeadlessScreenRepairHiddenCursor },
    { name: 'SessionManager screen repair debug byteLength uses UTF-8 bytes', run: testSessionManagerScreenRepairDebugByteLengthUsesUtf8Bytes },
    { name: 'SessionManager screen repair rejects alternate buffer mismatch', run: testSessionManagerScreenRepairBufferMismatch },
    { name: 'SessionManager screen repair rejects degraded headless', run: testSessionManagerScreenRepairRejectsDegraded },
    { name: 'Terminal payload truncation skips partial CSI sequences', run: testTerminalPayloadTruncationCsi },
    { name: 'Terminal payload truncation skips partial OSC sequences', run: testTerminalPayloadTruncationOsc },
    { name: 'Terminal payload truncation drops incomplete trailing CSI sequences', run: testTerminalPayloadTruncationIncompleteCsi },
    { name: 'Terminal payload truncation drops incomplete trailing OSC sequences', run: testTerminalPayloadTruncationIncompleteOsc },
    { name: 'Terminal payload truncation removes incomplete trailing escape suffixes', run: testTerminalPayloadTruncationTrailingIncompleteSuffix },
    { name: 'Terminal payload truncation enforces UTF-8 byte caps', run: testTerminalPayloadTruncationUtf8ByteCap },
    { name: 'TerminalTitleDetector emits OSC 0 and OSC 2 titles', run: testTerminalTitleDetectorEmitsOsc0AndOsc2 },
    { name: 'TerminalTitleDetector ignores unsupported and empty titles', run: testTerminalTitleDetectorIgnoresUnsupportedAndEmpty },
    { name: 'TerminalTitleDetector handles chunk-split title sequences', run: testTerminalTitleDetectorHandlesChunkSplit },
    { name: 'TerminalTitleDetector sanitizes and bounds titles', run: testTerminalTitleSanitizer },
    { name: 'TerminalTitleDetector identifies absolute path titles', run: testTerminalTitleAbsolutePathPolicy },
    { name: 'TerminalTitleDetector caps unterminated payloads and recovers', run: testTerminalTitleDetectorCapsAndRecovers },
    { name: 'TerminalTitleDetector releases normal output after an over-cap sequence terminates', run: testTerminalTitleDetectorOverCapTerminatorReleasesSignal },
    { name: 'SessionManager emits terminal title events without changing status', run: testSessionManagerTerminalTitleSignalStaysIdle },
    { name: 'SessionManager detects terminal titles from raw OSC133-mode output', run: testSessionManagerTerminalTitleRawOsc133Mode },
    { name: 'WsRouter sends screen snapshot before flushing queued live output', run: testWsRouterScreenSnapshotOrdering },
    { name: 'WsRouter queues input while replay is pending and flushes after ACK', run: testWsRouterQueuesInputWhileReplayPendingAndFlushesAfterAck },
    { name: 'WsRouter routes screen-repair input barriers through SessionInputGateway', run: testWsRouterRejectsInputDuringScreenRepairThroughGateway },
    { name: 'WsRouter preserves queued input across replay refresh', run: testWsRouterPreservesInputQueueAcrossReplayRefresh },
    { name: 'WsRouter does not flush queued input for stale ACK', run: testWsRouterDoesNotFlushInputForStaleAck },
    { name: 'WsRouter rejects expired replay input on ACK', run: testWsRouterRejectsExpiredReplayInputOnAck },
    { name: 'WsRouter rejects expired replay input on timeout', run: testWsRouterRejectsExpiredReplayInputOnTimeout },
    { name: 'WsRouter rejects Enter input on replay timeout', run: testWsRouterRejectsEnterInputOnReplayTimeout },
    { name: 'WsRouter flushes safe input on replay timeout before ready', run: testWsRouterFlushesSafeInputOnReplayTimeout },
    { name: 'WsRouter exposes replay input queue overflow', run: testWsRouterQueuedInputOverflowIsObservable },
    { name: 'WsRouter rejects invalid input payload', run: testWsRouterRejectsInvalidInputPayload },
    { name: 'WsRouter rejects invalid input sequence range', run: testWsRouterRejectsInvalidInputSequenceRange },
    { name: 'WsRouter sanitizes client input metadata', run: testWsRouterSanitizesClientInputMetadata },
    { name: 'WsRouter emits input:rejected for server reject scenarios', run: testWsRouterEmitsInputRejectedForRealServerScenarios },
    { name: 'WsRouter converts PTY input write failures into server-error rejects', run: testWsRouterInputWriteFailureDoesNotThrow },
    { name: 'WsRouter exposes per-session replay state for MCP input gateway', run: testWsRouterExposesPerSessionReplayState },
    { name: 'WsRouter reports replay observability counters', run: testWsRouterObservabilityCounters },
    { name: 'WsRouter still emits a replay start for degraded sessions', run: testWsRouterDegradedReplayStart },
    { name: 'WsRouter still emits a replay start for oversized snapshots', run: testWsRouterOversizedSnapshotReplayStart },
    { name: 'WsRouter sends viewport-only snapshots on subscribe and resubscribe', run: testWsRouterViewportOnlySnapshotReplayStart },
    { name: 'WsRouter duplicate subscribe does not replay screen snapshot twice', run: testWsRouterDuplicateSubscribeIdempotent },
    { name: 'WsRouter ignores stale replay tokens', run: testWsRouterIgnoresStaleReplayTokens },
    { name: 'WsRouter refreshes replay snapshots on resize while pending', run: testWsRouterRefreshesReplaySnapshotsOnResize },
    { name: 'WsRouter preserves queued output across fallback replay refresh', run: testWsRouterPreservesQueuedOutputAcrossFallbackReplayRefresh },
    { name: 'WsRouter flushes queued output on replay ACK timeout', run: testWsRouterFlushesQueuedOutputOnReplayTimeout },
    { name: 'WsRouter flushes snapshot-covered output on refresh timeout', run: testWsRouterFlushesSnapshotCoveredOutputOnRefreshTimeout },
    { name: 'WsRouter does not treat fallback substring matches as covered output', run: testWsRouterDoesNotTreatFallbackSubstringAsCoveredOutput },
    { name: 'WsRouter does not duplicate fallback-covered output on ACK', run: testWsRouterDoesNotDuplicateFallbackCoveredOutputOnAck },
    { name: 'WsRouter preserves fallback-covered output across repeated refresh ACK', run: testWsRouterPreservesFallbackCoveredOutputAcrossRepeatedRefreshAck },
    { name: 'WsRouter flushes fallback-covered output on refresh timeout', run: testWsRouterFlushesFallbackCoveredOutputOnRefreshTimeout },
    { name: 'WsRouter replay timeout uses UTF-8 byte-bounded tail through router queue', run: testWsRouterReplayTimeoutUsesUtf8ByteBoundedTail },
    { name: 'WsRouter suppresses unchanged empty fallback replay refresh', run: testWsRouterSuppressesUnchangedEmptyFallbackReplayRefresh },
    { name: 'WsRouter safe-send enforce queues output over high-water', run: testWsRouterSafeSendQueuesOutputOverHighWater },
    { name: 'WsRouter safe-send retry timer drains queued output', run: testWsRouterSafeSendRetryTimerDrainsQueuedOutput },
    { name: 'WsRouter safe-send enforce closes hard-limit slow clients', run: testWsRouterSafeSendClosesHardLimitSlowClient },
    { name: 'WsRouter safe-send closes on send callback errors', run: testWsRouterSafeSendClosesOnSendCallbackErrors },
    { name: 'WsRouter safe-send prioritizes independent control over output backlog', run: testWsRouterSafeSendPrioritizesIndependentControlOverOutputBacklog },
    { name: 'WsRouter safe-send queues output on projected high-water pressure', run: testWsRouterSafeSendQueuesProjectedHighWaterOutput },
    { name: 'WsRouter safe-send closes clients on projected hard-limit pressure', run: testWsRouterSafeSendClosesProjectedHardLimitClient },
    { name: 'WsRouter safe-send preserves output queued during in-flight send', run: testWsRouterSafeSendPreservesOutputQueuedDuringInflightSend },
    { name: 'WsRouter safe-send preserves same-session lifecycle ordering', run: testWsRouterSafeSendPreservesSameSessionLifecycleOrdering },
    { name: 'WsRouter direct send callback errors do not enforce close', run: testWsRouterDirectSendCallbackErrorDoesNotClose },
    { name: 'WsRouter observe send callback errors do not enforce close', run: testWsRouterObserveSendCallbackErrorDoesNotClose },
    { name: 'WsRouter safe-send rollback flushes queued output without enforce close', run: testWsRouterSafeSendRollbackFlushesQueuedOutputWithoutClose },
    { name: 'WsRouter safe-send coalesces queued output', run: testWsRouterSafeSendCoalescesQueuedOutput },
    { name: 'WsRouter safe-send respects output coalesce window', run: testWsRouterSafeSendRespectsOutputCoalesceWindow },
    { name: 'WsRouter safe-send closes instead of dropping control messages', run: testWsRouterSafeSendClosesOnControlQueueOverflow },
    { name: 'WsRouter safe-send observe records pressure without queueing', run: testWsRouterSafeSendObserveDoesNotQueue },
    { name: 'WsRouter safe-send preserves replay flush ordering under pressure', run: testWsRouterSafeSendPreservesReplayFlushOrdering },
    { name: 'WsRouter safe-send preserves fallback replay flush ordering under pressure', run: testWsRouterSafeSendPreservesFallbackReplayFlushOrdering },
    { name: 'WsRouter safe-send preserves screen repair flush ordering under pressure', run: testWsRouterSafeSendPreservesScreenRepairFlushOrdering },
    { name: 'SessionManager broadcasts through WsRouter send policy', run: testSessionManagerBroadcastUsesWsRouterPolicy },
    { name: 'WsRouter sends screen repair and queues output until ACK', run: testWsRouterSendsScreenRepairAndQueuesOutputUntilAck },
    { name: 'WsRouter screen repair sent telemetry byteLength uses UTF-8 bytes', run: testWsRouterScreenRepairSentTelemetryByteLengthUsesUtf8Bytes },
    { name: 'WsRouter queues output while screen repair is generating', run: testWsRouterQueuesOutputDuringScreenRepairGeneration },
    { name: 'WsRouter flushes output newer than screen repair snapshot seq', run: testWsRouterFlushesOutputAfterScreenRepairSnapshotSeq },
    { name: 'WsRouter flushes output on screen-repair ACK timeout', run: testWsRouterFlushesScreenRepairOutputOnAckTimeout },
    { name: 'WsRouter flushes covered screen repair output on client failure', run: testWsRouterFlushesCoveredScreenRepairOutputOnFailure },
    { name: 'WsRouter flushes covered screen repair output on ACK timeout', run: testWsRouterFlushesCoveredScreenRepairOutputOnTimeout },
    { name: 'WsRouter flushes output on screen-repair:failed', run: testWsRouterFlushesOutputOnScreenRepairFailed },
    { name: 'WsRouter ignores stale screen repair token', run: testWsRouterIgnoresStaleScreenRepairToken },
    { name: 'WsRouter rejects screen repair during replay pending', run: testWsRouterRejectsScreenRepairDuringReplayPending },
    { name: 'WsRouter aborts screen repair queue overflow without tail trimming', run: testWsRouterScreenRepairQueueOverflowFlushesAllOutput },
    { name: 'WsRouter applies screen repair queue cap using UTF-8 bytes', run: testWsRouterScreenRepairQueueOverflowUsesUtf8Bytes },
    { name: 'WsRouter allows multibyte screen repair output within byte cap', run: testWsRouterScreenRepairQueueAllowsUtf8WithinCap },
    { name: 'WsRouter starts repair replay without geometry change', run: testWsRouterStartsRepairReplayWithoutResize },
    { name: 'WsRouter queues output during repair replay until ACK', run: testWsRouterQueuesOutputDuringRepairReplayUntilAck },
    { name: 'WsRouter does not duplicate deferred degraded payload after fallback snapshot ack', run: testWsRouterNoDuplicateDeferredFallbackPayload },
    { name: 'WsRouter clears replay state when a session is removed', run: testWsRouterClearSessionState },
    { name: 'WorkspaceService restartTab invalidates old session lineage and preserves lastCwd', run: testWorkspaceServiceRestartTab },
    { name: 'WorkspaceService restartTab persists replacement lifecycle before deleting old session', run: testWorkspaceServiceRestartTabPersistsReplacementBeforeDelete },
    { name: 'WorkspaceService restartTab preserves old session when replacement save fails', run: testWorkspaceServiceRestartTabSaveFailurePreservesOldSession },
    { name: 'WorkspaceService restartTab preserves the old session when replacement creation fails', run: testWorkspaceServiceRestartTabCreateFailure },
    { name: 'WorkspaceService deleteWorkspace clears workspace sessions in bulk', run: testWorkspaceServiceDeleteWorkspace },
    { name: 'WorkspaceService deleteWorkspace pre-marks tabs non-recoverable before session cleanup', run: testWorkspaceServiceDeleteWorkspacePreMarksNonRecoverable },
    { name: 'WorkspaceService deleteWorkspace does not terminate sessions when pre-delete save fails', run: testWorkspaceServiceDeleteWorkspaceSaveFailureDoesNotTerminate },
    { name: 'WorkspaceService deleteTab ignores tab-delete finalizer callback after pre-marking', run: testWorkspaceServiceDeleteTabIgnoresDeleteFinalizerCallback },
    { name: 'WorkspaceService deleteTab does not terminate session when pre-delete save fails', run: testWorkspaceServiceDeleteTabSaveFailureDoesNotTerminate },
    { name: 'WorkspaceService moveTab preserves live session and reindexes source and target', run: testWorkspaceServiceMoveTabPreservesLiveSession },
    { name: 'WorkspaceService moveTab appends moved tab to target workspace', run: testWorkspaceServiceMoveTabAppendsToTarget },
    { name: 'WorkspaceService moveTab rejects full target and ended sessions', run: testWorkspaceServiceMoveTabRejectsInvalidTargets },
    { name: 'WorkspaceService moveTab restores state when save fails', run: testWorkspaceServiceMoveTabSaveFailureRestoresState },
    { name: 'WorkspaceService rejects invalid reorder payloads', run: testWorkspaceServiceRejectsInvalidReorderPayloads },
    { name: 'WorkspaceService passes session cleanup reasons', run: testWorkspaceServicePassesSessionCleanupReasons },
    { name: 'WorkspaceService orphan recovery recreates fresh session ids with saved cwd', run: testWorkspaceServiceCheckOrphanTabs },
    { name: 'WorkspaceService orphan recovery skips stopped or non-recoverable tabs', run: testWorkspaceServiceSkipsStoppedOrphanTabs },
    { name: 'WorkspaceService MCP registry excludes active tabs without live runtime sessions', run: testWorkspaceServiceMcpRegistryExcludesNonLiveTabs },
    { name: 'WorkspaceService MCP registry regenerates duplicate persisted session keys', run: testWorkspaceServiceMcpRegistryRegeneratesDuplicateSessionKeys },
    { name: 'WorkspaceService MCP search preserves zero and ambiguous result metadata', run: testWorkspaceServiceMcpSearchPreservesFailureMetadata },
    { name: 'WorkspaceService stores recovery metadata when shell submits codex', run: testWorkspaceServiceStoresCodexRecoveryMetadata },
    { name: 'WorkspaceService stores custom recovery metadata when enabled option exists', run: testWorkspaceServiceStoresCustomRecoveryMetadata },
    { name: 'WorkspaceService marks matched recovery command as foreground', run: testWorkspaceServiceMarksRecoveryForegroundCommand },
    { name: 'WorkspaceService clears recovery metadata when shell command has no enabled option', run: testWorkspaceServiceClearsUnmatchedRecoveryMetadata },
    { name: 'WorkspaceService restartTab schedules codex resume restore after save', run: testWorkspaceServiceRestartSchedulesRecoveryRestore },
    { name: 'WorkspaceService restart uses resolved shell for restore quoting', run: testWorkspaceServiceRestartRestoreUsesResolvedShell },
    { name: 'WorkspaceService orphan recovery schedules claude continue restore after final save', run: testWorkspaceServiceOrphanRecoverySchedulesRestore },
    { name: 'WorkspaceService restart skips and clears disabled recovery option', run: testWorkspaceServiceRestartClearsDisabledRecoveryOption },
    { name: 'WorkspaceService restart skips and clears deleted recovery option', run: testWorkspaceServiceRestartClearsDeletedRecoveryOption },
    { name: 'WorkspaceService orphan recovery skips disabled recovery option', run: testWorkspaceServiceOrphanClearsDisabledRecoveryOption },
    { name: 'WorkspaceService restart does not schedule restore when replacement save fails', run: testWorkspaceServiceRestartSaveFailureDoesNotScheduleRestore },
    { name: 'sessionRoutes direct delete marks workspace-owned tab stopped non-recoverable', run: testSessionRoutesDirectDeleteMarksWorkspaceTabStopped },
    { name: 'sessionRoutes direct delete does not terminate session when pre-delete workspace save fails', run: testSessionRoutesDirectDeleteSaveFailureDoesNotTerminate },
    { name: 'WorkspaceService infers tab name source for default and legacy names', run: testWorkspaceServiceTabNameSourceDefaults },
    { name: 'WorkspaceService applies terminal titles and broadcasts tab metadata changes', run: testWorkspaceServiceApplyTerminalTitle },
    { name: 'WorkspaceService ignores absolute path terminal titles', run: testWorkspaceServiceIgnoresAbsolutePathTerminalTitle },
    { name: 'WorkspaceService preserves user tab names from terminal titles', run: testWorkspaceServiceTerminalTitleRespectsUserName },
    { name: 'WorkspaceService debounces rapid terminal titles to the final value', run: testWorkspaceServiceTerminalTitleDebounce },
    { name: 'WorkspaceService absolute path terminal title cancels pending debounce', run: testWorkspaceServiceAbsolutePathTitleCancelsPendingDebounce },
    { name: 'WorkspaceService manual rename cancels pending terminal title updates', run: testWorkspaceServiceManualRenameCancelsPendingTitle },
    { name: 'WorkspaceService restart cancels pending old-session terminal titles', run: testWorkspaceServiceRestartCancelsPendingTitle },
    { name: 'workspace tab rename route broadcasts normalized tab metadata', run: testWorkspaceTabRenameRouteBroadcastsNormalizedMetadata },
    { name: 'workspace tab move route broadcasts moved tab state', run: testWorkspaceTabMoveRouteBroadcastsMovedState },
    { name: 'CommandPresetService persists CRUD operations and per-kind reorder', run: testCommandPresetServiceCrudAndReorder },
    { name: 'CommandPresetService serializes concurrent mutations', run: testCommandPresetServiceConcurrentCreates },
    { name: 'command preset routes expose CRUD and reject invalid order payloads', run: testCommandPresetRoutesCrudAndValidation },
    { name: 'RecoveryOptionService seeds Claude and Codex defaults once', run: testRecoveryOptionServiceSeedsDefaultsOnce },
    { name: 'RecoveryOptionService finds enabled option by submitted command', run: testRecoveryOptionServiceFindsEnabledSubmittedCommand },
    { name: 'recoveryCommand extracts executable through env assignments and paths', run: testRecoveryCommandExecutableParsing },
    { name: 'recoveryCommand quotes restore arguments per shell', run: testRecoveryCommandRestoreQuoting },
    { name: 'recovery option routes expose authenticated CRUD and reject unauthenticated requests', run: testRecoveryOptionRoutesCrudAndAuth },
    { name: 'TerminalShortcutService persists CRUD operations and validates reserved shortcuts', run: testTerminalShortcutServiceCrudValidationAndRecovery },
    { name: 'TerminalShortcutService serializes concurrent binding creates', run: testTerminalShortcutServiceConcurrentCreates },
    { name: 'terminal shortcut routes expose authenticated CRUD and reject unauthenticated requests', run: testTerminalShortcutRoutesCrudValidationAndAuth },
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

  const testFilter = process.env.BUILDERGATE_TEST_FILTER?.trim().toLowerCase();
  const selectedTests = testFilter
    ? tests.filter(testCase => testCase.name.toLowerCase().includes(testFilter))
    : tests;
  if (testFilter && selectedTests.length === 0) {
    throw new Error(`No tests matched BUILDERGATE_TEST_FILTER=${testFilter}`);
  }

  let failures = 0;

  for (const testCase of selectedTests) {
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

  console.log(`\n${selectedTests.length} test(s) passed`);
}

interface BoundedByteDequeResult {
  ok: boolean;
  reason?: 'byte-limit' | 'chunk-limit';
  pendingBytes: number;
  pendingChunks: number;
  itemBytes?: number;
}

interface BoundedByteDequeSnapshot {
  pendingBytes: number;
  pendingChunks: number;
  rejectedBytes: number;
  rejectedChunks: number;
  maxPendingBytes: number;
  maxPendingChunks: number;
}

interface BoundedByteDequeForTest<T> {
  enqueue(item: T): BoundedByteDequeResult;
  dequeue(): T | undefined;
  clear(): void;
  snapshot(): BoundedByteDequeSnapshot;
}

interface BoundedByteDequeModuleForTest {
  createBoundedByteDeque<T>(options: {
    maxBytes: number;
    maxChunks: number;
    getByteLength: (item: T) => number;
  }): BoundedByteDequeForTest<T>;
}

interface HeadlessOutputQueueSnapshotForTest {
  pendingBytes: number;
  pendingChunks: number;
  overflowCount: number;
  maxPendingBytes: number;
  maxPendingChunks: number;
  oldestPendingAgeMs: number;
  degradedCount: number;
  lastOverflow?: {
    reason: 'byte-limit' | 'chunk-limit';
    policy: 'degrade-headless';
    itemBytes: number;
  };
}

interface HeadlessOutputQueueForTest {
  enqueue(data: string): BoundedByteDequeResult & {
    policy?: 'degrade-headless';
    shouldDegradeHeadless?: boolean;
  };
  dequeue(): { data: string; byteLength: number; queuedAt: number } | undefined;
  clear(): void;
  snapshot(): HeadlessOutputQueueSnapshotForTest;
}

interface HeadlessOutputQueueModuleForTest {
  createHeadlessOutputQueue(options: {
    maxBytes: number;
    maxChunks: number;
    overflowPolicy: 'degrade-headless';
    now?: () => number;
  }): HeadlessOutputQueueForTest;
}

async function importBoundedByteDequeForTest(): Promise<BoundedByteDequeModuleForTest> {
  const modulePath = './utils/boundedByteDeque.js';
  return import(modulePath) as Promise<BoundedByteDequeModuleForTest>;
}

async function importHeadlessOutputQueueForTest(): Promise<HeadlessOutputQueueModuleForTest> {
  const modulePath = './utils/headlessOutputQueue.js';
  return import(modulePath) as Promise<HeadlessOutputQueueModuleForTest>;
}

async function testBoundedByteDequeUtf8ByteCap(): Promise<void> {
  const { createBoundedByteDeque } = await importBoundedByteDequeForTest();
  const queue = createBoundedByteDeque<string>({
    maxBytes: 6,
    maxChunks: 4,
    getByteLength: (item) => Buffer.byteLength(item, 'utf8'),
  });

  assert.equal(Buffer.byteLength('한', 'utf8'), 3);
  assert.equal(Buffer.byteLength('🙂', 'utf8'), 4);
  assert.deepEqual(queue.enqueue('한'), {
    ok: true,
    pendingBytes: 3,
    pendingChunks: 1,
    itemBytes: 3,
  });
  assert.deepEqual(queue.enqueue('글'), {
    ok: true,
    pendingBytes: 6,
    pendingChunks: 2,
    itemBytes: 3,
  });

  const rejected = queue.enqueue('🙂');
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, 'byte-limit');
  assert.equal(rejected.pendingBytes, 6);
  assert.equal(rejected.pendingChunks, 2);
  assert.equal(rejected.itemBytes, 4);
  assert.equal(queue.dequeue(), '한');
  assert.equal(queue.dequeue(), '글');
  assert.equal(queue.dequeue(), undefined);
}

async function testBoundedByteDequeChunkCap(): Promise<void> {
  const { createBoundedByteDeque } = await importBoundedByteDequeForTest();
  const queue = createBoundedByteDeque<string>({
    maxBytes: 1024,
    maxChunks: 2,
    getByteLength: (item) => Buffer.byteLength(item, 'utf8'),
  });

  assert.equal(queue.enqueue('a').ok, true);
  assert.equal(queue.enqueue('b').ok, true);
  const rejected = queue.enqueue('c');
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, 'chunk-limit');
  assert.deepEqual(queue.snapshot(), {
    pendingBytes: 2,
    pendingChunks: 2,
    rejectedBytes: 0,
    rejectedChunks: 1,
    maxPendingBytes: 2,
    maxPendingChunks: 2,
  });
}

async function testBoundedByteDequeFifoWithoutShiftHotPath(): Promise<void> {
  const { createBoundedByteDeque } = await importBoundedByteDequeForTest();
  const queue = createBoundedByteDeque<number>({
    maxBytes: 4096,
    maxChunks: 4096,
    getByteLength: () => 1,
  });

  for (let i = 0; i < 2048; i += 1) {
    assert.equal(queue.enqueue(i).ok, true);
  }

  const originalSlice = Array.prototype.slice;
  let sliceCalls = 0;
  try {
    (Array.prototype as any).slice = function patchedSlice(this: unknown[], ...args: unknown[]) {
      sliceCalls += 1;
      return originalSlice.apply(this, args as [start?: number, end?: number]);
    };
    for (let i = 0; i < 2048; i += 1) {
      assert.equal(queue.dequeue(), i);
    }
  } finally {
    Array.prototype.slice = originalSlice;
  }

  assert.equal(sliceCalls, 0, 'dequeue must not compact by copying arrays on the hot path');
  assert.equal(queue.dequeue(), undefined);
  assert.deepEqual(queue.snapshot(), {
    pendingBytes: 0,
    pendingChunks: 0,
    rejectedBytes: 0,
    rejectedChunks: 0,
    maxPendingBytes: 2048,
    maxPendingChunks: 2048,
  });
}

async function testHeadlessOutputQueueOverflowTelemetry(): Promise<void> {
  const { createHeadlessOutputQueue } = await importHeadlessOutputQueueForTest();
  const queue = createHeadlessOutputQueue({
    maxBytes: 6,
    maxChunks: 2,
    overflowPolicy: 'degrade-headless',
    now: () => 1000,
  });

  assert.equal(queue.enqueue('abc').ok, true);
  const rejected = queue.enqueue('한글');
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, 'byte-limit');
  assert.equal(rejected.policy, 'degrade-headless');
  assert.equal(rejected.shouldDegradeHeadless, true);
  assert.deepEqual(queue.snapshot(), {
    pendingBytes: 3,
    pendingChunks: 1,
    overflowCount: 1,
    maxPendingBytes: 3,
    maxPendingChunks: 1,
    oldestPendingAgeMs: 0,
    degradedCount: 0,
    lastOverflow: {
      reason: 'byte-limit',
      policy: 'degrade-headless',
      itemBytes: 6,
    },
  });

  assert.deepEqual(queue.dequeue(), { data: 'abc', byteLength: 3, queuedAt: 1000 });
  assert.equal(queue.dequeue(), undefined);
}

function testSessionManagerHeadlessQueueRuntimeConfig(): void {
  const fixture = createConfigFixture();
  const resourceLimits = resourceLimitsSchema.parse({
    headless: {
      pendingOutputMaxBytes: 4096,
      pendingOutputMaxChunks: 7,
      writeLagWarnMs: 25,
      writeBatchMaxBytes: 2048,
      overflowPolicy: 'degrade-headless',
    },
  });
  const stabilityModes = stabilityModesSchema.parse({
    headlessQueueMode: 'bounded',
  });
  const manager = new SessionManager({
    pty: fixture.pty,
    session: fixture.session,
    resourceLimits,
    stabilityModes,
  } as any, {
    platform: 'linux',
    execFileSyncFn: (() => Buffer.from('')) as any,
  });

  const runtime = (manager as any).runtimeHeadlessQueueConfig;
  assert.equal(runtime.mode, 'bounded');
  assert.equal(runtime.limits.pendingOutputMaxBytes, 4096);
  assert.equal(runtime.limits.pendingOutputMaxChunks, 7);
  assert.equal(runtime.limits.writeLagWarnMs, 25);
  assert.equal(runtime.limits.writeBatchMaxBytes, 2048);
  assert.equal(runtime.limits.overflowPolicy, 'degrade-headless');

  const defaultManager = new SessionManager({
    pty: fixture.pty,
    session: fixture.session,
  }, {
    platform: 'linux',
    execFileSyncFn: (() => Buffer.from('')) as any,
  });
  const defaultRuntime = (defaultManager as any).runtimeHeadlessQueueConfig;
  assert.equal(defaultRuntime.mode, 'observe');
  assert.equal(defaultRuntime.limits.pendingOutputMaxBytes, 8388608);
  assert.equal(defaultRuntime.limits.pendingOutputMaxChunks, 1024);

  const existingHarness = createManagedSessionHarness(defaultManager);
  try {
    assert.equal(existingHarness.sessionData.headlessQueueMode, 'observe');
    defaultManager.updateRuntimeConfig({
      resourceLimits: {
        headless: {
          pendingOutputMaxBytes: 2048,
          pendingOutputMaxChunks: 3,
          writeLagWarnMs: 10,
          writeBatchMaxBytes: 2048,
          overflowPolicy: 'degrade-headless',
        },
      },
      stabilityModes: {
        headlessQueueMode: 'bounded',
      },
    });
    assert.equal((defaultManager as any).runtimeHeadlessQueueConfig.mode, 'bounded');
    assert.equal(existingHarness.sessionData.headlessQueueMode, 'observe');

    const futureHarness = createManagedSessionHarness(defaultManager);
    try {
      assert.equal(futureHarness.sessionData.headlessQueueMode, 'bounded');
    } finally {
      futureHarness.dispose();
    }
  } finally {
    existingHarness.dispose();
  }
}

function testWsRouterSendRuntimeConfig(): void {
  const resourceLimits = resourceLimitsSchema.parse({
    ws: {
      serverBufferedHighWaterBytes: 4096,
      serverBufferedHardLimitBytes: 8192,
      perClientOutputQueueMaxBytes: 2048,
      perClientControlQueueMaxBytes: 1024,
      outputCoalesceWindowMs: 7,
    },
  });
  const stabilityModes = stabilityModesSchema.parse({
    wsSendMode: 'safe-send-observe',
  });
  const authServiceStub = {
    verifyToken: () => ({ valid: true, payload: { sub: 'test-user' } }),
  } as unknown as AuthService;
  const sessionManagerStub = {
    getSession: () => null,
  } as unknown as SessionManager;
  const router = new WsRouter(authServiceStub, sessionManagerStub, {
    resourceLimits,
    stabilityModes,
  } as any);
  const runtime = (router as any).runtimeSendPolicyConfig;
  assert.equal(runtime.mode, 'safe-send-observe');
  assert.equal(runtime.limits.serverBufferedHighWaterBytes, 4096);
  assert.equal(runtime.limits.serverBufferedHardLimitBytes, 8192);
  assert.equal(runtime.limits.perClientOutputQueueMaxBytes, 2048);
  assert.equal(runtime.limits.perClientControlQueueMaxBytes, 1024);
  assert.equal(runtime.limits.outputCoalesceWindowMs, 7);
  router.destroy();

  const defaultRouter = new WsRouter(authServiceStub, sessionManagerStub);
  const defaultRuntime = (defaultRouter as any).runtimeSendPolicyConfig;
  assert.equal(defaultRuntime.mode, 'direct');
  assert.equal(defaultRuntime.limits.serverBufferedHighWaterBytes, 8388608);
  assert.equal(defaultRuntime.limits.serverBufferedHardLimitBytes, 33554432);
  defaultRouter.destroy();
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

async function testConfigLoaderNativePerformanceP0Overrides(): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'buildergate-config-native-perf-'));
  const configPath = path.join(tempDir, 'config.json5');
  const configContent = createConfigFixtureContent()
    .replace(
      '  session: {\n    idleDelayMs: 200,\n  },',
      `  session: {
    idleDelayMs: 200,
    processCleanup: {
      mode: "enforce",
      gracefulWaitMs: 750,
      forceWaitMs: 1500,
      descendantSampleLimit: 64,
    },
  },`,
    )
    .replace(
      '  twoFactor: {',
      `  resourceLimits: {
    terminal: {
      visibleFlushBudgetBytes: 262144,
    },
  },
  twoFactor: {`,
    );

  await fs.writeFile(configPath, configContent, 'utf-8');

  try {
    const loaded = loadConfigFromPath(configPath, 'win32');
    const schemaDefaultProcessCleanup = sessionProcessCleanupSchema.parse(undefined);
    const terminalLimits = loaded.resourceLimits?.terminal;

    assert.ok(terminalLimits);
    assert.equal(terminalLimits.visibleFlushBudgetBytes, 262144);
    assert.equal(loaded.session.processCleanup?.mode, 'enforce');
    assert.equal(schemaDefaultProcessCleanup.mode, 'observe');
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

function testRuntimeConfigWave6SelectedResourceCapabilities(): void {
  const store = new RuntimeConfigStore(createConfigFixture(), 'linux');
  const capabilities = store.getFieldCapabilities();

  assert.equal(capabilities['resourceLimits.headless.pendingOutputMaxBytes'].available, true);
  assert.equal(capabilities['resourceLimits.headless.pendingOutputMaxChunks'].available, true);
  assert.equal(capabilities['resourceLimits.headless.writeLagWarnMs'].available, false);
  assert.equal(capabilities['resourceLimits.headless.writeBatchMaxBytes'].available, false);
  assert.equal(capabilities['resourceLimits.headless.overflowPolicy'].available, false);
  assert.equal(capabilities['resourceLimits.ws.serverBufferedHighWaterBytes'].available, true);
  assert.equal(capabilities['resourceLimits.ws.serverBufferedHardLimitBytes'].available, true);
  assert.equal(capabilities['resourceLimits.ws.perClientOutputQueueMaxBytes'].available, true);
  assert.equal(capabilities['resourceLimits.ws.perClientControlQueueMaxBytes'].available, false);
  assert.equal(capabilities['resourceLimits.ws.outputCoalesceWindowMs'].available, false);
  assert.equal(capabilities['resourceLimits.terminal.visibleOutputQueueMaxBytes'].available, false);
  assert.equal(capabilities['resourceLimits.terminal.scrollbackLines'].available, false);
  assert.equal(capabilities['stabilityModes.headlessQueueMode'].available, false);
  assert.equal(capabilities['stabilityModes.wsSendMode'].available, false);
  assert.equal(capabilities['stabilityModes.frontendRuntimeResidency'].available, false);
  assert.match(capabilities['stabilityModes.wsSendMode'].reason ?? '', /selected Wave6 Settings field set/);
  assert.equal(capabilities['resourceLimits.telemetry.sampleIntervalMs'].available, false);
  assert.equal(capabilities['resourceLimits.telemetry.recentEventLimit'].available, false);
}

async function testServerStartupWiresWave4LimitsIntoWsRouter(): Promise<void> {
  const sourcePath = path.join(process.cwd(), 'src', 'index.ts');
  const source = await fs.readFile(sourcePath, 'utf-8');

  assert.match(source, /const\s+runtimeValues\s*=\s*runtimeConfigStore\.getEditableValues\(\);/);
  assert.match(source, /new\s+WsRouter\(authService,\s*sessionManager,\s*\{/);
  assert.match(source, /resourceLimits:\s*runtimeValues\.resourceLimits/);
  assert.match(source, /stabilityModes:\s*runtimeValues\.stabilityModes/);
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

async function testSettingsServiceAppliesWave4HeadlessRuntimeSettings(): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'buildergate-settings-wave4-headless-'));
  const configPath = path.join(tempDir, 'config.json5');
  await fs.writeFile(configPath, createConfigFixtureContent(), 'utf-8');

  const fixture = createConfigFixture();
  const cryptoService = new CryptoService('settings-wave4-headless-runtime');
  const runtimeConfigStore = new RuntimeConfigStore(fixture, 'linux');
  const authService = new AuthService(fixture.auth!, cryptoService);
  const sessionManager = new SessionManager({
    pty: fixture.pty,
    session: fixture.session,
    resourceLimits: resourceLimitsSchema.parse(fixture.resourceLimits),
    stabilityModes: stabilityModesSchema.parse(fixture.stabilityModes),
  }, {
    platform: 'linux',
    execFileSyncFn: (() => Buffer.from('')) as any,
  });
  const fileService = new FileService({
    getSession: () => ({ id: 'session-1' }),
    getPtyPid: () => null,
    getInitialCwd: () => tempDir,
    getCwdFilePath: () => null,
  }, fixture.fileManager!);
  const configRepository = new ConfigFileRepository(configPath, 'linux');
  const settingsService = new SettingsService({
    runtimeConfigStore,
    configRepository,
    cryptoService,
    authService,
    getFileService: () => fileService,
    sessionManager,
  }, 'linux');

  try {
    const result = settingsService.savePatch({
      resourceLimits: {
        headless: {
          pendingOutputMaxBytes: 4096,
          pendingOutputMaxChunks: 5,
        },
      },
    });

    assert.ok(result.changedKeys.includes('resourceLimits.headless.pendingOutputMaxBytes'));
    const runtime = (sessionManager as any).runtimeHeadlessQueueConfig;
    assert.equal(runtime.mode, 'observe');
    assert.equal(runtime.limits.pendingOutputMaxBytes, 4096);
    assert.equal(runtime.limits.pendingOutputMaxChunks, 5);
    assert.equal(runtime.limits.writeLagWarnMs, 500);
    assert.equal(runtime.limits.writeBatchMaxBytes, 65536);
  } finally {
    authService.destroy();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function testSettingsServiceAppliesWave4WsRuntimeSettings(): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'buildergate-settings-wave4-ws-'));
  const configPath = path.join(tempDir, 'config.json5');
  await fs.writeFile(configPath, createConfigFixtureContent(), 'utf-8');

  const fixture = createConfigFixture();
  const cryptoService = new CryptoService('settings-wave4-ws-runtime');
  const runtimeConfigStore = new RuntimeConfigStore(fixture, 'linux');
  const authService = new AuthService(fixture.auth!, cryptoService);
  const sessionManager = new SessionManager({
    pty: fixture.pty,
    session: fixture.session,
    resourceLimits: resourceLimitsSchema.parse(fixture.resourceLimits),
    stabilityModes: stabilityModesSchema.parse(fixture.stabilityModes),
  }, {
    platform: 'linux',
    execFileSyncFn: (() => Buffer.from('')) as any,
  });
  const routerAuthService = {
    verifyToken: () => ({ valid: true, payload: { sub: 'test-user' } }),
  } as unknown as AuthService;
  const router = new WsRouter(routerAuthService, sessionManager);
  const fileService = new FileService({
    getSession: () => ({ id: 'session-1' }),
    getPtyPid: () => null,
    getInitialCwd: () => tempDir,
    getCwdFilePath: () => null,
  }, fixture.fileManager!);
  const configRepository = new ConfigFileRepository(configPath, 'linux');
  const settingsService = new SettingsService({
    runtimeConfigStore,
    configRepository,
    cryptoService,
    authService,
    getFileService: () => fileService,
    sessionManager,
    getWsRouter: () => router,
  } as any, 'linux');

  try {
    const result = settingsService.savePatch({
      resourceLimits: {
        ws: {
          serverBufferedHighWaterBytes: 4096,
          serverBufferedHardLimitBytes: 8192,
          perClientOutputQueueMaxBytes: 2048,
        },
      },
    });

    assert.ok(result.changedKeys.includes('resourceLimits.ws.serverBufferedHighWaterBytes'));
    assert.ok(result.applySummary.immediate.includes('resourceLimits.ws.serverBufferedHighWaterBytes'));
    assert.equal(result.applySummary.new_sessions.includes('resourceLimits.ws.serverBufferedHighWaterBytes'), false);
    const runtime = (router as any).runtimeSendPolicyConfig;
    assert.equal(runtime.mode, 'direct');
    assert.equal(runtime.limits.serverBufferedHighWaterBytes, 4096);
    assert.equal(runtime.limits.serverBufferedHardLimitBytes, 8192);
    assert.equal(runtime.limits.perClientOutputQueueMaxBytes, 2048);
    assert.equal(runtime.limits.perClientControlQueueMaxBytes, 262144);
    assert.equal(runtime.limits.outputCoalesceWindowMs, 16);
  } finally {
    router.destroy();
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
      resourceLimits: resourceLimitsSchema.parse(fixture.resourceLimits),
      stabilityModes: stabilityModesSchema.parse(fixture.stabilityModes),
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
    headlessOutputQueue: createHeadlessOutputQueueForHarness({
      maxBytes: 1024 * 1024,
      maxChunks: 1024,
      overflowPolicy: 'degrade-headless',
    }),
    headlessQueueMode: 'observe',
    pendingHeadlessOutputs: new Map(),
    pendingHeadlessOutputBytes: 0,
    maxPendingHeadlessOutputBytes: 0,
    maxPendingHeadlessOutputChunks: 0,
    nextHeadlessOutputId: 0,
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
  sessionOverrides: { idleDelayMs?: number; runningDelayMs?: number; writeError?: Error } = {},
) {
  let onDataHandler: ((data: string) => void) | null = null;
  let killCalled = false;
  const writes: string[] = [];
  const { writeError, ...timingOverrides } = sessionOverrides;
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
      ...timingOverrides,
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
        write(input: string) {
          if (writeError) {
            throw writeError;
          }
          writes.push(input);
        },
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
    writes,
    cleanup() {
      assert.equal(manager.deleteSession(session.id), true);
      assert.equal(killCalled, true);
    },
  };
}

function readCleanupTelemetry(manager: SessionManager): any {
  return (manager.getObservabilitySnapshot() as any).cleanup;
}

function createProcessCleanupSessionHarness(options: {
  pid?: number | null;
  platform?: NodeJS.Platform;
  shell?: ShellType;
  useConpty?: boolean;
  windowsPowerShellBackend?: 'inherit' | 'conpty' | 'winpty';
  execFileSyncFn?: (...args: any[]) => any;
  readProcessStartIdentityFn?: (...args: any[]) => Promise<string | null>;
  processCleanup?: Partial<{
    mode: 'legacy' | 'observe' | 'enforce';
    gracefulWaitMs: number;
    forceWaitMs: number;
    descendantSampleLimit: number;
  }>;
  processInspector?: (...args: any[]) => any;
  processTreeTerminator?: ProcessTreeTerminator;
} = {}) {
  let exitHandler: ((event: { exitCode: number; signal?: number }) => void) | null = null;
  let killCalls = 0;
  const ptyPid = options.pid === null ? undefined : options.pid ?? 4321;
  const platform = options.platform ?? 'linux';
  const shell = options.shell ?? 'bash';
  const deps: any = {
    platform,
    spawnPty: ((spawnShell: string, spawnArgs: string[], spawnOptions: { cols?: number; rows?: number }) => {
      return {
        pid: ptyPid,
        cols: spawnOptions.cols ?? 80,
        rows: spawnOptions.rows ?? 24,
        process: spawnShell,
        handleFlowControl: false,
        onData() { return { dispose() {} }; },
        onExit(callback: (event: { exitCode: number; signal?: number }) => void) {
          exitHandler = callback;
          return { dispose() {} };
        },
        write() {},
        resize() {},
        kill() { killCalls += 1; },
        __spawnArgs: spawnArgs,
      } as any;
    }) as any,
  };
  if (options.execFileSyncFn) {
    deps.execFileSyncFn = options.execFileSyncFn;
  }
  if (options.readProcessStartIdentityFn) {
    deps.readProcessStartIdentityFn = options.readProcessStartIdentityFn;
  }
  if (options.processInspector) {
    deps.processInspector = options.processInspector;
  }
  if (options.processTreeTerminator) {
    deps.processTreeTerminator = options.processTreeTerminator;
  }

  const manager = new SessionManager({
    pty: {
      termName: 'xterm-256color',
      defaultCols: 80,
      defaultRows: 24,
      useConpty: options.useConpty ?? platform === 'win32',
      windowsPowerShellBackend: options.windowsPowerShellBackend ?? 'inherit',
      scrollbackLines: 1000,
      maxSnapshotBytes: 1024,
      shell,
    },
    session: {
      idleDelayMs: 40,
      runningDelayMs: 40,
      processCleanup: {
        mode: 'observe',
        gracefulWaitMs: 750,
        forceWaitMs: 1500,
        descendantSampleLimit: 64,
        ...options.processCleanup,
      },
    },
  } as any, deps);

  (manager as any).isCommandAvailable = (cmd: string) => ['bash', 'sh', 'powershell', 'powershell.exe', 'pwsh', 'cmd', 'cmd.exe'].includes(cmd.toLowerCase());
  const session = manager.createSession('Cleanup Session', shell, process.cwd());

  return {
    manager,
    session,
    get sessionData() {
      return (manager as any).sessions.get(session.id);
    },
    getKillCalls() {
      return killCalls;
    },
    exit(exitCode = 0) {
      if (!exitHandler) {
        throw new Error('Expected PTY onExit handler to be registered');
      }
      exitHandler({ exitCode });
    },
    cleanupIfActive() {
      if ((manager as any).sessions.has(session.id)) {
        manager.deleteSession(session.id);
      }
    },
  };
}

function testSessionManagerRecordsObserveCleanupTelemetryOnDelete(): void {
  const inspectorCalls: any[] = [];
  const harness = createProcessCleanupSessionHarness({
    processInspector: (metadata: any, limit: number) => {
      inspectorCalls.push({ metadata, limit });
      return { status: 'observed', remainingDescendants: 2 };
    },
  });

  try {
    const processMetadata = harness.sessionData.processMetadata;
    assert.equal(processMetadata.rootPid, 4321);
    assert.equal(processMetadata.shellCommand, 'bash');
    assert.deepEqual(processMetadata.shellArgs, []);
    assert.equal(processMetadata.cwd, process.cwd());
    assert.equal(processMetadata.platform, 'linux');
    assert.equal(processMetadata.backend, 'unix');
    assert.equal(typeof processMetadata.launchedAt, 'string');
    assert.equal(processMetadata.osStartIdentity, null);

    assert.equal(harness.manager.deleteSession(harness.session.id), true);
    assert.equal(harness.getKillCalls(), 1);
    assert.equal(inspectorCalls.length, 1);
    assert.equal(inspectorCalls[0].limit, 64);

    const cleanup = readCleanupTelemetry(harness.manager);
    assert.equal(cleanup.mode, 'observe');
    assert.equal(cleanup.attempted, 1);
    assert.equal(cleanup.completed, 1);
    assert.equal(cleanup.degraded, 0);
    assert.equal(cleanup.unverifiedSkipped, 0);
    assert.equal(cleanup.recentResults.length, 1);
    assert.equal(cleanup.recentResults[0].sessionId, harness.session.id);
    assert.equal(cleanup.recentResults[0].reason, 'direct-session-delete');
    assert.equal(cleanup.recentResults[0].rootPid, 4321);
    assert.equal(cleanup.recentResults[0].remainingDescendants, 2);
    assert.equal(cleanup.recentResults[0].cleanupStatus, 'observed');
    assert.equal(typeof cleanup.recentResults[0].recordedAt, 'string');
  } finally {
    harness.cleanupIfActive();
  }
}

function testSessionManagerFinalizesNaturalProcessExitOnce(): void {
  const harness = createProcessCleanupSessionHarness({
    processInspector: () => ({ status: 'observed', remainingDescendants: 0 }),
  });
  const sentMessages: any[] = [];
  const wsRouter = {
    sendSessionEvent(sessionId: string, event: string, payload: object) {
      assert.equal(sessionId, harness.session.id);
      sentMessages.push({ type: event, sessionId, ...payload });
    },
    clearSessionState(sessionId: string) {
      assert.equal(sessionId, harness.session.id);
    },
    disableDebugReplayCapture(sessionId: string) {
      assert.equal(sessionId, harness.session.id);
    },
    clearReplayEvents(sessionId: string) {
      assert.equal(sessionId, harness.session.id);
    },
  };
  harness.manager.setWsRouter(wsRouter as any);
  (harness.manager as any).pendingResizeReplaySessions.add(harness.session.id);
  (harness.manager as any).pendingResizeReplayStartedAt.set(harness.session.id, Date.now());
  (harness.manager as any).pendingResizeReplayLastOutputAt.set(harness.session.id, Date.now());

  try {
    const sessionData = harness.sessionData;
    assert.ok(sessionData);
    if (sessionData.cwdFilePath) {
      fsSyncWriteFile(sessionData.cwdFilePath, process.cwd());
    }

    harness.exit(0);

    const cleanup = readCleanupTelemetry(harness.manager);
    assert.equal(cleanup.attempted, 1);
    assert.equal(cleanup.completed, 1);
    assert.equal(cleanup.recentResults.length, 1);
    assert.equal(cleanup.recentResults[0].reason, 'process-exit');
    assert.equal(harness.getKillCalls(), 0);
    assert.equal(harness.manager.getSession(harness.session.id), null);
    assert.equal((harness.manager as any).sessions.has(harness.session.id), false);
    assert.equal(harness.manager.deleteSession(harness.session.id), false);
    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0].type, 'session:exited');
    assert.equal(sentMessages[0].sessionId, harness.session.id);
    assert.equal(sentMessages[0].exitCode, 0);
    assert.equal(sessionData.finalized, true);
    assert.equal(sessionData.headless, null);
    assert.equal((harness.manager as any).pendingResizeReplaySessions.has(harness.session.id), false);
    assert.equal((harness.manager as any).pendingResizeReplayStartedAt.has(harness.session.id), false);
    assert.equal((harness.manager as any).pendingResizeReplayLastOutputAt.has(harness.session.id), false);
    if (sessionData.cwdFilePath) {
      assert.equal(existsSync(sessionData.cwdFilePath), false);
    }
  } finally {
    harness.cleanupIfActive();
  }
}

function testSessionManagerDoesNotDoubleCountDeleteThenProcessExit(): void {
  const harness = createProcessCleanupSessionHarness({
    processInspector: () => ({ status: 'observed', remainingDescendants: 0 }),
  });

  try {
    assert.equal(harness.manager.deleteSession(harness.session.id), true);
    const afterDelete = readCleanupTelemetry(harness.manager);
    assert.equal(afterDelete.attempted, 1);
    assert.equal(afterDelete.recentResults[0].reason, 'direct-session-delete');

    harness.exit(0);

    const afterLateExit = readCleanupTelemetry(harness.manager);
    assert.equal(afterLateExit.attempted, 1);
    assert.equal(afterLateExit.completed, 1);
    assert.equal(afterLateExit.recentResults.length, 1);
    assert.equal(afterLateExit.recentResults[0].reason, 'direct-session-delete');
    assert.equal(harness.getKillCalls(), 1);
    assert.equal(harness.manager.deleteSession(harness.session.id), false);
  } finally {
    harness.cleanupIfActive();
  }
}

function testSessionManagerDefaultCleanupInspectorSkipsUnverified(): void {
  const harness = createProcessCleanupSessionHarness();

  try {
    assert.equal(harness.sessionData.processMetadata.rootPid, 4321);
    assert.equal(harness.sessionData.processMetadata.osStartIdentity, null);
    assert.equal(harness.manager.deleteSession(harness.session.id), true);

    const cleanup = readCleanupTelemetry(harness.manager);
    assert.equal(cleanup.attempted, 1);
    assert.equal(cleanup.completed, 0);
    assert.equal(cleanup.degraded, 0);
    assert.equal(cleanup.unverifiedSkipped, 1);
    assert.equal(cleanup.recentResults[0].cleanupStatus, 'skipped-unverified');
  } finally {
    harness.cleanupIfActive();
  }
}

function testSessionManagerCleanupTelemetryRecordsUnverifiedSkip(): void {
  let inspectorCalled = false;
  const harness = createProcessCleanupSessionHarness({
    pid: null,
    processInspector: () => {
      inspectorCalled = true;
      return { status: 'skipped-unverified', remainingDescendants: 0 };
    },
  });

  try {
    assert.equal(harness.sessionData.processMetadata.rootPid, null);
    assert.equal(harness.manager.deleteSession(harness.session.id), true);
    assert.equal(harness.getKillCalls(), 1);
    assert.equal(inspectorCalled, true);

    const cleanup = readCleanupTelemetry(harness.manager);
    assert.equal(cleanup.attempted, 1);
    assert.equal(cleanup.completed, 0);
    assert.equal(cleanup.degraded, 0);
    assert.equal(cleanup.unverifiedSkipped, 1);
    assert.equal(cleanup.recentResults[0].cleanupStatus, 'skipped-unverified');
    assert.equal(cleanup.recentResults[0].rootPid, null);
  } finally {
    harness.cleanupIfActive();
  }
}

function testSessionManagerCleanupTelemetryBoundsRecentResults(): void {
  const harness = createProcessCleanupSessionHarness({
    processInspector: () => ({ status: 'observed', remainingDescendants: 0 }),
  });

  try {
    assert.equal(harness.manager.deleteSession(harness.session.id), true);
    for (let index = 1; index < 70; index += 1) {
      const session = harness.manager.createSession(`Cleanup ${index}`, 'bash', process.cwd());
      assert.equal(harness.manager.deleteSession(session.id), true);
    }

    const cleanup = readCleanupTelemetry(harness.manager);
    assert.equal(cleanup.attempted, 70);
    assert.equal(cleanup.completed, 70);
    assert.equal(cleanup.recentResults.length, 64);
  } finally {
    harness.cleanupIfActive();
  }
}

async function testProcessTreeTerminatorSkipsWithoutIdentity(): Promise<void> {
  const killCalls: number[] = [];
  const terminator = new DefaultProcessTreeTerminator({
    platform: 'linux',
    killFn: (pid: number) => {
      killCalls.push(pid);
    },
    processInfoProvider: async (pid: number) => ({
      pid,
      running: true,
      startIdentity: 'procfs:123:live',
      childPids: [456],
    }),
  });

  const result = await terminator.terminate({
    rootPid: 123,
    shellCommand: 'bash',
    shellArgs: [],
    shellType: 'bash',
    cwd: process.cwd(),
    platform: 'linux',
    backend: 'unix',
    launchedAt: new Date().toISOString(),
    osStartIdentity: null,
  }, {
    gracefulWaitMs: 0,
    forceWaitMs: 0,
    descendantSampleLimit: 16,
  });

  assert.equal(result.status, 'skipped-unverified');
  assert.deepEqual(result.terminatedPids, []);
  assert.deepEqual(result.unverifiedPids, [123]);
  assert.deepEqual(killCalls, []);
}

async function testProcessTreeTerminatorRejectsIdentityMismatch(): Promise<void> {
  const killCalls: number[] = [];
  const terminator = new DefaultProcessTreeTerminator({
    platform: 'linux',
    killFn: (pid: number) => {
      killCalls.push(pid);
    },
    processInfoProvider: async (pid: number) => ({
      pid,
      running: true,
      startIdentity: 'procfs:123:new-start',
      cwd: process.cwd(),
      childPids: [456],
    }),
  });

  const result = await terminator.terminate({
    rootPid: 123,
    shellCommand: 'bash',
    shellArgs: [],
    shellType: 'bash',
    cwd: process.cwd(),
    platform: 'linux',
    backend: 'unix',
    launchedAt: new Date().toISOString(),
    osStartIdentity: 'procfs:123:old-start',
  }, {
    gracefulWaitMs: 0,
    forceWaitMs: 0,
    descendantSampleLimit: 16,
  });

  assert.equal(result.status, 'skipped-unverified');
  assert.match(result.message ?? '', /identity/);
  assert.deepEqual(result.terminatedPids, []);
  assert.deepEqual(killCalls, []);
}

async function testProcessTreeTerminatorSkipsPosixMissingCwd(): Promise<void> {
  const killCalls: number[] = [];
  const terminator = new DefaultProcessTreeTerminator({
    platform: 'linux',
    killFn: (pid: number) => {
      killCalls.push(pid);
    },
    processInfoProvider: async (pid: number) => ({
      pid,
      running: true,
      startIdentity: 'procfs:123:started',
      cwd: null,
      childPids: [456],
    }),
  });

  const result = await terminator.terminate({
    rootPid: 123,
    shellCommand: 'bash',
    shellArgs: [],
    shellType: 'bash',
    cwd: process.cwd(),
    platform: 'linux',
    backend: 'unix',
    launchedAt: new Date().toISOString(),
    osStartIdentity: 'procfs:123:started',
  }, {
    gracefulWaitMs: 0,
    forceWaitMs: 0,
    descendantSampleLimit: 16,
  });

  assert.equal(result.status, 'skipped-unverified');
  assert.match(result.message ?? '', /cwd is unavailable/);
  assert.deepEqual(result.terminatedPids, []);
  assert.deepEqual(result.unverifiedPids, [123]);
  assert.deepEqual(killCalls, []);
}

async function testProcessTreeTerminatorSkipsCwdMismatch(): Promise<void> {
  const killCalls: number[] = [];
  const terminator = new DefaultProcessTreeTerminator({
    platform: 'linux',
    killFn: (pid: number) => {
      killCalls.push(pid);
    },
    processInfoProvider: async (pid: number) => ({
      pid,
      running: true,
      startIdentity: 'procfs:123:started',
      cwd: '/different/cwd',
      childPids: [456],
    }),
  });

  const result = await terminator.terminate({
    rootPid: 123,
    shellCommand: 'bash',
    shellArgs: [],
    shellType: 'bash',
    cwd: process.cwd(),
    platform: 'linux',
    backend: 'unix',
    launchedAt: new Date().toISOString(),
    osStartIdentity: 'procfs:123:started',
  }, {
    gracefulWaitMs: 0,
    forceWaitMs: 0,
    descendantSampleLimit: 16,
  });

  assert.equal(result.status, 'skipped-unverified');
  assert.match(result.message ?? '', /cwd does not match/);
  assert.deepEqual(result.terminatedPids, []);
  assert.deepEqual(result.unverifiedPids, [123]);
  assert.deepEqual(killCalls, []);
}

async function testProcessTreeTerminatorWindowsTaskkillByPid(): Promise<void> {
  let providerCalls = 0;
  const execCalls: Array<{ file: string; args: string[]; options: any }> = [];
  const terminator = new DefaultProcessTreeTerminator({
    platform: 'win32',
    processInfoProvider: async (pid: number) => {
      providerCalls += 1;
      if (providerCalls === 1) {
        return {
          pid,
          running: true,
          startIdentity: 'win32:123:started',
          childPids: [456],
        };
      }
      return {
        pid,
        running: false,
        startIdentity: 'win32:123:started',
        childPids: [],
      };
    },
    execFileFn: ((file: string, args: string[], options: any, callback: (error: Error | null, stdout?: string, stderr?: string) => void) => {
      execCalls.push({ file, args, options });
      callback(null, '', '');
      return {} as any;
    }) as any,
  });

  const result = await terminator.terminate({
    rootPid: 123,
    shellCommand: 'powershell.exe',
    shellArgs: [],
    shellType: 'powershell',
    cwd: 'C:/repo',
    platform: 'win32',
    backend: 'conpty',
    launchedAt: new Date().toISOString(),
    osStartIdentity: 'win32:123:started',
  }, {
    gracefulWaitMs: 0,
    forceWaitMs: 0,
    descendantSampleLimit: 16,
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.method, 'windows-taskkill-tree');
  assert.equal(execCalls.length, 1);
  assert.equal(execCalls[0].file, 'taskkill.exe');
  assert.deepEqual(execCalls[0].args, ['/PID', '123', '/T', '/F']);
  assert.equal(execCalls[0].options.shell, false);
  assert.equal(execCalls[0].options.windowsHide, true);
}

async function testProcessTreeTerminatorWindowsTaskkillFailureReportsFailed(): Promise<void> {
  const terminator = new DefaultProcessTreeTerminator({
    platform: 'win32',
    processInfoProvider: async (pid: number) => ({
      pid,
      running: true,
      startIdentity: 'win32:123:started',
      childPids: [456],
    }),
    execFileFn: ((_file: string, _args: string[], _options: any, callback: (error: Error | null, stdout?: string, stderr?: string) => void) => {
      callback(new Error('taskkill failed'), '', '');
      return {} as any;
    }) as any,
  });

  const result = await terminator.terminate({
    rootPid: 123,
    shellCommand: 'powershell.exe',
    shellArgs: [],
    shellType: 'powershell',
    cwd: 'C:/repo',
    platform: 'win32',
    backend: 'conpty',
    launchedAt: new Date().toISOString(),
    osStartIdentity: 'win32:123:started',
  }, {
    gracefulWaitMs: 0,
    forceWaitMs: 0,
    descendantSampleLimit: 16,
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.method, 'windows-taskkill-tree');
  assert.deepEqual(result.terminatedPids, []);
  assert.deepEqual(result.remainingPids, [123, 456]);
  assert.match(result.message ?? '', /taskkill failed/);
}

async function testProcessTreeTerminatorSkipsWslWithoutLinuxIdentity(): Promise<void> {
  const execCalls: Array<{ file: string; args: string[] }> = [];
  const terminator = new DefaultProcessTreeTerminator({
    platform: 'win32',
    processInfoProvider: async (pid: number) => ({
      pid,
      running: true,
      startIdentity: 'win32:123:started',
      childPids: [456],
    }),
    execFileFn: ((file: string, args: string[], _options: any, callback: (error: Error | null, stdout?: string, stderr?: string) => void) => {
      execCalls.push({ file, args });
      callback(null, '', '');
      return {} as any;
    }) as any,
  });

  const result = await terminator.terminate({
    rootPid: 123,
    shellCommand: 'wsl.exe',
    shellArgs: [],
    shellType: 'wsl',
    cwd: 'C:/repo',
    platform: 'win32',
    backend: 'wsl',
    launchedAt: new Date().toISOString(),
    osStartIdentity: 'win32:123:started',
  }, {
    gracefulWaitMs: 0,
    forceWaitMs: 0,
    descendantSampleLimit: 16,
  });

  assert.equal(result.status, 'skipped-unverified');
  assert.match(result.message ?? '', /WSL/);
  assert.deepEqual(result.terminatedPids, []);
  assert.deepEqual(result.unverifiedPids, [123]);
  assert.deepEqual(execCalls, []);
}

async function testProcessTreeTerminatorPosixLeafFirstWhenPgidUnverified(): Promise<void> {
  let providerCalls = 0;
  const killCalls: Array<{ pid: number; signal?: NodeJS.Signals | number }> = [];
  const terminator = new DefaultProcessTreeTerminator({
    platform: 'linux',
    killFn: (pid: number, signal?: NodeJS.Signals | number) => {
      killCalls.push({ pid, signal });
    },
    processInfoProvider: async (pid: number) => {
      providerCalls += 1;
      if (providerCalls === 1) {
        return {
          pid,
          running: true,
          startIdentity: 'procfs:123:started',
          cwd: process.cwd(),
          processGroupId: 999,
          childPids: [200, 300],
        };
      }
      return {
        pid,
        running: false,
        startIdentity: 'procfs:123:started',
        cwd: process.cwd(),
        processGroupId: 999,
        childPids: [],
      };
    },
  });

  const result = await terminator.terminate({
    rootPid: 123,
    shellCommand: 'bash',
    shellArgs: [],
    shellType: 'bash',
    cwd: process.cwd(),
    platform: 'linux',
    backend: 'unix',
    launchedAt: new Date().toISOString(),
    osStartIdentity: 'procfs:123:started',
  }, {
    gracefulWaitMs: 0,
    forceWaitMs: 0,
    descendantSampleLimit: 16,
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.method, 'posix-leaf-first');
  assert.deepEqual(killCalls, [
    { pid: 300, signal: 'SIGTERM' },
    { pid: 200, signal: 'SIGTERM' },
    { pid: 123, signal: 'SIGTERM' },
  ]);
  assert.equal(killCalls.some(call => call.pid === -123), false);
}

async function testProcessTreeTerminatorDoesNotUsePgidFromRootAlone(): Promise<void> {
  let providerCalls = 0;
  const killCalls: Array<{ pid: number; signal?: NodeJS.Signals | number }> = [];
  const terminator = new DefaultProcessTreeTerminator({
    platform: 'linux',
    killFn: (pid: number, signal?: NodeJS.Signals | number) => {
      killCalls.push({ pid, signal });
    },
    processInfoProvider: async (pid: number) => {
      providerCalls += 1;
      if (providerCalls === 1) {
        return {
          pid,
          running: true,
          startIdentity: 'procfs:123:started',
          cwd: process.cwd(),
          processGroupId: 123,
          childPids: [200],
        };
      }
      return {
        pid,
        running: false,
        startIdentity: 'procfs:123:started',
        cwd: process.cwd(),
        processGroupId: 123,
        childPids: [],
      };
    },
  });

  const result = await terminator.terminate({
    rootPid: 123,
    shellCommand: 'bash',
    shellArgs: [],
    shellType: 'bash',
    cwd: process.cwd(),
    platform: 'linux',
    backend: 'unix',
    launchedAt: new Date().toISOString(),
    osStartIdentity: 'procfs:123:started',
  }, {
    gracefulWaitMs: 0,
    forceWaitMs: 0,
    descendantSampleLimit: 16,
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.method, 'posix-leaf-first');
  assert.equal(killCalls.some(call => call.pid < 0), false);
  assert.deepEqual(killCalls, [
    { pid: 200, signal: 'SIGTERM' },
    { pid: 123, signal: 'SIGTERM' },
  ]);
}

async function testProcessTreeTerminatorForceKillsVerifiedRemainingRoot(): Promise<void> {
  let providerCalls = 0;
  const killCalls: Array<{ pid: number; signal?: NodeJS.Signals | number }> = [];
  const terminator = new DefaultProcessTreeTerminator({
    platform: 'linux',
    killFn: (pid: number, signal?: NodeJS.Signals | number) => {
      killCalls.push({ pid, signal });
    },
    processInfoProvider: async (pid: number) => {
      providerCalls += 1;
      if (providerCalls === 1) {
        return {
          pid,
          running: true,
          startIdentity: 'procfs:123:started',
          cwd: process.cwd(),
          processGroupId: 999,
          childPids: [200],
        };
      }
      if (providerCalls === 2) {
        return {
          pid,
          running: true,
          startIdentity: 'procfs:123:started',
          cwd: process.cwd(),
          processGroupId: 999,
          childPids: [],
        };
      }
      return {
        pid,
        running: false,
        startIdentity: 'procfs:123:started',
        cwd: process.cwd(),
        processGroupId: 999,
        childPids: [],
      };
    },
  });

  const result = await terminator.terminate({
    rootPid: 123,
    shellCommand: 'bash',
    shellArgs: [],
    shellType: 'bash',
    cwd: process.cwd(),
    platform: 'linux',
    backend: 'unix',
    launchedAt: new Date().toISOString(),
    osStartIdentity: 'procfs:123:started',
  }, {
    gracefulWaitMs: 0,
    forceWaitMs: 0,
    descendantSampleLimit: 16,
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.method, 'posix-leaf-first');
  assert.deepEqual(killCalls, [
    { pid: 200, signal: 'SIGTERM' },
    { pid: 123, signal: 'SIGTERM' },
    { pid: 123, signal: 'SIGKILL' },
  ]);
}

async function testProcessTreeTerminatorReportsSurvivingSampledChildAfterRootExit(): Promise<void> {
  const rootCwd = process.cwd();
  let rootCalls = 0;
  const killCalls: Array<{ pid: number; signal?: NodeJS.Signals | number }> = [];
  const terminator = new DefaultProcessTreeTerminator({
    platform: 'linux',
    killFn: (pid: number, signal?: NodeJS.Signals | number) => {
      killCalls.push({ pid, signal });
    },
    processInfoProvider: async (pid: number) => {
      if (pid === 123) {
        rootCalls += 1;
        if (rootCalls === 1) {
          return {
            pid,
            running: true,
            startIdentity: 'procfs:123:started',
            cwd: rootCwd,
            processGroupId: 999,
            childPids: [200],
          };
        }
        return {
          pid,
          running: false,
          startIdentity: 'procfs:123:started',
          cwd: rootCwd,
          processGroupId: 999,
          childPids: [],
        };
      }
      if (pid === 200) {
        return {
          pid,
          running: true,
          startIdentity: 'procfs:200:started',
          cwd: rootCwd,
          processGroupId: 999,
          childPids: [],
        };
      }
      return {
        pid,
        running: false,
        startIdentity: null,
        cwd: null,
        childPids: [],
      };
    },
  });

  const result = await terminator.terminate({
    rootPid: 123,
    shellCommand: 'bash',
    shellArgs: [],
    shellType: 'bash',
    cwd: rootCwd,
    platform: 'linux',
    backend: 'unix',
    launchedAt: new Date().toISOString(),
    osStartIdentity: 'procfs:123:started',
  }, {
    gracefulWaitMs: 0,
    forceWaitMs: 0,
    descendantSampleLimit: 16,
  });

  assert.equal(result.status, 'degraded');
  assert.equal(result.method, 'posix-leaf-first');
  assert.deepEqual(result.remainingPids, []);
  assert.deepEqual(result.unverifiedPids, [200]);
  assert.deepEqual(killCalls, [
    { pid: 200, signal: 'SIGTERM' },
    { pid: 123, signal: 'SIGTERM' },
  ]);
}

async function testSessionManagerTerminateSessionAwaitsEnforceTerminator(): Promise<void> {
  let terminateStarted = false;
  let terminateFinished = false;
  const fakeTerminator: ProcessTreeTerminator = {
    async inspect() {
      throw new Error('inspect should not be called directly');
    },
    async terminate(metadata, options) {
      terminateStarted = true;
      assert.equal(metadata.rootPid, 4321);
      assert.equal(options.gracefulWaitMs, 5);
      assert.equal(options.forceWaitMs, 6);
      assert.equal(options.descendantSampleLimit, 7);
      await delay(10);
      terminateFinished = true;
      return {
        status: 'completed',
        rootPid: metadata.rootPid,
        terminatedPids: [metadata.rootPid as number],
        remainingPids: [],
        unverifiedPids: [],
        method: 'posix-leaf-first',
      };
    },
  };
  const harness = createProcessCleanupSessionHarness({
    processCleanup: {
      mode: 'enforce',
      gracefulWaitMs: 5,
      forceWaitMs: 6,
      descendantSampleLimit: 7,
    },
    processTreeTerminator: fakeTerminator,
  });

  try {
    const terminatePromise = harness.manager.terminateSession(harness.session.id, {
      reason: 'direct-session-delete',
    });
    await delay(0);

    assert.equal(terminateStarted, true);
    assert.equal(terminateFinished, false);
    assert.ok(harness.manager.getSession(harness.session.id));

    assert.equal(await terminatePromise, true);
    assert.equal(terminateFinished, true);
    assert.equal(harness.getKillCalls(), 1);
    assert.equal(harness.manager.getSession(harness.session.id), null);

    const cleanup = readCleanupTelemetry(harness.manager);
    assert.equal(cleanup.mode, 'enforce');
    assert.equal(cleanup.attempted, 1);
    assert.equal(cleanup.completed, 1);
    assert.equal(cleanup.recentResults[0].cleanupStatus, 'completed');
    assert.equal(cleanup.recentResults[0].remainingDescendants, 0);
  } finally {
    harness.cleanupIfActive();
  }
}

async function testSessionManagerTerminateSessionMergesProcessExitRace(): Promise<void> {
  const finalizedEvents: SessionFinalizedEvent[] = [];
  let terminateStarted = false;
  const fakeTerminator: ProcessTreeTerminator = {
    async inspect() {
      throw new Error('inspect should not be called directly');
    },
    async terminate(metadata) {
      terminateStarted = true;
      assert.equal(metadata.rootPid, 4321);
      harness.exit(23);
      await delay(0);
      return {
        status: 'completed',
        rootPid: metadata.rootPid,
        terminatedPids: [metadata.rootPid as number],
        remainingPids: [],
        unverifiedPids: [],
        method: 'posix-leaf-first',
      };
    },
  };
  const harness = createProcessCleanupSessionHarness({
    processCleanup: {
      mode: 'enforce',
    },
    processTreeTerminator: fakeTerminator,
  });
  harness.manager.onSessionFinalized((event) => finalizedEvents.push(event));

  try {
    const result = await harness.manager.terminateSession(harness.session.id, {
      reason: 'direct-session-delete',
    });

    assert.equal(terminateStarted, true);
    assert.equal(result, true);
    assert.equal(harness.manager.getSession(harness.session.id), null);
    assert.deepEqual(finalizedEvents.map(event => event.reason), ['direct-session-delete']);
    assert.equal(finalizedEvents[0].exitCode, 23);

    const cleanup = readCleanupTelemetry(harness.manager);
    assert.equal(cleanup.attempted, 1);
    assert.equal(cleanup.completed, 1);
    assert.equal(cleanup.recentResults[0].reason, 'direct-session-delete');
    assert.equal(cleanup.recentResults[0].cleanupStatus, 'completed');
  } finally {
    harness.cleanupIfActive();
  }
}

function testSessionManagerCreateSessionDoesNotReadStartIdentitySynchronously(): void {
  let syncIdentityCalls = 0;
  const harness = createProcessCleanupSessionHarness({
    platform: 'win32',
    shell: 'powershell',
    pid: process.pid,
    useConpty: true,
    windowsPowerShellBackend: 'conpty',
    execFileSyncFn: (() => {
      syncIdentityCalls += 1;
      return Buffer.from('');
    }) as any,
    readProcessStartIdentityFn: async () => null,
  });

  try {
    assert.equal(syncIdentityCalls, 0);
  } finally {
    harness.cleanupIfActive();
  }
}

async function testSessionManagerIgnoresRejectedAsyncStartIdentityCapture(): Promise<void> {
  let captureCalls = 0;
  const harness = createProcessCleanupSessionHarness({
    readProcessStartIdentityFn: async () => {
      captureCalls += 1;
      throw new Error('identity probe failed');
    },
  });

  try {
    // Only the first probe has run synchronously at creation time.
    assert.equal(captureCalls, 1);
    assert.ok(harness.manager.getSession(harness.session.id));

    // Rejections trigger bounded retries; wait for the retry budget (200ms + 400ms) to drain.
    await delay(900);

    assert.ok(harness.manager.getSession(harness.session.id));
    assert.equal(captureCalls, 3);
    assert.equal(harness.sessionData?.processMetadata.osStartIdentity, null);

    const cleanup = readCleanupTelemetry(harness.manager);
    assert.equal(cleanup.identityCaptureRetried, 2);
    assert.equal(cleanup.identityCaptureFailed, 1);
    assert.equal(cleanup.identityCaptureSucceeded, 0);
  } finally {
    harness.cleanupIfActive();
  }
}

async function testSessionManagerRetriesAsyncStartIdentityCaptureAfterTransientFailure(): Promise<void> {
  let captureCalls = 0;
  const harness = createProcessCleanupSessionHarness({
    readProcessStartIdentityFn: async () => {
      captureCalls += 1;
      // First probe simulates a transient timeout/failure (null); later probes succeed.
      return captureCalls >= 2 ? 'procfs:4321:recovered-start' : null;
    },
  });

  try {
    // Immediately after creation only the first (failing) probe has run synchronously.
    assert.equal(captureCalls, 1);
    assert.equal(harness.sessionData?.processMetadata.osStartIdentity, null);

    // Allow the retry backoff to elapse and the second probe to resolve.
    await delay(500);

    assert.ok(captureCalls >= 2, `expected at least 2 identity probe attempts, saw ${captureCalls}`);
    assert.equal(harness.sessionData?.processMetadata.osStartIdentity, 'procfs:4321:recovered-start');

    const cleanup = readCleanupTelemetry(harness.manager);
    assert.equal(cleanup.identityCaptureSucceeded, 1);
    assert.equal(cleanup.identityCaptureRetried, 1);
    assert.equal(cleanup.identityCaptureFailed, 0);
  } finally {
    harness.cleanupIfActive();
  }
}

async function testReadProcessStartIdentityWindowsTimeoutReturnsNull(): Promise<void> {
  let observedTimeout: number | undefined;
  const fakeExecFile = ((file: string, args: string[], options: any, callback: any) => {
    assert.equal(file, 'powershell.exe');
    assert.deepEqual(args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
    observedTimeout = options.timeout;
    queueMicrotask(() => {
      const error = Object.assign(new Error('operation timed out'), { code: 'ETIMEDOUT' });
      callback(error, '', '');
    });
    return {} as any;
  }) as any;

  const identity = await readProcessStartIdentity(process.pid, 'win32', fakeExecFile);

  assert.equal(identity, null);
  assert.equal(observedTimeout, 3000);
}

async function testSessionManagerStoresAsyncStartIdentity(): Promise<void> {
  let requestedPid: number | null = null;
  let resolveCapture: (identity: string | null) => void = () => {
    throw new Error('Expected async start identity capture promise to be initialized');
  };
  const harness = createProcessCleanupSessionHarness({
    readProcessStartIdentityFn: async (pid: number | null) => {
      requestedPid = pid;
      return await new Promise<string | null>((resolve) => {
        resolveCapture = resolve;
      });
    },
  });

  try {
    assert.equal(requestedPid, 4321);
    assert.equal(harness.sessionData?.processMetadata.osStartIdentity, null);
    resolveCapture('procfs:4321:async-start');
    await delay(0);
    assert.equal(harness.sessionData?.processMetadata.osStartIdentity, 'procfs:4321:async-start');
  } finally {
    harness.cleanupIfActive();
  }
}

async function testSessionManagerTerminateBeforeAsyncStartIdentityCapture(): Promise<void> {
  let resolveCapture: (identity: string | null) => void = () => {
    throw new Error('Expected async start identity capture promise to be initialized');
  };
  let observedIdentity: string | null | undefined;
  const fakeTerminator: ProcessTreeTerminator = {
    async inspect() {
      throw new Error('inspect should not be called directly');
    },
    async terminate(metadata) {
      observedIdentity = metadata.osStartIdentity;
      return {
        status: 'skipped-unverified',
        rootPid: metadata.rootPid,
        terminatedPids: [],
        remainingPids: [],
        unverifiedPids: metadata.rootPid === null ? [] : [metadata.rootPid],
        method: 'observe',
        message: 'Session root identity is unavailable',
      };
    },
  };
  const harness = createProcessCleanupSessionHarness({
    processCleanup: { mode: 'enforce' },
    processTreeTerminator: fakeTerminator,
    readProcessStartIdentityFn: async () => await new Promise<string | null>((resolve) => {
      resolveCapture = resolve;
    }),
  });

  const sessionId = harness.session.id;
  const result = await harness.manager.terminateSession(sessionId, {
    reason: 'direct-session-delete',
  });
  resolveCapture('procfs:4321:late-start');
  await delay(0);

  assert.equal(result, true);
  assert.equal(observedIdentity, null);
  assert.equal(harness.manager.getSession(sessionId), null);
  const cleanup = readCleanupTelemetry(harness.manager);
  assert.equal(cleanup.unverifiedSkipped, 1);
  assert.equal(cleanup.recentResults[0].cleanupStatus, 'skipped-unverified');
}

async function testSessionManagerUpdatesProcessMetadataCwdFromHook(): Promise<void> {
  const harness = createProcessCleanupSessionHarness();
  const nextCwd = path.join(process.cwd(), 'nested-cwd');

  try {
    const cwdFilePath = harness.sessionData?.cwdFilePath;
    if (!cwdFilePath) {
      throw new Error('Expected cwdFilePath to be registered');
    }

    await fs.writeFile(cwdFilePath, nextCwd, 'utf8');
    await delay(1200);

    assert.equal(harness.sessionData?.lastCwd, nextCwd);
    assert.equal(harness.sessionData?.processMetadata.cwd, nextCwd);
  } finally {
    harness.cleanupIfActive();
  }
}

async function testSessionManagerTerminateSessionFinalizesWhenTerminatorThrows(): Promise<void> {
  const fakeTerminator: ProcessTreeTerminator = {
    async inspect() {
      throw new Error('inspect should not be called directly');
    },
    async terminate() {
      throw new Error('terminator failed');
    },
  };
  const harness = createProcessCleanupSessionHarness({
    processCleanup: {
      mode: 'enforce',
    },
    processTreeTerminator: fakeTerminator,
  });

  try {
    assert.equal(await harness.manager.terminateSession(harness.session.id, {
      reason: 'direct-session-delete',
    }), true);
    assert.equal(harness.getKillCalls(), 1);
    assert.equal(harness.manager.getSession(harness.session.id), null);

    const cleanup = readCleanupTelemetry(harness.manager);
    assert.equal(cleanup.mode, 'enforce');
    assert.equal(cleanup.attempted, 1);
    assert.equal(cleanup.degraded, 1);
    assert.equal(cleanup.completed, 0);
    assert.equal(cleanup.recentResults[0].cleanupStatus, 'failed');
    assert.equal(cleanup.recentResults[0].remainingDescendants, 1);
  } finally {
    harness.cleanupIfActive();
  }
}

async function testSessionManagerTerminateMultipleSessionsReportsMissing(): Promise<void> {
  const harness = createProcessCleanupSessionHarness({
    processInspector: () => ({ status: 'observed', remainingDescendants: 0 }),
  });

  try {
    const second = harness.manager.createSession('Cleanup 2', 'bash', process.cwd());
    const result = await harness.manager.terminateMultipleSessions([
      harness.session.id,
      'missing-session',
      second.id,
    ], {
      reason: 'workspace-delete',
    });

    assert.deepEqual(result, {
      attempted: 3,
      terminated: 2,
      missing: ['missing-session'],
      remainingVerifiedDescendants: 0,
      remainingUnverifiedDescendants: 0,
    });
    assert.equal(harness.manager.getSession(harness.session.id), null);
    assert.equal(harness.manager.getSession(second.id), null);

    const cleanup = readCleanupTelemetry(harness.manager);
    assert.equal(cleanup.attempted, 2);
    assert.equal(cleanup.completed, 2);
  } finally {
    harness.cleanupIfActive();
  }
}

async function testSessionManagerTerminateAllSessionsBatchResult(): Promise<void> {
  const fakeTerminator: ProcessTreeTerminator = {
    async inspect() {
      throw new Error('inspect should not be called directly');
    },
    async terminate(metadata) {
      return {
        status: 'degraded',
        rootPid: metadata.rootPid,
        terminatedPids: metadata.rootPid === null ? [] : [metadata.rootPid],
        remainingPids: metadata.rootPid === null ? [] : [metadata.rootPid],
        unverifiedPids: [9000],
        method: 'posix-leaf-first',
      };
    },
  };
  const harness = createProcessCleanupSessionHarness({
    processCleanup: {
      mode: 'enforce',
    },
    processTreeTerminator: fakeTerminator,
  });

  try {
    const second = harness.manager.createSession('Cleanup 2', 'bash', process.cwd());
    const result = await harness.manager.terminateAllSessions({
      reason: 'shutdown',
    });

    assert.deepEqual(result, {
      attempted: 2,
      terminated: 2,
      missing: [],
      remainingVerifiedDescendants: 2,
      remainingUnverifiedDescendants: 2,
    });
    assert.equal(harness.manager.getSession(harness.session.id), null);
    assert.equal(harness.manager.getSession(second.id), null);
  } finally {
    harness.cleanupIfActive();
  }
}

async function testSessionManagerTerminateAllSessionsEnforceOverrideRecordsTelemetry(): Promise<void> {
  let terminateCalls = 0;
  const fakeTerminator: ProcessTreeTerminator = {
    async inspect() {
      throw new Error('inspect should not be called directly');
    },
    async terminate(metadata) {
      terminateCalls += 1;
      return {
        status: 'degraded',
        rootPid: metadata.rootPid,
        terminatedPids: metadata.rootPid === null ? [] : [metadata.rootPid],
        remainingPids: metadata.rootPid === null ? [] : [metadata.rootPid],
        unverifiedPids: [],
        method: 'posix-leaf-first',
      };
    },
  };
  const harness = createProcessCleanupSessionHarness({
    processCleanup: {
      mode: 'legacy',
    },
    processTreeTerminator: fakeTerminator,
  });

  try {
    const result = await harness.manager.terminateAllSessions({
      reason: 'shutdown',
      mode: 'enforce',
    });

    assert.equal(terminateCalls, 1);
    assert.deepEqual(result, {
      attempted: 1,
      terminated: 1,
      missing: [],
      remainingVerifiedDescendants: 1,
      remainingUnverifiedDescendants: 0,
    });

    const cleanup = readCleanupTelemetry(harness.manager);
    assert.equal(cleanup.mode, 'enforce');
    assert.equal(cleanup.attempted, 1);
    assert.equal(cleanup.degraded, 1);
    assert.equal(cleanup.recentResults[0].cleanupStatus, 'degraded');
    assert.equal(cleanup.recentResults[0].verifiedRemainingDescendants, 1);
  } finally {
    harness.cleanupIfActive();
  }
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
  const submittedCommands: Array<{ command: string; executable: string | null }> = [];

  try {
    const handler = harness.getHandler();
    harness.manager.onCommandSubmitted((event) => {
      submittedCommands.push({
        command: event.command,
        executable: event.executable,
      });
    });
    harness.manager.writeInput(harness.session.id, 'codex\r');
    handler('OpenAI Codex\r\n');
    await delay(10);
    assert.equal(harness.sessionData?.derivedState?.foregroundAppId, 'codex');
    assert.equal(harness.sessionData?.aiTuiLaunchAttempt, undefined);
    assert.deepEqual(submittedCommands, [{ command: 'codex', executable: 'codex' }]);

    harness.manager.writeInput(harness.session.id, 'claude\r');
    await delay(10);
    assert.equal(harness.manager.getSession(harness.session.id)?.status, 'idle');
    assert.equal(harness.sessionData?.derivedState?.foregroundAppId, 'codex');
    assert.equal(harness.sessionData?.pendingForegroundAppHint, undefined);
    assert.equal(harness.sessionData?.aiTuiLaunchAttempt, undefined);
    assert.deepEqual(submittedCommands, [{ command: 'codex', executable: 'codex' }]);

    handler('/bin/bash: claude: command not found\r\n');
    await delay(60);
    assert.equal(harness.manager.getSession(harness.session.id)?.status, 'running');
    assert.equal(harness.sessionData?.derivedState?.foregroundAppId, 'codex');
  } finally {
    harness.cleanup();
  }
}

async function testSessionManagerCustomRecoveryForegroundInputStaysIdle(): Promise<void> {
  const harness = createForegroundSessionHarness('bash', { idleDelayMs: 200, runningDelayMs: 30 });
  const submittedCommands: Array<{ command: string; executable: string | null }> = [];

  try {
    const handler = harness.getHandler();
    harness.manager.onCommandSubmitted((event) => {
      submittedCommands.push({
        command: event.command,
        executable: event.executable,
      });
    });
    harness.manager.writeInput(harness.session.id, 'codex\r');
    handler('OpenAI Codex\r\n');
    await delay(10);
    assert.equal(harness.sessionData?.derivedState?.foregroundAppId, 'codex');
    submittedCommands.splice(0);

    harness.manager.markRecoveryCommandForeground(harness.session.id, 'claudep');
    assert.equal(harness.sessionData?.derivedState?.foregroundAppId, undefined);

    harness.manager.writeInput(harness.session.id, 'hello from prompt\r');
    await delay(50);

    assert.equal(harness.manager.getSession(harness.session.id)?.status, 'idle');
    assert.deepEqual(submittedCommands, []);
  } finally {
    harness.cleanup();
  }
}

async function testSessionManagerCommandSubmittedCallbackRequiresSuccessfulWrite(): Promise<void> {
  const harness = createForegroundSessionHarness('bash', {
    writeError: new Error('simulated write failure'),
  });
  const submittedCommands: Array<{ command: string; executable: string | null }> = [];

  try {
    harness.manager.onCommandSubmitted((event) => {
      submittedCommands.push({
        command: event.command,
        executable: event.executable,
      });
    });

    assert.equal(harness.manager.writeInput(harness.session.id, 'codex\r'), false);
    assert.deepEqual(submittedCommands, []);
  } finally {
    if (harness.sessionData?.pty) {
      harness.sessionData.pty.write = () => {};
    }
    harness.cleanup();
  }
}

async function testSessionManagerRestoreInputWaitsForStartupReady(): Promise<void> {
  const harness = createForegroundSessionHarness('bash');

  try {
    harness.manager.scheduleRestoreInput(harness.session.id, 'codex resume --last\r', { delayMs: 0 });
    await delay(10);
    assert.deepEqual(harness.writes, []);

    (harness.manager as any).markSessionStartupReady(harness.session.id, harness.sessionData, 'test_ready');
    assert.deepEqual(harness.writes, ['codex resume --last\r']);
  } finally {
    harness.cleanup();
  }
}

async function testSessionManagerRestoreInputGuardCancelsWrite(): Promise<void> {
  const harness = createForegroundSessionHarness('bash');

  try {
    harness.manager.scheduleRestoreInput(harness.session.id, 'claude --continue\r', {
      delayMs: 0,
      guard: () => false,
    });
    await delay(10);
    (harness.manager as any).markSessionStartupReady(harness.session.id, harness.sessionData, 'test_ready');
    assert.deepEqual(harness.writes, []);
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
  let observedArgs: string[] = [];
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
    spawnPty: ((_: string, args: string[], options: { useConpty?: boolean; cols?: number; rows?: number }) => {
      observedArgs = args;
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
  assert.deepEqual(
    observedArgs.slice(0, 5),
    ['-NoLogo', '-NoExit', '-NoProfile', '-WindowStyle', 'Hidden'],
  );
  assert.ok(observedArgs.includes('-EncodedCommand'));
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
    headlessOutputQueue: createHeadlessOutputQueueForHarness({
      maxBytes: 1024 * 1024,
      maxChunks: 1024,
      overflowPolicy: 'degrade-headless',
    }),
    headlessQueueMode: 'observe',
    pendingHeadlessOutputs: new Map(),
    pendingHeadlessOutputBytes: 0,
    maxPendingHeadlessOutputBytes: 0,
    maxPendingHeadlessOutputChunks: 0,
    nextHeadlessOutputId: 0,
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
    assert.equal((first as any)?.scope, 'viewport-only');
    assert.equal((harness.sessionData.snapshotCache as any)?.scope, 'viewport-only');
    assert.equal(second?.generatedAt, first?.generatedAt);
    assert.equal(serializeCalls, 1);
    assert.deepEqual(replay, { data: 'hello\r\nworld', truncated: false });

    (harness.sessionData.snapshotCache as any).scope = undefined;
    const third = manager.getScreenSnapshot(harness.sessionId);

    assert.equal(serializeCalls, 2);
    assert.equal((third as any)?.scope, 'viewport-only');
    assert.equal((harness.sessionData.snapshotCache as any)?.scope, 'viewport-only');
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
    await (manager as any).applyHeadlessOutput(harness.sessionId, harness.sessionData, '한글');
    manager.enableDebugCapture(harness.sessionId);
    const snapshot = manager.getScreenSnapshot(harness.sessionId);
    manager.getScreenSnapshot(harness.sessionId);

    const stats = manager.getObservabilitySnapshot();
    const snapshotData = snapshot?.data ?? '';
    const snapshotByteLength = Buffer.byteLength(snapshotData, 'utf8');
    const debugEvents = manager.getDebugCapture(harness.sessionId);
    const serializedEvent = debugEvents.find((event) => event.kind === 'snapshot_serialized');
    const cacheHitEvent = debugEvents.find((event) => event.kind === 'snapshot_cache_hit');

    assert.equal(stats.totalSessions, 1);
    assert.equal(stats.healthySessions, 1);
    assert.equal(stats.snapshotRequests, 2);
    assert.equal(stats.snapshotCacheHits, 1);
    assert.equal(stats.snapshotSerializeFailures, 0);
    assert.equal(snapshotByteLength > snapshotData.length, true);
    assert.equal(stats.totalSnapshotBytes, snapshotByteLength);
    assert.equal(stats.maxSnapshotBytesObserved, snapshotByteLength);
    assert.equal(serializedEvent?.details?.byteLength, snapshotByteLength);
    assert.equal(serializedEvent?.details?.snapshotScope, 'viewport-only');
    assert.equal(cacheHitEvent?.details?.byteLength, snapshotByteLength);
    assert.equal(cacheHitEvent?.details?.snapshotScope, 'viewport-only');
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
  assert.deepEqual(
    resolved.args.slice(0, 5),
    ['-NoLogo', '-NoExit', '-NoProfile', '-WindowStyle', 'Hidden'],
  );
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
        sessionCleanupAttempted: 1,
        sessionCleanupCompleted: 1,
        sessionCleanupDegraded: 0,
        sessionCleanupSkippedUnverified: 0,
        remainingVerifiedDescendants: 0,
      };
    },
  });
  await delay(5);

  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.reason, 'internal-shutdown');
  assert.equal(result.body.workspaceFlushed, true);
  assert.equal(result.body.workspaceFlushMarker, '[Shutdown] Workspace state + CWDs saved');
  assert.equal(result.body.sessionCleanupAttempted, 1);
  assert.equal(result.body.sessionCleanupCompleted, 1);
  assert.equal(result.body.sessionCleanupDegraded, 0);
  assert.equal(result.body.sessionCleanupSkippedUnverified, 0);
  assert.equal(result.body.remainingVerifiedDescendants, 0);
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

type McpSecurityContract = Record<string, unknown>;

const expectedDefaultMcpScopes = [
  'mcp:self.read',
  'mcp:sessions.list',
  'mcp:sessions.search',
  'mcp:message.paste',
  'mcp:status.write',
];

const requiredMcpDenialCodes = [
  'UNBOUND_ACTOR',
  'INVALID_SCOPE',
  'TARGET_NOT_FOUND',
  'AMBIGUOUS_TARGET',
  'STALE_SESSION_ID',
  'TARGET_NOT_LIVE',
  'INPUT_REJECTED_REPLAY_PENDING',
  'INPUT_REJECTED_ENTER_POLICY',
  'SELF_CLOSE_DENIED_NO_LEADER',
  'MCP_PORT_REBIND_FAILED',
  'WEBHOOK_KEY_INVALID',
  'MCP_WHITELIST_EMPTY',
  'MCP_WHITELIST_DENIED',
];

const mcpSecurityContractRedTests: Record<string, () => Promise<void>> = {
  'Security_contract_red_tests_SEC-MCP-001_AC-1': testMcpSecuritySecMcp001Ac1,
  'Security_contract_red_tests_SEC-MCP-001_AC-2': testMcpSecuritySecMcp001Ac2,
  'Security_contract_red_tests_SEC-MCP-001_AC-3': testMcpSecuritySecMcp001Ac3,
  'Security_contract_red_tests_SEC-MCP-001_AC-4': testMcpSecuritySecMcp001Ac4,
  'Security_contract_red_tests_SEC-MCP-001_AC-5': testMcpSecuritySecMcp001Ac5,
  'Security_contract_red_tests_SEC-MCP-001_AC-6': testMcpSecuritySecMcp001Ac6,
  'Security_contract_red_tests_SEC-MCP-002_AC-1': testMcpSecuritySecMcp002Ac1,
  'Security_contract_red_tests_SEC-MCP-002_AC-2': testMcpSecuritySecMcp002Ac2,
  'Security_contract_red_tests_SEC-MCP-002_AC-3': testMcpSecuritySecMcp002Ac3,
  'Security_contract_red_tests_SEC-MCP-002_AC-4': testMcpSecuritySecMcp002Ac4,
  'Security_contract_red_tests_SEC-MCP-002_AC-5': testMcpSecuritySecMcp002Ac5,
  'Security_contract_red_tests_SEC-MCP-002_AC-6': testMcpSecuritySecMcp002Ac6,
  'Security_contract_red_tests_SEC-MCP-002_AC-7': testMcpSecuritySecMcp002Ac7,
  'Security_contract_red_tests_SEC-MCP-002_AC-8': testMcpSecuritySecMcp002Ac8,
  'Security_contract_red_tests_SEC-MCP-002_AC-9': testMcpSecuritySecMcp002Ac9,
  'Security_contract_red_tests_SEC-MCP-002_AC-10': testMcpSecuritySecMcp002Ac10,
  'Security_contract_red_tests_IR-MCP-005_AC-1': testMcpSecurityIrMcp005Ac1,
  'Security_contract_red_tests_IR-MCP-005_AC-2': testMcpSecurityIrMcp005Ac2,
  'Security_contract_red_tests_IR-MCP-005_AC-3': testMcpSecurityIrMcp005Ac3,
  'Security_contract_red_tests_IR-MCP-005_AC-4': testMcpSecurityIrMcp005Ac4,
  'Security_contract_red_tests_IR-MCP-005_AC-5': testMcpSecurityIrMcp005Ac5,
  'Security_contract_red_tests_IR-MCP-005_AC-6': testMcpSecurityIrMcp005Ac6,
  'Security_contract_red_tests_IR-MCP-005_AC-7': testMcpSecurityIrMcp005Ac7,
  'Security_contract_red_tests_IR-MCP-005_AC-8': testMcpSecurityIrMcp005Ac8,
  'Security_contract_red_tests_IR-MCP-005_AC-9': testMcpSecurityIrMcp005Ac9,
  'Security_contract_red_tests_IR-MCP-005_AC-10': testMcpSecurityIrMcp005Ac10,
};

type McpSessionRegistryContract = Record<string, unknown>;

const uuidV4Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const registryAndAliasRedTests: Record<string, () => Promise<void>> = {
  'Registry_and_alias_red_tests_FR-MCP-001_AC-1': testMcpRegistryFrMcp001Ac1,
  'Registry_and_alias_red_tests_FR-MCP-001_AC-2': testMcpRegistryFrMcp001Ac2,
  'Registry_and_alias_red_tests_FR-MCP-001_AC-3': testMcpRegistryFrMcp001Ac3,
  'Registry_and_alias_red_tests_FR-MCP-001_AC-4': testMcpRegistryFrMcp001Ac4,
  'Registry_and_alias_red_tests_FR-MCP-001_AC-5': testMcpRegistryFrMcp001Ac5,
  'Registry_and_alias_red_tests_FR-MCP-001_AC-6': testMcpRegistryFrMcp001Ac6,
  'Registry_and_alias_red_tests_FR-MCP-001_AC-7': testMcpRegistryFrMcp001Ac7,
  'Registry_and_alias_red_tests_FR-MCP-006_DUPLICATE_KEYS': testMcpRegistryFrMcp006Ac6,
  'Registry_and_alias_red_tests_FR-MCP-001_AC-7_SEARCH_RANKING': testMcpAliasFrMcp001Ac7SearchRanking,
  'Registry_and_alias_red_tests_FR-MCP-001_AC-7_SEARCH_SESSION_IDS': testMcpAliasFrMcp001Ac7SearchSessionIds,
  'Registry_and_alias_red_tests_FR-MCP-001_AC-7_SEARCH_DENIALS': testMcpAliasFrMcp001Ac7SearchDenials,
  'Registry_and_alias_red_tests_FR-MCP-006_AC-1': testMcpAliasFrMcp006Ac1,
  'Registry_and_alias_red_tests_FR-MCP-006_AC-2': testMcpAliasFrMcp006Ac2,
  'Registry_and_alias_red_tests_FR-MCP-006_AC-3': testMcpAliasFrMcp006Ac3,
  'Registry_and_alias_red_tests_FR-MCP-006_AC-4': testMcpAliasFrMcp006Ac4,
  'Registry_and_alias_red_tests_FR-MCP-006_AC-5': testMcpAliasFrMcp006Ac5,
  'Registry_and_alias_red_tests_FR-MCP-006_AC-6': testMcpAliasFrMcp006Ac6,
};

type SessionInputGatewayContract = Record<string, unknown>;

type InputGatewayScenario = {
  request: Record<string, unknown>;
  replayPending?: boolean;
  screenRepairPending?: boolean;
  target?: Record<string, unknown>;
  leader?: Record<string, unknown> | null;
  policyDenialCode?: string;
  expected: {
    accepted: boolean;
    code?: string;
    message?: string;
    details?: Record<string, unknown>;
    fieldErrors?: Record<string, unknown>;
    writes: number;
    targetSessionKey?: string;
    sessionActivityAfter?: string;
    followerLifecycleAfter?: string;
    requiresNoSecrets?: string[];
    requiresAuditEvent?: boolean;
    requiresIncludeSelf?: boolean;
  };
};

const requiredInputGatewaySources = [
  'websocket',
  'restore',
  'mcp-message-send',
  'mcp-reply-to-leader',
  'open-agent-command',
  'open-agent-kickoff',
  'webhook',
];

const inputGatewayRedTests: Record<string, () => Promise<void>> = {
  'Input_gateway_red_tests_FR-MCP-002_AC-1': async () => {
    const contract = await loadSessionInputGatewayContract();
    assertInputGatewayContractExports(contract);
    for (const source of requiredInputGatewaySources) {
      await runInputGatewayContractScenario({
        request: createGatewayRequest({ source, data: `input from ${source}` }),
        expected: {
          accepted: true,
          writes: 1,
          targetSessionKey: source === 'mcp-reply-to-leader' ? 'leader-session' : 'target-session',
        },
      }, contract);
    }
  },
  'Input_gateway_red_tests_FR-MCP-002_AC-2': () => runInputGatewayContractScenario({
    request: createGatewayRequest({ source: 'mcp-message-send', replayPolicy: 'reject' }),
    replayPending: true,
    expected: {
      accepted: false,
      code: 'INPUT_REJECTED_REPLAY_PENDING',
      writes: 0,
    },
  }),
  'Input_gateway_red_tests_FR-MCP-002_AC-3': () => runInputGatewayContractScenario({
    request: createGatewayRequest({
      source: 'mcp-message-send',
      data: 'paste-only text\nmust not submit',
      delivery: { mode: 'paste', submit: false },
      actor: { type: 'mcp', sessionKey: 'actor-session', scopes: ['mcp:message.paste', 'mcp:message.submit'] },
    }),
    expected: {
      accepted: false,
      code: 'INPUT_REJECTED_ENTER_POLICY',
      writes: 0,
    },
  }).then(() => runInputGatewayContractScenario({
    request: createGatewayRequest({
      source: 'mcp-message-send',
      data: 'submit text\nwithout scope',
      delivery: { mode: 'submit', submit: true },
      actor: { type: 'mcp', sessionKey: 'actor-session', scopes: ['mcp:message.paste'] },
    }),
    expected: {
      accepted: false,
      code: 'INPUT_REJECTED_ENTER_POLICY',
      writes: 0,
    },
  })).then(() => runInputGatewayContractScenario({
    request: createGatewayRequest({
      source: 'mcp-message-send',
      data: 'submit intent without newline',
      delivery: { mode: 'submit', submit: true },
      actor: { type: 'mcp', sessionKey: 'actor-session', scopes: ['mcp:message.paste'] },
    }),
    expected: {
      accepted: false,
      code: 'INPUT_REJECTED_ENTER_POLICY',
      writes: 0,
    },
  })).then(() => runInputGatewayContractScenario({
    request: createGatewayRequest({
      source: 'mcp-message-send',
      data: 'submit text\nwith scope',
      delivery: { mode: 'submit', submit: true },
      actor: { type: 'mcp', sessionKey: 'actor-session', scopes: ['mcp:message.paste', 'mcp:message.submit'] },
    }),
    expected: {
      accepted: true,
      writes: 1,
    },
  })),
  'Input_gateway_red_tests_FR-MCP-002_AC-4': () => runInputGatewayContractScenario({
    request: createGatewayRequest({
      source: 'mcp-message-send',
      target: { sessionKey: 'target-session', sessionId: 'stale-session-id', expectedGeneration: 1 },
    }),
    target: {
      sessionKey: 'target-session',
      currentSessionId: 'current-session-id',
      generation: 2,
      lifecycle: 'live',
      hidden: false,
    },
    expected: {
      accepted: false,
      code: 'STALE_SESSION_ID',
      writes: 0,
    },
  }).then(() => runInputGatewayContractScenario({
    request: createGatewayRequest({
      source: 'mcp-message-send',
      target: { sessionKey: 'target-session' },
    }),
    target: {
      lifecycle: 'stopped',
      message: 'target is no longer live',
      details: { sessionKey: 'target-session' },
      fieldErrors: { sessionKey: 'not live' },
    },
    expected: {
      accepted: false,
      code: 'TARGET_NOT_LIVE',
      message: 'target is no longer live',
      details: { sessionKey: 'target-session' },
      fieldErrors: { sessionKey: 'not live' },
      writes: 0,
    },
  })),
  'Input_gateway_red_tests_FR-MCP-002_AC-5': async () => {
    const contract = await loadSessionInputGatewayContract();
    assertInputGatewayContractExports(contract);
    for (const inputEventKind of ['user-typing', 'local-echo', 'prompt-redraw', 'cursor-movement', 'ticker-output', 'waiting-input-repaint']) {
      await runInputGatewayContractScenario({
        request: createGatewayRequest({
          source: 'websocket',
          data: inputEventKind === 'user-typing' ? 'h' : '',
          inputEventKind,
          sessionKind: 'ai-tui',
          currentActivity: 'idle',
        }),
        expected: {
          accepted: true,
          writes: inputEventKind === 'user-typing' ? 1 : 0,
          sessionActivityAfter: 'idle',
        },
      }, contract);
    }
  },
  'Input_gateway_red_tests_FR-MCP-002_AC-6': () => runInputGatewayContractScenario({
    request: createGatewayRequest({ source: 'mcp-reply-to-leader', data: 'reply for leader' }),
    leader: null,
    expected: {
      accepted: false,
      code: 'TARGET_NOT_LIVE',
      writes: 0,
      followerLifecycleAfter: 'live',
    },
  }),
  'Input_gateway_red_tests_IR-MCP-004_AC-1': () => runInputGatewayContractScenario({
    request: createGatewayRequest({
      source: 'webhook',
      data: 'create webhook delivery',
      credential: { fullKey: 'webhook-full-key-create', fullUrl: 'https://localhost:2222/webhook?key=webhook-full-key-create' },
      auditContext: { operation: 'create' },
    }),
    expected: {
      accepted: true,
      writes: 1,
      requiresNoSecrets: ['webhook-full-key-create'],
      requiresAuditEvent: true,
    },
  }),
  'Input_gateway_red_tests_IR-MCP-004_AC-2': () => runInputGatewayContractScenario({
    request: createGatewayRequest({
      source: 'webhook',
      credential: { headerName: 'X-BuilderGate-Webhook-Key', fullKey: 'header-webhook-secret' },
      auditContext: { credentialMode: 'header' },
    }),
    expected: {
      accepted: true,
      writes: 1,
      requiresNoSecrets: ['header-webhook-secret'],
      requiresAuditEvent: true,
    },
  }),
  'Input_gateway_red_tests_IR-MCP-004_AC-3': () => runInputGatewayContractScenario({
    request: createGatewayRequest({ source: 'webhook', data: 'rate limited prompt' }),
    policyDenialCode: 'WEBHOOK_RATE_LIMITED',
    expected: {
      accepted: false,
      code: 'WEBHOOK_RATE_LIMITED',
      writes: 0,
      requiresAuditEvent: true,
    },
  }),
  'Input_gateway_red_tests_IR-MCP-004_AC-4': () => runInputGatewayContractScenario({
    request: createGatewayRequest({ source: 'webhook', data: 'x'.repeat(8192) }),
    policyDenialCode: 'WEBHOOK_PROMPT_TOO_LARGE',
    expected: {
      accepted: false,
      code: 'WEBHOOK_PROMPT_TOO_LARGE',
      writes: 0,
      requiresAuditEvent: true,
    },
  }),
  'Input_gateway_red_tests_IR-MCP-004_AC-5': () => runInputGatewayContractScenario({
    request: createGatewayRequest({
      source: 'webhook',
      credential: { keyId: 'revoked-key', revoked: true },
    }),
    policyDenialCode: 'WEBHOOK_KEY_REVOKED',
    expected: {
      accepted: false,
      code: 'WEBHOOK_KEY_REVOKED',
      writes: 0,
      requiresAuditEvent: true,
    },
  }),
  'Input_gateway_red_tests_IR-MCP-004_AC-6': () => runInputGatewayContractScenario({
    request: createGatewayRequest({
      source: 'mcp-message-send',
      target: { self: true, includeSelf: undefined },
    }),
    expected: {
      accepted: true,
      writes: 1,
      requiresIncludeSelf: true,
    },
  }),
  'Input_gateway_red_tests_IR-MCP-004_AC-7': () => runInputGatewayContractScenario({
    request: createGatewayRequest({
      source: 'mcp-message-send',
      target: { alias: 'api', matchMode: 'exact' },
    }),
    target: { ambiguousCandidates: ['sess-alpha', 'sess-beta'] },
    expected: {
      accepted: false,
      code: 'AMBIGUOUS_TARGET',
      writes: 0,
    },
  }),
  'Input_gateway_red_tests_IR-MCP-004_AC-8': () => runInputGatewayContractScenario({
    request: createGatewayRequest({
      source: 'close-self-failure-notification',
      data: 'follower close failed',
      target: { leaderSessionKey: 'leader-session' },
    }),
    expected: {
      accepted: true,
      writes: 1,
      targetSessionKey: 'leader-session',
      followerLifecycleAfter: 'closing-failed',
    },
  }),
  'Input_gateway_red_tests_IR-MCP-004_AC-9': () => runInputGatewayContractScenario({
    request: createGatewayRequest({ source: 'webhook', replayPolicy: 'reject' }),
    screenRepairPending: true,
    expected: {
      accepted: false,
      code: 'INPUT_REJECTED_REPLAY_PENDING',
      writes: 0,
    },
  }),
  'Input_gateway_red_tests_IR-MCP-004_AC-10': () => runInputGatewayContractScenario({
    request: createGatewayRequest({
      source: 'control-close-live-session',
      closeConfirmation: { confirmClose: true, expectedSessionKey: 'different-session', confirmationNonce: 'stale' },
    }),
    policyDenialCode: 'CLOSE_CONFIRMATION_REQUIRED',
    expected: {
      accepted: false,
      code: 'CLOSE_CONFIRMATION_REQUIRED',
      writes: 0,
    },
  }),
  'Input_gateway_red_tests_IR-MCP-005_AC-1': () => runInputGatewayContractScenario({
    request: createGatewayRequest({ source: 'webhook' }),
    policyDenialCode: 'MCP_WHITELIST_DENIED',
    expected: {
      accepted: false,
      code: 'MCP_WHITELIST_DENIED',
      writes: 0,
    },
  }),
  'Input_gateway_red_tests_IR-MCP-005_AC-2': () => runInputGatewayContractScenario({
    request: createGatewayRequest({
      source: 'webhook',
      data: '  token=super-secret\r\nnext line  ',
      auditContext: { promptPreviewMaxChars: 18 },
    }),
    expected: {
      accepted: true,
      writes: 1,
      requiresNoSecrets: ['super-secret', '\r', '\n'],
      requiresAuditEvent: true,
    },
  }),
  'Input_gateway_red_tests_IR-MCP-005_AC-3': () => runInputGatewayContractScenario({
    request: createGatewayRequest({
      source: 'webhook',
      data: 'prompt that must be redacted from recent audit',
      metadata: {
        rawToken: 'metadata-raw-capability-token',
        fullUrl: 'https://localhost:2222/webhook?key=metadata-webhook-full-key',
        safeCounter: 1,
      },
      auditContext: { recentAuditEventsLimit: 2, rawToken: 'raw-capability-token' },
    }),
    expected: {
      accepted: true,
      writes: 1,
      requiresNoSecrets: [
        'raw-capability-token',
        'metadata-raw-capability-token',
        'metadata-webhook-full-key',
        'prompt that must be redacted from recent audit',
      ],
      requiresAuditEvent: true,
    },
  }),
  'Input_gateway_red_tests_IR-MCP-005_AC-4': () => runInputGatewayContractScenario({
    request: createGatewayRequest({
      source: 'webhook',
      credential: { headerName: 'X-Forwarded-For', fullKey: 'forwarded-secret' },
    }),
    policyDenialCode: 'WEBHOOK_HEADER_FORBIDDEN',
    expected: {
      accepted: false,
      code: 'WEBHOOK_HEADER_FORBIDDEN',
      writes: 0,
    },
  }),
  'Input_gateway_red_tests_IR-MCP-005_AC-5': () => runInputGatewayContractScenario({
    request: createGatewayRequest({
      source: 'webhook',
      data: 'rotate delivery',
      credential: { fullKey: 'webhook-full-key-rotate', fullUrl: 'https://localhost:2222/webhook?key=webhook-full-key-rotate' },
      auditContext: { operation: 'rotate' },
    }),
    expected: {
      accepted: true,
      writes: 1,
      requiresNoSecrets: ['webhook-full-key-rotate'],
      requiresAuditEvent: true,
    },
  }),
  'Input_gateway_red_tests_IR-MCP-005_AC-6': () => runInputGatewayContractScenario({
    request: createGatewayRequest({ source: 'mcp-message-send' }),
    target: { sessionKey: 'target-session', currentSessionId: 'current-session-id', generation: 2, lifecycle: 'live', agentStatus: 'arbitrary' },
    expected: {
      accepted: false,
      code: 'INVALID_AGENT_STATUS',
      writes: 0,
    },
  }),
  'Input_gateway_red_tests_IR-MCP-005_AC-7': () => runInputGatewayContractScenario({
    request: createGatewayRequest({ source: 'mcp-message-send' }),
    target: { sessionKey: 'target-session', currentSessionId: 'current-session-id', generation: 2, lifecycle: 'active' },
    expected: {
      accepted: false,
      code: 'TARGET_NOT_LIVE',
      writes: 0,
    },
  }),
  'Input_gateway_red_tests_IR-MCP-005_AC-8': () => runInputGatewayContractScenario({
    request: createGatewayRequest({ source: 'mcp-message-send', replayPolicy: 'reject' }),
    replayPending: true,
    policyDenialCode: 'INPUT_REPLAY_BLOCKED',
    expected: {
      accepted: false,
      code: 'INPUT_REJECTED_REPLAY_PENDING',
      writes: 0,
    },
  }),
  'Input_gateway_red_tests_IR-MCP-005_AC-9': () => runInputGatewayContractScenario({
    request: createGatewayRequest({
      source: 'control-close-live-session',
      closeConfirmation: { confirmClose: false, expectedSessionKey: 'target-session', confirmationNonce: 'nonce-1' },
    }),
    policyDenialCode: 'CLOSE_CONFIRMATION_REQUIRED',
    expected: {
      accepted: false,
      code: 'CLOSE_CONFIRMATION_REQUIRED',
      writes: 0,
    },
  }),
  'Input_gateway_red_tests_IR-MCP-005_AC-10': () => runInputGatewayContractScenario({
    request: createGatewayRequest({
      source: 'webhook',
      credential: { fullKey: 'webhook-full-key-list', fullUrl: 'https://localhost:2222/webhook?key=webhook-full-key-list' },
      auditContext: { operation: 'list' },
    }),
    expected: {
      accepted: true,
      writes: 1,
      requiresNoSecrets: ['webhook-full-key-list'],
      requiresAuditEvent: true,
    },
  }),
};

type McpTransportToolContract = Record<string, unknown>;

const requiredMcpToolNames = [
  'buildergate.session.whoami',
  'buildergate.session.claim',
  'buildergate.session.list',
  'buildergate.session.search',
  'buildergate.message.send',
  'buildergate.session.set_alias',
  'buildergate.session.open_agent',
  'buildergate.session.close',
  'buildergate.session.close_self',
  'buildergate.message.reply_to_leader',
  'buildergate.session.update_status',
];

const mcpTransportAndToolRedTests: Record<string, () => Promise<void>> = {
  'MCP_transport_and_tool_red_tests_IR-MCP-001_AC-1': async () => {
    const service = await createMcpToolServiceHarness();
    const tools = await callMcpToolService(service, 'listTools', {});
    const toolList = asRecordArray(asRecord(tools, 'MCP tools/list result').tools, 'MCP tools/list tools');
    const handler = await createMcpHttpHandlerHarness();
    const httpTools = asRecord(await callMcpHttpHandler(handler, {
      method: 'POST',
      path: '/mcp',
      headers: { 'content-type': 'application/json; charset=utf-8', authorization: 'Bearer valid-mcp-capability-token' },
      credential: createMcpActor({ token: 'valid-mcp-capability-token' }),
      body: Buffer.from(JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {},
      }), 'utf8'),
      remoteAddress: '127.0.0.1',
    }), 'MCP streamable HTTP tools/list response');
    const httpBody = asRecord(httpTools.body, 'MCP tools/list JSON-RPC body');
    const httpResult = asRecord(httpBody.result, 'MCP tools/list JSON-RPC result');
    const httpToolList = asRecordArray(httpResult.tools, 'MCP JSON-RPC tools/list tools');

    assert.equal(httpTools.status, 200);
    assert.match(String(httpTools.contentType), /application\/json/u);
    assert.match(String(httpTools.contentType), /utf-8/i);
    assert.equal(httpBody.jsonrpc, '2.0');
    assert.equal(httpBody.id, 1);
    assertRequiredMcpTools(toolList, 'service tools/list');
    assertRequiredMcpTools(httpToolList, 'HTTP tools/list');

    const contract = await loadMcpTransportToolContract();
    const createHandler = getMcpTransportFunction(contract, 'createMcpHttpHandler');
    const createController = getMcpTransportFunction(contract, 'createMcpListenerController');
    const authenticatedService = await createMcpToolServiceHarness();
    const authenticatedHandler = asRecord(createHandler({
      service: authenticatedService,
      listenerController: createController({ current: { bindHost: '127.0.0.1', port: 3333 } }),
    }), 'authenticated MCP HTTP handler');
    const credential = await createValidMcpCredential('self-session-key');
    const sharedAuthHeaders = {
      'content-type': 'application/json; charset=utf-8',
      authorization: `Bearer ${credential.token}`,
    };
    const authenticatedList = asRecord(await callMcpHttpHandler(authenticatedHandler, {
      method: 'POST',
      path: '/mcp',
      headers: sharedAuthHeaders,
      credential,
      body: Buffer.from(JSON.stringify({
        jsonrpc: '2.0',
        id: 101,
        method: 'tools/list',
        params: {},
      }), 'utf8'),
      remoteAddress: '127.0.0.1',
    }), 'authenticated MCP tools/list response');
    const authenticatedSearch = asRecord(await callMcpHttpHandler(authenticatedHandler, {
      method: 'POST',
      path: '/mcp',
      headers: sharedAuthHeaders,
      credential,
      body: Buffer.from(JSON.stringify({
        jsonrpc: '2.0',
        id: 102,
        method: 'tools/call',
        params: {
          name: 'buildergate.session.search',
          arguments: { query: '클로드' },
        },
      }), 'utf8'),
      remoteAddress: '127.0.0.1',
    }), 'authenticated MCP session.search response');
    const searchBody = asRecord(authenticatedSearch.body, 'authenticated MCP search JSON-RPC body');
    const searchResult = asRecord(searchBody.result, 'authenticated MCP search result');
    const searchMatches = asRecordArray(searchResult.matches, 'authenticated MCP search matches');
    const authenticatedSend = asRecord(await callMcpHttpHandler(authenticatedHandler, {
      method: 'POST',
      path: '/mcp',
      headers: sharedAuthHeaders,
      credential,
      body: Buffer.from(JSON.stringify({
        jsonrpc: '2.0',
        id: 103,
        method: 'tools/call',
        params: {
          name: 'buildergate.message.send',
          arguments: { sessionKey: searchMatches[0].sessionKey, prompt: 'message after search' },
        },
      }), 'utf8'),
      remoteAddress: '127.0.0.1',
    }), 'authenticated MCP message.send after search response');
    const sendBody = asRecord(authenticatedSend.body, 'authenticated MCP send JSON-RPC body');
    const sendResult = asRecord(sendBody.result, 'authenticated MCP send result');

    assert.equal(authenticatedList.status, 200);
    assert.equal(authenticatedSearch.status, 200);
    assert.equal(searchBody.id, 102);
    assert.equal(searchResult.allowed, true);
    assert.equal(searchMatches[0].sessionKey, 'target-session');
    assert.equal(authenticatedSend.status, 200);
    assert.equal(sendBody.id, 103);
    assert.equal(sendResult.ok, true);
    assert.equal(typeof sendResult.assignmentId, 'string');

    const authenticatedAliasSend = asRecord(await callMcpHttpHandler(authenticatedHandler, {
      method: 'POST',
      path: '/mcp',
      headers: sharedAuthHeaders,
      credential,
      body: Buffer.from(JSON.stringify({
        jsonrpc: '2.0',
        id: 105,
        method: 'tools/call',
        params: {
          name: 'buildergate.message.send',
          arguments: { alias: '클로드', prompt: 'message by alias' },
        },
      }), 'utf8'),
      remoteAddress: '127.0.0.1',
    }), 'authenticated MCP message.send by alias response');
    const aliasSendBody = asRecord(authenticatedAliasSend.body, 'authenticated MCP alias send JSON-RPC body');
    const aliasSendResult = asRecord(aliasSendBody.result, 'authenticated MCP alias send result');
    assert.equal(authenticatedAliasSend.status, 200);
    assert.equal(aliasSendBody.id, 105);
    assert.equal(aliasSendResult.ok, true);

    const authenticatedSessionIdSend = asRecord(await callMcpHttpHandler(authenticatedHandler, {
      method: 'POST',
      path: '/mcp',
      headers: sharedAuthHeaders,
      credential,
      body: Buffer.from(JSON.stringify({
        jsonrpc: '2.0',
        id: 106,
        method: 'tools/call',
        params: {
          name: 'buildergate.message.send',
          arguments: { sessionId: 'target-current-session-id', prompt: 'message by runtime session id' },
        },
      }), 'utf8'),
      remoteAddress: '127.0.0.1',
    }), 'authenticated MCP message.send by sessionId response');
    const sessionIdSendBody = asRecord(authenticatedSessionIdSend.body, 'authenticated MCP sessionId send JSON-RPC body');
    const sessionIdSendResult = asRecord(sessionIdSendBody.result, 'authenticated MCP sessionId send result');
    assert.equal(authenticatedSessionIdSend.status, 200);
    assert.equal(sessionIdSendBody.id, 106);
    assert.equal(sessionIdSendResult.ok, true);

    const staleSessionIdService = await createMcpToolServiceHarness({
      deps: {
        sessions: [{
          sessionId: 'target-current-session-id',
          currentSessionId: 'target-current-session-id',
          previousSessionIds: ['old-target-session-id'],
          sessionKey: 'target-session',
          alias: '클로드',
          workspaceId: 'workspace-1',
          tabId: 'tab-2',
          bindingLifecycle: 'live',
          agentStatus: 'ready',
          mcpConnected: true,
        }],
      },
    });
    const staleSessionIdSend = asRecord(await callMcpToolService(staleSessionIdService, 'callTool', {
      name: 'buildergate.message.send',
      actor: createMcpActor(),
      arguments: { sessionId: 'old-target-session-id', prompt: 'stale session id message' },
    }), 'MCP message.send stale sessionId result');
    assert.equal(staleSessionIdSend.ok, false);
    assert.equal(staleSessionIdSend.code, 'STALE_SESSION_ID');
    assert.equal(staleSessionIdSend.currentSessionId, 'target-current-session-id');

    const staleTargetSend = asRecord(await callMcpToolService(staleSessionIdService, 'callTool', {
      name: 'buildergate.message.send',
      actor: createMcpActor(),
      arguments: { target: 'old-target-session-id', prompt: 'stale generic target message' },
    }), 'MCP message.send stale target sessionId result');
    assert.equal(staleTargetSend.ok, false);
    assert.equal(staleTargetSend.code, 'STALE_SESSION_ID');
    assert.equal(staleTargetSend.currentSessionId, 'target-current-session-id');

    const staleSearchTargetService = await createMcpToolServiceHarness({
      deps: {
        sessions: [{
          sessionId: 'target-current-session-id',
          currentSessionId: 'target-current-session-id',
          sessionKey: 'target-session',
          alias: '클로드',
          workspaceId: 'workspace-1',
          tabId: 'tab-2',
          bindingLifecycle: 'live',
          agentStatus: 'ready',
          mcpConnected: true,
        }],
        searchSessions: () => ({
          allowed: true,
          matches: [{
            sessionId: 'target-current-session-id',
            currentSessionId: 'target-current-session-id',
            sessionKey: 'target-session',
            alias: '클로드',
            matchSource: 'previous-session-id',
            matchType: 'exact-previous-session-id',
          }],
        }),
      },
    });
    const staleSearchTargetSend = asRecord(await callMcpToolService(staleSearchTargetService, 'callTool', {
      name: 'buildergate.message.send',
      actor: createMcpActor(),
      arguments: { target: 'old-target-session-id', prompt: 'stale search target message' },
    }), 'MCP message.send stale search target result');
    assert.equal(staleSearchTargetSend.ok, false);
    assert.equal(staleSearchTargetSend.code, 'STALE_SESSION_ID');
    assert.equal(staleSearchTargetSend.currentSessionId, 'target-current-session-id');

    const ambiguousAliasService = await createMcpToolServiceHarness({
      deps: {
        sessions: [
          {
            sessionId: 'sess-one-current',
            currentSessionId: 'sess-one-current',
            sessionKey: 'sess-one',
            alias: 'builder',
            workspaceId: 'workspace-1',
            tabId: 'tab-one',
            bindingLifecycle: 'live',
            agentStatus: 'ready',
            mcpConnected: true,
          },
          {
            sessionId: 'sess-two-current',
            currentSessionId: 'sess-two-current',
            sessionKey: 'sess-two',
            alias: 'builder',
            workspaceId: 'workspace-1',
            tabId: 'tab-two',
            bindingLifecycle: 'live',
            agentStatus: 'ready',
            mcpConnected: true,
          },
        ],
      },
    });
    const ambiguousAliasSend = asRecord(await callMcpToolService(ambiguousAliasService, 'callTool', {
      name: 'buildergate.message.send',
      actor: createMcpActor(),
      arguments: { alias: 'builder', prompt: 'ambiguous alias message' },
    }), 'MCP message.send ambiguous alias result');
    assert.equal(ambiguousAliasSend.ok, false);
    assert.equal(ambiguousAliasSend.code, 'AMBIGUOUS_TARGET');
    assert.equal(asRecordArray(ambiguousAliasSend.matches, 'ambiguous alias matches').length, 2);

    const replyDeliveries: Record<string, unknown>[] = [];
    const replyService = await createMcpToolServiceHarness({
      deps: {
        sessions: [
          {
            sessionId: 'follower-current-session-id',
            currentSessionId: 'follower-current-session-id',
            sessionKey: 'follower-session',
            alias: 'Follower',
            leaderSessionKey: 'leader-session',
            workspaceId: 'workspace-1',
            tabId: 'tab-follower',
            bindingLifecycle: 'live',
            agentStatus: 'ready',
            mcpConnected: true,
          },
          {
            sessionId: 'leader-current-session-id',
            currentSessionId: 'leader-current-session-id',
            sessionKey: 'leader-session',
            alias: 'Leader',
            workspaceId: 'workspace-1',
            tabId: 'tab-leader',
            bindingLifecycle: 'live',
            agentStatus: 'ready',
            mcpConnected: true,
          },
        ],
        deliverMessage: (delivery: unknown) => {
          const record = asRecord(delivery, 'reply_to_leader delivery');
          replyDeliveries.push(record);
          return { ok: true, accepted: true, status: 'delivered', assignmentId: 'reply-assignment' };
        },
      },
    });
    const replyToLeader = asRecord(await callMcpToolService(replyService, 'callTool', {
      name: 'buildergate.message.reply_to_leader',
      actor: createMcpActor({ sessionKey: 'follower-session' }),
      arguments: { prompt: 'reply to leader', deliveryMode: 'submit' },
    }), 'MCP reply_to_leader result');
    assert.equal(replyToLeader.ok, true);
    assert.equal(replyDeliveries.length, 1);
    assert.equal(replyDeliveries[0].sessionKey, 'leader-session');
    assert.equal(replyDeliveries[0].source, 'mcp-reply-to-leader');

    const missingPromptSend = asRecord(await callMcpToolService(replyService, 'callTool', {
      name: 'buildergate.message.send',
      actor: createMcpActor({ sessionKey: 'follower-session' }),
      arguments: { sessionKey: 'leader-session' },
    }), 'MCP message.send missing prompt result');
    const emptyPromptReply = asRecord(await callMcpToolService(replyService, 'callTool', {
      name: 'buildergate.message.reply_to_leader',
      actor: createMcpActor({ sessionKey: 'follower-session' }),
      arguments: { prompt: '   ', deliveryMode: 'paste' },
    }), 'MCP reply_to_leader empty prompt result');
    assert.equal(missingPromptSend.ok, false);
    assert.equal(missingPromptSend.code, 'VALIDATION_ERROR');
    assert.equal(asRecord(missingPromptSend.fieldErrors, 'missing prompt errors').prompt, 'required');
    assert.equal(emptyPromptReply.ok, false);
    assert.equal(emptyPromptReply.code, 'VALIDATION_ERROR');
    assert.equal(asRecord(emptyPromptReply.fieldErrors, 'empty reply prompt errors').prompt, 'required');

    const failingDeliveryService = await createMcpToolServiceHarness({
      deps: {
        deliverMessage: () => ({
          ok: false,
          accepted: false,
          code: 'TARGET_NOT_LIVE',
          message: 'target is no longer live',
          details: { lifecycle: 'stopped' },
          fieldErrors: { sessionKey: 'not live' },
          auditId: 'audit-provider-delivery',
          status: 'failed',
        }),
      },
    });
    const failingDeliveryHandler = asRecord(createHandler({
      service: failingDeliveryService,
      listenerController: createController({ current: { bindHost: '127.0.0.1', port: 3333 } }),
    }), 'failing delivery MCP HTTP handler');
    const failingDeliveryCredential = await createValidMcpCredential('self-session-key');
    const failingDelivery = asRecord(await callMcpHttpHandler(failingDeliveryHandler, {
      method: 'POST',
      path: '/mcp',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        authorization: `Bearer ${failingDeliveryCredential.token}`,
      },
      credential: failingDeliveryCredential,
      body: Buffer.from(JSON.stringify({
        jsonrpc: '2.0',
        id: 104,
        method: 'tools/call',
        params: {
          name: 'buildergate.message.send',
          arguments: { sessionKey: 'target-session', prompt: 'message to stopped session' },
        },
      }), 'utf8'),
      remoteAddress: '127.0.0.1',
    }), 'authenticated MCP message.send delivery failure response');
    const failingDeliveryBody = asRecord(failingDelivery.body, 'authenticated MCP failed send JSON-RPC body');
    const failingDeliveryResult = asRecord(failingDeliveryBody.result, 'authenticated MCP failed send result');
    assert.equal(failingDelivery.status, 200);
    assert.equal(failingDeliveryBody.id, 104);
    assert.equal(failingDeliveryResult.ok, false);
    assert.equal(failingDeliveryResult.code, 'TARGET_NOT_LIVE');
    assert.equal(failingDeliveryResult.message, 'target is no longer live');
    assert.equal(asRecord(failingDeliveryResult.details, 'failed send details').lifecycle, 'stopped');
    assert.equal(asRecord(failingDeliveryResult.fieldErrors, 'failed send field errors').sessionKey, 'not live');
    assert.equal(failingDeliveryResult.deliveryAuditId, 'audit-provider-delivery');

    const gatewayDeliveryFailure = asRecord(buildMcpGatewayDeliveryResponse({
      accepted: false,
      code: 'TARGET_NOT_LIVE',
      message: 'target is no longer live',
      details: { sessionKey: 'target-session' },
      fieldErrors: { sessionKey: 'not live' },
      auditId: 'audit-runtime-gateway',
    }), 'runtime gateway delivery failure');
    assert.equal(gatewayDeliveryFailure.ok, false);
    assert.equal(gatewayDeliveryFailure.status, 'failed');
    assert.equal(gatewayDeliveryFailure.code, 'TARGET_NOT_LIVE');
    assert.equal(gatewayDeliveryFailure.message, 'target is no longer live');
    assert.equal(asRecord(gatewayDeliveryFailure.details, 'runtime gateway delivery details').sessionKey, 'target-session');
    assert.equal(asRecord(gatewayDeliveryFailure.fieldErrors, 'runtime gateway delivery field errors').sessionKey, 'not live');
    assert.equal(gatewayDeliveryFailure.auditId, 'audit-runtime-gateway');
  },
  'MCP_transport_and_tool_red_tests_IR-MCP-001_AC-2': async () => {
    const service = await createMcpToolServiceHarness();
    const result = asRecord(await callMcpToolService(service, 'callTool', {
      name: 'buildergate.session.whoami',
      actor: createMcpActor(),
      arguments: {},
    }), 'MCP whoami tool result');

    for (const key of ['sessionId', 'sessionKey', 'workspaceId', 'tabId', 'alias', 'agentKind', 'leaderSessionKey', 'bindingLifecycle', 'agentStatus']) {
      assert.ok(result[key] !== undefined, `whoami must include ${key}`);
    }
    assert.equal(result.sessionKey, 'self-session-key');
    assert.equal(result.bindingLifecycle, 'live');
  },
  'MCP_transport_and_tool_red_tests_IR-MCP-001_AC-3': async () => {
    const claimTokenMints: Record<string, unknown>[] = [];
    const service = await createMcpToolServiceHarness({
      deps: {
        tokenStore: {
          mint: (request: unknown) => {
            const record = asRecord(request, 'claim token mint request');
            claimTokenMints.push(record);
            return mintMcpCapabilityToken({
              audience: String(record.audience),
              sessionKey: String(record.sessionKey),
              scopes: Array.isArray(record.scopes) ? record.scopes.map(String) : [],
              expiresInSeconds: Number(record.expiresInSeconds ?? 300),
            });
          },
        },
      },
    });
    const ordinaryDenied = asRecord(await callMcpToolService(service, 'callTool', {
      name: 'buildergate.session.claim',
      actor: createMcpActor({ sessionKey: undefined, scopes: [...expectedDefaultMcpScopes] }),
      arguments: { claimCode: 'claim-once-code', sessionKey: 'manual-session-key' },
    }), 'ordinary MCP actor claim denial');
    const first = asRecord(await callMcpToolService(service, 'callTool', {
      name: 'buildergate.session.claim',
      actor: createMcpActor({ sessionKey: undefined }),
      arguments: { claimCode: 'claim-once-code', sessionKey: 'manual-session-key' },
    }), 'MCP claim first result');
    const second = asRecord(await callMcpToolService(service, 'callTool', {
      name: 'buildergate.session.claim',
      actor: createMcpActor({ sessionKey: undefined }),
      arguments: { claimCode: 'claim-once-code', sessionKey: 'manual-session-key' },
    }), 'MCP claim reuse result');

    assert.equal(ordinaryDenied.ok, false);
    assert.equal(ordinaryDenied.code, 'INVALID_SCOPE');
    assert.equal(first.ok, true);
    assert.equal(typeof first.actorToken, 'string');
    assert.equal(first.sessionKey, 'manual-session-key');
    assert.deepEqual(readMcpTokenScopes(String(first.actorToken)).sort(), [...expectedDefaultMcpScopes].sort());
    assert.equal(readMcpTokenScopes(String(first.actorToken)).includes('mcp:session.open'), false);
    assert.equal(readMcpTokenScopes(String(first.actorToken)).includes('mcp:session.close_self'), false);
    assert.equal(claimTokenMints.length, 1);
    assert.equal(claimTokenMints[0].sessionKey, 'manual-session-key');
    assert.equal(second.ok, false);
    assert.equal(second.code, 'CLAIM_CODE_REUSED');

    const expiredService = await createMcpToolServiceHarness({
      deps: {
        claimCodes: new Map([['claim-expired', {
          sessionKey: 'manual-session-key',
          used: false,
          expiresAt: '2026-07-09T02:29:59.000Z',
        }]]),
      },
    });
    const expired = asRecord(await callMcpToolService(expiredService, 'callTool', {
      name: 'buildergate.session.claim',
      actor: createMcpActor({ sessionKey: undefined, scopes: ['mcp:session.claim'] }),
      arguments: { claimCode: 'claim-expired', sessionKey: 'manual-session-key' },
    }), 'expired claim denial');
    assert.equal(expired.code, 'CLAIM_CODE_EXPIRED');

    const deadSessionService = await createMcpToolServiceHarness({
      deps: {
        claimCodes: new Map([['claim-dead-session', {
          sessionKey: 'dead-session-key',
          used: false,
          expiresAt: '2026-07-09T02:35:00.000Z',
        }]]),
      },
    });
    const deadSession = asRecord(await callMcpToolService(deadSessionService, 'callTool', {
      name: 'buildergate.session.claim',
      actor: createMcpActor({ sessionKey: undefined, scopes: ['mcp:session.claim'] }),
      arguments: { claimCode: 'claim-dead-session', sessionKey: 'dead-session-key' },
    }), 'dead claim session denial');
    assert.equal(deadSession.code, 'TARGET_NOT_LIVE');

    const httpService = await createMcpToolServiceHarness();
    const contract = await loadMcpTransportToolContract();
    const createHandler = getMcpTransportFunction(contract, 'createMcpHttpHandler');
    const createController = getMcpTransportFunction(contract, 'createMcpListenerController');
    const httpHandler = createHandler({
      service: httpService,
      listenerController: createController({ current: { bindHost: '127.0.0.1', port: 3333 } }),
    });
    const initialized = asRecord(await callMcpHttpHandler(asRecord(httpHandler, 'MCP HTTP claim handler'), {
      method: 'POST',
      path: '/mcp',
      headers: { 'content-type': 'application/json; charset=utf-8', authorization: 'Bearer claim-once-code' },
      credential: classifyMcpBearerCredential('claim-once-code'),
      body: Buffer.from(JSON.stringify({
        jsonrpc: '2.0',
        id: 30,
        method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'manual', version: '1' } },
      }), 'utf8'),
      remoteAddress: '127.0.0.1',
    }), 'MCP HTTP claim initialize response');
    const mcpSessionId = String(asRecord(initialized.headers, 'MCP HTTP claim initialize headers')['mcp-session-id'] ?? '');
    assert.equal(initialized.status, 200);
    assert.match(mcpSessionId, /^[0-9a-f-]{36}$/iu);
    const httpClaim = asRecord(await callMcpHttpHandler(asRecord(httpHandler, 'MCP HTTP claim handler'), {
      method: 'POST',
      path: '/mcp',
      headers: { 'content-type': 'application/json; charset=utf-8', 'mcp-session-id': mcpSessionId },
      credential: classifyMcpBearerCredential('claim-once-code'),
      body: Buffer.from(JSON.stringify({
        jsonrpc: '2.0',
        id: 31,
        method: 'tools/call',
        params: {
          name: 'buildergate.session.claim',
          arguments: { claimCode: 'claim-once-code', sessionKey: 'manual-session-key' },
        },
      }), 'utf8'),
      remoteAddress: '127.0.0.1',
    }), 'MCP HTTP claim bootstrap response');
    const claimBody = asRecord(httpClaim.body, 'MCP HTTP claim bootstrap body');
    const claimResult = asRecord(claimBody.result, 'MCP HTTP claim bootstrap result');
    assert.equal(httpClaim.status, 200);
    assert.equal(claimBody.id, 31);
    assert.equal(claimResult.ok, true);
    assert.equal('actorToken' in claimResult, false);
  },
  'MCP_Claude_Code_compatibility_bootstrap_session_claims_before_protected_tools': async () => {
    const contract = await loadMcpTransportToolContract();
    const createHandler = getMcpTransportFunction(contract, 'createMcpHttpHandler');
    const createController = getMcpTransportFunction(contract, 'createMcpListenerController');
    const handler = asRecord(createHandler({
      service: await createMcpToolServiceHarness({
        deps: {
          sessions: [{
            sessionId: 'manual-current-session-id',
            sessionKey: 'manual-session-key',
            workspaceId: 'workspace-1',
            tabId: 'tab-manual',
            alias: '수동 Claude',
            agentKind: 'claude',
            bindingLifecycle: 'live',
            agentStatus: 'ready',
            mcpConnected: true,
          }],
        },
      }),
      listenerController: createController({ current: { bindHost: '127.0.0.1', port: 3333 } }),
    }), 'Claude Code MCP HTTP handler');
    const request = async (body: Record<string, unknown>, headers: Record<string, string> = {}) => asRecord(
      await callMcpHttpHandler(handler, {
        method: 'POST',
        path: '/mcp',
        headers: {
          'content-type': 'application/json; charset=utf-8',
          accept: 'application/json, text/event-stream',
          ...headers,
        },
        credential: headers.authorization?.startsWith('Bearer ')
          ? classifyMcpBearerCredential(headers.authorization.slice('Bearer '.length))
          : undefined,
        body: Buffer.from(JSON.stringify(body), 'utf8'),
        remoteAddress: '127.0.0.1',
      }),
      'Claude Code MCP HTTP response',
    );

    const unauthenticated = await request({
      jsonrpc: '2.0',
      id: 101,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'Claude Code', version: '2.1.198' },
      },
    });
    assert.equal(unauthenticated.status, 403);
    assert.equal(asRecord(asRecord(unauthenticated.body, 'unauthenticated initialize body').error, 'unauthenticated initialize error').message, 'INVALID_TOKEN');

    const initialized = await request({
      jsonrpc: '2.0',
      id: 101,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'Claude Code', version: '2.1.198' },
      },
    }, { authorization: 'Bearer claim-once-code' });
    const initializedBody = asRecord(initialized.body, 'MCP initialize body');
    const initializedResult = asRecord(initializedBody.result, 'MCP initialize result');
    const mcpSessionId = String(asRecord(initialized.headers, 'MCP initialize headers')['mcp-session-id'] ?? '');
    assert.equal(initialized.status, 200);
    assert.equal(initializedBody.id, 101);
    assert.equal(initializedResult.protocolVersion, '2025-11-25');
    assert.equal(asRecord(initializedResult.serverInfo, 'MCP server info').name, 'BuilderGate MCP Server');
    assert.match(mcpSessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu);

    const ready = await request({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
      params: {},
    }, { 'mcp-session-id': mcpSessionId, authorization: 'Bearer claim-once-code' });
    assert.equal(ready.status, 202);

    const bootstrapTools = await request({
      jsonrpc: '2.0',
      id: 102,
      method: 'tools/list',
      params: {},
    }, { 'mcp-session-id': mcpSessionId, authorization: 'Bearer claim-once-code' });
    const bootstrapToolList = asRecordArray(
      asRecord(asRecord(bootstrapTools.body, 'bootstrap tools body').result, 'bootstrap tools result').tools,
      'bootstrap tool list',
    );
    assert.deepEqual(bootstrapToolList.map(tool => tool.name), ['buildergate.session.claim']);

    const unboundWhoami = await request({
      jsonrpc: '2.0',
      id: 102,
      method: 'tools/call',
      params: { name: 'buildergate.session.whoami', arguments: {} },
    }, { 'mcp-session-id': mcpSessionId, authorization: 'Bearer claim-once-code' });
    assert.equal(unboundWhoami.status, 403);
    assert.equal(asRecord(unboundWhoami.body, 'unbound whoami body').error !== undefined, true);

    const claimed = await request({
      jsonrpc: '2.0',
      id: 103,
      method: 'tools/call',
      params: {
        name: 'buildergate.session.claim',
        arguments: { claimCode: 'claim-once-code', sessionKey: 'manual-session-key' },
      },
    }, { 'mcp-session-id': mcpSessionId, authorization: 'Bearer claim-once-code' });
    const claimedResult = asRecord(asRecord(claimed.body, 'claimed response body').result, 'claimed response result');
    assert.equal(claimed.status, 200);
    assert.equal(claimedResult.ok, true);
    assert.equal('actorToken' in claimedResult, false);

    const boundWhoami = await request({
      jsonrpc: '2.0',
      id: 104,
      method: 'tools/call',
      params: { name: 'buildergate.session.whoami', arguments: {} },
    }, { 'mcp-session-id': mcpSessionId, authorization: 'Bearer claim-once-code' });
    const boundResult = asRecord(asRecord(boundWhoami.body, 'bound whoami body').result, 'bound whoami result');
    assert.equal(boundWhoami.status, 200);
    assert.equal(boundResult.sessionKey, 'manual-session-key');

    const get = asRecord(await callMcpHttpHandler(handler, {
      method: 'GET',
      path: '/mcp',
      headers: { accept: 'text/event-stream', 'mcp-session-id': mcpSessionId },
      body: Buffer.alloc(0),
      remoteAddress: '127.0.0.1',
    }), 'MCP GET response');
    assert.equal(get.status, 405);
    assert.equal(asRecord(get.headers, 'MCP GET headers').allow, 'POST');
  },
  'MCP_transport_and_tool_red_tests_IR-MCP-001_AC-4': async () => {
    const service = await createMcpToolServiceHarness();
    const invalidPayload = asRecord(await callMcpToolService(service, 'callTool', {
      name: 'buildergate.message.send',
      actor: createMcpActor({ scopes: ['mcp:self.read'] }),
      arguments: { sessionKey: 'target-session', prompt: 'hello' },
    }), 'MCP invalid payload result');
    const unknownTool = asRecord(await callMcpToolService(service, 'callTool', {
      name: 'buildergate.session.unknown',
      actor: createMcpActor(),
      arguments: {},
    }), 'MCP unknown tool result');

    assert.equal(invalidPayload.ok, false);
    assert.equal(invalidPayload.code, 'INVALID_SCOPE');
    assert.equal(unknownTool.ok, false);
    assert.equal(unknownTool.code, 'UNKNOWN_TOOL');
  },
  'MCP_transport_and_tool_red_tests_IR-MCP-001_AC-5': async () => {
    const handler = await createMcpHttpHandlerHarness();
    const toolCalls = [
      { id: 7, name: 'buildergate.session.whoami', arguments: {} },
      { id: 8, name: 'buildergate.session.list', arguments: { includeSelf: true } },
      { id: 9, name: 'buildergate.session.search', arguments: { query: '빌더 게이트' } },
      { id: 10, name: 'buildergate.session.set_alias', arguments: { sessionKey: 'target-session', alias: '새 별칭' } },
      { id: 11, name: 'buildergate.message.send', arguments: { sessionKey: 'target-session', prompt: 'HTTP paste prompt', deliveryMode: 'paste' } },
      { id: 12, name: 'buildergate.session.update_status', arguments: { agentStatus: 'waiting_input' } },
    ];

    for (const toolCall of toolCalls) {
      const requestBody = {
        jsonrpc: '2.0',
        id: toolCall.id,
        method: 'tools/call',
        params: {
          name: toolCall.name,
          arguments: toolCall.arguments,
        },
      };
      const response = asRecord(await callMcpHttpHandler(handler, {
        method: 'POST',
        path: '/mcp',
        headers: { 'content-type': 'application/json; charset=utf-8', authorization: 'Bearer valid-mcp-capability-token' },
        credential: createMcpActor({ token: 'valid-mcp-capability-token' }),
        body: Buffer.from(JSON.stringify(requestBody), 'utf8'),
        remoteAddress: '127.0.0.1',
      }), `MCP streamable HTTP response: ${toolCall.name}`);

      assert.equal(response.status, 200);
      assert.match(String(response.contentType), /application\/json/u);
      assert.match(String(response.contentType), /utf-8/i);
      const body = asRecord(response.body, `MCP JSON-RPC response: ${toolCall.name}`);
      assert.equal(body.jsonrpc, '2.0');
      assert.equal(body.id, toolCall.id);
      assert.equal(body.error, undefined);
      assert.ok(body.result !== undefined);
      assert.match(toolCall.name, /^[\x20-\x7e]+$/u);
      assert.doesNotMatch(JSON.stringify(response.body), /빌더 게이트.*buildergate\./u);
    }

    try {
      await readMcpIncomingRequestBody((async function* overflowBody() {
        yield Buffer.alloc((1024 * 1024) + 1);
      })());
      assert.fail('oversized MCP request body must throw');
    } catch (error) {
      const response = asRecord(buildMcpNodeRequestErrorResponse(error, () => 'audit-oversized-mcp-body'), 'oversized MCP body response');
      const body = asRecord(response.body, 'oversized MCP body JSON-RPC body');
      const errorBody = asRecord(body.error, 'oversized MCP body error');
      const data = asRecord(errorBody.data, 'oversized MCP body error data');
      assert.equal(response.status, 413);
      assert.equal(errorBody.message, 'MCP_REQUEST_TOO_LARGE');
      assert.equal(data.code, 'MCP_REQUEST_TOO_LARGE');
      assert.equal(data.auditId, 'audit-oversized-mcp-body');
    }
  },
  'MCP_transport_and_tool_red_tests_OBS-MCP-001_AC-1': async () => {
    const calls = createMcpToolHarnessCalls();
    const service = await createMcpToolServiceHarness({ calls });
    const result = asRecord(await callMcpToolService(service, 'callTool', {
      name: 'buildergate.message.send',
      actor: createMcpActor(),
      arguments: { sessionKey: 'target-session', prompt: 'audit prompt', deliveryMode: 'paste' },
      requestId: 'req-audit-1',
      sourceIp: '127.0.0.1',
    }), 'MCP message send result');
    const statusUpdate = asRecord(await callMcpToolService(service, 'callTool', {
      name: 'buildergate.session.update_status',
      actor: createMcpActor(),
      arguments: { agentStatus: 'waiting_input', statusMessage: 'ready for next task' },
      requestId: 'req-status-1',
      sourceIp: '127.0.0.1',
    }), 'MCP update_status result');

    assert.equal(result.ok, true);
    assert.equal(typeof result.auditId, 'string');
    assert.equal(statusUpdate.ok, true);
    assert.equal(statusUpdate.agentStatus, 'waiting_input');
    assert.ok(calls.auditEvents.length > 0, 'MCP tool call must record an audit event');
    const audit = asRecord(calls.auditEvents.find((event) => event.action === 'buildergate.message.send'), 'message.send audit event');
    const statusAudit = asRecord(calls.auditEvents.find((event) => event.action === 'buildergate.session.update_status'), 'update_status audit event');
    assert.equal(audit.actorType, 'mcp');
    assert.equal(audit.actorSessionKey, 'self-session-key');
    assert.equal(audit.sourceIp, '127.0.0.1');
    assert.equal(audit.requestId, 'req-audit-1');
    assert.ok(Array.isArray(audit.scopes));
    assert.ok(audit.result !== undefined || audit.reason !== undefined);
    const messageTargetBinding = asRecord(audit.targetBinding ?? audit.target, 'message.send audit target binding');
    assert.equal(messageTargetBinding.sessionKey, 'target-session');
    assert.ok(audit.promptHash || audit.promptPreview);
    assert.equal(statusAudit.actorType, 'mcp');
    assert.equal(statusAudit.actorSessionKey, 'self-session-key');
    assert.equal(statusAudit.sourceIp, '127.0.0.1');
    assert.equal(statusAudit.requestId, 'req-status-1');
    assert.ok(Array.isArray(statusAudit.scopes));
    assert.ok(statusAudit.result !== undefined || statusAudit.reason !== undefined);
  },
  'MCP_transport_and_tool_red_tests_OBS-MCP-001_AC-2': async () => {
    const calls = createMcpToolHarnessCalls();
    const service = await createMcpToolServiceHarness({ calls });
    await callMcpToolService(service, 'callTool', {
      name: 'buildergate.message.send',
      actor: createMcpActor({ token: 'raw-mcp-token-secret' }),
      arguments: {
        sessionKey: 'target-session',
        prompt: 'raw long prompt material that must not be persisted',
        webhookKey: 'raw-webhook-key-secret',
        fullUrl: 'https://localhost:2222/mcp?token=raw-query-token-secret',
      },
    });
    const status = await callMcpToolService(service, 'getStatus', {});

    assertNoSecretMaterial({
      audit: calls.auditEvents,
      logs: calls.logs,
      status,
    }, [
      'raw-mcp-token-secret',
      'raw-webhook-key-secret',
      'raw-query-token-secret',
      'raw long prompt material that must not be persisted',
    ]);
  },
  'MCP_transport_and_tool_red_tests_OBS-MCP-001_AC-3': async () => {
    const service = await createMcpToolServiceHarness();
    const status = asRecord(await callMcpToolService(service, 'getStatus', {}), 'MCP listener status');
    for (const key of ['enabled', 'bindHost', 'port', 'listenerStatus', 'activeConnectionCount', 'lastRebindResult', 'lastError', 'rejectedRequestCounters']) {
      assert.ok(status[key] !== undefined, `MCP listener status must include ${key}`);
    }
    assert.equal(status.bindHost, '127.0.0.1');
    assert.equal(typeof status.activeConnectionCount, 'number');
  },
  'MCP_transport_and_tool_red_tests_OBS-MCP-001_AC-4': async () => {
    const calls = createMcpToolHarnessCalls();
    const service = await createMcpToolServiceHarness({ calls });
    const result = asRecord(await callMcpToolService(service, 'callTool', {
      name: 'buildergate.session.list',
      actor: createMcpActor(),
      arguments: { includeSelf: true },
      requestId: 'req-list-1',
      sourceIp: '127.0.0.1',
    }), 'MCP session list result');
    const omittedIncludeSelf = asRecord(await callMcpToolService(service, 'callTool', {
      name: 'buildergate.session.list',
      actor: createMcpActor(),
      arguments: {},
      requestId: 'req-list-default-include-self',
      sourceIp: '127.0.0.1',
    }), 'MCP session list default includeSelf result');
    const search = asRecord(await callMcpToolService(service, 'callTool', {
      name: 'buildergate.session.search',
      actor: createMcpActor(),
      arguments: { query: '클로드' },
      requestId: 'req-search-1',
      sourceIp: '127.0.0.1',
    }), 'MCP session search result');
    const aliasUpdate = asRecord(await callMcpToolService(service, 'callTool', {
      name: 'buildergate.session.set_alias',
      actor: createMcpActor(),
      arguments: { sessionKey: 'target-session', alias: '새 별칭' },
      requestId: 'req-alias-1',
      sourceIp: '127.0.0.1',
    }), 'MCP session set_alias result');
    const sessions = asRecordArray(result.sessions, 'MCP live sessions');
    const defaultSessions = asRecordArray(omittedIncludeSelf.sessions, 'MCP default includeSelf sessions');
    const matches = asRecordArray(search.matches, 'MCP session search matches');

    for (const session of sessions) {
      for (const key of ['alias', 'agentKind', 'agentStatus', 'bindingLifecycle', 'mcpConnected', 'leader', 'workspaceId', 'tabId', 'sessionId', 'sessionKey', 'lastSeenAt']) {
        assert.ok(session[key] !== undefined, `live session status must include ${key}`);
      }
      assert.equal(session.token, undefined);
      assert.equal(session.actorToken, undefined);
      assert.equal(session.mcpToken, undefined);
    }
    assert.ok(defaultSessions.some((session) => session.sessionKey === 'self-session-key'));
    for (const match of matches) {
      assert.equal(match.token, undefined);
      assert.equal(match.actorToken, undefined);
      assert.equal(match.mcpToken, undefined);
    }
    assert.ok(matches.some((match) => match.sessionKey === 'target-session'));
    assert.equal(aliasUpdate.ok, true);
    assert.equal(aliasUpdate.alias, '새 별칭');
    assertNoSecretMaterial({ result, search, aliasUpdate }, ['must-not-leak-session-token', 'redacted-session-token']);

    for (const expected of [
      { action: 'buildergate.session.list', requestId: 'req-list-1' },
      { action: 'buildergate.session.search', requestId: 'req-search-1' },
      { action: 'buildergate.session.set_alias', requestId: 'req-alias-1', targetSessionKey: 'target-session' },
    ]) {
      const audit = asRecord(calls.auditEvents.find((event) => event.action === expected.action), `${expected.action} audit event`);
      assert.equal(audit.actorType, 'mcp');
      assert.equal(audit.actorSessionKey, 'self-session-key');
      assert.equal(audit.sourceIp, '127.0.0.1');
      assert.equal(audit.requestId, expected.requestId);
      assert.ok(Array.isArray(audit.scopes));
      assert.ok(audit.result !== undefined || audit.reason !== undefined);
      if (expected.targetSessionKey) {
        const targetBinding = asRecord(audit.targetBinding ?? audit.target, `${expected.action} audit target binding`);
        assert.equal(targetBinding.sessionKey, expected.targetSessionKey);
      }
    }
    assertNoSecretMaterial(calls.auditEvents, ['must-not-leak-session-token', 'redacted-session-token']);

    const failureCalls = createMcpToolHarnessCalls();
    const failureService = await createMcpToolServiceHarness({
      calls: failureCalls,
      deps: {
        listSessions: () => ({
          allowed: false,
          code: 'TARGET_NOT_FOUND',
          message: 'list failed',
          candidates: [{ sessionKey: 'candidate-list' }],
        }),
        setSessionAlias: () => ({
          ok: false,
          code: 'TARGET_NOT_FOUND',
          message: 'alias failed',
          fieldErrors: { sessionKey: 'not found' },
        }),
      },
    });
    const failedList = asRecord(await callMcpToolService(failureService, 'callTool', {
      name: 'buildergate.session.list',
      actor: createMcpActor(),
      arguments: { includeSelf: true },
      requestId: 'req-list-failed',
      sourceIp: '127.0.0.1',
    }), 'MCP failed session list result');
    const failedAlias = asRecord(await callMcpToolService(failureService, 'callTool', {
      name: 'buildergate.session.set_alias',
      actor: createMcpActor(),
      arguments: { sessionKey: 'missing-session', alias: 'missing' },
      requestId: 'req-alias-failed',
      sourceIp: '127.0.0.1',
    }), 'MCP failed set_alias result');
    assert.equal(failedList.allowed, false);
    assert.equal(failedList.code, 'TARGET_NOT_FOUND');
    assert.equal(failedList.message, 'list failed');
    assert.equal(asRecordArray(failedList.candidates, 'failed MCP list candidates')[0]?.sessionKey, 'candidate-list');
    assert.equal(failedAlias.ok, false);
    assert.equal(failedAlias.code, 'TARGET_NOT_FOUND');
    assert.equal(failedAlias.message, 'alias failed');
    assert.equal(asRecord(failedAlias.fieldErrors, 'failed MCP alias field errors').sessionKey, 'not found');
    const throwingAliasService = await createMcpToolServiceHarness({
      deps: {
        setSessionAlias: () => {
          const error = new Error('tab missing');
          (error as Error & { code?: string }).code = 'TAB_NOT_FOUND';
          throw error;
        },
      },
    });
    const thrownAlias = asRecord(await callMcpToolService(throwingAliasService, 'callTool', {
      name: 'buildergate.session.set_alias',
      actor: createMcpActor(),
      arguments: { sessionKey: 'missing-session', alias: 'missing' },
      requestId: 'req-alias-throws',
      sourceIp: '127.0.0.1',
    }), 'MCP thrown set_alias result');
    assert.equal(thrownAlias.ok, false);
    assert.equal(thrownAlias.code, 'TARGET_NOT_FOUND');
    assert.equal(thrownAlias.message, 'tab missing');
    assert.equal(asRecord(thrownAlias.fieldErrors, 'thrown MCP alias field errors').sessionKey, 'not found');
    assert.equal(typeof thrownAlias.auditId, 'string');
    const deniedListAudit = asRecord(failureCalls.auditEvents.find(event => event.requestId === 'req-list-failed'), 'failed MCP list audit');
    const deniedAliasAudit = asRecord(failureCalls.auditEvents.find(event => event.requestId === 'req-alias-failed'), 'failed MCP alias audit');
    assert.equal(deniedListAudit.result, 'denied');
    assert.equal(deniedListAudit.reason, 'TARGET_NOT_FOUND');
    assert.equal(deniedAliasAudit.result, 'denied');
    assert.equal(deniedAliasAudit.reason, 'TARGET_NOT_FOUND');
  },
  'MCP_transport_and_tool_red_tests_OBS-MCP-001_AC-5': async () => {
    const service = await createMcpToolServiceHarness();
    const result = asRecord(await callMcpToolService(service, 'callTool', {
      name: 'buildergate.message.send',
      actor: createMcpActor(),
      arguments: { sessionKey: 'target-session', prompt: 'assignment prompt', deliveryMode: 'paste' },
    }), 'MCP message assignment result');
    assert.equal(typeof result.assignmentId, 'string');
    assert.match(String(result.assignmentId), /\S/u);
    const status = asRecord(await callMcpToolService(service, 'getAssignmentStatus', {
      assignmentId: result.assignmentId,
    }), 'MCP assignment status');

    assert.equal(status.assignmentId, result.assignmentId);
    const transitions = asRecordArray(status.transitions ?? status.history, 'MCP assignment status transitions');
    const transitionStatuses = transitions.map((transition) => String(transition.status));
    const createdIndex = transitionStatuses.indexOf('created');
    const resolvedIndex = transitionStatuses.indexOf('resolved');
    const finalIndex = transitionStatuses.findIndex((value) => value === 'delivered' || value === 'failed');
    assert.notEqual(createdIndex, -1, 'assignment transitions must include created');
    assert.ok(resolvedIndex > createdIndex, 'assignment transitions must progress from created to resolved');
    assert.ok(finalIndex > resolvedIndex, 'assignment transitions must progress from resolved to delivered or failed');
    assert.equal(status.status, transitionStatuses[transitionStatuses.length - 1]);
    assert.ok(['delivered', 'failed'].includes(String(status.status)));
    for (const key of ['promptHash', 'promptPreview', 'deliveryMode', 'target', 'source', 'auditId']) {
      assert.ok(status[key] !== undefined, `assignment status must include ${key}`);
    }
    assert.doesNotMatch(JSON.stringify(status), /assignment prompt/u);

    const failedService = await createMcpToolServiceHarness({
      deps: {
        deliverMessage: () => ({ ok: false, accepted: false, code: 'TARGET_NOT_LIVE', status: 'failed' }),
      },
    });
    const failed = asRecord(await callMcpToolService(failedService, 'callTool', {
      name: 'buildergate.message.send',
      actor: createMcpActor(),
      arguments: { sessionKey: 'target-session', prompt: 'undelivered prompt', deliveryMode: 'paste' },
    }), 'MCP failed delivery result');
    assert.equal(failed.ok, false);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.code, 'TARGET_NOT_LIVE');
    const failedStatus = asRecord(await callMcpToolService(failedService, 'getAssignmentStatus', {
      assignmentId: failed.assignmentId,
    }), 'MCP failed assignment status');
    assert.equal(failedStatus.status, 'failed');
    assert.equal(failedStatus.failureCode, 'TARGET_NOT_LIVE');
    assert.doesNotMatch(JSON.stringify(failedStatus), /undelivered prompt/u);
  },
  'MCP_transport_and_tool_red_tests_OBS-MCP-001_AC-6': async () => {
    const service = await createMcpToolServiceHarness();
    const manifest = asRecord(await callMcpToolService(service, 'getVerificationCoverage', {}), 'MCP verification coverage');
    const coveredLanes = ['serverUnit', 'mcpStreamableHttp', 'frontendUnit', 'playwrightCoreE2E'];
    for (const lane of coveredLanes) {
      const laneRecord = asRecord(manifest[lane], `coverage lane ${lane}`);
      const hasExplicitStatus = typeof laneRecord.status === 'string';
      const hasLegacyStatus = typeof laneRecord.covered === 'boolean' || typeof laneRecord.skipped === 'boolean';
      assert.ok(hasExplicitStatus || hasLegacyStatus, `${lane} coverage status must be explicit`);
      const status = hasExplicitStatus
        ? String(laneRecord.status)
        : laneRecord.covered === true ? 'covered' : laneRecord.skipped === true ? 'skipped' : 'remaining';
      assert.ok(['covered', 'skipped', 'remaining'].includes(status), `${lane} coverage status must be explicit`);
      assert.equal(status, 'covered', `${lane} coverage should be covered after final MCP implementation`);
      assert.notEqual(laneRecord.evidence ?? laneRecord.reference, undefined, `${lane} covered status must carry evidence`);
    }
    const coveredFlows = ['loopbackSecurity', 'whitelistProxyRejection', 'toolSchemas', 'searchAndSend', 'openAgentReadyKickoff', 'replyToLeader', 'closeSelf', 'webhookKeyFlow', 'redaction', 'toolsDialog'];
    for (const flow of coveredFlows) {
      const flowRecord = asRecord(asRecord(manifest.flows, 'coverage flows')[flow], `coverage flow ${flow}`);
      const hasExplicitStatus = typeof flowRecord.status === 'string';
      const hasLegacyStatus = typeof flowRecord.covered === 'boolean' || typeof flowRecord.skipped === 'boolean';
      assert.ok(hasExplicitStatus || hasLegacyStatus, `${flow} coverage status must be explicit`);
      const status = hasExplicitStatus
        ? String(flowRecord.status)
        : flowRecord.covered === true ? 'covered' : flowRecord.skipped === true ? 'skipped' : 'remaining';
      assert.ok(['covered', 'skipped', 'remaining'].includes(status), `${flow} coverage status must be explicit`);
      assert.equal(status, 'covered', `${flow} coverage should be covered after final MCP implementation`);
      assert.notEqual(flowRecord.evidence ?? flowRecord.reference, undefined, `${flow} covered status must carry evidence`);
    }
  },
  'MCP_transport_and_tool_red_tests_OBS-MCP-001_AC-7': async () => {
    const service = await createMcpToolServiceHarness();
    const report = asRecord(await callMcpToolService(service, 'recordValidationResult', {
      scenario: 'playwright-core-e2e',
      status: 'skipped',
      reason: 'local dev server unavailable',
    }), 'MCP validation result report');
    assert.equal(report.status, 'skipped');
    assert.match(String(report.reason), /unavailable/u);
    assert.notEqual(report.covered, true);
  },
  'MCP_transport_and_tool_red_tests_SEC-MCP-001_AC-1': async () => {
    const controller = await createMcpListenerControllerHarness();
    const status = asRecord(await callMcpListenerController(controller, 'start', { enabled: true }), 'MCP listener start status');
    const remote = asRecord(await callMcpListenerController(controller, 'evaluateRequest', {
      remoteAddress: '192.168.0.10',
      headers: {},
      credential: createMcpActor(),
    }), 'MCP remote request guard result');

    assert.equal(status.bindHost, '127.0.0.1');
    assert.equal(remote.ok, false);
    assert.equal(remote.code, 'MCP_LOOPBACK_ONLY');
    assert.equal(remote.dispatched, false);

    await callMcpListenerController(controller, 'start', { enabled: false });
    const disabled = asRecord(await callMcpListenerController(controller, 'evaluateRequest', {
      remoteAddress: '127.0.0.1',
      headers: {},
      credential: createMcpActor(),
    }), 'MCP disabled request guard result');
    assert.equal(disabled.ok, false);
    assert.equal(disabled.code, 'MCP_TRANSPORT_DENIED');
    assert.equal(disabled.dispatched, false);

    const enabledAgain = await createMcpListenerControllerHarness();
    await callMcpListenerController(enabledAgain, 'start', { enabled: true });
    await callMcpListenerController(enabledAgain, 'stop', {});
    const stopped = asRecord(await callMcpListenerController(enabledAgain, 'evaluateRequest', {
      remoteAddress: '127.0.0.1',
      headers: {},
      credential: createMcpActor(),
    }), 'MCP stopped request guard result');
    assert.equal(stopped.ok, false);
    assert.equal(stopped.code, 'MCP_TRANSPORT_DENIED');
    assert.equal(stopped.dispatched, false);
  },
  'MCP_transport_and_tool_red_tests_SEC-MCP-001_AC-2': async () => {
    const contract = await loadMcpTransportToolContract();
    const validate = getMcpTransportFunction(contract, 'validateMcpListenerConfig');
    const result = asRecord(await validate({
      current: { bindHost: '127.0.0.1', port: 3333 },
      candidate: { bindMode: 'whitelist', bindHost: '0.0.0.0', externalWhitelist: ['203.0.113.7'], transportSecurity: 'none' },
    }), 'MCP listener config validation result');

    assert.equal(result.ok, false);
    assert.equal(result.code, 'MCP_TRANSPORT_TLS_REQUIRED');
    assert.equal(asRecord(result.activeListener, 'active listener').bindHost, '127.0.0.1');
  },
  'MCP_transport_and_tool_red_tests_SEC-MCP-001_AC-3': async () => {
    const contract = await loadMcpTransportToolContract();
    const evaluate = getMcpTransportFunction(contract, 'evaluateMcpTransportRequest');
    const untrusted = asRecord(await evaluate({
      config: { bindMode: 'whitelist', trustedProxies: ['10.0.0.5'], externalWhitelist: ['203.0.113.7'], transportSecurity: 'trusted_tls_proxy' },
      remoteAddress: '10.0.0.6',
      headers: { 'x-forwarded-for': '203.0.113.7', 'x-forwarded-proto': 'https' },
    }), 'MCP untrusted proxy result');
    const insecure = asRecord(await evaluate({
      config: { bindMode: 'whitelist', trustedProxies: ['10.0.0.5'], externalWhitelist: ['203.0.113.7'], transportSecurity: 'trusted_tls_proxy' },
      remoteAddress: '10.0.0.5',
      headers: { 'x-forwarded-for': '203.0.113.7', 'x-forwarded-proto': 'http' },
    }), 'MCP insecure forwarded proto result');

    assert.equal(untrusted.ok, false);
    assert.equal(untrusted.code, 'MCP_TRUSTED_PROXY_DENIED');
    assert.equal(insecure.ok, false);
    assert.equal(insecure.code, 'MCP_TRANSPORT_DENIED');
  },
  'MCP_transport_and_tool_red_tests_SEC-MCP-001_AC-4': async () => {
    const calls = createMcpToolHarnessCalls();
    const controller = await createMcpListenerControllerHarness({ calls });
    const deniedCases = [
      {
        label: 'non-loopback remote',
        expectedCode: 'MCP_LOOPBACK_ONLY',
        request: {
          remoteAddress: '192.168.0.10',
          headers: { authorization: 'Bearer raw-browser-jwt-token' },
          body: { prompt: 'raw prompt denied before dispatch' },
        },
      },
      {
        label: 'origin denied',
        expectedCode: 'MCP_ORIGIN_DENIED',
        request: {
          remoteAddress: '127.0.0.1',
          headers: { origin: 'https://evil.example' },
          credential: createMcpActor(),
          body: { prompt: 'origin denied raw prompt' },
        },
      },
      {
        label: 'browser credential boundary',
        expectedCode: 'CREDENTIAL_BOUNDARY_VIOLATION',
        request: {
          remoteAddress: '127.0.0.1',
          headers: { authorization: 'Bearer raw-browser-jwt-token' },
          credential: { type: 'browser-jwt', token: 'raw-browser-jwt-token' },
          body: { prompt: 'browser jwt raw prompt' },
        },
      },
      {
        label: 'missing credential',
        expectedCode: 'INVALID_TOKEN',
        request: {
          remoteAddress: '127.0.0.1',
          headers: {},
          body: { prompt: 'missing credential raw prompt' },
        },
      },
      {
        label: 'invalid credential',
        expectedCode: 'INVALID_TOKEN',
        request: {
          remoteAddress: '127.0.0.1',
          headers: { authorization: 'Bearer raw-invalid-mcp-token' },
          credential: { type: 'mcp-capability', token: 'raw-invalid-mcp-token' },
          body: { prompt: 'invalid credential raw prompt' },
        },
      },
    ];

    for (const testCase of deniedCases) {
      const result = asRecord(await callMcpListenerController(controller, 'evaluateRequest', testCase.request), `MCP denied request result: ${testCase.label}`);
      assert.equal(result.ok, false);
      assert.equal(result.code, testCase.expectedCode);
      assert.equal(typeof result.auditId, 'string');
      assert.equal(result.dispatched, false);
      const audit = asRecord(calls.auditEvents.find((event) => event.auditId === result.auditId), `MCP denied audit event: ${testCase.label}`);
      assert.equal(audit.auditId, result.auditId);
      const requestRecord = asRecord(testCase.request, `${testCase.label} request`);
      const auditIp = audit.sourceIp ?? audit.effectiveClientIp ?? audit.remoteAddress;
      assert.equal(auditIp, requestRecord.remoteAddress);
      if (requestRecord.credential !== undefined) {
        assert.ok(audit.actorType !== undefined);
        const credential = asRecord(requestRecord.credential, `${testCase.label} credential`);
        if (credential.sessionKey !== undefined) {
          assert.equal(audit.actorSessionKey, credential.sessionKey);
        }
      }
      assert.ok(audit.reason === testCase.expectedCode || audit.code === testCase.expectedCode);
      assert.ok(audit.result !== undefined || audit.outcome !== undefined);
      assertNoSecretMaterial({ result, audit }, [
        'raw-browser-jwt-token',
        'raw-invalid-mcp-token',
        'raw prompt denied before dispatch',
        'origin denied raw prompt',
        'browser jwt raw prompt',
        'missing credential raw prompt',
        'invalid credential raw prompt',
      ]);
    }

    const contract = await loadMcpTransportToolContract();
    const createHandler = getMcpTransportFunction(contract, 'createMcpHttpHandler');
    const malformedHandler = createHandler({
      service: await createMcpToolServiceHarness(),
      listenerController: controller,
    });
    const malformed = asRecord(await callMcpHttpHandler(asRecord(malformedHandler, 'MCP malformed denial handler'), {
      method: 'POST',
      path: '/mcp',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: Buffer.from('{"jsonrpc":"2.0","id":', 'utf8'),
      remoteAddress: '127.0.0.1',
    }), 'MCP malformed denied response');
    const malformedBody = asRecord(malformed.body, 'MCP malformed denied body');
    const malformedError = asRecord(malformedBody.error, 'MCP malformed denied error');
    assert.equal(malformed.status, 403);
    assert.equal(malformedBody.id, null);
    assert.equal(malformedError.message, 'INVALID_TOKEN');
  },
  'MCP_transport_and_tool_red_tests_SEC-MCP-001_AC-5': async () => {
    const controller = await createMcpListenerControllerHarness();
    const result = asRecord(await callMcpListenerController(controller, 'rebind', {
      current: { bindHost: '127.0.0.1', port: 3333, appServerGeneration: 1 },
      candidate: { bindHost: '127.0.0.1', port: 3334 },
      probeResult: { ok: true },
    }), 'MCP listener rebind success');

    assert.equal(result.ok, true);
    assert.equal(result.candidateHealthProbed, true);
    assert.equal(asRecord(result.active, 'MCP active listener after successful rebind').port, 3334);
    assert.equal(result.oldListenerDrained, true);
    assert.equal(result.appServerRestarted, false);
    assert.equal(result.redirectServerRestarted, false);

    const contract = await loadMcpTransportToolContract();
    const createController = getMcpTransportFunction(contract, 'createMcpListenerController');
    const disabledBoundPorts: number[] = [];
    const disabledController = asRecord(createController({
      current: { enabled: false, bindHost: '127.0.0.1', port: 3337 },
      bindListener: (candidate: unknown) => {
        disabledBoundPorts.push(Number(asRecord(candidate, 'disabled MCP bind candidate').port));
        return { bindHost: '127.0.0.1', port: 3337, listenerStatus: 'listening', activeConnectionCount: 0 };
      },
      closeListener: () => undefined,
      healthProbe: () => ({ ok: true }),
    }), 'disabled MCP real bind listener controller');
    const disabledStart = asRecord(await callMcpListenerController(disabledController, 'start', { enabled: false }), 'disabled MCP listener start');
    assert.equal(disabledStart.enabled, false);
    assert.equal(disabledStart.listenerStatus, 'stopped');
    assert.deepEqual(disabledBoundPorts, []);

    const boundPorts: number[] = [];
    const closedPorts: number[] = [];
    const realController = asRecord(createController({
      current: { bindHost: '127.0.0.1', port: 3335 },
      bindListener: (candidate: unknown) => {
        const record = asRecord(candidate, 'MCP bind candidate');
        const port = Number(record.port);
        boundPorts.push(port);
        return { bindHost: record.bindHost, port, listenerStatus: 'listening', activeConnectionCount: 0, handleId: `listener-${port}` };
      },
      closeListener: (handle: unknown) => {
        closedPorts.push(Number(asRecord(handle, 'MCP listener handle').port));
      },
      healthProbe: () => ({ ok: true }),
    }), 'MCP real bind listener controller');
    await callMcpListenerController(realController, 'start', { enabled: true });
    const realRebind = asRecord(await callMcpListenerController(realController, 'rebind', {
      candidate: { bindHost: '127.0.0.1', port: 3336 },
    }), 'MCP real listener rebind success');
    assert.equal(realRebind.ok, true);
    assert.deepEqual(boundPorts, [3335, 3336]);
    assert.deepEqual(closedPorts, [3335]);
    assert.equal(asRecord(realRebind.active, 'MCP real active listener after rebind').port, 3336);

    const policyUpdate = asRecord(await callMcpListenerController(realController, 'updatePolicy', {
      allowedOrigins: ['https://allowed.example'],
    }), 'MCP listener policy-only update');
    assert.equal(policyUpdate.ok, true);
    assert.equal(policyUpdate.policyUpdated, true);
    assert.deepEqual(boundPorts, [3335, 3336]);
    assert.deepEqual(closedPorts, [3335]);

    const staleOrigin = asRecord(await callMcpListenerController(realController, 'evaluateRequest', {
      remoteAddress: '127.0.0.1',
      headers: { origin: 'https://stale.example' },
      credential: createMcpActor(),
    }), 'MCP stale origin after policy update');
    const allowedOrigin = asRecord(await callMcpListenerController(realController, 'evaluateRequest', {
      remoteAddress: '127.0.0.1',
      headers: { origin: 'https://allowed.example' },
      credential: createMcpActor(),
    }), 'MCP allowed origin after policy update');
    assert.equal(staleOrigin.ok, false);
    assert.equal(staleOrigin.code, 'MCP_ORIGIN_DENIED');
    assert.equal(staleOrigin.dispatched, false);
    assert.equal(allowedOrigin.ok, true);
    assert.equal(allowedOrigin.dispatched, true);
  },
  'MCP_transport_and_tool_red_tests_SEC-MCP-001_AC-6': async () => {
    const calls = createMcpToolHarnessCalls();
    const controller = await createMcpListenerControllerHarness({ calls });
    const result = asRecord(await callMcpListenerController(controller, 'rebind', {
      current: { bindHost: '127.0.0.1', port: 3333, generation: 4 },
      candidate: { bindHost: '127.0.0.1', port: 3334 },
      probeResult: { ok: false, code: 'HEALTH_PROBE_FAILED' },
    }), 'MCP listener rebind rollback');
    const status = asRecord(await callMcpListenerController(controller, 'getStatus', {}), 'MCP listener status after failed rebind');

    assert.equal(result.ok, false);
    assert.equal(result.code, 'MCP_PORT_REBIND_FAILED');
    assert.equal(asRecord(result.active, 'MCP active listener after failed rebind').port, 3333);
    assert.equal(asRecord(result.persisted, 'MCP persisted listener after failed rebind').port, 3333);
    assert.ok(result.lastError);
    assert.ok(result.auditId);
    const audit = asRecord(calls.auditEvents.find((event) => event.auditId === result.auditId), 'MCP rebind failure audit event');
    assert.equal(audit.auditId, result.auditId);
    assert.ok(audit.action === 'mcp.listener.rebind' || audit.reason === 'MCP_PORT_REBIND_FAILED' || audit.code === 'MCP_PORT_REBIND_FAILED');
    assert.ok(audit.result !== undefined || audit.outcome !== undefined);
    assert.equal(asRecord(status.lastRebindResult, 'MCP last rebind result').code, 'MCP_PORT_REBIND_FAILED');
    assert.ok(status.lastError);
    assert.equal(asRecord(status.active, 'MCP active listener after failed rebind').port, 3333);

    const contract = await loadMcpTransportToolContract();
    const createController = getMcpTransportFunction(contract, 'createMcpListenerController');
    const directTlsController = asRecord(createController({
      current: { bindHost: '127.0.0.1', port: 4441, transportSecurity: 'none' },
      bindListener: (candidate: unknown) => {
        const record = asRecord(candidate, 'MCP direct TLS bind candidate');
        return {
          bindHost: record.bindHost,
          port: Number(record.port),
          transportSecurity: record.transportSecurity,
          listenerStatus: 'listening',
          activeConnectionCount: 0,
        };
      },
      healthProbe: () => ({ ok: true }),
    }), 'MCP direct TLS listener controller');
    await callMcpListenerController(directTlsController, 'start', { enabled: true });
    const directTlsRebind = asRecord(await callMcpListenerController(directTlsController, 'rebind', {
      candidate: { bindHost: '127.0.0.1', port: 4441, transportSecurity: 'direct_tls' },
    }), 'MCP direct TLS rebind on HTTPS-capable listener');
    const directTlsStatus = asRecord(await callMcpListenerController(directTlsController, 'getStatus', {}), 'MCP direct TLS status');
    assert.equal(directTlsRebind.ok, true);
    assert.equal(asRecord(directTlsRebind.active, 'direct TLS active listener').transportSecurity, 'direct_tls');
    assert.equal(asRecord(directTlsStatus.active, 'direct TLS status active').transportSecurity, 'direct_tls');

    const previousServerRoot = process.env.BUILDERGATE_SERVER_ROOT;
    const tlsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'buildergate-mcp-direct-tls-'));
    let tlsHandle: unknown;
    let tlsDispatchCount = 0;
    try {
      process.env.BUILDERGATE_SERVER_ROOT = tlsRoot;
      tlsHandle = await createMcpNodeHttpListener({
        bindHost: '127.0.0.1',
        port: 0,
        transportSecurity: 'direct_tls',
      }, async (request) => {
        tlsDispatchCount += 1;
        const record = asRecord(request, 'direct TLS MCP request');
        assert.equal(record.method, 'POST');
        assert.equal(record.path, '/mcp');
        assert.equal(asRecord(record.credential, 'direct TLS credential').token, 'direct-tls-token');
        assert.ok(Buffer.isBuffer(record.body), 'direct TLS request body should be buffered');
        assert.equal(asRecord(JSON.parse((record.body as Buffer).toString('utf-8')), 'direct TLS JSON-RPC body').method, 'ping');
        return {
          status: 200,
          contentType: 'application/json; charset=utf-8',
          body: { jsonrpc: '2.0', id: 'direct-tls', result: { ok: true } },
        };
      }, { sslConfig: { certPath: '', keyPath: '', caPath: '' } });
      const directTlsPort = Number(asRecord(tlsHandle, 'direct TLS listener handle').port);
      assert.ok(directTlsPort > 0, 'direct TLS listener must bind an OS-assigned port');
      const directTlsResponseBody = await new Promise<string>((resolve, reject) => {
        const payload = JSON.stringify({ jsonrpc: '2.0', id: 'direct-tls', method: 'ping' });
        const req = https.request({
          hostname: '127.0.0.1',
          port: directTlsPort,
          path: '/mcp',
          method: 'POST',
          rejectUnauthorized: false,
          headers: {
            authorization: 'Bearer direct-tls-token',
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload),
          },
        }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
          res.on('error', reject);
          res.on('end', () => {
            assert.equal(res.statusCode, 200);
            assert.match(String(res.headers['content-type'] ?? ''), /application\/json/u);
            resolve(Buffer.concat(chunks).toString('utf-8'));
          });
        });
        req.setTimeout(10_000, () => req.destroy(new Error('direct TLS MCP request timed out')));
        req.on('error', reject);
        req.end(payload);
      });
      assert.deepEqual(JSON.parse(directTlsResponseBody), {
        jsonrpc: '2.0',
        id: 'direct-tls',
        result: { ok: true },
      });
      assert.equal(tlsDispatchCount, 1);
    } finally {
      if (tlsHandle) {
        await closeMcpNodeHttpListener(tlsHandle);
      }
      if (previousServerRoot === undefined) {
        delete process.env.BUILDERGATE_SERVER_ROOT;
      } else {
        process.env.BUILDERGATE_SERVER_ROOT = previousServerRoot;
      }
      await fs.rm(tlsRoot, { recursive: true, force: true });
    }
  },
};

function assertRequiredMcpTools(toolList: Array<Record<string, unknown>>, label: string): void {
  const names = toolList.map((tool) => String(tool.name));
  for (const name of names) {
    assert.match(name, /^[\x20-\x7e]+$/u, `${label} MCP tool name must remain ASCII: ${name}`);
  }
  for (const name of requiredMcpToolNames) {
    assert.ok(names.includes(name), `${label} missing MCP tool: ${name}`);
    const tool = toolList.find((candidate) => candidate.name === name);
    assert.equal(asRecord(tool?.inputSchema, `${label} ${name} input schema`).type, 'object');
  }
  const closeTool = asRecord(toolList.find((candidate) => candidate.name === 'buildergate.session.close'), `${label} close tool`);
  const closeSchema = asRecord(closeTool.inputSchema, `${label} close input schema`);
  const closeProperties = asRecord(closeSchema.properties, `${label} close properties`);
  const closeRequired = Array.isArray(closeSchema.required) ? closeSchema.required.map(String) : [];
  assert.ok('expectedSessionKey' in closeProperties, `${label} close tool must expose expectedSessionKey`);
  for (const required of ['sessionKey', 'expectedSessionKey', 'confirmClose', 'confirmationNonce']) {
    assert.ok(closeRequired.includes(required), `${label} close tool must require ${required}`);
  }
}

function readMcpTokenScopes(token: string): string[] {
  const [payload] = token.split('.');
  assert.ok(payload, 'MCP token must include payload');
  const normalized = payload.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(payload.length / 4) * 4, '=');
  const claims = JSON.parse(Buffer.from(normalized, 'base64').toString('utf-8')) as Record<string, unknown>;
  return Array.isArray(claims.scope) ? claims.scope.map(String) : [];
}

async function loadMcpSecurityContract(): Promise<McpSecurityContract> {
  try {
    return await import('./services/McpSecurityContract.js') as McpSecurityContract;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert.fail(`missing MCP implementation: expected ./services/McpSecurityContract.js for MCP security foundation (${message})`);
  }
}

function getContractFunction(contract: McpSecurityContract, name: string): (...args: unknown[]) => unknown {
  const value = contract[name];
  assert.equal(typeof value, 'function', `missing MCP implementation: ${name} must be exported`);
  return value as (...args: unknown[]) => unknown;
}

async function callMcpSecurityContract(name: string, ...args: unknown[]): Promise<unknown> {
  const contract = await loadMcpSecurityContract();
  return await getContractFunction(contract, name)(...args);
}

async function loadMcpSessionRegistryContract(): Promise<McpSessionRegistryContract> {
  try {
    return await import('./services/McpSessionRegistryContract.js') as McpSessionRegistryContract;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert.fail(`missing MCP session registry/alias implementation: expected ./services/McpSessionRegistryContract.js (${message})`);
  }
}

function getRegistryFunction(contract: McpSessionRegistryContract, name: string): (...args: unknown[]) => unknown {
  const value = contract[name];
  assert.equal(typeof value, 'function', `missing MCP session registry/alias implementation: ${name} must be exported`);
  return value as (...args: unknown[]) => unknown;
}

async function callMcpSessionRegistryContract(name: string, ...args: unknown[]): Promise<unknown> {
  const contract = await loadMcpSessionRegistryContract();
  return await getRegistryFunction(contract, name)(...args);
}

async function loadMcpTransportToolContract(): Promise<McpTransportToolContract> {
  try {
    return await import('./services/McpToolService.js') as McpTransportToolContract;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert.fail(`missing MCP transport/tool implementation: expected ./services/McpToolService.js (${message})`);
  }
}

function getMcpTransportFunction(contract: McpTransportToolContract, name: string): (...args: unknown[]) => unknown {
  const value = contract[name];
  assert.equal(typeof value, 'function', `missing MCP transport/tool implementation: ${name} must be exported`);
  return value as (...args: unknown[]) => unknown;
}

function assertMcpTransportContractExports(contract: McpTransportToolContract): void {
  assert.equal(typeof contract.createMcpToolService, 'function', 'missing MCP transport/tool implementation: createMcpToolService must be exported');
  assert.equal(typeof contract.createMcpHttpHandler, 'function', 'missing MCP transport/tool implementation: createMcpHttpHandler must be exported');
  assert.equal(typeof contract.createMcpListenerController, 'function', 'missing MCP transport/tool implementation: createMcpListenerController must be exported');
  assert.equal(typeof contract.validateMcpListenerConfig, 'function', 'missing MCP transport/tool implementation: validateMcpListenerConfig must be exported');
  assert.equal(typeof contract.evaluateMcpTransportRequest, 'function', 'missing MCP transport/tool implementation: evaluateMcpTransportRequest must be exported');
  const toolNames = readStringContractArray(contract.BUILDERGATE_MCP_TOOL_NAMES, 'BUILDERGATE_MCP_TOOL_NAMES');
  for (const name of requiredMcpToolNames) {
    assert.ok(toolNames.includes(name), `missing MCP tool name export: ${name}`);
  }
}

type McpHarnessCalls = {
  auditEvents: Array<Record<string, unknown>>;
  assignments: Array<Record<string, unknown>>;
  logs: Array<Record<string, unknown>>;
};

function createMcpToolHarnessCalls(): McpHarnessCalls {
  return {
    auditEvents: [],
    assignments: [],
    logs: [],
  };
}

function createMcpActor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const actor: Record<string, unknown> = {
    type: 'mcp',
    sessionKey: 'self-session-key',
    scopes: [
      'mcp:self.read',
      'mcp:sessions.list',
      'mcp:sessions.search',
      'mcp:sessions.alias.write',
      'mcp:message.paste',
      'mcp:message.submit',
      'mcp:status.write',
      'mcp:session.claim',
      'mcp:session.close_self',
    ],
    token: 'redacted-session-token',
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete actor[key];
    } else {
      actor[key] = value;
    }
  }
  return actor;
}

async function createMcpToolServiceHarness(options: { calls?: McpHarnessCalls; deps?: Record<string, unknown> } = {}): Promise<Record<string, unknown>> {
  const contract = await loadMcpTransportToolContract();
  assertMcpTransportContractExports(contract);
  const createService = getMcpTransportFunction(contract, 'createMcpToolService');
  const calls = options.calls ?? createMcpToolHarnessCalls();
  return asRecord(createService({
    now: () => '2026-07-09T02:30:00.000Z',
    audit: (event: unknown) => calls.auditEvents.push(asRecord(event, 'MCP audit event')),
    log: (event: unknown) => calls.logs.push(asRecord(event, 'MCP log event')),
    createAssignment: (assignment: unknown) => {
      const record = asRecord(assignment, 'MCP assignment');
      calls.assignments.push(record);
      return { ok: true, assignmentId: record.assignmentId ?? 'assignment-1', status: 'delivered' };
    },
    sessions: [
      {
        sessionId: 'current-session-id',
        sessionKey: 'self-session-key',
        workspaceId: 'workspace-1',
        tabId: 'tab-1',
        alias: '빌더 게이트',
        agentKind: 'codex',
        leaderSessionKey: 'leader-session-key',
        bindingLifecycle: 'live',
        agentStatus: 'ready',
        mcpConnected: true,
        leader: false,
        lastSeenAt: '2026-07-09T02:30:00.000Z',
        token: 'must-not-leak-session-token',
      },
      {
        sessionId: 'target-current-session-id',
        sessionKey: 'target-session',
        workspaceId: 'workspace-1',
        tabId: 'tab-2',
        alias: '클로드',
        agentKind: 'claude',
        leaderSessionKey: 'self-session-key',
        bindingLifecycle: 'live',
        agentStatus: 'waiting_input',
        mcpConnected: true,
        leader: false,
        lastSeenAt: '2026-07-09T02:30:00.000Z',
      },
      {
        sessionId: 'manual-current-session-id',
        sessionKey: 'manual-session-key',
        workspaceId: 'workspace-1',
        tabId: 'tab-manual',
        alias: '수동 클라이언트',
        agentKind: 'claude',
        bindingLifecycle: 'live',
        agentStatus: 'ready',
        mcpConnected: false,
        lastSeenAt: '2026-07-09T02:30:00.000Z',
      },
    ],
    claimCodes: new Map([['claim-once-code', {
      sessionKey: 'manual-session-key',
      used: false,
      expiresAt: '2026-07-09T02:35:00.000Z',
    }]]),
    listener: {
      enabled: true,
      bindHost: '127.0.0.1',
      port: 3333,
      listenerStatus: 'listening',
      activeConnectionCount: 1,
      lastRebindResult: null,
      lastError: null,
      rejectedRequestCounters: { MCP_LOOPBACK_ONLY: 1 },
    },
    ...(options.deps ?? {}),
  }), 'MCP tool service instance');
}

async function callMcpToolService(service: Record<string, unknown>, method: string, payload: unknown): Promise<unknown> {
  const fn = service[method];
  assert.equal(typeof fn, 'function', `missing MCP transport/tool implementation: service.${method} must be a function`);
  return await (fn as (...args: unknown[]) => unknown)(payload);
}

async function createMcpHttpHandlerHarness(): Promise<Record<string, unknown> | ((request: unknown) => unknown)> {
  const contract = await loadMcpTransportToolContract();
  assertMcpTransportContractExports(contract);
  const createHandler = getMcpTransportFunction(contract, 'createMcpHttpHandler');
  const service = await createMcpToolServiceHarness();
  const handler = createHandler({ service });
  if (typeof handler === 'function') {
    return handler as (request: unknown) => unknown;
  }
  return asRecord(handler, 'MCP HTTP handler');
}

async function callMcpHttpHandler(handler: Record<string, unknown> | ((request: unknown) => unknown), request: unknown): Promise<unknown> {
  if (typeof handler === 'function') {
    return await handler(request);
  }
  const handleRequest = handler.handleRequest;
  assert.equal(typeof handleRequest, 'function', 'missing MCP transport/tool implementation: MCP HTTP handler.handleRequest must be a function');
  return await (handleRequest as (...args: unknown[]) => unknown)(request);
}

async function createMcpListenerControllerHarness(options: { calls?: McpHarnessCalls } = {}): Promise<Record<string, unknown>> {
  const contract = await loadMcpTransportToolContract();
  assertMcpTransportContractExports(contract);
  const createController = getMcpTransportFunction(contract, 'createMcpListenerController');
  const calls = options.calls ?? createMcpToolHarnessCalls();
  return asRecord(createController({
    current: { bindHost: '127.0.0.1', port: 3333, generation: 1 },
    audit: (event: unknown) => calls.auditEvents.push(asRecord(event, 'MCP listener audit event')),
    healthProbe: () => ({ ok: true }),
  }), 'MCP listener controller');
}

async function callMcpListenerController(controller: Record<string, unknown>, method: string, payload: unknown): Promise<unknown> {
  const fn = controller[method];
  assert.equal(typeof fn, 'function', `missing MCP transport/tool implementation: listenerController.${method} must be a function`);
  return await (fn as (...args: unknown[]) => unknown)(payload);
}

type AgentLifecycleContract = Record<string, unknown>;

const agentLifecycleRedTests: Record<string, () => Promise<void>> = {
  'Agent_lifecycle_red_tests_FR-MCP-003_AC-1': async () => {
    const { service, cleanup } = await createAgentProfileServiceHarness();
    try {
      const created = asRecord(await callObjectMethod(service, 'createProfile', {
        displayName: 'Codex follower',
        command: 'codex',
        args: ['--model', 'gpt-5'],
        aliases: ['codex', 'builder'],
        isDefault: true,
        enabled: true,
        kickoffPrompt: 'Start after ready',
        mcpClientConfigMode: 'env',
      }), 'agent profile create result');
      const profiles = asRecordArray(await callObjectMethod(service, 'listProfiles', {}), 'agent profiles');
      assert.equal(created.storeKind, 'agent-command-profile');
      assert.equal(created.displayName, 'Codex follower');
      assert.equal(created.command, 'codex');
      assert.deepEqual(created.args, ['--model', 'gpt-5']);
      assert.deepEqual(created.aliases, ['codex', 'builder']);
      assert.equal(created.isDefault, true);
      assert.equal(created.enabled, true);
      assert.equal(created.kickoffPrompt, 'Start after ready');
      assert.equal(created.mcpClientConfigMode, 'env');
      assert.equal(profiles.length, 1);
    } finally {
      await cleanup();
    }
  },
  'Agent_lifecycle_red_tests_FR-MCP-003_AC-2': async () => {
    const { service, calls } = await createAgentLifecycleHarness();
    const result = asRecord(await callObjectMethod(service, 'openAgent', createOpenAgentRequest({
      profileId: 'codex-env',
      kickoffPrompt: 'Implement feature',
    })), 'open_agent preallocation result');
    assert.equal(result.ok, true);
    assert.match(String(result.sessionKey), /[0-9a-f-]{36}/u);
    assert.equal(result.leaderSessionKey, 'leader-session-key');
    assert.equal(typeof result.actorToken, 'string');
    const events = calls.events as string[];
    assert.equal(events.indexOf('record-launch-attempt') < events.indexOf('create-tab'), true);
    assert.equal(events.indexOf('preallocate-binding') < events.indexOf('create-tab'), true);
    assert.equal(events.indexOf('mint-token') < events.indexOf('create-tab'), true);
    const tokenMint = asRecord(calls.tokenMints[0], 'open_agent token mint request');
    const mintedScopes = Array.isArray(tokenMint.scopes) ? tokenMint.scopes.map(String) : [];
    assert.deepEqual(mintedScopes.sort(), [...expectedDefaultMcpScopes].sort());
    assert.equal(mintedScopes.includes('mcp:session.open'), false);
    assert.equal(mintedScopes.includes('mcp:session.close_self'), false);
    const launchAttempt = asRecord(calls.launchAttempts[0], 'preallocated launch attempt');
    assert.equal(launchAttempt.sessionKey, result.sessionKey);
    assert.equal(launchAttempt.leaderSessionKey, 'leader-session-key');
    assert.ok(['draft', 'preallocated', 'spawning'].includes(String(launchAttempt.status)));
  },
  'Agent_lifecycle_red_tests_FR-MCP-003_AC-3': async () => {
    const { service, calls } = await createAgentLifecycleHarness();
    await callObjectMethod(service, 'openAgent', createOpenAgentRequest({
      profileId: 'codex-generated-file',
      mcpClientConfigMode: 'generated-file',
    }));
    const launchContext = asRecord(calls.launchContexts[0], 'spawn launch context');
    const envPatch = asRecord(launchContext.envPatch, 'spawn env patch');
    assert.match(String(envPatch.BUILDERGATE_MCP_URL), /\/mcp/u);
    assert.match(String(envPatch.BUILDERGATE_MCP_SESSION_KEY), /[0-9a-f-]{36}/u);
    assert.equal(envPatch.BUILDERGATE_MCP_CURRENT_SESSION_ID, 'current-session-id');
    assert.equal(envPatch.BUILDERGATE_MCP_LEADER_SESSION_KEY, 'leader-session-key');
    assert.equal(typeof envPatch.BUILDERGATE_MCP_TOKEN, 'string');
    assert.equal(typeof launchContext.generatedConfigPath, 'string');
    const events = calls.events as string[];
    assert.equal(events.indexOf('spawn-pty') > events.indexOf('create-tab'), true);
  },
  'Agent_lifecycle_red_tests_FR-MCP-003_AC-4': async () => {
    const { service, calls } = await createAgentLifecycleHarness();
    const result = asRecord(await callObjectMethod(service, 'openAgent', createOpenAgentRequest({
      profileId: 'manual-profile',
      mcpClientConfigMode: 'manual',
    })), 'manual open_agent result');
    assert.equal(result.ok, true);
    assert.equal(result.actorToken, undefined);
    assert.equal(typeof result.claimCode, 'string');
    assert.equal(calls.claimCodes.length, 1);
    assert.equal(asRecord(calls.claimCodes[0], 'manual claim record').sessionKey, result.sessionKey);
  },
  'Agent_lifecycle_red_tests_FR-MCP-003_AC-5': async () => {
    const { service, calls } = await createAgentLifecycleHarness();
    await callObjectMethod(service, 'openAgent', createOpenAgentRequest({
      profileId: 'codex-env',
      command: 'codex --resume',
    }));
    const input = asRecord(calls.gatewayInputs[0], 'agent command gateway input');
    assert.equal(input.source, 'open-agent-command');
    assert.equal(asRecord(input.delivery, 'agent command delivery').submit, true);
    assert.equal(asRecord(input.auditContext, 'agent command audit').purpose, 'agent-command');
    assert.doesNotMatch(JSON.stringify(input), /raw-mcp-token-secret/u);
  },
  'Agent_lifecycle_red_tests_FR-MCP-003_AC-6': async () => {
    const { service, calls } = await createAgentLifecycleHarness({ readiness: 'timeout' });
    const timeout = asRecord(await callObjectMethod(service, 'openAgent', createOpenAgentRequest({
      profileId: 'codex-env',
      kickoffPrompt: 'Run tests',
    })), 'open_agent readiness timeout result');
    assert.equal(timeout.kickoffPending, true);
    assert.equal(calls.gatewayInputs.filter((input) => asRecord(input, 'gateway input').source === 'open-agent-kickoff').length, 0);

    await callObjectMethod(service, 'updateStatus', {
      actor: createMcpActor({ sessionKey: String(timeout.sessionKey) }),
      agentStatus: 'ready',
      detail: 'ready for kickoff',
    });
    assert.equal(calls.gatewayInputs.some((input) => asRecord(input, 'gateway input').source === 'open-agent-kickoff'), true);
  },
  'Agent_lifecycle_red_tests_FR-MCP-003_AC-7': async () => {
    const { service, calls } = await createAgentLifecycleHarness();
    const result = asRecord(await callObjectMethod(service, 'updateStatus', {
      actor: createMcpActor({ sessionKey: 'follower-session-key' }),
      agentKind: 'codex',
      agentStatus: 'waiting_input',
      detail: 'needs input',
    }), 'agent status update result');
    assert.equal(result.ok, true);
    const update = asRecord(calls.registryUpdates[0], 'registry status update');
    assert.equal(update.sessionKey, 'follower-session-key');
    assert.equal(update.agentKind, 'codex');
    assert.equal(update.agentStatus, 'waiting_input');
    assert.equal(update.detail, 'needs input');
    assert.equal(update.mcpConnected, true);
    assert.equal(typeof update.lastSeenAt, 'string');
  },
  'Agent_lifecycle_red_tests_REL-MCP-001_AC-1': async () => {
    const { service, calls } = await createAgentLifecycleHarness({ failAt: 'before-tab' });
    const result = asRecord(await callObjectMethod(service, 'openAgent', createOpenAgentRequest({
      profileId: 'codex-generated-file',
      mcpClientConfigMode: 'generated-file',
    })), 'pre-tab failure result');
    assert.equal(result.ok, false);
    assert.equal(typeof result.code, 'string');
    assert.equal(calls.createdTabs.length, 0);
    assert.equal(calls.createdSessions.length, 0);
    assert.equal(calls.revokedTokens.length, 1);
    assert.equal(calls.deletedConfigFiles.length, 1);
    const launchAttempt = asRecord(calls.launchAttempts.at(-1), 'launch attempt');
    assert.ok(['cancelled', 'failed'].includes(String(launchAttempt.status)));
    assert.equal(launchAttempt.errorCode, result.code);
  },
  'Agent_lifecycle_red_tests_REL-MCP-001_AC-2': async () => {
    const { service, calls } = await createAgentLifecycleHarness({ failAt: 'after-tab' });
    const result = asRecord(await callObjectMethod(service, 'openAgent', createOpenAgentRequest({
      profileId: 'codex-generated-file',
      mcpClientConfigMode: 'generated-file',
    })), 'post-tab failure result');
    assert.equal(result.ok, false);
    assert.equal(calls.deleteTabs.length, 1);
    assert.equal(calls.revokedTokens.length, 1);
    assert.equal(calls.deletedConfigFiles.length, 1);
    assert.equal(asRecord(calls.launchAttempts.at(-1), 'failed launch attempt').status, 'failed');
    const evidence = asRecord(calls.cleanupEvidence.at(-1), 'post-tab failure cleanup evidence');
    assert.equal(evidence.sessionKey, result.sessionKey);
    assert.ok(['completed', 'failed', 'degraded'].includes(String(evidence.cleanupStatus)));
  },
  'Agent_lifecycle_red_tests_REL-MCP-001_AC-3': async () => {
    const { service, calls } = await createAgentLifecycleHarness({ readiness: 'timeout' });
    const result = asRecord(await callObjectMethod(service, 'openAgent', createOpenAgentRequest({
      kickoffPrompt: 'Do not paste until ready',
    })), 'readiness timeout result');
    assert.equal(result.ok, true);
    assert.equal(result.kickoffPending, true);
    assert.equal(calls.deleteTabs.length, 0);
    assert.equal(asRecord(calls.registryUpdates.at(-1), 'timeout registry update').agentStatus, 'starting');
    assert.equal(calls.gatewayInputs.some((input) => asRecord(input, 'gateway input').source === 'open-agent-kickoff'), false);
  },
  'Agent_lifecycle_red_tests_REL-MCP-001_AC-4': async () => {
    const { service, calls } = await createAgentLifecycleHarness();
    const result = asRecord(await callObjectMethod(service, 'closeSession', {
      actor: createMcpActor({ scopes: ['mcp:session.close'] }),
      sessionKey: 'follower-session-key',
      confirmClose: true,
      expectedSessionKey: 'follower-session-key',
      confirmationNonce: 'nonce-1',
    }), 'close other result');
    assert.equal(result.ok, true);
    assert.equal(calls.deleteTabs.length, 1);
    assert.equal(calls.terminateSessions.length, 0);

    const missingExpectedHarness = await createAgentLifecycleHarness();
    const missingExpected = asRecord(await callObjectMethod(missingExpectedHarness.service, 'closeSession', {
      actor: createMcpActor({ scopes: ['mcp:session.close'] }),
      sessionKey: 'follower-session-key',
      confirmClose: true,
      confirmationNonce: 'nonce-1',
    }), 'close other missing expected key result');
    const mismatchedExpected = asRecord(await callObjectMethod(missingExpectedHarness.service, 'closeSession', {
      actor: createMcpActor({ scopes: ['mcp:session.close'] }),
      sessionKey: 'follower-session-key',
      expectedSessionKey: 'other-session-key',
      confirmClose: true,
      confirmationNonce: 'nonce-1',
    }), 'close other mismatched expected key result');
    assert.equal(missingExpected.ok, false);
    assert.equal(missingExpected.code, 'CLOSE_CONFIRMATION_REQUIRED');
    assert.equal(mismatchedExpected.ok, false);
    assert.equal(mismatchedExpected.code, 'CLOSE_CONFIRMATION_REQUIRED');
    assert.equal(missingExpectedHarness.calls.deleteTabs.length, 0);
  },
  'Agent_lifecycle_red_tests_REL-MCP-001_AC-5': async () => {
    const { service, calls } = await createAgentLifecycleHarness();
    const result = asRecord(await callObjectMethod(service, 'closeSelf', {
      actor: createMcpActor({ sessionKey: 'standalone-session-key', scopes: ['mcp:session.close.self'] }),
    }), 'close_self no leader result');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'SELF_CLOSE_DENIED_NO_LEADER');
    assert.equal(calls.deleteTabs.length, 0);
  },
  'Agent_lifecycle_red_tests_REL-MCP-001_AC-6': async () => {
    const { service, calls } = await createAgentLifecycleHarness();
    const result = asRecord(await callObjectMethod(service, 'closeSelf', {
      actor: createMcpActor({ sessionKey: 'follower-session-key', leaderSessionKey: 'leader-session-key', scopes: ['mcp:session.close.self'] }),
    }), 'close_self follower result');
    assert.equal(result.ok, true);
    assert.equal(result.status, 'accepted');
    assert.equal(calls.scheduledCloseJobs.length, 1);
    const job = asRecord(calls.scheduledCloseJobs[0], 'scheduled close_self job');
    assert.ok(Number(job.delayMs) >= 250 && Number(job.delayMs) <= 1000);
    assert.equal(calls.deleteTabs.length, 0);
  },
  'Agent_lifecycle_red_tests_REL-MCP-001_AC-7': async () => {
    const { service, calls } = await createAgentLifecycleHarness();
    const result = asRecord(await callObjectMethod(service, 'closeSession', {
      actor: createMcpActor({ scopes: ['mcp:session.close'] }),
      sessionKey: 'follower-session-key',
      confirmClose: true,
      expectedSessionKey: 'follower-session-key',
      confirmationNonce: 'nonce-2',
    }), 'close observable result');
    assert.equal(result.ok, true);
    assert.equal(asRecord(calls.registryUpdates.at(-1), 'close registry update').bindingLifecycle, 'closing');
    assert.equal(calls.broadcasts.some((event) => asRecord(event, 'broadcast event').type === 'tab:removed'), true);
    assert.equal(asRecord(calls.auditEvents.at(-1), 'close audit event').result, 'closed');
    assert.equal(asRecord(calls.cleanupEvidence.at(-1), 'cleanup evidence').processTreeCleanupStatus, 'completed');
    assert.equal(calls.revokedTokens.length, 1);
    assert.equal(asRecord(calls.revokedTokens[0], 'closed session token revocation').sessionKey, 'follower-session-key');

    const failedHarness = await createAgentLifecycleHarness({ closeFails: true });
    const failed = asRecord(await callObjectMethod(failedHarness.service, 'closeSession', {
      actor: createMcpActor({ scopes: ['mcp:session.close'] }),
      sessionKey: 'follower-session-key',
      confirmClose: true,
      expectedSessionKey: 'follower-session-key',
      confirmationNonce: 'nonce-3',
    }), 'failed close observable result');
    assert.equal(failed.ok, false);
    assert.equal(asRecord(failedHarness.calls.registryUpdates.at(-1), 'failed close registry update').bindingLifecycle, 'closing-failed');
    assert.equal(asRecord(failedHarness.calls.auditEvents.at(-1), 'failed close audit event').result, 'failed');
    assert.equal(asRecord(failedHarness.calls.cleanupEvidence.at(-1), 'failed close cleanup evidence').processTreeCleanupStatus, 'failed');
    assert.equal(failedHarness.calls.revokedTokens.length, 1);
    assert.equal(asRecord(failedHarness.calls.revokedTokens[0], 'failed close token revocation').sessionKey, 'follower-session-key');
  },
  'Agent_lifecycle_regression_tool_scope_gate': async () => {
    let delegated = 0;
    const service = await createMcpToolServiceHarness({
      deps: {
        agentLifecycle: {
          openAgent: () => {
            delegated += 1;
            return { ok: true };
          },
          updateStatus: () => {
            delegated += 1;
            return { ok: true };
          },
          closeSession: () => {
            delegated += 1;
            return { ok: true };
          },
        },
      },
    });
    const open = asRecord(await callMcpToolService(service, 'callTool', {
      name: 'buildergate.session.open_agent',
      actor: createMcpActor({ scopes: ['mcp:self.read'] }),
      arguments: { profileId: 'codex-env' },
    }), 'open_agent scope denial');
    const status = asRecord(await callMcpToolService(service, 'callTool', {
      name: 'buildergate.session.update_status',
      actor: createMcpActor({ scopes: ['mcp:self.read'] }),
      arguments: { agentStatus: 'ready' },
    }), 'update_status scope denial');
    const missingCloseExpected = asRecord(await callMcpToolService(service, 'callTool', {
      name: 'buildergate.session.close',
      actor: createMcpActor({ scopes: ['mcp:session.close'] }),
      arguments: { sessionKey: 'target-session', confirmClose: true, confirmationNonce: 'nonce-1' },
    }), 'close tool missing expected key denial');
    assert.equal(open.ok, false);
    assert.equal(open.code, 'INVALID_SCOPE');
    assert.equal(status.ok, false);
    assert.equal(status.code, 'INVALID_SCOPE');
    assert.equal(missingCloseExpected.ok, false);
    assert.equal(missingCloseExpected.code, 'CLOSE_CONFIRMATION_REQUIRED');
    assert.equal(delegated, 0);
  },
  'Agent_lifecycle_regression_gateway_failure_cleanup': async () => {
    const { service, calls } = await createAgentLifecycleHarness({ gatewayFails: true });
    const result = asRecord(await callObjectMethod(service, 'openAgent', createOpenAgentRequest()), 'gateway failure result');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'INPUT_GATEWAY_REJECTED');
    assert.equal(calls.deleteTabs.length, 1);
    assert.equal(asRecord(calls.launchAttempts.at(-1), 'failed gateway launch attempt').status, 'failed');
    assert.equal(asRecord(calls.cleanupEvidence.at(-1), 'gateway cleanup evidence').sessionKey, result.sessionKey);
  },
  'Agent_lifecycle_regression_close_self_registry_leader': async () => {
    const { service, calls } = await createAgentLifecycleHarness();
    const result = asRecord(await callObjectMethod(service, 'closeSelf', {
      actor: createMcpActor({ sessionKey: 'follower-session-key', leaderSessionKey: undefined, scopes: ['mcp:session.close_self'] }),
    }), 'close_self registry leader result');
    assert.equal(result.ok, true);
    assert.equal(result.status, 'accepted');
    assert.equal(calls.scheduledCloseJobs.length, 1);
  },
  'Agent_lifecycle_regression_env_mode_no_config_file': async () => {
    const { service, calls } = await createAgentLifecycleHarness();
    const result = asRecord(await callObjectMethod(service, 'openAgent', createOpenAgentRequest({
      profileId: 'codex-env',
      mcpClientConfigMode: 'env',
    })), 'env mode open_agent result');
    assert.equal(result.ok, true);
    assert.equal(calls.createdConfigFiles.length, 0);
    assert.equal(calls.deletedConfigFiles.length, 0);
  },
};

type WebhookAndControlRestContract = Record<string, unknown>;

const webhookAndControlRestRedTests: Record<string, () => Promise<void>> = {
  'Webhook_control_red_tests_FR-MCP-004_AC-1': async () => {
    const { service, calls } = await createWebhookInvocationHarness();
    const created = asRecord(await callObjectMethod(service, 'createWebhookKey', {
      targetSessionKey: 'target-session',
      profileId: 'codex-env',
      mode: 'send-only',
      scopes: ['mcp:webhook.invoke'],
      expiresAt: '2026-07-10T00:00:00.000Z',
    }), 'webhook key create result');
    const record = asRecord(created.record, 'webhook persisted record');
    assert.equal(typeof created.fullKey, 'string');
    assert.equal(typeof created.fullUrl, 'string');
    assert.equal(typeof record.keyHash, 'string');
    assert.equal('fullKey' in record, false);
    assert.equal('fullUrl' in record, false);
    assertNoSecretMaterial(record, [String(created.fullKey)]);
    assert.equal(calls.persistedWebhooks.length, 1);
    assertNoSecretMaterial(calls.persistedWebhooks[0], [String(created.fullKey), String(created.fullUrl)]);

    const contract = await loadWebhookInvocationContract();
    const createStore = getWebhookControlFunction(contract, 'createWebhookRecordFileStore');
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'buildergate-webhook-store-'));
    try {
      const store = asRecord(createStore({ dataPath: path.join(tmpDir, 'webhooks.json') }), 'webhook record file store');
      const saveRecords = store.saveRecords as ((payload: unknown) => Promise<unknown>);
      const loadRecords = store.loadRecords as (() => Promise<unknown>);
      await saveRecords(asRecord(calls.persistedWebhooks[0], 'persisted webhook snapshot').records);
      const loaded = asRecordArray(await loadRecords(), 'loaded webhook records');
      assert.equal(loaded.length > 0, true);
      assertNoSecretMaterial(loaded, [String(created.fullKey), String(created.fullUrl)]);

      const restarted = await createWebhookInvocationHarness({
        webhookRecord: false,
        webhookRecords: loaded,
      });
      const acceptedAfterRestart = asRecord(await callObjectMethod(restarted.service, 'invokeWebhook', createWebhookInvokeRequest({
        query: { key: String(created.fullKey), prompt: 'after restart' },
      })), 'persisted webhook after restart result');
      assert.equal(acceptedAfterRestart.ok, true);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }

    const createFailureHarness = await createWebhookInvocationHarness({ persistWebhookRecordsFails: true });
    await assert.rejects(
      () => callObjectMethod(createFailureHarness.service, 'createWebhookKey', {
        targetSessionKey: 'target-session',
        profileId: 'persist-fail-profile',
      }),
      /persist failed/,
    );
    const createFailureList = asRecordArray(await callObjectMethod(createFailureHarness.service, 'listWebhookKeys', {}), 'create failure webhook list');
    assert.equal(createFailureList.some(item => item.profileId === 'persist-fail-profile'), false);

    const rotateFailureHarness = await createWebhookInvocationHarness({ persistWebhookRecordsFails: true });
    await assert.rejects(
      () => callObjectMethod(rotateFailureHarness.service, 'rotateWebhookKey', { id: 'wh_1' }),
      /persist failed/,
    );
    const oldKeyAfterRotateFailure = asRecord(await callObjectMethod(rotateFailureHarness.service, 'invokeWebhook', createWebhookInvokeRequest({
      query: { key: 'webhook-full-key', prompt: 'old key after failed rotate' },
    })), 'old key after failed rotate result');
    assert.equal(oldKeyAfterRotateFailure.ok, true);

    const revokeFailureHarness = await createWebhookInvocationHarness({ persistWebhookRecordsFails: true });
    await assert.rejects(
      () => callObjectMethod(revokeFailureHarness.service, 'revokeWebhookKey', { id: 'wh_1' }),
      /persist failed/,
    );
    const oldKeyAfterRevokeFailure = asRecord(await callObjectMethod(revokeFailureHarness.service, 'invokeWebhook', createWebhookInvokeRequest({
      query: { key: 'webhook-full-key', prompt: 'old key after failed revoke' },
    })), 'old key after failed revoke result');
    assert.equal(oldKeyAfterRevokeFailure.ok, true);

    const delayedRotateHarness = await createWebhookInvocationHarness({
      persistWebhookRecordsDelayMs: 25,
      webhookRecords: [],
    });
    const rotatePromise = callObjectMethod(delayedRotateHarness.service, 'rotateWebhookKey', { id: 'wh_1' });
    const staleInvokePromise = callObjectMethod(delayedRotateHarness.service, 'invokeWebhook', createWebhookInvokeRequest({
      query: { key: 'webhook-full-key', prompt: 'old key during delayed rotate' },
    }));
    const rotatedAfterDelay = asRecord(await rotatePromise, 'delayed rotate result');
    const staleInvoke = asRecord(await staleInvokePromise, 'stale invoke during delayed rotate result');
    assert.equal(typeof rotatedAfterDelay.fullKey, 'string');
    assert.equal(staleInvoke.ok, false);
    assert.equal(staleInvoke.code, 'WEBHOOK_KEY_INVALID');
    const newKeyAfterDelayedRotate = asRecord(await callObjectMethod(delayedRotateHarness.service, 'invokeWebhook', createWebhookInvokeRequest({
      query: { key: String(rotatedAfterDelay.fullKey), prompt: 'new key after delayed rotate' },
    })), 'new key after delayed rotate result');
    assert.equal(newKeyAfterDelayedRotate.ok, true);
  },
  'Webhook_control_red_tests_FR-MCP-004_AC-2': async () => {
    const { service, calls } = await createWebhookInvocationHarness();
    const accepted = asRecord(await callObjectMethod(service, 'invokeWebhook', createWebhookInvokeRequest({
      query: { key: 'webhook-full-key', prompt: 'x'.repeat(2048) },
    })), 'webhook max query prompt result');
    const rejected = asRecord(await callObjectMethod(service, 'invokeWebhook', createWebhookInvokeRequest({
      query: { key: 'webhook-full-key', prompt: 'x'.repeat(2049) },
    })), 'webhook oversized query prompt result');
    assert.equal(accepted.ok, true);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.code, 'WEBHOOK_PROMPT_TOO_LARGE');
    assert.equal(calls.openAgent.length + calls.deliverMessage.length <= 1, true);
  },
  'Webhook_control_red_tests_FR-MCP-004_AC-3': async () => {
    const { service, calls } = await createWebhookInvocationHarness({ revoked: true });
    const result = asRecord(await callObjectMethod(service, 'invokeWebhook', createWebhookInvokeRequest()), 'revoked webhook result');
    assert.equal(result.ok, false);
    assert.ok(['WEBHOOK_KEY_REVOKED', 'WEBHOOK_KEY_INVALID', 'WEBHOOK_RATE_LIMITED', 'MCP_TRANSPORT_DENIED'].includes(String(result.code)));
    assert.equal(typeof result.auditId, 'string');
    assert.equal(calls.searchSessions.length, 0);
    assert.equal(calls.openAgent.length, 0);
    assert.equal(calls.deliverMessage.length, 0);

    const missingHashHarness = await createWebhookInvocationHarness({
      webhookRecord: false,
      webhookRecords: [{
        keyId: 'wh_missing_hash',
        maskedKey: 'bgwh_****_missing',
        targetSessionKey: 'target-session',
        profileId: 'codex-env',
        mode: 'send-only',
        scopes: ['mcp:webhook.invoke'],
        expiresAt: '2026-07-10T00:00:00.000Z',
      }],
    });
    const missingHashResult = asRecord(await callObjectMethod(missingHashHarness.service, 'invokeWebhook', createWebhookInvokeRequest({
      query: { key: 'webhook-full-key', prompt: 'must not match fallback' },
    })), 'missing hash webhook result');
    const missingHashList = asRecordArray(await callObjectMethod(missingHashHarness.service, 'listWebhookKeys', {}), 'missing hash webhook list');
    assert.equal(missingHashResult.ok, false);
    assert.equal(missingHashResult.code, 'WEBHOOK_KEY_INVALID');
    assert.equal(missingHashHarness.calls.deliverMessage.length, 0);
    assert.equal(asRecord(missingHashList[0], 'missing hash listed webhook').revoked, true);
  },
  'Webhook_control_red_tests_FR-MCP-004_AC-4': async () => {
    const { service, calls } = await createWebhookInvocationHarness();
    const result = asRecord(await callObjectMethod(service, 'invokeWebhook', createWebhookInvokeRequest()), 'webhook assignment result');
    assert.equal(result.ok, true);
    const assignment = asRecord(calls.assignments[0], 'webhook assignment');
    assert.equal(assignment.sourceSessionKey ?? assignment.callerSessionId, '0');
    assert.equal(asRecord(calls.auditEvents[0], 'webhook audit').actorType, 'webhook');
  },
  'Webhook_control_red_tests_FR-MCP-004_AC-5': async () => {
    const { service, calls } = await createWebhookInvocationHarness();
    const result = asRecord(await callObjectMethod(service, 'invokeWebhook', createWebhookInvokeRequest({
      query: { key: 'webhook-full-key', prompt: 'hello', target: '빌더 게이트' },
    })), 'webhook alias target result');
    assert.equal(result.ok, true);
    assert.equal(asRecord(calls.searchSessions[0], 'webhook search request').query, '빌더 게이트');
    const delivery = asRecord(calls.deliverMessage[0], 'webhook delivery');
    assert.equal(delivery.deliveryMode, 'paste');
    assert.notEqual(delivery.deliveryMode, 'submit');

    const deliveryFailureHarness = await createWebhookInvocationHarness({ deliveryFails: true });
    const deliveryFailure = asRecord(await callObjectMethod(deliveryFailureHarness.service, 'invokeWebhook', createWebhookInvokeRequest({
      query: { key: 'webhook-full-key', prompt: 'hello', target: '빌더 게이트' },
    })), 'webhook delivery failure result');
    assert.equal(deliveryFailure.ok, false);
    assert.equal(deliveryFailure.code, 'TARGET_NOT_LIVE');
    assert.equal(deliveryFailure.message, 'target is no longer live');
    assert.equal(typeof deliveryFailure.auditId, 'string');
    assert.equal(asRecord(deliveryFailure.fieldErrors, 'webhook delivery field errors').sessionKey, 'not live');
    const deliveryFailureRoute = buildMcpControlRouteFailure(deliveryFailure, () => 'req_webhook_delivery');
    const deliveryFailureBody = asRecord(deliveryFailureRoute.body, 'webhook delivery route failure body');
    assert.equal(deliveryFailureRoute.status, 400);
    assert.equal(deliveryFailureBody.code, 'TARGET_NOT_LIVE');
    assert.equal(deliveryFailureBody.auditId, deliveryFailure.auditId);

    const ambiguousHarness = await createWebhookInvocationHarness({ ambiguousTarget: true });
    const ambiguous = asRecord(await callObjectMethod(ambiguousHarness.service, 'invokeWebhook', createWebhookInvokeRequest({
      query: { key: 'webhook-full-key', prompt: 'hello', target: 'builder' },
    })), 'webhook ambiguous result');
    assert.equal(ambiguous.ok, false);
    assert.equal(ambiguous.code, 'AMBIGUOUS_TARGET');

    const allowedAmbiguousHarness = await createWebhookInvocationHarness({ ambiguousTargetAllowed: true });
    const allowedAmbiguous = asRecord(await callObjectMethod(allowedAmbiguousHarness.service, 'invokeWebhook', createWebhookInvokeRequest({
      query: { key: 'webhook-full-key', prompt: 'hello', target: 'builder' },
    })), 'webhook allowed ambiguous result');
    assert.equal(allowedAmbiguous.ok, false);
    assert.equal(allowedAmbiguous.code, 'AMBIGUOUS_TARGET');
  },
  'Webhook_control_red_tests_FR-MCP-004_AC-6': async () => {
    const { service, calls } = await createWebhookInvocationHarness({ noTarget: true });
    const opened = asRecord(await callObjectMethod(service, 'invokeWebhook', createWebhookInvokeRequest({
      query: { key: 'webhook-full-key', prompt: 'open default' },
    })), 'webhook no target result');
    assert.equal(opened.ok, true);
    assert.equal(calls.searchSessions.length, 0);
    assert.equal(calls.deliverMessage.length, 0);
    assert.equal(calls.openAgent.length, 1);
    assert.equal(asRecord(calls.openAgent[0], 'open agent request').profileId, 'codex-env');

    const restCreatedHarness = await createWebhookInvocationHarness({ noTarget: true });
    const restCreated = asRecord(await callObjectMethod(restCreatedHarness.service, 'createWebhookKey', {
      profileId: 'codex-env',
      mode: 'open-or-send',
    }), 'REST created no-target webhook');
    assert.equal(asRecord(restCreated.record, 'REST created no-target record').targetSessionKey, undefined);
    const restOpened = asRecord(await callObjectMethod(restCreatedHarness.service, 'invokeWebhook', createWebhookInvokeRequest({
      query: { key: String(restCreated.fullKey), prompt: 'open default' },
    })), 'REST created no-target webhook invoke result');
    assert.equal(restOpened.ok, true);
    assert.equal(restCreatedHarness.calls.searchSessions.length, 0);
    assert.equal(restCreatedHarness.calls.deliverMessage.length, 0);
    assert.equal(restCreatedHarness.calls.openAgent.length, 1);

    const openFailureHarness = await createWebhookInvocationHarness({ noTarget: true, openAgentFails: true });
    const openFailure = asRecord(await callObjectMethod(openFailureHarness.service, 'invokeWebhook', createWebhookInvokeRequest({
      query: { key: 'webhook-full-key', prompt: 'open default failure' },
    })), 'webhook no-target open failure result');
    assert.equal(openFailure.ok, false);
    assert.equal(openFailure.code, 'AGENT_PROFILE_NOT_FOUND');
    assert.equal(openFailure.message, 'agent profile missing');
    assert.equal(asRecord(openFailure.details, 'open failure details').profileId, 'codex-env');
    assert.equal(asRecord(openFailure.fieldErrors, 'open failure field errors').profileId, 'not found');
    assert.equal(openFailure.openAgentAuditId, 'audit-open-agent-provider');
    const openFailureRoute = buildMcpControlRouteFailure(openFailure, () => 'req_open_agent_failure');
    const openFailureBody = asRecord(openFailureRoute.body, 'open agent failure route body');
    assert.equal(openFailureRoute.status, 404);
    assert.equal(openFailureBody.code, 'AGENT_PROFILE_NOT_FOUND');
    assert.equal(openFailureBody.message, 'agent profile missing');

    const missingDefault = await createWebhookInvocationHarness({ noTarget: true, noDefaultProfile: true });
    const failed = asRecord(await callObjectMethod(missingDefault.service, 'invokeWebhook', createWebhookInvokeRequest({
      query: { key: 'webhook-full-key', prompt: 'open default' },
    })), 'webhook missing default result');
    assert.equal(failed.ok, false);
    assert.equal(failed.code, 'AGENT_PROFILE_NOT_FOUND');
    assert.equal(missingDefault.calls.openAgent.length, 0);
  },
  'Webhook_control_red_tests_FR-MCP-004_AC-7': async () => {
    const validationHarness = await createWebhookInvocationHarness();
    const emptyBody = asRecord(await callObjectMethod(validationHarness.service, 'createWebhookKey', {}), 'empty webhook create result');
    const emptyScopes = asRecord(await callObjectMethod(validationHarness.service, 'createWebhookKey', {
      targetSessionKey: 'target-session',
      scopes: [],
    }), 'empty webhook scopes create result');
    assert.equal(emptyBody.ok, false);
    assert.equal(emptyBody.code, 'VALIDATION_ERROR');
    assert.equal(emptyScopes.ok, false);
    assert.equal(emptyScopes.code, 'VALIDATION_ERROR');
    assert.equal(validationHarness.calls.persistedWebhooks.length, 0);

    const { service, calls } = await createWebhookInvocationHarness();
    await callObjectMethod(service, 'invokeWebhook', createWebhookInvokeRequest({
      url: '/webhook/agent?key=webhook-full-key&prompt=raw-long-secret-prompt',
      query: { key: 'webhook-full-key', prompt: 'raw-long-secret-prompt' },
    }));
    const listed = asRecordArray(await callObjectMethod(service, 'listWebhookKeys', {}), 'webhook key list');
    assertNoSecretMaterial({ listed, auditEvents: calls.auditEvents, accessLogs: calls.accessLogs }, ['webhook-full-key', 'raw-long-secret-prompt']);
    assert.equal(typeof asRecord(listed[0], 'listed webhook').maskedKey, 'string');
    assert.equal(asRecord(listed[0], 'listed webhook').lastUsedAt, '2026-07-09T05:00:00.000Z');
    const persisted = asRecordArray(asRecord(calls.persistedWebhooks.at(-1), 'persisted webhook usage').records, 'persisted webhook records');
    assert.equal(asRecord(persisted[0], 'persisted used webhook').lastUsedAt, '2026-07-09T05:00:00.000Z');
    assertNoSecretMaterial(persisted, ['webhook-full-key', 'raw-long-secret-prompt']);

    const failingPersistHarness = await createWebhookInvocationHarness({ persistWebhookRecordsFails: true });
    const deliveredWithPersistFailure = asRecord(await callObjectMethod(failingPersistHarness.service, 'invokeWebhook', createWebhookInvokeRequest({
      query: { key: 'webhook-full-key', prompt: 'delivered despite metadata persist failure' },
    })), 'webhook usage metadata persist failure result');
    assert.equal(deliveredWithPersistFailure.ok, true);
    assert.equal(failingPersistHarness.calls.deliverMessage.length, 1);
    assert.equal(failingPersistHarness.calls.auditEvents.some(event => event.code === 'WEBHOOK_METADATA_PERSIST_FAILED'), true);
  },
  'Webhook_control_red_tests_IR-MCP-002_AC-1': async () => {
    const { service } = await createMcpControlHarness();
    const configResult = asRecord(await callObjectMethod(service, 'getConfig', { auth: { type: 'browser-jwt' } }), 'control config result');
    const denied = asRecord(await callObjectMethod(service, 'getConfig', { auth: { type: 'mcp-capability', token: 'mcp-token' } }), 'MCP token config denial');
    const deniedMcpType = asRecord(await callObjectMethod(service, 'getConfig', { auth: { type: 'mcp', token: 'mcp-token' } }), 'MCP legacy token config denial');
    const deniedUnknown = asRecord(await callObjectMethod(service, 'getConfig', { auth: { type: 'unknown' } }), 'unknown auth config denial');
    for (const key of ['enabled', 'bindMode', 'host', 'port', 'transportSecurity', 'trustedProxies', 'externalWhitelist', 'allowedOrigins', 'status', 'lastError', 'lastRebindResult']) {
      assert.ok(key in configResult, `missing config field ${key}`);
    }
    assert.equal(denied.ok, false);
    assert.equal(denied.code, 'CREDENTIAL_BOUNDARY_VIOLATION');
    assert.equal(deniedMcpType.ok, false);
    assert.equal(deniedMcpType.code, 'CREDENTIAL_BOUNDARY_VIOLATION');
    assert.equal(deniedUnknown.ok, false);
    assert.equal(deniedUnknown.code, 'CREDENTIAL_BOUNDARY_VIOLATION');

    const successfulConfigHarness = await createMcpControlHarness();
    const setConfigOk = asRecord(await callObjectMethod(successfulConfigHarness.service, 'setConfig', {
      host: '127.0.0.1',
      port: 4444,
      externalWhitelist: ['127.0.0.1'],
    }), 'successful control config mutation');
    assert.equal(setConfigOk.ok ?? true, true);
    assert.equal(setConfigOk.port, 4444);
    assert.equal(asRecord(setConfigOk.lastRebindResult, 'successful config last rebind').ok, true);
    assert.equal(successfulConfigHarness.calls.mutateConfig.length, 1);
    assert.equal(asRecord(successfulConfigHarness.calls.mutateConfig[0], 'successful config mutate call').rebindRequested, true);

    const policyOnlyConfigHarness = await createMcpControlHarness();
    const policyOnly = asRecord(await callObjectMethod(policyOnlyConfigHarness.service, 'setConfig', {
      allowedOrigins: ['https://buildergate.local'],
    }), 'policy-only control config mutation');
    assert.equal(policyOnly.ok ?? true, true);
    assert.equal(policyOnlyConfigHarness.calls.mutateConfig.length, 1);
    const policyOnlyMutation = asRecord(policyOnlyConfigHarness.calls.mutateConfig[0], 'policy-only config mutate call');
    assert.equal(policyOnlyMutation.rebindRequested, false);
    assert.deepEqual(policyOnlyMutation.changedFields, ['allowedOrigins']);

    const contract = await loadMcpControlRestContract();
    const mergeSecurityConfig = getWebhookControlFunction(contract, 'mergeMcpControlSecurityConfig');
    const preservedPartialPatch = asRecord(mergeSecurityConfig({
      enabled: false,
      bindMode: 'whitelist',
      bindHost: '0.0.0.0',
      port: 4444,
      externalWhitelist: ['203.0.113.0/24'],
      transportSecurity: 'direct_tls',
      trustedProxies: ['198.51.100.5/32'],
      allowedOrigins: ['https://old.example'],
    }, {
      allowedOrigins: ['https://new.example'],
    }, {
      bindHost: '127.0.0.1',
      port: 3333,
    }), 'merged partial MCP control security patch');
    assert.equal(preservedPartialPatch.enabled, false);
    assert.equal(preservedPartialPatch.bindMode, 'whitelist');
    assert.equal(preservedPartialPatch.bindHost, '0.0.0.0');
    assert.equal(preservedPartialPatch.port, 4444);
    assert.deepEqual(preservedPartialPatch.externalWhitelist, ['203.0.113.0/24']);
    assert.equal(preservedPartialPatch.transportSecurity, 'direct_tls');
    assert.deepEqual(preservedPartialPatch.trustedProxies, ['198.51.100.5/32']);
    assert.deepEqual(preservedPartialPatch.allowedOrigins, ['https://new.example']);

    const malformedPartialPatch = asRecord(mergeSecurityConfig({
      enabled: true,
      bindMode: 'loopback',
      bindHost: '127.0.0.1',
      port: 4444,
      externalWhitelist: [],
      transportSecurity: 'none',
      trustedProxies: [],
      allowedOrigins: [],
    }, {
      allowedOrigins: 'https://example.com',
    }, {
      port: 3333,
    }), 'merged malformed MCP control security patch');
    assert.equal(malformedPartialPatch.port, 4444);
    assert.equal(malformedPartialPatch.allowedOrigins, 'https://example.com');

    const runtimePolicyController = await createMcpListenerControllerHarness();
    await callMcpListenerController(runtimePolicyController, 'start', { enabled: true });
    const runtimePolicyHarness = await createMcpControlHarness({ listenerController: runtimePolicyController });
    const runtimePolicy = asRecord(await callObjectMethod(runtimePolicyHarness.service, 'setConfig', {
      allowedOrigins: ['https://allowed.example'],
    }), 'runtime policy-only control config mutation');
    assert.equal(runtimePolicy.ok ?? true, true);
    assert.equal(asRecord(runtimePolicyHarness.calls.mutateConfig[0], 'runtime policy-only mutate call').rebindRequested, false);
    const staleRuntimePolicy = asRecord(await callMcpListenerController(runtimePolicyController, 'evaluateRequest', {
      remoteAddress: '127.0.0.1',
      headers: { origin: 'https://stale.example' },
      credential: createMcpActor(),
    }), 'runtime stale origin after control config mutation');
    const currentRuntimePolicy = asRecord(await callMcpListenerController(runtimePolicyController, 'evaluateRequest', {
      remoteAddress: '127.0.0.1',
      headers: { origin: 'https://allowed.example' },
      credential: createMcpActor(),
    }), 'runtime allowed origin after control config mutation');
    assert.equal(staleRuntimePolicy.ok, false);
    assert.equal(staleRuntimePolicy.code, 'MCP_ORIGIN_DENIED');
    assert.equal(currentRuntimePolicy.ok, true);
    assert.equal(currentRuntimePolicy.dispatched, true);

    const transportSecurityHarness = await createMcpControlHarness();
    const transportSecurityChange = asRecord(await callObjectMethod(transportSecurityHarness.service, 'setConfig', {
      transportSecurity: 'direct_tls',
    }), 'transport security control config mutation');
    assert.equal(transportSecurityChange.ok ?? true, true);
    assert.equal(transportSecurityHarness.calls.mutateConfig.length, 1);
    const transportSecurityMutation = asRecord(transportSecurityHarness.calls.mutateConfig[0], 'transport security mutate call');
    assert.equal(transportSecurityMutation.rebindRequested, true);
    assert.deepEqual(transportSecurityMutation.changedFields, ['transportSecurity']);

    const disableHarness = await createMcpControlHarness();
    const disabledOk = asRecord(await callObjectMethod(disableHarness.service, 'setConfig', {
      enabled: false,
    }), 'disabled control config mutation');
    assert.equal(disabledOk.enabled, false);
    assert.equal(disableHarness.calls.mutateConfig.length, 1);
    assert.equal(asRecord(disableHarness.calls.mutateConfig[0], 'disable config mutate call').rebindRequested, true);

    const failingConfigHarness = await createMcpControlHarness({ configMutationFails: true });
    const setConfigFailed = asRecord(await callObjectMethod(failingConfigHarness.service, 'setConfig', {
      host: '127.0.0.1',
      port: 4444,
      externalWhitelist: ['10.0.0.5'],
    }), 'failed control config mutation');
    assert.equal(setConfigFailed.ok, false);
    assert.equal(setConfigFailed.code, 'MCP_PORT_REBIND_FAILED');
    assert.equal(failingConfigHarness.calls.mutateConfig.length, 1);
    const configAfterFailedMutation = asRecord(await callObjectMethod(failingConfigHarness.service, 'getConfig', {}), 'config after failed mutation');
    assert.equal(configAfterFailedMutation.host, '127.0.0.1');
    assert.equal(configAfterFailedMutation.port, 3333);
    assert.deepEqual(configAfterFailedMutation.externalWhitelist, []);
    assert.equal(configAfterFailedMutation.lastError, 'bind failed');
    assert.equal(asRecord(configAfterFailedMutation.lastRebindResult, 'failed config last rebind').code, 'MCP_PORT_REBIND_FAILED');

    const unsafeWhitelistHarness = await createMcpControlHarness();
    const unsafeWhitelist = asRecord(await callObjectMethod(unsafeWhitelistHarness.service, 'setConfig', {
      bindMode: 'whitelist',
      externalWhitelist: ['0.0.0.0/0'],
      transportSecurity: 'none',
    }), 'unsafe whitelist config mutation');
    assert.equal(unsafeWhitelist.ok, false);
    assert.equal(unsafeWhitelist.code, 'MCP_WHITELIST_DENIED');
    assert.equal(unsafeWhitelistHarness.calls.mutateConfig.length, 0);
    const configAfterUnsafeWhitelist = asRecord(await callObjectMethod(unsafeWhitelistHarness.service, 'getConfig', {}), 'config after unsafe whitelist');
    assert.equal(configAfterUnsafeWhitelist.bindMode, 'loopback');
    assert.deepEqual(configAfterUnsafeWhitelist.externalWhitelist, []);

    const unsafeDirectTlsHarness = await createMcpControlHarness();
    const unsafeDirectTls = asRecord(await callObjectMethod(unsafeDirectTlsHarness.service, 'setConfig', {
      bindMode: 'whitelist',
      host: '0.0.0.0',
      externalWhitelist: ['0.0.0.0/0'],
      transportSecurity: 'direct_tls',
    }), 'unsafe direct TLS whitelist config mutation');
    assert.equal(unsafeDirectTls.ok, false);
    assert.equal(unsafeDirectTls.code, 'MCP_WHITELIST_DENIED');
    assert.equal(unsafeDirectTlsHarness.calls.mutateConfig.length, 0);

    const disabledUnsafeHarness = await createMcpControlHarness();
    const disabledUnsafe = asRecord(await callObjectMethod(disabledUnsafeHarness.service, 'setConfig', {
      enabled: false,
      bindMode: 'whitelist',
      externalWhitelist: ['0.0.0.0/0'],
      transportSecurity: 'none',
    }), 'disabled unsafe whitelist config mutation');
    assert.equal(disabledUnsafe.ok, false);
    assert.equal(disabledUnsafe.code, 'MCP_WHITELIST_DENIED');
    assert.equal(disabledUnsafeHarness.calls.mutateConfig.length, 0);

    const disabledLoopbackExternalHarness = await createMcpControlHarness();
    const disabledLoopbackExternal = asRecord(await callObjectMethod(disabledLoopbackExternalHarness.service, 'setConfig', {
      enabled: false,
      bindMode: 'loopback',
      host: '0.0.0.0',
    }), 'disabled loopback external host config mutation');
    assert.equal(disabledLoopbackExternal.ok, false);
    assert.equal(disabledLoopbackExternal.code, 'MCP_LOOPBACK_ONLY');
    assert.equal(disabledLoopbackExternalHarness.calls.mutateConfig.length, 0);

    const emptyWhitelistHarness = await createMcpControlHarness();
    const emptyWhitelist = asRecord(await callObjectMethod(emptyWhitelistHarness.service, 'setConfig', {
      bindMode: 'whitelist',
      externalWhitelist: [],
      transportSecurity: 'trusted_tls_proxy',
    }), 'empty whitelist config mutation');
    assert.equal(emptyWhitelist.ok, false);
    assert.equal(emptyWhitelist.code, 'MCP_WHITELIST_EMPTY');
    assert.equal(emptyWhitelistHarness.calls.mutateConfig.length, 0);

    const malformedConfigCases = [
      {
        label: 'bind mode',
        request: { bindMode: 'external', host: '127.0.0.1' },
        code: 'MCP_TRANSPORT_DENIED',
      },
      {
        label: 'external whitelist CIDR',
        request: {
          bindMode: 'whitelist',
          externalWhitelist: ['not-a-cidr'],
          transportSecurity: 'direct_tls',
        },
        code: 'MCP_WHITELIST_DENIED',
      },
      {
        label: 'loopback wide-open external whitelist CIDR',
        request: {
          bindMode: 'loopback',
          host: '127.0.0.1',
          externalWhitelist: ['0.0.0.0/0'],
        },
        code: 'MCP_WHITELIST_DENIED',
      },
      {
        label: 'loopback wide-open zero-padded external whitelist CIDR',
        request: {
          bindMode: 'loopback',
          host: '127.0.0.1',
          externalWhitelist: ['0.0.0.0/00'],
        },
        code: 'MCP_WHITELIST_DENIED',
      },
      {
        label: 'trusted proxy CIDR',
        request: {
          bindMode: 'whitelist',
          externalWhitelist: ['203.0.113.0/24'],
          transportSecurity: 'trusted_tls_proxy',
          trustedProxies: ['also-bad'],
        },
        code: 'MCP_TRUSTED_PROXY_DENIED',
      },
      {
        label: 'allowed origin',
        request: { allowedOrigins: ['not a url'] },
        code: 'MCP_ORIGIN_DENIED',
      },
      {
        label: 'allowed origin shape',
        request: { allowedOrigins: 'https://example.com' },
        code: 'MCP_ORIGIN_DENIED',
      },
      {
        label: 'transport security',
        request: {
          bindMode: 'whitelist',
          externalWhitelist: ['203.0.113.0/24'],
          transportSecurity: 'plaintext',
        },
        code: 'MCP_TRANSPORT_DENIED',
      },
    ];
    for (const { label, request, code } of malformedConfigCases) {
      const malformedHarness = await createMcpControlHarness();
      const malformed = asRecord(await callObjectMethod(
        malformedHarness.service,
        'setConfig',
        request,
      ), `malformed ${label} config mutation`);
      assert.equal(malformed.ok, false, `${label} config must fail`);
      assert.equal(malformed.code, code, `${label} rejection code`);
      assert.equal(malformedHarness.calls.mutateConfig.length, 0, `${label} config must not reach mutator`);
      const configAfterMalformed = asRecord(await callObjectMethod(
        malformedHarness.service,
        'getConfig',
        {},
      ), `config after malformed ${label}`);
      assert.equal(configAfterMalformed.bindMode, 'loopback', `${label} rollback bindMode`);
      assert.equal(configAfterMalformed.host, '127.0.0.1', `${label} rollback host`);
      assert.deepEqual(configAfterMalformed.externalWhitelist, [], `${label} rollback whitelist`);
      assert.deepEqual(configAfterMalformed.trustedProxies, [], `${label} rollback trusted proxies`);
      assert.deepEqual(configAfterMalformed.allowedOrigins, [], `${label} rollback origins`);
    }

    const mutatingHarness = await createMcpControlHarness();
    const mcpAuth = { type: 'mcp-capability', token: 'mcp-token' };
    const deniedMutations = [
      await callObjectMethod(mutatingHarness.service, 'createAgentProfile', { auth: mcpAuth, displayName: 'Codex', command: 'codex' }),
      await callObjectMethod(mutatingHarness.service, 'createWebhook', { auth: mcpAuth, targetSessionKey: 'target-session' }),
      await callObjectMethod(mutatingHarness.service, 'rotateWebhook', { auth: mcpAuth, id: 'wh_1' }),
      await callObjectMethod(mutatingHarness.service, 'revokeWebhook', { auth: mcpAuth, id: 'wh_1' }),
      await callObjectMethod(mutatingHarness.service, 'replyTest', { auth: mcpAuth, sessionKey: 'target-session', prompt: 'reply' }),
      await callObjectMethod(mutatingHarness.service, 'closeSession', { auth: mcpAuth, sessionKey: 'target-session', confirmClose: true, expectedSessionKey: 'target-session', confirmationNonce: 'nonce-current' }),
    ].map((item, index) => asRecord(item, `MCP auth mutation denial ${index}`));
    for (const item of deniedMutations) {
      assert.equal(item.ok, false);
      assert.equal(item.code, 'CREDENTIAL_BOUNDARY_VIOLATION');
    }
    assert.equal(mutatingHarness.calls.profileMutations.length, 0);
    assert.equal(mutatingHarness.calls.webhookMutations.length, 0);
    assert.equal(mutatingHarness.calls.replyGateway.length, 0);
    assert.equal(mutatingHarness.calls.closeLifecycle.length, 0);
  },
  'Webhook_control_red_tests_IR-MCP-002_AC-2': async () => {
    const { service } = await createMcpControlHarness();
    const created = asRecord(await callObjectMethod(service, 'createAgentProfile', {
      displayName: 'Codex Worker',
      command: 'codex',
      args: ['--model', 'gpt-5'],
      aliases: ['codex'],
      isDefault: true,
      enabled: true,
      kickoffPrompt: 'start',
      mcpClientConfigMode: 'env',
    }), 'control agent create result');
    for (const key of ['id', 'displayName', 'command', 'args', 'aliases', 'isDefault', 'enabled', 'kickoffPrompt', 'mcpClientConfigMode', 'createdAt', 'updatedAt']) {
      assert.ok(key in created, `missing agent profile field ${key}`);
    }
  },
  'Webhook_control_red_tests_IR-MCP-002_AC-3': async () => {
    const { service } = await createMcpControlHarness();
    const result = asRecord(await callObjectMethod(service, 'createAgentProfile', {
      displayName: '',
      command: 'bad\u0000command',
      args: 'not-array',
      aliases: ['dup', 'dup'],
      mcpClientConfigMode: 'unsafe',
      kickoffPrompt: 'x'.repeat(12001),
    }), 'invalid control agent create result');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'VALIDATION_ERROR');
    const fields = asRecord(result.fieldErrors, 'agent validation field errors');
    for (const key of ['displayName', 'command', 'args', 'aliases', 'mcpClientConfigMode', 'kickoffPrompt']) {
      assert.ok(key in fields, `missing field error ${key}`);
    }
    const patchResult = asRecord(await callObjectMethod(service, 'updateAgentProfile', {
      id: 'agent-1',
      command: 'bad\u0000command',
      aliases: ['dup', 'dup'],
      mcpClientConfigMode: 'unsupported',
    }), 'invalid control agent patch result');
    assert.equal(patchResult.ok, false);
    assert.equal(patchResult.code, 'VALIDATION_ERROR');
    const patchFields = asRecord(patchResult.fieldErrors, 'agent patch validation field errors');
    for (const key of ['command', 'aliases', 'mcpClientConfigMode']) {
      assert.ok(key in patchFields, `missing patch field error ${key}`);
    }
    const patchOk = asRecord(await callObjectMethod(service, 'updateAgentProfile', {
      id: 'agent-1',
      displayName: 'Renamed Agent',
    }), 'valid control agent patch result');
    assert.equal(patchOk.ok, true);
    assert.equal('auth' in patchOk, false);
  },
  'Webhook_control_red_tests_IR-MCP-002_AC-4': async () => {
    const { service } = await createMcpControlHarness();
    const created = asRecord(await callObjectMethod(service, 'createWebhook', { targetSessionKey: 'target-session' }), 'control webhook create');
    const rotated = asRecord(await callObjectMethod(service, 'rotateWebhook', { id: String(created.keyId) }), 'control webhook rotate');
    const revoked = asRecord(await callObjectMethod(service, 'revokeWebhook', { id: String(created.keyId) }), 'control webhook revoke');
    const listed = asRecordArray(await callObjectMethod(service, 'listWebhooks', {}), 'control webhook list');
    assert.equal(typeof created.fullKey, 'string');
    assert.equal(typeof rotated.fullKey, 'string');
    assert.equal(revoked.revoked, true);
    assertNoSecretMaterial(listed, [String(created.fullKey), String(rotated.fullKey)]);
  },
  'Webhook_control_red_tests_IR-MCP-002_AC-5': async () => {
    const { service, calls } = await createMcpControlHarness();
    const sessionsResult = asRecord(await callObjectMethod(service, 'listSessions', {}), 'control sessions result');
    const sessions = asRecordArray(sessionsResult.sessions, 'control sessions');
    const alias = asRecord(await callObjectMethod(service, 'setSessionAlias', { sessionKey: 'target-session', alias: '빌더 게이트' }), 'control alias update');
    assert.equal(sessions.every(session => !('token' in session) && !('webhookKey' in session)), true);
    assert.equal(alias.nameSource ?? alias.aliasSource, 'user');
    assert.equal(asRecord(calls.setAlias[0], 'set alias call').sessionKey, 'target-session');

    const asyncHarness = await createMcpControlHarness({ asyncDeps: true });
    const asyncAlias = asRecord(await callObjectMethod(asyncHarness.service, 'setSessionAlias', {
      sessionKey: 'target-session',
      alias: 'async-alias',
    }), 'async control alias update');
    assert.equal(asyncAlias.name, 'async-alias');
    assert.equal(asyncAlias.nameSource ?? asyncAlias.aliasSource, 'user');
    assert.equal(asRecord(asyncHarness.calls.setAlias[0], 'async set alias call').sessionKey, 'target-session');

    const failureHarness = await createMcpControlHarness({
      listSessionsFails: true,
      searchSessionsFails: true,
      aliasFails: true,
    });
    const failedList = asRecord(await callObjectMethod(failureHarness.service, 'listSessions', {}), 'control list dependency failure');
    const failedQueryList = asRecord(await callObjectMethod(failureHarness.service, 'listSessions', { query: 'missing' }), 'control query list dependency failure');
    const failedSearch = asRecord(await callObjectMethod(failureHarness.service, 'searchSessions', { query: 'missing' }), 'control search dependency failure');
    const failedSearchTest = asRecord(await callObjectMethod(failureHarness.service, 'searchTest', { query: 'missing' }), 'control search-test dependency failure');
    const failedAlias = asRecord(await callObjectMethod(failureHarness.service, 'setSessionAlias', {
      sessionKey: 'missing-session',
      alias: 'missing',
    }), 'control alias dependency failure');
    assert.equal(failedList.allowed, false);
    assert.equal(failedList.code, 'TARGET_NOT_FOUND');
    assert.equal(failedList.message, 'list target missing');
    assert.equal(asRecordArray(failedList.candidates, 'failed list candidates')[0]?.sessionKey, 'candidate-list');
    assert.equal(failedQueryList.allowed, false);
    assert.equal(failedQueryList.code, 'TARGET_NOT_FOUND');
    assert.equal(failedSearch.allowed, false);
    assert.equal(failedSearch.code, 'TARGET_NOT_FOUND');
    assert.equal(failedSearch.reason, 'missing-session');
    assert.equal(asRecordArray(failedSearch.candidates, 'failed search candidates')[0]?.sessionKey, 'candidate-search');
    assert.equal(failedSearchTest.allowed, false);
    assert.equal(failedSearchTest.code, 'TARGET_NOT_FOUND');
    assert.equal(failedSearchTest.readOnly, true);
    assert.equal(failedAlias.allowed, false);
    assert.equal(failedAlias.code, 'TARGET_NOT_FOUND');
    assert.equal(failedAlias.message, 'alias target missing');
    assert.equal(asRecord(failedAlias.fieldErrors, 'failed alias field errors').sessionKey, 'not found');

    const aliasThrowHarness = await createMcpControlHarness({ aliasThrows: true });
    const thrownAlias = asRecord(await callObjectMethod(aliasThrowHarness.service, 'setSessionAlias', {
      sessionKey: 'missing-session',
      alias: 'missing',
    }), 'control alias provider throw result');
    assert.equal(thrownAlias.ok, false);
    assert.equal(thrownAlias.code, 'TARGET_NOT_FOUND');
    assert.equal(thrownAlias.message, 'Tab not found');
    assert.equal(asRecord(thrownAlias.fieldErrors, 'thrown alias field errors').sessionKey, 'not found');
    assert.equal(typeof thrownAlias.auditId, 'string');
  },
  'Webhook_control_red_tests_IR-MCP-002_AC-6': async () => {
    const { service, calls } = await createMcpControlHarness();
    const reply = asRecord(await callObjectMethod(service, 'replyTest', { sessionKey: 'follower-session', prompt: 'reply', deliveryMode: 'paste' }), 'reply test result');
    const close = asRecord(await callObjectMethod(service, 'closeSession', { sessionKey: 'follower-session', confirmClose: true, expectedSessionKey: 'follower-session', confirmationNonce: 'nonce-current' }), 'control close result');
    assert.equal(reply.accepted, true);
    assert.equal(close.ok, true);
    assert.equal(calls.replyGateway.length, 1);
    assert.equal(calls.closeLifecycle.length, 1);
    assert.equal(asRecord(calls.closeLifecycle[0], 'control close lifecycle call').expectedSessionKey, 'follower-session');
    const pasteReplyCall = asRecord(calls.replyGateway[0], 'paste reply gateway call');
    const pasteReplyDelivery = asRecord(pasteReplyCall.delivery, 'paste reply delivery');
    assert.equal(pasteReplyCall.data, 'reply');
    assert.equal(pasteReplyDelivery.mode, 'paste');
    assert.equal(pasteReplyDelivery.submit, false);

    const submitReply = asRecord(await callObjectMethod(service, 'replyTest', {
      sessionKey: 'follower-session',
      prompt: 'Hello, World!',
      deliveryMode: 'submit',
    }), 'submit reply test result');
    const submitReplyCall = asRecord(calls.replyGateway[1], 'submit reply gateway call');
    const submitReplyDelivery = asRecord(submitReplyCall.delivery, 'submit reply delivery');
    assert.equal(submitReply.accepted, true);
    assert.equal(calls.replyGateway.length, 2);
    assert.equal(submitReplyCall.data, 'Hello, World!\r');
    assert.equal(submitReplyDelivery.mode, 'submit');
    assert.equal(submitReplyDelivery.submit, true);

    const asyncFailureHarness = await createMcpControlHarness({
      asyncDeps: true,
      replyGatewayFails: true,
      closeLifecycleFails: true,
    });
    const asyncReply = asRecord(await callObjectMethod(asyncFailureHarness.service, 'replyTest', {
      sessionKey: 'follower-session',
      prompt: 'reply',
      deliveryMode: 'paste',
    }), 'async reply gateway rejection result');
    const asyncClose = asRecord(await callObjectMethod(asyncFailureHarness.service, 'closeSession', {
      sessionKey: 'follower-session',
      confirmClose: true,
      expectedSessionKey: 'follower-session',
      confirmationNonce: 'nonce-current',
    }), 'async close lifecycle failure result');
    assert.equal(asyncReply.accepted, false);
    assert.equal(asyncReply.ok, false);
    assert.equal(asyncReply.code, 'INPUT_REJECTED_REPLAY_PENDING');
    const replyRouteFailure = buildMcpControlRouteFailure(asyncReply, () => 'req_reply_failure');
    const replyRouteFailureBody = asRecord(replyRouteFailure.body, 'reply route failure body');
    assert.notEqual(replyRouteFailure.status, 200);
    assert.equal(replyRouteFailureBody.ok, false);
    assert.equal(replyRouteFailureBody.code, 'INPUT_REJECTED_REPLAY_PENDING');
    assert.equal(asyncClose.ok, false);
    assert.equal(asyncClose.status, 'failed');
    assert.equal(asyncClose.code, 'TAB_DELETE_FAILED');
    assert.equal(asyncFailureHarness.calls.replyGateway.length, 1);
    assert.equal(asyncFailureHarness.calls.closeLifecycle.length, 1);

    const internalNonceHarness = await createMcpControlHarness({ internalCloseConfirmation: true });
    const listedForClose = asRecord(await callObjectMethod(internalNonceHarness.service, 'listSessions', {}), 'internal nonce control sessions result');
    const closeTarget = asRecord(
      asRecordArray(listedForClose.sessions, 'internal nonce control sessions')
        .find(session => session.sessionKey === 'target-session'),
      'internal nonce close target',
    );
    const issuedNonce = String(closeTarget.closeConfirmationNonce ?? '');
    assert.match(issuedNonce, /^close_/u);

    const searchForClose = asRecord(await callObjectMethod(internalNonceHarness.service, 'listSessions', { query: '빌더 게이트' }), 'internal nonce query sessions result');
    const searchTarget = asRecord(asRecordArray(searchForClose.matches, 'internal nonce query matches')[0], 'internal nonce query target');
    assert.equal(searchTarget.closeConfirmationNonce, issuedNonce);

    const arbitraryNonceClose = asRecord(await callObjectMethod(internalNonceHarness.service, 'closeSession', {
      sessionKey: 'target-session',
      confirmClose: true,
      expectedSessionKey: 'target-session',
      confirmationNonce: 'anything',
    }), 'arbitrary nonce close result');
    assert.equal(arbitraryNonceClose.ok, false);
    assert.equal(arbitraryNonceClose.code, 'CLOSE_CONFIRMATION_REQUIRED');
    assert.equal(internalNonceHarness.calls.closeLifecycle.length, 0);

    const validNonceClose = asRecord(await callObjectMethod(internalNonceHarness.service, 'closeSession', {
      sessionKey: 'target-session',
      confirmClose: true,
      expectedSessionKey: 'target-session',
      confirmationNonce: issuedNonce,
    }), 'issued nonce close result');
    const replayedNonceClose = asRecord(await callObjectMethod(internalNonceHarness.service, 'closeSession', {
      sessionKey: 'target-session',
      confirmClose: true,
      expectedSessionKey: 'target-session',
      confirmationNonce: issuedNonce,
    }), 'replayed nonce close result');
    assert.equal(validNonceClose.ok, true);
    assert.equal(replayedNonceClose.ok, false);
    assert.equal(replayedNonceClose.code, 'CLOSE_CONFIRMATION_REQUIRED');
    assert.equal(internalNonceHarness.calls.closeLifecycle.length, 1);
  },
  'Webhook_control_red_tests_IR-MCP-002_AC-7': async () => {
    const { service } = await createMcpControlHarness();
    const result = asRecord(await callObjectMethod(service, 'createWebhook', { fullKey: 'raw-key', prompt: 'raw prompt', targetSessionKey: '' }), 'control validation error');
    assert.equal(result.ok, false);
    assert.equal(typeof result.code, 'string');
    assert.ok(typeof result.requestId === 'string' || typeof result.auditId === 'string');
    assertNoSecretMaterial(result, ['raw-key', 'raw prompt']);
  },
  'Webhook_control_red_tests_IR-MCP-002_AC-8': async () => {
    const { service } = await createMcpControlHarness();
    const created = asRecord(await callObjectMethod(service, 'createWebhook', { targetSessionKey: 'target-session' }), 'one-time webhook create');
    const list = await callObjectMethod(service, 'listWebhooks', {});
    const status = await callObjectMethod(service, 'getConfig', { auth: { type: 'browser-jwt' } });
    assert.equal(typeof created.fullUrl, 'string');
    assertNoSecretMaterial({ list, status }, [String(created.fullUrl), String(created.fullKey)]);
  },
  'Webhook_control_red_tests_IR-MCP-003_AC-1': async () => {
    const { service, calls } = await createMcpControlHarness();
    const result = asRecord(await callObjectMethod(service, 'listSessions', { query: '빌더 게이트' }), 'control query sessions');
    assert.equal(result.allowed ?? true, true);
    assert.equal(asRecord(calls.searchSessions[0], 'control search call').query, '빌더 게이트');
    assertNoSecretMaterial(result, ['raw-token', 'webhook-full-key', 'hidden-terminal-payload']);
    const match = asRecord(asRecordArray(result.matches, 'control query matches')[0], 'control query match');
    assert.equal(match.sessionId, 'target-current-session-id');
    assert.equal(match.currentSessionId, 'target-current-session-id');
    assert.equal(match.bindingLifecycle, 'live');
    assert.equal(match.mcpConnected, true);
    assert.equal(match.leader, false);
    assert.equal(match.lastSeenAt, '2026-07-09T05:00:00.000Z');
  },
  'Webhook_control_red_tests_IR-MCP-003_AC-2': async () => {
    const { service, calls } = await createMcpControlHarness();
    const result = asRecord(await callObjectMethod(service, 'searchTest', { query: 'builder' }), 'control search test');
    assert.equal(Array.isArray(result.matches), true);
    assert.equal(asRecordArray(result.matches, 'control search test matches').some(match => 'closeConfirmationNonce' in match), false);
    assert.equal(calls.setAlias.length, 0);
    assert.equal(calls.closeLifecycle.length, 0);
  },
  'Webhook_control_red_tests_IR-MCP-003_AC-3': async () => {
    const { service, calls } = await createMcpControlHarness();
    const result = asRecord(await callObjectMethod(service, 'replyTest', { sessionKey: 'follower-session', prompt: 'hello' }), 'control reply test');
    assert.equal(result.accepted, true);
    assert.equal(asRecord(calls.replyGateway[0], 'reply gateway call').source, 'mcp-reply-to-leader');
  },
  'MCP_manual_client_claim_code_is_UI_auth_only_and_bound_to_a_live_session': async () => {
    const { service, calls } = await createMcpControlHarness();
    const issued = asRecord(await callObjectMethod(service, 'createSessionClaimCode', {
      sessionKey: 'target-session',
    }), 'manual client claim code');
    assert.equal(issued.ok, true);
    assert.equal(issued.sessionKey, 'target-session');
    assert.equal(issued.claimCode, 'claim_target-session');
    assert.equal(asRecord(calls.claimCodes[0], 'claim code request').sessionKey, 'target-session');

    const listed = await callObjectMethod(service, 'listSessions', {});
    assertNoSecretMaterial(listed, [String(issued.claimCode)]);

    const denied = asRecord(await callObjectMethod(service, 'createSessionClaimCode', {
      auth: { type: 'mcp-capability', token: 'mcp-token' },
      sessionKey: 'target-session',
    }), 'MCP actor claim-code denial');
    assert.equal(denied.ok, false);
    assert.equal(denied.code, 'CREDENTIAL_BOUNDARY_VIOLATION');

    const missing = asRecord(await callObjectMethod(service, 'createSessionClaimCode', {
      sessionKey: 'missing-session',
    }), 'missing claim-code session');
    assert.equal(missing.ok, false);
    assert.equal(missing.code, 'TARGET_NOT_FOUND');
    assert.equal(calls.claimCodes.length, 1);
  },
  'Webhook_control_red_tests_IR-MCP-003_AC-4': async () => {
    const { service, calls } = await createMcpControlHarness();
    const missing = asRecord(await callObjectMethod(service, 'closeSession', { sessionKey: 'follower-session' }), 'missing close confirmation');
    assert.equal(missing.ok, false);
    assert.equal(missing.code, 'CLOSE_CONFIRMATION_REQUIRED');
    assert.equal(calls.closeLifecycle.length, 0);
  },
  'Webhook_control_red_tests_IR-MCP-003_AC-5': async () => {
    const { service } = await createMcpControlHarness();
    const listed = asRecordArray(await callObjectMethod(service, 'listWebhooks', {}), 'masked control webhooks');
    for (const record of listed) {
      for (const key of ['keyId', 'maskedKey', 'targetSessionKey', 'profileId', 'mode', 'scopes', 'lastUsedAt', 'expiresAt', 'revoked', 'rateLimit']) {
        assert.ok(key in record, `missing webhook list field ${key}`);
      }
      assert.equal('fullKey' in record, false);
      assert.equal('fullUrl' in record, false);
      assert.equal('keyHash' in record, false);
    }
    const routePublicRecord = sanitizeWebhookPublicRecord({
      keyId: 'wh_route',
      keyHash: 'sha256:must-not-leak',
      maskedKey: 'bgwh_****_route',
      fullKey: 'webhook-full-key-route',
      fullUrl: 'https://localhost:2222/webhook?key=webhook-full-key-route',
      scopes: ['mcp:webhook.invoke'],
      revoked: false,
    });
    assert.equal('keyHash' in routePublicRecord, false);
    assert.equal('fullKey' in routePublicRecord, false);
    assert.equal('fullUrl' in routePublicRecord, false);
  },
  'Webhook_control_red_tests_IR-MCP-003_AC-6': async () => {
    const { service } = await createMcpControlHarness();
    const first = asRecord(await callObjectMethod(service, 'createAgentProfile', { displayName: 'Same', command: 'codex' }), 'first duplicate profile');
    const second = asRecord(await callObjectMethod(service, 'createAgentProfile', { displayName: 'Same', command: 'claude' }), 'second duplicate profile');
    const invalid = asRecord(await callObjectMethod(service, 'createAgentProfile', { displayName: 'bad\u0000name', command: 'codex' }), 'invalid displayName');
    assert.notEqual(first.id, second.id);
    assert.equal(invalid.ok, false);
    assert.equal(asRecord(invalid.fieldErrors, 'displayName field errors').displayName !== undefined, true);
  },
  'Webhook_control_red_tests_IR-MCP-003_AC-7': async () => {
    const { service } = await createMcpControlHarness();
    const result = asRecord(await callObjectMethod(service, 'createAgentProfile', {
      displayName: 'Bad',
      command: '',
      kickoffPrompt: 'Bearer raw-token webhook_key=raw-key',
    }), 'redacted profile validation');
    assert.equal(result.ok, false);
    assertNoSecretMaterial(result, ['raw-token', 'raw-key']);
  },
  'Webhook_control_red_tests_IR-MCP-003_AC-8': async () => {
    const { service, calls } = await createWebhookInvocationHarness();
    const result = asRecord(await callObjectMethod(service, 'invokeWebhook', createWebhookInvokeRequest({
      headers: { 'x-buildergate-webhook-key': 'webhook-full-key' },
      query: { prompt: 'from header' },
    })), 'header-only webhook result');
    assert.equal(result.ok, true);
    assert.equal(asRecord(calls.auditEvents[0], 'header webhook audit').credentialKind, 'header');
  },
  'Webhook_control_red_tests_IR-MCP-003_AC-9': async () => {
    const { service } = await createWebhookInvocationHarness();
    const result = asRecord(await callObjectMethod(service, 'invokeWebhook', createWebhookInvokeRequest({
      headers: { 'x-buildergate-webhook-key': 'webhook-full-key-other' },
      query: { key: 'webhook-full-key', prompt: 'conflict' },
    })), 'query header conflict');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'WEBHOOK_KEY_INVALID');
  },
  'Webhook_control_red_tests_IR-MCP-003_AC-10': async () => {
    const { service, calls } = await createMcpControlHarness();
    const accepted = asRecord(await callObjectMethod(service, 'updateAgentStatus', { sessionKey: 'target-session', agentStatus: 'busy' }), 'control status accepted');
    const rejected = asRecord(await callObjectMethod(service, 'updateAgentStatus', { sessionKey: 'target-session', agentStatus: 'sleeping' }), 'control status rejected');
    const sessionsResult = asRecord(await callObjectMethod(service, 'listSessions', {}), 'status sessions result');
    const sessions = asRecordArray(sessionsResult.sessions, 'status sessions');
    const search = asRecord(await callObjectMethod(service, 'searchSessions', { query: '빌더 게이트' }), 'status search result');
    assert.equal(accepted.ok, true);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.code, 'INVALID_AGENT_STATUS');
    assert.equal(asRecord(calls.updateAgentStatus[0], 'status update call').agentStatus, 'busy');
    assert.equal(sessions.some(session => session.sessionKey === 'target-session' && session.agentStatus === 'busy'), true);
    assert.equal(asRecordArray(search.matches, 'status search matches').some(session => session.sessionKey === 'target-session' && session.agentStatus === 'busy'), true);

    const failedHarness = await createMcpControlHarness({ statusUpdateFails: true });
    const failed = asRecord(await callObjectMethod(failedHarness.service, 'updateAgentStatus', {
      sessionKey: 'target-session',
      agentStatus: 'busy',
    }), 'control status delegated failure');
    const failedSessionsResult = asRecord(await callObjectMethod(failedHarness.service, 'listSessions', {}), 'failed status sessions result');
    const failedSessions = asRecordArray(failedSessionsResult.sessions, 'failed status sessions');
    const failedSearch = asRecord(await callObjectMethod(failedHarness.service, 'searchSessions', { query: 'reviewer' }), 'failed status search result');
    assert.equal(failed.ok, false);
    assert.equal(failed.code, 'STATUS_UPDATE_FAILED');
    assert.equal(asRecord(failedHarness.calls.updateAgentStatus[0], 'failed status update call').agentStatus, 'busy');
    assert.equal(failedSessions.some(session => session.sessionKey === 'target-session' && session.agentStatus === 'busy'), false);
    assert.equal(asRecordArray(failedSearch.matches, 'failed status search matches').some(session => session.sessionKey === 'target-session' && session.agentStatus === 'busy'), false);
  },
  'Webhook_control_red_tests_IR-MCP-004_AC-1': async () => {
    const { service } = await createMcpControlHarness();
    const created = asRecord(await callObjectMethod(service, 'createWebhook', { targetSessionKey: 'target-session' }), 'create full secret surface');
    const rotated = asRecord(await callObjectMethod(service, 'rotateWebhook', { id: String(created.keyId) }), 'rotate full secret surface');
    const revoke = await callObjectMethod(service, 'revokeWebhook', { id: String(created.keyId) });
    const list = await callObjectMethod(service, 'listWebhooks', {});
    const legacyRotated = await callObjectMethod(service, 'rotateWebhook', { id: 'wh_1' });
    const legacyList = await callObjectMethod(service, 'listWebhooks', {});
    assert.equal(typeof created.fullKey, 'string');
    assert.equal(typeof rotated.fullUrl, 'string');
    assertNoSecretMaterial({ revoke, list }, [String(created.fullKey), String(rotated.fullKey), String(created.fullUrl), String(rotated.fullUrl)]);
    assertNoSecretMaterial({ legacyRotated, legacyList }, ['webhook-full-key']);
  },
  'Webhook_control_red_tests_IR-MCP-004_AC-2': async () => {
    const { service } = await createWebhookInvocationHarness();
    const defaults = asRecord(await callObjectMethod(service, 'getWebhookConfig', {}), 'webhook config defaults');
    const valid = asRecord(await callObjectMethod(service, 'setWebhookConfig', { webhookKeyHeaderName: 'X-Custom-Webhook-Key' }), 'valid webhook config');
    const validRateLimit = asRecord(await callObjectMethod(service, 'setWebhookConfig', {
      webhookKeyHeaderName: 'X-Custom-Webhook-Key',
      rateLimit: { windowSeconds: 30, burstLimit: 4 },
    }), 'valid webhook rate limit config');
    const invalidRateLimit = asRecord(await callObjectMethod(service, 'setWebhookConfig', {
      webhookKeyHeaderName: 'X-Custom-Webhook-Key',
      rateLimit: { windowSeconds: 0, burstLimit: 4 },
    }), 'invalid webhook rate limit config');
    const invalid = asRecord(await callObjectMethod(service, 'setWebhookConfig', { webhookKeyHeaderName: 'Authorization' }), 'invalid webhook config');
    const blank = asRecord(await callObjectMethod(service, 'setWebhookConfig', { webhookKeyHeaderName: '' }), 'blank webhook config');
    const whitespace = asRecord(await callObjectMethod(service, 'setWebhookConfig', { webhookKeyHeaderName: '   ' }), 'whitespace webhook config');
    assert.equal(defaults.webhookKeyHeaderName, 'X-BuilderGate-Webhook-Key');
    assert.deepEqual(defaults.rateLimit, { windowSeconds: 60, burstLimit: 10 });
    assert.equal(valid.webhookKeyHeaderName, 'X-Custom-Webhook-Key');
    assert.deepEqual(validRateLimit.rateLimit, { windowSeconds: 30, burstLimit: 4 });
    assert.equal(invalidRateLimit.ok, false);
    assert.equal(invalidRateLimit.code, 'WEBHOOK_RATE_LIMIT_INVALID');
    assert.equal(invalid.ok, false);
    assert.equal(invalid.code, 'WEBHOOK_HEADER_FORBIDDEN');
    assert.equal(blank.ok, false);
    assert.equal(blank.code, 'WEBHOOK_HEADER_FORBIDDEN');
    assert.equal(whitespace.ok, false);
    assert.equal(whitespace.code, 'WEBHOOK_HEADER_FORBIDDEN');

    const customHarness = await createWebhookInvocationHarness({ webhookKeyHeaderName: 'X-Custom-Webhook-Key' });
    const defaultHeader = asRecord(await callObjectMethod(customHarness.service, 'invokeWebhook', createWebhookInvokeRequest({
      headers: { 'x-buildergate-webhook-key': 'webhook-full-key' },
      query: { prompt: 'default header should fail' },
    })), 'default header after custom config result');
    const customHeader = asRecord(await callObjectMethod(customHarness.service, 'invokeWebhook', createWebhookInvokeRequest({
      headers: { 'x-custom-webhook-key': 'webhook-full-key' },
      query: { prompt: 'custom header should pass' },
    })), 'custom header after config result');
    assert.equal(defaultHeader.ok, false);
    assert.equal(defaultHeader.code, 'WEBHOOK_KEY_INVALID');
    assert.equal(customHeader.ok, true);
    assert.equal(asRecord(customHarness.calls.auditEvents.at(-1), 'custom header audit').credentialKind, 'header');

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'buildergate-mcp-control-config-'));
    try {
      const store = createMcpControlConfigFileStore({ dataPath: path.join(tmpDir, 'mcp-control-config.json') });
      const saved = asRecord(await callObjectMethod(store, 'saveConfig', {
        enabled: true,
        bindMode: 'whitelist',
        bindHost: '0.0.0.0',
        host: '0.0.0.0',
        port: 4444,
        transportSecurity: 'trusted_tls_proxy',
        trustedProxies: ['10.0.0.1/32'],
        externalWhitelist: ['203.0.113.7/32'],
        allowedOrigins: ['https://localhost:2222'],
        webhookKeyHeaderName: 'X-Custom-Webhook-Key',
        webhookRateLimit: { windowSeconds: 30, burstLimit: 4 },
      }), 'mcp control config save result');
      const loaded = asRecord(await callObjectMethod(store, 'loadConfig', {}), 'mcp control config load result');
      assert.equal(saved.ok, true);
      assert.equal(loaded.bindMode, 'whitelist');
      assert.equal(loaded.host, '0.0.0.0');
      assert.equal(loaded.bindHost, '0.0.0.0');
      assert.equal(loaded.port, 4444);
      assert.deepEqual(loaded.trustedProxies, ['10.0.0.1/32']);
      assert.deepEqual(loaded.externalWhitelist, ['203.0.113.7/32']);
      assert.deepEqual(loaded.allowedOrigins, ['https://localhost:2222']);
      assert.equal(loaded.webhookKeyHeaderName, 'X-Custom-Webhook-Key');
      assert.deepEqual(loaded.webhookRateLimit, { windowSeconds: 30, burstLimit: 4 });

      const invalidPersistedWarnings: Record<string, unknown>[] = [];
      const fallback = mergeStoredMcpControlConfig({
        enabled: true,
        bindMode: 'loopback',
        host: '127.0.0.1',
        bindHost: '127.0.0.1',
        port: 3333,
        transportSecurity: 'none',
        trustedProxies: [],
        externalWhitelist: [],
        allowedOrigins: [],
      }, {
        enabled: true,
        bindMode: 'whitelist',
        host: '0.0.0.0',
        bindHost: '0.0.0.0',
        port: 4444,
        transportSecurity: 'none',
        externalWhitelist: ['not-a-cidr'],
        allowedOrigins: ['https://localhost:2222/'],
        webhookKeyHeaderName: 'Authorization',
        webhookRateLimit: { windowSeconds: 0, burstLimit: 0 },
      }, {
        dataPath: path.join(tmpDir, 'mcp-control-config.json'),
        warn: event => invalidPersistedWarnings.push({ ...event }),
      });
      assert.equal(fallback.bindMode, 'loopback');
      assert.equal(fallback.host, '127.0.0.1');
      assert.equal(fallback.bindHost, '127.0.0.1');
      assert.equal(fallback.port, 3333);
      assert.deepEqual(fallback.externalWhitelist, []);
      assert.equal(fallback.webhookKeyHeaderName, 'X-BuilderGate-Webhook-Key');
      assert.deepEqual(fallback.webhookRateLimit, { windowSeconds: 60, burstLimit: 10 });
      assert.equal(invalidPersistedWarnings.length, 1);
      assert.equal(typeof invalidPersistedWarnings[0]?.code, 'string');
      assert.equal(invalidPersistedWarnings[0]?.path, path.join(tmpDir, 'mcp-control-config.json'));

      const malformedConfigPath = path.join(tmpDir, 'malformed-mcp-control-config.json');
      await fs.writeFile(malformedConfigPath, '{ invalid json', 'utf-8');
      const loadWarnings: Record<string, unknown>[] = [];
      const malformedStore = createMcpControlConfigFileStore({
        dataPath: malformedConfigPath,
        warn: event => loadWarnings.push({ ...event }),
      });
      const malformedLoaded = asRecord(await callObjectMethod(malformedStore, 'loadConfig', {}), 'malformed mcp config load fallback');
      assert.deepEqual(malformedLoaded, {});
      assert.equal(loadWarnings.length, 1);
      assert.equal(loadWarnings[0]?.code, 'MCP_CONTROL_CONFIG_LOAD_FAILED');
      assert.equal(loadWarnings[0]?.path, malformedConfigPath);
      assert.equal(typeof loadWarnings[0]?.message, 'string');

      const invalidRateLimitConfigPath = path.join(tmpDir, 'invalid-rate-limit-mcp-control-config.json');
      await fs.writeFile(invalidRateLimitConfigPath, JSON.stringify({
        version: 1,
        config: {
          bindMode: 'loopback',
          host: '127.0.0.1',
          webhookRateLimit: { windowSeconds: 0, burstLimit: 10 },
        },
      }), 'utf-8');
      const invalidRateLimitWarnings: Record<string, unknown>[] = [];
      const invalidRateLimitStore = createMcpControlConfigFileStore({
        dataPath: invalidRateLimitConfigPath,
        warn: event => invalidRateLimitWarnings.push({ ...event }),
      });
      const invalidRateLimitLoaded = asRecord(await callObjectMethod(invalidRateLimitStore, 'loadConfig', {}), 'invalid rate limit mcp config load fallback');
      assert.deepEqual(invalidRateLimitLoaded, {});
      assert.equal(invalidRateLimitWarnings.length, 1);
      assert.equal(invalidRateLimitWarnings[0]?.code, 'WEBHOOK_RATE_LIMIT_INVALID');
      assert.equal(invalidRateLimitWarnings[0]?.path, invalidRateLimitConfigPath);

      const rejectedSave = asRecord(await callObjectMethod(store, 'saveConfig', {
        bindMode: 'whitelist',
        host: '0.0.0.0',
        bindHost: '0.0.0.0',
        port: 4444,
        transportSecurity: 'none',
        externalWhitelist: ['203.0.113.7/32'],
      }), 'invalid mcp control config save result');
      assert.equal(rejectedSave.ok, false);
      assert.equal(rejectedSave.code, 'MCP_TRANSPORT_TLS_REQUIRED');

      const wideOpenRejectedSave = asRecord(await callObjectMethod(store, 'saveConfig', {
        bindMode: 'whitelist',
        host: '0.0.0.0',
        bindHost: '0.0.0.0',
        port: 4444,
        transportSecurity: 'direct_tls',
        externalWhitelist: ['0.0.0.0/0'],
      }), 'wide-open mcp control config save result');
      assert.equal(wideOpenRejectedSave.ok, false);
      assert.equal(wideOpenRejectedSave.code, 'MCP_WHITELIST_DENIED');

      const loopbackWideOpenRejectedSave = asRecord(await callObjectMethod(store, 'saveConfig', {
        bindMode: 'loopback',
        host: '127.0.0.1',
        bindHost: '127.0.0.1',
        externalWhitelist: ['0.0.0.0/00'],
      }), 'loopback wide-open mcp control config save result');
      assert.equal(loopbackWideOpenRejectedSave.ok, false);
      assert.equal(loopbackWideOpenRejectedSave.code, 'MCP_WHITELIST_DENIED');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }

    const controlState: Record<string, unknown> = {
      enabled: true,
      bindMode: 'loopback',
      host: '127.0.0.1',
      port: 3333,
      transportSecurity: 'none',
      trustedProxies: [],
      externalWhitelist: [],
      allowedOrigins: [],
      status: 'listening',
      lastError: null,
      lastRebindResult: null,
    };
    const webhookState: Record<string, unknown> = {
      webhookKeyHeaderName: 'X-BuilderGate-Webhook-Key',
      rateLimit: { windowSeconds: 60, burstLimit: 10 },
    };
    const coordinatorResult = asRecord(await applyMcpControlConfigPatch({
      body: {
        host: '127.0.0.1',
        port: 4444,
        webhookKeyHeaderName: 'X-Custom-Webhook-Key',
        webhookRateLimit: { windowSeconds: 30, burstLimit: 4 },
      },
      controlService: {
        getConfig: () => ({ ...controlState }),
        setConfig: (request: unknown) => {
          Object.assign(controlState, pickControlConfigFields(asRecord(request, 'coordinator control request')));
          return { ok: true, ...controlState };
        },
      },
      webhookService: {
        getWebhookConfig: () => ({ ...webhookState }),
        setWebhookConfig: (request: unknown) => {
          const input = asRecord(request, 'coordinator webhook request');
          if (input.webhookKeyHeaderName !== undefined) webhookState.webhookKeyHeaderName = input.webhookKeyHeaderName;
          if (input.rateLimit !== undefined) webhookState.rateLimit = input.rateLimit;
          return { ok: true, ...webhookState };
        },
      },
      configStore: {
        saveConfig: async () => {
          throw new Error('persist failed');
        },
      },
      validateWebhookHeaderName: validateMcpWebhookKeyHeaderName,
    }), 'mcp control config coordinator persist failure');
    assert.equal(coordinatorResult.ok, false);
    assert.equal(coordinatorResult.code, 'MCP_CONTROL_CONFIG_PERSIST_FAILED');
    assert.equal(controlState.port, 3333);
    assert.equal(webhookState.webhookKeyHeaderName, 'X-BuilderGate-Webhook-Key');
    assert.deepEqual(webhookState.rateLimit, { windowSeconds: 60, burstLimit: 10 });

    let initialSnapshotSetConfigCalls = 0;
    const initialSnapshotFailure = asRecord(await applyMcpControlConfigPatch({
      body: { host: '127.0.0.1', port: 4444 },
      controlService: {
        getConfig: () => ({ ...controlState }),
        setConfig: () => {
          initialSnapshotSetConfigCalls += 1;
          return { ok: true };
        },
      },
      webhookService: {
        getWebhookConfig: () => ({
          ok: false,
          code: 'MCP_CONTROL_WEBHOOK_CONFIG_FAILED',
          message: 'webhook snapshot failed',
          auditId: 'audit-initial-webhook-snapshot',
        }),
        setWebhookConfig: () => ({ ok: true }),
      },
      validateWebhookHeaderName: validateMcpWebhookKeyHeaderName,
    }), 'mcp control coordinator initial webhook snapshot failure');
    assert.equal(initialSnapshotFailure.ok, false);
    assert.equal(initialSnapshotFailure.code, 'MCP_CONTROL_WEBHOOK_CONFIG_FAILED');
    assert.equal(initialSnapshotFailure.auditId, 'audit-initial-webhook-snapshot');
    assert.equal(initialSnapshotSetConfigCalls, 0);

    const finalSnapshotControlState: Record<string, unknown> = {
      enabled: true,
      bindMode: 'loopback',
      host: '127.0.0.1',
      port: 3333,
      transportSecurity: 'none',
      trustedProxies: [],
      externalWhitelist: [],
      allowedOrigins: [],
    };
    const finalSnapshotWebhookState: Record<string, unknown> = {
      webhookKeyHeaderName: 'X-BuilderGate-Webhook-Key',
      rateLimit: { windowSeconds: 60, burstLimit: 10 },
    };
    let finalSnapshotWebhookReads = 0;
    let finalSnapshotPersisted = false;
    const finalSnapshotFailure = asRecord(await applyMcpControlConfigPatch({
      body: { host: '127.0.0.1', port: 4444, webhookKeyHeaderName: 'X-Custom-Webhook-Key' },
      controlService: {
        getConfig: () => ({ ...finalSnapshotControlState }),
        setConfig: (request: unknown) => {
          Object.assign(finalSnapshotControlState, pickControlConfigFields(asRecord(request, 'final snapshot control request')));
          return { ok: true, ...finalSnapshotControlState };
        },
      },
      webhookService: {
        getWebhookConfig: () => {
          finalSnapshotWebhookReads += 1;
          if (finalSnapshotWebhookReads === 1) {
            return { ...finalSnapshotWebhookState };
          }
          return {
            ok: false,
            code: 'MCP_CONTROL_WEBHOOK_CONFIG_FAILED',
            message: 'webhook final snapshot failed',
            auditId: 'audit-final-webhook-snapshot',
          };
        },
        setWebhookConfig: (request: unknown) => {
          const input = asRecord(request, 'final snapshot webhook request');
          if (input.webhookKeyHeaderName !== undefined) finalSnapshotWebhookState.webhookKeyHeaderName = input.webhookKeyHeaderName;
          if (input.rateLimit !== undefined) finalSnapshotWebhookState.rateLimit = input.rateLimit;
          return { ok: true, ...finalSnapshotWebhookState };
        },
      },
      configStore: {
        saveConfig: async () => {
          finalSnapshotPersisted = true;
          return { ok: true };
        },
      },
      validateWebhookHeaderName: validateMcpWebhookKeyHeaderName,
    }), 'mcp control coordinator final webhook snapshot failure');
    assert.equal(finalSnapshotFailure.ok, false);
    assert.equal(finalSnapshotFailure.code, 'MCP_CONTROL_WEBHOOK_CONFIG_FAILED');
    assert.equal(finalSnapshotFailure.auditId, 'audit-final-webhook-snapshot');
    assert.equal(finalSnapshotControlState.port, 3333);
    assert.equal(finalSnapshotWebhookState.webhookKeyHeaderName, 'X-BuilderGate-Webhook-Key');
    assert.equal(finalSnapshotPersisted, false);

    const controlRestoreFailureState: Record<string, unknown> = {
      enabled: true,
      bindMode: 'loopback',
      host: '127.0.0.1',
      port: 3333,
      transportSecurity: 'none',
      trustedProxies: [],
      externalWhitelist: [],
      allowedOrigins: [],
    };
    const webhookAfterControlRestoreFailureState: Record<string, unknown> = {
      webhookKeyHeaderName: 'X-BuilderGate-Webhook-Key',
      rateLimit: { windowSeconds: 60, burstLimit: 10 },
    };
    const controlRestoreFailureResult = asRecord(await applyMcpControlConfigPatch({
      body: {
        host: '127.0.0.1',
        port: 4444,
        webhookKeyHeaderName: 'X-Custom-Webhook-Key',
        webhookRateLimit: { windowSeconds: 30, burstLimit: 4 },
      },
      controlService: {
        getConfig: () => ({ ...controlRestoreFailureState }),
        setConfig: (request: unknown) => {
          const next = pickControlConfigFields(asRecord(request, 'control restore failure request'));
          if (next.port === 3333) {
            return { ok: false, code: 'CONTROL_RESTORE_FAILED', message: 'control rollback failed' };
          }
          Object.assign(controlRestoreFailureState, next);
          return { ok: true, ...controlRestoreFailureState };
        },
      },
      webhookService: {
        getWebhookConfig: () => ({ ...webhookAfterControlRestoreFailureState }),
        setWebhookConfig: (request: unknown) => {
          const input = asRecord(request, 'webhook restore after control failure request');
          if (input.webhookKeyHeaderName !== undefined) webhookAfterControlRestoreFailureState.webhookKeyHeaderName = input.webhookKeyHeaderName;
          if (input.rateLimit !== undefined) webhookAfterControlRestoreFailureState.rateLimit = input.rateLimit;
          return { ok: true, ...webhookAfterControlRestoreFailureState };
        },
      },
      configStore: {
        saveConfig: async () => {
          throw new Error('persist failed');
        },
      },
      validateWebhookHeaderName: validateMcpWebhookKeyHeaderName,
    }), 'mcp control coordinator control rollback failure');
    const controlRollbackErrors = asRecordArray(controlRestoreFailureResult.rollbackErrors, 'control rollback errors');
    assert.equal(controlRestoreFailureResult.ok, false);
    assert.equal(controlRestoreFailureResult.code, 'MCP_CONTROL_CONFIG_PERSIST_FAILED');
    assert.equal(controlRollbackErrors.some(error => error.target === 'control' && error.code === 'CONTROL_RESTORE_FAILED'), true);
    assert.equal(webhookAfterControlRestoreFailureState.webhookKeyHeaderName, 'X-BuilderGate-Webhook-Key');
    assert.deepEqual(webhookAfterControlRestoreFailureState.rateLimit, { windowSeconds: 60, burstLimit: 10 });
    const routeFailure = buildMcpControlRouteFailure(controlRestoreFailureResult, () => 'req_route_failure');
    const routeFailureBody = asRecord(routeFailure.body, 'mcp route failure body');
    assert.equal(routeFailure.status, 400);
    assert.equal(routeFailureBody.code, 'MCP_CONTROL_CONFIG_PERSIST_FAILED');
    assert.equal(routeFailureBody.message, 'persist failed');
    assert.equal(routeFailureBody.requestId, 'req_route_failure');
    assert.equal(
      asRecordArray(routeFailureBody.rollbackErrors, 'route rollback errors')
        .some(error => error.target === 'control' && error.code === 'CONTROL_RESTORE_FAILED'),
      true,
    );

    const webhookRestoreFailureControlState: Record<string, unknown> = {
      enabled: true,
      bindMode: 'loopback',
      host: '127.0.0.1',
      port: 3333,
      transportSecurity: 'none',
      trustedProxies: [],
      externalWhitelist: [],
      allowedOrigins: [],
    };
    const webhookRestoreFailureState: Record<string, unknown> = {
      webhookKeyHeaderName: 'X-BuilderGate-Webhook-Key',
      rateLimit: { windowSeconds: 60, burstLimit: 10 },
    };
    const webhookRestoreFailureResult = asRecord(await applyMcpControlConfigPatch({
      body: {
        host: '127.0.0.1',
        port: 4444,
        webhookKeyHeaderName: 'X-Custom-Webhook-Key',
        webhookRateLimit: { windowSeconds: 30, burstLimit: 4 },
      },
      controlService: {
        getConfig: () => ({ ...webhookRestoreFailureControlState }),
        setConfig: (request: unknown) => {
          Object.assign(webhookRestoreFailureControlState, pickControlConfigFields(asRecord(request, 'webhook restore failure control request')));
          return { ok: true, ...webhookRestoreFailureControlState };
        },
      },
      webhookService: {
        getWebhookConfig: () => ({ ...webhookRestoreFailureState }),
        setWebhookConfig: (request: unknown) => {
          const input = asRecord(request, 'webhook restore failure request');
          if (input.webhookKeyHeaderName === 'X-BuilderGate-Webhook-Key') {
            throw new Error('webhook rollback failed');
          }
          if (input.webhookKeyHeaderName !== undefined) webhookRestoreFailureState.webhookKeyHeaderName = input.webhookKeyHeaderName;
          if (input.rateLimit !== undefined) webhookRestoreFailureState.rateLimit = input.rateLimit;
          return { ok: true, ...webhookRestoreFailureState };
        },
      },
      configStore: {
        saveConfig: async () => {
          throw new Error('persist failed');
        },
      },
      validateWebhookHeaderName: validateMcpWebhookKeyHeaderName,
    }), 'mcp control coordinator webhook rollback failure');
    const webhookRollbackErrors = asRecordArray(webhookRestoreFailureResult.rollbackErrors, 'webhook rollback errors');
    assert.equal(webhookRestoreFailureResult.ok, false);
    assert.equal(webhookRestoreFailureResult.code, 'MCP_CONTROL_CONFIG_PERSIST_FAILED');
    assert.equal(webhookRollbackErrors.some(error => error.target === 'webhook' && error.code === 'MCP_CONTROL_CONFIG_ROLLBACK_FAILED'), true);
    assert.equal(webhookRestoreFailureControlState.port, 3333);
    const aliasRouteFailure = buildMcpControlRouteFailure({
      ok: false,
      code: 'TARGET_NOT_FOUND',
      message: 'alias target missing',
      fieldErrors: { sessionKey: 'not found' },
    }, () => 'req_alias_failure');
    const aliasRouteFailureBody = asRecord(aliasRouteFailure.body, 'alias route failure body');
    assert.equal(aliasRouteFailure.status, 404);
    assert.equal(aliasRouteFailureBody.message, 'alias target missing');
    assert.equal(asRecord(aliasRouteFailureBody.fieldErrors, 'alias route field errors').sessionKey, 'not found');

    const webhookConfigRouteFailureSource = {
      ok: false,
      code: 'MCP_CONTROL_WEBHOOK_CONFIG_FAILED',
      message: 'webhook config unavailable',
      auditId: 'audit-webhook-config',
    };
    assert.equal(isMcpControlRouteFailure(webhookConfigRouteFailureSource), true);
    const webhookConfigRouteFailure = buildMcpControlRouteFailure(webhookConfigRouteFailureSource, () => 'req_webhook_config');
    const webhookConfigRouteFailureBody = asRecord(webhookConfigRouteFailure.body, 'webhook config route failure body');
    assert.equal(webhookConfigRouteFailure.status, 400);
    assert.equal(webhookConfigRouteFailureBody.code, 'MCP_CONTROL_WEBHOOK_CONFIG_FAILED');
    assert.equal(webhookConfigRouteFailureBody.message, 'webhook config unavailable');
    assert.equal(webhookConfigRouteFailureBody.auditId, 'audit-webhook-config');
    assert.equal(webhookConfigRouteFailureBody.requestId, 'audit-webhook-config');

    const webhookListRouteFailureSource = {
      allowed: false,
      code: 'WEBHOOK_KEY_INVALID',
      message: 'webhook list unavailable',
      auditId: 'audit-webhook-list',
    };
    assert.equal(isMcpControlRouteFailure(webhookListRouteFailureSource), true);
    const webhookListRouteFailure = buildMcpControlRouteFailure(webhookListRouteFailureSource, () => 'req_webhook_list');
    const webhookListRouteFailureBody = asRecord(webhookListRouteFailure.body, 'webhook list route failure body');
    assert.equal(webhookListRouteFailure.status, 404);
    assert.equal(webhookListRouteFailureBody.code, 'WEBHOOK_KEY_INVALID');
    assert.equal(webhookListRouteFailureBody.message, 'webhook list unavailable');
    assert.equal(webhookListRouteFailureBody.auditId, 'audit-webhook-list');

    const webhookThrowControlState: Record<string, unknown> = {
      enabled: true,
      bindMode: 'loopback',
      host: '127.0.0.1',
      port: 3333,
      transportSecurity: 'none',
      trustedProxies: [],
      externalWhitelist: [],
      allowedOrigins: [],
    };
    const webhookThrowState: Record<string, unknown> = {
      webhookKeyHeaderName: 'X-BuilderGate-Webhook-Key',
      rateLimit: { windowSeconds: 60, burstLimit: 10 },
    };
    const webhookThrowResult = asRecord(await applyMcpControlConfigPatch({
      body: {
        host: '127.0.0.1',
        port: 4444,
        webhookKeyHeaderName: 'X-Throws-Webhook-Key',
      },
      controlService: {
        getConfig: () => ({ ...webhookThrowControlState }),
        setConfig: (request: unknown) => {
          Object.assign(webhookThrowControlState, pickControlConfigFields(asRecord(request, 'webhook throw control request')));
          return { ok: true, ...webhookThrowControlState };
        },
      },
      webhookService: {
        getWebhookConfig: () => ({ ...webhookThrowState }),
        setWebhookConfig: (request: unknown) => {
          const input = asRecord(request, 'webhook throw config request');
          if (input.webhookKeyHeaderName === 'X-Throws-Webhook-Key') {
            throw new Error('webhook config exploded');
          }
          if (input.webhookKeyHeaderName !== undefined) webhookThrowState.webhookKeyHeaderName = input.webhookKeyHeaderName;
          if (input.rateLimit !== undefined) webhookThrowState.rateLimit = input.rateLimit;
          return { ok: true, ...webhookThrowState };
        },
      },
      validateWebhookHeaderName: validateMcpWebhookKeyHeaderName,
    }), 'mcp control coordinator webhook config throw');
    assert.equal(webhookThrowResult.ok, false);
    assert.equal(webhookThrowResult.code, 'MCP_CONTROL_WEBHOOK_CONFIG_FAILED');
    assert.equal(webhookThrowResult.message, 'webhook config exploded');
    assert.equal(webhookThrowControlState.port, 3333);
    assert.equal(webhookThrowState.webhookKeyHeaderName, 'X-BuilderGate-Webhook-Key');
    const webhookThrowRouteFailure = buildMcpControlRouteFailure(webhookThrowResult, () => 'req_webhook_throw');
    const webhookThrowRouteBody = asRecord(webhookThrowRouteFailure.body, 'webhook throw route failure body');
    assert.equal(webhookThrowRouteBody.message, 'webhook config exploded');
    assert.equal(webhookThrowRouteBody.code, 'MCP_CONTROL_WEBHOOK_CONFIG_FAILED');
  },
  'Webhook_control_red_tests_IR-MCP-004_AC-3': async () => {
    const { service, calls } = await createWebhookInvocationHarness({ rateLimited: true });
    const result = asRecord(await callObjectMethod(service, 'invokeWebhook', createWebhookInvokeRequest()), 'rate limited webhook');
    const status = asRecord(await callObjectMethod(service, 'getWebhookStatus', {}), 'webhook status');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'WEBHOOK_RATE_LIMITED');
    assert.equal(asRecord(calls.rateLimitChecks[0], 'rate limit check').keyId, 'wh_1');
    assert.equal(asRecord(calls.rateLimitChecks[0], 'rate limit check').effectiveClientIp, '127.0.0.1');
    assert.equal(typeof asRecord(status.rateLimit, 'rate limit status').windowSeconds, 'number');
    assert.equal(calls.searchSessions.length, 0);
    assert.equal(calls.openAgent.length, 0);
    assert.equal(calls.deliverMessage.length, 0);
    assert.equal(calls.assignments.length, 0);

    const partition = await createWebhookInvocationHarness({ rateLimitPartition: true });
    await callObjectMethod(partition.service, 'invokeWebhook', createWebhookInvokeRequest({ remoteAddress: '127.0.0.1' }));
    await callObjectMethod(partition.service, 'invokeWebhook', createWebhookInvokeRequest({ remoteAddress: '127.0.0.2' }));
    await callObjectMethod(partition.service, 'invokeWebhook', createWebhookInvokeRequest({ query: { key: 'webhook-full-key-other', prompt: 'other key' } }));
    const partitions = partition.calls.rateLimitChecks.map(call => `${call.keyId}:${call.effectiveClientIp}`);
    assert.equal(new Set(partitions).size >= 3, true);
  },
  'Webhook_control_red_tests_IR-MCP-004_AC-4': async () => {
    const { service } = await createWebhookInvocationHarness({ denialCode: 'MCP_ORIGIN_DENIED' });
    const result = asRecord(await callObjectMethod(service, 'invokeWebhook', createWebhookInvokeRequest()), 'stable webhook denial');
    assert.equal(result.ok, false);
    assert.ok(['WEBHOOK_RATE_LIMITED', 'WEBHOOK_PROMPT_TOO_LARGE', 'MCP_TRANSPORT_DENIED', 'MCP_ORIGIN_DENIED', 'WEBHOOK_KEY_INVALID'].includes(String(result.code)));
    assert.equal(typeof result.auditId, 'string');
    assertNoSecretMaterial(result, ['webhook-full-key']);
  },
  'Webhook_control_red_tests_IR-MCP-004_AC-5': async () => {
    const { service } = await createMcpControlHarness();
    const created = asRecord(await callObjectMethod(service, 'createWebhook', { targetSessionKey: 'target-session' }), 'revoke create');
    const first = asRecord(await callObjectMethod(service, 'revokeWebhook', { id: String(created.keyId) }), 'first revoke');
    const second = asRecord(await callObjectMethod(service, 'revokeWebhook', { id: String(created.keyId) }), 'second revoke');
    const listed = asRecordArray(await callObjectMethod(service, 'listWebhooks', {}), 'revoked list');
    assert.equal(first.revoked, true);
    assert.ok(second.revoked === true || second.code === 'WEBHOOK_KEY_REVOKED');
    assert.equal(listed.some(record => record.keyId === created.keyId && record.revoked === true), true);
  },
  'Webhook_control_red_tests_IR-MCP-004_AC-6': async () => {
    const { service } = await createMcpControlHarness();
    const implicit = asRecord(await callObjectMethod(service, 'listSessions', {}), 'implicit include self sessions');
    const explicit = asRecord(await callObjectMethod(service, 'listSessions', { includeSelf: false, actorSessionKey: 'self-session-key' }), 'explicit exclude self sessions');
    assert.equal(implicit.includeSelf, true);
    assert.equal(asRecordArray(implicit.sessions, 'implicit sessions').some(session => session.sessionKey === 'self-session-key'), true);
    assert.equal(asRecordArray(explicit.sessions, 'explicit sessions').some(session => session.sessionKey === 'self-session-key'), false);
  },
  'Webhook_control_red_tests_IR-MCP-004_AC-7': async () => {
    const { service } = await createMcpControlHarness();
    const role = asRecord(await callObjectMethod(service, 'searchSessions', { query: 'reviewer' }), 'role search');
    const recovery = asRecord(await callObjectMethod(service, 'searchSessions', { query: 'npm test' }), 'recovery search');
    assert.equal(role.allowed, true);
    assert.equal(recovery.allowed, true);
    assert.equal(asRecordArray(role.matches, 'role matches')[0].matchReason, 'role');
    assert.equal(asRecordArray(recovery.matches, 'recovery matches')[0].matchReason, 'recoveryCommand');
  },
  'Webhook_control_red_tests_IR-MCP-004_AC-8': async () => {
    const { service, calls } = await createMcpControlHarness({ deferredCloseFails: true });
    const result = asRecord(await callObjectMethod(service, 'handleDeferredCloseSelfFailure', { sessionKey: 'follower-session', leaderSessionKey: 'leader-session' }), 'deferred close failure');
    assert.equal(result.ok, true);
    assert.equal(result.bindingLifecycle, 'closing-failed');
    assert.equal(calls.replyGateway.length, 1);
    assert.equal(asRecord(calls.replyGateway[0], 'failure notification').source, 'close-self-failure-notification');
  },
  'Webhook_control_red_tests_IR-MCP-004_AC-9': async () => {
    const { service } = await createWebhookInvocationHarness({ replayPending: true });
    const result = asRecord(await callObjectMethod(service, 'invokeWebhook', createWebhookInvokeRequest()), 'webhook replay pending');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'INPUT_REJECTED_REPLAY_PENDING');
  },
  'Webhook_control_red_tests_IR-MCP-004_AC-10': async () => {
    const { service, calls } = await createMcpControlHarness();
    const missing = asRecord(await callObjectMethod(service, 'closeSession', { sessionKey: 'follower-session', confirmClose: true, confirmationNonce: 'nonce-current' }), 'missing expected close key');
    const mismatched = asRecord(await callObjectMethod(service, 'closeSession', { sessionKey: 'follower-session', confirmClose: true, expectedSessionKey: 'other-session', confirmationNonce: 'nonce-current' }), 'mismatched close key');
    const falseConfirm = asRecord(await callObjectMethod(service, 'closeSession', { sessionKey: 'follower-session', confirmClose: false, expectedSessionKey: 'follower-session', confirmationNonce: 'nonce-current' }), 'false close confirmation');
    const staleNonce = asRecord(await callObjectMethod(service, 'closeSession', { sessionKey: 'follower-session', confirmClose: true, expectedSessionKey: 'follower-session', confirmationNonce: 'nonce-stale' }), 'stale close nonce');
    const unknownNonce = asRecord(await callObjectMethod(service, 'closeSession', { sessionKey: 'follower-session', confirmClose: true, expectedSessionKey: 'follower-session', confirmationNonce: 'nonce-unknown' }), 'unknown close nonce');
    assert.equal(missing.ok, false);
    assert.equal(missing.code, 'CLOSE_CONFIRMATION_REQUIRED');
    assert.equal(mismatched.ok, false);
    assert.equal(mismatched.code, 'CLOSE_CONFIRMATION_REQUIRED');
    assert.equal(falseConfirm.ok, false);
    assert.equal(falseConfirm.code, 'CLOSE_CONFIRMATION_REQUIRED');
    assert.equal(staleNonce.ok, false);
    assert.equal(staleNonce.code, 'CLOSE_CONFIRMATION_REQUIRED');
    assert.equal(unknownNonce.ok, false);
    assert.equal(unknownNonce.code, 'CLOSE_CONFIRMATION_REQUIRED');
    assert.equal(calls.closeLifecycle.length, 0);
  },
};

async function loadWebhookInvocationContract(): Promise<WebhookAndControlRestContract> {
  try {
    const modulePath = './services/WebhookInvocationService.js';
    return await import(modulePath) as WebhookAndControlRestContract;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert.fail(`missing webhook/control REST implementation: expected ./services/WebhookInvocationService.js (${message})`);
  }
}

async function loadMcpControlRestContract(): Promise<WebhookAndControlRestContract> {
  try {
    const modulePath = './services/McpControlService.js';
    return await import(modulePath) as WebhookAndControlRestContract;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert.fail(`missing webhook/control REST implementation: expected ./services/McpControlService.js (${message})`);
  }
}

function getWebhookControlFunction(contract: WebhookAndControlRestContract, name: string): (...args: unknown[]) => unknown {
  const value = contract[name];
  assert.equal(typeof value, 'function', `missing webhook/control REST implementation: ${name} must be exported`);
  return value as (...args: unknown[]) => unknown;
}

async function createWebhookInvocationHarness(options: Record<string, unknown> = {}): Promise<{
  service: Record<string, unknown>;
  calls: Record<string, Array<Record<string, unknown>>>;
}> {
  const contract = await loadWebhookInvocationContract();
  const createService = getWebhookControlFunction(contract, 'createWebhookInvocationService');
  const calls: Record<string, Array<Record<string, unknown>>> = {
    auditEvents: [],
    accessLogs: [],
    assignments: [],
    searchSessions: [],
    openAgent: [],
    deliverMessage: [],
    rateLimitChecks: [],
    persistedWebhooks: [],
  };
  const defaultWebhookRecord = {
    keyId: 'wh_1',
    keyHash: 'hash',
    maskedKey: 'bgwh_****_key',
    fullKey: 'webhook-full-key',
    targetSessionKey: options.noTarget === true ? undefined : 'target-session',
    profileId: 'codex-env',
    mode: 'open-or-send',
    scopes: ['mcp:webhook.invoke'],
    revoked: options.revoked === true,
    expiresAt: '2026-07-10T00:00:00.000Z',
  };
  const defaultWebhookRecords = [
    { keyId: 'wh_1', fullKey: 'webhook-full-key' },
    { keyId: 'wh_2', fullKey: 'webhook-full-key-other' },
  ];
  let persistCallCount = 0;
  const service = asRecord(createService({
    now: () => '2026-07-09T05:00:00.000Z',
    webhookRecord: options.webhookRecord === false
      ? undefined
      : Object.prototype.hasOwnProperty.call(options, 'webhookRecord')
        ? asRecord(options.webhookRecord, 'custom webhook record')
        : defaultWebhookRecord,
    webhookRecords: Array.isArray(options.webhookRecords)
      ? options.webhookRecords.map(item => asRecord(item, 'custom webhook record'))
      : defaultWebhookRecords,
    persistWebhookRecords: async (records: Array<Record<string, unknown>>) => {
      calls.persistedWebhooks.push({ records: records.map(record => ({ ...record })) });
      persistCallCount += 1;
      const delayMs = Number(options.persistWebhookRecordsDelayMs ?? 0);
      const delayCount = Number(options.persistWebhookRecordsDelayCount ?? 1);
      if (delayMs > 0 && persistCallCount <= delayCount) {
        await delay(delayMs);
      }
      if (options.persistWebhookRecordsFails === true) {
        throw new Error('persist failed');
      }
      return { ok: true };
    },
    defaultProfile: options.noDefaultProfile === true ? null : { id: 'codex-env', enabled: true },
    webhookKeyHeaderName: options.webhookKeyHeaderName ?? 'X-BuilderGate-Webhook-Key',
    denialCode: options.denialCode,
    rateLimited: options.rateLimited === true,
    rateLimitPartition: options.rateLimitPartition === true,
    replayPending: options.replayPending === true,
    ambiguousTarget: options.ambiguousTarget === true,
    audit: (event: unknown) => calls.auditEvents.push(asRecord(event, 'webhook audit event')),
    accessLog: (event: unknown) => calls.accessLogs.push(asRecord(event, 'webhook access log')),
    recordAssignment: (assignment: unknown) => calls.assignments.push(asRecord(assignment, 'webhook assignment')),
    searchSessions: (request: unknown) => {
      const record = asRecord(request, 'webhook search request');
      calls.searchSessions.push(record);
      if (options.ambiguousTarget === true) {
        return { allowed: false, code: 'AMBIGUOUS_TARGET', candidates: [{ sessionKey: 'a' }, { sessionKey: 'b' }] };
      }
      if (options.ambiguousTargetAllowed === true) {
        return { allowed: true, matches: [{ sessionKey: 'a' }, { sessionKey: 'b' }] };
      }
      return { allowed: true, matches: [{ sessionKey: 'target-session', alias: record.query ?? 'target' }] };
    },
    openAgent: (request: unknown) => {
      calls.openAgent.push(asRecord(request, 'webhook open agent request'));
      if (options.openAgentFails === true) {
        return {
          ok: false,
          code: 'AGENT_PROFILE_NOT_FOUND',
          message: 'agent profile missing',
          details: { profileId: 'codex-env' },
          fieldErrors: { profileId: 'not found' },
          auditId: 'audit-open-agent-provider',
        };
      }
      return { ok: true, sessionKey: 'opened-session' };
    },
    deliverMessage: (request: unknown) => {
      calls.deliverMessage.push(asRecord(request, 'webhook delivery request'));
      if (options.deliveryFails === true) {
        return {
          ok: false,
          accepted: false,
          code: 'TARGET_NOT_LIVE',
          message: 'target is no longer live',
          status: 'failed',
          fieldErrors: { sessionKey: 'not live' },
        };
      }
      return { ok: true, accepted: true, assignmentId: 'assignment-webhook-1' };
    },
    checkRateLimit: (request: unknown) => {
      const record = asRecord(request, 'webhook rate limit request');
      calls.rateLimitChecks.push(record);
      return options.rateLimited === true ? { ok: false, code: 'WEBHOOK_RATE_LIMITED' } : { ok: true };
    },
  }), 'webhook invocation service');
  return { service, calls };
}

async function createMcpControlHarness(options: Record<string, unknown> = {}): Promise<{
  service: Record<string, unknown>;
  calls: Record<string, Array<Record<string, unknown>>>;
}> {
  const contract = await loadMcpControlRestContract();
  const createService = getWebhookControlFunction(contract, 'createMcpControlService');
  const calls: Record<string, Array<Record<string, unknown>>> = {
    searchSessions: [],
    setAlias: [],
    updateAgentStatus: [],
    replyGateway: [],
    closeLifecycle: [],
    profileMutations: [],
    webhookMutations: [],
    mutateConfig: [],
    claimCodes: [],
    fixedAccessKeyRotations: [],
  };
  const rawService = asRecord(createService({
    now: () => '2026-07-09T05:00:00.000Z',
    config: {
      enabled: true,
      bindMode: 'loopback',
      host: '127.0.0.1',
      port: 3333,
      transportSecurity: 'none',
      trustedProxies: [],
      externalWhitelist: [],
      allowedOrigins: [],
      status: 'listening',
      lastError: null,
      lastRebindResult: null,
    },
    ...(options.internalCloseConfirmation === true ? {} : {
      currentConfirmationNonce: 'nonce-current',
      validateCloseConfirmation: (request: unknown) => {
        const record = asRecord(request, 'control close confirmation request');
        return record.confirmClose === true
          && record.expectedSessionKey === record.sessionKey
          && record.confirmationNonce === 'nonce-current'
          ? { ok: true }
          : { ok: false, code: 'CLOSE_CONFIRMATION_REQUIRED' };
      },
    }),
    mutateConfig: async (request: unknown) => {
      const record = asRecord(request, 'control config mutation request');
      calls.mutateConfig.push(record);
      if (options.configMutationFails === true) {
        return {
          ok: false,
          code: 'MCP_PORT_REBIND_FAILED',
          lastError: 'bind failed',
          active: { bindHost: '127.0.0.1', port: 3333, listenerStatus: 'listening' },
          persisted: { bindHost: '127.0.0.1', port: 3333 },
        };
      }
      const listenerController = options.listenerController !== null
        && typeof options.listenerController === 'object'
        && !Array.isArray(options.listenerController)
        ? options.listenerController as Record<string, unknown>
        : {};
      if (Object.keys(listenerController).length > 0) {
        const listenerPayload = {
          enabled: record.enabled !== false,
          bindMode: record.bindMode,
          bindHost: record.host ?? record.bindHost ?? '127.0.0.1',
          externalWhitelist: Array.isArray(record.externalWhitelist) ? record.externalWhitelist : [],
          transportSecurity: record.transportSecurity,
          trustedProxies: Array.isArray(record.trustedProxies) ? record.trustedProxies : [],
          allowedOrigins: Array.isArray(record.allowedOrigins) ? record.allowedOrigins : [],
          port: Number(record.port ?? 3333),
        };
        return record.rebindRequested === true
          ? await callMcpListenerController(listenerController, 'rebind', { candidate: listenerPayload })
          : await callMcpListenerController(listenerController, 'updatePolicy', listenerPayload);
      }
      return {
        ok: true,
        active: {
          bindHost: String(record.host ?? '127.0.0.1'),
          port: Number(record.port ?? 3333),
          listenerStatus: 'listening',
        },
      };
    },
    listSessions: options.listSessionsFails === true
      ? () => ({
        allowed: false,
        code: 'TARGET_NOT_FOUND',
        message: 'list target missing',
        reason: 'missing-session',
        candidates: [{ sessionKey: 'candidate-list' }],
      })
      : undefined,
    sessions: [
      {
        sessionKey: 'self-session-key',
        sessionId: 'self-current-session-id',
        currentSessionId: 'self-current-session-id',
        alias: 'self',
        workspaceId: 'workspace-1',
        tabId: 'tab-self',
        agentKind: 'codex',
        agentStatus: 'ready',
        role: 'leader',
        bindingLifecycle: 'live',
        mcpConnected: true,
        leader: true,
        lastSeenAt: '2026-07-09T05:00:00.000Z',
        cwd: 'C:/Work/app',
        recoveryCommand: 'npm test',
      },
      {
        sessionKey: 'target-session',
        sessionId: 'target-current-session-id',
        currentSessionId: 'target-current-session-id',
        alias: '빌더 게이트',
        workspaceId: 'workspace-1',
        tabId: 'tab-target',
        agentKind: 'codex',
        agentStatus: 'waiting_input',
        role: 'reviewer',
        bindingLifecycle: 'live',
        mcpConnected: true,
        leader: false,
        lastSeenAt: '2026-07-09T05:00:00.000Z',
        cwd: 'C:/Work/reviewer',
        recoveryCommand: 'npm test',
        token: 'raw-token',
        hiddenPayload: 'hidden-terminal-payload',
      },
    ],
    webhooks: [
      {
        keyId: 'wh_1',
        maskedKey: 'bgwh_****_key',
        targetSessionKey: 'target-session',
        profileId: 'codex-env',
        mode: 'send-only',
        scopes: ['mcp:webhook.invoke'],
        lastUsedAt: null,
        expiresAt: '2026-07-10T00:00:00.000Z',
        revoked: false,
        rateLimit: { windowSeconds: 60, burstLimit: 10 },
        fullKey: 'webhook-full-key',
      },
    ],
    searchSessions: (request: unknown) => {
      const record = asRecord(request, 'control search request');
      calls.searchSessions.push(record);
      if (options.searchSessionsFails === true) {
        return {
          allowed: false,
          code: 'TARGET_NOT_FOUND',
          message: 'search target missing',
          reason: 'missing-session',
          candidates: [{ sessionKey: 'candidate-search' }],
        };
      }
      return {
        allowed: true,
        matches: [{
          sessionKey: 'target-session',
          sessionId: 'target-current-session-id',
          currentSessionId: 'target-current-session-id',
          alias: '빌더 게이트',
          workspaceId: 'workspace-1',
          tabId: 'tab-target',
          agentKind: 'codex',
          role: 'reviewer',
          bindingLifecycle: 'live',
          mcpConnected: true,
          leader: false,
          lastSeenAt: '2026-07-09T05:00:00.000Z',
          status: 'ready',
          matchReason: record.query === 'npm test' ? 'recoveryCommand' : record.query === 'reviewer' ? 'role' : 'alias',
        }],
      };
    },
    setAlias: (request: unknown) => {
      const record = asRecord(request, 'control alias request');
      calls.setAlias.push(record);
      if (options.aliasThrows === true) {
        const error = new Error('Tab not found');
        (error as Error & { code?: string }).code = 'TAB_NOT_FOUND';
        throw error;
      }
      if (options.aliasFails === true) {
        return {
          allowed: false,
          code: 'TARGET_NOT_FOUND',
          message: 'alias target missing',
          fieldErrors: { sessionKey: 'not found' },
        };
      }
      const result = { ...record, name: record.alias, nameSource: 'user' };
      return options.asyncDeps === true ? Promise.resolve(result) : result;
    },
    updateAgentStatus: (request: unknown) => {
      const record = asRecord(request, 'control status update request');
      calls.updateAgentStatus.push(record);
      if (options.statusUpdateFails === true) {
        return { ok: false, code: 'STATUS_UPDATE_FAILED' };
      }
      return { ok: true, ...record };
    },
    replyGateway: (request: unknown) => {
      const record = asRecord(request, 'control reply gateway request');
      calls.replyGateway.push(record);
      const result = options.replyGatewayFails === true
        ? { accepted: false, code: 'INPUT_REJECTED_REPLAY_PENDING', auditId: 'audit-reply-test' }
        : { accepted: true, auditId: 'audit-reply-test' };
      return options.asyncDeps === true ? Promise.resolve(result) : result;
    },
    closeLifecycle: (request: unknown) => {
      const record = asRecord(request, 'control close lifecycle request');
      calls.closeLifecycle.push(record);
      const result = options.deferredCloseFails === true || options.closeLifecycleFails === true
        ? { ok: false, code: 'TAB_DELETE_FAILED', bindingLifecycle: 'closing-failed' }
        : { ok: true, status: 'closed' };
      return options.asyncDeps === true ? Promise.resolve(result) : result;
    },
    mutateProfile: (request: unknown) => {
      calls.profileMutations.push(asRecord(request, 'profile mutation'));
      return { ok: true };
    },
    mutateWebhook: (request: unknown) => {
      calls.webhookMutations.push(asRecord(request, 'webhook mutation'));
      return { ok: true };
    },
    createSessionClaimCode: (request: unknown) => {
      const record = asRecord(request, 'session claim-code request');
      calls.claimCodes.push(record);
      return { claimCode: `claim_${record.sessionKey}` };
    },
    rotateFixedAccessKey: () => {
      calls.fixedAccessKeyRotations.push({ requestedAt: '2026-07-09T05:00:00.000Z' });
      return options.fixedAccessKeyRotationFails === true
        ? { ok: false, code: 'MCP_CONTROL_CONFIG_PERSIST_FAILED' }
        : { ok: true, accessKey: 'bgmcp_one-time-fixed-access-key' };
    },
  }), 'MCP control service');
  const service = withDefaultControlUiAuth(rawService);
  return { service, calls };
}

async function testMcpFixedAccessKeyControlRotation(): Promise<void> {
  const { service, calls } = await createMcpControlHarness();
  const rotated = asRecord(await callObjectMethod(service, 'rotateFixedAccessKey', {}), 'fixed access key rotation result');
  assert.equal(rotated.ok, true);
  assert.equal(rotated.accessKey, 'bgmcp_one-time-fixed-access-key');
  assert.equal(calls.fixedAccessKeyRotations.length, 1);

  const config = asRecord(await callObjectMethod(service, 'getConfig', {}), 'fixed access key control config');
  assert.equal(config.fixedAccessKeyConfigured, true);
  assert.equal('accessKey' in config, false);

  const denied = asRecord(await callObjectMethod(service, 'rotateFixedAccessKey', {
    auth: { type: 'mcp-capability', token: 'mcp-token' },
  }), 'fixed access key rotation auth denial');
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'CREDENTIAL_BOUNDARY_VIOLATION');
  assert.equal(calls.fixedAccessKeyRotations.length, 1);
}

function withDefaultControlUiAuth(service: Record<string, unknown>): Record<string, unknown> {
  const wrapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(service)) {
    if (typeof value !== 'function') {
      wrapped[key] = value;
      continue;
    }
    wrapped[key] = async (payload: unknown = {}) => {
      const record = payload !== null && typeof payload === 'object' && !Array.isArray(payload)
        ? payload as Record<string, unknown>
        : {};
      const request = Object.prototype.hasOwnProperty.call(record, 'auth')
        ? record
        : { ...record, auth: { type: 'browser-jwt' } };
      return await (value as (...args: unknown[]) => unknown)(request);
    };
  }
  return wrapped;
}

function createWebhookInvokeRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    method: 'GET',
    path: '/webhook/agent',
    url: '/webhook/agent?key=webhook-full-key&prompt=hello',
    remoteAddress: '127.0.0.1',
    headers: {},
    query: { key: 'webhook-full-key', prompt: 'hello' },
    ...overrides,
  };
}

async function loadAgentLifecycleContract(): Promise<AgentLifecycleContract> {
  try {
    const modulePath = './services/AgentLifecycleService.js';
    return await import(modulePath) as AgentLifecycleContract;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert.fail(`missing agent lifecycle implementation: expected ./services/AgentLifecycleService.js (${message})`);
  }
}

function getAgentLifecycleFunction(contract: AgentLifecycleContract, name: string): (...args: unknown[]) => unknown {
  const value = contract[name];
  assert.equal(typeof value, 'function', `missing agent lifecycle implementation: ${name} must be exported`);
  return value as (...args: unknown[]) => unknown;
}

async function createAgentProfileServiceHarness(): Promise<{ service: Record<string, unknown>; cleanup: () => Promise<void> }> {
  const contract = await loadAgentLifecycleContract();
  const createService = getAgentLifecycleFunction(contract, 'createAgentCommandProfileService');
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'buildergate-agent-profiles-'));
  return {
    service: asRecord(createService({ dataPath: path.join(tempDir, 'agent-command-profiles.json') }), 'agent profile service'),
    cleanup: () => fs.rm(tempDir, { recursive: true, force: true }),
  };
}

async function createAgentLifecycleHarness(options: Record<string, unknown> = {}): Promise<{
  service: Record<string, unknown>;
  calls: Record<string, Array<Record<string, unknown>> | string[]>;
}> {
  const contract = await loadAgentLifecycleContract();
  const createService = getAgentLifecycleFunction(contract, 'createMcpAgentLifecycleService');
  const calls: Record<string, Array<Record<string, unknown>> | string[]> = {
    events: [],
    launchContexts: [],
    claimCodes: [],
    gatewayInputs: [],
    registryUpdates: [],
    launchAttempts: [],
    createdTabs: [],
    createdSessions: [],
    deleteTabs: [],
    terminateSessions: [],
    revokedTokens: [],
    tokenMints: [],
    createdConfigFiles: [],
    deletedConfigFiles: [],
    scheduledCloseJobs: [],
    broadcasts: [],
    auditEvents: [],
    cleanupEvidence: [],
  };
  const service = asRecord(createService({
    now: () => '2026-07-09T04:00:00.000Z',
    readinessMode: options.readiness ?? 'ready',
    failAt: options.failAt,
    profiles: {
      getProfile: (profileId: string) => ({
        id: profileId,
        displayName: profileId,
        command: 'codex',
        args: ['--model', 'gpt-5'],
        enabled: true,
        kickoffPrompt: 'Default kickoff',
        mcpClientConfigMode: profileId.includes('manual') ? 'manual' : profileId.includes('generated') ? 'generated-file' : 'env',
      }),
    },
    workspace: {
      preallocateMcpSession: () => {
        (calls.events as string[]).push('preallocate-binding');
        return { sessionKey: '11111111-1111-4111-8111-111111111111', currentSessionId: 'current-session-id' };
      },
      addTabWithLaunchContext: (request: unknown) => {
        (calls.events as string[]).push('create-tab');
        (calls.launchContexts as Array<Record<string, unknown>>).push(asRecord(request, 'launch context request'));
        (calls.createdTabs as Array<Record<string, unknown>>).push({ tabId: 'tab-follower' });
        (calls.events as string[]).push('spawn-pty');
        return { tabId: 'tab-follower', sessionId: 'current-session-id' };
      },
      deleteTab: (request: unknown) => {
        (calls.deleteTabs as Array<Record<string, unknown>>).push(asRecord(request, 'delete tab request'));
        return options.closeFails === true
          ? { ok: false, code: 'TAB_DELETE_FAILED', processTreeCleanupStatus: 'failed' }
          : { ok: true, processTreeCleanupStatus: 'completed' };
      },
      broadcast: (event: unknown) => (calls.broadcasts as Array<Record<string, unknown>>).push(asRecord(event, 'broadcast event')),
    },
    sessionManager: {
      createSession: (request: unknown) => {
        (calls.createdSessions as Array<Record<string, unknown>>).push(asRecord(request, 'create session request'));
        return { id: 'current-session-id' };
      },
      terminateSession: (request: unknown) => (calls.terminateSessions as Array<Record<string, unknown>>).push(asRecord(request, 'terminate session request')),
    },
    inputGateway: {
      submitInput: (request: unknown) => {
        (calls.gatewayInputs as Array<Record<string, unknown>>).push(asRecord(request, 'gateway input'));
        if (options.gatewayFails === true) {
          return { accepted: false, code: 'INPUT_GATEWAY_REJECTED' };
        }
        return { accepted: true, auditId: 'audit-agent-input' };
      },
    },
    tokenStore: {
      mint: (request: unknown) => {
        (calls.events as string[]).push('mint-token');
        (calls.tokenMints as Array<Record<string, unknown>>).push(asRecord(request, 'token mint request'));
        return { token: 'raw-mcp-token-secret' };
      },
      revoke: (request: unknown) => (calls.revokedTokens as Array<Record<string, unknown>>).push(asRecord(request, 'token revoke request')),
    },
    claimCodeStore: {
      create: (request: unknown) => {
        const record = { claimCode: 'claim-code-1', ...asRecord(request, 'claim code request') };
        (calls.claimCodes as Array<Record<string, unknown>>).push(record);
        return record;
      },
    },
    configStore: {
      create: (request: unknown) => {
        const record = { path: 'C:/tmp/buildergate-mcp-client.json', ...asRecord(request, 'config create request') };
        (calls.createdConfigFiles as Array<Record<string, unknown>>).push(record);
        return record;
      },
      delete: (request: unknown) => (calls.deletedConfigFiles as Array<Record<string, unknown>>).push(asRecord(request, 'config delete request')),
    },
    registry: {
      update: (request: unknown) => (calls.registryUpdates as Array<Record<string, unknown>>).push(asRecord(request, 'registry update')),
      getSession: (sessionKey: string) => sessionKey === 'follower-session-key'
        ? { sessionKey, leaderSessionKey: 'leader-session-key' }
        : { sessionKey, leaderSessionKey: null },
    },
    launchAttempts: {
      record: (request: unknown) => {
        (calls.events as string[]).push('record-launch-attempt');
        (calls.launchAttempts as Array<Record<string, unknown>>).push(asRecord(request, 'launch attempt'));
      },
    },
    scheduleClose: (request: unknown) => (calls.scheduledCloseJobs as Array<Record<string, unknown>>).push(asRecord(request, 'scheduled close')),
    audit: (event: unknown) => (calls.auditEvents as Array<Record<string, unknown>>).push(asRecord(event, 'agent lifecycle audit event')),
    recordCleanupEvidence: (event: unknown) => (calls.cleanupEvidence as Array<Record<string, unknown>>).push(asRecord(event, 'cleanup evidence')),
  }), 'agent lifecycle service');
  return { service, calls };
}

function createOpenAgentRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    actor: createMcpActor({ sessionKey: 'leader-session-key' }),
    leaderSessionKey: 'leader-session-key',
    profileId: 'codex-env',
    kickoffPrompt: 'Default kickoff',
    workspaceId: 'workspace-1',
    ...overrides,
  };
}

async function callObjectMethod(target: Record<string, unknown>, method: string, payload: unknown): Promise<unknown> {
  const fn = target[method];
  assert.equal(typeof fn, 'function', `missing agent lifecycle implementation: service.${method} must be a function`);
  return await (fn as (...args: unknown[]) => unknown)(payload);
}

function pickControlConfigFields(input: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of [
    'enabled',
    'bindMode',
    'host',
    'port',
    'transportSecurity',
    'trustedProxies',
    'externalWhitelist',
    'allowedOrigins',
    'status',
    'lastError',
    'lastRebindResult',
  ]) {
    if (Object.prototype.hasOwnProperty.call(input, key)) {
      result[key] = input[key];
    }
  }
  return result;
}

async function loadSessionInputGatewayContract(): Promise<SessionInputGatewayContract> {
  try {
    return await import('./services/SessionInputGateway.js') as SessionInputGatewayContract;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert.fail(`missing input gateway implementation: expected ./services/SessionInputGateway.js (${message})`);
  }
}

function assertInputGatewayContractExports(contract: SessionInputGatewayContract): void {
  assert.equal(typeof contract.createSessionInputGateway, 'function', 'missing input gateway implementation: createSessionInputGateway must be exported');
  assert.equal(contract.INPUT_REJECTED_REPLAY_PENDING, 'INPUT_REJECTED_REPLAY_PENDING');

  const codes = readStringContractArray(contract.INPUT_GATEWAY_DENIAL_CODES, 'INPUT_GATEWAY_DENIAL_CODES');
  for (const code of [
    'INPUT_REJECTED_REPLAY_PENDING',
    'INPUT_REJECTED_ENTER_POLICY',
    'STALE_SESSION_ID',
    'TARGET_NOT_LIVE',
    'AMBIGUOUS_TARGET',
    'WEBHOOK_RATE_LIMITED',
    'WEBHOOK_PROMPT_TOO_LARGE',
    'WEBHOOK_KEY_REVOKED',
    'CLOSE_CONFIRMATION_REQUIRED',
  ]) {
    assert.ok(codes.includes(code), `missing input gateway denial code: ${code}`);
  }

  const sources = readStringContractArray(contract.SESSION_INPUT_GATEWAY_INGRESS_SOURCES, 'SESSION_INPUT_GATEWAY_INGRESS_SOURCES');
  for (const source of requiredInputGatewaySources) {
    assert.ok(sources.includes(source), `missing input gateway ingress source: ${source}`);
  }
}

function readStringContractArray(value: unknown, label: string): string[] {
  if (Array.isArray(value)) {
    return value.map(String);
  }
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).map(String);
  }
  assert.fail(`missing input gateway implementation: ${label} must be exported as an array or enum object`);
}

function createGatewayRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const source = String(overrides.source ?? 'mcp-message-send');
  const base: Record<string, unknown> = {
    source,
    actor: {
      type: source === 'webhook' ? 'webhook' : 'mcp',
      sessionKey: 'actor-session',
      scopes: ['mcp:message.paste', 'mcp:message.submit', 'mcp:webhook.invoke'],
    },
    target: source === 'mcp-reply-to-leader'
      ? { leaderSessionKey: 'leader-session' }
      : { sessionKey: 'target-session', sessionId: 'current-session-id', expectedGeneration: 2 },
    data: 'gateway input',
    delivery: { mode: 'paste', submit: false },
    replayPolicy: 'reject',
    enterPolicy: 'reject-without-submit-scope',
    currentActivity: 'idle',
  };

  return {
    ...base,
    ...overrides,
  };
}

async function runInputGatewayContractScenario(
  scenario: InputGatewayScenario,
  loadedContract?: SessionInputGatewayContract,
): Promise<void> {
  const contract = loadedContract ?? await loadSessionInputGatewayContract();
  assertInputGatewayContractExports(contract);
  const createGateway = contract.createSessionInputGateway as (...args: unknown[]) => unknown;
  const calls = {
    writeInput: [] as Array<Record<string, unknown>>,
    auditInput: [] as Array<Record<string, unknown>>,
    activityTransitions: [] as Array<Record<string, unknown>>,
    lifecycleTransitions: [] as Array<Record<string, unknown>>,
  };
  const gateway = asRecord(createGateway({
    writeInput: (write: unknown) => {
      calls.writeInput.push(asRecord(write, 'input gateway low-level write'));
      return { ok: true };
    },
    auditInput: (event: unknown) => {
      calls.auditInput.push(asRecord(event, 'input gateway audit event'));
    },
    transitionSessionActivity: (event: unknown) => {
      calls.activityTransitions.push(asRecord(event, 'input gateway activity transition'));
    },
    transitionLifecycle: (event: unknown) => {
      calls.lifecycleTransitions.push(asRecord(event, 'input gateway lifecycle transition'));
    },
    resolveTarget: (request: unknown) => resolveInputGatewayTarget(request, scenario),
    resolveLeader: () => scenario.leader === null
      ? { ok: false, code: 'TARGET_NOT_LIVE' }
      : {
          ok: true,
          binding: scenario.leader ?? {
            sessionKey: 'leader-session',
            currentSessionId: 'leader-current-session-id',
            generation: 1,
            lifecycle: 'live',
            hidden: false,
          },
        },
    readReplayState: () => ({
      replayPending: scenario.replayPending === true,
      screenRepairPending: scenario.screenRepairPending === true,
    }),
    evaluateInputPolicy: () => scenario.policyDenialCode
      ? { ok: false, code: scenario.policyDenialCode }
      : { ok: true },
  }), 'SessionInputGateway instance');

  const submitInput = gateway.submitInput;
  assert.equal(typeof submitInput, 'function', 'missing input gateway implementation: gateway.submitInput must be a function');
  const result = asRecord(await (submitInput as (...args: unknown[]) => unknown)(scenario.request), 'SessionInputGateway submit result');

  assert.equal(result.accepted, scenario.expected.accepted);
  assert.equal(result.code ?? null, scenario.expected.code ?? null);
  assert.equal(calls.writeInput.length, scenario.expected.writes);
  if (scenario.expected.message !== undefined) {
    assert.equal(result.message, scenario.expected.message);
  }
  if (scenario.expected.details !== undefined) {
    assert.deepEqual(asRecord(result.details, 'input gateway failure details'), scenario.expected.details);
  }
  if (scenario.expected.fieldErrors !== undefined) {
    assert.deepEqual(asRecord(result.fieldErrors, 'input gateway failure field errors'), scenario.expected.fieldErrors);
  }

  if (scenario.expected.targetSessionKey !== undefined && calls.writeInput.length > 0) {
    assert.equal(calls.writeInput[0].sessionKey ?? calls.writeInput[0].targetSessionKey, scenario.expected.targetSessionKey);
  }
  if (scenario.expected.sessionActivityAfter !== undefined) {
    assert.equal(result.sessionActivityAfter, scenario.expected.sessionActivityAfter);
    assert.equal(calls.activityTransitions.some((event) => event.to === 'running' || event.status === 'running'), false);
  }
  if (scenario.expected.followerLifecycleAfter !== undefined) {
    assert.equal(result.followerLifecycleAfter, scenario.expected.followerLifecycleAfter);
  }
  if (scenario.expected.requiresIncludeSelf === true) {
    assert.equal(result.includeSelf, true);
  }
  if (scenario.expected.requiresAuditEvent === true) {
    assert.ok(calls.auditInput.length > 0 || result.auditId !== undefined, 'input gateway must expose an audit hook or auditId');
  }
  if (scenario.expected.requiresNoSecrets !== undefined) {
    assertNoSecretMaterial({
      result,
      auditInput: calls.auditInput,
      writeMetadata: calls.writeInput.map((write) => {
        const metadata = { ...write };
        delete metadata.data;
        return metadata;
      }),
    }, scenario.expected.requiresNoSecrets);
  }
}

function resolveInputGatewayTarget(request: unknown, scenario: InputGatewayScenario): Record<string, unknown> {
  if (scenario.target?.ambiguousCandidates !== undefined) {
    return { ok: false, code: 'AMBIGUOUS_TARGET', candidates: scenario.target.ambiguousCandidates };
  }

  const requestRecord = asRecord(request, 'input gateway target request');
  const target = asRecord(requestRecord.target ?? {}, 'input gateway request target');
  const binding: Record<string, unknown> = {
    sessionKey: 'target-session',
    currentSessionId: 'current-session-id',
    generation: 2,
    lifecycle: 'live',
    hidden: false,
    agentStatus: 'waiting_input',
    ...scenario.target,
  };

  if (target.leaderSessionKey !== undefined) {
    return {
      ok: true,
      binding: {
        sessionKey: String(target.leaderSessionKey),
        currentSessionId: 'leader-current-session-id',
        generation: 1,
        lifecycle: 'live',
        hidden: false,
      },
    };
  }
  if (binding.agentStatus === 'arbitrary') {
    return { ok: false, code: 'INVALID_AGENT_STATUS' };
  }
  if (binding.lifecycle !== 'live') {
    return { ok: false, code: 'TARGET_NOT_LIVE', ...pickScenarioFailureFields(binding) };
  }
  if (binding.hidden === true) {
    return { ok: false, code: 'TARGET_NOT_LIVE', ...pickScenarioFailureFields(binding) };
  }
  if (target.expectedGeneration !== undefined && target.expectedGeneration !== binding.generation) {
    return { ok: false, code: 'STALE_SESSION_ID' };
  }
  if (target.sessionId !== undefined && target.sessionId !== binding.currentSessionId) {
    return { ok: false, code: 'STALE_SESSION_ID' };
  }

  return {
    ok: true,
    binding,
  };
}

function pickScenarioFailureFields(source: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of ['message', 'details', 'fieldErrors']) {
    if (source[key] !== undefined) {
      result[key] = source[key];
    }
  }
  return result;
}

async function createValidMcpCredential(
  sessionKey = 'sess_A',
  scopes: readonly string[] = expectedDefaultMcpScopes,
): Promise<{ type: 'mcp-capability'; token: string }> {
  const tokenResult = asRecord(await callMcpSecurityContract('mintMcpCapabilityToken', {
    audience: 'buildergate-mcp',
    scopes: [...scopes],
    sessionKey,
    expiresInSeconds: 60,
  }), 'MCP token mint result');
  assert.equal(typeof tokenResult.token, 'string');
  return {
    type: 'mcp-capability',
    token: String(tokenResult.token),
  };
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  return value as Record<string, unknown>;
}

function asRecordArray(value: unknown, label: string): Array<Record<string, unknown>> {
  assert.equal(Array.isArray(value), true, `${label} must be an array`);
  return (value as unknown[]).map((item, index) => asRecord(item, `${label}[${index}]`));
}

function createMcpRegistryFixture(): Array<Record<string, unknown>> {
  return [
    {
      sessionKey: 'sess_alpha',
      currentSessionId: '550e8400-e29b-41d4-a716-446655440000',
      previousSessionIds: [],
      tabId: 'tab-alpha',
      workspaceId: 'ws-1',
      alias: 'api',
      aliasSource: 'user',
      cwd: 'C:/Work/api',
      lifecycleState: 'active',
      sortOrder: 0,
    },
    {
      sessionKey: 'sess_beta',
      currentSessionId: '6ba7b811-9dad-41d1-80b4-00c04fd430c8',
      previousSessionIds: [],
      tabId: 'tab-beta',
      workspaceId: 'ws-1',
      alias: 'api worker',
      aliasSource: 'user',
      cwd: 'C:/Work/api-worker',
      lifecycleState: 'active',
      sortOrder: 1,
    },
    {
      sessionKey: 'sess_gamma',
      currentSessionId: '6ba7b812-9dad-41d1-80b4-00c04fd430c8',
      previousSessionIds: [],
      tabId: 'tab-gamma',
      workspaceId: 'ws-1',
      alias: 'logs',
      aliasSource: 'default',
      cwd: 'C:/Work/logs',
      lifecycleState: 'active',
      sortOrder: 2,
    },
  ];
}

function assertMcpDenied(value: unknown, expectedCode: string): Record<string, unknown> {
  const result = asRecord(value, 'MCP denial result');
  assert.equal(result.allowed, false);
  assert.equal(result.code, expectedCode);
  return result;
}

function assertMcpAccepted(value: unknown): Record<string, unknown> {
  const result = asRecord(value, 'MCP acceptance result');
  assert.equal(result.allowed, true);
  assert.equal(result.code ?? null, null);
  return result;
}

function assertNoSecretMaterial(value: unknown, secrets: string[]): void {
  const serialized = JSON.stringify(value);
  for (const secret of secrets) {
    assert.equal(serialized.includes(secret), false, `secret material leaked: ${secret}`);
  }
}

function readDenialCodes(contract: McpSecurityContract): string[] {
  const raw = contract.MCP_DENIAL_CODES;
  if (Array.isArray(raw)) {
    return raw.map(String);
  }
  if (raw !== null && typeof raw === 'object') {
    return Object.values(raw as Record<string, unknown>).map(String);
  }
  assert.fail('missing MCP implementation: MCP_DENIAL_CODES must be exported');
}

async function testMcpRegistryFrMcp001Ac1(): Promise<void> {
  const currentSessionId = '550e8400-e29b-41d4-a716-446655440000';
  const binding = asRecord(await callMcpSessionRegistryContract('createMcpSessionBinding', {
    tab: {
      id: 'tab-alpha',
      workspaceId: 'ws-1',
      sessionId: currentSessionId,
      name: 'Build Agent',
      nameSource: 'user',
    },
    now: '2026-07-09T00:00:00.000Z',
  }), 'MCP session binding');

  assert.equal(typeof binding.sessionKey, 'string');
  assert.notEqual(binding.sessionKey, '');
  assert.notEqual(binding.sessionKey, currentSessionId);
  assert.equal(binding.currentSessionId, currentSessionId);
  assert.match(String(binding.currentSessionId), uuidV4Pattern);
  assert.equal(binding.tabId, 'tab-alpha');
  assert.equal(binding.workspaceId, 'ws-1');
  assert.equal(binding.alias, 'Build Agent');
  assert.equal(binding.generation, 1);
}

async function testMcpRegistryFrMcp001Ac2(): Promise<void> {
  const previousSessionId = '550e8400-e29b-41d4-a716-446655440000';
  const nextSessionId = '6ba7b810-9dad-41d1-80b4-00c04fd430c8';
  const updated = asRecord(await callMcpSessionRegistryContract('updateCurrentSessionIdGeneration', {
    binding: {
      sessionKey: 'sess_tab_alpha',
      currentSessionId: previousSessionId,
      previousSessionIds: [],
      generation: 1,
      tabId: 'tab-alpha',
    },
    nextSessionId,
    reason: 'tab-restart',
    now: '2026-07-09T00:01:00.000Z',
  }), 'MCP updated session generation');

  assert.equal(updated.sessionKey, 'sess_tab_alpha');
  assert.equal(updated.currentSessionId, nextSessionId);
  assert.match(String(updated.currentSessionId), uuidV4Pattern);
  assert.deepEqual(updated.previousSessionIds, [previousSessionId]);
  assert.equal(updated.generation, 2);
  assert.equal(updated.generationReason, 'tab-restart');
}

async function testMcpRegistryFrMcp001Ac3(): Promise<void> {
  const result = asRecord(await callMcpSessionRegistryContract('resolveMcpSessionTarget', {
    actorSessionKey: 'sess_actor',
    target: {
      sessionKey: 'sess_tab_alpha',
      sessionId: '550e8400-e29b-41d4-a716-446655440000',
    },
    registry: [{
      sessionKey: 'sess_tab_alpha',
      currentSessionId: '6ba7b810-9dad-41d1-80b4-00c04fd430c8',
      previousSessionIds: ['550e8400-e29b-41d4-a716-446655440000'],
      lifecycleState: 'active',
    }],
  }), 'MCP stale target resolution');

  assert.equal(result.allowed, false);
  assert.equal(result.code, 'STALE_SESSION_ID');
  assert.equal(result.sessionKey, 'sess_tab_alpha');
  assert.equal(result.currentSessionId, '6ba7b810-9dad-41d1-80b4-00c04fd430c8');
}

async function testMcpRegistryFrMcp001Ac4(): Promise<void> {
  const result = asRecord(await callMcpSessionRegistryContract('resolveMcpSessionTarget', {
    actorSessionKey: 'sess_actor',
    target: {
      sessionKey: 'sess_tab_alpha',
      sessionId: '6ba7b810-9dad-41d1-80b4-00c04fd430c8',
    },
    registry: [{
      sessionKey: 'sess_tab_alpha',
      currentSessionId: '6ba7b810-9dad-41d1-80b4-00c04fd430c8',
      previousSessionIds: ['550e8400-e29b-41d4-a716-446655440000'],
      lifecycleState: 'active',
    }],
  }), 'MCP current target resolution');

  assert.equal(result.allowed, true);
  assert.equal(result.code ?? null, null);
  assert.equal(result.sessionKey, 'sess_tab_alpha');
  assert.equal(result.currentSessionId, '6ba7b810-9dad-41d1-80b4-00c04fd430c8');
}

async function testMcpRegistryFrMcp001Ac5(): Promise<void> {
  const recovered = asRecord(await callMcpSessionRegistryContract('reconcileMcpSessionRegistry', {
    reason: 'orphan-recovery',
    workspaceTabs: [{
      id: 'tab-alpha',
      workspaceId: 'ws-1',
      sessionKey: 'sess_tab_alpha',
      sessionId: '550e8400-e29b-41d4-a716-446655440000',
      name: 'Build Agent',
      nameSource: 'user',
      lifecycleState: 'active',
    }],
    liveSessions: [{
      tabId: 'tab-alpha',
      sessionId: '6ba7b810-9dad-41d1-80b4-00c04fd430c8',
    }],
    now: '2026-07-09T00:02:00.000Z',
  }), 'MCP orphan recovery reconcile');
  const bindings = asRecordArray(recovered.bindings, 'MCP orphan recovery bindings');
  const binding = asRecord(bindings[0], 'MCP orphan recovery binding');

  assert.equal(binding.sessionKey, 'sess_tab_alpha');
  assert.equal(binding.currentSessionId, '6ba7b810-9dad-41d1-80b4-00c04fd430c8');
  assert.match(String(binding.currentSessionId), uuidV4Pattern);
  assert.deepEqual(binding.previousSessionIds, ['550e8400-e29b-41d4-a716-446655440000']);
  assert.equal(binding.generationReason, 'orphan-recovery');
}

async function testMcpRegistryFrMcp001Ac6(): Promise<void> {
  const reconciled = asRecord(await callMcpSessionRegistryContract('reconcileMcpSessionRegistry', {
    reason: 'startup',
    workspaceTabs: [
      {
        id: 'tab-alpha',
        workspaceId: 'ws-1',
        sessionKey: 'sess_tab_alpha',
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        name: 'Build Agent',
        nameSource: 'user',
        lifecycleState: 'active',
      },
      {
        id: 'tab-stopped',
        workspaceId: 'ws-1',
        sessionKey: 'sess_tab_stopped',
        sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        name: 'Stopped Agent',
        nameSource: 'user',
        lifecycleState: 'stopped',
      },
    ],
    liveSessions: [{
      tabId: 'tab-alpha',
      sessionId: '550e8400-e29b-41d4-a716-446655440000',
    }],
    now: '2026-07-09T00:03:00.000Z',
  }), 'MCP startup reconcile');
  const bindings = asRecordArray(reconciled.bindings, 'MCP startup bindings');

  assert.deepEqual(bindings.map(binding => binding.sessionKey), ['sess_tab_alpha']);
  assert.equal(bindings[0].currentSessionId, '550e8400-e29b-41d4-a716-446655440000');
  assert.equal(reconciled.removedStaleBindings, 1);
}

async function testMcpRegistryFrMcp001Ac7(): Promise<void> {
  const result = asRecord(await callMcpSessionRegistryContract('backfillLegacyWorkspaceTabs', {
    workspaceTabs: [{
      id: 'tab-legacy',
      workspaceId: 'ws-1',
      sessionId: '550e8400-e29b-41d4-a716-446655440000',
      name: 'Legacy Agent',
      nameSource: 'default',
      lifecycleState: 'active',
    }],
    now: '2026-07-09T00:04:00.000Z',
  }), 'MCP legacy tab backfill');
  const tabs = asRecordArray(result.tabs, 'MCP backfilled tabs');
  const tab = asRecord(tabs[0], 'MCP backfilled tab');

  assert.equal(typeof tab.sessionKey, 'string');
  assert.notEqual(tab.sessionKey, '');
  assert.equal(tab.currentSessionId, '550e8400-e29b-41d4-a716-446655440000');
  assert.match(String(tab.currentSessionId), uuidV4Pattern);
  assert.equal(result.changed, true);

  const reserved = asRecord(await callMcpSessionRegistryContract('backfillLegacyWorkspaceTabs', {
    workspaceTabs: [
      {
        id: 'tab-beta',
        workspaceId: 'ws-1',
        sessionId: '6ba7b811-9dad-41d1-80b4-00c04fd430c8',
        name: 'Active Legacy',
        nameSource: 'default',
        lifecycleState: 'active',
        sortOrder: 0,
      },
      {
        id: 'tab-stopped',
        workspaceId: 'ws-1',
        sessionKey: 'sess_tab_beta',
        sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        name: 'Stopped Owner',
        nameSource: 'user',
        lifecycleState: 'stopped',
        sortOrder: 1,
      },
    ],
    now: '2026-07-09T00:04:30.000Z',
  }), 'MCP legacy tab backfill reserved keys');
  const reservedTabs = asRecordArray(reserved.tabs, 'MCP reserved-key backfilled tabs');

  assert.notEqual(reservedTabs[0].sessionKey, 'sess_tab_beta');
  assert.equal(reservedTabs[1].sessionKey, 'sess_tab_beta');
  assert.equal(new Set(reservedTabs.map(item => item.sessionKey)).size, 2);
}

async function testMcpRegistryFrMcp006Ac6(): Promise<void> {
  const reconciled = asRecord(await callMcpSessionRegistryContract('reconcileMcpSessionRegistry', {
    reason: 'startup',
    workspaceTabs: [
      {
        id: 'tab-stopped',
        workspaceId: 'ws-1',
        sessionKey: 'sess_tab_beta',
        sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        name: 'Stopped Owner',
        nameSource: 'user',
        lifecycleState: 'stopped',
        sortOrder: 0,
      },
      {
        id: 'tab-alpha',
        workspaceId: 'ws-1',
        sessionKey: 'sess_duplicate',
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        name: 'Primary',
        nameSource: 'user',
        lifecycleState: 'active',
        sortOrder: 1,
      },
      {
        id: 'tab-beta',
        workspaceId: 'ws-1',
        sessionKey: 'sess_duplicate',
        sessionId: '6ba7b811-9dad-41d1-80b4-00c04fd430c8',
        name: 'Duplicate',
        nameSource: 'user',
        lifecycleState: 'active',
        sortOrder: 2,
      },
    ],
    liveSessions: [
      { tabId: 'tab-alpha', sessionId: '550e8400-e29b-41d4-a716-446655440000' },
      { tabId: 'tab-beta', sessionId: '6ba7b811-9dad-41d1-80b4-00c04fd430c8' },
    ],
    now: '2026-07-09T00:05:00.000Z',
  }), 'MCP startup duplicate key reconcile');
  const bindings = asRecordArray(reconciled.bindings, 'MCP duplicate key bindings');
  const tabs = asRecordArray(reconciled.tabs, 'MCP duplicate key tabs');

  assert.equal(bindings[0].sessionKey, 'sess_duplicate');
  assert.equal(tabs[0].sessionKey, 'sess_duplicate');
  assert.notEqual(bindings[1].sessionKey, 'sess_duplicate');
  assert.notEqual(bindings[1].sessionKey, 'sess_tab_beta');
  assert.equal(tabs[1].sessionKey, bindings[1].sessionKey);
  assert.equal(new Set(bindings.map(binding => binding.sessionKey)).size, 2);
}

async function testMcpAliasFrMcp006Ac1(): Promise<void> {
  const result = asRecord(await callMcpSessionRegistryContract('listMcpSessions', {
    actorSessionKey: 'sess_alpha',
    includeSelf: false,
    registry: createMcpRegistryFixture(),
  }), 'MCP session list');
  const sessions = asRecordArray(result.sessions, 'MCP session list items');

  assert.equal(sessions.some(session => session.sessionKey === 'sess_alpha'), false);
  assert.deepEqual(sessions.map(session => session.sessionKey), ['sess_beta', 'sess_gamma']);
}

async function testMcpAliasFrMcp006Ac2(): Promise<void> {
  const result = asRecord(await callMcpSessionRegistryContract('listMcpSessions', {
    actorSessionKey: 'sess_alpha',
    includeSelf: true,
    registry: createMcpRegistryFixture(),
  }), 'MCP session list include self');
  const sessions = asRecordArray(result.sessions, 'MCP session list include self items');

  assert.deepEqual(sessions.map(session => session.sessionKey), ['sess_alpha', 'sess_beta', 'sess_gamma']);
  assert.equal(sessions[0].isSelf, true);
}

async function testMcpAliasFrMcp006Ac3(): Promise<void> {
  const result = asRecord(await callMcpSessionRegistryContract('listMcpSessions', {
    actorSessionKey: 'sess_beta',
    includeSelf: false,
    registry: createMcpRegistryFixture(),
  }), 'MCP session list aliases');
  const sessions = asRecordArray(result.sessions, 'MCP session alias items');
  const alpha = asRecord(sessions.find(session => session.sessionKey === 'sess_alpha'), 'alpha MCP session');

  assert.equal(alpha.alias, 'api');
  assert.equal(alpha.aliasSource, 'user');
  assert.equal(alpha.nameSource, 'user');
  assert.equal(alpha.sessionId, '550e8400-e29b-41d4-a716-446655440000');
  assert.equal(alpha.currentSessionId, '550e8400-e29b-41d4-a716-446655440000');
  assert.equal(alpha.workspaceId, 'ws-1');
  assert.equal(alpha.tabId, 'tab-alpha');
  assert.equal(alpha.agentKind, 'terminal');
  assert.equal(alpha.agentStatus, 'unknown');
  assert.equal(alpha.bindingLifecycle, 'live');
  assert.equal(alpha.mcpConnected, false);
  assert.equal(alpha.leaderSessionKey, null);
}

async function testMcpAliasFrMcp006Ac4(): Promise<void> {
  const result = asRecord(await callMcpSessionRegistryContract('searchMcpSessions', {
    actorSessionKey: 'sess_gamma',
    query: 'api',
    includeSelf: false,
    registry: createMcpRegistryFixture(),
  }), 'MCP session search');
  const matches = asRecordArray(result.matches, 'MCP session search matches');

  assert.deepEqual(matches.map(match => match.sessionKey), ['sess_alpha', 'sess_beta']);
  assert.equal(matches[0].alias, 'api');
  assert.equal(matches[0].matchType, 'exact-alias');
  assert.equal(matches[1].matchType, 'partial-alias');
  assert.ok(Number(matches[0].score) > Number(matches[1].score));
}

async function testMcpAliasFrMcp001Ac7SearchRanking(): Promise<void> {
  const result = asRecord(await callMcpSessionRegistryContract('searchMcpSessions', {
    actorSessionKey: undefined,
    query: 'builder gate',
    includeSelf: true,
    registry: [
      {
        sessionKey: 'sess_user_alias',
        currentSessionId: '550e8400-e29b-41d4-a716-446655440000',
        tabId: 'tab-user-alias',
        workspaceId: 'ws-1',
        alias: 'Builder Gate',
        aliasSource: 'user',
        terminalTitle: 'generic shell',
        sortOrder: 0,
      },
      {
        sessionKey: 'sess_terminal_title',
        currentSessionId: '6ba7b811-9dad-41d1-80b4-00c04fd430c8',
        tabId: 'tab-terminal-title',
        workspaceId: 'ws-1',
        alias: 'Terminal',
        aliasSource: 'default',
        terminalTitle: 'Builder Gate',
        sortOrder: 1,
      },
      {
        sessionKey: 'sess_cwd',
        currentSessionId: '6ba7b812-9dad-41d1-80b4-00c04fd430c8',
        tabId: 'tab-cwd',
        workspaceId: 'ws-1',
        alias: 'Worker',
        aliasSource: 'default',
        cwd: 'C:/Work/builder gate',
        sortOrder: 2,
      },
      {
        sessionKey: 'sess_recovery',
        currentSessionId: '6ba7b813-9dad-41d1-80b4-00c04fd430c8',
        tabId: 'tab-recovery',
        workspaceId: 'ws-1',
        alias: 'Recovery',
        aliasSource: 'default',
        recoveryCommand: 'npm run builder gate',
        sortOrder: 3,
      },
    ],
  }), 'MCP session search ranking');
  const matches = asRecordArray(result.matches, 'MCP ranked search matches');

  assert.equal(result.allowed, true);
  assert.deepEqual(matches.map(match => match.sessionKey), ['sess_user_alias', 'sess_terminal_title', 'sess_cwd', 'sess_recovery']);
  assert.equal(matches[0].matchType, 'exact-alias');
  assert.equal(matches[0].matchSource, 'user-alias');
  assert.ok(Number(matches[0].score) > Number(matches[1].score));
  assert.ok(Number(matches[1].score) > Number(matches[2].score));
  assert.ok(Number(matches[2].score) > Number(matches[3].score));
}

async function testMcpAliasFrMcp001Ac7SearchSessionIds(): Promise<void> {
  const registry = [
    {
      sessionKey: 'sess_lookup_target',
      currentSessionId: '550e8400-e29b-41d4-a716-446655440000',
      previousSessionIds: ['6ba7b811-9dad-41d1-80b4-00c04fd430c8'],
      alias: 'Target',
      aliasSource: 'default',
      lifecycleState: 'active',
      sortOrder: 0,
    },
  ];
  const bySessionKey = asRecord(await callMcpSessionRegistryContract('searchMcpSessions', {
    actorSessionKey: undefined,
    query: 'sess_lookup_target',
    includeSelf: true,
    registry,
  }), 'MCP search by session key');
  const byCurrentSessionId = asRecord(await callMcpSessionRegistryContract('searchMcpSessions', {
    actorSessionKey: undefined,
    query: '550e8400-e29b-41d4-a716-446655440000',
    includeSelf: true,
    registry,
  }), 'MCP search by current session id');
  const byPreviousSessionId = asRecord(await callMcpSessionRegistryContract('searchMcpSessions', {
    actorSessionKey: undefined,
    query: '6ba7b811-9dad-41d1-80b4-00c04fd430c8',
    includeSelf: true,
    registry,
  }), 'MCP search by previous session id');

  const keyMatch = asRecord(asRecordArray(bySessionKey.matches, 'session-key search matches')[0], 'session-key search match');
  const currentIdMatch = asRecord(asRecordArray(byCurrentSessionId.matches, 'current-session-id search matches')[0], 'current-session-id search match');
  const previousIdMatch = asRecord(asRecordArray(byPreviousSessionId.matches, 'previous-session-id search matches')[0], 'previous-session-id search match');
  assert.equal(bySessionKey.allowed, true);
  assert.equal(keyMatch.sessionKey, 'sess_lookup_target');
  assert.equal(keyMatch.matchSource, 'session-key');
  assert.equal(keyMatch.matchType, 'exact-session-key');
  assert.equal(currentIdMatch.matchSource, 'current-session-id');
  assert.equal(currentIdMatch.matchType, 'exact-current-session-id');
  assert.equal(previousIdMatch.matchSource, 'previous-session-id');
  assert.equal(previousIdMatch.matchType, 'exact-previous-session-id');
}

async function testMcpAliasFrMcp001Ac7SearchDenials(): Promise<void> {
  const zero = asRecord(await callMcpSessionRegistryContract('searchMcpSessions', {
    actorSessionKey: undefined,
    query: 'missing',
    includeSelf: true,
    registry: createMcpRegistryFixture(),
  }), 'MCP zero-match search result');
  assert.equal(zero.allowed, false);
  assert.equal(zero.code, 'TARGET_NOT_FOUND');
  assert.equal(zero.reason, 'zero-matches');
  assert.deepEqual(asRecordArray(zero.matches, 'MCP zero-match matches'), []);

  const ambiguous = asRecord(await callMcpSessionRegistryContract('searchMcpSessions', {
    actorSessionKey: undefined,
    query: 'builder',
    includeSelf: true,
    registry: [
      {
        sessionKey: 'sess_one',
        currentSessionId: '550e8400-e29b-41d4-a716-446655440000',
        alias: 'builder',
        aliasSource: 'user',
        lifecycleState: 'active',
        sortOrder: 0,
      },
      {
        sessionKey: 'sess_two',
        currentSessionId: '6ba7b811-9dad-41d1-80b4-00c04fd430c8',
        alias: 'builder',
        aliasSource: 'user',
        lifecycleState: 'active',
        sortOrder: 1,
      },
    ],
  }), 'MCP ambiguous search result');
  const candidates = asRecordArray(ambiguous.candidates, 'MCP ambiguous search candidates');

  assert.equal(ambiguous.allowed, false);
  assert.equal(ambiguous.code, 'AMBIGUOUS_TARGET');
  assert.equal(ambiguous.reason, 'ambiguous-equal-rank');
  assert.deepEqual(candidates.map(candidate => candidate.sessionKey), ['sess_one', 'sess_two']);
}

async function testMcpAliasFrMcp006Ac5(): Promise<void> {
  const result = asRecord(await callMcpSessionRegistryContract('setMcpSessionAlias', {
    actorSessionKey: 'sess_alpha',
    targetSessionKey: 'sess_beta',
    alias: 'worker-main',
    registry: createMcpRegistryFixture(),
  }), 'MCP alias update');
  const tab = asRecord(result.updatedTab, 'MCP alias updated tab');
  const binding = asRecord(result.binding, 'MCP alias updated binding');

  assert.equal(tab.id, 'tab-beta');
  assert.equal(tab.name, 'worker-main');
  assert.equal(tab.nameSource, 'user');
  assert.equal(binding.sessionKey, 'sess_beta');
  assert.equal(binding.alias, 'worker-main');
  assert.equal(binding.aliasSource, 'user');
}

async function testMcpAliasFrMcp006Ac6(): Promise<void> {
  const result = asRecord(await callMcpSessionRegistryContract('setMcpSessionAlias', {
    actorSessionKey: 'sess_alpha',
    targetSessionKey: 'sess_beta',
    alias: 'worker-main',
    registry: createMcpRegistryFixture(),
    broadcast: true,
  }), 'MCP alias broadcast update');
  const broadcast = asRecord(result.broadcast, 'MCP alias update broadcast');
  const payload = asRecord(broadcast.payload, 'MCP alias update broadcast payload');

  assert.equal(broadcast.event, 'tab:updated');
  assert.equal(payload.tabId, 'tab-beta');
  assert.equal(payload.sessionKey, 'sess_beta');
  assert.equal(payload.currentSessionId, '6ba7b811-9dad-41d1-80b4-00c04fd430c8');
  assert.equal(payload.name, 'worker-main');
  assert.equal(payload.nameSource, 'user');
}

async function testMcpSecuritySecMcp001Ac1(): Promise<void> {
  const config = asRecord(await callMcpSecurityContract('createDefaultMcpSecurityConfig'), 'default MCP security config');
  assert.equal(config.bindHost, '127.0.0.1');
  assert.equal(config.bindMode, 'loopback');

  const denied = await callMcpSecurityContract('evaluateMcpRequestGuard', {
    config,
    remoteAddress: '203.0.113.10',
    headers: {},
    credential: await createValidMcpCredential(),
    dispatchKind: 'mcp',
  });
  assertMcpDenied(denied, 'MCP_LOOPBACK_ONLY');

  const disabled = await callMcpSecurityContract('evaluateMcpRequestGuard', {
    config: { ...config, enabled: false },
    remoteAddress: '127.0.0.1',
    headers: {},
    credential: await createValidMcpCredential(),
    dispatchKind: 'mcp',
  });
  assertMcpDenied(disabled, 'MCP_TRANSPORT_DENIED');
}

async function testMcpSecuritySecMcp001Ac2(): Promise<void> {
  const activeConfig = { enabled: true, bindMode: 'loopback', bindHost: '127.0.0.1' };
  const result = asRecord(await callMcpSecurityContract('validateMcpSecurityConfig', {
    enabled: true,
    bindMode: 'whitelist',
    externalWhitelist: ['203.0.113.0/24'],
    transportSecurity: 'none',
  }, { activeConfig }), 'MCP config validation result');

  assert.equal(result.ok, false);
  assert.equal(result.code, 'MCP_TRANSPORT_TLS_REQUIRED');
  assert.deepEqual(result.activeConfig, activeConfig);

  const nonLoopbackHost = asRecord(await callMcpSecurityContract('validateMcpSecurityConfig', {
    enabled: false,
    bindMode: 'loopback',
    bindHost: '0.0.0.0',
  }, { activeConfig }), 'MCP disabled non-loopback host validation result');
  assert.equal(nonLoopbackHost.ok, false);
  assert.equal(nonLoopbackHost.code, 'MCP_LOOPBACK_ONLY');

  const invalidConfigCases = [
    {
      label: 'bind mode',
      candidate: { enabled: true, bindMode: 'external', bindHost: '127.0.0.1' },
      code: 'MCP_TRANSPORT_DENIED',
    },
    {
      label: 'transport security',
      candidate: { enabled: true, bindMode: 'whitelist', externalWhitelist: ['203.0.113.0/24'], transportSecurity: 'plaintext' },
      code: 'MCP_TRANSPORT_DENIED',
    },
    {
      label: 'external whitelist CIDR',
      candidate: { enabled: true, bindMode: 'whitelist', externalWhitelist: ['not-a-cidr'], transportSecurity: 'direct_tls' },
      code: 'MCP_WHITELIST_DENIED',
    },
    {
      label: 'wide-open external whitelist CIDR',
      candidate: { enabled: true, bindMode: 'whitelist', externalWhitelist: ['0.0.0.0/0'], transportSecurity: 'direct_tls' },
      code: 'MCP_WHITELIST_DENIED',
    },
    {
      label: 'loopback wide-open external whitelist CIDR',
      candidate: { enabled: true, bindMode: 'loopback', bindHost: '127.0.0.1', externalWhitelist: ['0.0.0.0/0'] },
      code: 'MCP_WHITELIST_DENIED',
    },
    {
      label: 'loopback wide-open zero-padded external whitelist CIDR',
      candidate: { enabled: true, bindMode: 'loopback', bindHost: '127.0.0.1', externalWhitelist: ['0.0.0.0/00'] },
      code: 'MCP_WHITELIST_DENIED',
    },
    {
      label: 'trusted proxy CIDR',
      candidate: {
        enabled: true,
        bindMode: 'whitelist',
        externalWhitelist: ['203.0.113.0/24'],
        transportSecurity: 'trusted_tls_proxy',
        trustedProxies: ['also-bad'],
      },
      code: 'MCP_TRUSTED_PROXY_DENIED',
    },
    {
      label: 'allowed origin',
      candidate: { enabled: true, bindMode: 'loopback', bindHost: '127.0.0.1', allowedOrigins: ['not a url'] },
      code: 'MCP_ORIGIN_DENIED',
    },
    {
      label: 'allowed origin shape',
      candidate: { enabled: true, bindMode: 'loopback', bindHost: '127.0.0.1', allowedOrigins: 'https://example.com' },
      code: 'MCP_ORIGIN_DENIED',
    },
  ];
  for (const { label, candidate, code } of invalidConfigCases) {
    const invalid = asRecord(await callMcpSecurityContract(
      'validateMcpSecurityConfig',
      candidate,
      { activeConfig },
    ), `MCP invalid ${label} validation result`);
    assert.equal(invalid.ok, false, `${label} config must be rejected`);
    assert.equal(invalid.code, code, `${label} rejection code`);
    assert.deepEqual(invalid.activeConfig, activeConfig, `${label} rejection should preserve active config`);
  }
}

async function testMcpSecuritySecMcp001Ac3(): Promise<void> {
  const untrustedProxy = await callMcpSecurityContract('evaluateMcpRequestGuard', {
    config: {
      bindMode: 'whitelist',
      externalWhitelist: ['198.51.100.10/32'],
      transportSecurity: 'trusted_tls_proxy',
      trustedProxies: ['127.0.0.1/32'],
    },
    remoteAddress: '192.0.2.44',
    headers: {
      'x-forwarded-for': '198.51.100.10',
      'x-forwarded-proto': 'https',
    },
    credential: await createValidMcpCredential(),
    dispatchKind: 'mcp',
  });
  const insecureProto = await callMcpSecurityContract('evaluateMcpRequestGuard', {
    config: {
      bindMode: 'whitelist',
      externalWhitelist: ['198.51.100.10/32'],
      transportSecurity: 'trusted_tls_proxy',
      trustedProxies: ['127.0.0.1/32'],
    },
    remoteAddress: '127.0.0.1',
    headers: {
      'x-forwarded-for': '198.51.100.10',
      'x-forwarded-proto': 'http',
    },
    credential: await createValidMcpCredential(),
    dispatchKind: 'mcp',
  });
  const missingForwardedHeaders = await callMcpSecurityContract('evaluateMcpRequestGuard', {
    config: {
      bindMode: 'whitelist',
      externalWhitelist: ['198.51.100.10/32'],
      transportSecurity: 'trusted_tls_proxy',
      trustedProxies: ['127.0.0.1/32'],
    },
    remoteAddress: '198.51.100.10',
    headers: {},
    credential: await createValidMcpCredential(),
    dispatchKind: 'mcp',
  });

  assertMcpDenied(untrustedProxy, 'MCP_TRUSTED_PROXY_DENIED');
  assertMcpDenied(insecureProto, 'MCP_TRANSPORT_DENIED');
  assertMcpDenied(missingForwardedHeaders, 'MCP_TRUSTED_PROXY_DENIED');
}

async function testMcpSecuritySecMcp001Ac4(): Promise<void> {
  const secretToken = 'mcp-secret-token-123';
  const result = assertMcpDenied(await callMcpSecurityContract('evaluateMcpRequestGuard', {
    config: {
      bindMode: 'loopback',
      bindHost: '127.0.0.1',
      allowedOrigins: ['https://localhost:2222'],
    },
    remoteAddress: '127.0.0.1',
    headers: { origin: 'https://evil.example' },
    credential: await createValidMcpCredential(),
    dispatchKind: 'mcp',
  }), 'MCP_ORIGIN_DENIED');

  assert.equal(typeof result.auditId, 'string');
  assert.match(String(result.auditId), /\S/u);
  assertNoSecretMaterial(result, [secretToken, 'raw prompt material']);
}

async function testMcpSecuritySecMcp001Ac5(): Promise<void> {
  const result = asRecord(await callMcpSecurityContract('rebindMcpListener', {
    current: { host: '127.0.0.1', port: 3333, generation: 1 },
    candidate: { host: '127.0.0.1', port: 3334, generation: 2 },
    probeResult: { ok: true },
  }), 'MCP listener rebind result');

  assert.equal(result.ok, true);
  assert.equal(result.candidateHealthProbed, true);
  assert.equal(result.oldListenerDrained, true);
  assert.equal(result.appHttpsServerRestarted, false);
  assert.equal(result.redirectServerRestarted, false);
}

async function testMcpSecuritySecMcp001Ac6(): Promise<void> {
  const activeConfig = { host: '127.0.0.1', port: 3333, generation: 7 };
  const result = asRecord(await callMcpSecurityContract('rebindMcpListener', {
    current: activeConfig,
    candidate: { host: '0.0.0.0', port: 3334, generation: 8 },
    probeResult: { ok: false, code: 'health-probe-failed' },
  }), 'MCP failed rebind result');

  assert.equal(result.ok, false);
  assert.equal(result.code, 'MCP_PORT_REBIND_FAILED');
  assert.deepEqual(result.activeConfig, activeConfig);
  assert.equal(result.persistedConfigUpdated, false);
  assert.equal(typeof result.auditId, 'string');

  const unsafeCandidate = asRecord(await callMcpSecurityContract('rebindMcpListener', {
    current: activeConfig,
    candidate: { host: '0.0.0.0', port: 3334, generation: 8, bindMode: 'loopback' },
    probeResult: { ok: true },
  }), 'MCP unsafe rebind result');

  assert.equal(unsafeCandidate.ok, false);
  assert.equal(unsafeCandidate.code, 'MCP_PORT_REBIND_FAILED');
  assert.deepEqual(unsafeCandidate.activeConfig, activeConfig);
  assert.equal(unsafeCandidate.persistedConfigUpdated, false);

  const malformedLoopbackCandidate = asRecord(await callMcpSecurityContract('rebindMcpListener', {
    current: activeConfig,
    candidate: { host: '127.evil', port: 3334, generation: 9, bindMode: 'loopback' },
    probeResult: { ok: true },
  }), 'MCP malformed loopback rebind result');

  assert.equal(malformedLoopbackCandidate.ok, false);
  assert.equal(malformedLoopbackCandidate.code, 'MCP_PORT_REBIND_FAILED');
  assert.deepEqual(malformedLoopbackCandidate.activeConfig, activeConfig);
  assert.equal(malformedLoopbackCandidate.persistedConfigUpdated, false);
}

async function testMcpSecuritySecMcp002Ac1(): Promise<void> {
  const tokenResult = asRecord(await callMcpSecurityContract('mintMcpCapabilityToken', {
    audience: 'buildergate-mcp',
    scopes: expectedDefaultMcpScopes,
    sessionKey: 'sess_A',
    expiresInSeconds: 60,
  }), 'MCP token mint result');
  assert.equal(typeof tokenResult.token, 'string');
  assert.equal(tokenResult.persistedRawToken, undefined);
  const claims = asRecord(tokenResult.claims, 'MCP token claims');

  assert.equal(claims.aud, 'buildergate-mcp');
  assert.equal(claims.sessionKey, 'sess_A');
  assert.equal(typeof claims.jti, 'string');
  assert.ok(Array.isArray(claims.scope));

  assertMcpDenied(await callMcpSecurityContract('verifyMcpCapabilityToken', tokenResult.token, {
    expectedAudience: 'buildergate-browser',
    sessionKey: 'sess_A',
  }), 'INVALID_TOKEN_AUDIENCE');
  assertMcpDenied(await callMcpSecurityContract('verifyMcpCapabilityToken', tokenResult.token, {
    expectedAudience: 'buildergate-mcp',
    sessionKey: 'sess_B',
  }), 'STALE_SESSION_ID');

  assertMcpAccepted(await callMcpSecurityContract('verifyMcpCapabilityToken', tokenResult.token, {
    expectedAudience: 'buildergate-mcp',
    sessionKey: 'sess_A',
  }));
  assertMcpAccepted(await callMcpSecurityContract('verifyMcpCapabilityToken', tokenResult.token, {
    expectedAudience: 'buildergate-mcp',
    sessionKey: 'sess_A',
  }));
}

async function testMcpSecuritySecMcp002Ac2(): Promise<void> {
  const scopes = await callMcpSecurityContract('getDefaultMcpSessionScopes');
  assert.deepEqual([...scopes as string[]].sort(), [...expectedDefaultMcpScopes].sort());
  assert.equal((scopes as string[]).includes('mcp:message.submit'), false);
  assert.equal((scopes as string[]).includes('mcp:session.open'), false);
  assert.equal((scopes as string[]).includes('mcp:sessions.alias.write'), false);
  assert.equal((scopes as string[]).includes('mcp:session.close'), false);
  assert.equal((scopes as string[]).includes('mcp:session.close_self'), false);
}

async function testMcpSecuritySecMcp002Ac3(): Promise<void> {
  assertMcpDenied(await callMcpSecurityContract('authorizeMcpScope', {
    scopes: ['mcp:session.close_self'],
    sessionKey: 'follower',
    leaderSessionKey: null,
  }, 'mcp:session.close_self', { targetSessionKey: 'follower' }), 'SELF_CLOSE_DENIED_NO_LEADER');

  assertMcpDenied(await callMcpSecurityContract('authorizeMcpScope', {
    scopes: ['mcp:session.close_self'],
    sessionKey: 'follower',
    leaderSessionKey: 'leader',
  }, 'mcp:session.close', { targetSessionKey: 'other' }), 'INVALID_SCOPE');

  assertMcpAccepted(await callMcpSecurityContract('authorizeMcpScope', {
    scopes: ['mcp:session.close_self'],
    sessionKey: 'follower',
    leaderSessionKey: 'leader',
  }, 'mcp:session.close_self', { targetSessionKey: 'follower' }));
}

async function testMcpSecuritySecMcp002Ac4(): Promise<void> {
  const browserJwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.browser-admin-token.signature';
  const result = assertMcpDenied(await callMcpSecurityContract('evaluateMcpRequestGuard', {
    config: { bindMode: 'loopback', bindHost: '127.0.0.1' },
    remoteAddress: '127.0.0.1',
    headers: { authorization: `Bearer ${browserJwt}` },
    credential: { type: 'browser-jwt', token: browserJwt },
    dispatchKind: 'mcp',
  }), 'CREDENTIAL_BOUNDARY_VIOLATION');

  assertNoSecretMaterial(result, [browserJwt]);
}

async function testMcpSecuritySecMcp002Ac5(): Promise<void> {
  const validCredential = await createValidMcpCredential();

  assertMcpDenied(await callMcpSecurityContract('evaluateMcpRequestGuard', {
    config: {
      bindMode: 'loopback',
      bindHost: '127.0.0.1',
      allowedOrigins: ['https://localhost:2222'],
    },
    remoteAddress: '127.0.0.1',
    headers: { origin: 'https://evil.example' },
    credential: validCredential,
    dispatchKind: 'mcp',
  }), 'MCP_ORIGIN_DENIED');

  assertMcpDenied(await callMcpSecurityContract('evaluateMcpRequestGuard', {
    config: {
      bindMode: 'loopback',
      bindHost: '127.0.0.1',
      allowedOrigins: [],
    },
    remoteAddress: '127.0.0.1',
    headers: { origin: 'https://evil.example' },
    credential: validCredential,
    dispatchKind: 'mcp',
  }), 'MCP_ORIGIN_DENIED');

  assertMcpDenied(await callMcpSecurityContract('evaluateMcpRequestGuard', {
    config: {
      bindMode: 'loopback',
      bindHost: '127.0.0.1',
      allowedOrigins: ['https://localhost:2222'],
    },
    remoteAddress: '127.0.0.1',
    headers: {},
    dispatchKind: 'mcp',
  }), 'UNBOUND_ACTOR');

  assertMcpDenied(await callMcpSecurityContract('evaluateMcpRequestGuard', {
    config: {
      bindMode: 'loopback',
      bindHost: '127.0.0.1',
      allowedOrigins: ['https://localhost:2222'],
    },
    remoteAddress: '127.0.0.1',
    headers: {},
    credential: { type: 'mcp-capability', token: 'not-a-valid-token' },
    dispatchKind: 'mcp',
  }), 'INVALID_TOKEN');

  assertMcpAccepted(await callMcpSecurityContract('evaluateMcpRequestGuard', {
    config: {
      bindMode: 'loopback',
      bindHost: '127.0.0.1',
      allowedOrigins: ['https://localhost:2222'],
    },
    remoteAddress: '127.0.0.1',
    headers: {},
    credential: validCredential,
    dispatchKind: 'mcp',
  }));
}

async function testMcpSecuritySecMcp002Ac6(): Promise<void> {
  const result = asRecord(await callMcpSecurityContract('validateMcpSecurityConfig', {
    enabled: true,
    bindMode: 'whitelist',
    externalWhitelist: [],
    transportSecurity: 'direct_tls',
  }), 'MCP empty whitelist validation result');

  assert.equal(result.ok, false);
  assert.equal(result.code, 'MCP_WHITELIST_EMPTY');
}

async function testMcpSecuritySecMcp002Ac7(): Promise<void> {
  const created = asRecord(await callMcpSecurityContract('createWebhookCredential', {
    targetSessionKey: 'sess_A',
    profileId: 'default',
    mode: 'send-only',
    scopes: ['mcp:webhook.invoke'],
  }), 'webhook credential creation result');
  const record = asRecord(created.record, 'persisted webhook credential record');

  assert.equal(typeof created.fullKey, 'string');
  assert.ok(Buffer.byteLength(String(created.fullKey), 'utf-8') >= 32);
  assert.equal(typeof record.keyHash, 'string');
  assert.equal('fullKey' in record, false);
  assert.equal('fullUrl' in record, false);

  const rotated = asRecord(await callMcpSecurityContract('rotateWebhookCredential', record), 'webhook credential rotation result');
  assert.equal(typeof rotated.fullKey, 'string');
  assert.notEqual(rotated.fullKey, created.fullKey);
}

async function testMcpSecuritySecMcp002Ac8(): Promise<void> {
  const created = asRecord(await callMcpSecurityContract('createWebhookCredential', {
    targetSessionKey: 'sess_A',
    profileId: 'profile_A',
    mode: 'send-only',
    scopes: ['mcp:webhook.invoke'],
  }), 'webhook credential creation result');
  const record = asRecord(created.record, 'persisted webhook credential record');
  const requestedWebhook = {
    targetSessionKey: 'sess_A',
    profileId: 'profile_A',
    mode: 'send-only',
  };
  const credential = {
    keyHash: 'hash',
    targetSessionKey: 'sess_A',
    profileId: 'profile_A',
    mode: 'send-only',
    scopes: ['mcp:webhook.invoke'],
  };

  assertMcpDenied(await callMcpSecurityContract('authorizeWebhookInvocation', credential, {
    targetSessionKey: 'sess_B',
    profileId: 'profile_A',
    mode: 'send-only',
  }), 'WEBHOOK_BINDING_DENIED');
  assertMcpDenied(await callMcpSecurityContract('authorizeWebhookInvocation', credential, {
    targetSessionKey: 'sess_A',
    profileId: 'profile_B',
    mode: 'open-or-send',
  }), 'WEBHOOK_BINDING_DENIED');

  assertMcpDenied(await callMcpSecurityContract('evaluateMcpRequestGuard', {
    config: { bindMode: 'loopback', bindHost: '127.0.0.1' },
    remoteAddress: '127.0.0.1',
    headers: {},
    credential: { type: 'webhook-key', fullKey: String(created.fullKey), keyHash: String(record.keyHash) },
    dispatchKind: 'webhook',
    requestedWebhook,
  }), 'WEBHOOK_KEY_INVALID');

  assertMcpDenied(await callMcpSecurityContract('evaluateMcpRequestGuard', {
    config: { bindMode: 'loopback', bindHost: '127.0.0.1' },
    remoteAddress: '127.0.0.1',
    headers: {},
    credential: { type: 'webhook-key', fullKey: String(created.fullKey), record },
    dispatchKind: 'webhook',
  }), 'WEBHOOK_BINDING_DENIED');

  assertMcpDenied(await callMcpSecurityContract('evaluateMcpRequestGuard', {
    config: { bindMode: 'loopback', bindHost: '127.0.0.1' },
    remoteAddress: '127.0.0.1',
    headers: {},
    credential: {
      type: 'webhook-key',
      fullKey: String(created.fullKey),
      record: { ...record, scopes: [] },
    },
    dispatchKind: 'webhook',
    requestedWebhook,
  }), 'WEBHOOK_BINDING_DENIED');

  assertMcpAccepted(await callMcpSecurityContract('evaluateMcpRequestGuard', {
    config: { bindMode: 'loopback', bindHost: '127.0.0.1' },
    remoteAddress: '127.0.0.1',
    headers: {},
    credential: { type: 'webhook-key', fullKey: String(created.fullKey), record },
    dispatchKind: 'webhook',
    requestedWebhook,
  }));
}

async function testMcpSecuritySecMcp002Ac9(): Promise<void> {
  const contract = await loadMcpSecurityContract();
  const codes = readDenialCodes(contract);
  for (const code of requiredMcpDenialCodes.slice(0, 11)) {
    assert.ok(codes.includes(code), `missing stable MCP denial code ${code}`);
  }
}

async function testMcpSecuritySecMcp002Ac10(): Promise<void> {
  const created = asRecord(await callMcpSecurityContract('createMcpFixedAccessKey'), 'fixed MCP access key creation result');
  const accessKey = String(created.accessKey ?? '');
  const keyHash = String(created.keyHash ?? '');

  assert.match(accessKey, /^bgmcp_[A-Za-z0-9_-]+$/u);
  assert.ok(Buffer.byteLength(accessKey, 'utf-8') >= 48);
  assert.match(keyHash, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(created.persistedAccessKey, undefined);
  assert.equal(await callMcpSecurityContract('verifyMcpFixedAccessKey', accessKey, keyHash), true);
  assert.equal(await callMcpSecurityContract('verifyMcpFixedAccessKey', `${accessKey}x`, keyHash), false);

  const scopes = await callMcpSecurityContract('getFixedMcpAccessKeyScopes');
  assert.deepEqual([...scopes as string[]].sort(), [
    'mcp:message.paste',
    'mcp:message.submit',
    'mcp:sessions.list',
    'mcp:sessions.search',
  ]);
}

async function testMcpFixedAccessKeyBearerTransport(): Promise<void> {
  const created = asRecord(await callMcpSecurityContract('createMcpFixedAccessKey'), 'fixed MCP access key');
  const accessKey = String(created.accessKey ?? '');
  const keyHash = String(created.keyHash ?? '');
  const scopes = await callMcpSecurityContract('getFixedMcpAccessKeyScopes') as string[];
  const contract = await loadMcpTransportToolContract();
  const createController = getMcpTransportFunction(contract, 'createMcpListenerController');
  const controller = asRecord(createController({
    current: { bindHost: '127.0.0.1', port: 2222 },
    resolveFixedAccessKeyActor: (token: string) => verifyMcpFixedAccessKey(token, keyHash)
      ? { type: 'mcp-fixed-access-key', scopes }
      : undefined,
  }), 'fixed MCP access key listener controller');

  const accepted = asRecord(await callMcpListenerController(controller, 'evaluateRequest', {
    remoteAddress: '127.0.0.1',
    headers: {},
    credential: { type: 'mcp-capability', token: accessKey },
  }), 'fixed access key accepted request');
  assert.equal(accepted.ok, true);
  assert.equal(asRecord(accepted.actor, 'fixed access key actor').type, 'mcp-fixed-access-key');
  assert.deepEqual(asRecord(accepted.actor, 'fixed access key actor').scopes, scopes);

  const denied = asRecord(await callMcpListenerController(controller, 'evaluateRequest', {
    remoteAddress: '127.0.0.1',
    headers: {},
    credential: { type: 'mcp-capability', token: `${accessKey}invalid` },
  }), 'fixed access key denied request');
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'INVALID_TOKEN');
  assert.equal(await callMcpSecurityContract('verifyMcpFixedAccessKey', accessKey, keyHash), true);
}

async function testMcpClaimCodeIssuanceBounds(): Promise<void> {
  const contract = await loadMcpTransportToolContract();
  const issueClaimCode = getMcpTransportFunction(contract, 'issueMcpClaimCode');
  const claimCodes = new Map<string, Record<string, unknown>>([
    ['claim-expired', {
      sessionKey: 'expired-session',
      used: false,
      expiresAt: '2026-07-09T02:29:59.000Z',
    }],
    ['claim-used', {
      sessionKey: 'used-session',
      used: true,
      expiresAt: '2026-07-09T02:40:00.000Z',
    }],
    ['claim-active', {
      sessionKey: 'active-session',
      used: false,
      createdAt: '2099-01-01T00:00:00.000Z',
      expiresAt: '2026-07-09T02:40:00.000Z',
    }],
    ['claim-active-newer', {
      sessionKey: 'active-newer-session',
      used: false,
      createdAt: '2026-07-09T02:29:30.000Z',
      expiresAt: '2026-07-09T02:40:00.000Z',
    }],
  ]);

  const issued = asRecord(issueClaimCode(
    claimCodes,
    { sessionKey: 'new-session' },
    {
      now: () => '2026-07-09T02:30:00.000Z',
      ttlMs: 60_000,
      maxEntries: 2,
    },
  ), 'issued MCP claim code');

  assert.match(String(issued.claimCode ?? ''), /^claim_[A-Za-z0-9_-]{43}$/u);
  assert.equal(issued.sessionKey, 'new-session');
  assert.equal(issued.createdAt, '2026-07-09T02:30:00.000Z');
  assert.equal(issued.expiresAt, '2026-07-09T02:31:00.000Z');
  assert.equal(claimCodes.has('claim-expired'), false);
  assert.equal(claimCodes.has('claim-used'), false);
  assert.equal(claimCodes.has('claim-active'), false);
  assert.equal(claimCodes.has('claim-active-newer'), true);
  assert.equal(claimCodes.size, 2);
}

async function testMcpFixedAccessKeyHttpAuthentication(): Promise<void> {
  const created = asRecord(await callMcpSecurityContract('createMcpFixedAccessKey'), 'fixed MCP access key');
  const accessKey = String(created.accessKey ?? '');
  let activeHash = String(created.keyHash ?? '');
  let now = 1_000;
  let ordinarySessionLive = true;
  const auditEvents: Record<string, unknown>[] = [];
  const scopes = await callMcpSecurityContract('getFixedMcpAccessKeyScopes') as string[];
  const contract = await loadMcpTransportToolContract();
  const createHandler = getMcpTransportFunction(contract, 'createMcpHttpHandler');
  const createController = getMcpTransportFunction(contract, 'createMcpListenerController');
  const noBoundaryHandler = asRecord(createHandler({
    service: await createMcpToolServiceHarness(),
  }), 'MCP HTTP handler without listener controller');
  const handler = asRecord(createHandler({
    service: await createMcpToolServiceHarness(),
    listenerController: createController({
      current: { bindHost: '127.0.0.1', port: 2222 },
      audit: (event: Record<string, unknown>) => auditEvents.push(event),
      resolveFixedAccessKeyActor: (token: string) => verifyMcpFixedAccessKey(token, activeHash)
        ? { type: 'mcp-fixed-access-key', scopes }
        : undefined,
      resolveSession: (sessionKey: string) => ({
        sessionKey,
        bindingLifecycle: sessionKey === 'self-session-key' && ordinarySessionLive ? 'live' : 'stopped',
      }),
    }),
    now: () => now,
    sessionTtlMs: 500,
  }), 'fixed MCP HTTP handler');
  const initializeBody = Buffer.from(JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
  }), 'utf8');
  const request = (credential?: Record<string, unknown>) => callMcpHttpHandler(handler, {
    method: 'POST',
    path: '/mcp',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    credential,
    body: initializeBody,
    remoteAddress: '127.0.0.1',
  });

  const missing = asRecord(await request(), 'missing fixed key initialize');
  assert.equal(missing.status, 403);
  const invalid = asRecord(await request({ type: 'mcp-capability', token: `${accessKey}invalid` }), 'invalid fixed key initialize');
  assert.equal(invalid.status, 403);

  const browserToken = `header.${Buffer.from(JSON.stringify({ sub: 'admin', jti: 'browser', exp: 9999999999 })).toString('base64url')}.signature`;
  const browserCredential = classifyMcpBearerCredential(browserToken);
  assert.equal(browserCredential.type, 'browser-jwt');
  const unprotectedBrowser = asRecord(await callMcpHttpHandler(noBoundaryHandler, {
    method: 'POST',
    path: '/mcp',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    credential: browserCredential,
    body: initializeBody,
    remoteAddress: '127.0.0.1',
  }), 'browser JWT initialize without listener controller');
  assert.equal(unprotectedBrowser.status, 403);
  assert.equal(asRecord(asRecord(unprotectedBrowser.body, 'unprotected browser body').error, 'unprotected browser error').message, 'CREDENTIAL_BOUNDARY_VIOLATION');
  const browser = asRecord(await request(browserCredential), 'browser JWT initialize');
  assert.equal(asRecord(asRecord(browser.body, 'browser JWT body').error, 'browser JWT error').message, 'CREDENTIAL_BOUNDARY_VIOLATION');
  assert.equal(auditEvents.some(event => event.code === 'CREDENTIAL_BOUNDARY_VIOLATION'), true);
  assert.doesNotMatch(JSON.stringify(auditEvents), new RegExp(browserToken.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));

  const initialized = asRecord(await request({ type: 'mcp-capability', token: accessKey }), 'valid fixed key initialize');
  assert.equal(initialized.status, 200);
  const sessionId = String(asRecord(initialized.headers, 'fixed key initialize headers')['mcp-session-id'] ?? '');
  assert.match(sessionId, /^[0-9a-f-]{36}$/iu);

  const missingSessionBearer = asRecord(await callMcpHttpHandler(handler, {
    method: 'POST',
    path: '/mcp',
    headers: { 'content-type': 'application/json; charset=utf-8', 'mcp-session-id': sessionId },
    body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'ping', params: {} }), 'utf8'),
    remoteAddress: '127.0.0.1',
  }), 'missing fixed key session bearer response');
  assert.equal(missingSessionBearer.status, 403);
  assert.equal(asRecord(asRecord(missingSessionBearer.body, 'missing bearer body').error, 'missing bearer error').message, 'INVALID_TOKEN');

  const browserSessionCredential = asRecord(await callMcpHttpHandler(handler, {
    method: 'POST',
    path: '/mcp',
    headers: { 'content-type': 'application/json; charset=utf-8', 'mcp-session-id': sessionId },
    credential: browserCredential,
    body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 12, method: 'ping', params: {} }), 'utf8'),
    remoteAddress: '127.0.0.1',
  }), 'browser JWT fixed key session response');
  assert.equal(browserSessionCredential.status, 403);
  assert.equal(asRecord(asRecord(browserSessionCredential.body, 'browser session body').error, 'browser session error').message, 'CREDENTIAL_BOUNDARY_VIOLATION');

  const forbidden = asRecord(await callMcpHttpHandler(handler, {
    method: 'POST',
    path: '/mcp',
    headers: { 'content-type': 'application/json; charset=utf-8', 'mcp-session-id': sessionId },
    credential: { type: 'mcp-capability', token: accessKey },
    body: Buffer.from(JSON.stringify({
      jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'buildergate.session.open_agent', arguments: {} },
    }), 'utf8'),
    remoteAddress: '127.0.0.1',
  }), 'fixed key forbidden tool response');
  assert.equal(asRecord(asRecord(forbidden.body, 'forbidden response body').result, 'forbidden result').code, 'INVALID_SCOPE');

  const fixedKeyClaim = asRecord(await callMcpHttpHandler(handler, {
    method: 'POST',
    path: '/mcp',
    headers: { 'content-type': 'application/json; charset=utf-8', 'mcp-session-id': sessionId },
    credential: { type: 'mcp-capability', token: accessKey },
    body: Buffer.from(JSON.stringify({
      jsonrpc: '2.0',
      id: 21,
      method: 'tools/call',
      params: {
        name: 'buildergate.session.claim',
        arguments: { claimCode: 'claim-once-code', sessionKey: 'manual-session-key' },
      },
    }), 'utf8'),
    remoteAddress: '127.0.0.1',
  }), 'fixed key claim denial response');
  assert.equal(asRecord(asRecord(fixedKeyClaim.body, 'fixed key claim body').result, 'fixed key claim result').code, 'INVALID_SCOPE');

  const sessionCredential = await createValidMcpCredential('self-session-key');
  const sessionInitialized = asRecord(await request(sessionCredential), 'ordinary session initialize');
  const ordinarySessionId = String(asRecord(sessionInitialized.headers, 'ordinary session headers')['mcp-session-id'] ?? '');
  ordinarySessionLive = false;
  const stoppedSessionToken = asRecord(await callMcpHttpHandler(handler, {
    method: 'POST',
    path: '/mcp',
    headers: { 'content-type': 'application/json; charset=utf-8', 'mcp-session-id': ordinarySessionId },
    credential: sessionCredential,
    body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 14, method: 'ping', params: {} }), 'utf8'),
    remoteAddress: '127.0.0.1',
  }), 'stopped session token response');
  assert.equal(stoppedSessionToken.status, 403);
  assert.equal(asRecord(asRecord(stoppedSessionToken.body, 'stopped session body').error, 'stopped session error').message, 'TOKEN_REVOKED');
  ordinarySessionLive = true;
  const mismatchedSessionBearer = asRecord(await callMcpHttpHandler(handler, {
    method: 'POST',
    path: '/mcp',
    headers: { 'content-type': 'application/json; charset=utf-8', 'mcp-session-id': sessionId },
    credential: sessionCredential,
    body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 13, method: 'ping', params: {} }), 'utf8'),
    remoteAddress: '127.0.0.1',
  }), 'mismatched MCP session bearer response');
  assert.equal(mismatchedSessionBearer.status, 403);
  assert.equal(asRecord(asRecord(mismatchedSessionBearer.body, 'mismatched bearer body').error, 'mismatched bearer error').message, 'INVALID_TOKEN');
  const sessionClaim = asRecord(await callMcpHttpHandler(handler, {
    method: 'POST',
    path: '/mcp',
    headers: { 'content-type': 'application/json; charset=utf-8', 'mcp-session-id': ordinarySessionId },
    credential: sessionCredential,
    body: Buffer.from(JSON.stringify({
      jsonrpc: '2.0',
      id: 22,
      method: 'tools/call',
      params: {
        name: 'buildergate.session.claim',
        arguments: { claimCode: 'claim-once-code', sessionKey: 'manual-session-key' },
      },
    }), 'utf8'),
    remoteAddress: '127.0.0.1',
  }), 'ordinary session claim denial response');
  assert.equal(asRecord(asRecord(sessionClaim.body, 'ordinary session claim body').result, 'ordinary session claim result').code, 'INVALID_SCOPE');

  const rotated = asRecord(await callMcpSecurityContract('createMcpFixedAccessKey'), 'rotated MCP fixed key');
  activeHash = String(rotated.keyHash ?? '');
  const revoked = asRecord(await callMcpHttpHandler(handler, {
    method: 'POST',
    path: '/mcp',
    headers: { 'content-type': 'application/json; charset=utf-8', 'mcp-session-id': sessionId },
    credential: { type: 'mcp-capability', token: accessKey },
    body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping', params: {} }), 'utf8'),
    remoteAddress: '127.0.0.1',
  }), 'revoked fixed key session response');
  assert.equal(revoked.status, 403);

  activeHash = String(rotated.keyHash ?? '');
  const fresh = asRecord(await request({ type: 'mcp-capability', token: String(rotated.accessKey ?? '') }), 'fresh fixed key initialize');
  const freshSessionId = String(asRecord(fresh.headers, 'fresh fixed key headers')['mcp-session-id'] ?? '');
  const rotatedAccessKey = String(rotated.accessKey ?? '');
  now += 501;
  const expired = asRecord(await callMcpHttpHandler(handler, {
    method: 'POST',
    path: '/mcp',
    headers: { 'content-type': 'application/json; charset=utf-8', 'mcp-session-id': freshSessionId },
    credential: { type: 'mcp-capability', token: rotatedAccessKey },
    body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'ping', params: {} }), 'utf8'),
    remoteAddress: '127.0.0.1',
  }), 'expired MCP HTTP session response');
  assert.equal(expired.status, 404);
}

async function testMcpFixedAccessKeyHashPersistence(): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'buildergate-mcp-fixed-key-'));
  const configPath = path.join(tempDir, 'mcp-control-config.json');
  try {
    const created = asRecord(await callMcpSecurityContract('createMcpFixedAccessKey'), 'fixed MCP access key');
    const accessKey = String(created.accessKey ?? '');
    const keyHash = String(created.keyHash ?? '');
    const store = asRecord(createMcpControlConfigFileStore({ dataPath: configPath }), 'MCP control config store');
    const saveConfig = store.saveConfig as (config: unknown) => Promise<unknown>;
    const loadConfig = store.loadConfig as () => Promise<unknown>;
    const initialSave = asRecord(await saveConfig({
      enabled: true,
      bindMode: 'loopback',
      host: '127.0.0.1',
      port: 2222,
      transportSecurity: 'none',
      trustedProxies: [],
      externalWhitelist: [],
      allowedOrigins: [],
      fixedAccessKeyHash: keyHash,
    }), 'fixed access key initial config save');
    assert.equal(initialSave.ok, true);
    const rotated = asRecord(await callMcpSecurityContract('createMcpFixedAccessKey'), 'rotated fixed MCP access key');
    const rotatedHash = String(rotated.keyHash ?? '');
    const [rotationSave, updatedSave] = await Promise.all([
      saveConfig({ fixedAccessKeyHash: rotatedHash }),
      saveConfig({ allowedOrigins: ['https://localhost:2222'] }),
    ]);
    assert.equal(asRecord(rotationSave, 'fixed key rotation save').ok, true);
    assert.equal(asRecord(updatedSave, 'fixed access key config update').ok, true);
    const loaded = asRecord(await loadConfig(), 'fixed access key loaded config');
    assert.equal(loaded.fixedAccessKeyHash, rotatedHash);
    const persisted = await fs.readFile(configPath, 'utf-8');
    assertNoSecretMaterial({ persisted }, [accessKey, String(rotated.accessKey ?? '')]);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function testMcpSecurityIrMcp005Ac1(): Promise<void> {
  const emptyWhitelist = asRecord(await callMcpSecurityContract('validateMcpSecurityConfig', {
    enabled: true,
    bindMode: 'whitelist',
    externalWhitelist: [],
    transportSecurity: 'direct_tls',
  }), 'MCP empty whitelist validation result');
  const credential = await createValidMcpCredential();
  const nonMatchingRequest = await callMcpSecurityContract('evaluateMcpRequestGuard', {
    config: {
      bindMode: 'whitelist',
      externalWhitelist: ['198.51.100.10/32'],
      transportSecurity: 'direct_tls',
    },
    remoteAddress: '203.0.113.8',
    headers: {},
    credential,
    dispatchKind: 'mcp',
  });

  assert.equal(emptyWhitelist.ok, false);
  assert.equal(emptyWhitelist.code, 'MCP_WHITELIST_EMPTY');
  assertMcpDenied(nonMatchingRequest, 'MCP_WHITELIST_DENIED');
}

async function testMcpSecurityIrMcp005Ac2(): Promise<void> {
  const preview = await callMcpSecurityContract('normalizeMcpPromptPreview', {
    prompt: '  Bearer abc.def.ghi\r\nsend secret webhook_key=super-secret\nnext line  ',
    maxChars: 40,
  });

  assert.equal(typeof preview, 'string');
  assert.equal(String(preview).includes('\n'), false);
  assert.equal(String(preview).includes('\r'), false);
  assert.equal(String(preview).trim(), preview);
  assert.ok(String(preview).length <= 40);
  assertNoSecretMaterial(preview, ['abc.def.ghi', 'super-secret']);
}

async function testMcpSecurityIrMcp005Ac3(): Promise<void> {
  const status = asRecord(await callMcpSecurityContract('createMcpOperationalStatus', {
    auditRecentEventsLimit: 1,
    events: [
      {
        auditId: 'audit-1',
        timestamp: '2026-07-09T00:00:00.000Z',
        category: 'denial',
        code: 'WEBHOOK_KEY_INVALID',
        target: 'sess_A',
        token: 'raw-token',
        fullUrl: 'https://example.invalid/hook?key=raw-key',
        prompt: 'raw prompt',
      },
      {
        auditId: 'audit-2',
        timestamp: '2026-07-09T00:00:01.000Z',
        category: 'denial',
        code: 'MCP_WHITELIST_DENIED',
        target: 'sess_B',
      },
    ],
  }), 'MCP operational status');
  const recentAuditEvents = status.recentAuditEvents as unknown[];

  assert.equal(Array.isArray(recentAuditEvents), true);
  assert.equal(recentAuditEvents.length, 1);
  assertNoSecretMaterial(recentAuditEvents, ['raw-token', 'raw-key', 'raw prompt']);
  assert.equal(typeof asRecord(recentAuditEvents[0], 'recent audit event').auditId, 'string');
}

async function testMcpSecurityIrMcp005Ac4(): Promise<void> {
  const forbidden = [
    'Authorization',
    'Cookie',
    'Set-Cookie',
    'Forwarded',
    'X-Forwarded-For',
    'X-Forwarded-Anything',
    'Host',
    'Content-Length',
    'X-Test: injected',
    'X-Test\r\nInjected',
    'X Test',
    '',
  ];

  for (const headerName of forbidden) {
    const result = asRecord(await callMcpSecurityContract('validateMcpWebhookKeyHeaderName', headerName), `webhook header validation ${headerName}`);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'WEBHOOK_HEADER_FORBIDDEN');
  }

  const accepted = asRecord(await callMcpSecurityContract('validateMcpWebhookKeyHeaderName', 'X-BuilderGate-Webhook-Key'), 'accepted webhook header validation');
  assert.equal(accepted.ok, true);
}

async function testMcpSecurityIrMcp005Ac5(): Promise<void> {
  const created = asRecord(await callMcpSecurityContract('serializeWebhookCredentialResponse', {
    operation: 'create',
    fullKey: 'webhook-full-key-create',
    fullUrl: 'https://localhost:2222/api/webhooks/x?key=webhook-full-key-create',
    record: { id: 'wh_1', keyHash: 'hash', maskedKey: 'bgwh_****_tail' },
  }), 'webhook create response');
  const rotated = asRecord(await callMcpSecurityContract('serializeWebhookCredentialResponse', {
    operation: 'rotate',
    fullKey: 'webhook-full-key-rotate',
    fullUrl: 'https://localhost:2222/api/webhooks/x?key=webhook-full-key-rotate',
    record: { id: 'wh_1', keyHash: 'hash2', maskedKey: 'bgwh_****_tail2' },
  }), 'webhook rotate response');

  assert.equal(created.fullKey, 'webhook-full-key-create');
  assert.equal(typeof created.fullUrl, 'string');
  assert.equal(rotated.fullKey, 'webhook-full-key-rotate');
  assert.equal(typeof rotated.fullUrl, 'string');
}

async function testMcpSecurityIrMcp005Ac6(): Promise<void> {
  const allowed = ['unknown', 'starting', 'ready', 'busy', 'waiting_input', 'completed', 'failed'];

  for (const status of allowed) {
    const result = asRecord(await callMcpSecurityContract('validateMcpAgentStatus', status), `agentStatus ${status}`);
    assert.equal(result.ok, true);
    assert.equal(result.value, status);
  }

  const invalid = asRecord(await callMcpSecurityContract('validateMcpAgentStatus', 'sleeping'), 'invalid agentStatus');
  assert.equal(invalid.ok, false);
  assert.equal(invalid.code, 'INVALID_AGENT_STATUS');
}

async function testMcpSecurityIrMcp005Ac7(): Promise<void> {
  const allowed = ['live', 'closing', 'closed', 'retired', 'failed', 'closing-failed'];

  for (const lifecycle of allowed) {
    const result = asRecord(await callMcpSecurityContract('validateMcpBindingLifecycle', lifecycle), `bindingLifecycle ${lifecycle}`);
    assert.equal(result.ok, true);
    assert.equal(result.value, lifecycle);
  }

  const invalid = asRecord(await callMcpSecurityContract('validateMcpBindingLifecycle', 'active'), 'legacy bindingLifecycle');
  assert.equal(invalid.ok, false);
  assert.equal(invalid.code, 'INVALID_BINDING_LIFECYCLE');
}

async function testMcpSecurityIrMcp005Ac8(): Promise<void> {
  const result = assertMcpDenied(await callMcpSecurityContract('mapMcpInputRejection', {
    reason: 'replay-pending',
    earlierEquivalentCode: 'SESSION_BUSY',
  }), 'INPUT_REJECTED_REPLAY_PENDING');

  assert.equal(result.code, 'INPUT_REJECTED_REPLAY_PENDING');
}

async function testMcpSecurityIrMcp005Ac9(): Promise<void> {
  const missingNonce = asRecord(await callMcpSecurityContract('validateMcpCloseConfirmation', {
    pathSessionKey: 'sess_A',
    confirmClose: true,
    expectedSessionKey: 'sess_A',
  }), 'missing close confirmation nonce');
  const mismatchedKey = asRecord(await callMcpSecurityContract('validateMcpCloseConfirmation', {
    pathSessionKey: 'sess_A',
    confirmClose: true,
    expectedSessionKey: 'sess_B',
    confirmationNonce: 'nonce-current',
    currentNonce: 'nonce-current',
  }), 'mismatched close confirmation key');

  assert.equal(missingNonce.ok, false);
  assert.equal(missingNonce.code, 'CLOSE_CONFIRMATION_REQUIRED');
  assert.equal(mismatchedKey.ok, false);
  assert.equal(mismatchedKey.code, 'CLOSE_CONFIRMATION_REQUIRED');
}

async function testMcpSecurityIrMcp005Ac10(): Promise<void> {
  for (const operation of ['revoke', 'list', 'config', 'history']) {
    const response = await callMcpSecurityContract('serializeWebhookCredentialResponse', {
      operation,
      fullKey: `webhook-full-key-${operation}`,
      fullUrl: `https://localhost:2222/api/webhooks/x?key=webhook-full-key-${operation}`,
      record: { id: 'wh_1', keyHash: 'hash', maskedKey: 'bgwh_****_tail' },
    });

    assertNoSecretMaterial(response, [`webhook-full-key-${operation}`]);
    assert.equal('fullKey' in asRecord(response, `webhook ${operation} response`), false);
    assert.equal('fullUrl' in asRecord(response, `webhook ${operation} response`), false);
  }
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
    onTerminalTitleChange() {},
    onSessionFinalized() {},
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
    assert.equal(result.sessionCleanupAttempted, 0);
    assert.equal(result.sessionCleanupCompleted, 0);
    assert.equal(result.sessionCleanupDegraded, 0);
    assert.equal(result.sessionCleanupSkippedUnverified, 0);
    assert.equal(result.remainingVerifiedDescendants, 0);
    assert.deepEqual(events, ['stop-watchers']);
    assert.equal(typeof file.lastUpdated, 'string');
    assert.equal(file.state?.tabs?.[0]?.lastCwd, cwd);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

async function testPerformGracefulShutdownTerminatesSessionsAfterWorkspaceFlush(): Promise<void> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'buildergate-graceful-shutdown-cleanup-'));
  const cwdFilePath = path.join(tmpDir, 'cwd.txt');
  const workspaceFilePath = path.join(tmpDir, 'workspaces.json');
  const cwd = path.join(tmpDir, 'project');
  const events: string[] = [];
  let cleanupSnapshot = {
    attempted: 0,
    completed: 0,
    degraded: 0,
    unverifiedSkipped: 0,
    recentResults: [] as Array<{
      sessionId: string;
      reason: string;
      cleanupStatus: string;
      remainingDescendants: number;
      verifiedRemainingDescendants?: number;
      unverifiedRemainingDescendants?: number;
    }>,
  };
  await fs.writeFile(cwdFilePath, cwd, 'utf-8');

  const sessionManagerStub = {
    onCwdChange() {},
    onTerminalTitleChange() {},
    onSessionFinalized() {},
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
    async terminateAllSessions(options: { reason: string }) {
      events.push(`terminate:${options.reason}`);
      const flushed = JSON.parse(await fs.readFile(workspaceFilePath, 'utf-8')) as {
        state?: { tabs?: Array<{ lastCwd?: string }> };
      };
      assert.equal(flushed.state?.tabs?.[0]?.lastCwd, cwd);
      await fs.rm(cwdFilePath, { force: true });
      cleanupSnapshot = {
        attempted: 2,
        completed: 1,
        degraded: 1,
        unverifiedSkipped: 0,
        recentResults: [
          {
            sessionId: 'session-1',
            reason: 'shutdown',
            cleanupStatus: 'completed',
            remainingDescendants: 0,
            verifiedRemainingDescendants: 0,
            unverifiedRemainingDescendants: 0,
          },
          {
            sessionId: 'session-2',
            reason: 'shutdown',
            cleanupStatus: 'degraded',
            remainingDescendants: 3,
            verifiedRemainingDescendants: 1,
            unverifiedRemainingDescendants: 2,
          },
        ],
      };
      return {
        attempted: 2,
        terminated: 2,
        missing: [],
        remainingVerifiedDescendants: 1,
        remainingUnverifiedDescendants: 2,
      };
    },
    getObservabilitySnapshot() {
      return {
        totalSessions: cleanupSnapshot.attempted === 0 ? 2 : 0,
        cleanup: cleanupSnapshot,
      };
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
  const originalSnapshotAllCwds = workspaceService.snapshotAllCwds.bind(workspaceService);
  const originalForceFlush = workspaceService.forceFlush.bind(workspaceService);
  let flushCount = 0;
  (workspaceService as any).snapshotAllCwds = () => {
    events.push('snapshot');
    originalSnapshotAllCwds();
  };
  (workspaceService as any).forceFlush = async () => {
    flushCount += 1;
    events.push(`flush-${flushCount}`);
    await originalForceFlush();
  };

  try {
    const result = await performGracefulShutdown('internal-shutdown', {
      sessionManager: sessionManagerStub,
      workspaceService,
    });
    const finalWorkspace = JSON.parse(await fs.readFile(workspaceFilePath, 'utf-8')) as {
      state?: { tabs?: Array<{ lastCwd?: string }> };
    };

    assert.deepEqual(events, ['stop-watchers', 'snapshot', 'flush-1', 'terminate:shutdown', 'flush-2']);
    assert.equal(flushCount, 2);
    assert.equal(finalWorkspace.state?.tabs?.[0]?.lastCwd, cwd);
    assert.equal(result.sessionCleanupAttempted, 2);
    assert.equal(result.sessionCleanupCompleted, 1);
    assert.equal(result.sessionCleanupDegraded, 1);
    assert.equal(result.sessionCleanupSkippedUnverified, 0);
    assert.equal(result.remainingVerifiedDescendants, 1);
    assert.equal(result.workspaceFlushed, true);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

async function testPerformGracefulShutdownSessionCleanupTimeoutDegradesAndFinalFlushes(): Promise<void> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'buildergate-graceful-shutdown-timeout-'));
  const workspaceFilePath = path.join(tmpDir, 'workspaces.json');
  const events: string[] = [];
  let flushCount = 0;
  let cleanupSnapshot = {
    attempted: 0,
    completed: 0,
    degraded: 0,
    unverifiedSkipped: 0,
    recentResults: [] as Array<{
      sessionId: string;
      reason: string;
      cleanupStatus: string;
      remainingDescendants: number;
      verifiedRemainingDescendants?: number;
      unverifiedRemainingDescendants?: number;
      recordedAt: string;
    }>,
  };
  const sessionManagerStub = {
    stopAllCwdWatching() {
      events.push('stop-watchers');
    },
    async terminateAllSessions() {
      events.push('terminate');
      cleanupSnapshot = {
        attempted: 1,
        completed: 0,
        degraded: 1,
        unverifiedSkipped: 0,
        recentResults: [{
          sessionId: 'session-timeout-1',
          reason: 'shutdown',
          cleanupStatus: 'degraded',
          remainingDescendants: 2,
          verifiedRemainingDescendants: 1,
          unverifiedRemainingDescendants: 1,
          recordedAt: new Date().toISOString(),
        }],
      };
      await new Promise(() => undefined);
      return { attempted: 2, terminated: 0, missing: [] };
    },
    getObservabilitySnapshot() {
      return {
        totalSessions: cleanupSnapshot.attempted === 0 ? 2 : 1,
        cleanup: cleanupSnapshot,
      };
    },
  } as unknown as SessionManager;
  const workspaceService = {
    snapshotAllCwds() {
      events.push('snapshot');
    },
    async forceFlush() {
      flushCount += 1;
      events.push(`flush-${flushCount}`);
      await fs.writeFile(workspaceFilePath, JSON.stringify({
        lastUpdated: new Date().toISOString(),
        state: { tabs: [] },
      }), 'utf-8');
    },
    getDataFilePath() {
      return workspaceFilePath;
    },
  };

  try {
    const result = await performGracefulShutdown('SIGTERM', {
      sessionManager: sessionManagerStub,
      workspaceService,
      sessionCleanupTimeoutMs: 1,
    });

    assert.deepEqual(events, ['stop-watchers', 'snapshot', 'flush-1', 'terminate', 'flush-2']);
    assert.equal(result.sessionCleanupAttempted, 2);
    assert.equal(result.sessionCleanupCompleted, 0);
    assert.equal(result.sessionCleanupDegraded, 2);
    assert.equal(result.sessionCleanupSkippedUnverified, 0);
    assert.equal(result.remainingVerifiedDescendants, 1);
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

    assert.match(replay?.data ?? '', /oldnew/);
    assert.equal((replay?.data ?? '').split('oldnew').length - 1, 1);
    assert.match(harness.sessionData.degradedReplayBuffer, /oldnew/);
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

    assert.match(replay?.data ?? '', /PAYLOAD_A/);
    assert.match(replay?.data ?? '', /PAYLOAD_B/);
    assert.equal((replay?.data ?? '').split('PAYLOAD_A').length - 1, 1);
    assert.equal((replay?.data ?? '').split('PAYLOAD_B').length - 1, 1);
    assert.match(harness.sessionData.degradedReplayBuffer, /PAYLOAD_A/);
    assert.match(harness.sessionData.degradedReplayBuffer, /PAYLOAD_B/);
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

    assert.match(replay?.data ?? '', /PAYLOAD_A/);
    assert.match(replay?.data ?? '', /PAYLOAD_B/);
    assert.equal((replay?.data ?? '').split('PAYLOAD_A').length - 1, 1);
    assert.equal((replay?.data ?? '').split('PAYLOAD_B').length - 1, 1);
    assert.equal(harness.sessionData.degradedReplayBuffer.split('PAYLOAD_A').length - 1, 1);
    assert.equal(harness.sessionData.degradedReplayBuffer.split('PAYLOAD_B').length - 1, 1);
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

    assert.match(replay?.data ?? '', /PAYLOAD_X/);
    assert.equal((replay?.data ?? '').split('PAYLOAD_X').length - 1, 1);
    assert.equal(harness.sessionData.degradedReplayBuffer.split('PAYLOAD_X').length - 1, 1);
  } finally {
    harness.dispose();
  }
}

function createBoundedHeadlessManager(options: {
  pendingOutputMaxBytes?: number;
  pendingOutputMaxChunks?: number;
  maxSnapshotBytes?: number;
} = {}): SessionManager {
  return new SessionManager({
    pty: {
      termName: 'xterm-256color',
      defaultCols: 10,
      defaultRows: 4,
      useConpty: false,
      scrollbackLines: 1000,
      maxSnapshotBytes: options.maxSnapshotBytes ?? 4096,
      shell: 'auto',
    },
    session: {
      idleDelayMs: 200,
    },
    resourceLimits: resourceLimitsSchema.parse({
      headless: {
        pendingOutputMaxBytes: options.pendingOutputMaxBytes ?? 1024,
        pendingOutputMaxChunks: options.pendingOutputMaxChunks ?? 8,
        writeLagWarnMs: 1,
        writeBatchMaxBytes: 1024,
        overflowPolicy: 'degrade-headless',
      },
    }),
    stabilityModes: stabilityModesSchema.parse({
      headlessQueueMode: 'bounded',
    }),
  });
}

function installDelayedHeadlessWrite(harness: ReturnType<typeof createManagedSessionHarness>) {
  const writes: Array<{ data: string | Uint8Array; callback?: () => void }> = [];
  harness.sessionData.headless!.terminal.write = ((data: string | Uint8Array, callback?: () => void) => {
    writes.push({ data, callback });
  }) as typeof harness.sessionData.headless.terminal.write;
  return writes;
}

async function testSessionManagerBoundedHeadlessChunkOverflow(): Promise<void> {
  const manager = createBoundedHeadlessManager({ pendingOutputMaxChunks: 1 });
  const harness = createManagedSessionHarness(manager, { cols: 10, rows: 4, scrollbackLines: 1000 });
  installDelayedHeadlessWrite(harness);

  try {
    (manager as any).queueHeadlessOutput(harness.sessionId, harness.sessionData, 'A');
    (manager as any).queueHeadlessOutput(harness.sessionId, harness.sessionData, 'B');

    assert.equal(harness.sessionData.headlessHealth, 'degraded');
    const output = (manager.getObservabilitySnapshot() as any).headlessOutput;
    assert.equal(output.overflowCount, 1);
    assert.equal(output.degradedCount, 1);
    assert.equal(output.pendingChunks, 0);
  } finally {
    harness.dispose();
  }
}

async function testSessionManagerBoundedHeadlessByteOverflow(): Promise<void> {
  const manager = createBoundedHeadlessManager({ pendingOutputMaxBytes: 1024, pendingOutputMaxChunks: 8 });
  const harness = createManagedSessionHarness(manager, { cols: 10, rows: 4, scrollbackLines: 1000 });
  installDelayedHeadlessWrite(harness);

  try {
    (manager as any).queueHeadlessOutput(harness.sessionId, harness.sessionData, 'a'.repeat(800));
    (manager as any).queueHeadlessOutput(harness.sessionId, harness.sessionData, 'b'.repeat(300));

    assert.equal(harness.sessionData.headlessHealth, 'degraded');
    const output = (manager.getObservabilitySnapshot() as any).headlessOutput;
    assert.equal(output.overflowCount, 1);
    assert.equal(output.pendingBytes, 0);
    assert.equal(output.maxPendingBytes, 800);
  } finally {
    harness.dispose();
  }
}

async function testSessionManagerBoundedHeadlessMultibyteOverflow(): Promise<void> {
  const manager = createBoundedHeadlessManager({ pendingOutputMaxBytes: 1024, pendingOutputMaxChunks: 8 });
  const harness = createManagedSessionHarness(manager, { cols: 10, rows: 4, scrollbackLines: 1000 });
  installDelayedHeadlessWrite(harness);
  const first = '가'.repeat(300);
  const second = '🙂'.repeat(40);

  try {
    assert.equal(Buffer.byteLength(first, 'utf8'), 900);
    assert.equal(Buffer.byteLength(second, 'utf8'), 160);
    assert.equal(first.length + second.length < 1024, true);

    (manager as any).queueHeadlessOutput(harness.sessionId, harness.sessionData, first);
    (manager as any).queueHeadlessOutput(harness.sessionId, harness.sessionData, second);

    assert.equal(harness.sessionData.headlessHealth, 'degraded');
    const output = (manager.getObservabilitySnapshot() as any).headlessOutput;
    assert.equal(output.overflowCount, 1);
    assert.equal(output.maxPendingBytes, 900);
  } finally {
    harness.dispose();
  }
}

async function testSessionManagerBoundedHeadlessOverflowTelemetry(): Promise<void> {
  const manager = createBoundedHeadlessManager({ pendingOutputMaxBytes: 1024, pendingOutputMaxChunks: 8 });
  const harness = createManagedSessionHarness(manager, { cols: 10, rows: 4, scrollbackLines: 1000 });
  installDelayedHeadlessWrite(harness);

  try {
    (manager as any).queueHeadlessOutput(harness.sessionId, harness.sessionData, 'x'.repeat(900));
    (manager as any).queueHeadlessOutput(harness.sessionId, harness.sessionData, 'y'.repeat(200));

    const output = (manager.getObservabilitySnapshot() as any).headlessOutput;
    assert.equal(harness.sessionData.headlessHealth, 'degraded');
    assert.equal(output.pendingBytes, 0);
    assert.equal(output.pendingChunks, 0);
    assert.equal(output.maxPendingBytes, 900);
    assert.equal(output.maxPendingChunks, 1);
    assert.equal(output.oldestPendingAgeMs, 0);
    assert.equal(output.overflowCount, 1);
    assert.equal(output.degradedCount, 1);
    assert.match(harness.sessionData.degradedReplayBuffer, /x+/);
    assert.match(harness.sessionData.degradedReplayBuffer, /y+/);
  } finally {
    harness.dispose();
  }
}

async function testSessionManagerObserveHeadlessOverflowKeepsOutputOrder(): Promise<void> {
  const first = 'a'.repeat(900);
  const second = 'b'.repeat(200);
  const third = 'c'.repeat(124);
  const manager = new SessionManager({
    pty: {
      termName: 'xterm-256color',
      defaultCols: 10,
      defaultRows: 4,
      useConpty: false,
      scrollbackLines: 1000,
      maxSnapshotBytes: 4096,
      shell: 'auto',
    },
    session: {
      idleDelayMs: 200,
    },
    resourceLimits: resourceLimitsSchema.parse({
      headless: {
        pendingOutputMaxBytes: 1024,
        pendingOutputMaxChunks: 4,
        writeLagWarnMs: 1,
        writeBatchMaxBytes: 1024,
        overflowPolicy: 'degrade-headless',
      },
    }),
    stabilityModes: stabilityModesSchema.parse({
      headlessQueueMode: 'observe',
    }),
  });
  const harness = createManagedSessionHarness(manager, { cols: 10, rows: 4, scrollbackLines: 1000 });
  const writes = installDelayedHeadlessWrite(harness);
  const routed: Array<{ data: string; screenSeq?: number }> = [];
  (manager as any).wsRouter = {
    routeSessionOutput: (_sessionId: string, data: string, screenSeq?: number) => {
      routed.push({ data, screenSeq });
    },
  };

  try {
    (manager as any).queueHeadlessOutput(harness.sessionId, harness.sessionData, first);
    (manager as any).queueHeadlessOutput(harness.sessionId, harness.sessionData, second);
    (manager as any).queueHeadlessOutput(harness.sessionId, harness.sessionData, third);

    await delay(0);
    assert.equal(harness.sessionData.headlessHealth, 'degraded');
    assert.deepEqual(routed, [
      { data: second, screenSeq: 2 },
      { data: third, screenSeq: 3 },
    ]);
    assert.equal(writes.length, 0);
    const pendingStats = (manager.getObservabilitySnapshot() as any).headlessOutput;
    assert.equal(pendingStats.pendingBytes, 0);
    assert.equal(pendingStats.pendingChunks, 0);
    assert.equal(pendingStats.maxPendingBytes, Buffer.byteLength(first, 'utf8'));
    assert.equal(pendingStats.maxPendingChunks, 1);
    assert.equal(pendingStats.overflowCount, 1);
    assert.equal(pendingStats.degradedCount, 1);
    assert.match(harness.sessionData.degradedReplayBuffer, new RegExp(first));
    assert.match(harness.sessionData.degradedReplayBuffer, new RegExp(second));
    assert.match(harness.sessionData.degradedReplayBuffer, new RegExp(third));
  } finally {
    harness.dispose();
  }
}

async function testSessionManagerObserveHeadlessOverflowPreservedOnDegradation(): Promise<void> {
  const first = 'a'.repeat(900);
  const second = 'b'.repeat(200);
  const third = 'c'.repeat(124);
  const manager = new SessionManager({
    pty: {
      termName: 'xterm-256color',
      defaultCols: 10,
      defaultRows: 4,
      useConpty: false,
      scrollbackLines: 1000,
      maxSnapshotBytes: 4096,
      shell: 'auto',
    },
    session: {
      idleDelayMs: 200,
    },
    resourceLimits: resourceLimitsSchema.parse({
      headless: {
        pendingOutputMaxBytes: 1024,
        pendingOutputMaxChunks: 4,
        writeLagWarnMs: 1,
        writeBatchMaxBytes: 1024,
        overflowPolicy: 'degrade-headless',
      },
    }),
    stabilityModes: stabilityModesSchema.parse({
      headlessQueueMode: 'observe',
    }),
  });
  const harness = createManagedSessionHarness(manager, { cols: 10, rows: 4, scrollbackLines: 1000 });
  installDelayedHeadlessWrite(harness);

  try {
    (manager as any).queueHeadlessOutput(harness.sessionId, harness.sessionData, first);
    (manager as any).queueHeadlessOutput(harness.sessionId, harness.sessionData, second);
    (manager as any).queueHeadlessOutput(harness.sessionId, harness.sessionData, third);

    await delay(0);
    assert.equal(harness.sessionData.headlessHealth, 'degraded');
    await harness.sessionData.headlessWriteChain;

    assert.equal(harness.sessionData.headlessHealth, 'degraded');
    assert.match(harness.sessionData.degradedReplayBuffer, new RegExp(first));
    assert.match(harness.sessionData.degradedReplayBuffer, new RegExp(second));
    assert.match(harness.sessionData.degradedReplayBuffer, new RegExp(third));
    const output = (manager.getObservabilitySnapshot() as any).headlessOutput;
    assert.equal(output.overflowCount, 1);
    assert.equal(output.degradedCount, 1);
    assert.equal(output.pendingBytes, 0);
    assert.equal(output.pendingChunks, 0);
  } finally {
    harness.dispose();
  }
}

async function testSessionManagerDegradedOverflowStartsReadySubscriberRecovery(): Promise<void> {
  const first = 'a'.repeat(900);
  const second = 'b'.repeat(200);
  const manager = createBoundedHeadlessManager({ pendingOutputMaxBytes: 1024, pendingOutputMaxChunks: 4 });
  const harness = createManagedSessionHarness(manager, { cols: 10, rows: 4, scrollbackLines: 1000 });
  installDelayedHeadlessWrite(harness);
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
      screenRepairPendingSessions: new Map(),
    });

    (router as any).handleSubscribe(ws, [harness.sessionId]);
    const initialSnapshot = sent.find((message) => message.type === 'screen-snapshot');
    assert.equal(initialSnapshot?.type, 'screen-snapshot');
    (router as any).handleScreenSnapshotReady(ws, harness.sessionId, String(initialSnapshot?.replayToken));

    (manager as any).queueHeadlessOutput(harness.sessionId, harness.sessionData, first);
    (manager as any).queueHeadlessOutput(harness.sessionId, harness.sessionData, second);

    assert.equal(harness.sessionData.headlessHealth, 'degraded');
    assert.equal(harness.sessionData.headlessDegradedPhase, 'queue-overflow');

    const outputMessages = sent.filter((message) => message.type === 'output');
    assert.equal(outputMessages.length, 1);
    assert.equal(outputMessages[0].data, second);

    const snapshots = sent.filter((message) => message.type === 'screen-snapshot');
    assert.equal(snapshots.length, 2);
    const recoverySnapshot = snapshots[1];
    assert.equal(recoverySnapshot.mode, 'fallback');
    assert.equal(recoverySnapshot.fallbackDataState, 'recoverable-buffer');
    assert.equal(recoverySnapshot.fallbackDataBytes, Buffer.byteLength(String(recoverySnapshot.data), 'utf8'));
    assert.match(String(recoverySnapshot.data), new RegExp(first));
    assert.match(String(recoverySnapshot.data), new RegExp(second));

    (router as any).handleScreenSnapshotReady(ws, harness.sessionId, String(recoverySnapshot.replayToken));
    assert.equal(sent.filter((message) => message.type === 'output').length, 1);
    assert.equal(sent.at(-1)?.type, 'session:ready');

    const output = (manager.getObservabilitySnapshot() as any).headlessOutput;
    assert.equal(output.recoverableFallbackSessions, 1);
    assert.equal(output.queueOverflowDegradedCount, 1);
    assert.equal(output.lastDegradedPhase, 'queue-overflow');
    assert.equal(output.degradedReplayBufferBytes, Buffer.byteLength(harness.sessionData.degradedReplayBuffer, 'utf8'));
  } finally {
    router.destroy();
    harness.dispose();
  }
}

async function testSessionManagerBoundedHeadlessOutputRoutesAfterCommit(): Promise<void> {
  const manager = createBoundedHeadlessManager({ pendingOutputMaxBytes: 4096, pendingOutputMaxChunks: 8 });
  const harness = createManagedSessionHarness(manager, { cols: 10, rows: 4, scrollbackLines: 1000 });
  const writes = installDelayedHeadlessWrite(harness);
  const routed: Array<{ data: string; screenSeq?: number }> = [];
  (manager as any).wsRouter = {
    routeSessionOutput: (_sessionId: string, data: string, screenSeq?: number) => {
      routed.push({ data, screenSeq });
    },
  };

  try {
    (manager as any).queueHeadlessOutput(harness.sessionId, harness.sessionData, 'first');
    (manager as any).queueHeadlessOutput(harness.sessionId, harness.sessionData, 'second');

    await delay(0);
    assert.deepEqual(routed, []);
    assert.equal(writes.length, 1);
    writes[0]?.callback?.();
    await delay(0);
    assert.deepEqual(routed, [{ data: 'first', screenSeq: 1 }]);
    assert.equal(writes.length, 2);
    writes[1]?.callback?.();
    await harness.sessionData.headlessWriteChain;
    assert.deepEqual(routed, [
      { data: 'first', screenSeq: 1 },
      { data: 'second', screenSeq: 2 },
    ]);
  } finally {
    harness.dispose();
  }
}

async function testSessionManagerBoundedHeadlessSourceRemovesLegacyPendingArray(): Promise<void> {
  const sourcePath = path.join(process.cwd(), 'src', 'services', 'SessionManager.ts');
  const source = await fs.readFile(sourcePath, 'utf-8');

  assert.equal(source.includes('pendingOutputChunks'), false);
  assert.equal(source.includes('sessionData.headlessOutputQueue.enqueue(data)'), true);
  assert.equal(source.includes('sessionData.headlessOutputQueue.dequeue()?.data'), true);
  assert.equal(source.includes('sessionData.headlessOutputQueue.drain()'), true);
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
    assert.match(harness.sessionData.degradedReplayBuffer, /lost-while-unsubscribed/);
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
      resourceLimits: resourceLimitsSchema.parse(fixture.resourceLimits),
      stabilityModes: stabilityModesSchema.parse(fixture.stabilityModes),
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
      resourceLimits: resourceLimitsSchema.parse(fixture.resourceLimits),
      stabilityModes: stabilityModesSchema.parse(fixture.stabilityModes),
    }, {}, { dryRun: true, changedKeys: ['pty.shell'] });

    assert.equal(result.previousConfig.pty.shell, 'auto');
    assert.equal(result.nextConfig.pty.shell, 'bash');
    assert.match(result.renderedContent, /pty:\s*\{[\s\S]*shell:\s*"bash",[\s\S]*\},/);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function testConfigFileRepositoryPersistsGeneratedJwtSecret(): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'buildergate-settings-jwt-secret-'));
  const configPath = path.join(tempDir, 'config.json5');
  await fs.writeFile(configPath, createConfigFixtureContent().replace('jwtSecret: "jwt-secret"', 'jwtSecret: ""'), 'utf-8');
  const repository = new ConfigFileRepository(configPath, 'linux');

  try {
    const result = repository.persistAuthSecrets({ authJwtSecret: 'enc(generated-jwt)' });
    const savedContent = await fs.readFile(configPath, 'utf-8');

    assert.equal(result.previousConfig.auth?.jwtSecret, '');
    assert.equal(result.nextConfig.auth?.jwtSecret, 'enc(generated-jwt)');
    assert.match(savedContent, /jwtSecret:\s*"enc\(generated-jwt\)"/);
    assert.doesNotMatch(savedContent, /password:\s*"enc\(generated-jwt\)"/);
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
  const headlessOutputQueue = typeof (manager as any).createHeadlessOutputQueue === 'function'
    ? (manager as any).createHeadlessOutputQueue()
    : createHeadlessOutputQueueForHarness({
      maxBytes: 1024 * 1024,
      maxChunks: 1024,
      overflowPolicy: 'degrade-headless',
    });
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
    headlessDegradedPhase: null as null | string,
    headlessOutputQueue,
    headlessQueueMode: ((manager as any).runtimeHeadlessQueueConfig?.mode ?? 'observe'),
    pendingHeadlessOutputs: new Map(),
    pendingHeadlessOutputBytes: 0,
    maxPendingHeadlessOutputBytes: 0,
    maxPendingHeadlessOutputChunks: 0,
    nextHeadlessOutputId: 0,
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
    terminalTitleDetector: new TerminalTitleDetector(),
    terminalTitleSignalDetector: new TerminalTitleDetector(),
  };

  (manager as any).sessions.set(session.id, sessionData);

  return {
    sessionId: session.id,
    sessionData,
    dispose: () => {
      sessionData.oscDetector.destroy();
      sessionData.terminalTitleDetector.destroy();
      sessionData.terminalTitleSignalDetector.destroy();
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

function createWorkspaceServiceHarness(options: {
  terminalTitleDebounceMs?: number;
  recoveryOptionService?: RecoveryOptionService;
  restoreInputDelayMs?: number;
} = {}) {
  const calls = {
    createSession: [] as Array<{ name?: string; shell?: string; cwd?: string }>,
    deleteSession: [] as string[],
    deleteMultipleSessions: [] as string[][],
    deleteSessionReasons: [] as Array<{ id: string; reason?: string }>,
    deleteMultipleSessionReasons: [] as Array<{ ids: string[]; reason?: string }>,
    terminateSession: [] as string[],
    terminateMultipleSessions: [] as string[][],
    hasSession: new Set<string>(),
    createSessionError: null as Error | null,
    order: [] as string[],
    save: [] as Array<{ immediate: boolean; tabs: any[]; workspaces: any[] }>,
    recoveryForeground: [] as Array<{ sessionId: string; command: string }>,
    scheduleRestoreInput: [] as Array<{
      sessionId: string;
      input: string;
      delayMs?: number;
      guard?: () => boolean;
    }>,
  };
  let sessionCounter = 0;
  const resolvedShellBySession = new Map<string, string | undefined>();
  let sessionFinalizedCallback: ((event: SessionFinalizedEvent) => void) | null = null;
  let commandSubmittedCallback: ((event: any) => void | Promise<void>) | null = null;

  const emitSessionFinalized = (id: string, reason?: string) => {
    sessionFinalizedCallback?.({
      sessionId: id,
      reason: (reason ?? 'process-exit') as SessionFinalizedEvent['reason'],
      exitCode: null,
      cleanupStatus: 'completed',
      recordedAt: new Date().toISOString(),
    });
  };

  const sessionManagerStub = {
    onCwdChange() {},
    onTerminalTitleChange() {},
    onSessionFinalized(cb: (event: SessionFinalizedEvent) => void) {
      sessionFinalizedCallback = cb;
    },
    onCommandSubmitted(cb: (event: any) => void | Promise<void>) {
      commandSubmittedCallback = cb;
    },
    markRecoveryCommandForeground(sessionId: string, command: string) {
      calls.order.push(`markRecoveryForeground:${sessionId}:${command}`);
      calls.recoveryForeground.push({ sessionId, command });
    },
    createSession(name?: string, shell?: string, cwd?: string) {
      calls.order.push('createSession');
      calls.createSession.push({ name, shell, cwd });
      if (calls.createSessionError) {
        throw calls.createSessionError;
      }
      const id = `session-${++sessionCounter}`;
      calls.hasSession.add(id);
      resolvedShellBySession.set(id, shell === 'auto' ? 'powershell' : shell);
      return {
        id,
        name: name ?? `Session-${sessionCounter}`,
        status: 'idle',
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        sortOrder: 0,
      };
    },
    deleteSession(id: string, reason?: string) {
      calls.order.push(`deleteSession:${id}:${reason ?? ''}`);
      calls.deleteSession.push(id);
      calls.deleteSessionReasons.push({ id, reason });
      calls.hasSession.delete(id);
      emitSessionFinalized(id, reason);
      return true;
    },
    deleteMultipleSessions(ids: string[], reason?: string) {
      calls.order.push(`deleteMultipleSessions:${reason ?? ''}`);
      calls.deleteMultipleSessions.push(ids);
      calls.deleteMultipleSessionReasons.push({ ids, reason });
      for (const id of ids) calls.hasSession.delete(id);
      for (const id of ids) emitSessionFinalized(id, reason);
    },
    async terminateSession(id: string, options: { reason?: string }) {
      const reason = options.reason;
      calls.order.push(`terminateSession:${id}:${reason ?? ''}`);
      calls.terminateSession.push(id);
      calls.deleteSession.push(id);
      calls.deleteSessionReasons.push({ id, reason });
      calls.hasSession.delete(id);
      emitSessionFinalized(id, reason);
      return true;
    },
    async terminateMultipleSessions(ids: string[], options: { reason?: string }) {
      const reason = options.reason;
      calls.order.push(`terminateMultipleSessions:${reason ?? ''}`);
      calls.terminateMultipleSessions.push(ids);
      calls.deleteMultipleSessions.push(ids);
      calls.deleteMultipleSessionReasons.push({ ids, reason });
      for (const id of ids) calls.hasSession.delete(id);
      for (const id of ids) emitSessionFinalized(id, reason);
      return { attempted: ids.length, terminated: ids.length, missing: [] };
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
    getResolvedShellType(sessionId: string) {
      const shell = resolvedShellBySession.get(sessionId);
      switch (shell) {
        case 'powershell':
        case 'bash':
        case 'zsh':
        case 'sh':
        case 'cmd':
        case 'wsl':
          return shell;
        default:
          return null;
      }
    },
    scheduleRestoreInput(sessionId: string, input: string, options?: { delayMs?: number; guard?: () => boolean }) {
      calls.order.push(`scheduleRestoreInput:${sessionId}:${input}`);
      calls.scheduleRestoreInput.push({
        sessionId,
        input,
        delayMs: options?.delayMs,
        guard: options?.guard,
      });
    },
  } as unknown as SessionManager;

  const workspaceService = new WorkspaceService(sessionManagerStub, options);
  (workspaceService as any).save = async (immediate = false) => {
    calls.order.push(`save:${immediate}`);
    calls.save.push({
      immediate,
      tabs: JSON.parse(JSON.stringify((workspaceService as any).state.tabs)),
      workspaces: JSON.parse(JSON.stringify((workspaceService as any).state.workspaces)),
    });
  };
  (workspaceService as any).flushToDisk = async () => {};

  const emitCommandSubmitted = async (event: any) => {
    await commandSubmittedCallback?.(event);
  };

  return { workspaceService, calls, emitCommandSubmitted };
}

async function createTempRecoveryOptionService(): Promise<{
  service: RecoveryOptionService;
  cleanup: () => Promise<void>;
}> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'buildergate-recovery-options-'));
  const service = new RecoveryOptionService({
    dataPath: path.join(tempDir, 'recovery-options.json'),
  });
  await service.initialize();
  return {
    service,
    cleanup: () => fs.rm(tempDir, { recursive: true, force: true }),
  };
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

async function testHeadlessSnapshotViewportOnlyLongScrollback(): Promise<void> {
  const harness = createHeadlessHarness({ cols: 32, rows: 4, scrollbackLines: 1000 });
  const byteHarness = createHeadlessHarness({ cols: 16, rows: 4, scrollbackLines: 1000 });

  try {
    await writeHeadlessTerminal(harness.state, 'BG-OLD-MARKER-001\r\n');
    for (let i = 2; i < 80; i += 1) {
      await writeHeadlessTerminal(harness.state, `BG-FILLER-${String(i).padStart(3, '0')}\r\n`);
    }
    await writeHeadlessTerminal(harness.state, 'BG-LATEST-MARKER-080\r\n');

    const fullScrollback = harness.state.serializeAddon.serialize({ scrollback: 1000 });
    const snapshot = serializeHeadlessTerminal(harness.state, 4096);

    assert.match(fullScrollback, /BG-OLD-MARKER-001/);
    assert.equal(snapshot.truncated, false);
    assert.doesNotMatch(snapshot.data, /BG-OLD-MARKER-001/);
    assert.match(snapshot.data, /BG-LATEST-MARKER-080/);

    await writeHeadlessTerminal(byteHarness.state, '한글🙂');
    const byteBoundedSnapshot = serializeHeadlessTerminal(byteHarness.state, '한글🙂'.length);

    assert.equal(Buffer.byteLength('한글🙂', 'utf8') > '한글🙂'.length, true);
    assert.equal(byteBoundedSnapshot.truncated, true);
    assert.equal(byteBoundedSnapshot.data, '');
  } finally {
    harness.dispose();
    byteHarness.dispose();
  }
}

async function testHeadlessScreenRepairViewportOnly(): Promise<void> {
  const harness = createHeadlessHarness({ cols: 16, rows: 4, scrollbackLines: 1000 });

  try {
    for (let i = 1; i <= 20; i += 1) {
      await writeHeadlessTerminal(harness.state, `BG-LINE-${String(i).padStart(3, '0')}\r\n`);
    }

    const repair = serializeHeadlessScreenRepair(harness.state, {
      cols: 16,
      rows: 4,
      bufferType: 'normal',
      seq: 42,
    }, 4096);

    assert.equal(repair.ok, true);
    if (!repair.ok) return;
    assert.equal(repair.payload.seq, 42);
    assert.equal(repair.payload.viewportRows.length, 4);
    assert.equal(repair.payload.bufferType, 'normal');
    assert.doesNotMatch(JSON.stringify(repair.payload.viewportRows), /BG-LINE-001/);
    assert.match(JSON.stringify(repair.payload.viewportRows), /BG-LINE-020/);
    assert.doesNotMatch(repair.payload.ansiPatch, /\r|\n/);
  } finally {
    harness.dispose();
  }
}

async function testHeadlessScreenRepairSgrAndCursor(): Promise<void> {
  const harness = createHeadlessHarness({ cols: 12, rows: 4 });

  try {
    await writeHeadlessTerminal(harness.state, '\x1b[31;1mRED\x1b[0m\r\nplain');

    const repair = serializeHeadlessScreenRepair(harness.state, {
      cols: 12,
      rows: 4,
      bufferType: 'normal',
      seq: 7,
    }, 4096);

    assert.equal(repair.ok, true);
    if (!repair.ok) return;
    assert.match(repair.payload.viewportRows[0].ansi, /\x1b\[[0-9;]*31[0-9;]*;1m|\x1b\[[0-9;]*1[0-9;]*;31m/);
    assert.match(repair.payload.viewportRows[0].text, /RED/);
    assert.equal(repair.payload.cursor.x >= 0, true);
    assert.equal(repair.payload.cursor.y >= 0, true);
    assert.match(repair.payload.ansiPatch, /\x1b\[1;1H\x1b\[2K/);
  } finally {
    harness.dispose();
  }
}

async function testHeadlessScreenRepairHiddenCursor(): Promise<void> {
  const harness = createHeadlessHarness({ cols: 12, rows: 4 });

  try {
    await writeHeadlessTerminal(harness.state, 'hidden-cursor\x1b[?25l');

    const repair = serializeHeadlessScreenRepair(harness.state, {
      cols: 12,
      rows: 4,
      bufferType: 'normal',
      seq: 8,
    }, 4096);

    assert.equal(repair.ok, true);
    if (!repair.ok) return;
    assert.equal(repair.payload.cursor.hidden, true);
    assert.match(repair.payload.ansiPatch, /\x1b\[\?25l$/);
    assert.doesNotMatch(repair.payload.ansiPatch, /\x1b\[\?25h$/);

    await writeHeadlessTerminal(harness.state, '\x1b[?25h');
    const visibleRepair = serializeHeadlessScreenRepair(harness.state, {
      cols: 12,
      rows: 4,
      bufferType: 'normal',
      seq: 9,
    }, 4096);

    assert.equal(visibleRepair.ok, true);
    if (!visibleRepair.ok) return;
    assert.equal(visibleRepair.payload.cursor.hidden, false);
    assert.match(visibleRepair.payload.ansiPatch, /\x1b\[\?25h$/);
  } finally {
    harness.dispose();
  }
}

async function testSessionManagerScreenRepairDebugByteLengthUsesUtf8Bytes(): Promise<void> {
  const manager = new SessionManager({
    pty: {
      termName: 'xterm-256color',
      defaultCols: 12,
      defaultRows: 4,
      useConpty: false,
      scrollbackLines: 1000,
      maxSnapshotBytes: 4096,
      shell: 'auto',
    },
    session: {
      idleDelayMs: 200,
    },
  });
  const harness = createManagedSessionHarness(manager, { cols: 12, rows: 4, scrollbackLines: 1000 });

  try {
    await (manager as any).applyHeadlessOutput(harness.sessionId, harness.sessionData, '가🙂');
    manager.enableDebugCapture(harness.sessionId);

    const repair = await manager.getScreenRepair(harness.sessionId, {
      cols: 12,
      rows: 4,
      bufferType: 'normal',
    });

    assert.equal(repair.ok, true);
    if (!repair.ok) return;
    const event = manager.getDebugCapture(harness.sessionId).find((item) => item.kind === 'screen_repair_serialized');
    assert.equal(event?.details?.byteLength, Buffer.byteLength(repair.payload.ansiPatch, 'utf8'));
    assert.equal(Number(event?.details?.byteLength) > repair.payload.ansiPatch.length, true);
  } finally {
    harness.dispose();
  }
}

async function testSessionManagerScreenRepairBufferMismatch(): Promise<void> {
  const manager = new SessionManager({
    pty: {
      termName: 'xterm-256color',
      defaultCols: 10,
      defaultRows: 4,
      useConpty: false,
      scrollbackLines: 1000,
      maxSnapshotBytes: 4096,
      shell: 'auto',
    },
    session: {
      idleDelayMs: 200,
    },
  });
  const harness = createManagedSessionHarness(manager, { cols: 10, rows: 4 });

  try {
    await writeHeadlessTerminal(harness.sessionData.headless!, '\x1b[?1049hALT');
    const repair = await manager.getScreenRepair(harness.sessionId, {
      cols: 10,
      rows: 4,
      bufferType: 'normal',
    });

    assert.deepEqual(repair, { ok: false, reason: 'buffer-mismatch' });
  } finally {
    harness.dispose();
  }
}

async function testSessionManagerScreenRepairRejectsDegraded(): Promise<void> {
  const manager = new SessionManager({
    pty: {
      termName: 'xterm-256color',
      defaultCols: 10,
      defaultRows: 4,
      useConpty: false,
      scrollbackLines: 1000,
      maxSnapshotBytes: 4096,
      shell: 'auto',
    },
    session: {
      idleDelayMs: 200,
    },
  });
  const harness = createDegradedSessionHarness(manager, { cols: 10, rows: 4 });

  try {
    const repair = await manager.getScreenRepair(harness.sessionId, {
      cols: 10,
      rows: 4,
      bufferType: 'normal',
    });

    assert.deepEqual(repair, { ok: false, reason: 'headless-degraded' });
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

function testTerminalPayloadTruncationUtf8ByteCap(): void {
  const multibyte = truncateTerminalPayloadTail(`prefix${'가'.repeat(64)}`, 64);
  assert.equal(multibyte.truncated, true);
  assert.equal(Buffer.byteLength(multibyte.content, 'utf8') <= 64, true);
  assert.doesNotMatch(multibyte.content, /prefix/);

  const emoji = truncateTerminalPayloadTail(`prefix${'🙂'.repeat(20)}`, 17);
  assert.equal(emoji.truncated, true);
  assert.equal(Buffer.byteLength(emoji.content, 'utf8') <= 17, true);
  assert.equal(emoji.content.includes('\uFFFD'), false);
}

function testTerminalTitleDetectorEmitsOsc0AndOsc2(): void {
  const detector = new TerminalTitleDetector();
  const events: TerminalTitleEvent[] = [];
  detector.setCallback(event => events.push(event));

  detector.process('\x1b]0;Hello Title\x07');
  detector.process('\x1b]2;Window Title\x1b\\');

  assert.deepEqual(events.map(event => ({ source: event.source, title: event.title })), [
    { source: 'osc0', title: 'Hello Title' },
    { source: 'osc2', title: 'Window Title' },
  ]);
  assert.equal(detector.getSignalData(), '');
  detector.destroy();
}

function testTerminalTitleDetectorIgnoresUnsupportedAndEmpty(): void {
  const detector = new TerminalTitleDetector();
  const events: TerminalTitleEvent[] = [];
  detector.setCallback(event => events.push(event));

  detector.process('\x1b]1;Icon Title\x07');
  assert.equal(detector.getSignalData(), '\x1b]1;Icon Title\x07');
  detector.process('\x1b]133;A\x07');
  assert.equal(detector.getSignalData(), '\x1b]133;A\x07');
  detector.process('\x1b]0;\t\r\n\x07');

  assert.equal(events.length, 0);
  assert.equal(detector.getSignalData(), '');
  detector.destroy();
}

function testTerminalTitleDetectorHandlesChunkSplit(): void {
  const detector = new TerminalTitleDetector();
  const events: TerminalTitleEvent[] = [];
  detector.setCallback(event => events.push(event));

  detector.process('before\x1b]0;Hel');
  assert.equal(detector.getSignalData(), 'before');
  detector.process('lo\x07after');

  assert.deepEqual(events.map(event => event.title), ['Hello']);
  assert.equal(detector.getSignalData(), 'after');
  detector.destroy();
}

function testTerminalTitleSanitizer(): void {
  const rawTitle = ` Alpha\tBeta\r\nGamma\x1bHidden\u202e${'Z'.repeat(40)}`;
  const sanitized = sanitizeTerminalTitle(rawTitle);

  assert.equal(sanitized, 'Alpha Beta Gamma HiddenZZZZZZZZZ');
  assert.equal(Array.from(sanitized ?? '').length, 32);
  assert.equal(isDefaultTerminalTabName('Terminal-1'), true);
  assert.equal(isDefaultTerminalTabName('Terminal-01'), false);
  assert.equal(isDefaultTerminalTabName('Terminal-1 memo'), false);
}

function testTerminalTitleAbsolutePathPolicy(): void {
  const blockedTitles = [
    'C:\\Work\\repo',
    'C:/Work/repo',
    'c:\\Users\\beom',
    'C:\\',
    '/mnt/c/Work/repo',
    '/home/beom/project',
    '/',
    '\\\\server\\share',
    '//server/share',
    '\\\\?\\C:\\Work',
    '\\Users\\beom',
  ];
  for (const title of blockedTitles) {
    assert.equal(isSystemAbsolutePathTerminalTitle(title), true, title);
  }

  const allowedTitles = [
    'Project C:\\Work',
    'Codex /mnt/c/Work',
    'C:relative',
    'Workspace',
    'https://example.test/repo',
    '~/project',
  ];
  for (const title of allowedTitles) {
    assert.equal(isSystemAbsolutePathTerminalTitle(title), false, title);
  }

  const sanitizedTitle = sanitizeTerminalTitle('\tC:\\Work\\repo');
  assert.equal(isSystemAbsolutePathTerminalTitle(sanitizedTitle ?? ''), true);
}

function testTerminalTitleDetectorCapsAndRecovers(): void {
  const detector = new TerminalTitleDetector();
  const events: TerminalTitleEvent[] = [];
  detector.setCallback(event => events.push(event));

  detector.process(`\x1b]0;${'A'.repeat(4097)}`);
  assert.equal(events.length, 0);
  assert.equal(detector.getSignalData(), '');
  detector.process('\x1b]2;Recovered\x07');

  assert.deepEqual(events.map(event => event.title), ['Recovered']);
  assert.equal(detector.getSignalData(), '');
  detector.destroy();
}

function testTerminalTitleDetectorOverCapTerminatorReleasesSignal(): void {
  const detector = new TerminalTitleDetector();
  const events: TerminalTitleEvent[] = [];
  detector.setCallback(event => events.push(event));

  detector.process(`\x1b]0;${'A'.repeat(4097)}`);
  assert.equal(detector.getSignalData(), '');
  detector.process('\x07normal output');

  assert.equal(events.length, 0);
  assert.equal(detector.getSignalData(), 'normal output');

  detector.process(`\x1b]2;${'B'.repeat(4097)}\x07after`);
  assert.equal(events.length, 0);
  assert.equal(detector.getSignalData(), 'after');
  detector.destroy();
}

function testSessionManagerTerminalTitleSignalStaysIdle(): void {
  const harness = createForegroundSessionHarness('bash');
  const titles: Array<{ sessionId: string; title: string }> = [];
  harness.manager.onTerminalTitleChange((sessionId, title) => {
    titles.push({ sessionId, title });
  });

  try {
    harness.getHandler()('\x1b]0;Idle Title\x07');

    assert.deepEqual(titles, [{ sessionId: harness.session.id, title: 'Idle Title' }]);
    assert.equal(harness.manager.getSession(harness.session.id)?.status, 'idle');
  } finally {
    harness.cleanup();
  }
}

function testSessionManagerTerminalTitleRawOsc133Mode(): void {
  const harness = createForegroundSessionHarness('bash');
  const titles: Array<{ sessionId: string; title: string }> = [];
  harness.manager.onTerminalTitleChange((sessionId, title) => {
    titles.push({ sessionId, title });
  });

  try {
    harness.sessionData.detectionMode = 'osc133';
    harness.getHandler()('\x1b]0;A\x07');

    assert.deepEqual(titles, [{ sessionId: harness.session.id, title: 'A' }]);
    assert.equal(harness.manager.getSession(harness.session.id)?.status, 'idle');
  } finally {
    harness.cleanup();
  }
}

function createFakeWs(options: { bufferedAmount?: number; nextSendError?: Error; deferSendCallbacks?: boolean } = {}) {
  const sent: Array<Record<string, unknown>> = [];
  const listeners = new Map<string, Array<(...args: any[]) => void>>();
  const pendingSendCallbacks: Array<() => void> = [];
  let bufferedAmount = options.bufferedAmount ?? 0;
  let nextSendError = options.nextSendError;
  let closeCode: number | undefined;
  let closeReason: string | undefined;
  let terminateCount = 0;

  const ws = {
    readyState: 1,
    get bufferedAmount() {
      return bufferedAmount;
    },
    set bufferedAmount(value: number) {
      bufferedAmount = value;
    },
    send(payload: string, callback?: (error?: Error) => void) {
      sent.push(JSON.parse(payload) as Record<string, unknown>);
      const error = nextSendError;
      nextSendError = undefined;
      if (options.deferSendCallbacks && callback) {
        pendingSendCallbacks.push(() => callback(error));
        return;
      }
      callback?.(error);
    },
    ping() {},
    close(code?: number, reason?: string) {
      closeCode = code;
      closeReason = reason;
      (this as any).readyState = 3;
      for (const handler of listeners.get('close') ?? []) {
        handler(code, Buffer.from(reason ?? ''));
      }
    },
    terminate() {
      terminateCount += 1;
      (this as any).readyState = 3;
      for (const handler of listeners.get('close') ?? []) {
        handler();
      }
    },
    on(event: string, handler: (...args: any[]) => void) {
      const current = listeners.get(event) ?? [];
      current.push(handler);
      listeners.set(event, current);
      return this;
    },
  } as unknown as import('ws').WebSocket;

  return {
    ws,
    sent,
    setBufferedAmount: (value: number) => {
      bufferedAmount = value;
    },
    setNextSendError: (error: Error) => {
      nextSendError = error;
    },
    getCloseCode: () => closeCode,
    getCloseReason: () => closeReason,
    getTerminateCount: () => terminateCount,
    flushNextSendCallback: () => {
      pendingSendCallbacks.shift()?.();
    },
  };
}

function createWsRouterHarness(options?: {
  snapshotData?: string;
  snapshotTruncated?: boolean;
  snapshotMode?: 'authoritative' | 'fallback';
  snapshotSeq?: number;
  writeInputThrows?: boolean;
  routerOptions?: ConstructorParameters<typeof WsRouter>[2];
  fakeWsOptions?: Parameters<typeof createFakeWs>[0];
  getScreenRepair?: (
    id: string,
    expected: { cols: number; rows: number; bufferType: 'normal' | 'alternate' },
  ) => Promise<unknown> | unknown;
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
    getScreenRepair: options?.getScreenRepair ?? (async (id: string, expected: { cols: number; rows: number; bufferType: 'normal' | 'alternate' }) => id === session.id ? {
      ok: true as const,
      payload: {
        seq: options?.snapshotSeq ?? 1,
        cols: expected.cols,
        rows: expected.rows,
        bufferType: expected.bufferType,
        cursor: { x: 0, y: 0 },
        viewportRows: [{ y: 0, ansi: 'repair-row', text: 'repair-row', wrapped: false }],
        ansiPatch: '\x1b[1;1Hrepair-row',
      },
    } : { ok: false as const, reason: 'headless-degraded' as const }),
    getReplayQueueLimit: () => 64,
    writeInput: (sessionId: string, data: string, metadata?: unknown) => {
      if (options?.writeInputThrows) {
        throw new Error('simulated write failure');
      }
      calls.writeInput.push({ sessionId, data, metadata });
      return true;
    },
    resize: () => true,
  } as unknown as SessionManager;

  const authServiceStub = {
    verifyToken: () => ({ valid: true, payload: { sub: 'test-user' } }),
  } as unknown as AuthService;

  const router = new WsRouter(authServiceStub, sessionManagerStub, {
    inputReliabilityMode: 'queue',
    ...options?.routerOptions,
  });
  const fake = createFakeWs(options?.fakeWsOptions);
  const { ws, sent } = fake;

  (router as any).clients.set(ws, {
    clientId: 'client-1',
    isAlive: true,
    subscribedSessions: new Set<string>(),
    replayPendingSessions: new Map(),
    screenRepairPendingSessions: new Map(),
  });

  return { router, ws, sent, calls, fake };
}

function testWsRouterExposesPerSessionReplayState(): void {
  const { router, ws } = createWsRouterHarness();
  const initial = router.readInputReplayState('session-1');
  assert.deepEqual(initial, { replayPending: false, screenRepairPending: false });

  const meta = (router as any).clients.get(ws);
  meta.replayPendingSessions.set('session-1', { replayToken: 'replay-token-1' });
  meta.screenRepairPendingSessions.set('session-1', { repairToken: 'repair-token-1' });
  const pending = router.readInputReplayState('session-1');

  assert.deepEqual(pending, { replayPending: true, screenRepairPending: true });
  assert.deepEqual(router.readInputReplayState('other-session'), { replayPending: false, screenRepairPending: false });
  router.destroy();
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

function testWsRouterQueuesInputWhileReplayPendingAndFlushesAfterAck(): void {
  const { router, ws, sent, calls } = createWsRouterHarness();

  (router as any).handleSubscribe(ws, ['session-1']);
  const replayToken = String(sent[0].replayToken);

  (router as any).handleInput(ws, {
    type: 'input',
    sessionId: 'session-1',
    data: '가나다ABC\r',
    inputSeqStart: 5,
    inputSeqEnd: 5,
    metadata: {
    captureSeq: 5,
      clientObservedByteLength: 13,
    clientObservedHasHangul: true,
    unsafe: 'raw-text',
    },
  });
  assert.equal(calls.writeInput.length, 0);
  const queuedEvent = router.getObservabilitySnapshot().recentReplayEvents.find((event) => event.kind === 'input_queued');
  assert.equal(queuedEvent?.details?.captureSeq, 5);
  assert.equal(queuedEvent?.details?.clientObservedByteLength, 13);
  assert.equal(queuedEvent?.details?.byteLength, 13);
  assert.equal(queuedEvent?.details?.hasHangul, true);
  assert.equal(queuedEvent?.details?.hasEnter, true);
  assert.equal(queuedEvent?.details?.inputClass, 'mixed-printable-control');
  assert.equal(queuedEvent?.details?.inputSeqStart, 5);
  assert.equal(queuedEvent?.details?.inputSeqEnd, 5);
  assert.equal((queuedEvent?.details as Record<string, unknown>)?.unsafe, undefined);
  assert.doesNotMatch(JSON.stringify(queuedEvent), /가나다/);

  (router as any).handleScreenSnapshotReady(ws, 'session-1', replayToken);

  assert.equal(calls.writeInput.length, 1);
  assert.equal(calls.writeInput[0].sessionId, 'session-1');
  assert.equal(calls.writeInput[0].data, '가나다ABC\r');
  assert.equal((calls.writeInput[0].metadata as Record<string, unknown>).captureSeq, 5);
  assert.equal((calls.writeInput[0].metadata as Record<string, unknown>).unsafe, undefined);
  const flushedEvent = router.getObservabilitySnapshot().recentReplayEvents.find((event) => event.kind === 'input_flushed');
  assert.equal(flushedEvent?.details?.inputSeqStart, 5);
  assert.equal(sent[sent.length - 1].type, 'session:ready');

  router.destroy();
}

function testWsRouterRejectsInputDuringScreenRepairThroughGateway(): void {
  const { router, ws, sent, calls } = createWsRouterHarness();

  (router as any).markScreenRepairPending(ws, 'session-1', 1);
  (router as any).handleInput(ws, {
    type: 'input',
    sessionId: 'session-1',
    data: 'blocked during repair',
    inputSeqStart: 9,
    inputSeqEnd: 9,
    metadata: { captureSeq: 9, rawToken: 'ws-metadata-raw-token' },
  });

  assert.equal(calls.writeInput.length, 0);
  const rejected = sent.find((message) => message.type === 'input:rejected');
  assert.ok(rejected, 'screen-repair input barrier should reject before PTY write');
  assert.equal(rejected?.sessionId, 'session-1');
  assert.equal(rejected?.inputSeqStart, 9);
  assert.equal(rejected?.reason, 'context-changed');
  assert.doesNotMatch(JSON.stringify(sent), /ws-metadata-raw-token/);

  router.destroy();
}

function testWsRouterPreservesInputQueueAcrossReplayRefresh(): void {
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
  const calls = {
    writeInput: [] as Array<{ sessionId: string; data: string; metadata?: unknown }>,
  };
  const sessionManagerStub = {
    getSession: (id: string) => id === session.id ? session : null,
    getLastCwd: () => 'C:\\repo',
    isSessionReady: (id: string) => id === session.id,
    getScreenSnapshot: () => snapshotState,
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
  const router = new WsRouter(authServiceStub, sessionManagerStub, { inputReliabilityMode: 'queue' });
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
    (router as any).handleInput(ws, {
      type: 'input',
      sessionId: 'session-1',
      data: 'preserved',
      inputSeqStart: 1,
      inputSeqEnd: 1,
    });

    snapshotState.seq = 2;
    snapshotState.data = 'AB';
    router.refreshReplaySnapshots('session-1');
    const refreshed = sent.find((message) => message.type === 'screen-snapshot' && message.replayToken !== firstToken);
    assert.equal(refreshed?.type, 'screen-snapshot');
    const secondToken = String(refreshed?.replayToken);

    (router as any).handleScreenSnapshotReady(ws, 'session-1', secondToken);

    assert.deepEqual(calls.writeInput.map((call) => call.data), ['preserved']);
  } finally {
    router.destroy();
  }
}

function testWsRouterDoesNotFlushInputForStaleAck(): void {
  const { router, ws, sent, calls } = createWsRouterHarness();

  (router as any).handleSubscribe(ws, ['session-1']);
  const firstToken = String(sent[0].replayToken);
  (router as any).handleInput(ws, {
    type: 'input',
    sessionId: 'session-1',
    data: 'stays-pending',
    inputSeqStart: 1,
    inputSeqEnd: 1,
  });
  (router as any).handleUnsubscribe(ws, ['session-1']);

  (router as any).handleSubscribe(ws, ['session-1']);
  const secondSnapshot = sent
    .filter((message) => message.type === 'screen-snapshot')
    .at(-1);
  const secondToken = String(secondSnapshot?.replayToken);
  (router as any).handleInput(ws, {
    type: 'input',
    sessionId: 'session-1',
    data: 'active-input',
    inputSeqStart: 2,
    inputSeqEnd: 2,
  });

  (router as any).handleScreenSnapshotReady(ws, 'session-1', firstToken);
  assert.equal(calls.writeInput.length, 0);

  (router as any).handleScreenSnapshotReady(ws, 'session-1', secondToken);
  assert.deepEqual(calls.writeInput.map((call) => call.data), ['active-input']);

  router.destroy();
}

function testWsRouterRejectsExpiredReplayInputOnAck(): void {
  const { router, ws, sent, calls } = createWsRouterHarness();

  (router as any).handleSubscribe(ws, ['session-1']);
  const replayToken = String(sent[0].replayToken);
  (router as any).handleInput(ws, {
    type: 'input',
    sessionId: 'session-1',
    data: 'expired',
    inputSeqStart: 1,
    inputSeqEnd: 1,
  });
  const pending = (router as any).clients.get(ws).replayPendingSessions.get('session-1');
  pending.queuedInputs[0].queuedAt = Date.now() - 10_000;

  (router as any).handleScreenSnapshotReady(ws, 'session-1', replayToken);

  assert.equal(calls.writeInput.length, 0);
  const rejected = sent.find((message) => message.type === 'input:rejected');
  assert.equal(rejected?.reason, 'timeout');

  router.destroy();
}

function testWsRouterRejectsExpiredReplayInputOnTimeout(): void {
  const { router, ws, sent, calls } = createWsRouterHarness();

  (router as any).handleSubscribe(ws, ['session-1']);
  const replayToken = String(sent[0].replayToken);
  (router as any).handleInput(ws, {
    type: 'input',
    sessionId: 'session-1',
    data: 'expired-timeout',
    inputSeqStart: 1,
    inputSeqEnd: 1,
  });
  const pending = (router as any).clients.get(ws).replayPendingSessions.get('session-1');
  pending.queuedInputs[0].queuedAt = Date.now() - 10_000;

  (router as any).handleReplayAckTimeout(ws, 'session-1', replayToken, 1, 'timeout');

  assert.equal(calls.writeInput.length, 0);
  const rejected = sent.find((message) => message.type === 'input:rejected');
  assert.equal(rejected?.reason, 'timeout');
  assert.equal(sent[sent.length - 1].type, 'session:ready');

  router.destroy();
}

function testWsRouterRejectsEnterInputOnReplayTimeout(): void {
  const { router, ws, sent, calls } = createWsRouterHarness();

  (router as any).handleSubscribe(ws, ['session-1']);
  const replayToken = String(sent[0].replayToken);
  (router as any).handleInput(ws, {
    type: 'input',
    sessionId: 'session-1',
    data: 'danger\r',
    inputSeqStart: 1,
    inputSeqEnd: 1,
  });

  (router as any).handleReplayAckTimeout(ws, 'session-1', replayToken, 1, 'timeout');

  assert.equal(calls.writeInput.length, 0);
  const rejected = sent.find((message) => message.type === 'input:rejected');
  assert.equal(rejected?.reason, 'timeout-enter-safety');
  assert.equal(sent[sent.length - 1].type, 'session:ready');

  router.destroy();
}

function testWsRouterFlushesSafeInputOnReplayTimeout(): void {
  const { router, ws, sent, calls } = createWsRouterHarness();

  (router as any).handleSubscribe(ws, ['session-1']);
  const replayToken = String(sent[0].replayToken);
  (router as any).handleInput(ws, {
    type: 'input',
    sessionId: 'session-1',
    data: 'safe',
    inputSeqStart: 1,
    inputSeqEnd: 1,
  });

  (router as any).handleReplayAckTimeout(ws, 'session-1', replayToken, 1, 'timeout');

  assert.deepEqual(calls.writeInput.map((call) => call.data), ['safe']);
  const flushed = router.getObservabilitySnapshot().recentReplayEvents.find((event) => event.kind === 'input_flushed_timeout');
  assert.equal(flushed?.details?.phase, 'timeout');
  assert.equal(sent[sent.length - 1].type, 'session:ready');

  router.destroy();
}

function testWsRouterQueuedInputOverflowIsObservable(): void {
  const { router, ws, sent, calls } = createWsRouterHarness();

  (router as any).handleSubscribe(ws, ['session-1']);
  (router as any).handleInput(ws, {
    type: 'input',
    sessionId: 'session-1',
    data: 'x'.repeat(64 * 1024),
    inputSeqStart: 1,
    inputSeqEnd: 1,
  });
  (router as any).handleInput(ws, {
    type: 'input',
    sessionId: 'session-1',
    data: 'overflow',
    inputSeqStart: 2,
    inputSeqEnd: 2,
  });

  assert.equal(calls.writeInput.length, 0);
  const overflow = router.getObservabilitySnapshot().recentReplayEvents.find((event) => event.kind === 'input_queue_overflow');
  assert.equal(overflow?.details?.reason, 'queue-overflow');
  const rejected = sent.find((message) => message.type === 'input:rejected');
  assert.equal(rejected?.reason, 'queue-overflow');

  router.destroy();
}

function testWsRouterRejectsInvalidInputPayload(): void {
  const { router, ws, sent, calls } = createWsRouterHarness();

  (router as any).handleMessage(ws, JSON.stringify({
    type: 'input',
    sessionId: 'session-1',
    data: 123,
    inputSeqStart: 1,
    inputSeqEnd: 1,
  }));
  (router as any).handleMessage(ws, JSON.stringify({
    type: 'input',
    sessionId: '',
    data: 'bad',
  }));
  (router as any).handleMessage(ws, JSON.stringify({
    type: 'input',
    sessionId: 'session-1',
    data: 'x'.repeat((64 * 1024) + 1),
  }));

  assert.equal(calls.writeInput.length, 0);
  const rejected = sent.filter((message) => message.type === 'input:rejected');
  assert.equal(rejected.length, 2);
  assert.equal(rejected[0].reason, 'invalid-payload');
  assert.equal(rejected[1].reason, 'invalid-payload');

  router.destroy();
}

function testWsRouterRejectsInvalidInputSequenceRange(): void {
  const { router, ws, sent, calls } = createWsRouterHarness();

  const invalidMessages = [
    { type: 'input', sessionId: 'session-1', data: 'bad', inputSeq: 1 },
    { type: 'input', sessionId: 'session-1', data: 'bad', inputSeqStart: 1 },
    { type: 'input', sessionId: 'session-1', data: 'bad', inputSeqStart: 0, inputSeqEnd: 1 },
    { type: 'input', sessionId: 'session-1', data: 'bad', inputSeqStart: 5, inputSeqEnd: 4 },
    { type: 'input', sessionId: 'session-1', data: 'bad', inputSeqStart: 1, inputSeqEnd: 1025 },
  ];

  for (const message of invalidMessages) {
    (router as any).handleMessage(ws, JSON.stringify(message));
  }

  assert.equal(calls.writeInput.length, 0);
  const rejected = sent.filter((message) => message.type === 'input:rejected');
  assert.equal(rejected.length, invalidMessages.length);
  assert.equal(rejected.every((message) => message.reason === 'invalid-sequence'), true);

  router.destroy();
}

function testWsRouterSanitizesClientInputMetadata(): void {
  const { router, ws, sent, calls } = createWsRouterHarness();

  (router as any).handleSubscribe(ws, ['session-1']);
  const replayToken = String(sent[0].replayToken);
  (router as any).handleInput(ws, {
    type: 'input',
    sessionId: 'session-1',
    data: '한글',
    inputSeqStart: 1,
    inputSeqEnd: 1,
    metadata: {
      captureSeq: 7,
      clientObservedHasHangul: true,
      clientObservedHasEnter: false,
      reason: 'raw-reason',
      raw: '한글',
      nested: { unsafe: true },
    },
  });
  (router as any).handleScreenSnapshotReady(ws, 'session-1', replayToken);

  assert.equal(calls.writeInput.length, 1);
  const metadata = calls.writeInput[0].metadata as Record<string, unknown>;
  assert.equal(metadata.captureSeq, 7);
  assert.equal(metadata.clientObservedHasHangul, true);
  assert.equal(metadata.clientObservedHasEnter, false);
  assert.equal(metadata.reason, undefined);
  assert.equal(metadata.raw, undefined);
  assert.equal(metadata.nested, undefined);

  const serializedEvents = JSON.stringify(router.getObservabilitySnapshot().recentReplayEvents);
  assert.doesNotMatch(serializedEvents, /raw-reason/);
  assert.doesNotMatch(serializedEvents, /한글/);

  router.destroy();
}

function testWsRouterEmitsInputRejectedForRealServerScenarios(): void {
  const { router, ws, sent } = createWsRouterHarness();

  (router as any).handleMessage(ws, JSON.stringify({
    type: 'input',
    sessionId: 'session-1',
    data: 'invalid-seq',
    inputSeqStart: 9,
    inputSeqEnd: 1,
  }));
  (router as any).handleMessage(ws, JSON.stringify({
    type: 'input',
    sessionId: 'missing-session',
    data: 'missing',
    inputSeqStart: 1,
    inputSeqEnd: 1,
  }));

  (router as any).handleSubscribe(ws, ['session-1']);
  (router as any).handleInput(ws, {
    type: 'input',
    sessionId: 'session-1',
    data: 'enter\r',
    inputSeqStart: 2,
    inputSeqEnd: 2,
  });
  (router as any).handleInput(ws, {
    type: 'input',
    sessionId: 'session-1',
    data: 'x'.repeat(64 * 1024),
    inputSeqStart: 3,
    inputSeqEnd: 3,
  });
  const replayToken = String(sent.find((message) => message.type === 'screen-snapshot')?.replayToken);
  (router as any).handleReplayAckTimeout(ws, 'session-1', replayToken, 1, 'timeout');

  const reasons = sent
    .filter((message) => message.type === 'input:rejected')
    .map((message) => message.reason);
  assert.ok(reasons.includes('invalid-sequence'));
  assert.ok(reasons.includes('session-missing'));
  assert.ok(reasons.includes('queue-overflow'));
  assert.ok(reasons.includes('timeout-enter-safety'));

  router.destroy();
}

function testWsRouterInputWriteFailureDoesNotThrow(): void {
  const { router, ws, sent } = createWsRouterHarness({ writeInputThrows: true });

  assert.doesNotThrow(() => {
    (router as any).handleInput(ws, {
      type: 'input',
      sessionId: 'session-1',
      data: 'safe',
      inputSeqStart: 1,
      inputSeqEnd: 1,
    });
  });

  const rejected = sent.filter((message) => message.type === 'input:rejected');
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason, 'server-error');

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

function assertViewportOnlySnapshotPayload(payload: string, oldMarker: string, latestMarker: string): void {
  assert.doesNotMatch(payload, new RegExp(oldMarker));
  assert.match(payload, new RegExp(latestMarker));
}

async function testWsRouterViewportOnlySnapshotReplayStart(): Promise<void> {
  const manager = new SessionManager({
    pty: {
      termName: 'xterm-256color',
      defaultCols: 32,
      defaultRows: 4,
      useConpty: false,
      scrollbackLines: 1000,
      maxSnapshotBytes: 4096,
      shell: 'auto',
    },
    session: {
      idleDelayMs: 200,
    },
  });
  const harness = createManagedSessionHarness(manager, { cols: 32, rows: 4, scrollbackLines: 1000 });
  const authServiceStub = {
    verifyToken: () => ({ valid: true, payload: { sub: 'test-user' } }),
  } as unknown as AuthService;
  const router = new WsRouter(authServiceStub, manager);
  manager.setWsRouter(router);
  const { ws, sent } = createFakeWs();
  const oldMarker = 'WS-OLD-MARKER-001';
  const latestMarker = 'WS-LATEST-MARKER-080';

  try {
    (router as any).clients.set(ws, {
      clientId: 'client-1',
      isAlive: true,
      subscribedSessions: new Set<string>(),
      replayPendingSessions: new Map(),
    });

    await (manager as any).applyHeadlessOutput(harness.sessionId, harness.sessionData, `${oldMarker}\r\n`);
    for (let i = 2; i < 80; i += 1) {
      await (manager as any).applyHeadlessOutput(harness.sessionId, harness.sessionData, `WS-FILLER-${String(i).padStart(3, '0')}\r\n`);
    }
    await (manager as any).applyHeadlessOutput(harness.sessionId, harness.sessionData, `${latestMarker}\r\n`);

    (router as any).handleSubscribe(ws, [harness.sessionId]);
    const firstSnapshot = sent.find((message) => message.type === 'screen-snapshot');
    assert.equal(firstSnapshot?.type, 'screen-snapshot');
    assert.equal(firstSnapshot?.mode, 'authoritative');
    assertViewportOnlySnapshotPayload(String(firstSnapshot?.data), oldMarker, latestMarker);

    (router as any).handleUnsubscribe(ws, [harness.sessionId]);
    (router as any).handleSubscribe(ws, [harness.sessionId]);
    const secondSnapshot = sent
      .filter((message) => message.type === 'screen-snapshot')
      .at(-1);
    assert.equal(secondSnapshot?.type, 'screen-snapshot');
    assert.equal(secondSnapshot?.mode, 'authoritative');
    assertViewportOnlySnapshotPayload(String(secondSnapshot?.data), oldMarker, latestMarker);
  } finally {
    router.destroy();
    harness.dispose();
  }
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

function testWsRouterPreservesQueuedOutputAcrossFallbackReplayRefresh(): void {
  const snapshotState = {
    seq: 1,
    cols: 80,
    rows: 24,
    data: 'A',
    truncated: false,
    generatedAt: Date.now(),
    health: 'healthy' as 'healthy' | 'degraded',
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

    router.routeSessionOutput('session-1', 'queued-before-empty-refresh');
    snapshotState.seq = 2;
    snapshotState.data = '';
    snapshotState.truncated = true;
    router.refreshReplaySnapshots('session-1');

    const refreshed = sent.find((message) => message.type === 'screen-snapshot' && message.replayToken !== firstToken);
    assert.equal(refreshed?.type, 'screen-snapshot');
    assert.equal(refreshed?.mode, 'fallback');
    assert.equal(refreshed?.data, '');
    const secondToken = String(refreshed?.replayToken);

    (router as any).handleScreenSnapshotReady(ws, 'session-1', secondToken);

    const outputs = sent.filter((message) => message.type === 'output');
    assert.equal(outputs.length, 1);
    assert.equal(outputs[0].data, 'queued-before-empty-refresh');
  } finally {
    router.destroy();
  }
}

function testWsRouterFlushesQueuedOutputOnReplayTimeout(): void {
  const { router, ws, sent } = createWsRouterHarness({
    snapshotMode: 'fallback',
    snapshotData: '',
  });

  try {
    (router as any).handleSubscribe(ws, ['session-1']);
    const replayToken = String(sent[0].replayToken);

    router.routeSessionOutput('session-1', 'timeout-preserved-output');
    (router as any).handleReplayAckTimeout(ws, 'session-1', replayToken, 1, 'timeout');

    const outputMessages = sent.filter((message) => message.type === 'output');
    assert.equal(outputMessages.length, 1);
    assert.equal(outputMessages[0].data, 'timeout-preserved-output');
    assert.equal(sent.at(-2)?.type, 'output');
    assert.equal(sent.at(-1)?.type, 'session:ready');

    const flushed = router.getObservabilitySnapshot().recentReplayEvents.find((event) => event.kind === 'output_flushed');
    assert.equal(flushed?.details?.phase, 'timeout');
  } finally {
    router.destroy();
  }
}

function testWsRouterFlushesSnapshotCoveredOutputOnRefreshTimeout(): void {
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

    router.routeSessionOutput('session-1', 'B');
    snapshotState.seq = 2;
    snapshotState.data = 'AB';
    router.refreshReplaySnapshots('session-1');

    const refreshed = sent.find((message) => message.type === 'screen-snapshot' && message.replayToken !== firstToken);
    assert.equal(refreshed?.type, 'screen-snapshot');
    const secondToken = String(refreshed?.replayToken);

    (router as any).handleReplayAckTimeout(ws, 'session-1', secondToken, 2, 'refresh-timeout');

    const outputMessages = sent.filter((message) => message.type === 'output');
    assert.equal(outputMessages.length, 1);
    assert.equal(outputMessages[0].data, 'B');
    assert.equal(sent.at(-2)?.type, 'output');
    assert.equal(sent.at(-1)?.type, 'session:ready');

    const flushed = router.getObservabilitySnapshot().recentReplayEvents.find((event) => (
      event.kind === 'output_flushed' && event.details?.phase === 'refresh-timeout'
    ));
    assert.equal(flushed?.details?.coveredQueuedBytes, 1);
  } finally {
    router.destroy();
  }
}

function createMutableSnapshotWsRouterHarness(snapshotState: {
  seq: number;
  cols: number;
  rows: number;
  data: string;
  truncated: boolean;
  generatedAt: number;
  health: 'healthy' | 'degraded';
}, options?: {
  replayQueueLimit?: number;
  routerOptions?: ConstructorParameters<typeof WsRouter>[2];
  fakeWsOptions?: Parameters<typeof createFakeWs>[0];
}) {
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
    getReplayQueueLimit: () => options?.replayQueueLimit ?? 64,
    writeInput: () => true,
    resize: () => true,
  } as unknown as SessionManager;
  const authServiceStub = {
    verifyToken: () => ({ valid: true, payload: { sub: 'test-user' } }),
  } as unknown as AuthService;
  const router = new WsRouter(authServiceStub, sessionManagerStub, {
    inputReliabilityMode: 'queue',
    ...options?.routerOptions,
  });
  const fake = createFakeWs(options?.fakeWsOptions);
  const { ws, sent } = fake;

  (router as any).clients.set(ws, {
    clientId: 'client-1',
    isAlive: true,
    subscribedSessions: new Set<string>(),
    replayPendingSessions: new Map(),
    screenRepairPendingSessions: new Map(),
  });

  return { router, ws, sent, fake };
}

function testWsRouterDoesNotTreatFallbackSubstringAsCoveredOutput(): void {
  const snapshotState = {
    seq: 1,
    cols: 80,
    rows: 24,
    data: 'old prompt repeated-output',
    truncated: false,
    generatedAt: Date.now(),
    health: 'degraded' as const,
  };
  const { router, ws, sent } = createMutableSnapshotWsRouterHarness(snapshotState);

  try {
    (router as any).handleSubscribe(ws, ['session-1']);
    const firstToken = String(sent[0].replayToken);

    router.routeSessionOutput('session-1', 'repeated-output', 2);
    snapshotState.data = 'old prompt repeated-output';
    router.refreshReplaySnapshots('session-1');

    const refreshed = sent.find((message) => message.type === 'screen-snapshot' && message.replayToken !== firstToken);
    assert.equal(refreshed?.type, 'screen-snapshot');

    (router as any).handleScreenSnapshotReady(ws, 'session-1', String(refreshed?.replayToken));

    const outputMessages = sent.filter((message) => message.type === 'output');
    assert.equal(outputMessages.length, 1);
    assert.equal(outputMessages[0].data, 'repeated-output');
  } finally {
    router.destroy();
  }
}

function testWsRouterDoesNotDuplicateFallbackCoveredOutputOnAck(): void {
  const snapshotState = {
    seq: 1,
    cols: 80,
    rows: 24,
    data: 'A',
    truncated: false,
    generatedAt: Date.now(),
    health: 'degraded' as const,
  };
  const { router, ws, sent } = createMutableSnapshotWsRouterHarness(snapshotState);

  try {
    (router as any).handleSubscribe(ws, ['session-1']);
    const firstToken = String(sent[0].replayToken);

    router.routeSessionOutput('session-1', 'B', 2);
    snapshotState.seq = 2;
    snapshotState.data = 'AB';
    router.refreshReplaySnapshots('session-1');

    const refreshed = sent.find((message) => message.type === 'screen-snapshot' && message.replayToken !== firstToken);
    assert.equal(refreshed?.type, 'screen-snapshot');

    (router as any).handleScreenSnapshotReady(ws, 'session-1', String(refreshed?.replayToken));

    const outputMessages = sent.filter((message) => message.type === 'output');
    assert.equal(outputMessages.length, 0);
    const covered = router.getObservabilitySnapshot().recentReplayEvents.find((event) => (
      event.kind === 'output_covered_by_snapshot'
    ));
    assert.equal(covered?.details?.coveredQueuedBytes, 1);
  } finally {
    router.destroy();
  }
}

function testWsRouterPreservesFallbackCoveredOutputAcrossRepeatedRefreshAck(): void {
  const snapshotState = {
    seq: 1,
    cols: 80,
    rows: 24,
    data: 'A',
    truncated: false,
    generatedAt: Date.now(),
    health: 'degraded' as const,
  };
  const { router, ws, sent } = createMutableSnapshotWsRouterHarness(snapshotState);

  try {
    (router as any).handleSubscribe(ws, ['session-1']);
    const firstToken = String(sent[0].replayToken);

    router.routeSessionOutput('session-1', 'B', 2);
    snapshotState.seq = 2;
    snapshotState.data = 'AB';
    router.refreshReplaySnapshots('session-1');

    const firstRefresh = sent.find((message) => message.type === 'screen-snapshot' && message.replayToken !== firstToken);
    assert.equal(firstRefresh?.type, 'screen-snapshot');

    snapshotState.generatedAt = Date.now();
    router.refreshReplaySnapshots('session-1');

    const snapshots = sent.filter((message) => message.type === 'screen-snapshot');
    assert.equal(snapshots.length, 3);
    const latestToken = String(snapshots.at(-1)?.replayToken);

    (router as any).handleScreenSnapshotReady(ws, 'session-1', latestToken);

    const outputMessages = sent.filter((message) => message.type === 'output');
    assert.equal(outputMessages.length, 0);
    const coveredEvents = router.getObservabilitySnapshot().recentReplayEvents.filter((event) => (
      event.kind === 'output_covered_by_snapshot'
    ));
    assert.equal(coveredEvents.length, 1);
    assert.equal(coveredEvents[0].details?.coveredQueuedBytes, 1);
  } finally {
    router.destroy();
  }
}

function testWsRouterFlushesFallbackCoveredOutputOnRefreshTimeout(): void {
  const snapshotState = {
    seq: 1,
    cols: 80,
    rows: 24,
    data: 'A',
    truncated: false,
    generatedAt: Date.now(),
    health: 'degraded' as const,
  };
  const { router, ws, sent } = createMutableSnapshotWsRouterHarness(snapshotState);

  try {
    (router as any).handleSubscribe(ws, ['session-1']);
    const firstToken = String(sent[0].replayToken);

    router.routeSessionOutput('session-1', 'B', 2);
    snapshotState.seq = 2;
    snapshotState.data = 'AB';
    router.refreshReplaySnapshots('session-1');

    const refreshed = sent.find((message) => message.type === 'screen-snapshot' && message.replayToken !== firstToken);
    assert.equal(refreshed?.type, 'screen-snapshot');

    (router as any).handleReplayAckTimeout(ws, 'session-1', String(refreshed?.replayToken), 2, 'refresh-timeout');

    const outputMessages = sent.filter((message) => message.type === 'output');
    assert.equal(outputMessages.length, 1);
    assert.equal(outputMessages[0].data, 'B');
    assert.equal(sent.at(-2)?.type, 'output');
    assert.equal(sent.at(-1)?.type, 'session:ready');
  } finally {
    router.destroy();
  }
}

function testWsRouterReplayTimeoutUsesUtf8ByteBoundedTail(): void {
  const snapshotState = {
    seq: 1,
    cols: 80,
    rows: 24,
    data: 'A',
    truncated: false,
    generatedAt: Date.now(),
    health: 'degraded' as const,
  };
  const { router, ws, sent } = createMutableSnapshotWsRouterHarness(snapshotState, {
    replayQueueLimit: 16,
  });

  try {
    (router as any).handleSubscribe(ws, ['session-1']);
    const firstToken = String(sent[0].replayToken);

    const coveredChunk = '가'.repeat(8);
    router.routeSessionOutput('session-1', coveredChunk, 2);
    const firstQueued = router.getObservabilitySnapshot().recentReplayEvents.find((event) => (
      event.kind === 'output_queued' && event.details?.outputScreenSeq === 2
    ));
    assert.equal(firstQueued?.details?.outputBytes, Buffer.byteLength(coveredChunk, 'utf8'));
    assert.equal(Number(firstQueued?.details?.queuedBytes) <= 16, true);

    snapshotState.seq = 2;
    snapshotState.data = `A${coveredChunk}`;
    snapshotState.generatedAt = Date.now() + 1;
    router.refreshReplaySnapshots('session-1');

    const refreshed = sent.find((message) => message.type === 'screen-snapshot' && message.replayToken !== firstToken);
    assert.equal(refreshed?.type, 'screen-snapshot');
    const secondToken = String(refreshed?.replayToken);

    const queuedChunk = '🙂'.repeat(5);
    router.routeSessionOutput('session-1', queuedChunk, 3);
    const secondQueued = router.getObservabilitySnapshot().recentReplayEvents.find((event) => (
      event.kind === 'output_queued' && event.details?.outputScreenSeq === 3
    ));
    assert.equal(secondQueued?.details?.outputBytes, Buffer.byteLength(queuedChunk, 'utf8'));
    assert.equal(Number(secondQueued?.details?.queuedBytes) <= 16, true);

    (router as any).handleReplayAckTimeout(ws, 'session-1', secondToken, 2, 'refresh-timeout');

    const outputMessages = sent.filter((message) => message.type === 'output');
    assert.equal(outputMessages.length, 1);
    const outputData = String(outputMessages[0].data);
    assert.equal(Buffer.byteLength(outputData, 'utf8') <= 16, true);
    assert.equal(outputData.includes('\uFFFD'), false);
    assert.equal(sent.at(-2)?.type, 'output');
    assert.equal(sent.at(-1)?.type, 'session:ready');

    const flushed = router.getObservabilitySnapshot().recentReplayEvents.find((event) => (
      event.kind === 'output_flushed' && event.details?.phase === 'refresh-timeout'
    ));
    assert.equal(Number(flushed?.details?.coveredQueuedBytes) > 0, true);
    assert.equal(Number(flushed?.details?.queuedBytes) > 0, true);
    assert.equal(flushed?.details?.outputBytes, Buffer.byteLength(outputData, 'utf8'));
    assert.equal(Number(flushed?.details?.outputBytes) <= 16, true);
  } finally {
    router.destroy();
  }
}

function testWsRouterSuppressesUnchangedEmptyFallbackReplayRefresh(): void {
  const snapshotState = {
    seq: 1,
    cols: 80,
    rows: 24,
    data: '',
    truncated: true,
    generatedAt: Date.now(),
    health: 'degraded' as const,
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
    const pendingBefore = (router as any).clients.get(ws).replayPendingSessions.get('session-1');
    const firstToken = String(pendingBefore.replayToken);

    router.refreshReplaySnapshots('session-1');
    router.refreshReplaySnapshots('session-1');

    const pendingAfter = (router as any).clients.get(ws).replayPendingSessions.get('session-1');
    const snapshotMessages = sent.filter((message) => message.type === 'screen-snapshot');
    assert.equal(snapshotMessages.length, 1);
    assert.equal(String(pendingAfter.replayToken), firstToken);
    assert.equal(router.getObservabilitySnapshot().replayRefreshCount, 0);

    const skippedEvents = router.getObservabilitySnapshot().recentReplayEvents.filter((event) => (
      event.kind === 'snapshot_refresh_skipped'
      && event.details?.reason === 'unchanged-empty-fallback'
    ));
    assert.equal(skippedEvents.length, 2);
  } finally {
    router.destroy();
  }
}

function safeSendRouterOptions(
  mode: 'direct' | 'safe-send-observe' | 'safe-send-enforce' = 'safe-send-enforce',
): ConstructorParameters<typeof WsRouter>[2] {
  return {
    inputReliabilityMode: 'queue',
    resourceLimits: {
      ws: resourceLimitsSchema.parse({
        ws: {
          serverBufferedHighWaterBytes: 1024,
          serverBufferedHardLimitBytes: 2048,
          perClientOutputQueueMaxBytes: 2048,
          perClientControlQueueMaxBytes: 1024,
          outputCoalesceWindowMs: 1,
        },
      }).ws,
    },
    stabilityModes: {
      wsSendMode: mode,
    },
  };
}

function testWsRouterSafeSendQueuesOutputOverHighWater(): void {
  const { router, ws, sent, fake } = createWsRouterHarness({
    routerOptions: safeSendRouterOptions(),
    fakeWsOptions: { bufferedAmount: 1500 },
  });

  try {
    (router as any).sessionSubscribers.set('session-1', new Set([ws]));
    router.routeSessionOutput('session-1', 'queued-output');
    assert.equal(sent.length, 0);
    const queued = router.getObservabilitySnapshot();
    assert.equal((queued as any).transportQueuedClientCount, 1);
    assert.equal((queued as any).transportOutputQueuedBytes > 0, true);

    fake.setBufferedAmount(0);
    (router as any).flushTransportQueue(ws);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'output');
    assert.equal(sent[0].data, 'queued-output');
  } finally {
    router.destroy();
  }
}

async function testWsRouterSafeSendRetryTimerDrainsQueuedOutput(): Promise<void> {
  const { router, ws, sent, fake } = createWsRouterHarness({
    routerOptions: safeSendRouterOptions(),
    fakeWsOptions: { bufferedAmount: 1500 },
  });

  try {
    (router as any).sessionSubscribers.set('session-1', new Set([ws]));
    router.routeSessionOutput('session-1', 'timer-drained-output');
    assert.equal(sent.length, 0);

    fake.setBufferedAmount(0);
    await delay(60);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'output');
    assert.equal(sent[0].data, 'timer-drained-output');
    assert.equal((router.getObservabilitySnapshot() as any).transportQueuedClientCount, 0);
  } finally {
    router.destroy();
  }
}

function testWsRouterSafeSendClosesHardLimitSlowClient(): void {
  const { router, ws, sent, fake } = createWsRouterHarness({
    routerOptions: safeSendRouterOptions(),
    fakeWsOptions: { bufferedAmount: 2500 },
  });

  try {
    (router as any).sessionSubscribers.set('session-1', new Set([ws]));
    router.routeSessionOutput('session-1', 'slow-client-output');
    assert.equal(sent.length, 0);
    assert.equal(fake.getCloseCode(), 1013);
    assert.match(fake.getCloseReason() ?? '', /backpressure/i);
    const stats = router.getObservabilitySnapshot();
    assert.equal((stats as any).transportSlowClientCloseCount, 1);
  } finally {
    router.destroy();
  }
}

function testWsRouterSafeSendClosesOnSendCallbackErrors(): void {
  const { router, ws, sent, fake } = createWsRouterHarness({
    routerOptions: safeSendRouterOptions(),
  });

  try {
    fake.setNextSendError(new Error('simulated send failure'));
    router.sendTo(ws, { type: 'session:ready', sessionId: 'session-1' });
    assert.equal(sent.length, 1);
    const stats = router.getObservabilitySnapshot();
    assert.equal((stats as any).transportSendErrorCount, 1);
    assert.equal((stats as any).transportSlowClientCloseCount, 1);
    assert.equal(fake.getCloseCode(), 1013);
  } finally {
    router.destroy();
  }
}

function testWsRouterSafeSendPrioritizesIndependentControlOverOutputBacklog(): void {
  const { router, ws, sent, fake } = createWsRouterHarness({
    routerOptions: safeSendRouterOptions(),
    fakeWsOptions: { bufferedAmount: 1500 },
  });

  try {
    (router as any).sessionSubscribers.set('session-1', new Set([ws]));
    router.routeSessionOutput('session-1', 'queued-output');
    router.sendTo(ws, { type: 'pong' });
    assert.equal(sent.length, 0);

    fake.setBufferedAmount(0);
    (router as any).flushTransportQueue(ws);

    assert.equal(sent[0].type, 'pong');
    assert.equal(sent[1].type, 'output');
    assert.equal(sent[1].data, 'queued-output');
  } finally {
    router.destroy();
  }
}

function testWsRouterSafeSendQueuesProjectedHighWaterOutput(): void {
  const { router, ws, sent, fake } = createWsRouterHarness({
    routerOptions: safeSendRouterOptions(),
    fakeWsOptions: { bufferedAmount: 900 },
  });

  try {
    (router as any).sessionSubscribers.set('session-1', new Set([ws]));
    router.routeSessionOutput('session-1', 'x'.repeat(400));
    assert.equal(sent.length, 0);
    assert.equal((router.getObservabilitySnapshot() as any).transportQueuedClientCount, 1);

    fake.setBufferedAmount(0);
    (router as any).flushTransportQueue(ws);
    assert.equal(sent[0].type, 'output');
  } finally {
    router.destroy();
  }
}

function testWsRouterSafeSendClosesProjectedHardLimitClient(): void {
  const { router, ws, sent, fake } = createWsRouterHarness({
    routerOptions: safeSendRouterOptions(),
    fakeWsOptions: { bufferedAmount: 1900 },
  });

  try {
    (router as any).sessionSubscribers.set('session-1', new Set([ws]));
    router.routeSessionOutput('session-1', 'x'.repeat(400));
    assert.equal(sent.length, 0);
    assert.equal(fake.getCloseCode(), 1013);
    assert.match(fake.getCloseReason() ?? '', /hard-limit/i);
  } finally {
    router.destroy();
  }
}

function testWsRouterSafeSendPreservesOutputQueuedDuringInflightSend(): void {
  const { router, ws, sent, fake } = createWsRouterHarness({
    routerOptions: safeSendRouterOptions(),
    fakeWsOptions: {
      bufferedAmount: 1500,
      deferSendCallbacks: true,
    },
  });

  try {
    (router as any).sessionSubscribers.set('session-1', new Set([ws]));
    router.routeSessionOutput('session-1', 'first-output');
    assert.equal(sent.length, 0);

    fake.setBufferedAmount(0);
    (router as any).flushTransportQueue(ws);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'output');
    assert.equal(sent[0].data, 'first-output');

    router.routeSessionOutput('session-1', 'second-output');
    assert.equal(sent.length, 1);

    fake.flushNextSendCallback();
    assert.equal(sent.length, 2);
    assert.equal(sent[1].type, 'output');
    assert.equal(sent[1].data, 'second-output');
    assert.equal((router.getObservabilitySnapshot() as any).transportOutputQueuedBytes, 0);
  } finally {
    router.destroy();
  }
}

function testWsRouterSafeSendPreservesSameSessionLifecycleOrdering(): void {
  const { router, ws, sent, fake } = createWsRouterHarness({
    routerOptions: safeSendRouterOptions(),
    fakeWsOptions: { bufferedAmount: 1500 },
  });

  try {
    (router as any).sessionSubscribers.set('session-1', new Set([ws]));
    router.routeSessionOutput('session-1', 'queued-output');
    router.sendSessionEvent('session-1', 'session:exited', { exitCode: 0 });
    assert.equal(sent.length, 0);

    fake.setBufferedAmount(0);
    (router as any).flushTransportQueue(ws);
    (router as any).flushTransportQueue(ws);
    assert.equal(sent[0].type, 'output');
    assert.equal(sent[0].data, 'queued-output');
    assert.equal(sent[1].type, 'session:exited');
  } finally {
    router.destroy();
  }
}

function testWsRouterDirectSendCallbackErrorDoesNotClose(): void {
  const { router, ws, sent, fake } = createWsRouterHarness({
    routerOptions: safeSendRouterOptions('direct'),
  });

  try {
    fake.setNextSendError(new Error('simulated direct send failure'));
    router.sendTo(ws, { type: 'session:ready', sessionId: 'session-1' });
    assert.equal(sent.length, 1);
    const stats = router.getObservabilitySnapshot();
    assert.equal((stats as any).transportSendErrorCount, 1);
    assert.equal((stats as any).transportSlowClientCloseCount, 0);
    assert.equal(fake.getCloseCode(), undefined);
  } finally {
    router.destroy();
  }
}

function testWsRouterObserveSendCallbackErrorDoesNotClose(): void {
  const { router, ws, sent, fake } = createWsRouterHarness({
    routerOptions: safeSendRouterOptions('safe-send-observe'),
    fakeWsOptions: { bufferedAmount: 1500 },
  });

  try {
    fake.setNextSendError(new Error('simulated observe send failure'));
    router.sendTo(ws, { type: 'session:ready', sessionId: 'session-1' });
    assert.equal(sent.length, 1);
    const stats = router.getObservabilitySnapshot();
    assert.equal((stats as any).transportBackpressureObserveCount, 1);
    assert.equal((stats as any).transportSendErrorCount, 1);
    assert.equal((stats as any).transportSlowClientCloseCount, 0);
    assert.equal(fake.getCloseCode(), undefined);
  } finally {
    router.destroy();
  }
}

async function testWsRouterSafeSendRollbackFlushesQueuedOutputWithoutClose(): Promise<void> {
  for (const mode of ['direct', 'safe-send-observe'] as const) {
    const { router, ws, sent, fake } = createWsRouterHarness({
      routerOptions: safeSendRouterOptions(),
      fakeWsOptions: { bufferedAmount: 1500 },
    });

    try {
      (router as any).sessionSubscribers.set('session-1', new Set([ws]));
      router.routeSessionOutput('session-1', `rollback-${mode}`);
      assert.equal(sent.length, 0);
      assert.equal((router.getObservabilitySnapshot() as any).transportQueuedClientCount, 1);

      router.updateRuntimeConfig({
        stabilityModes: {
          wsSendMode: mode,
        },
      });

      assert.equal(sent.length, 1);
      assert.equal(sent[0].type, 'output');
      assert.equal(sent[0].data, `rollback-${mode}`);
      assert.equal((router.getObservabilitySnapshot() as any).transportQueuedClientCount, 0);
      assert.equal((router.getObservabilitySnapshot() as any).transportSlowClientCloseCount, 0);
      assert.equal(fake.getCloseCode(), undefined);

      await delay(60);
      assert.equal(sent.length, 1);
    } finally {
      router.destroy();
    }
  }
}

function testWsRouterSafeSendCoalescesQueuedOutput(): void {
  const { router, ws, sent, fake } = createWsRouterHarness({
    routerOptions: safeSendRouterOptions(),
    fakeWsOptions: { bufferedAmount: 1500 },
  });

  try {
    (router as any).sessionSubscribers.set('session-1', new Set([ws]));
    router.routeSessionOutput('session-1', 'A');
    router.routeSessionOutput('session-1', 'B');
    assert.equal(sent.length, 0);

    fake.setBufferedAmount(0);
    (router as any).flushTransportQueue(ws);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'output');
    assert.equal(sent[0].data, 'AB');
    const stats = router.getObservabilitySnapshot();
    assert.equal((stats as any).transportOutputCoalesceCount, 1);
  } finally {
    router.destroy();
  }
}

async function testWsRouterSafeSendRespectsOutputCoalesceWindow(): Promise<void> {
  const { router, ws, sent, fake } = createWsRouterHarness({
    routerOptions: safeSendRouterOptions(),
    fakeWsOptions: { bufferedAmount: 1500 },
  });

  try {
    (router as any).sessionSubscribers.set('session-1', new Set([ws]));
    router.routeSessionOutput('session-1', 'A');
    await delay(5);
    router.routeSessionOutput('session-1', 'B');
    assert.equal((router.getObservabilitySnapshot() as any).transportOutputCoalesceCount, 0);

    fake.setBufferedAmount(0);
    (router as any).flushTransportQueue(ws);
    assert.equal(sent[0].data, 'A');
    assert.equal(sent[1].data, 'B');
  } finally {
    router.destroy();
  }
}

function testWsRouterSafeSendClosesOnControlQueueOverflow(): void {
  const { router, ws, sent, fake } = createWsRouterHarness({
    routerOptions: safeSendRouterOptions(),
    fakeWsOptions: { bufferedAmount: 1500 },
  });

  try {
    (router as any).sessionSubscribers.set('session-1', new Set([ws]));
    router.routeSessionOutput('session-1', 'queued-output');
    fake.setBufferedAmount(0);
    router.sendTo(ws, { type: 'pong', data: 'x'.repeat(1500) });
    assert.equal(sent.length, 0);
    assert.equal(fake.getCloseCode(), 1013);
    const stats = router.getObservabilitySnapshot();
    assert.equal((stats as any).transportQueueOverflowCount, 1);
  } finally {
    router.destroy();
  }
}

function testSessionManagerBroadcastUsesWsRouterPolicy(): void {
  const manager = new SessionManager({
    pty: {
      termName: 'xterm-256color',
      defaultCols: 80,
      defaultRows: 24,
      useConpty: false,
      scrollbackLines: 1000,
      maxSnapshotBytes: 4096,
      shell: 'auto',
    },
    session: {
      idleDelayMs: 200,
    },
  });
  const sent: Array<{ sessionId: string; event: string; payload: object }> = [];
  (manager as any).wsRouter = {
    sendSessionEvent: (sessionId: string, event: string, payload: object) => {
      sent.push({ sessionId, event, payload });
    },
  };

  manager.broadcastWs('session-1', 'session:exited', { exitCode: 0 });
  assert.deepEqual(sent, [
    {
      sessionId: 'session-1',
      event: 'session:exited',
      payload: { exitCode: 0 },
    },
  ]);
}

function testWsRouterSafeSendObserveDoesNotQueue(): void {
  const { router, ws, sent } = createWsRouterHarness({
    routerOptions: safeSendRouterOptions('safe-send-observe'),
    fakeWsOptions: { bufferedAmount: 1500 },
  });

  try {
    router.sendTo(ws, { type: 'session:ready', sessionId: 'session-1' });
    assert.equal(sent.length, 1);
    const stats = router.getObservabilitySnapshot();
    assert.equal((stats as any).transportBackpressureObserveCount, 1);
    assert.equal((stats as any).transportQueuedClientCount, 0);
  } finally {
    router.destroy();
  }
}

function testWsRouterSafeSendPreservesReplayFlushOrdering(): void {
  const { router, ws, sent, fake } = createWsRouterHarness({
    routerOptions: safeSendRouterOptions(),
    fakeWsOptions: { bufferedAmount: 1500 },
  });

  try {
    (router as any).handleSubscribe(ws, ['session-1']);
    assert.equal(sent.length, 0);
    fake.setBufferedAmount(0);
    (router as any).flushTransportQueue(ws);
    const replayToken = String(sent[0].replayToken);
    const baselineCount = sent.length;

    fake.setBufferedAmount(1500);
    router.routeSessionOutput('session-1', 'live-after-snapshot');
    (router as any).handleScreenSnapshotReady(ws, 'session-1', replayToken);
    assert.equal(sent.length, baselineCount);

    fake.setBufferedAmount(0);
    (router as any).flushTransportQueue(ws);
    (router as any).flushTransportQueue(ws);
    assert.equal(sent[baselineCount].type, 'output');
    assert.equal(sent[baselineCount].data, 'live-after-snapshot');
    assert.equal(sent[baselineCount + 1].type, 'session:ready');
  } finally {
    router.destroy();
  }
}

function testWsRouterSafeSendPreservesFallbackReplayFlushOrdering(): void {
  const { router, ws, sent, fake } = createWsRouterHarness({
    snapshotMode: 'fallback',
    snapshotData: '',
    routerOptions: safeSendRouterOptions(),
    fakeWsOptions: { bufferedAmount: 1500 },
  });

  try {
    (router as any).handleSubscribe(ws, ['session-1']);
    assert.equal(sent.length, 0);

    fake.setBufferedAmount(0);
    (router as any).flushTransportQueue(ws);
    const snapshot = sent.find((message) => message.type === 'screen-snapshot');
    assert.equal(snapshot?.type, 'screen-snapshot');
    assert.equal(snapshot?.mode, 'fallback');
    const replayToken = String(snapshot?.replayToken);
    const baselineCount = sent.length;

    fake.setBufferedAmount(1500);
    router.routeSessionOutput('session-1', 'fallback-safe-send-output', 2);
    (router as any).handleScreenSnapshotReady(ws, 'session-1', replayToken);
    assert.equal(sent.length, baselineCount);

    fake.setBufferedAmount(0);
    (router as any).flushTransportQueue(ws);
    (router as any).flushTransportQueue(ws);
    assert.equal(sent[baselineCount].type, 'output');
    assert.equal(sent[baselineCount].data, 'fallback-safe-send-output');
    assert.equal(sent[baselineCount + 1].type, 'session:ready');
  } finally {
    router.destroy();
  }
}

async function testWsRouterSafeSendPreservesScreenRepairFlushOrdering(): Promise<void> {
  const { router, ws, sent, fake } = createWsRouterHarness({
    routerOptions: safeSendRouterOptions(),
  });

  try {
    (router as any).handleSubscribe(ws, ['session-1']);
    const replayToken = String(sent[0].replayToken);
    (router as any).handleScreenSnapshotReady(ws, 'session-1', replayToken);
    await (router as any).handleScreenRepairRequest(ws, {
      type: 'screen-repair',
      sessionId: 'session-1',
      cols: 80,
      rows: 24,
      reason: 'manual',
      clientAtBottom: true,
      clientBufferType: 'normal',
    });
    const repair = sent.find((message) => message.type === 'screen-repair');
    const repairToken = String(repair?.repairToken);

    fake.setBufferedAmount(1500);
    router.routeSessionOutput('session-1', 'repair-queued-output', 2);
    (router as any).handleScreenRepairReady(ws, 'session-1', repairToken);
    const beforeFlushCount = sent.length;

    fake.setBufferedAmount(0);
    (router as any).flushTransportQueue(ws);
    const flushed = sent.slice(beforeFlushCount);
    assert.equal(flushed[0].type, 'output');
    assert.equal(flushed[0].data, 'repair-queued-output');
  } finally {
    router.destroy();
  }
}

async function testWsRouterSendsScreenRepairAndQueuesOutputUntilAck(): Promise<void> {
  const { router, ws, sent } = createWsRouterHarness();

  try {
    (router as any).handleSubscribe(ws, ['session-1']);
    (router as any).handleScreenSnapshotReady(ws, 'session-1', String(sent[0].replayToken));

    await (router as any).handleScreenRepairRequest(ws, {
      type: 'screen-repair',
      sessionId: 'session-1',
      cols: 80,
      rows: 24,
      reason: 'manual',
      clientAtBottom: true,
      clientBufferType: 'normal',
    });

    const repair = sent.find((message) => message.type === 'screen-repair');
    assert.equal(repair?.type, 'screen-repair');
    assert.equal(repair?.cols, 80);
    assert.equal(repair?.rows, 24);
    assert.equal((repair as any)?.viewportRows.length, 1);
    assert.equal(sent.filter((message) => message.type === 'screen-snapshot').length, 1);

    router.routeSessionOutput('session-1', 'repair-pending-output');
    assert.equal(sent.filter((message) => message.type === 'output').length, 0);

    (router as any).handleScreenRepairReady(ws, 'session-1', String(repair?.repairToken));

    const outputs = sent.filter((message) => message.type === 'output');
    assert.equal(outputs.length, 1);
    assert.equal(outputs[0].data, 'repair-pending-output');
  } finally {
    router.destroy();
  }
}

async function testWsRouterScreenRepairSentTelemetryByteLengthUsesUtf8Bytes(): Promise<void> {
  const ansiPatch = '\x1b[1;1H가🙂';
  const { router, ws, sent } = createWsRouterHarness({
    getScreenRepair: async () => ({
      ok: true as const,
      payload: {
        seq: 2,
        cols: 80,
        rows: 24,
        bufferType: 'normal' as const,
        cursor: { x: 0, y: 0 },
        viewportRows: [{ y: 0, ansi: '가🙂', text: '가🙂', wrapped: false }],
        ansiPatch,
      },
    }),
  });

  try {
    (router as any).handleSubscribe(ws, ['session-1']);
    const replayToken = String(sent.find((message) => message.type === 'screen-snapshot')?.replayToken);
    (router as any).handleScreenSnapshotReady(ws, 'session-1', replayToken);

    await (router as any).handleScreenRepairRequest(ws, {
      type: 'screen-repair',
      sessionId: 'session-1',
      cols: 80,
      rows: 24,
      reason: 'manual',
      clientAtBottom: true,
      clientBufferType: 'normal',
    });

    const event = router.getObservabilitySnapshot().recentReplayEvents.find((item) => item.kind === 'screen_repair_sent');
    assert.equal(event?.details?.byteLength, Buffer.byteLength(ansiPatch, 'utf8'));
    assert.equal(Number(event?.details?.byteLength) > ansiPatch.length, true);
  } finally {
    router.destroy();
  }
}

async function testWsRouterQueuesOutputDuringScreenRepairGeneration(): Promise<void> {
  const manager = new SessionManager({
    pty: {
      termName: 'xterm-256color',
      defaultCols: 10,
      defaultRows: 4,
      useConpty: false,
      scrollbackLines: 1000,
      maxSnapshotBytes: 4096,
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
  const pendingCallbacks: Array<() => void> = [];

  try {
    (router as any).clients.set(ws, {
      clientId: 'client-1',
      isAlive: true,
      subscribedSessions: new Set<string>(),
      replayPendingSessions: new Map(),
      screenRepairPendingSessions: new Map(),
    });

    (router as any).handleSubscribe(ws, [harness.sessionId]);
    (router as any).handleScreenSnapshotReady(ws, harness.sessionId, String(sent[0].replayToken));

    const originalWrite = harness.sessionData.headless!.terminal.write.bind(harness.sessionData.headless!.terminal);
    harness.sessionData.headless!.terminal.write = ((data: string | Uint8Array, callback?: () => void) => {
      originalWrite(data, () => {
        pendingCallbacks.push(() => callback?.());
      });
    }) as typeof harness.sessionData.headless.terminal.write;

    (manager as any).queueHeadlessOutput(harness.sessionId, harness.sessionData, 'INCLUDED-IN-REPAIR');

    const requestPromise = (router as any).handleScreenRepairRequest(ws, {
      type: 'screen-repair',
      sessionId: harness.sessionId,
      cols: 10,
      rows: 4,
      reason: 'resize',
      clientAtBottom: true,
      clientBufferType: 'normal',
    });

    for (let attempt = 0; pendingCallbacks.length === 0 && attempt < 20; attempt += 1) {
      await delay(1);
    }
    assert.equal(pendingCallbacks.length, 1);
    pendingCallbacks.shift()?.();

    await requestPromise;
    const repair = sent.find((message) => message.type === 'screen-repair');
    assert.equal(repair?.type, 'screen-repair');
    const repairedText = (((repair as any)?.viewportRows ?? []) as Array<{ text?: string }>)
      .map((row) => row.text ?? '')
      .join('');
    assert.match(repairedText, /INCLUDED-IN-REPAIR/);
    assert.equal(sent.filter((message) => message.type === 'output').length, 0);

    (router as any).handleScreenRepairReady(ws, harness.sessionId, String(repair?.repairToken));
    assert.equal(sent.filter((message) => message.type === 'output').length, 0);
  } finally {
    router.destroy();
    harness.dispose();
  }
}

async function createCoveredScreenRepairHarness(output: string) {
  const manager = new SessionManager({
    pty: {
      termName: 'xterm-256color',
      defaultCols: 10,
      defaultRows: 4,
      useConpty: false,
      scrollbackLines: 1000,
      maxSnapshotBytes: 4096,
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
  const pendingCallbacks: Array<() => void> = [];

  (router as any).clients.set(ws, {
    clientId: 'client-1',
    isAlive: true,
    subscribedSessions: new Set<string>(),
    replayPendingSessions: new Map(),
    screenRepairPendingSessions: new Map(),
  });

  (router as any).handleSubscribe(ws, [harness.sessionId]);
  (router as any).handleScreenSnapshotReady(ws, harness.sessionId, String(sent[0].replayToken));

  const originalWrite = harness.sessionData.headless!.terminal.write.bind(harness.sessionData.headless!.terminal);
  harness.sessionData.headless!.terminal.write = ((data: string | Uint8Array, callback?: () => void) => {
    originalWrite(data, () => {
      pendingCallbacks.push(() => callback?.());
    });
  }) as typeof harness.sessionData.headless.terminal.write;

  (manager as any).queueHeadlessOutput(harness.sessionId, harness.sessionData, output);

  const requestPromise = (router as any).handleScreenRepairRequest(ws, {
    type: 'screen-repair',
    sessionId: harness.sessionId,
    cols: 10,
    rows: 4,
    reason: 'resize',
    clientAtBottom: true,
    clientBufferType: 'normal',
  });

  for (let attempt = 0; pendingCallbacks.length === 0 && attempt < 20; attempt += 1) {
    await delay(1);
  }
  assert.equal(pendingCallbacks.length, 1);
  pendingCallbacks.shift()?.();

  await requestPromise;
  const repair = sent.find((message) => message.type === 'screen-repair');
  assert.equal(repair?.type, 'screen-repair');
  assert.equal(sent.filter((message) => message.type === 'output').length, 0);

  return { router, ws, sent, harness, repair };
}

async function testWsRouterFlushesOutputAfterScreenRepairSnapshotSeq(): Promise<void> {
  const repairSignal = createTestDeferredSignal<unknown>();
  const { router, ws, sent } = createWsRouterHarness({
    getScreenRepair: (_id, expected) => repairSignal.promise.then(() => ({
      ok: true as const,
      payload: {
        seq: 11,
        cols: expected.cols,
        rows: expected.rows,
        bufferType: expected.bufferType,
        cursor: { x: 0, y: 0 },
        viewportRows: [{ y: 0, ansi: 'late-repair-row', text: 'late-repair-row', wrapped: false }],
        ansiPatch: '\x1b[1;1Hlate-repair-row',
      },
    })),
  });

  try {
    (router as any).handleSubscribe(ws, ['session-1']);
    (router as any).handleScreenSnapshotReady(ws, 'session-1', String(sent[0].replayToken));

    const requestPromise = (router as any).handleScreenRepairRequest(ws, {
      type: 'screen-repair',
      sessionId: 'session-1',
      cols: 80,
      rows: 24,
      reason: 'resize',
      clientAtBottom: true,
      clientBufferType: 'normal',
    });

    router.routeSessionOutput('session-1', 'after-repair-seq', 12);
    assert.equal(sent.filter((message) => message.type === 'output').length, 0);
    assert.equal(sent.filter((message) => message.type === 'screen-repair').length, 0);

    repairSignal.resolve(undefined);
    await requestPromise;
    const repair = sent.find((message) => message.type === 'screen-repair');
    assert.equal(repair?.type, 'screen-repair');
    assert.equal(sent.filter((message) => message.type === 'output').length, 0);

    (router as any).handleScreenRepairReady(ws, 'session-1', String(repair?.repairToken));
    const outputs = sent.filter((message) => message.type === 'output');
    assert.equal(outputs.length, 1);
    assert.equal(outputs[0].data, 'after-repair-seq');
  } finally {
    router.destroy();
  }
}

async function testWsRouterFlushesScreenRepairOutputOnAckTimeout(): Promise<void> {
  const { router, ws, sent } = createWsRouterHarness();

  try {
    (router as any).handleSubscribe(ws, ['session-1']);
    (router as any).handleScreenSnapshotReady(ws, 'session-1', String(sent[0].replayToken));

    await (router as any).handleScreenRepairRequest(ws, {
      type: 'screen-repair',
      sessionId: 'session-1',
      cols: 80,
      rows: 24,
      reason: 'manual',
      clientAtBottom: true,
      clientBufferType: 'normal',
    });

    const repair = sent.find((message) => message.type === 'screen-repair');
    assert.equal(repair?.type, 'screen-repair');
    router.routeSessionOutput('session-1', 'timeout-flushed-output');
    assert.equal(sent.filter((message) => message.type === 'output').length, 0);

    (router as any).handleScreenRepairAckTimeout(ws, 'session-1', String(repair?.repairToken), Number(repair?.seq));

    const outputs = sent.filter((message) => message.type === 'output');
    assert.equal(outputs.length, 1);
    assert.equal(outputs[0].data, 'timeout-flushed-output');
    assert.equal(sent[sent.length - 1].type, 'session:ready');
    const timeoutEvent = router.getObservabilitySnapshot().recentReplayEvents.find((event) => event.kind === 'screen_repair_ack_timeout');
    assert.ok(timeoutEvent);
  } finally {
    router.destroy();
  }
}

async function testWsRouterFlushesCoveredScreenRepairOutputOnFailure(): Promise<void> {
  const { router, ws, sent, harness, repair } = await createCoveredScreenRepairHarness('COVERED-FAILURE');

  try {
    (router as any).handleScreenRepairFailed(ws, harness.sessionId, String(repair?.repairToken), 'write-failed');

    const outputs = sent.filter((message) => message.type === 'output');
    assert.equal(outputs.length, 1);
    assert.equal(outputs[0].data, 'COVERED-FAILURE');
  } finally {
    router.destroy();
    harness.dispose();
  }
}

async function testWsRouterFlushesCoveredScreenRepairOutputOnTimeout(): Promise<void> {
  const { router, ws, sent, harness, repair } = await createCoveredScreenRepairHarness('COVERED-TIMEOUT');

  try {
    (router as any).handleScreenRepairAckTimeout(ws, harness.sessionId, String(repair?.repairToken), Number(repair?.seq));

    const outputs = sent.filter((message) => message.type === 'output');
    assert.equal(outputs.length, 1);
    assert.equal(outputs[0].data, 'COVERED-TIMEOUT');
    assert.equal(sent[sent.length - 1].type, 'session:ready');
  } finally {
    router.destroy();
    harness.dispose();
  }
}

async function testWsRouterFlushesOutputOnScreenRepairFailed(): Promise<void> {
  const { router, ws, sent } = createWsRouterHarness();

  try {
    (router as any).handleSubscribe(ws, ['session-1']);
    (router as any).handleScreenSnapshotReady(ws, 'session-1', String(sent[0].replayToken));

    await (router as any).handleScreenRepairRequest(ws, {
      type: 'screen-repair',
      sessionId: 'session-1',
      cols: 80,
      rows: 24,
      reason: 'workspace',
      clientAtBottom: true,
      clientBufferType: 'normal',
    });
    const repair = sent.find((message) => message.type === 'screen-repair');

    router.routeSessionOutput('session-1', 'queued-before-failed');
    (router as any).handleScreenRepairFailed(ws, 'session-1', String(repair?.repairToken), 'write-failed');

    const outputs = sent.filter((message) => message.type === 'output');
    assert.equal(outputs.length, 1);
    assert.equal(outputs[0].data, 'queued-before-failed');
  } finally {
    router.destroy();
  }
}

async function testWsRouterIgnoresStaleScreenRepairToken(): Promise<void> {
  const { router, ws, sent } = createWsRouterHarness();

  try {
    (router as any).handleSubscribe(ws, ['session-1']);
    (router as any).handleScreenSnapshotReady(ws, 'session-1', String(sent[0].replayToken));

    await (router as any).handleScreenRepairRequest(ws, {
      type: 'screen-repair',
      sessionId: 'session-1',
      cols: 80,
      rows: 24,
      reason: 'manual',
      clientAtBottom: true,
      clientBufferType: 'normal',
    });
    const repair = sent.find((message) => message.type === 'screen-repair');

    router.routeSessionOutput('session-1', 'wait-for-valid-token');
    (router as any).handleScreenRepairReady(ws, 'session-1', 'stale-token');
    assert.equal(sent.filter((message) => message.type === 'output').length, 0);

    (router as any).handleScreenRepairReady(ws, 'session-1', String(repair?.repairToken));
    const outputs = sent.filter((message) => message.type === 'output');
    assert.equal(outputs.length, 1);
    assert.equal(outputs[0].data, 'wait-for-valid-token');
  } finally {
    router.destroy();
  }
}

async function testWsRouterRejectsScreenRepairDuringReplayPending(): Promise<void> {
  const { router, ws, sent } = createWsRouterHarness();

  try {
    (router as any).handleSubscribe(ws, ['session-1']);

    await (router as any).handleScreenRepairRequest(ws, {
      type: 'screen-repair',
      sessionId: 'session-1',
      cols: 80,
      rows: 24,
      reason: 'workspace',
      clientAtBottom: true,
      clientBufferType: 'normal',
    });

    const rejected = sent.find((message) => message.type === 'screen-repair:rejected');
    assert.equal(rejected?.reason, 'pending');
    assert.equal(sent.filter((message) => message.type === 'screen-repair').length, 0);
  } finally {
    router.destroy();
  }
}

async function testWsRouterScreenRepairQueueOverflowFlushesAllOutput(): Promise<void> {
  const { router, ws, sent } = createWsRouterHarness();

  try {
    (router as any).handleSubscribe(ws, ['session-1']);
    (router as any).handleScreenSnapshotReady(ws, 'session-1', String(sent[0].replayToken));

    await (router as any).handleScreenRepairRequest(ws, {
      type: 'screen-repair',
      sessionId: 'session-1',
      cols: 80,
      rows: 24,
      reason: 'resize',
      clientAtBottom: true,
      clientBufferType: 'normal',
    });

    router.routeSessionOutput('session-1', 'a'.repeat(60));
    router.routeSessionOutput('session-1', 'b'.repeat(10));

    const outputs = sent.filter((message) => message.type === 'output');
    assert.equal(outputs.length, 1);
    assert.equal(outputs[0].data, `${'a'.repeat(60)}${'b'.repeat(10)}`);
    const overflow = router.getObservabilitySnapshot().recentReplayEvents.find((event) => event.kind === 'screen_repair_queue_overflow');
    assert.ok(overflow);
  } finally {
    router.destroy();
  }
}

async function testWsRouterScreenRepairQueueOverflowUsesUtf8Bytes(): Promise<void> {
  const { router, ws, sent } = createWsRouterHarness();

  try {
    (router as any).handleSubscribe(ws, ['session-1']);
    (router as any).handleScreenSnapshotReady(ws, 'session-1', String(sent[0].replayToken));

    await (router as any).handleScreenRepairRequest(ws, {
      type: 'screen-repair',
      sessionId: 'session-1',
      cols: 80,
      rows: 24,
      reason: 'resize',
      clientAtBottom: true,
      clientBufferType: 'normal',
    });

    const multibyteOutput = '가'.repeat(22);
    assert.equal(multibyteOutput.length < 64, true);
    assert.equal(Buffer.byteLength(multibyteOutput, 'utf8') > 64, true);
    router.routeSessionOutput('session-1', multibyteOutput);

    const outputs = sent.filter((message) => message.type === 'output');
    assert.equal(outputs.length, 1);
    assert.equal(outputs[0].data, multibyteOutput);
    const overflow = router.getObservabilitySnapshot().recentReplayEvents.find((event) => event.kind === 'screen_repair_queue_overflow');
    assert.ok(overflow);
    assert.equal(overflow.details?.outputBytes, Buffer.byteLength(multibyteOutput, 'utf8'));
  } finally {
    router.destroy();
  }
}

async function testWsRouterScreenRepairQueueAllowsUtf8WithinCap(): Promise<void> {
  const { router, ws, sent } = createWsRouterHarness();

  try {
    (router as any).handleSubscribe(ws, ['session-1']);
    (router as any).handleScreenSnapshotReady(ws, 'session-1', String(sent[0].replayToken));

    await (router as any).handleScreenRepairRequest(ws, {
      type: 'screen-repair',
      sessionId: 'session-1',
      cols: 80,
      rows: 24,
      reason: 'manual',
      clientAtBottom: true,
      clientBufferType: 'normal',
    });
    const repair = sent.find((message) => message.type === 'screen-repair');

    const multibyteOutput = '가'.repeat(21);
    assert.equal(Buffer.byteLength(multibyteOutput, 'utf8'), 63);
    router.routeSessionOutput('session-1', multibyteOutput);
    assert.equal(sent.filter((message) => message.type === 'output').length, 0);

    (router as any).handleScreenRepairReady(ws, 'session-1', String(repair?.repairToken));

    const outputs = sent.filter((message) => message.type === 'output');
    assert.equal(outputs.length, 1);
    assert.equal(outputs[0].data, multibyteOutput);
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
    assert.match(harness.sessionData.degradedReplayBuffer, /PAYLOAD_B/);

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
  assert.equal(tab.lifecycleState, 'active');
  assert.equal(tab.recoverable, true);
  assert.equal(tab.lifecycleReason, 'tab-restart');
  assert.equal(tab.generation, 1);
}

async function testWorkspaceServiceRestartTabPersistsReplacementBeforeDelete(): Promise<void> {
  const { workspaceService, calls } = createWorkspaceServiceHarness();
  (workspaceService as any).state = createWorkspaceStateWithTab({
    sessionId: 'old-session',
    shellType: 'bash',
    lastCwd: '/repo',
    generation: 2,
  });
  calls.hasSession.add('old-session');

  const tab = await workspaceService.restartTab('ws-1', 'tab-1');

  assert.notEqual(tab.sessionId, 'old-session');
  assert.equal(tab.generation, 3);
  assert.equal(tab.lifecycleState, 'active');
  assert.equal(tab.recoverable, true);
  assert.equal(tab.lifecycleReason, 'tab-restart');
  assert.equal(calls.order[0], 'createSession');
  assert.equal(calls.order[1], 'save:true');
  assert.equal(calls.order[2], 'terminateSession:old-session:tab-restart');
  assert.equal(calls.save[0].tabs[0].sessionId, tab.sessionId);
  assert.equal(calls.save[0].tabs[0].generation, 3);
  assert.equal(calls.save[0].tabs[0].lifecycleState, 'active');
}

async function testWorkspaceServiceRestartTabSaveFailurePreservesOldSession(): Promise<void> {
  const { workspaceService, calls } = createWorkspaceServiceHarness();
  (workspaceService as any).state = createWorkspaceStateWithTab({
    sessionId: 'old-session',
    shellType: 'bash',
    lastCwd: '/repo',
    lifecycleState: 'active',
    recoverable: true,
    cleanupStatus: 'not-started',
    generation: 2,
  });
  calls.hasSession.add('old-session');
  const originalSave = (workspaceService as any).save;
  (workspaceService as any).save = async (immediate = false) => {
    calls.order.push(`save:${immediate}:failed`);
    throw new Error('persist failed');
  };

  await assert.rejects(
    () => workspaceService.restartTab('ws-1', 'tab-1'),
    /persist failed/,
  );

  const tab = (workspaceService as any).state.tabs[0];
  assert.equal(tab.sessionId, 'old-session');
  assert.equal(tab.generation, 2);
  assert.equal(tab.lifecycleState, 'active');
  assert.equal(tab.recoverable, true);
  assert.equal(calls.order[0], 'createSession');
  assert.equal(calls.order[1], 'save:true:failed');
  assert.equal(calls.order[2], 'terminateSession:session-1:tab-restart');
  assert.deepEqual(calls.deleteSession, ['session-1']);
  assert.equal(calls.deleteSession.includes('old-session'), false);
  (workspaceService as any).save = originalSave;
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
  assert.equal((workspaceService as any).state.tabs[0].lifecycleState, undefined);
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

async function testWorkspaceServiceDeleteWorkspacePreMarksNonRecoverable(): Promise<void> {
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
    ],
    gridLayouts: [],
  };

  await workspaceService.deleteWorkspace('ws-1');

  assert.equal(calls.order[0], 'save:true');
  assert.equal(calls.order[1], 'terminateMultipleSessions:workspace-delete');
  assert.equal(calls.save[0].tabs[0].lifecycleState, 'stopped');
  assert.equal(calls.save[0].tabs[0].recoverable, false);
  assert.equal(calls.save[0].tabs[0].lifecycleReason, 'workspace-delete');
  assert.equal(calls.save[0].tabs[0].cleanupStatus, 'not-started');
  assert.deepEqual(calls.order, [
    'save:true',
    'terminateMultipleSessions:workspace-delete',
    'save:true',
  ]);
  assert.equal(calls.save.length, 2);
  assert.equal(calls.save[1].tabs.some((tab: any) => tab.workspaceId === 'ws-1'), false);
  assert.equal(calls.save[1].workspaces.some((workspace: any) => workspace.id === 'ws-1'), false);
}

async function testWorkspaceServiceDeleteWorkspaceSaveFailureDoesNotTerminate(): Promise<void> {
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
        lifecycleState: 'active',
        recoverable: true,
        lifecycleReason: 'orphan-recovery',
        cleanupStatus: 'observed',
        lastExitCode: 7,
        lifecycleUpdatedAt: 'before-workspace-delete',
        generation: 3,
      },
    ],
    gridLayouts: [],
  };
  const expectedLifecycle = pickWorkspaceTabLifecycle((workspaceService as any).state.tabs[0]);
  (workspaceService as any).save = async (immediate = false) => {
    calls.order.push(`save:${immediate}:failed`);
    throw new Error('persist failed');
  };

  await assert.rejects(
    () => workspaceService.deleteWorkspace('ws-1'),
    /persist failed/,
  );

  assert.deepEqual(calls.terminateMultipleSessions, []);
  assert.equal((workspaceService as any).state.workspaces.some((workspace: any) => workspace.id === 'ws-1'), true);
  assert.equal((workspaceService as any).state.tabs.some((tab: any) => tab.sessionId === 'session-a'), true);
  assert.deepEqual(pickWorkspaceTabLifecycle((workspaceService as any).state.tabs[0]), expectedLifecycle);
  assert.deepEqual(calls.order, ['save:true:failed']);
}

async function testWorkspaceServiceDeleteTabIgnoresDeleteFinalizerCallback(): Promise<void> {
  const { workspaceService, calls } = createWorkspaceServiceHarness();
  (workspaceService as any).state = createWorkspaceStateWithTab({
    sessionId: 'session-tab-delete',
  });

  await workspaceService.deleteTab('ws-1', 'tab-1');

  assert.deepEqual(calls.order, [
    'save:true',
    'terminateSession:session-tab-delete:tab-delete',
    'save:true',
  ]);
  assert.equal(calls.save.length, 2);
  assert.equal(calls.save[0].tabs[0].lifecycleState, 'stopped');
  assert.equal(calls.save[0].tabs[0].recoverable, false);
  assert.equal(calls.save[0].tabs[0].lifecycleReason, 'tab-delete');
  assert.equal(calls.save[1].tabs.length, 0);
}

async function testWorkspaceServiceDeleteTabSaveFailureDoesNotTerminate(): Promise<void> {
  const { workspaceService, calls } = createWorkspaceServiceHarness();
  (workspaceService as any).state = createWorkspaceStateWithTab({
    sessionId: 'session-tab-delete',
    lifecycleState: 'active',
    recoverable: true,
    lifecycleReason: 'orphan-recovery',
    cleanupStatus: 'observed',
    lastExitCode: 7,
    lifecycleUpdatedAt: 'before-tab-delete',
    generation: 3,
  });
  const expectedLifecycle = pickWorkspaceTabLifecycle((workspaceService as any).state.tabs[0]);
  (workspaceService as any).save = async (immediate = false) => {
    calls.order.push(`save:${immediate}:failed`);
    throw new Error('persist failed');
  };

  await assert.rejects(
    () => workspaceService.deleteTab('ws-1', 'tab-1'),
    /persist failed/,
  );

  assert.deepEqual(calls.terminateSession, []);
  assert.equal((workspaceService as any).state.tabs.some((tab: any) => tab.sessionId === 'session-tab-delete'), true);
  assert.deepEqual(pickWorkspaceTabLifecycle((workspaceService as any).state.tabs[0]), expectedLifecycle);
  assert.deepEqual(calls.order, ['save:true:failed']);
}

async function testWorkspaceServiceMoveTabPreservesLiveSession(): Promise<void> {
  const { workspaceService, calls } = createWorkspaceServiceHarness();
  (workspaceService as any).state = createWorkspaceMoveState();
  calls.hasSession.add('session-1');
  calls.hasSession.add('session-2');
  calls.hasSession.add('session-3');

  const result = await (workspaceService as any).moveTab('ws-1', 'tab-2', 'ws-2');
  const state = workspaceService.getState();
  const moved = state.tabs.find(tab => tab.id === 'tab-2');
  const source = state.workspaces.find(workspace => workspace.id === 'ws-1');
  const target = state.workspaces.find(workspace => workspace.id === 'ws-2');

  assert.equal(result.tab.id, 'tab-2');
  assert.equal(result.tab.sessionId, 'session-2');
  assert.equal(result.sourceWorkspaceId, 'ws-1');
  assert.equal(result.targetWorkspaceId, 'ws-2');
  assert.deepEqual(result.sourceTabIds, ['tab-1']);
  assert.deepEqual(result.targetTabIds, ['tab-3', 'tab-2']);
  assert.equal(result.sourceActiveTabId, 'tab-1');
  assert.equal(result.targetActiveTabId, 'tab-2');
  assert.equal(moved?.workspaceId, 'ws-2');
  assert.equal(moved?.sortOrder, 1);
  assert.equal(source?.activeTabId, 'tab-1');
  assert.equal(target?.activeTabId, 'tab-2');
  assert.deepEqual(calls.createSession, []);
  assert.deepEqual(calls.terminateSession, []);
  assert.equal(calls.save.length, 1);
}

async function testWorkspaceServiceMoveTabAppendsToTarget(): Promise<void> {
  const { workspaceService, calls } = createWorkspaceServiceHarness();
  const state = createWorkspaceMoveState();
  state.workspaces.find((workspace: any) => workspace.id === 'ws-1')!.activeTabId = 'tab-1';
  state.tabs.push({
    id: 'tab-4',
    workspaceId: 'ws-2',
    sessionId: 'session-4',
    name: 'Target 2',
    colorIndex: 3,
    sortOrder: 1,
    shellType: 'bash',
    createdAt: new Date().toISOString(),
    lifecycleState: 'active',
    recoverable: true,
  });
  (workspaceService as any).state = state;
  calls.hasSession.add('session-1');
  calls.hasSession.add('session-2');
  calls.hasSession.add('session-3');
  calls.hasSession.add('session-4');

  const result = await (workspaceService as any).moveTab('ws-1', 'tab-1', 'ws-2');
  const moved = workspaceService.getState().tabs.find(tab => tab.id === 'tab-1');

  assert.deepEqual(result.sourceTabIds, ['tab-2']);
  assert.deepEqual(result.targetTabIds, ['tab-3', 'tab-4', 'tab-1']);
  assert.equal(moved?.workspaceId, 'ws-2');
  assert.equal(moved?.sortOrder, 2);
}

async function testWorkspaceServiceMoveTabRejectsInvalidTargets(): Promise<void> {
  const { workspaceService, calls } = createWorkspaceServiceHarness();
  (workspaceService as any).state = createWorkspaceMoveState();
  (workspaceService as any).config.maxTabsPerWorkspace = 1;
  calls.hasSession.add('session-1');
  calls.hasSession.add('session-2');
  calls.hasSession.add('session-3');

  await assert.rejects(
    () => (workspaceService as any).moveTab('ws-1', 'tab-2', 'ws-2'),
    (error: unknown) => error instanceof AppError && error.code === ErrorCode.TAB_LIMIT_EXCEEDED,
  );

  (workspaceService as any).config.maxTabsPerWorkspace = 8;
  const stoppedTab = (workspaceService as any).state.tabs.find((tab: any) => tab.id === 'tab-2');
  stoppedTab.lifecycleState = 'stopped';
  stoppedTab.recoverable = false;

  await assert.rejects(
    () => (workspaceService as any).moveTab('ws-1', 'tab-2', 'ws-2'),
    (error: unknown) => error instanceof AppError && String(error.code) === 'SESSION_NOT_MOVABLE',
  );
}

async function testWorkspaceServiceMoveTabSaveFailureRestoresState(): Promise<void> {
  const { workspaceService, calls } = createWorkspaceServiceHarness();
  (workspaceService as any).state = createWorkspaceMoveState();
  calls.hasSession.add('session-1');
  calls.hasSession.add('session-2');
  calls.hasSession.add('session-3');
  const before = JSON.parse(JSON.stringify(workspaceService.getState()));
  (workspaceService as any).save = async (immediate = false) => {
    calls.order.push(`save:${immediate}:failed`);
    throw new Error('persist failed');
  };

  await assert.rejects(
    () => (workspaceService as any).moveTab('ws-1', 'tab-2', 'ws-2'),
    /persist failed/,
  );

  assert.deepEqual(workspaceService.getState(), before);
  assert.deepEqual(calls.createSession, []);
  assert.deepEqual(calls.terminateSession, []);
}

async function testWorkspaceServiceRejectsInvalidReorderPayloads(): Promise<void> {
  const { workspaceService } = createWorkspaceServiceHarness();
  (workspaceService as any).state = createWorkspaceMoveState();

  await assert.rejects(
    () => workspaceService.reorderWorkspaces(['ws-2']),
    (error: unknown) => error instanceof AppError && String(error.code) === 'INVALID_REORDER_PAYLOAD',
  );
  await assert.rejects(
    () => workspaceService.reorderWorkspaces(['ws-1', 'ws-1']),
    (error: unknown) => error instanceof AppError && String(error.code) === 'INVALID_REORDER_PAYLOAD',
  );
  await assert.rejects(
    () => workspaceService.reorderTabs('ws-1', ['tab-2']),
    (error: unknown) => error instanceof AppError && String(error.code) === 'INVALID_REORDER_PAYLOAD',
  );
}

async function testWorkspaceServicePassesSessionCleanupReasons(): Promise<void> {
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
        sessionId: 'session-tab-delete',
        name: 'Terminal A',
        colorIndex: 0,
        sortOrder: 0,
        shellType: 'bash',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'tab-2',
        workspaceId: 'ws-1',
        sessionId: 'session-restart',
        name: 'Terminal B',
        colorIndex: 1,
        sortOrder: 1,
        shellType: 'bash',
        lastCwd: '/repo',
        createdAt: new Date().toISOString(),
      },
    ],
    gridLayouts: [],
  };

  await workspaceService.deleteTab('ws-1', 'tab-1');
  assert.deepEqual(calls.deleteSessionReasons[calls.deleteSessionReasons.length - 1], {
    id: 'session-tab-delete',
    reason: 'tab-delete',
  });

  await workspaceService.restartTab('ws-1', 'tab-2');
  assert.deepEqual(calls.deleteSessionReasons[calls.deleteSessionReasons.length - 1], {
    id: 'session-restart',
    reason: 'tab-restart',
  });

  (workspaceService as any).state.tabs.push({
    id: 'tab-3',
    workspaceId: 'ws-1',
    sessionId: 'session-workspace-delete',
    name: 'Terminal C',
    colorIndex: 2,
    sortOrder: 2,
    shellType: 'bash',
    createdAt: new Date().toISOString(),
  });

  await workspaceService.deleteWorkspace('ws-1');
  assert.deepEqual(calls.deleteMultipleSessionReasons[calls.deleteMultipleSessionReasons.length - 1], {
    ids: ['session-1', 'session-workspace-delete'],
    reason: 'workspace-delete',
  });
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
  assert.equal((workspaceService as any).state.tabs[0].lifecycleState, 'active');
  assert.equal((workspaceService as any).state.tabs[0].recoverable, true);
  assert.equal((workspaceService as any).state.tabs[0].lifecycleReason, 'orphan-recovery');
  assert.equal((workspaceService as any).state.tabs[0].generation, 1);
}

async function testWorkspaceServiceSkipsStoppedOrphanTabs(): Promise<void> {
  const { workspaceService, calls } = createWorkspaceServiceHarness();
  const state = createWorkspaceStateWithTab({
    sessionId: 'stopped-session',
    lifecycleState: 'stopped',
    recoverable: true,
    lifecycleReason: 'direct-session-delete',
    cleanupStatus: 'completed',
    generation: 4,
  });
  (state.tabs as any[]).push({
    id: 'tab-2',
    workspaceId: 'ws-1',
    sessionId: 'non-recoverable-session',
    name: 'Terminal-2',
    colorIndex: 1,
    sortOrder: 1,
    shellType: 'bash',
    createdAt: new Date().toISOString(),
    lifecycleState: 'active',
    recoverable: false,
    lifecycleReason: 'process-exit',
    cleanupStatus: 'completed',
    generation: 5,
  });
  (workspaceService as any).state = state;

  const orphanTabIds = await workspaceService.checkOrphanTabs();

  assert.deepEqual(orphanTabIds, []);
  assert.equal(calls.createSession.length, 0);
  assert.equal((workspaceService as any).state.tabs[0].sessionId, 'stopped-session');
  assert.equal((workspaceService as any).state.tabs[0].generation, 4);
  assert.equal((workspaceService as any).state.tabs[1].sessionId, 'non-recoverable-session');
  assert.equal((workspaceService as any).state.tabs[1].generation, 5);
}

async function testWorkspaceServiceMcpRegistryExcludesNonLiveTabs(): Promise<void> {
  const { workspaceService, calls } = createWorkspaceServiceHarness();
  (workspaceService as any).state = {
    workspaces: [{
      id: 'ws-1',
      name: 'Workspace 1',
      sortOrder: 0,
      viewMode: 'tab',
      activeTabId: 'tab-live',
      colorCounter: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }],
    tabs: [
      {
        id: 'tab-live',
        workspaceId: 'ws-1',
        sessionId: 'session-live',
        sessionKey: 'sess_live',
        currentSessionId: 'session-live',
        name: 'Live',
        nameSource: 'user',
        colorIndex: 0,
        sortOrder: 0,
        shellType: 'bash',
        lifecycleState: 'active',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'tab-ghost',
        workspaceId: 'ws-1',
        sessionId: 'session-ghost',
        sessionKey: 'sess_ghost',
        currentSessionId: 'session-ghost',
        name: 'Ghost',
        nameSource: 'user',
        colorIndex: 1,
        sortOrder: 1,
        shellType: 'bash',
        lifecycleState: 'active',
        createdAt: new Date().toISOString(),
      },
    ],
    gridLayouts: [],
  };
  calls.hasSession.add('session-live');

  const sessions = workspaceService.listMcpSessions(undefined, true);

  assert.deepEqual(sessions.map(session => session.sessionKey), ['sess_live']);
  assert.equal(sessions[0].sessionId, 'session-live');
  assert.equal(sessions[0].bindingLifecycle, 'live');
}

async function testWorkspaceServiceMcpRegistryRegeneratesDuplicateSessionKeys(): Promise<void> {
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
    tabs: [
      {
        id: 'tab-1',
        workspaceId: 'ws-1',
        sessionId: 'session-1',
        sessionKey: 'sess_duplicate',
        currentSessionId: 'session-1',
        name: 'Primary',
        nameSource: 'user',
        colorIndex: 0,
        sortOrder: 0,
        shellType: 'bash',
        lifecycleState: 'active',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'tab-2',
        workspaceId: 'ws-1',
        sessionId: 'session-2',
        sessionKey: 'sess_duplicate',
        currentSessionId: 'session-2',
        name: 'Duplicate',
        nameSource: 'user',
        colorIndex: 1,
        sortOrder: 1,
        shellType: 'bash',
        lifecycleState: 'active',
        createdAt: new Date().toISOString(),
      },
    ],
    gridLayouts: [],
  };
  calls.hasSession.add('session-1');
  calls.hasSession.add('session-2');

  const sessions = workspaceService.listMcpSessions(undefined, true);
  const tabs = (workspaceService as any).state.tabs;

  assert.deepEqual(sessions.map(session => session.sessionKey), ['sess_duplicate', 'sess_tab_2']);
  assert.equal(tabs[0].sessionKey, 'sess_duplicate');
  assert.equal(tabs[1].sessionKey, 'sess_tab_2');
  assert.equal(new Set(sessions.map(session => session.sessionKey)).size, 2);
}

async function testWorkspaceServiceMcpSearchPreservesFailureMetadata(): Promise<void> {
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
    tabs: [
      {
        id: 'tab-1',
        workspaceId: 'ws-1',
        sessionId: 'session-1',
        sessionKey: 'sess_one',
        currentSessionId: 'session-1',
        name: 'builder',
        nameSource: 'user',
        colorIndex: 0,
        sortOrder: 0,
        shellType: 'bash',
        lifecycleState: 'active',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'tab-2',
        workspaceId: 'ws-1',
        sessionId: 'session-2',
        sessionKey: 'sess_two',
        currentSessionId: 'session-2',
        name: 'builder',
        nameSource: 'user',
        colorIndex: 1,
        sortOrder: 1,
        shellType: 'bash',
        lifecycleState: 'active',
        createdAt: new Date().toISOString(),
      },
    ],
    gridLayouts: [],
  };
  calls.hasSession.add('session-1');
  calls.hasSession.add('session-2');

  const zero = asRecord(workspaceService.searchMcpSessions(undefined, 'missing', true), 'WorkspaceService MCP zero search');
  assert.equal(zero.allowed, false);
  assert.equal(zero.code, 'TARGET_NOT_FOUND');
  assert.equal(zero.reason, 'zero-matches');

  const ambiguous = asRecord(workspaceService.searchMcpSessions(undefined, 'builder', true), 'WorkspaceService MCP ambiguous search');
  const candidates = asRecordArray(ambiguous.candidates, 'WorkspaceService MCP ambiguous candidates');
  assert.equal(ambiguous.allowed, false);
  assert.equal(ambiguous.code, 'AMBIGUOUS_TARGET');
  assert.deepEqual(candidates.map(candidate => candidate.sessionKey), ['sess_one', 'sess_two']);
}

async function testWorkspaceServiceStoresCodexRecoveryMetadata(): Promise<void> {
  const fixture = await createTempRecoveryOptionService();
  try {
    const { workspaceService, emitCommandSubmitted, calls } = createWorkspaceServiceHarness({
      recoveryOptionService: fixture.service,
    });
    (workspaceService as any).state = createWorkspaceStateWithTab({ sessionId: 'session-1' });

    await emitCommandSubmitted({ sessionId: 'session-1', command: 'codex', executable: 'codex' });

    const tab = (workspaceService as any).state.tabs[0];
    const codexOption = fixture.service.getAll().find(option => option.command === 'codex');
    assert.equal(tab.recoveryOptionId, codexOption?.id);
    assert.equal(tab.recoveryCommand, 'codex');
    assert.deepEqual(tab.recoveryArguments, ['resume', '--last']);
    assert.deepEqual(tab.recoveryIcon, { type: 'builtin', key: 'terminal' });
    assert.equal(calls.save.at(-1)?.immediate, true);
    assert.deepEqual(calls.recoveryForeground, []);
  } finally {
    await fixture.cleanup();
  }
}

async function testWorkspaceServiceStoresCustomRecoveryMetadata(): Promise<void> {
  const fixture = await createTempRecoveryOptionService();
  try {
    const custom = await fixture.service.createOption({
      command: 'claudep',
      arguments: ['--continue'],
      icon: { type: 'text', value: 'CP' },
    });
    const { workspaceService, emitCommandSubmitted } = createWorkspaceServiceHarness({
      recoveryOptionService: fixture.service,
    });
    (workspaceService as any).state = createWorkspaceStateWithTab({ sessionId: 'session-1' });

    await emitCommandSubmitted({
      sessionId: 'session-1',
      command: '/usr/local/bin/claudep --dangerously-skip-permissions',
      executable: 'claudep',
    });

    const tab = (workspaceService as any).state.tabs[0];
    assert.equal(tab.recoveryOptionId, custom.id);
    assert.equal(tab.recoveryCommand, 'claudep');
    assert.deepEqual(tab.recoveryArguments, ['--continue']);
    assert.deepEqual(tab.recoveryIcon, { type: 'text', value: 'CP' });
  } finally {
    await fixture.cleanup();
  }
}

async function testWorkspaceServiceMarksRecoveryForegroundCommand(): Promise<void> {
  const fixture = await createTempRecoveryOptionService();
  try {
    await fixture.service.createOption({
      command: 'claudep',
      arguments: ['--continue'],
      icon: { type: 'builtin', key: 'brain' },
    });
    const { workspaceService, emitCommandSubmitted, calls } = createWorkspaceServiceHarness({
      recoveryOptionService: fixture.service,
    });
    (workspaceService as any).state = createWorkspaceStateWithTab({ sessionId: 'session-1' });

    await emitCommandSubmitted({
      sessionId: 'session-1',
      command: 'claudep',
      executable: 'claudep',
    });

    assert.deepEqual(calls.recoveryForeground, [
      { sessionId: 'session-1', command: 'claudep' },
    ]);
    assert.deepEqual(calls.order.slice(-2), [
      'markRecoveryForeground:session-1:claudep',
      'save:true',
    ]);
  } finally {
    await fixture.cleanup();
  }
}

async function testWorkspaceServiceClearsUnmatchedRecoveryMetadata(): Promise<void> {
  const fixture = await createTempRecoveryOptionService();
  try {
    const { workspaceService, emitCommandSubmitted } = createWorkspaceServiceHarness({
      recoveryOptionService: fixture.service,
    });
    const events: any[] = [];
    workspaceService.onTabUpdated(event => events.push(event));
    (workspaceService as any).state = createWorkspaceStateWithTab({
      sessionId: 'session-1',
      recoveryOptionId: 'stale-option',
      recoveryCommand: 'codex',
      recoveryArguments: ['resume', '--last'],
      recoveryIcon: { type: 'builtin', key: 'terminal' },
      recoveryUpdatedAt: 'before',
    });

    await emitCommandSubmitted({ sessionId: 'session-1', command: 'ls', executable: 'ls' });

    const tab = (workspaceService as any).state.tabs[0];
    assert.equal(tab.recoveryOptionId, undefined);
    assert.equal(tab.recoveryCommand, undefined);
    assert.deepEqual(events.at(-1)?.changes, {
      recoveryOptionId: null,
      recoveryCommand: null,
      recoveryArguments: null,
      recoveryIcon: null,
      recoveryUpdatedAt: null,
    });
  } finally {
    await fixture.cleanup();
  }
}

async function testWorkspaceServiceRestartSchedulesRecoveryRestore(): Promise<void> {
  const fixture = await createTempRecoveryOptionService();
  try {
    const codexOption = fixture.service.getAll().find(option => option.command === 'codex');
    assert.ok(codexOption);
    const { workspaceService, calls } = createWorkspaceServiceHarness({
      recoveryOptionService: fixture.service,
      restoreInputDelayMs: 0,
    });
    (workspaceService as any).state = createWorkspaceStateWithTab({
      sessionId: 'old-session',
      shellType: 'bash',
      lastCwd: '/repo',
      recoveryOptionId: codexOption.id,
      recoveryCommand: 'codex',
      recoveryArguments: ['resume', '--last'],
      recoveryIcon: { type: 'builtin', key: 'terminal' },
    });
    calls.hasSession.add('old-session');

    const tab = await workspaceService.restartTab('ws-1', 'tab-1');

    assert.equal(calls.createSession[0].cwd, '/repo');
    assert.equal(calls.scheduleRestoreInput.length, 1);
    assert.equal(calls.scheduleRestoreInput[0].sessionId, tab.sessionId);
    assert.equal(calls.scheduleRestoreInput[0].input, "codex 'resume' '--last'\r");
    assert.equal(calls.scheduleRestoreInput[0].guard?.(), true);
    assert.deepEqual(calls.order.slice(0, 4), [
      'createSession',
      'save:true',
      `scheduleRestoreInput:${tab.sessionId}:codex 'resume' '--last'\r`,
      'terminateSession:old-session:tab-restart',
    ]);
  } finally {
    await fixture.cleanup();
  }
}

async function testWorkspaceServiceRestartRestoreUsesResolvedShell(): Promise<void> {
  const fixture = await createTempRecoveryOptionService();
  try {
    const claudeOption = fixture.service.getAll().find(option => option.command === 'claude');
    assert.ok(claudeOption);
    await fixture.service.updateOption(claudeOption.id, { arguments: ["O'Reilly"] });
    const { workspaceService, calls } = createWorkspaceServiceHarness({
      recoveryOptionService: fixture.service,
      restoreInputDelayMs: 0,
    });
    (workspaceService as any).state = createWorkspaceStateWithTab({
      sessionId: 'old-session',
      shellType: 'auto',
      lastCwd: 'C:\\repo',
      recoveryOptionId: claudeOption.id,
      recoveryCommand: 'claude',
      recoveryArguments: ["O'Reilly"],
      recoveryIcon: { type: 'builtin', key: 'bot' },
    });

    await workspaceService.restartTab('ws-1', 'tab-1');

    assert.equal(calls.createSession[0].shell, 'auto');
    assert.equal(calls.scheduleRestoreInput.length, 1);
    assert.equal(calls.scheduleRestoreInput[0].input, "claude 'O''Reilly'\r");
  } finally {
    await fixture.cleanup();
  }
}

async function testWorkspaceServiceOrphanRecoverySchedulesRestore(): Promise<void> {
  const fixture = await createTempRecoveryOptionService();
  try {
    const claudeOption = fixture.service.getAll().find(option => option.command === 'claude');
    assert.ok(claudeOption);
    const { workspaceService, calls } = createWorkspaceServiceHarness({
      recoveryOptionService: fixture.service,
      restoreInputDelayMs: 0,
    });
    (workspaceService as any).state = createWorkspaceStateWithTab({
      sessionId: 'orphan-session',
      shellType: 'powershell',
      lastCwd: 'C:\\repo',
      recoveryOptionId: claudeOption.id,
      recoveryCommand: 'claude',
      recoveryArguments: ['--continue'],
      recoveryIcon: { type: 'builtin', key: 'bot' },
    });

    const orphanTabIds = await workspaceService.checkOrphanTabs();

    const tab = (workspaceService as any).state.tabs[0];
    assert.deepEqual(orphanTabIds, ['tab-1']);
    assert.equal(calls.createSession[0].cwd, 'C:\\repo');
    assert.equal(calls.scheduleRestoreInput.length, 1);
    assert.equal(calls.scheduleRestoreInput[0].sessionId, tab.sessionId);
    assert.equal(calls.scheduleRestoreInput[0].input, "claude '--continue'\r");
    assert.equal(calls.scheduleRestoreInput[0].guard?.(), true);
    assert.equal(calls.order.at(-1), `scheduleRestoreInput:${tab.sessionId}:claude '--continue'\r`);
  } finally {
    await fixture.cleanup();
  }
}

async function testWorkspaceServiceRestartClearsDeletedRecoveryOption(): Promise<void> {
  const fixture = await createTempRecoveryOptionService();
  try {
    const codexOption = fixture.service.getAll().find(option => option.command === 'codex');
    assert.ok(codexOption);
    await fixture.service.deleteOption(codexOption.id);
    const { workspaceService, calls } = createWorkspaceServiceHarness({
      recoveryOptionService: fixture.service,
      restoreInputDelayMs: 0,
    });
    (workspaceService as any).state = createWorkspaceStateWithTab({
      sessionId: 'old-session',
      recoveryOptionId: codexOption.id,
      recoveryCommand: 'codex',
      recoveryArguments: ['resume', '--last'],
      recoveryIcon: { type: 'builtin', key: 'terminal' },
      recoveryUpdatedAt: 'before',
    });

    await workspaceService.restartTab('ws-1', 'tab-1');

    const tab = (workspaceService as any).state.tabs[0];
    assert.equal(calls.scheduleRestoreInput.length, 0);
    assert.equal(tab.recoveryOptionId, undefined);
    assert.equal(tab.recoveryCommand, undefined);
    assert.deepEqual(calls.order, [
      'createSession',
      'save:true',
      'save:true',
      'terminateSession:old-session:tab-restart',
    ]);
  } finally {
    await fixture.cleanup();
  }
}

async function testWorkspaceServiceOrphanClearsDisabledRecoveryOption(): Promise<void> {
  const fixture = await createTempRecoveryOptionService();
  try {
    const claudeOption = fixture.service.getAll().find(option => option.command === 'claude');
    assert.ok(claudeOption);
    await fixture.service.updateOption(claudeOption.id, { enabled: false });
    const { workspaceService, calls } = createWorkspaceServiceHarness({
      recoveryOptionService: fixture.service,
      restoreInputDelayMs: 0,
    });
    (workspaceService as any).state = createWorkspaceStateWithTab({
      sessionId: 'orphan-session',
      shellType: 'powershell',
      lastCwd: 'C:\\repo',
      recoveryOptionId: claudeOption.id,
      recoveryCommand: 'claude',
      recoveryArguments: ['--continue'],
      recoveryIcon: { type: 'builtin', key: 'bot' },
      recoveryUpdatedAt: 'before',
    });

    const orphanTabIds = await workspaceService.checkOrphanTabs();

    const tab = (workspaceService as any).state.tabs[0];
    assert.deepEqual(orphanTabIds, ['tab-1']);
    assert.equal(calls.scheduleRestoreInput.length, 0);
    assert.equal(tab.recoveryOptionId, undefined);
    assert.equal(tab.recoveryCommand, undefined);
    assert.deepEqual(calls.order, [
      'createSession',
      'save:true',
      'save:true',
    ]);
  } finally {
    await fixture.cleanup();
  }
}

async function testWorkspaceServiceRestartSaveFailureDoesNotScheduleRestore(): Promise<void> {
  const fixture = await createTempRecoveryOptionService();
  try {
    const codexOption = fixture.service.getAll().find(option => option.command === 'codex');
    assert.ok(codexOption);
    const { workspaceService, calls } = createWorkspaceServiceHarness({
      recoveryOptionService: fixture.service,
      restoreInputDelayMs: 0,
    });
    (workspaceService as any).state = createWorkspaceStateWithTab({
      sessionId: 'old-session',
      shellType: 'bash',
      lastCwd: '/repo',
      recoveryOptionId: codexOption.id,
      recoveryCommand: 'codex',
      recoveryArguments: ['resume', '--last'],
      recoveryIcon: { type: 'builtin', key: 'terminal' },
    });
    (workspaceService as any).save = async (immediate = false) => {
      calls.order.push(`save:${immediate}:failed`);
      throw new Error('persist failed');
    };

    await assert.rejects(
      () => workspaceService.restartTab('ws-1', 'tab-1'),
      /persist failed/,
    );

    assert.equal(calls.scheduleRestoreInput.length, 0);
    assert.deepEqual(calls.order, [
      'createSession',
      'save:true:failed',
      'terminateSession:session-1:tab-restart',
    ]);
  } finally {
    await fixture.cleanup();
  }
}

async function testWorkspaceServiceRestartClearsDisabledRecoveryOption(): Promise<void> {
  const fixture = await createTempRecoveryOptionService();
  try {
    const codexOption = fixture.service.getAll().find(option => option.command === 'codex');
    assert.ok(codexOption);
    await fixture.service.updateOption(codexOption.id, { enabled: false });
    const { workspaceService, calls } = createWorkspaceServiceHarness({
      recoveryOptionService: fixture.service,
      restoreInputDelayMs: 0,
    });
    (workspaceService as any).state = createWorkspaceStateWithTab({
      sessionId: 'old-session',
      recoveryOptionId: codexOption.id,
      recoveryCommand: 'codex',
      recoveryArguments: ['resume', '--last'],
      recoveryIcon: { type: 'builtin', key: 'terminal' },
      recoveryUpdatedAt: 'before',
    });

    await workspaceService.restartTab('ws-1', 'tab-1');

    const tab = (workspaceService as any).state.tabs[0];
    assert.equal(calls.scheduleRestoreInput.length, 0);
    assert.equal(tab.recoveryOptionId, undefined);
    assert.equal(tab.recoveryCommand, undefined);
    assert.deepEqual(calls.order, [
      'createSession',
      'save:true',
      'save:true',
      'terminateSession:old-session:tab-restart',
    ]);
  } finally {
    await fixture.cleanup();
  }
}

async function testSessionRoutesDirectDeleteMarksWorkspaceTabStopped(): Promise<void> {
  const { workspaceService } = createWorkspaceServiceHarness();
  (workspaceService as any).state = createWorkspaceStateWithTab({
    sessionId: 'session-direct-delete',
  });

  const order: string[] = [];
  const originalHasSession = sessionManager.hasSession.bind(sessionManager);
  const originalTerminateSession = sessionManager.terminateSession.bind(sessionManager);
  (sessionManager as any).hasSession = (id: string) => {
    assert.equal(id, 'session-direct-delete');
    return true;
  };
  (sessionManager as any).terminateSession = async (id: string, options?: { reason?: string }) => {
    assert.equal(id, 'session-direct-delete');
    assert.equal(options?.reason, 'direct-session-delete');
    const tab = (workspaceService as any).state.tabs[0];
    assert.equal(tab.lifecycleState, 'stopped');
    assert.equal(tab.recoverable, false);
    assert.equal(tab.lifecycleReason, 'direct-session-delete');
    order.push('terminateSession');
    return true;
  };

  try {
    const app = express();
    app.use('/api/sessions', createSessionRoutes({
      onSessionDeleting: async (sessionId) => {
        order.push('onSessionDeleting');
        await workspaceService.markSessionStoppedByDirectDelete(sessionId);
      },
    }));

    const response = await invokeJsonRoute(app, {
      method: 'DELETE',
      path: '/api/sessions/session-direct-delete',
    });

    assert.equal(response.status, 204);
    const tab = (workspaceService as any).state.tabs[0];
    assert.equal(tab.lifecycleState, 'stopped');
    assert.equal(tab.recoverable, false);
    assert.equal(tab.lifecycleReason, 'direct-session-delete');
    assert.equal(tab.cleanupStatus, 'not-started');
    assert.deepEqual(order, ['onSessionDeleting', 'terminateSession']);
  } finally {
    (sessionManager as any).hasSession = originalHasSession;
    (sessionManager as any).terminateSession = originalTerminateSession;
  }
}

async function testSessionRoutesDirectDeleteSaveFailureDoesNotTerminate(): Promise<void> {
  const { workspaceService } = createWorkspaceServiceHarness();
  (workspaceService as any).state = createWorkspaceStateWithTab({
    sessionId: 'session-direct-delete',
    lifecycleState: 'active',
    recoverable: true,
    lifecycleReason: 'orphan-recovery',
    cleanupStatus: 'observed',
    lastExitCode: 7,
    lifecycleUpdatedAt: 'before-direct-delete',
    generation: 3,
  });
  const expectedLifecycle = pickWorkspaceTabLifecycle((workspaceService as any).state.tabs[0]);
  (workspaceService as any).save = async () => {
    throw new Error('persist failed');
  };

  const originalHasSession = sessionManager.hasSession.bind(sessionManager);
  const originalTerminateSession = sessionManager.terminateSession.bind(sessionManager);
  let terminateCount = 0;
  (sessionManager as any).hasSession = (id: string) => {
    assert.equal(id, 'session-direct-delete');
    return true;
  };
  (sessionManager as any).terminateSession = async () => {
    terminateCount += 1;
    return true;
  };

  try {
    const app = express();
    app.use('/api/sessions', createSessionRoutes({
      onSessionDeleting: (sessionId) => workspaceService.markSessionStoppedByDirectDelete(sessionId),
    }));

    const response = await invokeJsonRoute(app, {
      method: 'DELETE',
      path: '/api/sessions/session-direct-delete',
    });

    assert.equal(response.status, 500);
    assert.equal(terminateCount, 0);
    assert.equal((workspaceService as any).state.tabs[0].sessionId, 'session-direct-delete');
    assert.deepEqual(pickWorkspaceTabLifecycle((workspaceService as any).state.tabs[0]), expectedLifecycle);
  } finally {
    (sessionManager as any).hasSession = originalHasSession;
    (sessionManager as any).terminateSession = originalTerminateSession;
  }
}

async function testWorkspaceServiceTabNameSourceDefaults(): Promise<void> {
  const { workspaceService } = createWorkspaceServiceHarness();
  (workspaceService as any).state = {
    workspaces: [{
      id: 'ws-1',
      name: 'Workspace 1',
      sortOrder: 0,
      viewMode: 'tab',
      activeTabId: null,
      colorCounter: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }],
    tabs: [
      {
        id: 'tab-1',
        workspaceId: 'ws-1',
        sessionId: 'session-1',
        name: 'Terminal-1',
        colorIndex: 0,
        sortOrder: 0,
        shellType: 'bash',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'tab-2',
        workspaceId: 'ws-1',
        sessionId: 'session-2',
        name: 'Terminal-1 notes',
        colorIndex: 1,
        sortOrder: 1,
        shellType: 'bash',
        terminalTitle: '\x1b',
        createdAt: new Date().toISOString(),
      },
    ],
    gridLayouts: [],
  };

  for (const tab of (workspaceService as any).state.tabs) {
    (workspaceService as any).normalizeTabNameMetadata(tab);
  }

  const tabs = (workspaceService as any).state.tabs;
  assert.equal(tabs[0].nameSource, 'default');
  assert.equal(tabs[1].nameSource, 'user');
  assert.equal(tabs[1].terminalTitle, undefined);
}

async function testWorkspaceServiceApplyTerminalTitle(): Promise<void> {
  const { workspaceService } = createWorkspaceServiceHarness({ terminalTitleDebounceMs: 0 });
  const events: any[] = [];
  (workspaceService as any).state = createWorkspaceStateWithTab({
    sessionId: 'session-1',
    name: 'Terminal-1',
    nameSource: 'default',
  });
  workspaceService.onTabUpdated(event => events.push(event));

  await workspaceService.applyTerminalTitle('session-1', 'Auto Title');
  await workspaceService.applyTerminalTitle('session-1', 'Auto Title');

  const tab = (workspaceService as any).state.tabs[0];
  assert.equal(tab.name, 'Auto Title');
  assert.equal(tab.nameSource, 'terminal-title');
  assert.equal(tab.terminalTitle, 'Auto Title');
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].changes, {
    name: 'Auto Title',
    terminalTitle: 'Auto Title',
    nameSource: 'terminal-title',
  });
}

async function testWorkspaceServiceIgnoresAbsolutePathTerminalTitle(): Promise<void> {
  const { workspaceService } = createWorkspaceServiceHarness({ terminalTitleDebounceMs: 0 });
  const events: any[] = [];
  (workspaceService as any).state = createWorkspaceStateWithTab({
    sessionId: 'session-1',
    name: 'Terminal-1',
    nameSource: 'default',
  });
  workspaceService.onTabUpdated(event => events.push(event));

  await workspaceService.applyTerminalTitle('session-1', 'C:\\Work\\git\\_Snoworca\\ProjectMaster');
  await workspaceService.applyTerminalTitle('session-1', '/mnt/c/Work/git/_Snoworca/ProjectMaster');

  const tab = (workspaceService as any).state.tabs[0];
  assert.equal(tab.name, 'Terminal-1');
  assert.equal(tab.nameSource, 'default');
  assert.equal(tab.terminalTitle, undefined);
  assert.equal(events.length, 0);
}

async function testWorkspaceServiceTerminalTitleRespectsUserName(): Promise<void> {
  const { workspaceService } = createWorkspaceServiceHarness({ terminalTitleDebounceMs: 0 });
  const events: any[] = [];
  (workspaceService as any).state = createWorkspaceStateWithTab({
    sessionId: 'session-1',
    name: 'Manual Name',
    nameSource: 'user',
  });
  workspaceService.onTabUpdated(event => events.push(event));

  await workspaceService.applyTerminalTitle('session-1', 'Ignored Title');

  const tab = (workspaceService as any).state.tabs[0];
  assert.equal(tab.name, 'Manual Name');
  assert.equal(tab.nameSource, 'user');
  assert.equal(events.length, 0);
}

async function testWorkspaceServiceTerminalTitleDebounce(): Promise<void> {
  const { workspaceService } = createWorkspaceServiceHarness({ terminalTitleDebounceMs: 10 });
  const events: any[] = [];
  (workspaceService as any).state = createWorkspaceStateWithTab({
    sessionId: 'session-1',
    name: 'Terminal-1',
    nameSource: 'default',
  });
  workspaceService.onTabUpdated(event => events.push(event));

  await workspaceService.applyTerminalTitle('session-1', 'Burst 1');
  await workspaceService.applyTerminalTitle('session-1', 'Burst 2');
  await workspaceService.applyTerminalTitle('session-1', 'Burst Final');
  await delay(30);

  const tab = (workspaceService as any).state.tabs[0];
  assert.equal(tab.name, 'Burst Final');
  assert.equal(events.length, 1);
  assert.equal(events[0].changes.name, 'Burst Final');
}

async function testWorkspaceServiceAbsolutePathTitleCancelsPendingDebounce(): Promise<void> {
  const { workspaceService } = createWorkspaceServiceHarness({ terminalTitleDebounceMs: 30 });
  const events: any[] = [];
  (workspaceService as any).state = createWorkspaceStateWithTab({
    sessionId: 'session-1',
    name: 'Terminal-1',
    nameSource: 'default',
  });
  workspaceService.onTabUpdated(event => events.push(event));

  await workspaceService.applyTerminalTitle('session-1', 'Pending Title');
  await workspaceService.applyTerminalTitle('session-1', 'C:\\Work\\git\\_Snoworca\\ProjectMaster');
  await delay(60);

  const tab = (workspaceService as any).state.tabs[0];
  assert.equal(tab.name, 'Terminal-1');
  assert.equal(tab.nameSource, 'default');
  assert.equal(tab.terminalTitle, undefined);
  assert.equal(events.length, 0);
}

async function testWorkspaceServiceManualRenameCancelsPendingTitle(): Promise<void> {
  const { workspaceService } = createWorkspaceServiceHarness({ terminalTitleDebounceMs: 30 });
  (workspaceService as any).state = createWorkspaceStateWithTab({
    sessionId: 'session-1',
    name: 'Existing Auto Title',
    nameSource: 'terminal-title',
    terminalTitle: 'Existing Auto Title',
  });

  await workspaceService.applyTerminalTitle('session-1', 'Pending Title');
  await workspaceService.updateTab('tab-1', { name: 'Manual Lock' });
  await delay(60);

  const tab = (workspaceService as any).state.tabs[0];
  assert.equal(tab.name, 'Manual Lock');
  assert.equal(tab.nameSource, 'user');
  assert.equal(tab.terminalTitle, undefined);
}

async function testWorkspaceServiceRestartCancelsPendingTitle(): Promise<void> {
  const { workspaceService } = createWorkspaceServiceHarness({ terminalTitleDebounceMs: 30 });
  (workspaceService as any).state = createWorkspaceStateWithTab({
    sessionId: 'old-session',
    name: 'Terminal-1',
    nameSource: 'default',
  });

  await workspaceService.applyTerminalTitle('old-session', 'Old Pending');
  const tab = await workspaceService.restartTab('ws-1', 'tab-1');
  await delay(60);

  assert.notEqual(tab.sessionId, 'old-session');
  assert.equal(tab.name, 'Terminal-1');
  assert.equal(tab.nameSource, 'default');
}

async function testWorkspaceTabRenameRouteBroadcastsNormalizedMetadata(): Promise<void> {
  const { workspaceService } = createWorkspaceServiceHarness({ terminalTitleDebounceMs: 0 });
  const broadcasts: Array<{ event: string; data: any; excludeClientId?: string }> = [];
  (workspaceService as any).state = createWorkspaceStateWithTab({
    sessionId: 'session-1',
    name: 'Auto Title',
    nameSource: 'terminal-title',
    terminalTitle: 'Auto Title',
  });

  const app = express();
  app.use(express.json());
  app.set('wsRouter', {
    broadcastAll(event: string, data: object, excludeClientId?: string) {
      broadcasts.push({ event, data, excludeClientId });
    },
  });
  app.use('/api/workspaces', createWorkspaceRoutes(workspaceService));

  const response = await invokeJsonRoute(app, {
    method: 'PATCH',
    path: '/api/workspaces/ws-1/tabs/tab-1',
    headers: { 'x-client-id': 'client-1' },
    body: {
      name: 'Manual Lock',
      nameSource: 'terminal-title',
      terminalTitle: 'Client Supplied Title',
    },
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.name, 'Manual Lock');
  assert.equal(response.body.nameSource, 'user');
  assert.equal('terminalTitle' in response.body, false);
  assert.equal(broadcasts.length, 1);
  assert.equal(broadcasts[0].event, 'tab:updated');
  assert.equal(broadcasts[0].excludeClientId, 'client-1');
  assert.deepEqual(broadcasts[0].data, {
    id: 'tab-1',
    workspaceId: 'ws-1',
    changes: {
      name: 'Manual Lock',
      nameSource: 'user',
      terminalTitle: null,
    },
  });
}

async function testWorkspaceTabMoveRouteBroadcastsMovedState(): Promise<void> {
  const { workspaceService, calls } = createWorkspaceServiceHarness({ terminalTitleDebounceMs: 0 });
  const broadcasts: Array<{ event: string; data: any; excludeClientId?: string }> = [];
  (workspaceService as any).state = createWorkspaceMoveState();
  calls.hasSession.add('session-1');
  calls.hasSession.add('session-2');
  calls.hasSession.add('session-3');

  const app = express();
  app.use(express.json());
  app.set('wsRouter', {
    broadcastAll(event: string, data: object, excludeClientId?: string) {
      broadcasts.push({ event, data, excludeClientId });
    },
  });
  app.use('/api/workspaces', createWorkspaceRoutes(workspaceService));

  const response = await invokeJsonRoute(app, {
    method: 'POST',
    path: '/api/workspaces/ws-1/tabs/tab-2/move',
    headers: { 'x-client-id': 'client-1' },
    body: { targetWorkspaceId: 'ws-2' },
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.tab.id, 'tab-2');
  assert.equal(response.body.tab.workspaceId, 'ws-2');
  assert.deepEqual(response.body.sourceTabIds, ['tab-1']);
  assert.deepEqual(response.body.targetTabIds, ['tab-3', 'tab-2']);
  assert.equal(response.body.sourceActiveTabId, 'tab-1');
  assert.equal(response.body.targetActiveTabId, 'tab-2');
  assert.equal(broadcasts.length, 1);
  assert.equal(broadcasts[0].event, 'tab:moved');
  assert.equal(broadcasts[0].excludeClientId, 'client-1');
  assert.deepEqual(broadcasts[0].data, response.body);
}

function createWorkspaceStateWithTab(tab: Partial<any>) {
  const now = new Date().toISOString();
  return {
    workspaces: [{
      id: 'ws-1',
      name: 'Workspace 1',
      sortOrder: 0,
      viewMode: 'tab',
      activeTabId: 'tab-1',
      colorCounter: 0,
      createdAt: now,
      updatedAt: now,
    }],
    tabs: [{
      id: 'tab-1',
      workspaceId: 'ws-1',
      sessionId: 'session-1',
      name: 'Terminal-1',
      colorIndex: 0,
      sortOrder: 0,
      shellType: 'bash',
      createdAt: now,
      ...tab,
    }],
    gridLayouts: [],
  };
}

function createWorkspaceMoveState() {
  const now = new Date().toISOString();
  return {
    workspaces: [
      {
        id: 'ws-1',
        name: 'Source',
        sortOrder: 0,
        viewMode: 'tab',
        activeTabId: 'tab-2',
        colorCounter: 0,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'ws-2',
        name: 'Target',
        sortOrder: 1,
        viewMode: 'grid',
        activeTabId: 'tab-3',
        colorCounter: 0,
        createdAt: now,
        updatedAt: now,
      },
    ],
    tabs: [
      {
        id: 'tab-1',
        workspaceId: 'ws-1',
        sessionId: 'session-1',
        name: 'Source 1',
        colorIndex: 0,
        sortOrder: 0,
        shellType: 'bash',
        createdAt: now,
        lifecycleState: 'active',
        recoverable: true,
      },
      {
        id: 'tab-2',
        workspaceId: 'ws-1',
        sessionId: 'session-2',
        name: 'Source 2',
        colorIndex: 1,
        sortOrder: 1,
        shellType: 'bash',
        createdAt: now,
        lifecycleState: 'active',
        recoverable: true,
      },
      {
        id: 'tab-3',
        workspaceId: 'ws-2',
        sessionId: 'session-3',
        name: 'Target 1',
        colorIndex: 2,
        sortOrder: 0,
        shellType: 'bash',
        createdAt: now,
        lifecycleState: 'active',
        recoverable: true,
      },
    ],
    gridLayouts: [],
  };
}

function pickWorkspaceTabLifecycle(tab: any) {
  return {
    lifecycleState: tab.lifecycleState,
    recoverable: tab.recoverable,
    lifecycleReason: tab.lifecycleReason,
    cleanupStatus: tab.cleanupStatus,
    lastExitCode: tab.lastExitCode,
    lifecycleUpdatedAt: tab.lifecycleUpdatedAt,
    generation: tab.generation,
  };
}

async function invokeJsonRoute(
  app: express.Express,
  options: {
    method: string;
    path: string;
    body?: Record<string, unknown>;
    headers?: Record<string, string>;
  },
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const port = (server.address() as net.AddressInfo).port;
      const requestBody = JSON.stringify(options.body ?? {});
      const headers: Record<string, string | number> = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(requestBody),
        ...(options.headers ?? {}),
      };
      const request = http.request({
        hostname: '127.0.0.1',
        port,
        method: options.method,
        path: options.path,
        headers,
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          server.close();
          try {
            const payload = Buffer.concat(chunks).toString();
            resolve({
              status: res.statusCode ?? 0,
              body: payload ? JSON.parse(payload) : {},
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
      request.write(requestBody);
      request.end();
    });
    server.on('error', reject);
  });
}

async function testCommandPresetServiceCrudAndReorder(): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'buildergate-command-presets-'));
  const dataPath = path.join(tempDir, 'command-presets.json');

  try {
    const service = new CommandPresetService({ dataPath });
    await service.initialize();

    const first = await service.createPreset({
      kind: 'command',
      label: 'List',
      value: 'ls',
    });
    const second = await service.createPreset({
      kind: 'command',
      label: 'Print',
      value: 'pwd',
    });
    const prompt = await service.createPreset({
      kind: 'prompt',
      label: 'Prompt',
      value: 'line 1\nline 2',
    });

    assert.equal(first.sortOrder, 0);
    assert.equal(second.sortOrder, 1);
    assert.equal(prompt.value, 'line 1\nline 2');

    const updated = await service.updatePreset(first.id, { label: 'List files' });
    assert.equal(updated.label, 'List files');

    await service.reorderPresets('command', [second.id, first.id]);
    assert.deepEqual(
      service.getAll().filter(item => item.kind === 'command').map(item => item.id),
      [second.id, first.id],
    );

    await service.deletePreset(second.id);
    assert.deepEqual(
      service.getAll().filter(item => item.kind === 'command').map(item => item.sortOrder),
      [0],
    );

    const reloaded = new CommandPresetService({ dataPath });
    await reloaded.initialize();
    assert.deepEqual(reloaded.getAll().map(item => item.label), ['List files', 'Prompt']);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function testCommandPresetServiceConcurrentCreates(): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'buildergate-command-presets-concurrent-'));
  const dataPath = path.join(tempDir, 'command-presets.json');

  try {
    const service = new CommandPresetService({ dataPath });
    await service.initialize();

    const created = await Promise.all(Array.from({ length: 20 }, (_unused, index) => {
      return service.createPreset({
        kind: 'command',
        label: `Concurrent ${index}`,
        value: `echo ${index}`,
      });
    }));

    assert.equal(created.length, 20);
    assert.equal(new Set(created.map(preset => preset.id)).size, 20);
    assert.deepEqual(
      service.getAll().map(preset => preset.sortOrder),
      Array.from({ length: 20 }, (_unused, index) => index),
    );

    const reloaded = new CommandPresetService({ dataPath });
    await reloaded.initialize();
    assert.equal(reloaded.getAll().length, 20);
    assert.deepEqual(
      reloaded.getAll().map(preset => preset.sortOrder),
      Array.from({ length: 20 }, (_unused, index) => index),
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function testCommandPresetRoutesCrudAndValidation(): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'buildergate-command-preset-routes-'));
  const dataPath = path.join(tempDir, 'command-presets.json');

  try {
    const service = new CommandPresetService({ dataPath });
    await service.initialize();

    const app = express();
    app.use(express.json());
    app.use('/api/command-presets', createCommandPresetRoutes(service));

    const created = await requestJson(app, 'POST', '/api/command-presets', {
      kind: 'directory',
      label: 'Repo',
      value: 'C:\\Work\\git',
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.label, 'Repo');

    const listed = await requestJson(app, 'GET', '/api/command-presets');
    assert.equal(listed.status, 200);
    assert.equal(Array.isArray(listed.body.presets), true);
    assert.equal((listed.body.presets as unknown[]).length, 1);

    const invalidOrder = await requestJson(app, 'PUT', '/api/command-presets/order', {
      kind: 'directory',
      presetIds: [],
    });
    assert.equal(invalidOrder.status, 400);
    assert.equal((invalidOrder.body.error as { code?: string }).code, 'INVALID_INPUT');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function testRecoveryOptionServiceSeedsDefaultsOnce(): Promise<void> {
  const fixture = await createTempRecoveryOptionService();
  try {
    const initialCommands = fixture.service.getAll().map(option => option.command);
    assert.deepEqual(initialCommands, ['claude', 'codex']);

    const codexOption = fixture.service.getAll().find(option => option.command === 'codex');
    assert.ok(codexOption);
    await fixture.service.deleteOption(codexOption.id);

    const reloaded = new RecoveryOptionService({
      dataPath: fixture.service.getDataFilePath(),
    });
    await reloaded.initialize();
    assert.deepEqual(reloaded.getAll().map(option => option.command), ['claude']);
  } finally {
    await fixture.cleanup();
  }
}

async function testRecoveryOptionServiceFindsEnabledSubmittedCommand(): Promise<void> {
  const fixture = await createTempRecoveryOptionService();
  try {
    const codex = fixture.service.findEnabledBySubmittedCommand('env FOO=bar "C:\\Tools\\codex.exe" --profile work');
    assert.equal(codex?.command, 'codex');
    assert.deepEqual(codex?.arguments, ['resume', '--last']);

    if (!codex) {
      throw new Error('codex option missing');
    }
    await fixture.service.updateOption(codex.id, { enabled: false });
    assert.equal(fixture.service.findEnabledBySubmittedCommand('codex'), null);
  } finally {
    await fixture.cleanup();
  }
}

async function testRecoveryCommandExecutableParsing(): Promise<void> {
  assert.equal(getRecoveryExecutableToken('FOO=bar env BAZ=1 /usr/local/bin/claude --continue'), 'claude');
  assert.equal(getRecoveryExecutableToken('command "C:\\Tools\\codex.cmd" resume --last'), 'codex');
  assert.equal(getRecoveryExecutableToken('"C:\\Program Files\\OpenAI Codex\\codex.exe" resume --last'), 'codex');
  assert.equal(getRecoveryExecutableToken('env A=1 command /opt/bin/claudep'), 'claudep');
  assert.equal(getRecoveryExecutableToken('   '), null);
  assert.equal(
    buildRecoveryRestoreInput('bash', 'codex', ['resume', '--last', '$(touch injected)', 'path with spaces']),
    "codex 'resume' '--last' '$(touch injected)' 'path with spaces'\r",
  );
  assert.equal(
    buildRecoveryRestoreInput('powershell', 'claude', ['--continue', '$(Write-Error injected)']),
    "claude '--continue' '$(Write-Error injected)'\r",
  );
  assert.equal(
    buildRecoveryRestoreInput('cmd', 'codex', ['resume', '%PATH%', 'x!y']),
    'codex "resume" "^%PATH^%" "x^!y"\r',
  );
}

async function testRecoveryCommandRestoreQuoting(): Promise<void> {
  assert.equal(
    buildRecoveryRestoreInput('powershell', 'claude', ["O'Reilly", 'path with spaces']),
    "claude 'O''Reilly' 'path with spaces'\r",
  );
  assert.equal(
    buildRecoveryRestoreInput('bash', 'claude', ["O'Reilly", 'path with spaces']),
    "claude 'O'\\''Reilly' 'path with spaces'\r",
  );
  assert.equal(
    buildRecoveryRestoreInput('zsh', 'claude', ["O'Reilly"]),
    "claude 'O'\\''Reilly'\r",
  );
  assert.equal(
    buildRecoveryRestoreInput('sh', 'claude', ["O'Reilly"]),
    "claude 'O'\\''Reilly'\r",
  );
  assert.equal(
    buildRecoveryRestoreInput('cmd', 'claude', ['100% done', 'x!y', 'say "hi"']),
    'claude "100^% done" "x^!y" "say ""hi"""\r',
  );
}

async function testRecoveryOptionRoutesCrudAndAuth(): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'buildergate-recovery-option-routes-'));
  const dataPath = path.join(tempDir, 'recovery-options.json');
  const authService = new AuthService({
    password: '1234',
    durationMs: 60_000,
    maxDurationMs: 60_000,
    jwtSecret: 'recovery-option-route-test-secret',
  }, new CryptoService('recovery-option-route-test'));
  const updatedOptions: string[] = [];
  const deletedOptions: string[] = [];

  try {
    const service = new RecoveryOptionService({ dataPath });
    await service.initialize();
    const token = authService.issueToken().token;
    const authHeaders = { Authorization: `Bearer ${token}` };

    const app = express();
    app.use(express.json());
    app.use('/api/recovery-options', createAuthMiddleware(authService), createRecoveryOptionRoutes(service, {
      onOptionUpdated: (option) => {
        updatedOptions.push(option.id);
      },
      onOptionDeleted: (id) => {
        deletedOptions.push(id);
      },
    }));

    for (const request of [
      { method: 'GET', path: '/api/recovery-options' },
      { method: 'POST', path: '/api/recovery-options', body: { command: 'x' } },
      { method: 'PATCH', path: '/api/recovery-options/missing', body: { enabled: false } },
      { method: 'DELETE', path: '/api/recovery-options/missing' },
      { method: 'PUT', path: '/api/recovery-options/order', body: { optionIds: [] } },
    ]) {
      const unauthenticated = await requestJson(app, request.method, request.path, request.body);
      assert.equal(unauthenticated.status, 401);
    }

    const created = await requestJson(app, 'POST', '/api/recovery-options', {
      command: 'claudep',
      arguments: ['--continue'],
      icon: { type: 'text', value: 'CP' },
    }, authHeaders);
    assert.equal(created.status, 201);
    assert.equal(created.body.command, 'claudep');
    const createdId = created.body.id as string;

    const patched = await requestJson(app, 'PATCH', `/api/recovery-options/${createdId}`, {
      enabled: false,
    }, authHeaders);
    assert.equal(patched.status, 200);
    assert.equal(patched.body.enabled, false);
    assert.deepEqual(updatedOptions, [createdId]);

    const listed = await requestJson(app, 'GET', '/api/recovery-options', undefined, authHeaders);
    assert.equal(listed.status, 200);
    assert.equal(Array.isArray(listed.body.options), true);

    const deleted = await requestJson(app, 'DELETE', `/api/recovery-options/${createdId}`, undefined, authHeaders);
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.success, true);
    assert.deepEqual(deletedOptions, [createdId]);
  } finally {
    authService.destroy();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function createShortcutBindingFixture(
  overrides: Partial<CreateTerminalShortcutBindingInput> = {},
): CreateTerminalShortcutBindingInput {
  return {
    scope: 'workspace',
    workspaceId: 'workspace-1',
    key: 'Enter',
    code: 'Enter',
    ctrlKey: false,
    shiftKey: true,
    altKey: false,
    metaKey: false,
    location: 0,
    action: { type: 'send', data: '\n', label: 'LF' },
    description: '줄바꿈',
    ...overrides,
  };
}

async function testTerminalShortcutServiceCrudValidationAndRecovery(): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'buildergate-terminal-shortcuts-'));
  const dataPath = path.join(tempDir, 'terminal-shortcuts.json');

  try {
    const service = new TerminalShortcutService({ dataPath });
    await service.initialize();

    const initialState = service.getState();
    assert.equal(initialState.profileSelections.some(selection => selection.scope === 'global' && selection.profile === 'xterm-default'), true);

    const stateWithProfile = await service.setProfileSelection({
      scope: 'workspace',
      workspaceId: 'workspace-1',
      profile: 'ai-tui-compat',
    });
    assert.equal(
      stateWithProfile.profileSelections.some(selection => selection.workspaceId === 'workspace-1' && selection.profile === 'ai-tui-compat'),
      true,
    );

    const created = await service.createBinding(createShortcutBindingFixture());
    assert.equal(created.sortOrder, 0);
    assert.equal(created.description, '줄바꿈');

    const updated = await service.updateBinding(created.id, {
      enabled: false,
      description: '줄바꿈 수정',
    });
    assert.equal(updated.enabled, false);
    assert.equal(updated.description, '줄바꿈 수정');

    const ctrlSpace = await service.createBinding(createShortcutBindingFixture({
      key: ' ',
      code: 'Space',
      ctrlKey: true,
      shiftKey: false,
      action: { type: 'send', data: '\n', label: 'LF' },
      description: 'Ctrl+Space 경계값',
    }));
    assert.equal(ctrlSpace.key, ' ');

    await assert.rejects(
      () => service.createBinding(createShortcutBindingFixture({
        key: 'v',
        code: 'KeyV',
        ctrlKey: true,
        shiftKey: false,
      })),
      (error: unknown) => error instanceof AppError && error.code === ErrorCode.INVALID_INPUT,
    );

    await assert.rejects(
      () => service.createBinding(createShortcutBindingFixture({
        action: { type: 'send', data: 'x'.repeat(129) },
      })),
      (error: unknown) => error instanceof AppError && error.code === ErrorCode.INVALID_INPUT,
    );

    const reloaded = new TerminalShortcutService({ dataPath });
    await reloaded.initialize();
    assert.equal(reloaded.getState().bindings.length, 2);
    assert.equal(reloaded.getState().bindings[0].description, '줄바꿈 수정');

    await reloaded.updateBinding(created.id, { enabled: true });
    await fs.writeFile(dataPath, '{ broken', 'utf-8');

    const recovered = new TerminalShortcutService({ dataPath });
    await recovered.initialize();
    assert.equal(recovered.getState().bindings.length, 2);

    const resetState = await recovered.resetScope({ scope: 'workspace', workspaceId: 'workspace-1' });
    assert.equal(resetState.bindings.some(binding => binding.workspaceId === 'workspace-1'), false);
    assert.equal(resetState.profileSelections.some(selection => selection.workspaceId === 'workspace-1'), false);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function testTerminalShortcutServiceConcurrentCreates(): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'buildergate-terminal-shortcuts-concurrent-'));
  const dataPath = path.join(tempDir, 'terminal-shortcuts.json');

  try {
    const service = new TerminalShortcutService({ dataPath });
    await service.initialize();

    const created = await Promise.all(Array.from({ length: 20 }, (_unused, index) => {
      return service.createBinding(createShortcutBindingFixture({
        scope: 'global',
        workspaceId: undefined,
        key: `F${index + 1}`,
        code: `F${index + 1}`,
        shiftKey: false,
        action: { type: 'send', data: `\x1b[${index}~`, label: `F${index + 1}` },
        description: `shortcut ${index}`,
      }));
    }));

    assert.equal(created.length, 20);
    assert.equal(new Set(created.map(binding => binding.id)).size, 20);
    assert.deepEqual(
      service.getState().bindings.map(binding => binding.sortOrder),
      Array.from({ length: 20 }, (_unused, index) => index),
    );

    const reloaded = new TerminalShortcutService({ dataPath });
    await reloaded.initialize();
    assert.equal(reloaded.getState().bindings.length, 20);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function testTerminalShortcutRoutesCrudValidationAndAuth(): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'buildergate-terminal-shortcut-routes-'));
  const dataPath = path.join(tempDir, 'terminal-shortcuts.json');
  const authService = new AuthService({
    password: '1234',
    durationMs: 60_000,
    maxDurationMs: 60_000,
    jwtSecret: 'terminal-shortcut-route-test-secret',
  }, new CryptoService('terminal-shortcut-route-test'));

  try {
    const service = new TerminalShortcutService({ dataPath });
    await service.initialize();
    const token = authService.issueToken().token;
    const authHeaders = { Authorization: `Bearer ${token}` };

    const app = express();
    app.use(express.json());
    app.use('/api/terminal-shortcuts', createAuthMiddleware(authService), createTerminalShortcutRoutes(service));

    for (const request of [
      { method: 'GET', path: '/api/terminal-shortcuts' },
      { method: 'PUT', path: '/api/terminal-shortcuts/profile', body: { scope: 'global', profile: 'xterm-default' } },
      { method: 'POST', path: '/api/terminal-shortcuts/bindings', body: createShortcutBindingFixture() },
      { method: 'PATCH', path: '/api/terminal-shortcuts/bindings/missing', body: { enabled: false } },
      { method: 'DELETE', path: '/api/terminal-shortcuts/bindings/missing' },
      { method: 'POST', path: '/api/terminal-shortcuts/reset', body: { scope: 'global' } },
    ]) {
      const unauthenticated = await requestJson(app, request.method, request.path, request.body);
      assert.equal(unauthenticated.status, 401);
    }

    const initial = await requestJson(app, 'GET', '/api/terminal-shortcuts', undefined, authHeaders);
    assert.equal(initial.status, 200);
    assert.equal(Array.isArray(initial.body.profileSelections), true);

    const profile = await requestJson(app, 'PUT', '/api/terminal-shortcuts/profile', {
      scope: 'workspace',
      workspaceId: 'workspace-1',
      profile: 'ai-tui-compat',
    }, authHeaders);
    assert.equal(profile.status, 200);

    const created = await requestJson(app, 'POST', '/api/terminal-shortcuts/bindings', createShortcutBindingFixture(), authHeaders);
    assert.equal(created.status, 201);
    assert.equal((created.body.action as { type?: string }).type, 'send');
    const bindingId = created.body.id as string;

    const patched = await requestJson(app, 'PATCH', `/api/terminal-shortcuts/bindings/${bindingId}`, {
      enabled: false,
    }, authHeaders);
    assert.equal(patched.status, 200);
    assert.equal(patched.body.enabled, false);

    const invalid = await requestJson(app, 'POST', '/api/terminal-shortcuts/bindings', createShortcutBindingFixture({
      key: 'c',
      code: 'KeyC',
      ctrlKey: true,
      shiftKey: false,
    }), authHeaders);
    assert.equal(invalid.status, 400);
    assert.equal((invalid.body.error as { code?: string }).code, 'INVALID_INPUT');

    const deleted = await requestJson(app, 'DELETE', `/api/terminal-shortcuts/bindings/${bindingId}`, undefined, authHeaders);
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.success, true);

    const reset = await requestJson(app, 'POST', '/api/terminal-shortcuts/reset', {
      scope: 'workspace',
      workspaceId: 'workspace-1',
    }, authHeaders);
    assert.equal(reset.status, 200);
    assert.equal(Array.isArray(reset.body.bindings), true);
  } finally {
    authService.destroy();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function requestJson(
  app: ReturnType<typeof express>,
  method: string,
  requestPath: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const port = (server.address() as net.AddressInfo).port;
      const postBody = body ? JSON.stringify(body) : '';
      const headers: Record<string, string | number> = { ...extraHeaders };
      if (body) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(postBody);
      }

      const request = http.request({
        hostname: '127.0.0.1',
        port,
        method,
        path: requestPath,
        headers,
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          server.close();
          try {
            const payload = Buffer.concat(chunks).toString();
            const parsed = payload ? JSON.parse(payload) as Record<string, unknown> : {};
            resolve({ status: res.statusCode ?? 0, body: parsed });
          } catch (error) {
            reject(error);
          }
        });
      });
      request.on('error', (error: Error) => {
        server.close();
        reject(error);
      });
      if (body) {
        request.write(postBody);
      }
      request.end();
    });
  });
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
    assert.match(savedContent, /jwtSecret:\s*"enc\(/);
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
    assert.match(savedContent, /jwtSecret:\s*"enc\(/);
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
