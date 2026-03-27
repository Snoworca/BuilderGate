import * as pty from 'node-pty';
import { v4 as uuidv4 } from 'uuid';
import os from 'os';
import path from 'path';
import { unlinkSync, watchFile, unwatchFile, readFileSync } from 'fs';
import { Session, SessionDTO, SessionStatus, UpdateSessionRequest, ShellType, ShellInfo } from '../types/index.js';
import type { PTYConfig, SessionConfig } from '../types/config.types.js';
import { config } from '../utils/config.js';
import { AppError, ErrorCode } from '../utils/errors.js';
import type { WebSocket } from 'ws';
import type { WsRouter } from '../ws/WsRouter.js';

interface SessionData {
  session: Session;
  pty: pty.IPty;
  idleTimer: NodeJS.Timeout | null;
  outputBuffer: string; // Buffer for initial output
  initialCwd: string;   // CWD at session creation
  cwdFilePath?: string;  // Windows CWD tracking temp file path
  lastCwd?: string;      // Last known CWD for change detection
}

export class SessionManager {
  private sessions: Map<string, SessionData> = new Map();
  private sessionCounter: number = 0;
  private runtimePtyConfig: PTYConfig;
  private runtimeSessionConfig: SessionConfig;
  private wsRouter: WsRouter | null = null;

  constructor(initialConfig: { pty: PTYConfig; session: SessionConfig } = { pty: config.pty, session: config.session }) {
    this.runtimePtyConfig = clonePtyConfig(initialConfig.pty);
    this.runtimeSessionConfig = { idleDelayMs: initialConfig.session.idleDelayMs };
  }

