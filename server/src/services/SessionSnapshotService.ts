// FR-AITUI-007 / FR-AITUI-008 / FR-AITUI-013 / FR-AITUI-014 — the saved sessions and resuming them.
//
// A save reads every terminal's folder, running command and agent session id
// (FR-AITUI-006) without touching the agent, lets the user correct them, and
// writes one snapshot file. After a restart each saved tab comes back as a
// shell in its saved folder and, once the shell is ready, gets its resume
// command typed in without asking. The snapshot is used up by that one restart.

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  AGENT_KINDS,
  agentFromCommand,
  descendantsOf,
  detectAgentFromProcesses,
  isValidAgentSessionId,
  listAgentSessionCandidates,
  resolveAgentSession,
  type AgentKind,
  type AgentSessionCandidate,
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
  savedAt: string;
  entries: SnapshotEntry[];
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
  dataPath?: string;
  listTabs: () => SnapshotTabRecord[];
  getRuntime: (sessionId: string) => SnapshotTabRuntime | null;
  scheduleResume: (tabId: string, command: string, args: string[]) => boolean;
  listProcesses?: () => Promise<ProcessInfo[]>;
  rootsFor?: (cwd: string | null) => Promise<AgentRoots>;
  /** FR-AITUI-013 AC-2: the commands each agent may be launched with (Tools › Agent commands). */
  listLaunchers?: () => LauncherMap;
  isPidAlive?: (pid: number) => boolean;
  /** FR-AITUI-014 AC-4: how long a resumed agent has to appear in its tab. */
  confirmTimeoutMs?: number;
  confirmPollMs?: number;
  now?: () => Date;
}

const DEFAULT_DATA_PATH = './data/session-snapshot.json';
const DEFAULT_CONFIRM_TIMEOUT_MS = 20_000;
const DEFAULT_CONFIRM_POLL_MS = 2_000;
const MAX_COMMAND_LINE_LENGTH = 2000;

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
  };
}

class EntryError extends Error {}

