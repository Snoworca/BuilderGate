// FR-AITUI-007 / FR-AITUI-008 / FR-AITUI-013 / FR-AITUI-014 — the saved sessions and resuming them.
// FR-AITUI-016 / FR-AITUI-017 / FR-AITUI-018 — auto save, the list of manual saves, restore by hand.
//
// A save reads every terminal's folder, running command and agent session id
// (FR-AITUI-006) without touching the agent and writes it down. A manual save
// (the save dialog) is added to a list under session-snapshots/; the auto save
// overwrites one file, session-autosave.json. When the server starts, the newer
// of the newest manual save and the auto save is restored: each saved tab comes
// back as a shell in its saved folder and, once the shell is ready, gets its
// resume command typed in without asking. Any save can also be restored by hand.

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  AGENT_KINDS,
  agentFromCommand,
  descendantsOf,
  detectAgentFromProcesses,
  isValidAgentSessionId,
  listAgentSessionCandidates,
  loadAgentStateCache,
  resolveAgentSession,
  type AgentKind,
  type AgentSessionCandidate,
  type AgentStateCache,
  type AgentOutputHint,
  type AgentRoots,
  type ProcessInfo,
  type ResolveConfidence,
  type ResolvedAgentSession,
  type TabAgentContext,
} from './agentSession/agentSessionResolver.js';
import { buildResumeCommand, stripSessionSelectors } from './agentSession/resumeCommand.js';
import {
  normalizeRecoveryExecutable,
  splitLaunchCommand,
  validateRecoveryArguments,
  validateRecoveryCommand,
} from '../utils/recoveryCommand.js';
import { AppError, ErrorCode } from '../utils/errors.js';

export type SnapshotRestoreState = 'pending' | 'restored' | 'skipped' | 'failed';
/** FR-AITUI-013 AC-4: resume an agent, type a command, or only reopen the shell. */
export type SnapshotMode = 'agent' | 'shell' | 'command';
/** FR-AITUI-016 / FR-AITUI-017: made by the save dialog, or by the timer. */
export type SnapshotOrigin = 'manual' | 'auto';

export interface SnapshotEntry {
  tabId: string;
  workspaceId: string;
  workspaceName: string;
  tabName: string;
  cwd: string | null;
  mode: SnapshotMode;
  /** The agent for an agent entry; null for the others. */
  agent: AgentKind | null;
  /** '' for an entry that is not an agent. */
  sessionId: string;
  method: string;
  confidence: ResolveConfidence | 'manual';
  /** '' for a shell entry. */
  resumeCommand: string;
  resumeArguments: string[];
  restore: SnapshotRestoreState;
  processedAt?: string;
  /** FR-AITUI-016 AC-3: what ran in a shell entry's tab; recorded, never typed at start. */
  runningCommand?: string;
}

/** FR-AITUI-013 AC-3: one tab's choice in the save dialog. */
export interface SnapshotSaveItem {
  tabId: string;
  mode: SnapshotMode;
  agent?: AgentKind | null;
  launcher?: string;
  args?: string[];
  sessionId?: string;
  command?: string;
}

export type LauncherMap = Record<AgentKind, string[]>;

export interface PreviewTab {
  tabId: string;
  workspaceId: string;
  workspaceName: string;
  tabName: string;
  cwd: string | null;
  runningCommand: string | null;
  agent: AgentKind | null;
  launcher: string | null;
  args: string[];
  sessionId: string | null;
  method: string | null;
  /** null for a tab with no agent. */
  confidence: ResolveConfidence | 'missing' | null;
  candidates: AgentSessionCandidate[];
}

export type RestoreResult = 'waiting' | 'confirmed' | 'unconfirmed' | 'typed' | 'shell' | 'failed';

/** FR-AITUI-014 AC-5: what one saved tab came back as after the restart. */
export interface RestoreReportItem {
  tabId: string;
  workspaceName: string;
  tabName: string;
  mode: SnapshotMode;
  agent: AgentKind | null;
  cwd: string | null;
  commandLine: string;
  /** For an agent entry, the parts the retry editor starts from. */
  launcher?: string;
  args?: string[];
  sessionId?: string;
  result: RestoreResult;
  reason?: string;
}

export interface SessionSnapshot {
  version: 1;
  /** FR-AITUI-017 AC-1: a manual save's own id; 'auto' for the auto save. */
  id?: string;
  origin?: SnapshotOrigin;
  savedAt: string;
  /** FR-AITUI-017 AC-4: when a server start last restored this save. */
  restoredAt?: string;
  entries: SnapshotEntry[];
}

/** FR-AITUI-017 AC-4: one line of the list. */
export interface SnapshotSummary {
  id: string;
  origin: SnapshotOrigin;
  savedAt: string;
  tabCount: number;
  agentCounts: Partial<Record<AgentKind, number>>;
  /** True for the save the last server start restored. */
  usedForRestore: boolean;
}

export type RestoreTarget = 'tab' | 'new-tab';
export type RestoreTargetReason = 'idle' | 'busy' | 'missing';

/** FR-AITUI-018 AC-6: where restoring this entry by hand would type its command. */
export interface PlannedEntry extends SnapshotEntry {
  target: RestoreTarget;
  targetReason: RestoreTargetReason;
}

/** FR-AITUI-018 AC-5: one entry the user picked in the restore tab. */
export interface HandRestoreItem {
  tabId: string;
  /** Type the shell entry's running command too. */
  includeCommand?: boolean;
}

export type AutoSaveResult = 'saved' | 'skipped' | 'deferred' | 'failed';

export interface AutoSaveConfig {
  enabled: boolean;
  intervalMinutes: number;
}

export interface SnapshotTabRecord {
  workspaceId: string;
  workspaceName: string;
  tab: {
    id: string;
    name: string;
    sessionId: string;
    lastCwd?: string;
    recoveryCommand?: string;
    recoveryArguments?: string[];
  };
}

export interface SnapshotTabRuntime {
  foregroundAppId: AgentKind | null;
  foregroundStartedAt?: number;
  ptyPid?: number | null;
  outputHint?: AgentOutputHint | null;
  cwd?: string | null;
  /** FR-AITUI-011 AC-4: the command line the agent was launched with (alias and flags). */
  launchCommand?: string | null;
  /** FR-AITUI-013 AC-1: the last command submitted while the shell is not back at its prompt. */
  runningCommand?: string | null;
}

export interface AgentTabCandidate {
  tabId: string;
  workspaceId: string;
  workspaceName: string;
  tabName: string;
  cwd: string | null;
  agent: AgentKind;
}

export interface SaveResultItem {
  tabId: string;
  tabName: string;
  workspaceName: string;
  agent: AgentKind | null;
  status: 'found' | 'not-found';
  sessionId?: string;
  confidence?: ResolveConfidence;
  method?: string;
}

