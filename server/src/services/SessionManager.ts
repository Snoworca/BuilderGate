import * as pty from 'node-pty';
import { v4 as uuidv4 } from 'uuid';
import os from 'os';
import path from 'path';
import { unlinkSync, watchFile, unwatchFile, readFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { Session, SessionDTO, SessionStatus, UpdateSessionRequest, ShellType, ShellInfo } from '../types/index.js';
import type { PTYConfig, SessionConfig } from '../types/config.types.js';
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
import type { WindowsPtyBackend, WindowsPtyInfo } from '../types/ws-protocol.js';

interface EchoTracker {
  /** writeInput이 호출된 시각 (ms, Date.now) */
  lastInputAt: number;
  /** 마지막 입력 데이터의 바이트 길이 */
  lastInputLen: number;
  /** 마지막 입력에 Enter(\r 또는 \n) 포함 여부 */
  lastInputHasEnter: boolean;
}

/** idle 감지 모드 */
type DetectionMode = 'heuristic' | 'osc133';

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
  source: 'pty' | 'snapshot' | 'headless';
  kind: string;
  details?: Record<string, SessionDebugCaptureValue>;
  preview?: string;
}

const LEGACY_TRUNCATED_REPLAY_PLACEHOLDER = '\r\n[BuilderGate] Screen snapshot exceeded maxSnapshotBytes. Waiting for new output...\r\n';
const LEGACY_DEGRADED_REPLAY_PLACEHOLDER = '\r\n[BuilderGate] Server snapshot is unavailable for this session. Using fallback recovery when possible...\r\n';
const MAX_DEBUG_CAPTURE_EVENTS = 400;
const DEBUG_CAPTURE_PREVIEW_CHARS = 320;

interface SessionData {
  session: Session;
  pty: pty.IPty;
  idleTimer: NodeJS.Timeout | null;
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
  private runtimePtyConfig: PTYConfig;
  private runtimeSessionConfig: SessionConfig;
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

  constructor(initialConfig: { pty: PTYConfig; session: SessionConfig } = { pty: config.pty, session: config.session }) {
    this.runtimePtyConfig = clonePtyConfig(initialConfig.pty);
    this.runtimeSessionConfig = { idleDelayMs: initialConfig.session.idleDelayMs };
    // 서버 시작 시 한 번만 셸 감지 후 캐싱
    this.cachedAvailableShells = this.detectAvailableShells();
  }