export class SessionSnapshotService {
  private readonly dataPath: string;
  private snapshot: SessionSnapshot | null = null;
  /** True once this server process wrote the snapshot; false for one loaded at start. */
  private savedInThisProcess = false;
  /** FR-AITUI-014 AC-5: what this server run's automatic resume did. */
  private report: RestoreReportItem[] = [];
  /**
   * FR-AITUI-015 AC-7: names this run's report, so a client that dismissed it can tell
   * it apart from the next restart's. Not a time: two restores can share a timestamp.
   */
  private reportId: string | null = null;
  /** FR-AITUI-014 AC-4: resumed agents still being looked for, by tab. */
  private readonly waiting = new Map<string, { agent: AgentKind; deadline: number }>();
  private watchTimer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: SessionSnapshotDeps) {
    this.dataPath = path.resolve(deps.dataPath ?? DEFAULT_DATA_PATH);
  }

  async initialize(): Promise<void> {
    this.snapshot = null;
    this.savedInThisProcess = false;
    this.report = [];
    this.reportId = null;
    if (!existsSync(this.dataPath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.dataPath, 'utf8')) as Partial<SessionSnapshot>;
      const entries = Array.isArray(parsed.entries)
        ? parsed.entries.map(sanitizeEntry).filter((entry): entry is SnapshotEntry => entry !== null)
        : [];
      this.snapshot = { version: 1, savedAt: String(parsed.savedAt ?? ''), entries };
    } catch (error) {
      console.warn('[SessionSnapshot] Unreadable snapshot set aside:', error instanceof Error ? error.message : error);
      try {
        renameSync(this.dataPath, `${this.dataPath}.corrupt-${Date.now()}`);
      } catch { /* leave it */ }
      this.snapshot = null;
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

  /** Resolves every tab's session id; exact answers claim their ids before the guesses. */
  private async resolveAll(
    records: SnapshotTabRecord[],
    processes: ProcessInfo[] | undefined,
  ): Promise<{ contexts: Array<{ record: SnapshotTabRecord; ctx: TabAgentContext }>; resolved: Map<string, ResolvedAgentSession | null> }> {
    const contexts = records.map((record) => ({ record, ctx: this.contextOf(record) }));
    const resolveOne = async (ctx: TabAgentContext, claimed: Set<string>): Promise<ResolvedAgentSession | null> => {
      const roots = this.deps.rootsFor ? await this.deps.rootsFor(ctx.cwd) : undefined;
      if (!roots) return null;
      return resolveAgentSession(ctx, {
        roots,
        processes,
        claimedSessionIds: claimed,
        ...(this.deps.isPidAlive ? { isPidAlive: this.deps.isPidAlive } : {}),
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

  async save(tabIds: string[]): Promise<{ snapshot: SessionSnapshot; results: SaveResultItem[] }> {
    const wanted = new Set(tabIds);
    const records = this.deps.listTabs().filter((record) => wanted.has(record.tab.id));
    const { contexts, resolved } = await this.resolveAll(records, await this.processList());

    const runtime = (record: SnapshotTabRecord) => this.deps.getRuntime(record.tab.sessionId);
    const entries: SnapshotEntry[] = [];
    const results: SaveResultItem[] = [];
    for (const { record, ctx } of contexts) {
      const result = resolved.get(ctx.tabId) ?? null;
      const agent = result?.agent ?? ctx.agent ?? agentFromCommand(record.tab.recoveryCommand);
      if (!result) {
        results.push({ tabId: record.tab.id, tabName: record.tab.name, workspaceName: record.workspaceName, agent, status: 'not-found' });
        continue;
      }
      // FR-AITUI-011 AC-4: the command the agent was actually launched with wins (claudep --model x);
      // a legacy recovery option is the fallback for a tab this server run never saw start.
      const launched = runtime(record)?.launchCommand ? splitLaunchCommand(runtime(record)!.launchCommand!) : null;
      const option = launched
        ?? (record.tab.recoveryCommand ? { command: record.tab.recoveryCommand, args: record.tab.recoveryArguments ?? [] } : null);
      const resume = buildResumeCommand(result.agent, result.sessionId, option);
      entries.push({
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
      });
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

    const now = (this.deps.now ?? (() => new Date()))();
    this.snapshot = { version: 1, savedAt: now.toISOString(), entries };
    this.savedInThisProcess = true;
    this.persist();
    return { snapshot: this.snapshot, results };
  }

  /**
   * `restorable` is what the client offers to resume: pending entries in a
   * snapshot carried over from before a restart. A snapshot saved in this run
   * is still "saved" — its agents are running right now.
   */
  getStatus(): {
    snapshot: SessionSnapshot | null;
    pendingCount: number;
    restorable: boolean;
    report: RestoreReportItem[];
    reportId: string | null;
  } {
    const pendingCount = this.snapshot?.entries.filter((entry) => entry.restore === 'pending').length ?? 0;
    return {
      snapshot: this.snapshot,
      pendingCount,
      restorable: pendingCount > 0 && !this.savedInThisProcess,
      report: this.report.map((item) => ({ ...item })),
      reportId: this.reportId,
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
    const now = (this.deps.now ?? (() => new Date()))();
    this.snapshot = { version: 1, savedAt: now.toISOString(), entries };
    this.savedInThisProcess = true;
    this.persist();
    return { snapshot: this.snapshot };
  }

  // --------------------------------------------------------------------------
  // FR-AITUI-014: the automatic resume after a restart
  // --------------------------------------------------------------------------

  /** AC-1: the folder a tab in an unprocessed snapshot reopens in. */
  restoreCwdFor(tabId: string): string | null {
    if (!this.snapshot || this.savedInThisProcess) return null;
    const entry = this.snapshot.entries.find((candidate) => candidate.tabId === tabId && candidate.restore === 'pending');
    return entry?.cwd ?? null;
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

  /** AC-2/AC-3: every pending entry of a snapshot carried over from before the restart, once. */
  async autoRestore(): Promise<RestoreReportItem[]> {
    if (!this.snapshot || this.savedInThisProcess) return [];
    const pending = this.snapshot.entries.filter((entry) => entry.restore === 'pending');
    if (pending.length === 0) return [];
    const tabIds = new Set(this.deps.listTabs().map((record) => record.tab.id));
    const processedAt = (this.deps.now ?? (() => new Date()))().toISOString();
    this.report = [];
    this.reportId = randomUUID();
    for (const entry of pending) {
      const item = this.runEntry(entry, tabIds);
      entry.restore = item.result === 'failed' ? 'failed' : 'restored';
      entry.processedAt = processedAt;
      this.report.push(item);
    }
    this.persist();
    return this.report.map((item) => ({ ...item }));
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

  hasPendingForTab(tabId: string): boolean {
    return this.snapshot?.entries.some((entry) => entry.tabId === tabId && entry.restore === 'pending') ?? false;
  }

  async restore(tabIds: string[]): Promise<{ snapshot: SessionSnapshot | null; results: Array<{ tabId: string; restore: SnapshotRestoreState }> }> {
    const results: Array<{ tabId: string; restore: SnapshotRestoreState }> = [];
    if (!this.snapshot) return { snapshot: null, results };
    const selected = new Set(tabIds);
    const processedAt = (this.deps.now ?? (() => new Date()))().toISOString();
    for (const entry of this.snapshot.entries) {
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
    this.persist();
    return { snapshot: this.snapshot, results };
  }

  async discard(): Promise<void> {
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.watchTimer = null;
    this.waiting.clear();
    this.snapshot = null;
    this.savedInThisProcess = false;
    rmSync(this.dataPath, { force: true });
  }

  private persist(): void {
    if (!this.snapshot) return;
    mkdirSync(path.dirname(this.dataPath), { recursive: true });
    const tmp = `${this.dataPath}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(this.snapshot, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, this.dataPath);
  }
}