export interface SessionSnapshotDeps {
  /**
   * The snapshot file from before the list (FR-AITUI-017 AC-6). Its folder holds
   * every save file: session-snapshots/, session-autosave.json and session-restore-state.json.
   */
  dataPath?: string;
  listTabs: () => SnapshotTabRecord[];
  getRuntime: (sessionId: string) => SnapshotTabRuntime | null;
  scheduleResume: (tabId: string, command: string, args: string[]) => boolean;
  /**
   * FR-AITUI-018 AC-6: opens a tab in the saved workspace, or in `fallbackWorkspaceId` (the
   * client's active one) when that is gone, in the saved folder; the new tab's id, or null.
   */
  addTab?: (workspaceId: string, name: string, cwd: string | null, fallbackWorkspaceId?: string | null) => Promise<string | null>;
  listProcesses?: () => Promise<ProcessInfo[]>;
  rootsFor?: (cwd: string | null) => Promise<AgentRoots>;
  /** FR-AITUI-013 AC-2: the commands each agent may be launched with (Tools › Agent commands). */
  listLaunchers?: () => LauncherMap;
  isPidAlive?: (pid: number) => boolean;
  isFileLocked?: (filePath: string) => boolean;
  /** FR-AITUI-019 AC-1: how many manual saves are kept. */
  retention?: () => number;
  /** FR-AITUI-014 AC-4: how long a resumed agent has to appear in its tab. */
  confirmTimeoutMs?: number;
  confirmPollMs?: number;
  /** One minute of the auto save interval; tests shorten it. */
  minuteMs?: number;
  now?: () => Date;
}

const DEFAULT_DATA_PATH = './data/session-snapshot.json';
const MANUAL_DIR = 'session-snapshots';
const AUTO_FILE = 'session-autosave.json';
const RESTORE_STATE_FILE = 'session-restore-state.json';
const AUTO_ID = 'auto';
const DEFAULT_RETENTION = 10;
const DEFAULT_CONFIRM_TIMEOUT_MS = 20_000;
const DEFAULT_CONFIRM_POLL_MS = 2_000;
const MAX_COMMAND_LINE_LENGTH = 2000;
const MANUAL_ID = /^[A-Za-z0-9-]{1,80}$/;

export const DEFAULT_LAUNCHERS: LauncherMap = {
  claude: ['claude', 'claude-code'],
  codex: ['codex'],
  hermes: ['hermes'],
  opencode: ['opencode'],
};

function isMode(value: unknown): value is SnapshotMode {
  return value === 'agent' || value === 'shell' || value === 'command';
}

function commandLineOf(command: string, args: readonly string[]): string {
  return [command, ...args].map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)).join(' ');
}

/** A submitted line as the user reads it: the quoting the shell needed is not shown. */
function displayCommand(line: string | null): string | null {
  if (!line) return null;
  const split = splitLaunchCommand(line);
  return split ? commandLineOf(split.command, split.args) : line;
}

function isAgentKind(value: unknown): value is AgentKind {
  return typeof value === 'string' && (AGENT_KINDS as readonly string[]).includes(value);
}

function sanitizeEntry(raw: unknown): SnapshotEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Record<string, unknown>;
  if (typeof e.tabId !== 'string') return null;
  // FR-AITUI-013 AC-6: an entry written before modes existed is an agent entry.
  const mode: SnapshotMode = isMode(e.mode) ? e.mode : 'agent';
  if (typeof e.resumeCommand !== 'string' || !Array.isArray(e.resumeArguments) || e.resumeArguments.some((a) => typeof a !== 'string')) return null;
  let agent: AgentKind | null = null;
  let sessionId = '';
  if (mode === 'agent') {
    if (!isAgentKind(e.agent) || typeof e.sessionId !== 'string' || !isValidAgentSessionId(e.agent, e.sessionId)) return null;
    agent = e.agent;
    sessionId = e.sessionId;
  }
  if (mode !== 'shell' && e.resumeCommand.length === 0) return null;
  const restore: SnapshotRestoreState = e.restore === 'restored' || e.restore === 'skipped' || e.restore === 'failed' ? e.restore : 'pending';
  const running = mode === 'shell' && typeof e.runningCommand === 'string' && e.runningCommand.length > 0
    && e.runningCommand.length <= MAX_COMMAND_LINE_LENGTH && !/[\x00-\x1F\x7F]/.test(e.runningCommand)
    ? e.runningCommand
    : null;
  return {
    tabId: e.tabId,
    workspaceId: String(e.workspaceId ?? ''),
    workspaceName: String(e.workspaceName ?? ''),
    tabName: String(e.tabName ?? ''),
    cwd: typeof e.cwd === 'string' ? e.cwd : null,
    mode,
    agent,
    sessionId,
    method: String(e.method ?? ''),
    confidence: e.confidence === 'exact' ? 'exact' : e.confidence === 'manual' ? 'manual' : 'estimated',
    resumeCommand: mode === 'shell' ? '' : e.resumeCommand,
    resumeArguments: mode === 'shell' ? [] : e.resumeArguments as string[],
    restore,
    ...(typeof e.processedAt === 'string' ? { processedAt: e.processedAt } : {}),
    ...(running ? { runningCommand: running } : {}),
  };
}

/** A save file as read from disk; null when it is not one. */
function sanitizeSnapshot(raw: unknown, origin: SnapshotOrigin, fallbackId: string): SessionSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const parsed = raw as Partial<SessionSnapshot>;
  const savedAt = String(parsed.savedAt ?? '');
  if (Number.isNaN(Date.parse(savedAt))) return null;
  const entries = Array.isArray(parsed.entries)
    ? parsed.entries.map(sanitizeEntry).filter((entry): entry is SnapshotEntry => entry !== null)
    : [];
  const id = origin === 'auto' ? AUTO_ID : (typeof parsed.id === 'string' && MANUAL_ID.test(parsed.id) ? parsed.id : fallbackId);
  return {
    version: 1,
    id,
    origin,
    savedAt,
    ...(typeof parsed.restoredAt === 'string' ? { restoredAt: parsed.restoredAt } : {}),
    entries,
  };
}

function newManualId(savedAt: string): string {
  return `${savedAt.replace(/[-:.]/g, '').replace('T', 't').replace('Z', 'z')}-${randomUUID().slice(0, 8)}`;
}

