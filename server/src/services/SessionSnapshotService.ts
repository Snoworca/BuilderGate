// FR-AITUI-007 / FR-AITUI-008 — the saved sessions and resuming them.
//
// A save reads each chosen AI tab's current session id (FR-AITUI-006) without
// touching the agent, and writes one snapshot file. After a restart the tabs
// in that file come back as shells; the user picks which to resume, and each
// resumed tab gets its agent's resume command typed in once its shell is
// ready. Whatever the user decided is written back so nothing is asked twice.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  AGENT_KINDS,
  agentFromCommand,
  isValidAgentSessionId,
  resolveAgentSession,
  type AgentKind,
  type AgentOutputHint,
  type AgentRoots,
  type ProcessInfo,
  type ResolveConfidence,
  type ResolvedAgentSession,
  type TabAgentContext,
} from './agentSession/agentSessionResolver.js';
import { buildResumeCommand } from './agentSession/resumeCommand.js';
import { splitLaunchCommand } from '../utils/recoveryCommand.js';

export type SnapshotRestoreState = 'pending' | 'restored' | 'skipped' | 'failed';

export interface SnapshotEntry {
  tabId: string;
  workspaceId: string;
  workspaceName: string;
  tabName: string;
  cwd: string | null;
  agent: AgentKind;
  sessionId: string;
  method: string;
  confidence: ResolveConfidence;
  resumeCommand: string;
  resumeArguments: string[];
  restore: SnapshotRestoreState;
  processedAt?: string;
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
  now?: () => Date;
}

const DEFAULT_DATA_PATH = './data/session-snapshot.json';

function isAgentKind(value: unknown): value is AgentKind {
  return typeof value === 'string' && (AGENT_KINDS as readonly string[]).includes(value);
}

function sanitizeEntry(raw: unknown): SnapshotEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Record<string, unknown>;
  if (typeof e.tabId !== 'string' || !isAgentKind(e.agent) || typeof e.sessionId !== 'string') return null;
  if (!isValidAgentSessionId(e.agent, e.sessionId)) return null;
  if (typeof e.resumeCommand !== 'string' || !Array.isArray(e.resumeArguments) || e.resumeArguments.some((a) => typeof a !== 'string')) return null;
  const restore: SnapshotRestoreState = e.restore === 'restored' || e.restore === 'skipped' || e.restore === 'failed' ? e.restore : 'pending';
  return {
    tabId: e.tabId,
    workspaceId: String(e.workspaceId ?? ''),
    workspaceName: String(e.workspaceName ?? ''),
    tabName: String(e.tabName ?? ''),
    cwd: typeof e.cwd === 'string' ? e.cwd : null,
    agent: e.agent,
    sessionId: e.sessionId,
    method: String(e.method ?? ''),
    confidence: e.confidence === 'exact' ? 'exact' : 'estimated',
    resumeCommand: e.resumeCommand,
    resumeArguments: e.resumeArguments as string[],
    restore,
    ...(typeof e.processedAt === 'string' ? { processedAt: e.processedAt } : {}),
  };
}

export class SessionSnapshotService {
  private readonly dataPath: string;
  private snapshot: SessionSnapshot | null = null;
  /** True once this server process wrote the snapshot; false for one loaded at start. */
  private savedInThisProcess = false;

  constructor(private readonly deps: SessionSnapshotDeps) {
    this.dataPath = path.resolve(deps.dataPath ?? DEFAULT_DATA_PATH);
  }

  async initialize(): Promise<void> {
    this.snapshot = null;
    this.savedInThisProcess = false;
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

  async save(tabIds: string[]): Promise<{ snapshot: SessionSnapshot; results: SaveResultItem[] }> {
    const wanted = new Set(tabIds);
    const records = this.deps.listTabs().filter((record) => wanted.has(record.tab.id));
    let processes: ProcessInfo[] | undefined;
    if (this.deps.listProcesses) {
      try {
        processes = await this.deps.listProcesses();
      } catch (error) {
        console.warn('[SessionSnapshot] Process list unavailable:', error instanceof Error ? error.message : error);
      }
    }

    const contexts = records.map((record) => {
      const runtime = this.deps.getRuntime(record.tab.sessionId);
      const ctx: TabAgentContext = {
        tabId: record.tab.id,
        cwd: runtime?.cwd ?? record.tab.lastCwd ?? null,
        agent: runtime?.foregroundAppId ?? null,
        ...(runtime?.foregroundStartedAt !== undefined ? { agentStartedAtMs: runtime.foregroundStartedAt } : {}),
        ptyPid: runtime?.ptyPid ?? null,
        outputHint: runtime?.outputHint ?? null,
        recoveryCommand: record.tab.recoveryCommand ?? null,
      };
      return { record, ctx };
    });

    const resolveOne = async (ctx: TabAgentContext, claimed: Set<string>): Promise<ResolvedAgentSession | null> => {
      const roots = this.deps.rootsFor ? await this.deps.rootsFor(ctx.cwd) : undefined;
      if (!roots) return null;
      return resolveAgentSession(ctx, { roots, processes, claimedSessionIds: claimed });
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
  getStatus(): { snapshot: SessionSnapshot | null; pendingCount: number; restorable: boolean } {
    const pendingCount = this.snapshot?.entries.filter((entry) => entry.restore === 'pending').length ?? 0;
    return { snapshot: this.snapshot, pendingCount, restorable: pendingCount > 0 && !this.savedInThisProcess };
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
      } else if (!isValidAgentSessionId(entry.agent, entry.sessionId)) {
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
