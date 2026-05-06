import * as pty from 'node-pty';
import { v4 as uuidv4 } from 'uuid';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { unlinkSync, watchFile, unwatchFile, readFileSync, existsSync, statSync } from 'fs';
import { execFile, execFileSync, execSync } from 'child_process';
import { Session, SessionDTO, SessionStatus, UpdateSessionRequest, ShellType, ShellInfo } from '../types/index.js';
import type { PTYConfig, SessionConfig, WindowsPowerShellBackend as PowerShellBackendPolicy } from '../types/config.types.js';
import { config } from '../utils/config.js';
import { AppError, ErrorCode } from '../utils/errors.js';
import {
  createHeadlessTerminalState,
  disposeHeadlessTerminal,
  resizeHeadlessTerminal,
  serializeHeadlessTerminal,
  type HeadlessTerminalState,
  writeHeadlessTerminal,
} from '../utils/headlessTerminal.js';
import { truncateTerminalPayloadTail } from '../utils/terminalPayload.js';
import type { WsRouter } from '../ws/WsRouter.js';
import { OscDetector } from './OscDetector.js';
import type { InputDebugMetadata, WindowsPtyBackend, WindowsPtyInfo } from '../types/ws-protocol.js';
import {
  normalizePtyConfigForPlatform,
  normalizeShellForPlatform,
} from '../utils/ptyPlatformPolicy.js';
import {
  buildInputDebugDetails,
  formatSafeInputPreview,
  type InputDebugValue,
} from '../utils/inputDebugMetadata.js';
import {
  ForegroundAppDetectorRegistry,
  createInitialDerivedState,
  deriveDisplayStatus,
  type DetectionMode,
  type ForegroundAppObservation,
  type SessionDerivedState,
  type SessionShellType,
} from './ForegroundAppDetector.js';
import { HermesForegroundDetector } from './HermesForegroundDetector.js';

interface EchoTracker {
  /** writeInput이 호출된 시각 (ms, Date.now) */
  lastInputAt: number;
  /** 마지막 입력 데이터의 바이트 길이 */
  recentInputs: Array<{
    at: number;
    hasEnter: boolean;
    inputClass: string;
  }>;
  /** 마지막 입력에 Enter(\r 또는 \n) 포함 여부 */
  lastInputHasEnter: boolean;
}

type HeadlessHealth = 'healthy' | 'degraded';

interface SessionSnapshotCache {
  seq: number;
  cols: number;
  rows: number;
  data: string;
  truncated: boolean;
  generatedAt: number;
  dirty: boolean;
}

interface SessionScreenSnapshot {
  seq: number;
  cols: number;
  rows: number;
  data: string;
  truncated: boolean;
  generatedAt: number;
  health: HeadlessHealth;
  windowsPty?: WindowsPtyInfo;
}

interface DeferredSignal<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

interface SessionManagerObservability {
  totalSessions: number;
  healthySessions: number;
  degradedSessions: number;
  snapshotRequests: number;
  snapshotCacheHits: number;
  snapshotSerializeFailures: number;
  snapshotFallbacks: number;
  oversizedSnapshots: number;
  totalSnapshotBytes: number;
  maxSnapshotBytesObserved: number;
  totalSnapshotSerializeMs: number;
  maxSnapshotSerializeMs: number;
}

type SessionDebugCaptureValue = string | number | boolean | null;

interface SessionDebugCaptureEvent {
  eventId: number;
  recordedAt: string;
  sessionId: string;
  source: 'pty' | 'snapshot' | 'headless' | 'detector';
  kind: string;
  details?: Record<string, SessionDebugCaptureValue>;
  preview?: string;
}