  createSession(name?: string, shell?: ShellType, cwd?: string): SessionDTO {
    const id = uuidv4();
    this.sessionCounter++;
    const sessionName = name || `Session-${this.sessionCounter}`;

    const { shell: shellCmd, args: shellArgs, shellType } = this.resolveShell(shell);
    const initialCwd = cwd || process.env.HOME || process.env.USERPROFILE || '/';
    const ptyProcess = pty.spawn(shellCmd, shellArgs, {
      name: this.runtimePtyConfig.termName,
      cols: this.runtimePtyConfig.defaultCols,
      rows: this.runtimePtyConfig.defaultRows,
      cwd: initialCwd,
      env: process.env as { [key: string]: string },
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

    const sessionData: SessionData = {
      session,
      pty: ptyProcess,
      idleTimer: null,
      outputBuffer: '',
      initialCwd,
    };

    this.sessions.set(id, sessionData);

    // Inject CWD tracking hook based on shell type
    this.injectCwdHook(id, sessionData, ptyProcess, shellType);

    // Handle PTY output
    ptyProcess.onData((data: string) => {
      this.updateStatus(id, 'running');

      const sData = this.sessions.get(id);
      if (sData) {
        const hasWsSubscribers = this.wsRouter?.hasSubscribers(id) ?? false;
        if (!hasWsSubscribers) {
          this.appendBufferedOutput(sData, data);
        } else {
          this.broadcastWs(id, 'output', { data });
        }
      }

      this.scheduleIdleTransition(id);
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

    // Clean up CWD file watching and temp file
    if (data.cwdFilePath) {
      unwatchFile(data.cwdFilePath);
      try { unlinkSync(data.cwdFilePath); } catch { /* ignore */ }
    }

    // Remove from map
    this.sessions.delete(id);
    return true;
  }

  writeInput(id: string, input: string): boolean {
    const data = this.sessions.get(id);
    if (!data) return false;

    data.pty.write(input);
    data.session.lastActiveAt = new Date();
    return true;
  }

  resize(id: string, cols: number, rows: number): boolean {
    const data = this.sessions.get(id);
    if (!data) return false;

    data.pty.resize(cols, rows);
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

  getCwdFilePath(sessionId: string): string | null {
    const data = this.sessions.get(sessionId);
    return data?.cwdFilePath ?? null;
  }

  getAvailableShells(): ShellInfo[] {
    const shells: ShellInfo[] = [];
    if (process.platform === 'win32') {
      shells.push(
        { id: 'powershell', label: 'PowerShell', icon: 'PS' },
        { id: 'wsl', label: 'WSL (Bash)', icon: '>_' }
      );
    } else {
      shells.push({ id: 'bash', label: 'Bash', icon: '>_' });
    }
    return shells;
  }

  /**
   * Resolve shell command and arguments based on config and platform.
   */
  private resolveShell(shellOverride?: ShellType): { shell: string; args: string[]; shellType: 'powershell' | 'bash' } {
    const shellConfig = shellOverride || this.runtimePtyConfig.shell || 'auto';

    if (shellConfig === 'powershell') {
      return { shell: 'powershell.exe', args: [], shellType: 'powershell' };
    }
    if (shellConfig === 'wsl') {
      return { shell: 'wsl.exe', args: [], shellType: 'bash' };
    }
    if (shellConfig === 'bash') {
      return process.platform === 'win32'
        ? { shell: 'wsl.exe', args: [], shellType: 'bash' }
        : { shell: 'bash', args: [], shellType: 'bash' };
    }

    // auto: OS default
    if (process.platform === 'win32') {
      return { shell: 'powershell.exe', args: [], shellType: 'powershell' };
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

    for (const data of this.sessions.values()) {
      if (data.outputBuffer.length > this.runtimePtyConfig.maxBufferSize) {
        data.outputBuffer = data.outputBuffer.slice(-this.runtimePtyConfig.maxBufferSize);
      }
    }
  }

  /**
   * Inject CWD tracking hook into the shell session.
   * - PowerShell: override prompt function to write $PWD to temp file
   * - Bash/WSL: use PROMPT_COMMAND to write $PWD to temp file
   */
  private injectCwdHook(
    id: string,
    sessionData: SessionData,
    ptyProcess: pty.IPty,
    shellType: 'powershell' | 'bash'
  ): void {
    const cwdFile = path.join(os.tmpdir(), `buildergate-cwd-${id}.txt`);
    sessionData.cwdFilePath = cwdFile;

    if (shellType === 'powershell') {
      const escapedPath = cwdFile.replace(/\\/g, '\\\\');
      const hookScript = `$Global:__OrigPrompt = $function:prompt; function Global:prompt { $pwd.Path | Out-File -FilePath '${escapedPath}' -Encoding utf8 -NoNewline; if ($Global:__OrigPrompt) { & $Global:__OrigPrompt } else { "PS $($pwd.Path)> " } }\r`;
      setTimeout(() => {
        ptyProcess.write(hookScript);
      }, 500);
    } else {
      // Bash / WSL: use PROMPT_COMMAND
      // Convert Windows temp path to WSL path if needed (e.g., C:\Users\... → /mnt/c/Users/...)
      const wslPath = process.platform === 'win32'
        ? '/mnt/' + cwdFile[0].toLowerCase() + cwdFile.slice(2).replace(/\\/g, '/')
        : cwdFile;
      const hookScript = ` PROMPT_COMMAND='printf "%s" "$PWD" > "${wslPath}"'\r`;
      setTimeout(() => {
        ptyProcess.write(hookScript);
      }, 500);
    }

    // Watch CWD file for changes and push via WS
    watchFile(cwdFile, { interval: 1000 }, () => {
      try {
        const cwd = readFileSync(cwdFile, 'utf8').trim();
        if (cwd && cwd !== sessionData.lastCwd) {
          sessionData.lastCwd = cwd;
          this.broadcastWs(id, 'cwd', { cwd });
        }
      } catch { /* file may not exist yet — ignore */ }
    });
  }

  // ==========================================================================
  // WebSocket Integration (Step 8)
  // ==========================================================================

  setWsRouter(router: WsRouter): void {
    this.wsRouter = router;
  }

  /** Flush buffered output to a specific WS client (called on subscribe) */
  flushBufferToWs(sessionId: string, ws: WebSocket): void {
    const data = this.sessions.get(sessionId);
    if (!data) return;

    if (data.outputBuffer.length > 0) {
      const msg = JSON.stringify({ type: 'output', sessionId, data: data.outputBuffer });
      if (ws.readyState === 1) ws.send(msg);
      data.outputBuffer = '';
    }

    // Send current status
    const statusMsg = JSON.stringify({ type: 'status', sessionId, status: data.session.status });
    if (ws.readyState === 1) ws.send(statusMsg);
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

  private appendBufferedOutput(sessionData: SessionData, data: string): void {
    sessionData.outputBuffer += data;
    if (sessionData.outputBuffer.length > this.runtimePtyConfig.maxBufferSize) {
      sessionData.outputBuffer = sessionData.outputBuffer.slice(-this.runtimePtyConfig.maxBufferSize);
    }
  }
}

export const sessionManager = new SessionManager();

function clonePtyConfig(source: PTYConfig): PTYConfig {
  return {
    termName: source.termName,
    defaultCols: source.defaultCols,
    defaultRows: source.defaultRows,
    useConpty: source.useConpty,
    maxBufferSize: source.maxBufferSize,
    shell: source.shell,
  };
}
