// FR-ARCH-014: a program in a session can open a GUI editor on the server's
// desktop and wait for it to close -- Claude Code's Ctrl+G runs
// `start /wait notepad`, `git commit` opens the configured editor. From a phone
// the window is out of reach and the session simply looks frozen (measured
// 2026-10-21: 2.5 hours). This finds such an editor under a session's shell so
// the browser can say so and close it.

import type { ProcessInfo } from '../agentSession/agentSessionResolver.js';

/** Executable names of GUI editors, lower case (AC-1). */
const EDITOR_PROCESS_NAMES: ReadonlySet<string> = new Set([
  'notepad.exe',
  'notepad++.exe',
  'code.exe',
  'sublime_text.exe',
  'wordpad.exe',
  'write.exe',
  'gvim.exe',
  'gedit',
  'kate',
  'mousepad',
  'xed',
  'pluma',
]);

/** AC-5: at most one process-table read per this many milliseconds. */
export const EDITOR_WAIT_SCAN_INTERVAL_MS = 20_000;

export interface EditorWait {
  pid: number;
  name: string;
  startedAtMs: number | null;
}

export function isEditorProcessName(name: string): boolean {
  return EDITOR_PROCESS_NAMES.has(name.toLowerCase());
}

function descendantsOf(processes: readonly ProcessInfo[], rootPid: number): ProcessInfo[] {
  const children = new Map<number, ProcessInfo[]>();
  for (const process of processes) {
    if (process.pid === process.ppid) continue;
    const list = children.get(process.ppid);
    if (list) list.push(process);
    else children.set(process.ppid, [process]);
  }
  const out: ProcessInfo[] = [];
  // A reused pid can make a parent loop; never visit a pid twice.
  const seen = new Set<number>([rootPid]);
  const queue = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift()!;
    for (const child of children.get(pid) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      out.push(child);
      queue.push(child.pid);
    }
  }
  return out;
}

/** AC-1: the earliest GUI editor under the shell, or null. */
export function findEditorWait(processes: readonly ProcessInfo[], shellPid: number): EditorWait | null {
  let best: ProcessInfo | null = null;
  for (const process of descendantsOf(processes, shellPid)) {
    if (!isEditorProcessName(process.name)) continue;
    if (
      !best
      || (process.createdAtMs ?? Number.MAX_SAFE_INTEGER) < (best.createdAtMs ?? Number.MAX_SAFE_INTEGER)
      || (process.createdAtMs === best.createdAtMs && process.pid < best.pid)
    ) {
      best = process;
    }
  }
  return best ? { pid: best.pid, name: best.name, startedAtMs: best.createdAtMs ?? null } : null;
}

function sameWait(a: EditorWait | null, b: EditorWait | null): boolean {
  if (!a || !b) return a === b;
  return a.pid === b.pid && a.name === b.name && a.startedAtMs === b.startedAtMs;
}

export interface EditorWaitSession {
  sessionId: string;
  shellPid: number | null;
}

export interface EditorWaitMonitorOptions {
  listSessions: () => EditorWaitSession[];
  listProcesses: () => Promise<ProcessInfo[]>;
  onChange: (sessionId: string, wait: EditorWait | null) => void;
  intervalMs?: number;
  setInterval?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval?: (handle: ReturnType<typeof setInterval>) => void;
}

export class EditorWaitMonitor {
  private readonly waits = new Map<string, EditorWait>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;

  constructor(private readonly options: EditorWaitMonitorOptions) {}

  start(): void {
    if (this.timer) return;
    const schedule = this.options.setInterval ?? setInterval;
    this.timer = schedule(() => {
      void this.tick();
    }, this.options.intervalMs ?? EDITOR_WAIT_SCAN_INTERVAL_MS);
    // A scheduler that only polls must not keep the process alive.
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    (this.options.clearInterval ?? clearInterval)(this.timer);
    this.timer = null;
  }

  get(sessionId: string): EditorWait | null {
    return this.waits.get(sessionId) ?? null;
  }

  /** AC-4: the editor was closed on request; report it now rather than at the next scan. */
  markClosed(sessionId: string, pid: number): void {
    if (this.waits.get(sessionId)?.pid !== pid) return;
    this.waits.delete(sessionId);
    this.options.onChange(sessionId, null);
  }

  private tick(): Promise<void> {
    // AC-5: a scan still running is not started again.
    if (this.inFlight) return this.inFlight;
    if (this.options.listSessions().length === 0) return Promise.resolve();
    return this.scanOnce();
  }

  scanOnce(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.scan().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async scan(): Promise<void> {
    let processes: ProcessInfo[];
    try {
      processes = await this.options.listProcesses();
    } catch {
      // AC-6: keep what was known; the next scan tries again.
      return;
    }
    const sessions = this.options.listSessions();
    const live = new Set(sessions.map(session => session.sessionId));
    for (const sessionId of [...this.waits.keys()]) {
      if (!live.has(sessionId)) this.waits.delete(sessionId);
    }
    for (const session of sessions) {
      const next = session.shellPid === null ? null : findEditorWait(processes, session.shellPid);
      const previous = this.get(session.sessionId);
      if (sameWait(previous, next)) continue;
      if (next) this.waits.set(session.sessionId, next);
      else this.waits.delete(session.sessionId);
      this.options.onChange(session.sessionId, next);
    }
  }
}

export type CloseEditorWaitCode = 'EDITOR_WAIT_NOT_FOUND' | 'EDITOR_WAIT_MISMATCH' | 'EDITOR_WAIT_GONE';

export type CloseEditorWaitResult = { ok: true } | { ok: false; code: CloseEditorWaitCode };

/**
 * AC-4: ends the one editor process the browser was shown, after checking from
 * a fresh process table that the pid still names that process under the
 * session's shell. Never a process tree.
 */
export async function closeEditorWait(args: {
  current: EditorWait | null;
  requestedPid: number;
  shellPid: number | null;
  listProcesses: () => Promise<ProcessInfo[]>;
  kill: (pid: number) => void;
}): Promise<CloseEditorWaitResult> {
  const { current, requestedPid, shellPid } = args;
  if (!current) return { ok: false, code: 'EDITOR_WAIT_NOT_FOUND' };
  if (current.pid !== requestedPid) return { ok: false, code: 'EDITOR_WAIT_MISMATCH' };
  if (shellPid === null) return { ok: false, code: 'EDITOR_WAIT_GONE' };

  const processes = await args.listProcesses();
  const fresh = descendantsOf(processes, shellPid).find(process => process.pid === current.pid);
  if (
    !fresh
    || fresh.name !== current.name
    || (fresh.createdAtMs ?? null) !== current.startedAtMs
  ) {
    return { ok: false, code: 'EDITOR_WAIT_GONE' };
  }
  try {
    args.kill(current.pid);
  } catch (error) {
    // It ended on its own between the check and the kill.
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return { ok: false, code: 'EDITOR_WAIT_GONE' };
    throw error;
  }
  return { ok: true };
}