const LEGACY_TRUNCATED_REPLAY_PLACEHOLDER = '\r\n[BuilderGate] Screen snapshot exceeded maxSnapshotBytes. Waiting for new output...\r\n';
const LEGACY_DEGRADED_REPLAY_PLACEHOLDER = '\r\n[BuilderGate] Server snapshot is unavailable for this session. Using fallback recovery when possible...\r\n';
const MAX_DEBUG_CAPTURE_EVENTS = 400;
const DEBUG_CAPTURE_PREVIEW_CHARS = 320;
const DEBUG_INPUT_CORRELATION_WINDOW_MS = 500;
const DEBUG_INPUT_SAMPLE_LIMIT = 8;
const MAX_RESIZE_REPLAY_DELAY_MS = 400;
const RESIZE_REPLAY_QUIET_WINDOW_MS = 120;
const DEFAULT_RUNNING_DELAY_MS = 250;
const AI_TUI_TYPING_FEEDBACK_THRESHOLD_MS = 1000;
const AI_TUI_SUBMITTED_ECHO_THRESHOLD_MS = 1000;
const AI_TUI_DECORATIVE_FRAME_RE = /^[\s─╰╯│┃┆┄┈┊·•]+$/;
const AI_TUI_CURSOR_MOTION_RE = /\x1b\[[0-9;?]*[ABCDHJKfhlmnpsu]/;
const SHELL_INTEGRATION_ROOT_ENV_KEY = 'BUILDERGATE_SHELL_INTEGRATION_ROOT';

type ForegroundAppId = 'hermes' | 'codex' | 'claude';

interface AiTuiLaunchAttempt {
  appId: ForegroundAppId;
  command: string;
  executable: string;
  startedAt: number;
}

interface DerivedStateSyncOptions {
  preservePendingRunningTransition?: boolean;
}

interface SessionManagerDeps {
  execFileFn?: typeof execFile;
  execFileSyncFn?: typeof execFileSync;
  platform?: NodeJS.Platform;
  spawnPty?: typeof pty.spawn;
}

interface SessionData {
  session: Session;
  pty: pty.IPty;
  idleTimer: NodeJS.Timeout | null;
  runningTimer: NodeJS.Timeout | null;
  shellType?: SessionShellType;
  headless: HeadlessTerminalState | null;
  headlessHealth: HeadlessHealth;
  headlessWriteChain: Promise<void>;
  headlessCloseSignal: DeferredSignal<void>;
  pendingHeadlessWrites: number;
  cols: number;
  rows: number;
  screenSeq: number;
  snapshotCache: SessionSnapshotCache | null;
  windowsPty?: WindowsPtyInfo;
  degradedReplayBuffer: string;
  degradedReplayTruncated: boolean;
  pendingOutputChunks: string[];
  unsnapshottedOutput: string;
  unsnapshottedOutputTruncated: boolean;
  initialCwd: string;   // CWD at session creation
  cwdFilePath?: string;  // Windows CWD tracking temp file path
  lastCwd?: string;      // Last known CWD for change detection

  // === Step 9: Idle Detection ===
  echoTracker: EchoTracker;
  detectionMode: DetectionMode;
  oscDetector: OscDetector;
  derivedState?: SessionDerivedState;
  foregroundDetectorRegistry?: ForegroundAppDetectorRegistry;
  inputBuffer: string;
  pendingForegroundAppHint?: ForegroundAppId;
  aiTuiLaunchAttempt?: AiTuiLaunchAttempt;
  expectShellPromptAfterAiTuiFailure?: boolean;
  lastSubmittedCommand?: string;
  foregroundStartedAt?: number;
}

/**
 * Sanitize a CWD value read from the tracking temp file.
 * Rejects control characters, null bytes, excessive length; strips BOM.
 */
function sanitizeCwd(raw: string): string | null {
  if (!raw) return null;
  // Strip PowerShell UTF-8 BOM
  let cleaned = raw.replace(/^\uFEFF/, '').trim();
  if (!cleaned) return null;
  // Reject if > 4096 chars
  if (cleaned.length > 4096) return null;
  // Reject control characters (\x00-\x1f) except nothing — all are rejected
  if (/[\x00-\x1f]/.test(cleaned)) return null;
  return cleaned;
}

export class SessionManager {
  private sessions: Map<string, SessionData> = new Map();
  private sessionCounter: number = 0;
  private debugCaptureCounter = 0;
  private debugCaptureBySession: Map<string, SessionDebugCaptureEvent[]> = new Map();
  private debugCaptureEnabledSessions: Set<string> = new Set();
  private pendingResizeRefreshTimers: Map<string, NodeJS.Timeout> = new Map();
  private pendingResizeReplaySessions: Set<string> = new Set();
  private pendingResizeReplayStartedAt: Map<string, number> = new Map();
  private pendingResizeReplayLastOutputAt: Map<string, number> = new Map();
  private runtimePtyConfig: PTYConfig;
  private runtimeSessionConfig: { idleDelayMs: number; runningDelayMs: number };
  private readonly execFileFn: typeof execFile;
  private readonly execFileSyncFn: typeof execFileSync;
  private readonly platform: NodeJS.Platform;
  private readonly spawnPty: typeof pty.spawn;
  private powerShellWinptyProbe: { checked: boolean; available: boolean; reason?: string } = {
    checked: false,
    available: false,
  };
  private wsRouter: WsRouter | null = null;
  private cachedAvailableShells: ShellInfo[] | null = null;
  private cwdChangeCallback: ((sessionId: string, cwd: string) => void) | null = null;
  private observability: Omit<SessionManagerObservability, 'totalSessions' | 'healthySessions' | 'degradedSessions'> = {
    snapshotRequests: 0,
    snapshotCacheHits: 0,
    snapshotSerializeFailures: 0,
    snapshotFallbacks: 0,
    oversizedSnapshots: 0,
    totalSnapshotBytes: 0,
    maxSnapshotBytesObserved: 0,
    totalSnapshotSerializeMs: 0,
    maxSnapshotSerializeMs: 0,
  };

  constructor(
    initialConfig: { pty: PTYConfig; session: SessionConfig } = { pty: config.pty, session: config.session },
    deps: SessionManagerDeps = {},
  ) {
    this.platform = deps.platform ?? process.platform;
    this.runtimePtyConfig = {
      ...clonePtyConfig(initialConfig.pty),
      ...normalizePtyConfigForPlatform(initialConfig.pty, this.platform),
    };
    this.runtimeSessionConfig = {
      idleDelayMs: initialConfig.session.idleDelayMs,
      runningDelayMs: initialConfig.session.runningDelayMs ?? DEFAULT_RUNNING_DELAY_MS,
    };
    this.execFileFn = deps.execFileFn ?? execFile;
    this.execFileSyncFn = deps.execFileSyncFn ?? execFileSync;
    this.spawnPty = deps.spawnPty ?? pty.spawn;
    // 서버 시작 시 한 번만 셸 감지 후 캐싱
    this.cachedAvailableShells = this.detectAvailableShells();
  }

  createSession(name?: string, shell?: ShellType, cwd?: string): SessionDTO {
    const id = uuidv4();
    this.sessionCounter++;
    const sessionName = name || `Session-${this.sessionCounter}`;

    const cwdFilePath = this.getCwdTrackingFilePath(id);
    const { shell: shellCmd, args: shellArgs, shellType } = this.resolveShell(shell, cwdFilePath);
    const backendResolution = this.resolveWindowsPtyBackend(shellType);
    const initialCwd = this.resolveSpawnCwd(cwd, shellType);

    // Step 9: OSC 133 셸 통합 환경변수 구성
    const env = this.buildShellEnv(shellType);
    const cols = this.runtimePtyConfig.defaultCols;
    const rows = this.runtimePtyConfig.defaultRows;

    const ptyProcess = this.spawnPty(shellCmd, shellArgs, {
      name: this.runtimePtyConfig.termName,
      cols,
      rows,
      cwd: initialCwd,
      env,  // Step 9: 확장된 env (OSC 133 주입 포함)
      // Windows PTY backend (ConPTY vs winpty)
      useConpty: backendResolution.useConpty,
    });

    const session: Session = {
      id,
      name: sessionName,
      status: 'idle',
      createdAt: new Date(),
      lastActiveAt: new Date(),
      sortOrder: this.sessions.size,
    };

    // Step 9: OscDetector 생성
    const oscDetector = new OscDetector();

    const sessionData: SessionData = {
      session,
      pty: ptyProcess,
      idleTimer: null,
      runningTimer: null,
      shellType,
      headless: null,
      headlessHealth: 'healthy',
      headlessWriteChain: Promise.resolve(),
      headlessCloseSignal: createDeferredSignal<void>(),
      pendingHeadlessWrites: 0,
      cols,
      rows,
      screenSeq: 0,
      snapshotCache: null,
      windowsPty: this.getWindowsPtyInfo(backendResolution.backend),
      degradedReplayBuffer: '',
      degradedReplayTruncated: false,
      pendingOutputChunks: [],
      unsnapshottedOutput: '',
      unsnapshottedOutputTruncated: false,
      initialCwd,
      cwdFilePath,
      // Step 9: Idle Detection
      echoTracker: {
        lastInputAt: 0,
        lastInputHasEnter: false,
        recentInputs: [],
      },
      detectionMode: 'heuristic',
      oscDetector,
      derivedState: createInitialDerivedState(),
      foregroundDetectorRegistry: this.createForegroundDetectorRegistry(),
      inputBuffer: '',
      foregroundStartedAt: undefined,
    };

    this.sessions.set(id, sessionData);
    this.initializeHeadlessState(id, sessionData);
    this.captureDebugEvent(id, 'pty', 'backend_resolved', {
      shellType,
      requestedPowerShellBackend: backendResolution.requestedPowerShellBackend,
      effectiveBackend: backendResolution.backend,
      useConpty: backendResolution.useConpty,
    });

    // Step 9: OSC 133 콜백 등록
    oscDetector.setCallback((_status, event) => {
      const sd = this.sessions.get(id);
      if (!sd || sd.detectionMode !== 'osc133') return;

      switch (event.type) {
        case 'prompt-start':  // A 마커
        case 'command-end':   // D 마커
          this.transitionToShellPrompt(id, event.type);
          break;
        case 'command-start': // C 마커
          if (isInteractiveAiAppId(sd.pendingForegroundAppHint) || isInteractiveAiAppId(this.ensureDerivedState(sd).foregroundAppId)) {
            this.beginForegroundProcess(id, 'osc133_command_start');
          } else {
            this.updateStatus(id, 'running');
          }
          break;
        case 'prompt-end':    // B 마커
          // 정보용, 상태 변경 없음 (이미 idle)
          break;
      }
    });

    // Inject CWD tracking hook based on shell type
    this.injectCwdHook(id, sessionData, ptyProcess, shellType);

    // Handle PTY output (Step 9: Phase 3 통합 최종 버전)
    ptyProcess.onData((rawData: string) => {
      const sData = this.sessions.get(id);
      if (!sData) return;

      // ========================================
      // Step 9: OSC 133 마커 처리 (항상 수행)
      // ========================================
      const { stripped, foundMarker } = sData.oscDetector.process(rawData);

      // 자동 모드 승격: 첫 OSC 133 마커 감지 시 heuristic → osc133
      if (foundMarker && sData.detectionMode === 'heuristic') {
        sData.detectionMode = 'osc133';
        console.log(`[Session ${id}] Idle detection upgraded to osc133 mode`);
        // idle 타이머 해제 (osc133 모드에서는 불필요)
        if (sData.idleTimer) {
          clearTimeout(sData.idleTimer);
          sData.idleTimer = null;
        }
        this.cancelPendingRunningTransition(sData);
      }

      const outputData = sData.detectionMode === 'osc133' ? stripped : rawData;

      if (outputData.length > 0) {
        const observation = this.inspectForegroundAppOutput(id, sData, outputData);
        if (observation) {
          this.applyForegroundObservation(id, observation);
        }

        if (!observation && sData.detectionMode === 'osc133') {
          const derivedState = this.ensureDerivedState(sData);
          const isAiForeground = derivedState.ownership === 'foreground_app'
            && isInteractiveAiAppId(derivedState.foregroundAppId);
          if (isAiForeground || isInteractiveAiAppId(sData.pendingForegroundAppHint)) {
            if (isLikelyAiTuiLaunchFailureOutput(sData, outputData)) {
              this.markAiTuiLaunchFailure(id, 'osc133_ai_tui_launch_failure');
            } else {
              const isLaunchEcho = this.isEchoOutput(sData, outputData)
                || isLikelyCommandEchoOutput(outputData, sData.lastSubmittedCommand);
              const signal = this.classifyAiTuiOutputSignal(sData, outputData);
              if (signal === 'waiting_input' || signal === 'repaint_only') {
                this.beginForegroundActivity(id, signal, `osc133_ai_tui_${signal}`);
              } else {
                this.scheduleRunningTransition(id, 'osc133_ai_tui_unclassified_output');
              }
              if (!isLaunchEcho) {
                this.markAiTuiLaunchSucceeded(sData);
              }
            }
          }
        }

        // ========================================
        // Step 9: 모드별 상태 전환
        // ========================================
        if (sData.detectionMode === 'heuristic') {
          const isEcho = this.isEchoOutput(sData, stripped);
          if (!isEcho) {
            const derivedState = this.ensureDerivedState(sData);
            const isAiForeground = derivedState.ownership === 'foreground_app'
              && isInteractiveAiAppId(derivedState.foregroundAppId);
            const isAiShellPromptReturn = (isAiForeground || sData.expectShellPromptAfterAiTuiFailure === true)
              && this.isShellPromptReturnOutput(sData, stripped);
            if (this.isPowerShellPromptRedrawOutput(sData, stripped) || isAiShellPromptReturn) {
              this.transitionToShellPrompt(
                id,
                isAiShellPromptReturn ? 'heuristic_ai_tui_shell_prompt_return' : 'heuristic_powershell_prompt_redraw',
              );
            } else {
              if (isAiForeground || isInteractiveAiAppId(sData.pendingForegroundAppHint)) {
                if (!observation) {
                  if (isLikelyAiTuiLaunchFailureOutput(sData, outputData)) {
                    this.markAiTuiLaunchFailure(id, 'heuristic_ai_tui_launch_failure');
                  } else {
                    const isLaunchEcho = this.isEchoOutput(sData, outputData)
                      || isLikelyCommandEchoOutput(outputData, sData.lastSubmittedCommand);
                    const signal = this.classifyAiTuiOutputSignal(sData, outputData);
                    if (signal === 'waiting_input' || signal === 'repaint_only') {
                      this.beginForegroundActivity(id, signal, `heuristic_ai_tui_${signal}`);
                    } else {
                      this.scheduleRunningTransition(id, 'heuristic_ai_tui_unclassified_output');
                    }
                    if (!isLaunchEcho) {
                      this.markAiTuiLaunchSucceeded(sData);
                    }
                  }
                }
              } else {
                this.updateStatus(id, 'running');
                this.scheduleIdleTransition(id);
              }
            }
          }
        }

        const outputDebugDetails = buildRawOutputDebugDetails(sData, rawData, outputData, foundMarker);
        if (this.pendingResizeReplaySessions.has(id)) {
          this.pendingResizeReplayLastOutputAt.set(id, Date.now());
          this.scheduleResizeReplayRefresh(id, RESIZE_REPLAY_QUIET_WINDOW_MS);
        }
        this.captureDebugEvent(id, 'pty', 'raw_output', outputDebugDetails, rawData);
        this.queueHeadlessOutput(id, sData, outputData);
      }
    });

    // Handle PTY exit
    ptyProcess.onExit(({ exitCode }) => {
      this.broadcastWs(id, 'session:exited', { exitCode });
    });

    return this.toDTO(session);
  }

  private scheduleIdleTransition(id: string): void {
    const data = this.sessions.get(id);
    if (!data) return;

    if (data.idleTimer) {
      clearTimeout(data.idleTimer);
    }
    this.cancelPendingRunningTransition(data);

    data.idleTimer = setTimeout(() => {
      this.updateStatus(id, 'idle');
    }, this.runtimeSessionConfig.idleDelayMs);
  }

  private cancelPendingRunningTransition(data: SessionData): void {
    if (data.runningTimer) {
      clearTimeout(data.runningTimer);
      data.runningTimer = null;
    }
  }

  private scheduleRunningTransition(id: string, reason: string): void {
    const data = this.sessions.get(id);
    if (!data) return;

    if (data.session.status === 'running') {
      this.scheduleIdleTransition(id);
      return;
    }

    if (data.runningTimer) {
      return;
    }

    const appHint = data.pendingForegroundAppHint ?? data.aiTuiLaunchAttempt?.appId;
    data.runningTimer = setTimeout(() => {
      const current = this.sessions.get(id);
      if (!current) return;

      current.runningTimer = null;
      this.captureDebugEvent(id, 'detector', 'running_delay_elapsed', {
        reason,
        runningDelayMs: this.runtimeSessionConfig.runningDelayMs,
      });
      this.updateDerivedState(id, reason, (state) => {
        state.ownership = 'foreground_app';
        state.activity = 'busy';
        if (!isInteractiveAiAppId(state.foregroundAppId) && isInteractiveAiAppId(appHint)) {
          state.foregroundAppId = appHint;
        }
        delete state.detectorId;
      });
      this.scheduleIdleTransition(id);
    }, this.runtimeSessionConfig.runningDelayMs);
    data.runningTimer.unref();

    this.captureDebugEvent(id, 'detector', 'running_delay_scheduled', {
      reason,
      runningDelayMs: this.runtimeSessionConfig.runningDelayMs,
    });
  }

  private updateStatus(id: string, status: SessionStatus): void {
    const data = this.sessions.get(id);
    if (!data || data.session.status === status) return;

    data.session.status = status;
    data.session.lastActiveAt = new Date();
    this.broadcastWs(id, 'status', { status });
  }

  private createForegroundDetectorRegistry(): ForegroundAppDetectorRegistry {
    return new ForegroundAppDetectorRegistry([
      new HermesForegroundDetector(),
    ]);
  }

  private ensureDerivedState(data: SessionData): SessionDerivedState {
    if (!data.derivedState) {
      data.derivedState = createInitialDerivedState();
    }
    return data.derivedState;
  }

  private ensureForegroundDetectorRegistry(data: SessionData): ForegroundAppDetectorRegistry {
    if (!data.foregroundDetectorRegistry) {
      data.foregroundDetectorRegistry = this.createForegroundDetectorRegistry();
    }
    return data.foregroundDetectorRegistry;
  }

  private beginForegroundProcess(id: string, reason: string): void {
    const data = this.sessions.get(id);
    if (!data) return;

    const hintedAppId = data.pendingForegroundAppHint;
    delete data.pendingForegroundAppHint;
    this.ensureForegroundDetectorRegistry(data).reset();
    this.updateDerivedState(id, reason, (state) => {
      state.ownership = 'foreground_app';
      state.activity = isInteractiveAiAppId(hintedAppId) ? 'waiting_input' : 'unknown';
      if (hintedAppId) {
        state.foregroundAppId = hintedAppId;
      } else {
        delete state.foregroundAppId;
      }
      delete state.detectorId;
    });
    data.foregroundStartedAt = Date.now();
  }

  private beginForegroundActivity(
    id: string,
    activity: 'busy' | 'unknown' | 'waiting_input' | 'repaint_only',
    reason: string,
  ): void {
    const data = this.sessions.get(id);
    if (!data) return;

    const current = this.ensureDerivedState(data);
    if (current.ownership !== 'foreground_app') {
      this.ensureForegroundDetectorRegistry(data).reset();
    }
    if (activity === 'waiting_input' || activity === 'repaint_only') {
      this.cancelPendingRunningTransition(data);
    }

    this.updateDerivedState(id, reason, (state) => {
      state.ownership = 'foreground_app';
      state.activity = activity;
      if (data.pendingForegroundAppHint) {
        state.foregroundAppId = data.pendingForegroundAppHint;
      }
    });
    data.foregroundStartedAt = Date.now();
  }

  private markAiTuiLaunchFailure(id: string, reason: string): void {
    const data = this.sessions.get(id);
    if (!data) return;

    this.cancelPendingRunningTransition(data);
    delete data.pendingForegroundAppHint;
    delete data.aiTuiLaunchAttempt;
    delete data.lastSubmittedCommand;
    data.foregroundStartedAt = undefined;
    data.expectShellPromptAfterAiTuiFailure = true;
    this.updateDerivedState(id, reason, (state) => {
      state.ownership = 'shell_prompt';
      state.activity = 'waiting_input';
      delete state.foregroundAppId;
      delete state.detectorId;
    });
    this.scheduleIdleTransition(id);
  }

  private markAiTuiLaunchSucceeded(data: SessionData): void {
    delete data.aiTuiLaunchAttempt;
    delete data.pendingForegroundAppHint;
  }

  private transitionToShellPrompt(id: string, reason: string): void {
    const data = this.sessions.get(id);
    if (!data) return;

    data.inputBuffer = '';
    delete data.pendingForegroundAppHint;
    delete data.aiTuiLaunchAttempt;
    delete data.expectShellPromptAfterAiTuiFailure;
    delete data.lastSubmittedCommand;
    data.foregroundStartedAt = undefined;
    this.cancelPendingRunningTransition(data);
    this.ensureForegroundDetectorRegistry(data).reset();
    this.updateDerivedState(id, reason, (state) => {
      state.ownership = 'shell_prompt';
      state.activity = 'waiting_input';
      delete state.foregroundAppId;
      delete state.detectorId;
    });
  }

  private inspectForegroundAppOutput(
    id: string,
    data: SessionData,
    chunk: string,
  ): ForegroundAppObservation | null {
    const derivedState = this.ensureDerivedState(data);
    const msSinceLastInput = data.echoTracker.lastInputAt > 0
      ? Date.now() - data.echoTracker.lastInputAt
      : null;
    return this.ensureForegroundDetectorRegistry(data).inspect({
      chunk,
      now: Date.now(),
      sessionId: id,
      shellType: data.shellType,
      detectionMode: data.detectionMode,
      appHint: data.pendingForegroundAppHint ?? derivedState.foregroundAppId,
      lastSubmittedCommand: data.lastSubmittedCommand,
      lastInputHasEnter: data.echoTracker.lastInputHasEnter,
      msSinceLastInput,
    });
  }

  private applyForegroundObservation(id: string, observation: ForegroundAppObservation): void {
    const now = Date.now();
    const data = this.sessions.get(id);
    this.captureDebugEvent(id, 'detector', 'detector_observation', {
      appId: observation.appId,
      detectorId: observation.detectorId,
      activity: observation.activity,
      reason: observation.reason,
      confidence: observation.confidence,
      ...sanitizeDebugValues(observation.details),
    });

    if (data && isInteractiveAiAppId(observation.appId) && observation.activity === 'busy') {
      const currentState = this.ensureDerivedState(data);
      const alreadyRunning = data.session.status === 'running' || currentState.activity === 'busy';
      this.updateDerivedState(id, alreadyRunning ? `detector_${observation.reason}` : `detector_${observation.reason}_pending_running`, (state) => {
        state.ownership = 'foreground_app';
        state.activity = alreadyRunning ? 'busy' : 'waiting_input';
        state.foregroundAppId = observation.appId;
        state.detectorId = observation.detectorId;
        state.lastObservationAt = now;
        state.lastSemanticOutputAt = now;
      }, {
        preservePendingRunningTransition: !alreadyRunning,
      });
      this.markAiTuiLaunchSucceeded(data);
      if (alreadyRunning) {
        this.scheduleIdleTransition(id);
      } else {
        this.scheduleRunningTransition(id, `detector_${observation.reason}`);
      }
      return;
    }

    this.updateDerivedState(id, `detector_${observation.reason}`, (state) => {
      state.ownership = 'foreground_app';
      state.activity = observation.activity;
      state.foregroundAppId = observation.appId;
      state.detectorId = observation.detectorId;
      state.lastObservationAt = now;
      if (observation.activity === 'busy') {
        state.lastSemanticOutputAt = now;
      }
      if (observation.activity === 'repaint_only') {
        state.lastRepaintOnlyAt = now;
      }
    });
    if (data && isInteractiveAiAppId(observation.appId)) {
      this.markAiTuiLaunchSucceeded(data);
    }
  }

  private updateDerivedState(
    id: string,
    reason: string,
    mutate: (state: SessionDerivedState) => void,
    options: DerivedStateSyncOptions = {},
  ): void {
    const data = this.sessions.get(id);
    if (!data) return;

    const state = this.ensureDerivedState(data);
    const previous = { ...state };
    mutate(state);

    if (hasCoreDerivedStateChange(previous, state)) {
      this.captureDebugEvent(id, 'detector', 'derived_status_transition', {
        reason,
        previousOwnership: previous.ownership,
        previousActivity: previous.activity,
        previousForegroundAppId: previous.foregroundAppId ?? null,
        previousDetectorId: previous.detectorId ?? null,
        nextOwnership: state.ownership,
        nextActivity: state.activity,
        nextForegroundAppId: state.foregroundAppId ?? null,
        nextDetectorId: state.detectorId ?? null,
        previousStatus: deriveDisplayStatus(previous),
        nextStatus: deriveDisplayStatus(state),
      });
    }

    this.syncStatusFromDerivedState(id, options);
  }

  private syncStatusFromDerivedState(id: string, options: DerivedStateSyncOptions = {}): void {
    const data = this.sessions.get(id);
    if (!data) return;

    if (data.idleTimer) {
      clearTimeout(data.idleTimer);
      data.idleTimer = null;
    }

    const derivedStatus = deriveDisplayStatus(this.ensureDerivedState(data));
    if (derivedStatus === 'idle' && !options.preservePendingRunningTransition) {
      this.cancelPendingRunningTransition(data);
    }
    this.updateStatus(id, derivedStatus);
  }

  getSession(id: string): SessionDTO | null {
    const data = this.sessions.get(id);
    return data ? this.toDTO(data.session) : null;
  }

  getAllSessions(): SessionDTO[] {
    return Array.from(this.sessions.values()).map(data => this.toDTO(data.session));
  }

  deleteSession(id: string): boolean {
    const data = this.sessions.get(id);
    if (!data) return false;

    // Clear idle timer
    if (data.idleTimer) {
      clearTimeout(data.idleTimer);
    }
    this.cancelPendingRunningTransition(data);

    // Kill PTY process
    data.pty.kill();

    // Step 9: OSC 감지기 정리
    data.oscDetector.destroy();
    data.foregroundDetectorRegistry?.reset();

    if (data.headless) {
      disposeHeadlessTerminal(data.headless);
      data.headless = null;
    }
    data.headlessCloseSignal.resolve();
    data.snapshotCache = null;

    // Clean up CWD file watching and temp file
    if (data.cwdFilePath) {
      unwatchFile(data.cwdFilePath);
      try { unlinkSync(data.cwdFilePath); } catch { /* ignore */ }
    }

    this.wsRouter?.clearSessionState(id);
    this.wsRouter?.disableDebugReplayCapture(id);
    this.wsRouter?.clearReplayEvents(id);
    this.disableDebugCapture(id);
    this.clearDebugCapture(id);
    this.pendingResizeReplaySessions.delete(id);
    this.pendingResizeReplayStartedAt.delete(id);
    this.pendingResizeReplayLastOutputAt.delete(id);
    const pendingResizeRefresh = this.pendingResizeRefreshTimers.get(id);
    if (pendingResizeRefresh) {
      clearTimeout(pendingResizeRefresh);
      this.pendingResizeRefreshTimers.delete(id);
    }

    // Remove from map
    this.sessions.delete(id);
    return true;
  }

  getDebugCapture(sessionId: string, limit = 200): SessionDebugCaptureEvent[] {
    const events = this.debugCaptureBySession.get(sessionId) ?? [];
    return events.slice(-Math.max(1, limit));
  }

  enableDebugCapture(sessionId: string): void {
    this.clearDebugCapture(sessionId);
    const session = this.sessions.get(sessionId);
    if (session) {
      session.echoTracker.recentInputs = [];
    }
    this.debugCaptureEnabledSessions.add(sessionId);
  }

  disableDebugCapture(sessionId: string): void {
    this.debugCaptureEnabledSessions.delete(sessionId);
  }

  isDebugCaptureEnabled(sessionId: string): boolean {
    return this.debugCaptureEnabledSessions.has(sessionId);
  }

  clearDebugCapture(sessionId: string): void {
    this.debugCaptureBySession.delete(sessionId);
  }

  writeInput(
    id: string,
    input: string,
    clientMetadata?: InputDebugMetadata,
    inputSequence?: { inputSeqStart?: number; inputSeqEnd?: number },
  ): boolean {
    const data = this.sessions.get(id);
    if (!data) return false;
    const inputDebugDetails: Record<string, InputDebugValue> = {
      ...buildInputDebugDetails(input, clientMetadata),
      ...(typeof inputSequence?.inputSeqStart === 'number' ? { inputSeqStart: inputSequence.inputSeqStart } : {}),
      ...(typeof inputSequence?.inputSeqEnd === 'number' ? { inputSeqEnd: inputSequence.inputSeqEnd } : {}),
    };
    const shouldCaptureInputDebug = this.isDebugCaptureEnabled(id);
    if (shouldCaptureInputDebug) {
      this.captureDebugEvent(id, 'pty', 'input', inputDebugDetails, formatSafeInputPreview(input) ?? undefined);
    }

    // Step 9: 에코 추적 정보 기록 (pty.write 전에 기록)
    const hasEnter = input.includes('\r') || input.includes('\n');
    const submittedCommand = this.updateCommandInputBuffer(data, input);
    const derivedState = this.ensureDerivedState(data);
    const isAiForeground = derivedState.ownership === 'foreground_app'
      && isInteractiveAiAppId(derivedState.foregroundAppId);
    const hintedAppId = submittedCommand && !isAiForeground ? detectForegroundAppHint(submittedCommand) : null;
    if (submittedCommand) {
      data.lastSubmittedCommand = submittedCommand;
      if (!isAiForeground) {
        if (hintedAppId) {
          data.pendingForegroundAppHint = hintedAppId;
          data.aiTuiLaunchAttempt = {
            appId: hintedAppId,
            command: submittedCommand,
            executable: getCommandExecutableToken(submittedCommand) ?? hintedAppId,
            startedAt: Date.now(),
          };
        } else {
          delete data.pendingForegroundAppHint;
          delete data.aiTuiLaunchAttempt;
        }
      }
    }
    data.echoTracker.lastInputAt = Date.now();
    data.echoTracker.lastInputHasEnter = hasEnter;
    if (shouldCaptureInputDebug) {
      data.echoTracker.recentInputs.push({
        at: data.echoTracker.lastInputAt,
        hasEnter,
        inputClass: String(inputDebugDetails.inputClass ?? 'safe-control'),
      });
      if (data.echoTracker.recentInputs.length > DEBUG_INPUT_SAMPLE_LIMIT) {
        data.echoTracker.recentInputs.splice(0, data.echoTracker.recentInputs.length - DEBUG_INPUT_SAMPLE_LIMIT);
      }
    }

    if (isAiForeground) {
      this.beginForegroundActivity(id, 'waiting_input', 'ai_tui_user_input');
    }

    // Enter 입력 시 heuristic 모드에서 즉시 running 전환.
    // AI TUI는 실행 명령과 내부 사용자 입력 모두 idle 상태로 유지한다.
    if (hasEnter && data.detectionMode === 'heuristic') {
      if (isInteractiveAiAppId(hintedAppId)) {
        this.beginForegroundActivity(id, 'waiting_input', `heuristic_${hintedAppId}_submit`);
      } else if (isAiForeground) {
        this.beginForegroundActivity(id, 'waiting_input', 'heuristic_ai_tui_submit');
      } else {
        this.updateStatus(id, 'running');
      }
    }

    try {
      data.pty.write(input);
    } catch (error) {
      this.captureDebugEvent(id, 'pty', 'input_write_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      console.error(`[PTY] Failed to write input to session ${id}:`, error);
      return false;
    }
    data.session.lastActiveAt = new Date();
    return true;
  }

  private updateCommandInputBuffer(data: SessionData, input: string): string | null {
    if (typeof data.inputBuffer !== 'string') {
      data.inputBuffer = '';
    }

    let submittedCommand: string | null = null;

    if (containsHistoryRecallControlSequence(input)) {
      data.inputBuffer = '';
    }

    const cleanedInput = stripInputTrackingControlSequences(input);

    for (const char of cleanedInput) {
      if (char === '\r' || char === '\n') {
        submittedCommand = data.inputBuffer.trim();
        data.inputBuffer = '';
        continue;
      }

      if (char === '\x7f' || char === '\b') {
        data.inputBuffer = data.inputBuffer.slice(0, -1);
        continue;
      }

      if (char === '\u0015') {
        data.inputBuffer = '';
        continue;
      }

      if (char >= ' ' && char !== '\x7f') {
        data.inputBuffer = `${data.inputBuffer}${char}`.slice(-512);
      }
    }

    return submittedCommand;
  }

  resize(id: string, cols: number, rows: number): boolean {
    const data = this.sessions.get(id);
    if (!data) return false;

    this.wsRouter?.recordReplayEvent({
      kind: 'resize_requested',
      sessionId: id,
      snapshotSeq: data.screenSeq,
      details: {
        currentCols: data.cols,
        currentRows: data.rows,
        requestedCols: cols,
        requestedRows: rows,
      },
    });

    if (data.cols === cols && data.rows === rows) {
      this.wsRouter?.recordReplayEvent({
        kind: 'resize_skipped',
        sessionId: id,
        snapshotSeq: data.screenSeq,
        details: {
          currentCols: data.cols,
          currentRows: data.rows,
          requestedCols: cols,
          requestedRows: rows,
        },
      });
      return true;
    }

    data.pty.resize(cols, rows);
    data.cols = cols;
    data.rows = rows;
    data.screenSeq += 1;
    this.markSnapshotDirty(data);

    if (data.headlessHealth === 'healthy' && data.headless) {
      try {
        resizeHeadlessTerminal(data.headless, cols, rows);
      } catch (error) {
        this.markHeadlessDegraded(id, data, 'resize', error);
      }
    }

    this.pendingResizeReplaySessions.add(id);
    this.pendingResizeReplayStartedAt.set(id, Date.now());
    this.pendingResizeReplayLastOutputAt.delete(id);
    this.scheduleResizeReplayRefresh(id, 150);
    return true;
  }

  updateSession(id: string, updates: UpdateSessionRequest): SessionDTO | null {
    const data = this.sessions.get(id);
    if (!data) return null;

    if (updates.name !== undefined) {
      const duplicate = Array.from(this.sessions.values()).find(
        d => d.session.id !== id && d.session.name === updates.name
      );
      if (duplicate) {
        throw new AppError(ErrorCode.DUPLICATE_SESSION_NAME);
      }
      data.session.name = updates.name;
    }

    if (updates.sortOrder !== undefined) {
      data.session.sortOrder = updates.sortOrder;
    }

    return this.toDTO(data.session);
  }

  reorderSessions(sessionId: string, direction: 'up' | 'down'): boolean {
    const sorted = Array.from(this.sessions.values())
      .sort((a, b) => a.session.sortOrder - b.session.sortOrder);

    const index = sorted.findIndex(d => d.session.id === sessionId);
    if (index === -1) return false;

    if (direction === 'up' && index > 0) {
      const temp = sorted[index].session.sortOrder;
      sorted[index].session.sortOrder = sorted[index - 1].session.sortOrder;
      sorted[index - 1].session.sortOrder = temp;
    } else if (direction === 'down' && index < sorted.length - 1) {
      const temp = sorted[index].session.sortOrder;
      sorted[index].session.sortOrder = sorted[index + 1].session.sortOrder;
      sorted[index + 1].session.sortOrder = temp;
    }

    return true;
  }


  getPtyPid(sessionId: string): number | null {
    const data = this.sessions.get(sessionId);
    return data ? data.pty.pid : null;
  }

  getInitialCwd(sessionId: string): string | null {
    const data = this.sessions.get(sessionId);
    return data ? data.initialCwd : null;
  }

  getLastCwd(sessionId: string): string | null {
    const data = this.sessions.get(sessionId);
    return data?.lastCwd ?? data?.initialCwd ?? null;
  }

  getCwdFilePath(sessionId: string): string | null {
    const data = this.sessions.get(sessionId);
    return data?.cwdFilePath ?? null;
  }

  /** Register a callback to be invoked when any session's CWD changes. */
  onCwdChange(cb: (sessionId: string, cwd: string) => void): void {
    this.cwdChangeCallback = cb;
  }

  /** Stop all CWD file watchers. Called during graceful shutdown. */
  stopAllCwdWatching(): void {
    for (const [id, data] of this.sessions) {
      if (data.cwdFilePath) {
        try {
          unwatchFile(data.cwdFilePath);
        } catch { /* already unwatched — ignore */ }
      }
    }
    console.log('[SessionManager] All CWD watchers stopped');
  }

  getAvailableShells(): ShellInfo[] {
    return this.cachedAvailableShells ?? [];
  }

  private detectAvailableShells(): ShellInfo[] {
    const shells: ShellInfo[] = [];
    if (this.platform === 'win32') {
      // PowerShell: 항상 추가
      shells.push({ id: 'powershell', label: 'PowerShell', icon: '💙' });
      // cmd: 항상 추가
      shells.push({ id: 'cmd', label: 'Command Prompt', icon: '⬛' });
      // WSL: wsl.exe 존재 시에만 추가
      if (this.isCommandAvailable('wsl.exe')) {
        shells.push({ id: 'wsl', label: 'WSL (Bash)', icon: '🐧' });
        shells.push({ id: 'bash', label: 'Bash (WSL)', icon: '🐚' });
        shells.push({ id: 'sh', label: 'Shell (WSL sh)', icon: '⚡' });
        // WSL 내부 zsh 확인
        if (this.isWslShellAvailable('zsh')) {
          shells.push({ id: 'zsh', label: 'WSL (Zsh)', icon: '🔮' });
        }
      }
    } else {
      // bash: 존재 시에만 추가
      if (this.isCommandAvailable('bash')) {
        shells.push({ id: 'bash', label: 'Bash', icon: '🐚' });
      }
      // zsh: 존재 시에만 추가
      if (this.isCommandAvailable('zsh')) {
        shells.push({ id: 'zsh', label: 'Zsh', icon: '🔮' });
      }
      // sh: 항상 추가
      shells.push({ id: 'sh', label: 'Shell (sh)', icon: '⚡' });
    }
    return shells;
  }

  private isCommandAvailable(cmd: string): boolean {
    try {
      if (this.platform === 'win32') {
        execSync(`where ${cmd}`, { stdio: 'ignore', windowsHide: true });
      } else {
        execSync(`which ${cmd}`, { stdio: 'ignore' });
      }
      return true;
    } catch {
      return false;
    }
  }

  private isWslShellAvailable(shell: string): boolean {
    try {
      execSync(`wsl.exe which ${shell}`, { stdio: 'ignore', timeout: 3000, windowsHide: true });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 셸 타입에 따라 OSC 133 주입을 위한 환경변수를 구성한다.
   *
   * - bash: BASH_ENV 환경변수로 스크립트 자동 로드
   * - zsh: ZDOTDIR 교체로 커스텀 .zshrc 로드 (Phase 2에서는 미지원)
   * - powershell: OSC 133 미지원, 기본 env 반환
   */
  private buildShellEnv(shellType: 'powershell' | 'bash' | 'zsh' | 'sh' | 'cmd'): Record<string, string> {
    const baseEnv = { ...process.env } as Record<string, string>;

    if (shellType === 'bash') {
      // bash: BASH_ENV로 스크립트 자동 로드
      const scriptPath = this.getShellIntegrationPath('bash-osc133.sh');
      if (scriptPath) {
        // WSL인 경우 Windows 경로를 WSL 경로로 변환
        if (this.platform === 'win32') {
          const wslPath = this.toWslPath(scriptPath);
          baseEnv['BASH_ENV'] = wslPath;
        } else {
          baseEnv['BASH_ENV'] = scriptPath;
        }
      }
    }
    // zsh: ZDOTDIR 교체 방식은 미구현, baseEnv만 반환
    // sh: 기본 env만 반환
    // cmd: 기본 env만 반환
    // powershell: OSC 133 미지원, 기본 env 반환

    return baseEnv;
  }

  private getWindowsPtyInfo(backendOverride?: WindowsPtyBackend): WindowsPtyInfo | undefined {
    if (this.platform !== 'win32') {
      return undefined;
    }

    const backend: WindowsPtyBackend = backendOverride ?? (this.runtimePtyConfig.useConpty ? 'conpty' : 'winpty');
    const buildNumber = parseInt(os.release().split('.').pop() ?? '', 10);
    return {
      backend,
      buildNumber: Number.isFinite(buildNumber) ? buildNumber : undefined,
    };
  }

  private resolveWindowsPtyBackend(shellType: 'powershell' | 'bash' | 'zsh' | 'sh' | 'cmd'): {
    backend: WindowsPtyBackend;
    useConpty: boolean;
    requestedPowerShellBackend: PowerShellBackendPolicy;
  } {
    const normalized = normalizePtyConfigForPlatform({
      useConpty: this.runtimePtyConfig.useConpty,
      windowsPowerShellBackend: this.runtimePtyConfig.windowsPowerShellBackend,
      shell: this.runtimePtyConfig.shell,
    }, this.platform);
    const inheritedBackend: WindowsPtyBackend = normalized.useConpty ? 'conpty' : 'winpty';
    const requestedPowerShellBackend = normalized.windowsPowerShellBackend;

    if (this.platform !== 'win32') {
      return {
        backend: inheritedBackend,
        useConpty: false,
        requestedPowerShellBackend,
      };
    }

    if (shellType !== 'powershell') {
      if (inheritedBackend === 'winpty') {
        this.assertPowerShellWinptyAvailable();
      }
      return {
        backend: inheritedBackend,
        useConpty: inheritedBackend === 'conpty',
        requestedPowerShellBackend,
      };
    }

    const effectiveBackend: WindowsPtyBackend = requestedPowerShellBackend === 'inherit'
      ? inheritedBackend
      : requestedPowerShellBackend;

    if (effectiveBackend === 'winpty') {
      this.assertPowerShellWinptyAvailable();
      return {
        backend: 'winpty',
        useConpty: false,
        requestedPowerShellBackend,
      };
    }

    return {
      backend: effectiveBackend,
      useConpty: effectiveBackend === 'conpty',
      requestedPowerShellBackend,
    };
  }

  /**
   * shell-integration 스크립트의 절대 경로를 반환한다.
   *
   * dev 환경(tsx): src/shell-integration/ 기준
   * 빌드 환경: dist/shell-integration/ 기준
   */
  private getShellIntegrationPath(filename: string): string | null {
    try {
      const configuredRoot = process.env[SHELL_INTEGRATION_ROOT_ENV_KEY]?.trim();
      if (configuredRoot) {
        return path.resolve(configuredRoot, filename);
      }

      const currentDir = typeof __dirname === 'string'
        ? __dirname
        : path.dirname(fileURLToPath(import.meta.url));
      const scriptPath = path.resolve(currentDir, '..', 'shell-integration', filename);
      return scriptPath;
    } catch {
      return null;
    }
  }

  /**
   * Windows 절대 경로를 WSL 경로로 변환.
   * C:\Users\foo\bar → /mnt/c/Users/foo/bar
   * /C:/Users/foo/bar → /mnt/c/Users/foo/bar
   */
  private toWslPath(windowsPath: string): string {
    // URL.pathname 형태 (/C:/Users/...) 처리: 앞의 / 제거
    const cleaned = windowsPath.replace(/^\//, '');
    // 드라이브 문자 추출 (C: 또는 C/)
    const drive = cleaned[0].toLowerCase();
    const rest = cleaned.slice(2).replace(/\\/g, '/');
    return `/mnt/${drive}${rest}`;
  }

  /**
   * Resolve CWD for pty.spawn.
   * On Windows, pty.spawn requires a Windows path. If the cwd is a WSL/Linux path
   * (starts with /), convert /mnt/X/... to X:\... or fall back to the default.
   */
  private resolveSpawnCwd(cwd: string | undefined, shellType: string): string {
    const fallback = process.env.HOME || process.env.USERPROFILE || '/';
    if (!cwd) return fallback;

    const isWindows = this.platform === 'win32';

    let resolved = cwd;
    if (isWindows && cwd.startsWith('/')) {
      // Linux path on Windows — try /mnt/X/... → X:\...
      const mntMatch = cwd.match(/^\/mnt\/([a-zA-Z])(\/.*)?$/);
      if (mntMatch) {
        const drive = mntMatch[1].toUpperCase();
        const rest = (mntMatch[2] || '').replace(/\//g, '\\');
        resolved = `${drive}:${rest || '\\'}`;
      } else {
        // Other Linux paths (e.g. /home/...) can't be mapped — use fallback
        return fallback;
      }
    }

    // Verify directory exists; fall back to home if not
    if (!existsSync(resolved)) {
      console.warn(`[SessionManager] CWD does not exist: ${resolved}, falling back to ${fallback}`);
      return fallback;
    }

    return resolved;
  }

  /**
   * Resolve shell command and arguments based on config and platform.
   */
  private resolveShell(
    shellOverride?: ShellType,
    cwdFilePath?: string,
  ): { shell: string; args: string[]; shellType: 'powershell' | 'bash' | 'zsh' | 'sh' | 'cmd' } {
    const shellConfig = normalizeShellForPlatform(shellOverride || this.runtimePtyConfig.shell || 'auto', this.platform);

    if (shellConfig === 'powershell') {
      return { shell: 'powershell.exe', args: this.buildPowerShellArgs(cwdFilePath), shellType: 'powershell' };
    }
    if (shellConfig === 'wsl') {
      return this.isCommandAvailable('wsl.exe')
        ? { shell: 'wsl.exe', args: [], shellType: 'bash' }
        : this.resolveAutoShell(cwdFilePath);
    }
    if (shellConfig === 'bash') {
      if (this.platform === 'win32') {
        return this.isCommandAvailable('wsl.exe')
          ? { shell: 'wsl.exe', args: [], shellType: 'bash' }
          : this.resolveAutoShell(cwdFilePath);
      }
      if (this.isCommandAvailable('bash')) {
        return { shell: 'bash', args: [], shellType: 'bash' };
      }
      return { shell: 'sh', args: [], shellType: 'sh' };
    }
    if (shellConfig === 'zsh') {
      if (this.platform === 'win32') {
        return this.isCommandAvailable('wsl.exe') && this.isWslShellAvailable('zsh')
          ? { shell: 'wsl.exe', args: ['-e', 'zsh'], shellType: 'zsh' }
          : this.resolveAutoShell(cwdFilePath);
      }
      if (this.isCommandAvailable('zsh')) {
        return { shell: 'zsh', args: [], shellType: 'zsh' };
      }
      return this.resolveAutoShell(cwdFilePath);
    }
    if (shellConfig === 'sh') {
      if (this.platform === 'win32') {
        return this.isCommandAvailable('wsl.exe')
          ? { shell: 'wsl.exe', args: ['-e', 'sh'], shellType: 'sh' }
          : this.resolveAutoShell(cwdFilePath);
      }
      return { shell: 'sh', args: [], shellType: 'sh' };
    }
    if (shellConfig === 'cmd') {
      return { shell: 'cmd.exe', args: [], shellType: 'cmd' };
    }

    return this.resolveAutoShell(cwdFilePath);
  }

  private resolveAutoShell(
    cwdFilePath?: string,
  ): { shell: string; args: string[]; shellType: 'powershell' | 'bash' | 'zsh' | 'sh' | 'cmd' } {
    if (this.platform === 'win32') {
      return { shell: 'powershell.exe', args: this.buildPowerShellArgs(cwdFilePath), shellType: 'powershell' };
    }
    if (this.platform === 'darwin' && this.isCommandAvailable('zsh')) {
      return { shell: 'zsh', args: [], shellType: 'zsh' };
    }
    if (this.isCommandAvailable('bash')) {
      return { shell: 'bash', args: [], shellType: 'bash' };
    }
    return { shell: 'sh', args: [], shellType: 'sh' };
  }

  // Step 7: Workspace support
  hasSession(id: string): boolean {
    return this.sessions.has(id);
  }

  deleteMultipleSessions(ids: string[]): void {
    for (const id of ids) {
      this.deleteSession(id);
    }
  }

  updateRuntimeConfig(next: { idleDelayMs?: number; runningDelayMs?: number; pty?: Partial<PTYConfig> }): void {
    const nextPowerShellBackendRaw = next.pty?.windowsPowerShellBackend ?? this.runtimePtyConfig.windowsPowerShellBackend ?? 'inherit';
    const nextUseConptyRaw = next.pty?.useConpty ?? this.runtimePtyConfig.useConpty;
    const nextNormalized = normalizePtyConfigForPlatform({
      useConpty: nextUseConptyRaw,
      windowsPowerShellBackend: nextPowerShellBackendRaw,
      shell: next.pty?.shell ?? this.runtimePtyConfig.shell,
    }, this.platform);
    const nextPowerShellBackend = nextNormalized.windowsPowerShellBackend;
    const nextUseConpty = nextNormalized.useConpty;
    const effectivePowerShellBackend = nextPowerShellBackend === 'inherit'
      ? (nextUseConpty ? 'conpty' : 'winpty')
      : nextPowerShellBackend;
    if (this.platform !== 'win32' && nextUseConptyRaw) {
      throw new AppError(ErrorCode.CONFIG_ERROR, 'ConPTY is only available on Windows');
    }
    if (this.platform !== 'win32' && nextPowerShellBackendRaw !== 'inherit') {
      throw new AppError(ErrorCode.CONFIG_ERROR, 'PowerShell backend override is only available on Windows');
    }

    if (this.platform === 'win32' && (nextUseConpty === false || effectivePowerShellBackend === 'winpty')) {
      this.assertPowerShellWinptyAvailable();
    }

    if (next.idleDelayMs !== undefined) {
      this.runtimeSessionConfig.idleDelayMs = next.idleDelayMs;
    }
    if (next.runningDelayMs !== undefined) {
      this.runtimeSessionConfig.runningDelayMs = next.runningDelayMs;
    }

    if (next.pty) {
      this.runtimePtyConfig = {
        ...this.runtimePtyConfig,
        ...next.pty,
        ...nextNormalized,
      };
    }

    if (!next.pty) {
      return;
    }

    for (const data of this.sessions.values()) {
      data.snapshotCache = null;
      if (data.degradedReplayBuffer.length > 0) {
        const degraded = truncateTerminalPayloadTail(data.degradedReplayBuffer, this.runtimePtyConfig.maxSnapshotBytes);
        data.degradedReplayBuffer = degraded.content;
        data.degradedReplayTruncated = data.degradedReplayTruncated || degraded.truncated;
      }
      if (data.unsnapshottedOutput.length > 0) {
        const pending = truncateTerminalPayloadTail(data.unsnapshottedOutput, this.runtimePtyConfig.maxSnapshotBytes);
        data.unsnapshottedOutput = pending.content;
        data.unsnapshottedOutputTruncated = data.unsnapshottedOutputTruncated || pending.truncated;
      }
    }
  }

  assertRuntimePtyCapabilities(): void {
    const normalized = normalizePtyConfigForPlatform({
      useConpty: this.runtimePtyConfig.useConpty,
      windowsPowerShellBackend: this.runtimePtyConfig.windowsPowerShellBackend,
      shell: this.runtimePtyConfig.shell,
    }, this.platform);
    const configuredPowerShellBackend = normalized.windowsPowerShellBackend;
    if (this.platform !== 'win32' && normalized.useConpty) {
      throw new AppError(ErrorCode.CONFIG_ERROR, 'ConPTY is only available on Windows');
    }
    const effectivePowerShellBackend = configuredPowerShellBackend === 'inherit'
      ? (normalized.useConpty ? 'conpty' : 'winpty')
      : configuredPowerShellBackend;
    if (this.platform !== 'win32' && configuredPowerShellBackend !== 'inherit') {
      throw new AppError(ErrorCode.CONFIG_ERROR, 'PowerShell backend override is only available on Windows');
    }
    if (this.platform === 'win32' && (this.runtimePtyConfig.useConpty === false || effectivePowerShellBackend === 'winpty')) {
      this.assertPowerShellWinptyAvailable();
    }
  }

  primePowerShellWinptyCapability(): void {
    if (this.platform !== 'win32' || this.powerShellWinptyProbe.checked) {
      return;
    }

    try {
      this.assertPowerShellWinptyAvailable();
    } catch {
      // The cached failure state is used by SettingsService to truthfully limit options.
    }
  }

  warmPowerShellWinptyCapability(): Promise<void> {
    if (this.platform !== 'win32' || this.powerShellWinptyProbe.checked) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      this.execFileFn(process.execPath, ['-e', this.buildWinptyProbeScript()], {
        timeout: 3000,
        windowsHide: true,
      }, (error, _stdout, stderr) => {
        if (!error) {
          this.powerShellWinptyProbe = { checked: true, available: true };
          resolve();
          return;
        }

        const reason = stderr?.trim() || formatWinptyProbeFailure(error);
        this.powerShellWinptyProbe = { checked: true, available: false, reason };
        resolve();
      });
    });
  }

  getPowerShellWinptyCapability(): { checked: boolean; available: boolean; reason?: string } {
    if (this.platform !== 'win32') {
      return {
        checked: true,
        available: false,
        reason: 'PowerShell backend override is only available on Windows',
      };
    }

    return { ...this.powerShellWinptyProbe };
  }

  private assertPowerShellWinptyAvailable(): void {
    if (this.platform !== 'win32') {
      throw new AppError(ErrorCode.CONFIG_ERROR, 'PowerShell winpty backend is only available on Windows');
    }

    if (this.powerShellWinptyProbe.checked && this.powerShellWinptyProbe.available) {
      return;
    }

    try {
      this.execFileSyncFn(process.execPath, ['-e', this.buildWinptyProbeScript()], {
        stdio: 'pipe',
        timeout: 3000,
        windowsHide: true,
      });
      this.powerShellWinptyProbe = { checked: true, available: true };
    } catch (error) {
      const reason = formatWinptyProbeFailure(error);
      this.powerShellWinptyProbe = { checked: true, available: false, reason };
      throw new AppError(
        ErrorCode.CONFIG_ERROR,
        `PowerShell winpty backend is unavailable: ${reason}`,
        { requestedBackend: 'winpty', reason },
      );
    }
  }

  private buildWinptyProbeScript(): string {
    return [
      "const pty = require('node-pty');",
      'let exited = false;',
      `const child = pty.spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', 'exit'], { name: ${JSON.stringify(this.runtimePtyConfig.termName)}, cols: 80, rows: 24, cwd: process.cwd(), env: process.env, useConpty: false });`,
      'child.onData(() => {});',
      'child.onExit(() => { exited = true; process.exit(0); });',
      "setTimeout(() => { if (!exited) { process.exit(124); } }, 1500);",
    ].join('');
  }

  /**
   * Inject CWD tracking hook into the shell session.
   * - PowerShell / cmd: override prompt function to write $PWD to temp file
   * - Bash / zsh / sh / WSL: use PROMPT_COMMAND to write $PWD to temp file
   */
  private injectCwdHook(
    id: string,
    sessionData: SessionData,
    ptyProcess: pty.IPty,
    shellType: 'powershell' | 'bash' | 'zsh' | 'sh' | 'cmd'
  ): void {
    const cwdFile = sessionData.cwdFilePath ?? this.getCwdTrackingFilePath(id);
    sessionData.cwdFilePath = cwdFile;

    if (shellType === 'powershell') {
      // PowerShell prompt hook is installed at startup args to avoid racing user input.
    } else if (shellType === 'cmd') {
      const escapedPath = cwdFile.replace(/\\/g, '\\\\');
      const hookScript = `$Global:__OrigPrompt = $function:prompt; function Global:prompt { $pwd.Path | Out-File -FilePath '${escapedPath}' -Encoding utf8 -NoNewline; if ($Global:__OrigPrompt) { & $Global:__OrigPrompt } else { "PS $($pwd.Path)> " } }\r`;
      setTimeout(() => {
        ptyProcess.write(hookScript);
      }, 500);
    } else {
      // Bash / zsh / sh / WSL: CWD tracking hook
      // Convert Windows temp path to WSL path if needed
      const wslPath = this.platform === 'win32'
        ? '/mnt/' + cwdFile[0].toLowerCase() + cwdFile.slice(2).replace(/\\/g, '/')
        : cwdFile;

      let hookScript: string;
      if (shellType === 'zsh') {
        // zsh uses precmd hook (PROMPT_COMMAND is bash-only)
        hookScript = ` precmd() { printf "%s" "$PWD" > "${wslPath}"; }\r`;
      } else if (shellType === 'sh') {
        // POSIX sh: embed in PS1 (no PROMPT_COMMAND or precmd)
        hookScript = ` PS1='$(printf "%s" "$PWD" > "${wslPath}")$ '\r`;
      } else {
        // bash / wsl (bash): use PROMPT_COMMAND
        hookScript = ` PROMPT_COMMAND='printf "%s" "$PWD" > "${wslPath}"'\r`;
      }
      setTimeout(() => {
        ptyProcess.write(hookScript);
      }, 500);
    }

    // Watch CWD file for changes and push via WS
    // Note: lstat symlink check omitted — localhost-only tool, LOW risk per security analysis.
    // The shell hook writes to cwdFile as the same OS user, so symlink attacks require
    // same-user access to the temp directory which already grants full filesystem access.
    watchFile(cwdFile, { interval: 1000 }, () => {
      try {
        const raw = readFileSync(cwdFile, 'utf8');
        const cwd = sanitizeCwd(raw);
        const currentData = this.sessions.get(id);
        const derivedState = currentData ? this.ensureDerivedState(currentData) : null;
        const fileMtime = statSync(cwdFile).mtimeMs;
        const ignoreStaleForegroundPrompt = Boolean(
          currentData &&
          derivedState?.ownership === 'foreground_app' &&
          currentData.foregroundStartedAt !== undefined &&
          fileMtime <= (currentData.foregroundStartedAt + 5),
        );
        if (!ignoreStaleForegroundPrompt) {
          this.transitionToShellPrompt(id, 'cwd_prompt_refresh');
        }
        if (cwd && cwd !== sessionData.lastCwd) {
          sessionData.lastCwd = cwd;
          this.broadcastWs(id, 'cwd', { cwd });
          this.cwdChangeCallback?.(id, cwd);
        }
      } catch { /* file may not exist yet — ignore */ }
    });
  }

  private buildPowerShellArgs(cwdFilePath?: string): string[] {
    if (!cwdFilePath) {
      return [];
    }

    const escapedPath = cwdFilePath.replace(/'/g, "''");
    const hookScript = [
      "$Global:__BuilderGateUtf8NoBom = [System.Text.UTF8Encoding]::new($false)",
      "$Global:__BuilderGateWritePwd = { param([string]$PathValue) try { [System.IO.File]::WriteAllText('" + escapedPath + "', $PathValue, $Global:__BuilderGateUtf8NoBom) } catch {} }",
      '$Global:__BuilderGateOrigPrompt = $function:prompt',
      '& $Global:__BuilderGateWritePwd $pwd.Path',
      "function Global:prompt { & $Global:__BuilderGateWritePwd $pwd.Path; if ($Global:__BuilderGateOrigPrompt) { & $Global:__BuilderGateOrigPrompt } else { \"PS $($pwd.Path)> \" } }",
    ].join('; ');
    const encodedScript = Buffer.from(hookScript, 'utf16le').toString('base64');

    return ['-NoLogo', '-NoExit', '-NoProfile', '-WindowStyle', 'Hidden', '-EncodedCommand', encodedScript];
  }

  private getCwdTrackingFilePath(sessionId: string): string {
    return path.join(os.tmpdir(), `buildergate-cwd-${sessionId}.txt`);
  }

  // ==========================================================================
  // WebSocket Integration (Step 8)
  // ==========================================================================

  setWsRouter(router: WsRouter): void {
    this.wsRouter = router;
  }

  getReplaySnapshot(sessionId: string): { data: string; truncated: boolean } | null {
    const snapshot = this.getScreenSnapshot(sessionId);
    if (!snapshot) return null;
    if (snapshot.health === 'degraded') {
      return {
        data: `${LEGACY_DEGRADED_REPLAY_PLACEHOLDER}${this.sessions.get(sessionId)?.degradedReplayBuffer ?? ''}`,
        truncated: this.sessions.get(sessionId)?.degradedReplayTruncated ?? false,
      };
    }
    if (snapshot.truncated && snapshot.data.length === 0) {
      return {
        data: LEGACY_TRUNCATED_REPLAY_PLACEHOLDER,
        truncated: true,
      };
    }
    return {
      data: snapshot.data,
      truncated: snapshot.truncated,
    };
  }

  isSessionReady(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  getScreenSnapshot(sessionId: string): SessionScreenSnapshot | null {
    const data = this.sessions.get(sessionId);
    if (!data) return null;
    this.observability.snapshotRequests += 1;
    this.captureDebugEvent(sessionId, 'snapshot', 'snapshot_requested', {
      screenSeq: data.screenSeq,
      cacheDirty: data.snapshotCache?.dirty ?? null,
      headlessHealth: data.headlessHealth,
      pendingHeadlessWrites: data.pendingHeadlessWrites,
    });

    if (data.headlessHealth !== 'healthy' || !data.headless) {
      this.observability.snapshotFallbacks += 1;
      this.captureDebugEvent(sessionId, 'snapshot', 'snapshot_fallback_degraded', {
        screenSeq: data.screenSeq,
      });
      return this.createDegradedSnapshot(data);
    }

    const cached = data.snapshotCache;
    if (cached && !cached.dirty && cached.seq === data.screenSeq && cached.cols === data.cols && cached.rows === data.rows) {
      this.observability.snapshotCacheHits += 1;
      this.captureDebugEvent(sessionId, 'snapshot', 'snapshot_cache_hit', {
        seq: cached.seq,
        cols: cached.cols,
        rows: cached.rows,
        truncated: cached.truncated,
      }, cached.data);
      return { ...cached, health: 'healthy', windowsPty: data.windowsPty };
    }

    try {
      const startedAt = Date.now();
      const snapshot = serializeHeadlessTerminal(data.headless, this.runtimePtyConfig.maxSnapshotBytes);
      const durationMs = Date.now() - startedAt;
      const generatedAt = Date.now();
      data.snapshotCache = {
        seq: data.screenSeq,
        cols: data.cols,
        rows: data.rows,
        data: snapshot.data,
        truncated: snapshot.truncated,
        generatedAt,
        dirty: false,
      };
      this.observability.totalSnapshotSerializeMs += durationMs;
      this.observability.maxSnapshotSerializeMs = Math.max(this.observability.maxSnapshotSerializeMs, durationMs);
      this.observability.totalSnapshotBytes += snapshot.data.length;
      this.observability.maxSnapshotBytesObserved = Math.max(this.observability.maxSnapshotBytesObserved, snapshot.data.length);
      if (snapshot.truncated) {
        this.observability.oversizedSnapshots += 1;
      }
      data.unsnapshottedOutput = '';
      data.unsnapshottedOutputTruncated = false;
      this.captureDebugEvent(sessionId, 'snapshot', 'snapshot_serialized', {
        seq: data.snapshotCache.seq,
        cols: data.snapshotCache.cols,
        rows: data.snapshotCache.rows,
        truncated: data.snapshotCache.truncated,
        byteLength: data.snapshotCache.data.length,
        durationMs,
      }, data.snapshotCache.data);
      return {
        ...data.snapshotCache,
        health: 'healthy',
        windowsPty: data.windowsPty,
      };
    } catch (error) {
      this.observability.snapshotSerializeFailures += 1;
      this.markHeadlessDegraded(sessionId, data, 'serialize', error);
      this.observability.snapshotFallbacks += 1;
      this.captureDebugEvent(sessionId, 'snapshot', 'snapshot_serialize_failed', {
        screenSeq: data.screenSeq,
        message: error instanceof Error ? error.message : String(error),
      });
      return this.createDegradedSnapshot(data);
    }
  }

  getReplayQueueLimit(): number {
    return Math.min(this.runtimePtyConfig.maxSnapshotBytes, 262_144);
  }

  getObservabilitySnapshot(): SessionManagerObservability {
    let healthySessions = 0;
    let degradedSessions = 0;

    for (const data of this.sessions.values()) {
      if (data.headlessHealth === 'healthy') {
        healthySessions += 1;
      } else {
        degradedSessions += 1;
      }
    }

    return {
      totalSessions: this.sessions.size,
      healthySessions,
      degradedSessions,
      ...this.observability,
    };
  }

  /** Broadcast to all WS subscribers of a session */
  broadcastWs(sessionId: string, event: string, payload: object): void {
    const subscribers = this.wsRouter?.getSubscribers(sessionId);
    if (!subscribers) return;
    const msg = JSON.stringify({ type: event, sessionId, ...payload });
    for (const ws of subscribers) {
      if (ws.readyState === 1) ws.send(msg);
    }
  }

  private toDTO(session: Session): SessionDTO {
    return {
      id: session.id,
      name: session.name,
      status: session.status,
      createdAt: session.createdAt.toISOString(),
      lastActiveAt: session.lastActiveAt.toISOString(),
      sortOrder: session.sortOrder,
    };
  }

  /**
   * PTY 출력이 사용자 입력의 에코인지 판정.
   *
   * 에코 조건 (모두 충족 시):
   * 1. 마지막 입력으로부터 50ms 이내
   * 2. 출력 길이가 입력 길이의 2배 이하 (ANSI 색상 코드 여유)
   * 3. 마지막 입력에 Enter가 없었음
   *
   * Enter 입력 후의 출력은 명령 실행 결과이므로 에코가 아님.
   */
  private isEchoOutput(sData: SessionData, output: string): boolean {
    const tracker = sData.echoTracker;
    if (tracker.lastInputAt === 0) return false; // 아직 입력 없음

    const elapsed = Date.now() - tracker.lastInputAt;
    const ECHO_TIME_THRESHOLD_MS = 50;

    // PowerShell(PSReadLine)은 키 입력 1글자마다 전체 라인을 ANSI 시퀀스로
    // 재렌더링하므로 출력 길이가 입력 길이의 수십 배에 달한다.
    // 따라서 길이 비교는 제거하고 타이밍 + Enter 여부만으로 판정한다.
    return (
      elapsed < ECHO_TIME_THRESHOLD_MS &&
      !tracker.lastInputHasEnter
    );
  }

  private isPowerShellPromptRedrawOutput(sData: SessionData, output: string): boolean {
    if (sData.shellType !== 'powershell') {
      return false;
    }

    const cwd = sData.lastCwd ?? sData.initialCwd;
    if (!cwd) {
      return false;
    }

    const prompt = `PS ${cwd}>`;
    const printableLines = stripTerminalControlSequences(output)
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    return printableLines.length > 0 && printableLines.every((line) => line === prompt);
  }

  private isShellPromptReturnOutput(sData: SessionData, output: string): boolean {
    const printableLines = stripTerminalControlSequences(output)
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const prompt = printableLines.at(-1);
    if (!prompt || prompt.length > 160 || this.isAiTuiPromptLikeShellOutput(prompt)) {
      return false;
    }

    if (sData.shellType === 'cmd') {
      return /^[A-Za-z]:[\\/][^<>|]*>$/.test(prompt);
    }

    if (sData.shellType === 'bash' || sData.shellType === 'zsh' || sData.shellType === 'sh') {
      if (/^[#$%]$/.test(prompt)) {
        return true;
      }

      if (/^[A-Za-z0-9_.-]+-\d+(?:\.\d+)*[$#%]$/.test(prompt)) {
        return true;
      }

      return /^[^\s].*[$#%]$/.test(prompt)
        && (prompt.includes('@') || prompt.includes(':') || prompt.includes('/') || prompt.includes('~'));
    }

    return false;
  }

  private isAiTuiPromptLikeShellOutput(prompt: string): boolean {
    const compact = prompt.replace(/\s+/g, ' ').trim();
    return compact === '>'
      || compact === '›'
      || compact.startsWith('>_')
      || compact.startsWith('│ >_')
      || compact.startsWith('╭')
      || compact.startsWith('╰')
      || compact.toLowerCase().includes('openai codex')
      || compact.toLowerCase().includes('claude code');
  }

  private classifyAiTuiOutputSignal(
    sData: SessionData,
    output: string,
  ): 'waiting_input' | 'repaint_only' | 'busy' {
    const normalized = stripTerminalControlSequences(output).replace(/\r\n?/g, '\n');
    const trimmed = normalized.trim();

    if (this.isEchoOutput(sData, output) || isLikelyCommandEchoOutput(output, sData.lastSubmittedCommand)) {
      return 'waiting_input';
    }

    if (this.isLikelyAiTuiTypingFeedback(sData, output, normalized, trimmed)) {
      return 'waiting_input';
    }

    if (this.isLikelyAiTuiSubmittedEcho(sData, trimmed)) {
      return 'waiting_input';
    }

    if (this.isAiTuiRepaintOnlyOutput(output, normalized, trimmed)) {
      return 'repaint_only';
    }

    return 'busy';
  }

  private isLikelyAiTuiTypingFeedback(
    sData: SessionData,
    raw: string,
    normalized: string,
    trimmed: string,
  ): boolean {
    if (sData.echoTracker.lastInputHasEnter || sData.echoTracker.lastInputAt === 0) {
      return false;
    }

    const elapsed = Date.now() - sData.echoTracker.lastInputAt;
    if (elapsed >= AI_TUI_TYPING_FEEDBACK_THRESHOLD_MS) {
      return false;
    }

    if (sData.inputBuffer.trim().length > 0 && (hasAiTuiRepaintHint(raw) || countNonEmptyLines(normalized) <= 4)) {
      return trimmed.length <= 640;
    }

    return countNonEmptyLines(normalized) <= 1 && trimmed.length <= 128;
  }

  private isLikelyAiTuiSubmittedEcho(sData: SessionData, trimmed: string): boolean {
    if (!sData.echoTracker.lastInputHasEnter || sData.echoTracker.lastInputAt === 0 || !sData.lastSubmittedCommand) {
      return false;
    }

    const elapsed = Date.now() - sData.echoTracker.lastInputAt;
    if (elapsed >= AI_TUI_SUBMITTED_ECHO_THRESHOLD_MS) {
      return false;
    }

    const normalizedChunk = trimmed.replace(/\s+/g, ' ').trim();
    const normalizedCommand = sData.lastSubmittedCommand.replace(/\s+/g, ' ').trim();
    return normalizedChunk === normalizedCommand || normalizedChunk.endsWith(normalizedCommand);
  }

  private isAiTuiRepaintOnlyOutput(raw: string, normalized: string, trimmed: string): boolean {
    const compact = trimmed.replace(/\s+/g, ' ').toLowerCase();

    if (!trimmed) {
      return containsAiTuiTerminalMotion(raw);
    }

    if (AI_TUI_DECORATIVE_FRAME_RE.test(trimmed)) {
      return true;
    }

    if (this.isAiTuiPromptChromeOutput(normalized, trimmed)) {
      return true;
    }

    if (this.isAiTuiStatusTelemetryOutput(raw, normalized, compact)) {
      return true;
    }

    if (!containsAiTuiTerminalMotion(raw)) {
      return false;
    }

    return (
      /^\d+$/.test(trimmed) ||
      /^\d+[smhd]$/i.test(trimmed) ||
      /^\d{1,2}:\d{2}$/.test(trimmed) ||
      (trimmed.length <= 8 && /^[0-9:]+$/.test(trimmed))
    );
  }

  private isAiTuiPromptChromeOutput(normalized: string, trimmed: string): boolean {
    const compact = trimmed.replace(/\s+/g, ' ').toLowerCase();
    const nonEmptyLines = countNonEmptyLines(normalized);
    if (nonEmptyLines === 0 || nonEmptyLines > 4 || compact.length > 320) {
      return false;
    }

    return compact === '›'
      || compact === '>'
      || compact === '>_'
      || compact === '│ >'
      || compact === '│ >_'
      || compact.startsWith('tip:')
      || compact.includes('openai codex')
      || compact.includes('claude code')
      || compact.includes('write tests for @filename');
  }

  private isAiTuiStatusTelemetryOutput(raw: string, normalized: string, compact: string): boolean {
    const nonEmptyLines = countNonEmptyLines(normalized);
    if (nonEmptyLines === 0 || nonEmptyLines > 4 || compact.length === 0 || compact.length > 640) {
      return false;
    }

    if (!hasAiTuiRepaintHint(raw)) {
      return false;
    }

    const hasModelHint = [
      'codex',
      'claude',
      'gpt-',
      'sonnet',
      'opus',
      'haiku',
      'model:',
    ].some((fragment) => compact.includes(fragment));

    const hasTelemetryHint = [
      'context [',
      'window',
      ' used',
      'weekly ',
      'daily ',
      'monthly ',
      'remaining',
      'fast off',
      'fast on',
      'esc to interrupt',
      ' token',
      ' tokens',
      ' in ',
      ' out ',
    ].some((fragment) => compact.includes(fragment));

    return hasModelHint && hasTelemetryHint;
  }

  private initializeHeadlessState(sessionId: string, sessionData: SessionData): void {
    try {
      sessionData.headless = createHeadlessTerminalState({
        cols: sessionData.cols,
        rows: sessionData.rows,
        scrollbackLines: this.runtimePtyConfig.scrollbackLines,
        windowsPty: sessionData.windowsPty,
      });
      sessionData.headlessHealth = 'healthy';
    } catch (error) {
      this.markHeadlessDegraded(sessionId, sessionData, 'create', error);
    }
  }

  private queueHeadlessOutput(sessionId: string, sessionData: SessionData, data: string): void {
    if (sessionData.headlessHealth !== 'healthy' || !sessionData.headless) {
      this.appendDegradedReplayOutput(sessionData, data);
      this.wsRouter?.routeSessionOutput(sessionId, data);
      if (this.pendingResizeReplaySessions.has(sessionId)) {
        this.scheduleResizeReplayRefresh(sessionId, 120);
      }
      return;
    }

    sessionData.pendingHeadlessWrites += 1;
    sessionData.pendingOutputChunks.push(data);
    sessionData.headlessWriteChain = sessionData.headlessWriteChain
      .then(async () => {
        await this.applyHeadlessOutput(sessionId, sessionData, data);
      })
      .catch((error) => {
        if (!this.isActiveSession(sessionId, sessionData)) {
          return;
        }

        this.markHeadlessDegraded(sessionId, sessionData, 'write', error);
        this.wsRouter?.routeSessionOutput(sessionId, data);
      })
      .finally(() => {
        if (!this.isActiveSession(sessionId, sessionData)) {
          return;
        }
        sessionData.pendingHeadlessWrites = Math.max(0, sessionData.pendingHeadlessWrites - 1);
      });
  }

  private async applyHeadlessOutput(sessionId: string, sessionData: SessionData, data: string): Promise<void> {
    if (!sessionData.headless) {
      return;
    }

    await Promise.race([
      writeHeadlessTerminal(sessionData.headless, data),
      sessionData.headlessCloseSignal.promise,
    ]);
    if (!this.isActiveSession(sessionId, sessionData) || sessionData.headlessHealth !== 'healthy' || !sessionData.headless) {
      return;
    }

    const flushedOutput = sessionData.pendingOutputChunks.shift() ?? data;
    sessionData.screenSeq += 1;
    this.appendUnsnapshottedOutput(sessionData, flushedOutput);
    this.markSnapshotDirty(sessionData);
    this.wsRouter?.routeSessionOutput(sessionId, data);
    if (this.pendingResizeReplaySessions.has(sessionId)) {
      this.scheduleResizeReplayRefresh(sessionId, 120);
    }
  }

  private markSnapshotDirty(sessionData: SessionData): void {
    if (sessionData.snapshotCache) {
      sessionData.snapshotCache.dirty = true;
    }
  }

  private markHeadlessDegraded(
    sessionId: string,
    sessionData: SessionData,
    phase: 'create' | 'write' | 'resize' | 'serialize',
    error: unknown,
  ): void {
    if (!this.isActiveSession(sessionId, sessionData)) {
      return;
    }

    if (sessionData.headless) {
      disposeHeadlessTerminal(sessionData.headless);
      sessionData.headless = null;
    }
    sessionData.headlessCloseSignal.resolve();
    const pendingOutput = sessionData.pendingOutputChunks.join('');
    const seed = `${sessionData.snapshotCache?.data ?? ''}${sessionData.unsnapshottedOutput}${pendingOutput}`;
    if (seed.length > 0) {
      const degraded = truncateTerminalPayloadTail(seed, this.runtimePtyConfig.maxSnapshotBytes);
      sessionData.degradedReplayBuffer = degraded.content;
      sessionData.degradedReplayTruncated =
        degraded.truncated ||
        Boolean(sessionData.snapshotCache?.truncated) ||
        sessionData.unsnapshottedOutputTruncated;
    }
    sessionData.pendingOutputChunks = [];
    sessionData.unsnapshottedOutput = '';
    sessionData.unsnapshottedOutputTruncated = false;
    sessionData.headlessHealth = 'degraded';
    sessionData.snapshotCache = null;

    const message = error instanceof Error ? error.message : String(error);
    this.captureDebugEvent(sessionId, 'headless', 'headless_degraded', {
      phase,
      message,
      screenSeq: sessionData.screenSeq,
    });
    console.warn(`[SessionManager] Headless terminal degraded (${phase}) for session ${sessionId}: ${message}`);
  }

  private createDegradedSnapshot(sessionData: SessionData): SessionScreenSnapshot {
    return {
      seq: sessionData.screenSeq,
      cols: sessionData.cols,
      rows: sessionData.rows,
      data: sessionData.degradedReplayBuffer,
      truncated: sessionData.degradedReplayTruncated,
      generatedAt: Date.now(),
      health: 'degraded',
      windowsPty: sessionData.windowsPty,
    };
  }

  private isActiveSession(sessionId: string, sessionData: SessionData): boolean {
    return this.sessions.get(sessionId) === sessionData;
  }

  private appendDegradedReplayOutput(sessionData: SessionData, data: string): void {
    const nextContent = `${sessionData.degradedReplayBuffer}${data}`;
    const truncated = truncateTerminalPayloadTail(nextContent, this.runtimePtyConfig.maxSnapshotBytes);
    sessionData.degradedReplayBuffer = truncated.content;
    sessionData.degradedReplayTruncated = sessionData.degradedReplayTruncated || truncated.truncated;
  }

  private appendUnsnapshottedOutput(sessionData: SessionData, data: string): void {
    const nextContent = `${sessionData.unsnapshottedOutput}${data}`;
    const truncated = truncateTerminalPayloadTail(nextContent, this.runtimePtyConfig.maxSnapshotBytes);
    sessionData.unsnapshottedOutput = truncated.content;
    sessionData.unsnapshottedOutputTruncated = sessionData.unsnapshottedOutputTruncated || truncated.truncated;
  }

  private scheduleResizeReplayRefresh(sessionId: string, delayMs = 75): void {
    const existing = this.pendingResizeRefreshTimers.get(sessionId);
    if (existing) {
      clearTimeout(existing);
    }

    if (!this.pendingResizeReplayStartedAt.has(sessionId)) {
      this.pendingResizeReplayStartedAt.set(sessionId, Date.now());
    }

    const startedAt = this.pendingResizeReplayStartedAt.get(sessionId) ?? Date.now();
    const elapsedMs = Date.now() - startedAt;
    const remainingDeadlineMs = MAX_RESIZE_REPLAY_DELAY_MS - elapsedMs;
    const effectiveDelayMs =
      remainingDeadlineMs <= 0
        ? Math.min(delayMs, 30)
        : remainingDeadlineMs > 0
        ? Math.min(delayMs, Math.max(1, remainingDeadlineMs))
        : delayMs;

    const timer = setTimeout(() => {
      const session = this.sessions.get(sessionId);
      if (!session) {
        this.pendingResizeReplaySessions.delete(sessionId);
        this.pendingResizeReplayStartedAt.delete(sessionId);
        this.pendingResizeReplayLastOutputAt.delete(sessionId);
        this.pendingResizeRefreshTimers.delete(sessionId);
        return;
      }

      const startedAt = this.pendingResizeReplayStartedAt.get(sessionId) ?? Date.now();
      const elapsedMs = Date.now() - startedAt;
      const afterDeadline = elapsedMs >= MAX_RESIZE_REPLAY_DELAY_MS;
      const lastOutputAt = this.pendingResizeReplayLastOutputAt.get(sessionId);
      const clearResizeReplayState = (): void => {
        this.pendingResizeRefreshTimers.delete(sessionId);
        this.pendingResizeReplaySessions.delete(sessionId);
        this.pendingResizeReplayStartedAt.delete(sessionId);
        this.pendingResizeReplayLastOutputAt.delete(sessionId);
      };

      if (lastOutputAt !== undefined) {
        const quietForMs = Date.now() - lastOutputAt;
        if (!afterDeadline && quietForMs < RESIZE_REPLAY_QUIET_WINDOW_MS) {

          this.scheduleResizeReplayRefresh(
            sessionId,
            Math.max(10, RESIZE_REPLAY_QUIET_WINDOW_MS - quietForMs),
          );
          return;
        }

        if (session.pendingHeadlessWrites > 0) {
          this.scheduleResizeReplayRefresh(sessionId, 30);
          return;
        }
      } else if (session.pendingHeadlessWrites > 0) {
        this.scheduleResizeReplayRefresh(sessionId, 30);
        return;
      }

      if (session.pendingHeadlessWrites > 0) {
        this.scheduleResizeReplayRefresh(sessionId, 30);
        return;
      }

      clearResizeReplayState();
      this.wsRouter?.refreshReplaySnapshots(sessionId);
    }, effectiveDelayMs);
    timer.unref();
    this.pendingResizeRefreshTimers.set(sessionId, timer);
  }

  private captureDebugEvent(
    sessionId: string,
    source: SessionDebugCaptureEvent['source'],
    kind: string,
    details?: Record<string, SessionDebugCaptureValue>,
    rawPreview?: string,
  ): void {
    if (!this.isDebugCaptureEnabled(sessionId)) {
      return;
    }

    const event: SessionDebugCaptureEvent = {
      eventId: ++this.debugCaptureCounter,
      recordedAt: new Date().toISOString(),
      sessionId,
      source,
      kind,
      details,
      preview: rawPreview ? formatDebugPreview(rawPreview) : undefined,
    };

    const events = this.debugCaptureBySession.get(sessionId) ?? [];
    events.push(event);
    if (events.length > MAX_DEBUG_CAPTURE_EVENTS) {
      events.splice(0, events.length - MAX_DEBUG_CAPTURE_EVENTS);
    }
    this.debugCaptureBySession.set(sessionId, events);
  }
}

export const sessionManager = new SessionManager();

function clonePtyConfig(source: PTYConfig): PTYConfig {
  return {
    termName: source.termName,
    defaultCols: source.defaultCols,
    defaultRows: source.defaultRows,
    useConpty: source.useConpty,
    windowsPowerShellBackend: source.windowsPowerShellBackend ?? 'inherit',
    scrollbackLines: source.scrollbackLines,
    maxSnapshotBytes: source.maxSnapshotBytes,
    shell: source.shell,
  };
}

function createDeferredSignal<T>(): DeferredSignal<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function formatDebugPreview(raw: string): string {
  return raw
    .slice(0, DEBUG_CAPTURE_PREVIEW_CHARS)
    .replace(/\x1b/g, '\\x1b')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t');
}

function formatWinptyProbeFailure(error: unknown): string {
  if (error && typeof error === 'object') {
    const childProcessError = error as {
      message?: string;
      stderr?: Buffer | string;
      status?: number | null;
      signal?: string | null;
      code?: string;
    };
    const stderr = childProcessError.stderr ? String(childProcessError.stderr).trim() : '';
    if (stderr) {
      return stderr;
    }
    if (childProcessError.status === 124 || childProcessError.signal === 'SIGTERM') {
      return 'winpty probe timed out while starting PowerShell';
    }
    if (childProcessError.code) {
      return `${childProcessError.code}${childProcessError.message ? `: ${childProcessError.message}` : ''}`;
    }
    if (childProcessError.message) {
      return childProcessError.message;
    }
  }
  return String(error);
}

function buildRawOutputDebugDetails(
  sessionData: SessionData,
  rawData: string,
  outputData: string,
  foundMarker: boolean,
): Record<string, SessionDebugCaptureValue> {
  const now = Date.now();
  const recentInputs = sessionData.echoTracker.recentInputs.filter((entry) => (now - entry.at) <= DEBUG_INPUT_CORRELATION_WINDOW_MS);
  sessionData.echoTracker.recentInputs = recentInputs;
  const newestInput = recentInputs.at(-1);
  const oldestInput = recentInputs[0];
  const derivedState = sessionData.derivedState ?? createInitialDerivedState();

  return {
    byteLength: Buffer.byteLength(rawData, 'utf8'),
    strippedByteLength: Buffer.byteLength(outputData, 'utf8'),
    detectionMode: sessionData.detectionMode,
    derivedOwnership: derivedState.ownership,
    derivedActivity: derivedState.activity,
    foregroundAppId: derivedState.foregroundAppId ?? null,
    detectorId: derivedState.detectorId ?? null,
    foundOsc133Marker: foundMarker,
    msSinceNewestInputSample: newestInput
      ? now - newestInput.at
      : null,
    msSinceOldestInputSample: oldestInput
      ? now - oldestInput.at
      : null,
    recentInputSampleCount: recentInputs.length,
    recentEnterSampleCount: recentInputs.filter((entry) => entry.hasEnter).length,
    recentInputSampleClasses: recentInputs.length > 0
      ? recentInputs.slice(-3).map((entry) => entry.inputClass).join(',')
      : null,
  };
}

function hasCoreDerivedStateChange(previous: SessionDerivedState, next: SessionDerivedState): boolean {
  return (
    previous.ownership !== next.ownership ||
    previous.activity !== next.activity ||
    previous.foregroundAppId !== next.foregroundAppId ||
    previous.detectorId !== next.detectorId
  );
}

function sanitizeDebugValues(
  details?: Record<string, string | number | boolean | null>,
): Record<string, SessionDebugCaptureValue> {
  return details ? { ...details } : {};
}

function isInteractiveAiAppId(value: string | undefined | null): value is ForegroundAppId {
  return value === 'hermes' || value === 'codex' || value === 'claude';
}

function detectForegroundAppHint(command: string): ForegroundAppId | null {
  const executable = getCommandExecutableToken(command);
  if (executable === 'hermes') {
    return 'hermes';
  }
  if (executable === 'codex') {
    return 'codex';
  }
  if (executable === 'claude' || executable === 'claude-code') {
    return 'claude';
  }

  return null;
}

function getCommandExecutableToken(command: string): string | null {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return null;
  }

  let index = 0;
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(tokens[index])) {
    index += 1;
  }
  while (index < tokens.length && (tokens[index] === 'env' || tokens[index] === 'command')) {
    index += 1;
    while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(tokens[index])) {
      index += 1;
    }
  }

  return normalizeExecutableToken(tokens[index] ?? '');
}

function normalizeExecutableToken(token: string): string {
  const cleaned = token.trim().replace(/^["']|["']$/g, '');
  const basename = cleaned.split(/[\\/]/).at(-1) ?? cleaned;
  return basename.toLowerCase().replace(/\.(?:exe|cmd|bat|ps1)$/i, '');
}

function stripInputTrackingControlSequences(raw: string): string {
  return raw
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-_]/g, '');
}

function containsHistoryRecallControlSequence(raw: string): boolean {
  return /\x1b\[(?:A|B)/.test(raw);
}

function isLikelyCommandEchoOutput(raw: string, lastSubmittedCommand?: string): boolean {
  const normalized = stripTerminalControlSequences(raw)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  if (normalized.length === 0) {
    return false;
  }

  for (const line of normalized) {
    const directHint = detectForegroundAppHint(line);
    if (directHint) {
      return true;
    }

    const promptSplit = line.split(/[>$#]\s+/);
    const promptCandidate = promptSplit.length > 1 ? promptSplit.at(-1)?.trim() : null;
    if (promptCandidate && detectForegroundAppHint(promptCandidate)) {
      return true;
    }

    if (lastSubmittedCommand) {
      const normalizedCommand = lastSubmittedCommand.replace(/\s+/g, ' ').trim();
      if (line === normalizedCommand || line.endsWith(normalizedCommand)) {
        return true;
      }
    }
  }

  return false;
}

function isLikelyAiTuiLaunchFailureOutput(sessionData: SessionData, raw: string): boolean {
  const attempt = sessionData.aiTuiLaunchAttempt;
  if (!attempt) {
    return false;
  }

  if (Date.now() - attempt.startedAt > 2000) {
    return false;
  }

  const cleanedLines = stripTerminalControlSequences(raw)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (cleanedLines.length === 0) {
    return false;
  }

  const candidates = getLaunchFailureExecutableCandidates(attempt);
  return cleanedLines.some((line) => candidates.some((candidate) => isAnchoredLaunchFailureLine(line, candidate)));
}

function getLaunchFailureExecutableCandidates(attempt: AiTuiLaunchAttempt): string[] {
  const candidates = new Set([attempt.executable, attempt.appId]);
  if (attempt.appId === 'claude') {
    candidates.add('claude-code');
  }
  return Array.from(candidates).filter(Boolean);
}

function isAnchoredLaunchFailureLine(line: string, executable: string): boolean {
  const escapedExecutable = escapeRegExp(executable);
  const executableWithPath = `(?:[^\\s:'"]*[\\\\/])?${escapedExecutable}(?:\\.(?:exe|cmd|bat|ps1))?`;
  const quotedExecutable = `['"\`]?${executableWithPath}['"\`]?`;

  const patterns = [
    new RegExp(`^(?:[^:]+:\\s*)?(?:line\\s+\\d+:\\s*)?${quotedExecutable}\\s*:\\s*command not found$`, 'i'),
    new RegExp(`^(?:[^:]+:\\s*)?(?:\\d+:\\s*)?${quotedExecutable}\\s*:\\s*not found$`, 'i'),
    new RegExp(`^(?:[^:]+:\\s*)?command not found:\\s*${quotedExecutable}$`, 'i'),
    new RegExp(`^${quotedExecutable}\\s*:\\s*no such file or directory$`, 'i'),
    new RegExp(`^${quotedExecutable}\\s*:\\s*the term\\s+['"\`]?${escapedExecutable}['"\`]?\\s+is not recognized`, 'i'),
    new RegExp(`^the term\\s+['"\`]?${escapedExecutable}['"\`]?\\s+is not recognized`, 'i'),
    new RegExp(`^${quotedExecutable}\\s+is not recognized as`, 'i'),
    new RegExp(`^cannot find\\s+${quotedExecutable}`, 'i'),
  ];

  return patterns.some((pattern) => pattern.test(line));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripTerminalControlSequences(raw: string): string {
  return raw
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-_]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

function countNonEmptyLines(value: string): number {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .length;
}

function containsAiTuiTerminalMotion(raw: string): boolean {
  return AI_TUI_CURSOR_MOTION_RE.test(raw) || /\x1b\[[0-9;]*m/.test(raw);
}

function hasAiTuiRepaintHint(raw: string): boolean {
  return raw.includes('\r')
    || raw.includes('\x1b[K')
    || raw.includes('\x1b[J')
    || containsAiTuiTerminalMotion(raw);
}