  createSession(name?: string, shell?: ShellType, cwd?: string): SessionDTO {
    const id = uuidv4();
    this.sessionCounter++;
    const sessionName = name || `Session-${this.sessionCounter}`;

    const cwdFilePath = this.getCwdTrackingFilePath(id);
    const { shell: shellCmd, args: shellArgs, shellType } = this.resolveShell(shell, cwdFilePath);
    const initialCwd = this.resolveSpawnCwd(cwd, shellType);

    // Step 9: OSC 133 셸 통합 환경변수 구성
    const env = this.buildShellEnv(shellType);
    const cols = this.runtimePtyConfig.defaultCols;
    const rows = this.runtimePtyConfig.defaultRows;

    const ptyProcess = pty.spawn(shellCmd, shellArgs, {
      name: this.runtimePtyConfig.termName,
      cols,
      rows,
      cwd: initialCwd,
      env,  // Step 9: 확장된 env (OSC 133 주입 포함)
      // Windows PTY backend (ConPTY vs winpty)
      useConpty: this.runtimePtyConfig.useConpty,
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
      headless: null,
      headlessHealth: 'healthy',
      headlessWriteChain: Promise.resolve(),
      headlessCloseSignal: createDeferredSignal<void>(),
      pendingHeadlessWrites: 0,
      cols,
      rows,
      screenSeq: 0,
      snapshotCache: null,
      windowsPty: this.getWindowsPtyInfo(),
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
        lastInputLen: 0,
        lastInputHasEnter: false,
      },
      detectionMode: 'heuristic',
      oscDetector,
    };

    this.sessions.set(id, sessionData);
    this.initializeHeadlessState(id, sessionData);

    // Step 9: OSC 133 콜백 등록
    oscDetector.setCallback((status, event) => {
      const sd = this.sessions.get(id);
      if (!sd || sd.detectionMode !== 'osc133') return;

      switch (event.type) {
        case 'prompt-start':  // A 마커
        case 'command-end':   // D 마커
          // idle 전환
          this.updateStatus(id, 'idle');
          // osc133 모드에서는 idle 타이머 불필요
          if (sd.idleTimer) {
            clearTimeout(sd.idleTimer);
            sd.idleTimer = null;
          }
          break;
        case 'command-start': // C 마커
          // running 전환
          this.updateStatus(id, 'running');
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
      }

      // ========================================
      // Step 9: 모드별 상태 전환
      // ========================================
      if (sData.detectionMode === 'heuristic') {
        // Tier 1: 에코 휴리스틱
        const isEcho = this.isEchoOutput(sData, stripped);
        if (!isEcho) {
          this.updateStatus(id, 'running');
          this.scheduleIdleTransition(id);
        }
      }
      // osc133 모드: OscDetector 콜백에서 직접 상태 전환

      // ========================================
      // 출력 브로드캐스트/버퍼링 (stripped 사용)
      // ========================================
      // OSC 133 마커가 제거된 출력을 전달
      const outputData = sData.detectionMode === 'osc133' ? stripped : rawData;

      if (outputData.length > 0) {
        this.captureDebugEvent(id, 'pty', 'raw_output', {
          byteLength: Buffer.byteLength(rawData, 'utf8'),
          strippedByteLength: Buffer.byteLength(outputData, 'utf8'),
          detectionMode: sData.detectionMode,
          foundOsc133Marker: foundMarker,
        }, rawData);
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

    data.idleTimer = setTimeout(() => {
      this.updateStatus(id, 'idle');
    }, this.runtimeSessionConfig.idleDelayMs);
  }

  private updateStatus(id: string, status: SessionStatus): void {
    const data = this.sessions.get(id);
    if (!data || data.session.status === status) return;

    data.session.status = status;
    data.session.lastActiveAt = new Date();
    this.broadcastWs(id, 'status', { status });
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

    // Kill PTY process
    data.pty.kill();

    // Step 9: OSC 감지기 정리
    data.oscDetector.destroy();

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

  writeInput(id: string, input: string): boolean {
    const data = this.sessions.get(id);
    if (!data) return false;

    // Step 9: 에코 추적 정보 기록 (pty.write 전에 기록)
    const hasEnter = input.includes('\r') || input.includes('\n');
    data.echoTracker.lastInputAt = Date.now();
    data.echoTracker.lastInputLen = input.length;
    data.echoTracker.lastInputHasEnter = hasEnter;

    // Enter 입력 시 heuristic 모드에서 즉시 running 전환
    if (hasEnter && data.detectionMode === 'heuristic') {
      this.updateStatus(id, 'running');
    }

    data.pty.write(input);
    data.session.lastActiveAt = new Date();
    return true;
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

    this.wsRouter?.refreshReplaySnapshots(id);
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
    if (process.platform === 'win32') {
      // PowerShell: 항상 추가
      shells.push({ id: 'powershell', label: 'PowerShell', icon: '💙' });
      // cmd: 항상 추가
      shells.push({ id: 'cmd', label: 'Command Prompt', icon: '⬛' });
      // WSL: wsl.exe 존재 시에만 추가
      if (this.isCommandAvailable('wsl.exe')) {
        shells.push({ id: 'wsl', label: 'WSL (Bash)', icon: '🐧' });
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
      if (process.platform === 'win32') {
        execSync(`where ${cmd}`, { stdio: 'ignore' });
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
      execSync(`wsl.exe which ${shell}`, { stdio: 'ignore', timeout: 3000 });
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
        if (process.platform === 'win32') {
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

  private getWindowsPtyInfo(): WindowsPtyInfo | undefined {
    if (process.platform !== 'win32') {
      return undefined;
    }

    const backend: WindowsPtyBackend = this.runtimePtyConfig.useConpty ? 'conpty' : 'winpty';
    const buildNumber = parseInt(os.release().split('.').pop() ?? '', 10);
    return {
      backend,
      buildNumber: Number.isFinite(buildNumber) ? buildNumber : undefined,
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
      // ESM 환경: import.meta.url 기반
      // 컴파일 후 dist/services/SessionManager.js → dist/shell-integration/
      const currentFileUrl = new URL(import.meta.url);
      let currentDir = path.dirname(currentFileUrl.pathname);
      // Windows에서 URL pathname이 /C:/... 형태로 오는 경우 앞의 / 제거
      if (process.platform === 'win32' && currentDir.startsWith('/')) {
        currentDir = currentDir.slice(1);
      }
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

    const isWindows = process.platform === 'win32';

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
    const shellConfig = shellOverride || this.runtimePtyConfig.shell || 'auto';

    if (shellConfig === 'powershell') {
      return { shell: 'powershell.exe', args: this.buildPowerShellArgs(cwdFilePath), shellType: 'powershell' };
    }
    if (shellConfig === 'wsl') {
      return { shell: 'wsl.exe', args: [], shellType: 'bash' };
    }
    if (shellConfig === 'bash') {
      return process.platform === 'win32'
        ? { shell: 'wsl.exe', args: [], shellType: 'bash' }
        : { shell: 'bash', args: [], shellType: 'bash' };
    }
    if (shellConfig === 'zsh') {
      return process.platform === 'win32'
        ? { shell: 'wsl.exe', args: ['-e', 'zsh'], shellType: 'zsh' }
        : { shell: 'zsh', args: [], shellType: 'zsh' };
    }
    if (shellConfig === 'sh') {
      return process.platform === 'win32'
        ? { shell: 'wsl.exe', args: ['-e', 'sh'], shellType: 'sh' }
        : { shell: 'sh', args: [], shellType: 'sh' };
    }
    if (shellConfig === 'cmd') {
      return { shell: 'cmd.exe', args: [], shellType: 'cmd' };
    }

    // auto: OS default
    if (process.platform === 'win32') {
      return { shell: 'powershell.exe', args: this.buildPowerShellArgs(cwdFilePath), shellType: 'powershell' };
    }
    // macOS default is zsh since Catalina; fallback to bash
    if (process.platform === 'darwin' && this.isCommandAvailable('zsh')) {
      return { shell: 'zsh', args: [], shellType: 'zsh' };
    }
    return { shell: 'bash', args: [], shellType: 'bash' };
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

  updateRuntimeConfig(next: { idleDelayMs?: number; pty?: Partial<PTYConfig> }): void {
    if (next.idleDelayMs !== undefined) {
      this.runtimeSessionConfig.idleDelayMs = next.idleDelayMs;
    }

    if (next.pty) {
      this.runtimePtyConfig = {
        ...this.runtimePtyConfig,
        ...next.pty,
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
      const wslPath = process.platform === 'win32'
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
      '$Global:__BuilderGateOrigPrompt = $function:prompt',
      `$pwd.Path | Out-File -FilePath '${escapedPath}' -Encoding utf8 -NoNewline`,
      "function Global:prompt { $pwd.Path | Out-File -FilePath '" + escapedPath + "' -Encoding utf8 -NoNewline; if ($Global:__BuilderGateOrigPrompt) { & $Global:__BuilderGateOrigPrompt } else { \"PS $($pwd.Path)> \" } }",
    ].join('; ');

    return ['-NoLogo', '-NoExit', '-Command', hookScript];
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
