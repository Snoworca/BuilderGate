// FR-AITUI-006 — the running agent's current session id, read from the records
// the agent keeps for itself. Nothing here sends input to an agent or stops it.
//
// Every record layout below was measured on 2026-09-26 (Claude Code 2.1.281,
// Codex CLI 0.157, OpenCode 1.3.13, Hermes Agent 0.21.5). They are internal
// formats, so every reader fails soft: an unreadable record is "not found",
// never an error the save has to handle.

import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import path from 'node:path';

export type AgentKind = 'claude' | 'codex' | 'hermes' | 'opencode';
export const AGENT_KINDS: readonly AgentKind[] = ['claude', 'codex', 'hermes', 'opencode'];
export type ResolveConfidence = 'exact' | 'estimated';

export interface AgentRoots {
  claudeHome: string;
  codexHome: string;
  opencodeData: string;
  hermesHome: string;
}

export interface ProcessInfo {
  pid: number;
  ppid: number;
  name: string;
  createdAtMs?: number;
  commandLine?: string;
}

export interface AgentOutputHint {
  agent: AgentKind;
  sessionId: string;
  source: string;
  atMs: number;
}

export interface TabAgentContext {
  tabId: string;
  cwd: string | null;
  /** What BuilderGate already believes runs there (foreground app hint). */
  agent: AgentKind | null;
  /** When the agent command was submitted in the tab. */
  agentStartedAtMs?: number;
  ptyPid?: number | null;
  outputHint?: AgentOutputHint | null;
  recoveryCommand?: string | null;
}

export interface ResolvedAgentSession {
  agent: AgentKind;
  sessionId: string;
  method: string;
  confidence: ResolveConfidence;
}

export interface ResolveEnv {
  roots: AgentRoots;
  processes?: ProcessInfo[];
  isPidAlive?: (pid: number) => boolean;
  isFileLocked?: (filePath: string) => boolean;
  claimedSessionIds?: ReadonlySet<string>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLAUDE_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,63}$/u;
const HERMES_ID = /^\d{8}_\d{6}_[0-9a-f]{6}$/;
const OPENCODE_ID = /^ses_[0-9A-Za-z]{26}$/;

/** FR-AITUI-006 AC-7: only ids of the agent's own shape ever reach a shell. */
export function isValidAgentSessionId(agent: AgentKind, id: string): boolean {
  if (typeof id !== 'string' || id.length === 0 || id.length > 128) return false;
  switch (agent) {
    case 'claude':
      return UUID.test(id) || CLAUDE_NAME.test(id);
    case 'codex':
      return UUID.test(id);
    case 'hermes':
      return HERMES_ID.test(id);
    case 'opencode':
      return OPENCODE_ID.test(id);
    default:
      return false;
  }
}

/** Compares a tab's cwd with the one an agent recorded. */
export function normalizeCwdForCompare(cwd: string): string {
  let value = cwd.trim();
  if (value.startsWith('\\\\?\\')) value = value.slice(4);
  value = value.replace(/\\/g, '/');
  if (value.length > 1) value = value.replace(/\/+$/, '');
  if (/^[a-zA-Z]:/.test(value) || value.startsWith('//')) value = value.toLowerCase();
  return value;
}

function sameCwd(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return normalizeCwdForCompare(a) === normalizeCwdForCompare(b);
}

export function descendantsOf(rootPid: number, processes: readonly ProcessInfo[]): ProcessInfo[] {
  const byParent = new Map<number, ProcessInfo[]>();
  for (const proc of processes) {
    const list = byParent.get(proc.ppid);
    if (list) list.push(proc);
    else byParent.set(proc.ppid, [proc]);
  }
  const out: ProcessInfo[] = [];
  const seen = new Set<number>([rootPid]);
  const queue = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift() as number;
    for (const child of byParent.get(pid) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      out.push(child);
      queue.push(child.pid);
    }
  }
  return out;
}

function exeName(name: string): string {
  return path.basename(name.replace(/\\/g, '/')).replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
}

