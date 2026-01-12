import * as pty from 'node-pty';
import { v4 as uuidv4 } from 'uuid';
import { Response } from 'express';
import { Session, SessionDTO, SessionStatus } from '../types/index.js';
import { sendSSE } from '../utils/sse.js';
import { config } from '../utils/config.js';

interface SessionData {
  session: Session;
  pty: pty.IPty;
  sseClients: Set<Response>;
  idleTimer: NodeJS.Timeout | null;
  outputBuffer: string; // Buffer for initial output
}

class SessionManager {
  private sessions: Map<string, SessionData> = new Map();
  private sessionCounter: number = 0;
  private readonly IDLE_DELAY_MS = config.session.idleDelayMs;
  private readonly MAX_BUFFER_SIZE = config.pty.maxBufferSize;

  createSession(name?: string): SessionDTO {
    const id = uuidv4();
    this.sessionCounter++;
    const sessionName = name || `Session-${this.sessionCounter}`;

    const shell = process.platform === 'win32' ? 'powershell.exe' : 'bash';
    const ptyProcess = pty.spawn(shell, [], {
      name: config.pty.termName,
      cols: config.pty.defaultCols,
      rows: config.pty.defaultRows,
      cwd: process.env.HOME || process.env.USERPROFILE || '/',
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
    };

    const sessionData: SessionData = {
      session,
      pty: ptyProcess,
      sseClients: new Set(),
      idleTimer: null,
      outputBuffer: '',
    };

    this.sessions.set(id, sessionData);

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
    };
  }
}

export const sessionManager = new SessionManager();