function timeOf(snapshot: SessionSnapshot): number {
  return Date.parse(snapshot.savedAt) || 0;
}

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/** FR-AITUI-016 AC-7 / FR-AITUI-017 AC-2: a temporary file, then a rename; 0600. */
async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  try {
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(tmp, filePath);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

class EntryError extends Error {}

export class SessionSnapshotService {
  private readonly legacyPath: string;
  private readonly dataDir: string;
  private readonly manualDir: string;
  private readonly autoPath: string;
  private readonly restoreStatePath: string;
  /** FR-AITUI-017: newest first. */
  private manual: SessionSnapshot[] = [];
  private auto: SessionSnapshot | null = null;
  /** FR-AITUI-018 AC-1: the save this server start restores, chosen when it loads. */
  private restoreSource: SessionSnapshot | null = null;
  private restoreSourceDone = false;
  /** FR-AITUI-014 AC-5: what this server run's automatic resume did. */
  private report: RestoreReportItem[] = [];
  /**
   * FR-AITUI-015 AC-7: names this run's report, so a client that dismissed it can tell
   * it apart from the next restart's. Not a time: two restores can share a timestamp.
   */
  private reportId: string | null = null;
  private reportSource: { origin: SnapshotOrigin; id: string; savedAt: string } | null = null;
  /** FR-AITUI-018 AC-3: the report whose notice a client already showed. */
  private noticeShownReportId: string | null = null;
  /** FR-AITUI-014 AC-4: resumed agents still being looked for, by tab. */
  private readonly waiting = new Map<string, { agent: AgentKind; deadline: number }>();
  private watchTimer: NodeJS.Timeout | null = null;
  /** FR-AITUI-016 AC-6: one auto save at a time. */
  private autoSaving = false;
  private autoSaveStatus: { lastAt: string | null; lastResult: AutoSaveResult | null } = { lastAt: null, lastResult: null };
  private autoSaveConfig: AutoSaveConfig = { enabled: false, intervalMinutes: 5 };
  private autoSaveTimer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: SessionSnapshotDeps) {
    this.legacyPath = path.resolve(deps.dataPath ?? DEFAULT_DATA_PATH);
    this.dataDir = path.dirname(this.legacyPath);
    this.manualDir = path.join(this.dataDir, MANUAL_DIR);
    this.autoPath = path.join(this.dataDir, AUTO_FILE);
    this.restoreStatePath = path.join(this.dataDir, RESTORE_STATE_FILE);
  }

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  // --------------------------------------------------------------------------
  // Loading
  // --------------------------------------------------------------------------

  private readJson(filePath: string): unknown {
    try {
      return JSON.parse(readFileSync(filePath, 'utf8'));
    } catch (error) {
      console.warn('[SessionSnapshot] Unreadable save set aside:', filePath, error instanceof Error ? error.message : error);
      try {
        renameSync(filePath, `${filePath}.corrupt-${Date.now()}`);
      } catch { /* leave it */ }
      return null;
    }
  }

  async initialize(): Promise<void> {
    this.manual = [];
    this.auto = null;
    this.report = [];
    this.reportId = null;
    this.reportSource = null;
    this.restoreSource = null;
    this.restoreSourceDone = false;

    if (existsSync(this.manualDir)) {
      for (const name of readdirSync(this.manualDir)) {
        if (!name.endsWith('.json')) continue;
        const raw = this.readJson(path.join(this.manualDir, name));
        const snapshot = raw === null ? null : sanitizeSnapshot(raw, 'manual', name.slice(0, -5));
        if (snapshot) this.manual.push(snapshot);
      }
    }
    // FR-AITUI-017 AC-6: the one snapshot file from before the list joins it.
    if (existsSync(this.legacyPath)) {
      const raw = this.readJson(this.legacyPath);
      const migrated = raw === null ? null : sanitizeSnapshot(raw, 'manual', '');
      if (migrated) {
        migrated.id = newManualId(migrated.savedAt);
        try {
          mkdirSync(this.manualDir, { recursive: true });
          await writeJsonAtomic(path.join(this.manualDir, `${migrated.id}.json`), migrated);
          renameSync(this.legacyPath, `${this.legacyPath}.migrated`);
          this.manual.push(migrated);
        } catch (error) {
          console.warn('[SessionSnapshot] Could not move the old snapshot into the list:', error instanceof Error ? error.message : error);
        }
      }
    }
    this.manual.sort((a, b) => timeOf(b) - timeOf(a));

    if (existsSync(this.autoPath)) {
      const raw = this.readJson(this.autoPath);
      this.auto = raw === null ? null : sanitizeSnapshot(raw, 'auto', AUTO_ID);
    }
    if (existsSync(this.restoreStatePath)) {
      const raw = this.readJson(this.restoreStatePath) as { noticeShownReportId?: unknown } | null;
      this.noticeShownReportId = typeof raw?.noticeShownReportId === 'string' ? raw.noticeShownReportId : null;
    }

    // FR-AITUI-018 AC-1: the newer of the newest manual save and the auto save; a tie goes to the manual one.
    const newestManual = this.manual[0] ?? null;
    if (newestManual && this.auto) {
      this.restoreSource = timeOf(newestManual) >= timeOf(this.auto) ? newestManual : this.auto;
    } else {
      this.restoreSource = newestManual ?? this.auto;
    }
  }

  private agentOf(record: SnapshotTabRecord, runtime: SnapshotTabRuntime | null): AgentKind | null {
    return runtime?.foregroundAppId ?? agentFromCommand(record.tab.recoveryCommand);
  }

  getCandidates(): AgentTabCandidate[] {
    const out: AgentTabCandidate[] = [];
    for (const record of this.deps.listTabs()) {
      const runtime = this.deps.getRuntime(record.tab.sessionId);
      const agent = this.agentOf(record, runtime);
      if (!agent) continue;
      out.push({
        tabId: record.tab.id,
        workspaceId: record.workspaceId,
        workspaceName: record.workspaceName,
        tabName: record.tab.name,
        cwd: runtime?.cwd ?? record.tab.lastCwd ?? null,
        agent,
      });
    }
    return out;
  }

  private async processList(): Promise<ProcessInfo[] | undefined> {
    if (!this.deps.listProcesses) return undefined;
    try {
      return await this.deps.listProcesses();
    } catch (error) {
      console.warn('[SessionSnapshot] Process list unavailable:', error instanceof Error ? error.message : error);
      return undefined;
    }
  }

  private contextOf(record: SnapshotTabRecord): TabAgentContext {
    const runtime = this.deps.getRuntime(record.tab.sessionId);
    return {
      tabId: record.tab.id,
      cwd: runtime?.cwd ?? record.tab.lastCwd ?? null,
      agent: runtime?.foregroundAppId ?? null,
      ...(runtime?.foregroundStartedAt !== undefined ? { agentStartedAtMs: runtime.foregroundStartedAt } : {}),
      ptyPid: runtime?.ptyPid ?? null,
      outputHint: runtime?.outputHint ?? null,
      recoveryCommand: record.tab.recoveryCommand ?? null,
    };
  }

  /**
   * Resolves every tab's session id; exact answers claim their ids before the guesses.
   * With `shared`, the agents' records are read once per set of roots, without blocking
   * (NFR-AITUI-001), and the event loop gets a turn between tabs.
   */
  private async resolveAll(
    records: SnapshotTabRecord[],
    processes: ProcessInfo[] | undefined,
    shared?: Map<string, AgentStateCache>,
  ): Promise<{ contexts: Array<{ record: SnapshotTabRecord; ctx: TabAgentContext }>; resolved: Map<string, ResolvedAgentSession | null> }> {
    const contexts = records.map((record) => ({ record, ctx: this.contextOf(record) }));
    const cacheFor = async (roots: AgentRoots): Promise<AgentStateCache | undefined> => {
      if (!shared) return undefined;
      const key = `${roots.claudeHome}\u0000${roots.codexHome}`;
      let cache = shared.get(key);
      if (!cache) {
        cache = await loadAgentStateCache(roots, this.deps.isFileLocked ? { isFileLocked: this.deps.isFileLocked } : {});
        shared.set(key, cache);
      }
      return cache;
    };
    const resolveOne = async (ctx: TabAgentContext, claimed: Set<string>): Promise<ResolvedAgentSession | null> => {
      const roots = this.deps.rootsFor ? await this.deps.rootsFor(ctx.cwd) : undefined;
      if (!roots) return null;
      const cache = await cacheFor(roots);
      if (shared) await yieldToEventLoop();
      return resolveAgentSession(ctx, {
        roots,
        processes,
        claimedSessionIds: claimed,
        ...(cache ? { cache } : {}),
        ...(this.deps.isPidAlive ? { isPidAlive: this.deps.isPidAlive } : {}),
        ...(this.deps.isFileLocked ? { isFileLocked: this.deps.isFileLocked } : {}),
      });
    };

    // Exact answers first; an estimated one that collides is resolved again
    // with the ids already taken set aside.
    const resolved = new Map<string, ResolvedAgentSession | null>();
    for (const { ctx } of contexts) resolved.set(ctx.tabId, await resolveOne(ctx, new Set()));
    const claimed = new Set<string>();
    for (const { ctx } of contexts) {
      const result = resolved.get(ctx.tabId);
      if (result?.confidence === 'exact') claimed.add(result.sessionId);
    }
    for (const { ctx } of contexts) {
      const result = resolved.get(ctx.tabId);
      if (!result || result.confidence === 'exact') continue;
      if (claimed.has(result.sessionId)) {
        const retry = await resolveOne(ctx, claimed);
        resolved.set(ctx.tabId, retry);
        if (retry) claimed.add(retry.sessionId);
      } else {
        claimed.add(result.sessionId);
      }
    }
    return { contexts, resolved };
  }

  /** The agent entry for a resolved id, resumed with the command the agent was launched with. */
  private agentEntry(record: SnapshotTabRecord, ctx: TabAgentContext, result: ResolvedAgentSession): SnapshotEntry {
    const runtime = this.deps.getRuntime(record.tab.sessionId);
    // FR-AITUI-011 AC-4: the command the agent was actually launched with wins (claudep --model x);
    // a legacy recovery option is the fallback for a tab this server run never saw start.
    const launched = runtime?.launchCommand ? splitLaunchCommand(runtime.launchCommand) : null;
    const option = launched
      ?? (record.tab.recoveryCommand ? { command: record.tab.recoveryCommand, args: record.tab.recoveryArguments ?? [] } : null);
    const resume = buildResumeCommand(result.agent, result.sessionId, option);
    return {
      tabId: record.tab.id,
      workspaceId: record.workspaceId,
      workspaceName: record.workspaceName,
      tabName: record.tab.name,
      cwd: ctx.cwd,
      mode: 'agent',
      agent: result.agent,
      sessionId: result.sessionId,
      method: result.method,
      confidence: result.confidence,
      resumeCommand: resume.command,
      resumeArguments: resume.args,
      restore: 'pending',
    };
  }

  /** Adds a manual save to the list and keeps the newest `retention` of them (FR-AITUI-017 AC-1..AC-3). */
  private async addManual(entries: SnapshotEntry[]): Promise<SessionSnapshot> {
    const savedAt = this.now().toISOString();
    const snapshot: SessionSnapshot = { version: 1, id: newManualId(savedAt), origin: 'manual', savedAt, entries };
    await writeJsonAtomic(path.join(this.manualDir, `${snapshot.id}.json`), snapshot);
    this.manual = [snapshot, ...this.manual].sort((a, b) => timeOf(b) - timeOf(a));
    const keep = Math.max(1, Math.floor(this.deps.retention?.() ?? DEFAULT_RETENTION));
    const dropped = this.manual.slice(keep);
    this.manual = this.manual.slice(0, keep);
    for (const old of dropped) {
      await rm(path.join(this.manualDir, `${old.id}.json`), { force: true }).catch((error: unknown) => {
        console.warn('[SessionSnapshot] Could not remove an old save:', error instanceof Error ? error.message : error);
      });
    }
    return snapshot;
  }

  private async persistSnapshot(snapshot: SessionSnapshot): Promise<void> {
    const file = snapshot.origin === 'auto' ? this.autoPath : path.join(this.manualDir, `${snapshot.id}.json`);
    await writeJsonAtomic(file, snapshot);
  }

  async save(tabIds: string[]): Promise<{ snapshot: SessionSnapshot; results: SaveResultItem[] }> {
    const wanted = new Set(tabIds);
    const records = this.deps.listTabs().filter((record) => wanted.has(record.tab.id));
    const { contexts, resolved } = await this.resolveAll(records, await this.processList());

    const entries: SnapshotEntry[] = [];
    const results: SaveResultItem[] = [];
    for (const { record, ctx } of contexts) {
      const result = resolved.get(ctx.tabId) ?? null;
      const agent = result?.agent ?? ctx.agent ?? agentFromCommand(record.tab.recoveryCommand);
      if (!result) {
        results.push({ tabId: record.tab.id, tabName: record.tab.name, workspaceName: record.workspaceName, agent, status: 'not-found' });
        continue;
      }
      entries.push(this.agentEntry(record, ctx, result));
      results.push({
        tabId: record.tab.id,
        tabName: record.tab.name,
        workspaceName: record.workspaceName,
        agent: result.agent,
        status: 'found',
        sessionId: result.sessionId,
        confidence: result.confidence,
        method: result.method,
      });
    }
    const snapshot = await this.addManual(entries);
    return { snapshot, results };
  }

  /**
   * `snapshot` is the newest manual save. `restorable` (FR-AITUI-008) stays false:
   * since FR-AITUI-018 the newest save is restored at start without asking.
   */
  getStatus(): {
    snapshot: SessionSnapshot | null;
    pendingCount: number;
    restorable: boolean;
    report: RestoreReportItem[];
    reportId: string | null;
    reportSource: { origin: SnapshotOrigin; id: string; savedAt: string } | null;
    reportNoticeShown: boolean;
    autoSave: AutoSaveConfig & { lastAt: string | null; lastResult: AutoSaveResult | null };
  } {
    const snapshot = this.manual[0] ?? null;
    return {
      snapshot,
      pendingCount: snapshot?.entries.filter((entry) => entry.restore === 'pending').length ?? 0,
      restorable: false,
      report: this.report.map((item) => ({ ...item })),
      reportId: this.reportId,
      reportSource: this.reportSource ? { ...this.reportSource } : null,
      reportNoticeShown: this.reportId !== null && this.noticeShownReportId === this.reportId,
      autoSave: { ...this.autoSaveConfig, ...this.autoSaveStatus },
    };
  }

  // --------------------------------------------------------------------------
  // FR-AITUI-013: every terminal, shown and saved at once
  // --------------------------------------------------------------------------

  private launchers(): LauncherMap {
    const configured = this.deps.listLaunchers?.();
    const out = {} as LauncherMap;
    for (const agent of AGENT_KINDS) {
      const names = [...DEFAULT_LAUNCHERS[agent], ...(configured?.[agent] ?? [])];
      out[agent] = [...new Set(names)];
    }
    return out;
  }

  /** FR-AITUI-013 AC-2: the registered command this agent was started with, and its args without a selector. */
  private launchOf(agent: AgentKind, record: SnapshotTabRecord, runtime: SnapshotTabRuntime | null): { launcher: string; args: string[] } {
    const launched = runtime?.launchCommand ? splitLaunchCommand(runtime.launchCommand) : null;
    const option = launched
      ?? (record.tab.recoveryCommand ? { command: record.tab.recoveryCommand, args: record.tab.recoveryArguments ?? [] } : null);
    if (!option) return { launcher: agent, args: [] };
    const executable = normalizeRecoveryExecutable(option.command);
    const registered = this.launchers()[agent].find((name) => name.toLowerCase() === executable);
    return { launcher: registered ?? agent, args: stripSessionSelectors(agent, option.args) };
  }

  async preview(): Promise<{ tabs: PreviewTab[]; launchers: LauncherMap }> {
    const records = this.deps.listTabs();
    const { contexts, resolved } = await this.resolveAll(records, await this.processList());
    const tabs: PreviewTab[] = [];
    for (const { record, ctx } of contexts) {
      const runtime = this.deps.getRuntime(record.tab.sessionId);
      const result = resolved.get(ctx.tabId) ?? null;
      const agent = result?.agent ?? ctx.agent ?? agentFromCommand(record.tab.recoveryCommand);
      const launch = agent ? this.launchOf(agent, record, runtime) : null;
      let candidates: AgentSessionCandidate[] = [];
      if (agent && this.deps.rootsFor) {
        const roots = await this.deps.rootsFor(ctx.cwd);
        const listed = listAgentSessionCandidates(agent, ctx.cwd, {
          roots,
          ...(this.deps.isPidAlive ? { isPidAlive: this.deps.isPidAlive } : {}),
        });
        const first = result ? [{ sessionId: result.sessionId, startedAtMs: listed.find((c) => c.sessionId === result.sessionId)?.startedAtMs ?? 0 }] : [];
        candidates = [...first, ...listed.filter((c) => c.sessionId !== result?.sessionId)];
      }
      tabs.push({
        tabId: record.tab.id,
        workspaceId: record.workspaceId,
        workspaceName: record.workspaceName,
        tabName: record.tab.name,
        cwd: ctx.cwd,
        runningCommand: displayCommand((agent ? runtime?.launchCommand : null) ?? runtime?.runningCommand ?? null),
        agent,
        launcher: launch?.launcher ?? null,
        args: launch?.args ?? [],
        sessionId: result?.sessionId ?? null,
        method: result?.method ?? null,
        confidence: agent ? (result?.confidence ?? 'missing') : null,
        candidates,
      });
    }
    return { tabs, launchers: this.launchers() };
  }

  /** Builds one snapshot entry from the user's choice; throws a reason string when it cannot. */
  private entryFor(record: SnapshotTabRecord, item: SnapshotSaveItem): SnapshotEntry {
    const runtime = this.deps.getRuntime(record.tab.sessionId);
    const base = {
      tabId: record.tab.id,
      workspaceId: record.workspaceId,
      workspaceName: record.workspaceName,
      tabName: record.tab.name,
      cwd: runtime?.cwd ?? record.tab.lastCwd ?? null,
      restore: 'pending' as const,
    };
    const shell = (): SnapshotEntry => ({
      ...base, mode: 'shell', agent: null, sessionId: '', method: '', confidence: 'manual', resumeCommand: '', resumeArguments: [],
    });
    if (!isMode(item.mode)) throw new EntryError('mode-invalid');
    if (item.mode === 'shell') return shell();
    if (item.mode === 'command') {
      const line = typeof item.command === 'string' ? item.command.trim() : '';
      if (!line || line.length > MAX_COMMAND_LINE_LENGTH || /[\x00-\x1F\x7F]/.test(line)) throw new EntryError('command-invalid');
      const split = splitLaunchCommand(line);
      if (!split) throw new EntryError('command-invalid');
      try {
        return {
          ...base, mode: 'command', agent: null, sessionId: '', method: '', confidence: 'manual',
          resumeCommand: validateRecoveryCommand(split.command),
          resumeArguments: validateRecoveryArguments(split.args),
        };
      } catch {
        throw new EntryError('command-invalid');
      }
    }
    const agent = item.agent;
    if (!isAgentKind(agent)) throw new EntryError('agent-invalid');
    const sessionId = typeof item.sessionId === 'string' ? item.sessionId.trim() : '';
    if (!sessionId) return shell();
    if (!isValidAgentSessionId(agent, sessionId)) throw new EntryError('session-id-invalid');
    const launcherInput = typeof item.launcher === 'string' && item.launcher.trim() ? item.launcher.trim() : agent;
    const launcher = this.launchers()[agent].find((name) => name.toLowerCase() === launcherInput.toLowerCase());
    if (!launcher) throw new EntryError('launcher-not-registered');
    let args: string[];
    try {
      args = validateRecoveryArguments(item.args ?? []);
    } catch {
      throw new EntryError('args-invalid');
    }
    const resume = buildResumeCommand(agent, sessionId, { command: launcher, args });
    return {
      ...base, mode: 'agent', agent, sessionId, method: 'user', confidence: 'manual',
      resumeCommand: resume.command, resumeArguments: resume.args,
    };
  }

  async saveAll(items: SnapshotSaveItem[]): Promise<{ snapshot: SessionSnapshot }> {
    const records = new Map(this.deps.listTabs().map((record) => [record.tab.id, record]));
    const byTab = new Map<string, SnapshotSaveItem>();
    for (const item of items) byTab.set(item.tabId, item);
    const entries: SnapshotEntry[] = [];
    const bad: string[] = [];
    const reasons: Record<string, string> = {};
    for (const [tabId, item] of byTab) {
      const record = records.get(tabId);
      try {
        if (!record) throw new EntryError('tab-missing');
        entries.push(this.entryFor(record, item));
      } catch (error) {
        bad.push(tabId);
        reasons[tabId] = error instanceof EntryError ? error.message : 'invalid';
      }
    }
    if (bad.length > 0) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'Some terminals cannot be saved', { tabIds: bad, reasons });
    }
    return { snapshot: await this.addManual(entries) };
  }

  // --------------------------------------------------------------------------
  // FR-AITUI-016: auto save
  // --------------------------------------------------------------------------

  /** AC-2/AC-4: one tab as the auto save records it. */
  private autoEntryFor(record: SnapshotTabRecord, ctx: TabAgentContext, result: ResolvedAgentSession | null): SnapshotEntry {
    if (result?.confidence === 'exact') return this.agentEntry(record, ctx, result);
    const runtime = this.deps.getRuntime(record.tab.sessionId);
    const names = { workspaceId: record.workspaceId, workspaceName: record.workspaceName, tabName: record.tab.name };
    const agent = result?.agent ?? ctx.agent ?? agentFromCommand(record.tab.recoveryCommand);
    if (agent) {
      // AC-4: a manual save made after this agent started knows its id better than a guess.
      const newestManual = this.manual[0];
      const manualEntry = newestManual?.entries.find((entry) => entry.tabId === record.tab.id && entry.mode === 'agent' && entry.agent === agent);
      const startedAt = runtime?.foregroundStartedAt;
      if (newestManual && manualEntry && (startedAt === undefined || timeOf(newestManual) >= startedAt)) {
        return { ...manualEntry, ...names, cwd: ctx.cwd ?? manualEntry.cwd, restore: 'pending' };
      }
      if (result) return this.agentEntry(record, ctx, result);
      const previous = this.auto?.entries.find((entry) => entry.tabId === record.tab.id && entry.mode === 'agent' && entry.agent === agent);
      if (previous) return { ...previous, ...names, cwd: ctx.cwd ?? previous.cwd, restore: 'pending' };
    }
    const running = agent ? null : runtime?.runningCommand ?? null;
    return {
      tabId: record.tab.id,
      ...names,
      cwd: ctx.cwd,
      mode: 'shell',
      agent: null,
      sessionId: '',
      method: '',
      confidence: 'manual',
      resumeCommand: '',
      resumeArguments: [],
      restore: 'pending',
      ...(running && running.length <= MAX_COMMAND_LINE_LENGTH && !/[\x00-\x1F\x7F]/.test(running) ? { runningCommand: running } : {}),
    };
  }

  /** One auto save cycle. AC-5: deferred while resumed agents are still looked for; AC-6: one at a time. */
  async autoSave(): Promise<{ result: AutoSaveResult; at: string }> {
    const at = this.now().toISOString();
    if (this.autoSaving) return { result: 'skipped', at };
    if (this.waiting.size > 0) return { result: 'deferred', at };
    this.autoSaving = true;
    try {
      const records = this.deps.listTabs();
      const agentish = records.some((record) => {
        const runtime = this.deps.getRuntime(record.tab.sessionId);
        return Boolean(runtime?.foregroundAppId || runtime?.outputHint || agentFromCommand(record.tab.recoveryCommand));
      });
      const processes = agentish ? await this.processList() : undefined;
      const { contexts, resolved } = await this.resolveAll(records, processes, new Map());
      const entries = contexts.map(({ record, ctx }) => this.autoEntryFor(record, ctx, resolved.get(ctx.tabId) ?? null));
      const snapshot: SessionSnapshot = {
        version: 1,
        id: AUTO_ID,
        origin: 'auto',
        savedAt: this.now().toISOString(),
        ...(this.auto?.restoredAt ? { restoredAt: this.auto.restoredAt } : {}),
        entries,
      };
      await writeJsonAtomic(this.autoPath, snapshot);
      this.auto = snapshot;
      this.autoSaveStatus = { lastAt: snapshot.savedAt, lastResult: 'saved' };
      return { result: 'saved', at: snapshot.savedAt };
    } catch (error) {
      // AC-7: the previous auto save stays; the next cycle tries again.
      console.warn('[SessionSnapshot] Auto save failed:', error instanceof Error ? error.message : error);
      this.autoSaveStatus = { lastAt: at, lastResult: 'failed' };
      return { result: 'failed', at };
    } finally {
      this.autoSaving = false;
    }
  }

  /** FR-AITUI-019 AC-3: applied without a restart; turning it off cancels the next cycle. */
  configureAutoSave(config: AutoSaveConfig): void {
    this.autoSaveConfig = { enabled: config.enabled, intervalMinutes: config.intervalMinutes };
    if (this.autoSaveTimer) clearTimeout(this.autoSaveTimer);
    this.autoSaveTimer = null;
    if (config.enabled) this.scheduleAutoSave();
  }

  private scheduleAutoSave(): void {
    const delay = Math.max(1, this.autoSaveConfig.intervalMinutes) * (this.deps.minuteMs ?? 60_000);
    this.autoSaveTimer = setTimeout(() => {
      this.autoSaveTimer = null;
      void this.autoSave().finally(() => {
        if (this.autoSaveConfig.enabled && !this.autoSaveTimer) this.scheduleAutoSave();
      });
    }, delay);
    this.autoSaveTimer.unref?.();
  }

  stopAutoSave(): void {
    if (this.autoSaveTimer) clearTimeout(this.autoSaveTimer);
    this.autoSaveTimer = null;
    this.autoSaveConfig = { ...this.autoSaveConfig, enabled: false };
  }

  // --------------------------------------------------------------------------
  // FR-AITUI-017: the list
  // --------------------------------------------------------------------------

  private summaryOf(snapshot: SessionSnapshot, lastRestored: SessionSnapshot | null): SnapshotSummary {
    const agentCounts: Partial<Record<AgentKind, number>> = {};
    for (const entry of snapshot.entries) {
      if (entry.mode === 'agent' && entry.agent) agentCounts[entry.agent] = (agentCounts[entry.agent] ?? 0) + 1;
    }
    return {
      id: String(snapshot.id),
      origin: snapshot.origin ?? 'manual',
      savedAt: snapshot.savedAt,
      tabCount: snapshot.entries.length,
      agentCounts,
      usedForRestore: lastRestored === snapshot,
    };
  }

  listSnapshots(): { manual: SnapshotSummary[]; auto: SnapshotSummary | null; retention: number } {
    const all = [...this.manual, ...(this.auto ? [this.auto] : [])];
    const lastRestored = all
      .filter((snapshot) => snapshot.restoredAt)
      .sort((a, b) => Date.parse(b.restoredAt ?? '') - Date.parse(a.restoredAt ?? ''))[0] ?? null;
    return {
      manual: this.manual.map((snapshot) => this.summaryOf(snapshot, lastRestored)),
      auto: this.auto ? this.summaryOf(this.auto, lastRestored) : null,
      retention: Math.max(1, Math.floor(this.deps.retention?.() ?? DEFAULT_RETENTION)),
    };
  }

  private find(id: string): SessionSnapshot {
    const snapshot = id === AUTO_ID ? this.auto : this.manual.find((candidate) => candidate.id === id);
    if (!snapshot) throw new AppError(ErrorCode.SNAPSHOT_NOT_FOUND);
    return snapshot;
  }

  async deleteSnapshot(id: string): Promise<void> {
    const snapshot = this.manual.find((candidate) => candidate.id === id);
    if (!snapshot) throw new AppError(ErrorCode.SNAPSHOT_NOT_FOUND);
    await rm(path.join(this.manualDir, `${snapshot.id}.json`), { force: true });
    this.manual = this.manual.filter((candidate) => candidate !== snapshot);
  }

  // --------------------------------------------------------------------------
  // FR-AITUI-018: restoring a save by hand
  // --------------------------------------------------------------------------

  /** AC-6: an idle tab (no agent, back at its prompt) takes the command; otherwise a new tab. */
  private targetOf(entry: SnapshotEntry, records: Map<string, SnapshotTabRecord>): { target: RestoreTarget; targetReason: RestoreTargetReason } {
    const record = records.get(entry.tabId);
    if (!record) return { target: 'new-tab', targetReason: 'missing' };
    const runtime = this.deps.getRuntime(record.tab.sessionId);
    if (!runtime || runtime.foregroundAppId || runtime.runningCommand) return { target: 'new-tab', targetReason: 'busy' };
    return { target: 'tab', targetReason: 'idle' };
  }

  getSnapshot(id: string): Omit<SessionSnapshot, 'entries'> & { entries: PlannedEntry[] } {
    const snapshot = this.find(id);
    const records = new Map(this.deps.listTabs().map((record) => [record.tab.id, record]));
    return {
      ...snapshot,
      entries: snapshot.entries.map((entry) => ({ ...entry, ...this.targetOf(entry, records) })),
    };
  }

  async restoreFrom(id: string, items: HandRestoreItem[], options: { fallbackWorkspaceId?: string | null } = {}): Promise<RestoreReportItem[]> {
    const snapshot = this.find(id);
    const records = new Map(this.deps.listTabs().map((record) => [record.tab.id, record]));
    const results: RestoreReportItem[] = [];
    for (const item of items) {
      const entry = snapshot.entries.find((candidate) => candidate.tabId === item.tabId);
      if (!entry) continue;
      const { target } = this.targetOf(entry, records);
      let tabId = entry.tabId;
      if (target === 'new-tab') {
        const opened = this.deps.addTab
          ? await this.deps.addTab(entry.workspaceId, entry.tabName, entry.cwd, options.fallbackWorkspaceId ?? null)
          : null;
        if (!opened) {
          results.push(this.reportItemOf(entry, 'failed', 'tab-not-opened'));
          continue;
        }
        tabId = opened;
      }
      const placed: SnapshotEntry = { ...entry, tabId };
      if (entry.mode === 'shell') {
        const typed = item.includeCommand && entry.runningCommand ? this.typeCommandLine(tabId, entry.runningCommand) : null;
        if (typed === false) results.push(this.reportItemOf(placed, 'failed', 'command-invalid'));
        else results.push(this.reportItemOf(typed ? { ...placed, mode: 'command' } : placed, typed ? 'typed' : 'shell'));
        continue;
      }
      results.push(this.runEntry(placed, new Set([tabId])));
    }
    return results;
  }

  /** A saved command line typed into a tab; false when it is not a command line that may be typed. */
  private typeCommandLine(tabId: string, line: string): boolean {
    const split = splitLaunchCommand(line);
    if (!split) return false;
    try {
      return this.deps.scheduleResume(tabId, validateRecoveryCommand(split.command), validateRecoveryArguments(split.args));
    } catch {
      return false;
    }
  }

  // --------------------------------------------------------------------------
  // FR-AITUI-014 / FR-AITUI-018: the automatic resume after a restart
  // --------------------------------------------------------------------------

  /** FR-AITUI-014 AC-1: the folder a tab of the save being restored reopens in. */
  restoreCwdFor(tabId: string): string | null {
    if (!this.restoreSource || this.restoreSourceDone) return null;
    return this.restoreSource.entries.find((candidate) => candidate.tabId === tabId)?.cwd ?? null;
  }

  private reportItemOf(entry: SnapshotEntry, result: RestoreResult, reason?: string): RestoreReportItem {
    return {
      tabId: entry.tabId,
      workspaceName: entry.workspaceName,
      tabName: entry.tabName,
      mode: entry.mode,
      agent: entry.agent,
      cwd: entry.cwd,
      commandLine: entry.mode === 'shell' ? '' : commandLineOf(entry.resumeCommand, entry.resumeArguments),
      // The selector and the id are the last two arguments of an agent's resume command.
      ...(entry.mode === 'agent'
        ? { launcher: entry.resumeCommand, args: entry.resumeArguments.slice(0, -2), sessionId: entry.sessionId }
        : {}),
      result,
      ...(reason ? { reason } : {}),
    };
  }

  private setReportItem(item: RestoreReportItem): void {
    const at = this.report.findIndex((current) => current.tabId === item.tabId);
    if (at >= 0) this.report[at] = item;
    else this.report.push(item);
  }

  /** Types the entry's command into its tab and starts watching for the agent. */
  private runEntry(entry: SnapshotEntry, tabIds: ReadonlySet<string>): RestoreReportItem {
    this.waiting.delete(entry.tabId);
    if (!tabIds.has(entry.tabId)) return this.reportItemOf(entry, 'failed', 'tab-missing');
    if (entry.mode === 'shell') return this.reportItemOf(entry, 'shell');
    const scheduled = this.deps.scheduleResume(entry.tabId, entry.resumeCommand, entry.resumeArguments);
    if (!scheduled) return this.reportItemOf(entry, 'failed', 'input-not-scheduled');
    if (entry.mode !== 'agent' || !entry.agent) return this.reportItemOf(entry, 'typed');
    this.waiting.set(entry.tabId, { agent: entry.agent, deadline: Date.now() + (this.deps.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS) });
    this.scheduleWatch();
    return this.reportItemOf(entry, 'waiting');
  }

  private settle(tabId: string, result: 'confirmed' | 'unconfirmed'): void {
    this.waiting.delete(tabId);
    const item = this.report.find((current) => current.tabId === tabId);
    if (item && item.result === 'waiting') {
      item.result = result;
      if (result === 'unconfirmed') item.reason = 'agent-not-detected';
    }
  }

  private scheduleWatch(): void {
    if (this.watchTimer || this.waiting.size === 0) return;
    this.watchTimer = setTimeout(() => {
      this.watchTimer = null;
      void this.watchTick();
    }, this.deps.confirmPollMs ?? DEFAULT_CONFIRM_POLL_MS);
    this.watchTimer.unref?.();
  }

  /**
   * AC-4: confirmed once the agent shows up in the tab — as its foreground app, or
   * in the shell's process tree when nothing marked it (an unregistered wrapper).
   * One process listing per tick serves every waiting tab.
   */
  private async watchTick(): Promise<void> {
    const records = new Map(this.deps.listTabs().map((record) => [record.tab.id, record]));
    let processes: ProcessInfo[] | undefined;
    let listed = false;
    for (const [tabId, watch] of [...this.waiting]) {
      const record = records.get(tabId);
      if (!record) {
        this.settle(tabId, 'unconfirmed');
        continue;
      }
      const runtime = this.deps.getRuntime(record.tab.sessionId);
      let found = runtime?.foregroundAppId === watch.agent;
      if (!found && typeof runtime?.ptyPid === 'number' && this.deps.listProcesses) {
        if (!listed) {
          processes = await this.processList();
          listed = true;
        }
        found = processes ? detectAgentFromProcesses(descendantsOf(runtime.ptyPid, processes))?.agent === watch.agent : false;
      }
      if (found) this.settle(tabId, 'confirmed');
      else if (Date.now() >= watch.deadline) this.settle(tabId, 'unconfirmed');
    }
    this.scheduleWatch();
  }

  /**
   * FR-AITUI-018 AC-1/AC-2: every entry of the save chosen at load, once per server start,
   * even when an earlier start already used it. FR-AITUI-016 AC-3: a running command is not typed.
   */
  async autoRestore(): Promise<RestoreReportItem[]> {
    const source = this.restoreSource;
    if (!source || this.restoreSourceDone) return [];
    this.restoreSourceDone = true;
    if (source.entries.length === 0) return [];
    const tabIds = new Set(this.deps.listTabs().map((record) => record.tab.id));
    const processedAt = this.now().toISOString();
    this.report = [];
    this.reportId = randomUUID();
    this.reportSource = { origin: source.origin ?? 'manual', id: String(source.id), savedAt: source.savedAt };
    for (const entry of source.entries) {
      const item = this.runEntry(entry, tabIds);
      entry.restore = item.result === 'failed' ? 'failed' : 'restored';
      entry.processedAt = processedAt;
      this.report.push(item);
    }
    source.restoredAt = processedAt;
    // The report as typed, taken before the write yields to the agent watch.
    const typed = this.report.map((item) => ({ ...item }));
    await this.persistSnapshot(source).catch((error: unknown) => {
      console.warn('[SessionSnapshot] Could not record the restore:', error instanceof Error ? error.message : error);
    });
    return typed;
  }

  /** FR-AITUI-018 AC-3: a client showed this report's notice; no client shows it again. */
  async acknowledgeReport(reportId: string): Promise<void> {
    if (!this.reportId || reportId !== this.reportId) return;
    this.noticeShownReportId = reportId;
    await writeJsonAtomic(this.restoreStatePath, { noticeShownReportId: reportId, shownAt: this.now().toISOString() });
  }

  /** AC-6: one tab again, with what the user corrected. */
  async retry(item: SnapshotSaveItem): Promise<RestoreReportItem> {
    const record = this.deps.listTabs().find((current) => current.tab.id === item.tabId);
    if (!record) throw new AppError(ErrorCode.TAB_NOT_FOUND);
    let entry: SnapshotEntry;
    try {
      entry = this.entryFor(record, item);
    } catch (error) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'The terminal cannot be resumed with this input', {
        tabIds: [item.tabId],
        reasons: { [item.tabId]: error instanceof EntryError ? error.message : 'invalid' },
      });
    }
    const result = this.runEntry(entry, new Set([record.tab.id]));
    this.setReportItem(result);
    return { ...result };
  }

  /** FR-AITUI-008 AC-1: the tab is a saved one the start has not restored yet. */
  hasPendingForTab(tabId: string): boolean {
    if (!this.restoreSource || this.restoreSourceDone) return false;
    return this.restoreSource.entries.some((entry) => entry.tabId === tabId);
  }

  /** FR-AITUI-008: the chosen tabs of the newest manual save, resumed on request. */
  async restore(tabIds: string[]): Promise<{ snapshot: SessionSnapshot | null; results: Array<{ tabId: string; restore: SnapshotRestoreState }> }> {
    const results: Array<{ tabId: string; restore: SnapshotRestoreState }> = [];
    const snapshot = this.manual[0] ?? null;
    if (!snapshot) return { snapshot: null, results };
    const selected = new Set(tabIds);
    const processedAt = this.now().toISOString();
    for (const entry of snapshot.entries) {
      if (entry.restore !== 'pending') continue;
      if (!selected.has(entry.tabId)) {
        entry.restore = 'skipped';
      } else if (entry.mode === 'shell') {
        entry.restore = 'restored';
      } else if (entry.mode === 'agent' && (!entry.agent || !isValidAgentSessionId(entry.agent, entry.sessionId))) {
        entry.restore = 'failed';
      } else {
        const ok = this.deps.scheduleResume(entry.tabId, entry.resumeCommand, entry.resumeArguments);
        entry.restore = ok ? 'restored' : 'failed';
      }
      entry.processedAt = processedAt;
      results.push({ tabId: entry.tabId, restore: entry.restore });
    }
    await this.persistSnapshot(snapshot);
    return { snapshot, results };
  }

  /** FR-AITUI-007 AC-3: the newest manual save is thrown away. */
  async discard(): Promise<void> {
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.watchTimer = null;
    this.waiting.clear();
    const newest = this.manual[0];
    if (newest) await this.deleteSnapshot(String(newest.id));
    rmSync(this.legacyPath, { force: true });
  }
}
