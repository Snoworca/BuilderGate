import * as pty from 'node-pty';
import { v4 as uuidv4 } from 'uuid';
import { Response } from 'express';
import os from 'os';
import path from 'path';
import { unlinkSync } from 'fs';
import { Session, SessionDTO, SessionStatus, UpdateSessionRequest, ShellType, ShellInfo } from '../types/index.js';
import { sendSSE } from '../utils/sse.js';
import { config } from '../utils/config.js';
import { AppError, ErrorCode } from '../utils/errors.js';

interface SessionData {
  session: Session;
  pty: pty.IPty;
  sseClients: Set<Response>;
  idleTimer: NodeJS.Timeout | null;
  outputBuffer: string; // Buffer for initial output
  initialCwd: string;   // CWD at session creation
  cwdFilePath?: string;  // Windows CWD tracking temp file path
}

class SessionManager {
  private sessions: Map<string, SessionData> = new Map();
  private sessionCounter: number = 0;
  private readonly IDLE_DELAY_MS = config.session.idleDelayMs;
  private readonly MAX_BUFFER_SIZE = config.pty.maxBufferSize;

  createSession(name?: string, shell?: ShellType, cwd?: string): SessionDTO {
    const id = uuidv4();
    this.sessionCounter++;
    const sessionName = name || `Session-${this.sessionCounter}`;

    const { shell: shellCmd, args: shellArgs, shellType } = this.resolveShell(shell);
    const initialCwd = cwd || process.env.HOME || process.env.USERPROFILE || '/';
    const ptyProcess = pty.spawn(shellCmd, shellArgs, {
      name: config.pty.termName,
      cols: config.pty.defaultCols,
      rows: config.pty.defaultRows,
      cwd: initialCwd,
      env: process.env as { [key: string]: string },
      // Windows PTY backend (ConPTY vs winpty)
      useConpty: config.pty.useConpty,
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
      sseClients: new Set(),
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

      // If no SSE clients connected, buffer the output
      const sData = this.sessions.get(id);
      if (sData) {
        if (sData.sseClients.size === 0) {
          // Buffer output (limit size)
          sData.outputBuffer += data;
          if (sData.outputBuffer.length > this.MAX_BUFFER_SIZE) {
            sData.outputBuffer = sData.outputBuffer.slice(-this.MAX_BUFFER_SIZE);
          }
        } else {
          // Send to connected clients
          this.broadcast(id, 'output', { data });
        }
      }

      this.scheduleIdleTransition(id);
    });

    // Handle PTY exit
    ptyProcess.onExit(({ exitCode }) => {
      this.broadcast(id, 'error', { message: `Shell exited with code ${exitCode}` });
      // Clean up SSE clients
      const data = this.sessions.get(id);
      if (data) {
        data.sseClients.forEach(client => {
          client.end();
        });
      }
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
    }, this.IDLE_DELAY_MS);
  }

  private updateStatus(id: string, status: SessionStatus): void {
    const data = this.sessions.get(id);
    if (!data || data.session.status === status) return;

    data.session.status = status;
    data.session.lastActiveAt = new Date();
    this.broadcast(id, 'status', { status });
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

    // Clean up CWD tracking file
    if (data.cwdFilePath) {
      try { unlinkSync(data.cwdFilePath); } catch { /* ignore */ }
    }

    // Close all SSE clients
    data.sseClients.forEach(client => {
      client.end();
    });

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

  addSSEClient(id: string, res: Response): boolean {
    const data = this.sessions.get(id);
    if (!data) return false;

    data.sseClients.add(res);

    // Send buffered output first (initial prompt, etc.)
    if (data.outputBuffer.length > 0) {
      sendSSE(res, 'output', { data: data.outputBuffer });
      data.outputBuffer = ''; // Clear buffer after sending
    }

    // Send current status
    sendSSE(res, 'status', { status: data.session.status });

    return true;
  }

  removeSSEClient(id: string, res: Response): void {
    const data = this.sessions.get(id);
    if (data) {
      data.sseClients.delete(res);
    }
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
    const shellConfig = shellOverride || config.pty.shell || 'auto';

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
  }

  private broadcast(id: string, event: string, payload: object): void {
    const data = this.sessions.get(id);
    if (!data) return;

    data.sseClients.forEach(client => {
      sendSSE(client, event, payload);
    });
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
}

export const sessionManager = new SessionManager();