/** The agent in a PTY's process tree: native executables first, then wrappers. */
export function detectAgentFromProcesses(processes: readonly ProcessInfo[]): { agent: AgentKind; process: ProcessInfo } | null {
  for (const proc of processes) {
    const name = exeName(proc.name);
    if (name === 'claude') return { agent: 'claude', process: proc };
    if (name === 'codex') return { agent: 'codex', process: proc };
    if (name === 'opencode') return { agent: 'opencode', process: proc };
    if (name === 'hermes') return { agent: 'hermes', process: proc };
  }
  for (const proc of processes) {
    const cmd = (proc.commandLine ?? '').toLowerCase().replace(/\\/g, '/');
    if (!cmd) continue;
    if (/@anthropic-ai\/claude-code|\/claude(\.exe)?(\s|$)/.test(cmd)) return { agent: 'claude', process: proc };
    if (/@openai\/codex|\/codex(\.js|\.exe)?(\s|$)/.test(cmd)) return { agent: 'codex', process: proc };
    if (/opencode/.test(cmd)) return { agent: 'opencode', process: proc };
    if (/hermes/.test(cmd)) return { agent: 'hermes', process: proc };
  }
  return null;
}

export function agentFromCommand(command: string | null | undefined): AgentKind | null {
  if (!command) return null;
  const name = exeName(command.trim().split(/\s+/)[0] ?? '');
  if (name.includes('opencode')) return 'opencode';
  if (name.includes('claude')) return 'claude';
  if (name.includes('codex')) return 'codex';
  if (name.includes('hermes')) return 'hermes';
  return null;
}

function defaultIsPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Codex holds each open thread's lock file exclusively; on Windows a read of a held one fails. */
function defaultIsFileLocked(filePath: string): boolean {
  if (process.platform !== 'win32') return true;
  let fd: number | null = null;
  try {
    fd = openSync(filePath, 'r');
    readSync(fd, Buffer.alloc(1), 0, 1, 0);
    return false;
  } catch {
    return true;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function readHead(filePath: string, bytes: number): string {
  let fd: number | null = null;
  try {
    fd = openSync(filePath, 'r');
    const buffer = Buffer.alloc(bytes);
    const read = readSync(fd, buffer, 0, bytes, 0);
    return buffer.subarray(0, read).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

function readTail(filePath: string, bytes: number): string {
  let fd: number | null = null;
  try {
    const size = statSync(filePath).size;
    const start = Math.max(0, size - bytes);
    fd = openSync(filePath, 'r');
    const buffer = Buffer.alloc(size - start);
    const read = readSync(fd, buffer, 0, buffer.length, start);
    return buffer.subarray(0, read).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

function pickNearest<T>(items: T[], at: (item: T) => number, anchor: number | undefined): T {
  if (anchor === undefined) {
    return items.reduce((best, item) => (at(item) > at(best) ? item : best));
  }
  return items.reduce((best, item) => (Math.abs(at(item) - anchor) < Math.abs(at(best) - anchor) ? item : best));
}

// ---------------------------------------------------------------------------
// Claude Code: <home>/sessions/<pid>.json, rewritten on every session switch
// and removed when the process exits.
// ---------------------------------------------------------------------------

interface ClaudeEntry { pid: number; sessionId: string; cwd: string; startedAt: number }

function readClaudeEntries(roots: AgentRoots): ClaudeEntry[] {
  const dir = path.join(roots.claudeHome, 'sessions');
  const out: ClaudeEntry[] = [];
  for (const file of safeReaddir(dir)) {
    if (!/^\d+\.json$/.test(file)) continue;
    try {
      const data = JSON.parse(readFileSync(path.join(dir, file), 'utf8')) as Partial<ClaudeEntry>;
      if (typeof data.pid === 'number' && typeof data.sessionId === 'string') {
        out.push({ pid: data.pid, sessionId: data.sessionId, cwd: String(data.cwd ?? ''), startedAt: Number(data.startedAt ?? 0) });
      }
    } catch { /* partly written or foreign file */ }
  }
  return out;
}

function resolveClaude(ctx: TabAgentContext, env: ResolveEnv, treePids: ReadonlySet<number> | null): ResolvedAgentSession | null {
  const isAlive = env.isPidAlive ?? defaultIsPidAlive;
  const claimed = env.claimedSessionIds ?? new Set<string>();
  const entries = readClaudeEntries(env.roots).filter((entry) => isValidAgentSessionId('claude', entry.sessionId));
  if (treePids) {
    const inTree = entries.find((entry) => treePids.has(entry.pid));
    if (inTree) return { agent: 'claude', sessionId: inTree.sessionId, method: 'claude-pid-file', confidence: 'exact' };
  }
  const live = entries.filter((entry) => !claimed.has(entry.sessionId) && isAlive(entry.pid));
  const inCwd = live.filter((entry) => sameCwd(entry.cwd, ctx.cwd));
  if (inCwd.length === 0) return null;
  if (inCwd.length === 1) return { agent: 'claude', sessionId: inCwd[0].sessionId, method: 'claude-pid-file', confidence: 'exact' };
  const anchor = ctx.agentStartedAtMs;
  const afterLaunch = anchor === undefined ? inCwd : inCwd.filter((entry) => entry.startedAt >= anchor - 2000);
  const pool = afterLaunch.length > 0 ? afterLaunch : inCwd;
  const best = pickNearest(pool, (entry) => entry.startedAt, anchor);
  return { agent: 'claude', sessionId: best.sessionId, method: 'claude-pid-file', confidence: 'estimated' };
}

// ---------------------------------------------------------------------------
// Codex: <home>/thread-writer-locks/<thread>.lock is held while the thread is
// open; the thread's rollout starts with a session_meta line carrying its cwd.
// ---------------------------------------------------------------------------

interface CodexThread {
  id: string;
  cwd: string;
  createdAt: number;
  /** 'cli' for a terminal launch; 'vscode' and others come from editor integrations. */
  source?: string;
}

function indexCodexRollouts(codexHome: string, wanted: ReadonlySet<string>): Map<string, string> {
  const found = new Map<string, string>();
  const root = path.join(codexHome, 'sessions');
  const years = safeReaddir(root).filter((name) => /^\d{4}$/.test(name)).sort().reverse();
  for (const year of years) {
    for (const month of safeReaddir(path.join(root, year)).sort().reverse()) {
      for (const day of safeReaddir(path.join(root, year, month)).sort().reverse()) {
        for (const file of safeReaddir(path.join(root, year, month, day))) {
          const match = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(file);
          if (match && wanted.has(match[1]) && !found.has(match[1])) {
            found.set(match[1], path.join(root, year, month, day, file));
          }
        }
        if (found.size === wanted.size) return found;
      }
    }
  }
  return found;
}

function readCodexThread(id: string, rolloutPath: string): CodexThread | null {
  const head = readHead(rolloutPath, 64 * 1024);
  const firstLine = head.split('\n', 1)[0] ?? '';
  try {
    const record = JSON.parse(firstLine) as {
      timestamp?: string;
      payload?: { cwd?: string; timestamp?: string; parent_thread_id?: unknown; source?: unknown };
    };
    const cwd = record.payload?.cwd;
    if (typeof cwd !== 'string') return null;
    // FR-AITUI-006: a subagent's thread (spawned by a session, locked in the same cwd) is not
    // a session to resume on its own; counting it turned the parent into a guess.
    const source = record.payload?.source;
    const isSubagent = typeof record.payload?.parent_thread_id === 'string'
      || (typeof source === 'object' && source !== null && 'subagent' in source);
    if (isSubagent) return null;
    const createdAt = Date.parse(record.payload?.timestamp ?? record.timestamp ?? '') || 0;
    return { id, cwd, createdAt, ...(typeof source === 'string' ? { source } : {}) };
  } catch {
    return null;
  }
}

function resolveCodex(ctx: TabAgentContext, env: ResolveEnv): ResolvedAgentSession | null {
  const isLocked = env.isFileLocked ?? defaultIsFileLocked;
  const claimed = env.claimedSessionIds ?? new Set<string>();
  const lockDir = path.join(env.roots.codexHome, 'thread-writer-locks');
  const liveIds = safeReaddir(lockDir)
    .map((file) => /^([0-9a-f-]{36})\.lock$/i.exec(file)?.[1])
    .filter((id): id is string => typeof id === 'string' && UUID.test(id) && !claimed.has(id))
    .filter((id) => isLocked(path.join(lockDir, `${id}.lock`)));
  if (liveIds.length === 0) return null;
  const rollouts = indexCodexRollouts(env.roots.codexHome, new Set(liveIds));
  const threads = liveIds
    .map((id) => (rollouts.has(id) ? readCodexThread(id, rollouts.get(id) as string) : null))
    .filter((thread): thread is CodexThread => thread !== null);
  const sameDir = threads.filter((thread) => sameCwd(thread.cwd, ctx.cwd));
  // A BuilderGate tab is a terminal: when a terminal-launched thread is there, an editor
  // integration's thread in the same folder (source 'vscode') is not this tab's.
  const fromTerminal = sameDir.filter((thread) => thread.source === 'cli');
  const inCwd = fromTerminal.length > 0 ? fromTerminal : sameDir;
  if (inCwd.length === 0) return null;
  if (inCwd.length === 1) return { agent: 'codex', sessionId: inCwd[0].id, method: 'codex-writer-lock', confidence: 'exact' };
  const best = pickNearest(inCwd, (thread) => thread.createdAt, ctx.agentStartedAtMs);
  return { agent: 'codex', sessionId: best.id, method: 'codex-writer-lock', confidence: 'estimated' };
}

// ---------------------------------------------------------------------------
// OpenCode: one log per process, named by its UTC start; every prompt writes a
// `service=session.prompt session.id=ses_…` (or `sessionID=`) line.
// ---------------------------------------------------------------------------

function parseOpencodeLogStart(file: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})(\d{2})\.log$/.exec(file);
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
}

const OPENCODE_PROMPT = /service=session\.prompt\b[^\n]*?\b(?:session\.id|sessionID)=(ses_[0-9A-Za-z]{26})/g;

function resolveOpenCode(ctx: TabAgentContext, env: ResolveEnv, agentProcess: ProcessInfo | null): ResolvedAgentSession | null {
  const anchor = agentProcess?.createdAtMs ?? ctx.agentStartedAtMs;
  if (anchor === undefined) return null;
  const exact = agentProcess?.createdAtMs !== undefined;
  const dir = path.join(env.roots.opencodeData, 'log');
  const logs = safeReaddir(dir)
    .map((file) => ({ file, start: parseOpencodeLogStart(file) }))
    .filter((log): log is { file: string; start: number } => log.start !== null && Math.abs(log.start - anchor) <= 60_000);
  if (logs.length === 0) return null;
  const log = pickNearest(logs, (item) => item.start, anchor);
  const text = readTail(path.join(dir, log.file), 2 * 1024 * 1024);
  let last: string | null = null;
  for (const match of text.matchAll(OPENCODE_PROMPT)) last = match[1];
  if (!last || (env.claimedSessionIds?.has(last) ?? false)) return null;
  return { agent: 'opencode', sessionId: last, method: 'opencode-process-log', confidence: exact ? 'exact' : 'estimated' };
}

// ---------------------------------------------------------------------------
// Hermes: no per-process record. The session id shows on screen (banner,
// resume line, exit hint) and v0.21's state.db records each session's cwd.
// ---------------------------------------------------------------------------

// node:sqlite ships with Node 22.5+; the installed @types/node predates it, so
// the module is loaded by name with just the surface used here.
interface SqliteModule {
  DatabaseSync: new (file: string, options?: { readOnly?: boolean }) => {
    prepare(sql: string): { get(...params: unknown[]): unknown };
    close(): void;
  };
}

async function loadSqlite(): Promise<SqliteModule | null> {
  try {
    const name = 'node:sqlite';
    return (await import(name)) as SqliteModule;
  } catch {
    return null;
  }
}

async function resolveHermes(ctx: TabAgentContext, env: ResolveEnv): Promise<ResolvedAgentSession | null> {
  const hint = ctx.outputHint;
  if (hint && hint.agent === 'hermes' && isValidAgentSessionId('hermes', hint.sessionId)) {
    return { agent: 'hermes', sessionId: hint.sessionId, method: hint.source, confidence: 'estimated' };
  }
  if (!ctx.cwd) return null;
  try {
    const sqlite = await loadSqlite();
    if (!sqlite) return null;
    const db = new sqlite.DatabaseSync(path.join(env.roots.hermesHome, 'state.db'), { readOnly: true });
    try {
      const row = db.prepare(
        "SELECT id FROM sessions WHERE source = 'cli' AND cwd = ? ORDER BY COALESCE(last_activity_at, started_at) DESC LIMIT 1",
      ).get(ctx.cwd) as { id?: string } | undefined;
      const id = row?.id;
      if (typeof id === 'string' && isValidAgentSessionId('hermes', id) && !(env.claimedSessionIds?.has(id) ?? false)) {
        return { agent: 'hermes', sessionId: id, method: 'hermes-state-db', confidence: 'estimated' };
      }
    } finally {
      db.close();
    }
  } catch { /* no db, old schema without cwd, or no node:sqlite */ }
  return null;
}

// ---------------------------------------------------------------------------
// FR-AITUI-013 AC-1: the other live sessions in a folder, for the user to pick
// from when the answer above is a guess or missing. Claude and Codex keep a
// per-session live record; Hermes and OpenCode do not, so they offer none.
// ---------------------------------------------------------------------------

export interface AgentSessionCandidate {
  sessionId: string;
  startedAtMs: number;
}

const MAX_CANDIDATES = 5;

export function listAgentSessionCandidates(agent: AgentKind, cwd: string | null, env: ResolveEnv): AgentSessionCandidate[] {
  if (!cwd) return [];
  try {
    if (agent === 'claude') {
      const isAlive = env.isPidAlive ?? defaultIsPidAlive;
      return readClaudeEntries(env.roots)
        .filter((entry) => isValidAgentSessionId('claude', entry.sessionId) && sameCwd(entry.cwd, cwd) && isAlive(entry.pid))
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(0, MAX_CANDIDATES)
        .map((entry) => ({ sessionId: entry.sessionId, startedAtMs: entry.startedAt }));
    }
    if (agent === 'codex') {
      const isLocked = env.isFileLocked ?? defaultIsFileLocked;
      const lockDir = path.join(env.roots.codexHome, 'thread-writer-locks');
      const liveIds = safeReaddir(lockDir)
        .map((file) => /^([0-9a-f-]{36})\.lock$/i.exec(file)?.[1])
        .filter((id): id is string => typeof id === 'string' && UUID.test(id))
        .filter((id) => isLocked(path.join(lockDir, `${id}.lock`)));
      if (liveIds.length === 0) return [];
      const rollouts = indexCodexRollouts(env.roots.codexHome, new Set(liveIds));
      return liveIds
        .map((id) => (rollouts.has(id) ? readCodexThread(id, rollouts.get(id) as string) : null))
        .filter((thread): thread is CodexThread => thread !== null && sameCwd(thread.cwd, cwd))
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, MAX_CANDIDATES)
        .map((thread) => ({ sessionId: thread.id, startedAtMs: thread.createdAt }));
    }
  } catch { /* unreadable roots: no candidates */ }
  return [];
}

// ---------------------------------------------------------------------------

export async function resolveAgentSession(ctx: TabAgentContext, env: ResolveEnv): Promise<ResolvedAgentSession | null> {
  const tree = typeof ctx.ptyPid === 'number' && env.processes ? descendantsOf(ctx.ptyPid, env.processes) : null;
  const detected = tree ? detectAgentFromProcesses(tree) : null;
  const agent = detected?.agent
    ?? ctx.agent
    ?? agentFromCommand(ctx.recoveryCommand)
    ?? ctx.outputHint?.agent
    ?? null;
  if (!agent) return null;
  const agentProcess = detected && detected.agent === agent ? detected.process : null;
  const treePids = tree ? new Set(tree.map((proc) => proc.pid)) : null;

  let result: ResolvedAgentSession | null = null;
  try {
    switch (agent) {
      case 'claude':
        result = resolveClaude(ctx, env, treePids);
        break;
      case 'codex':
        result = resolveCodex(ctx, env);
        break;
      case 'opencode':
        result = resolveOpenCode(ctx, env, agentProcess);
        break;
      case 'hermes':
        result = await resolveHermes(ctx, env);
        break;
    }
  } catch {
    result = null;
  }

  if (!result && ctx.outputHint && ctx.outputHint.agent === agent) {
    result = { agent, sessionId: ctx.outputHint.sessionId, method: ctx.outputHint.source, confidence: 'estimated' };
  }
  if (!result || !isValidAgentSessionId(result.agent, result.sessionId)) return null;
  return result;
}
