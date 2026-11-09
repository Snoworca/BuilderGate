// FR-LOOP-001..005, 008: keeps the loops, decides when each is due, and runs it — a new tab in a
// @schedule-{n} workspace, or the current session of a tab the user opened, sent the steps in order.
//
// Everything the run touches outside this module (workspaces, tabs, the PTY, the clock's
// sleeps, the file system) is behind LoopRuntimePort, which index.ts implements.
import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type { ShellType } from '../../types/index.js';
import { publishStoreAtomically } from '../../utils/atomicStoreWrite.js';
import { validateLoopInput, type LoopStep, type LoopTarget, type ValidLoopInput } from './loopDefinition.js';
import { nextRunAfter } from './loopSchedule.js';

export interface LoopRuntimePort {
  workspaceExists(workspaceId: string): boolean;
  countTabs(workspaceId: string): number;
  maxTabsPerWorkspace(): number;
  /** Creates the workspace and tells the open browsers; returns its id. */
  createWorkspace(name: string): Promise<string>;
  /** Opens a tab and tells the open browsers; throws when the shell cannot start. */
  openTab(workspaceId: string, request: { name: string; shell: ShellType; cwd: string }): Promise<{ tabId: string; sessionId: string }>;
  /** Closes the tab wherever it is now and tells the open browsers; throws when it is gone. */
  closeTab(tabId: string): Promise<void>;
  tabExists(tabId: string): boolean;
  /** Writes the text, then Enter on its own (FR-MCP-002 AC-7). */
  submit(sessionId: string, text: string): Promise<boolean>;
  sleep(ms: number): Promise<void>;
  directoryExists(cwd: string): Promise<boolean>;
  /** FR-LOOP-008: where a tab is now and what runs in it; null when the tab is gone. */
  inspectTab(tabId: string): LoopTabInfo | null;
  /** FR-LOOP-008 AC-7: every tab, in workspace screen order then tab order. */
  listTabs(): LoopTabInfo[];
}

export interface LoopTabInfo {
  tabId: string;
  workspaceId: string;
  workspaceName: string;
  tabName: string;
  cwd: string;
  shell: string;
  /** The session running in the tab now; null when its shell has ended. */
  sessionId: string | null;
  /** The AI agent detected in it (the messenger's detection), or null for a plain terminal. */
  agent: { kind: string; status: string } | null;
}

/** FR-LOOP-008 AC-7: a tab an existing-session loop can be pointed at. */
export interface LoopSessionOption extends Omit<LoopTabInfo, 'sessionId'> {
  alive: boolean;
}

/** FR-LOOP-008 AC-5: agent states that count as working. */
const AGENT_WORKING = new Set(['busy', 'starting', 'running']);
/**
 * The detector's status drops to idle for a moment between an agent's steps (Claude Code shows ✳
 * for a few ms and idleDelayMs is 200 ms, SessionManager FR-AITUI-010; its busy grace is 1.5 s), so
 * one look can land in that gap. Two more looks across this window must also read not-working.
 */
export const LOOP_BUSY_CONFIRM_MS = 1500;
const BUSY_CONFIRM_LOOKS = 2;

export interface LoopDefinition extends ValidLoopInput {
  id: string;
  /** ISO time of the next run; null when the schedule has none left or the loop is off. */
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type LoopRunResult = 'running' | 'success' | 'failed' | 'skipped' | 'aborted';

/** Why a run did not succeed; the screen words it (FR-LOOP-006 AC-5). */
export type LoopRunReason =
  | 'previousRunning' | 'tabCap' | 'directoryMissing' | 'cancelled' | 'tabClosed' | 'restart' | 'inputRejected' | 'error'
  | 'sessionMissing' | 'sessionStopped' | 'agentBusy';

export interface LoopRun {
  id: string;
  loopId: string;
  trigger: 'schedule' | 'manual';
  startedAt: string;
  finishedAt: string | null;
  result: LoopRunResult;
  stepsSent: number;
  totalSteps: number;
  workspaceId: string | null;
  workspaceName: string | null;
  tabId: string | null;
  tabName: string | null;
  reason: LoopRunReason | null;
  /** The folder, or the error's own text, for `directoryMissing` and `error`. */
  detail: string | null;
}

interface ScheduleWorkspace { id: string; n: number }
interface KeptTab { tabId: string }

interface LoopFile {
  version: 1;
  loops: LoopDefinition[];
  runs: Record<string, LoopRun[]>;
  /** Run numbers handed out so far, per loop. */
  counters: Record<string, number>;
  scheduleWorkspaces: ScheduleWorkspace[];
  /** Tabs of finished runs that had no session-end step, oldest first. */
  keptTabs: Record<string, KeptTab[]>;
}

export interface LoopServiceOptions {
  dataPath?: string;
  runtime: LoopRuntimePort;
  now?: () => Date;
  /** Off in tests, which call tick() themselves. */
  startTimer?: boolean;
  /** FR-LOOP-008 AC-5: how long an agent must read not-working before a skipWhenBusy run sends. */
  busyConfirmMs?: number;
}

/** FR-LOOP-004 AC-5. */
export const SCHEDULE_TAB_CAP = 32;
/** FR-LOOP-005 AC-2. */
export const LOOP_HISTORY_MAX = 50;
/** A tick this late still runs the loop; later than this the time counts as missed (FR-LOOP-002 AC-6). */
export const LOOP_LATE_GRACE_MS = 5 * 60_000;
const TAB_NAME_MAX = 32;
/** The longest the timer sleeps, so a changed clock is noticed. */
const TIMER_MAX_MS = 60_000;

export class LoopService {
  private readonly dataFilePath: string;
  private readonly runtime: LoopRuntimePort;
  private readonly now: () => Date;
  private readonly startTimer: boolean;
  private readonly busyConfirmMs: number;
  private file: LoopFile = emptyFile();
  private readonly running = new Set<string>();
  /** Loops turned off or deleted while a run of theirs is sending (FR-LOOP-003 AC-4). */
  private readonly cancelled = new Set<string>();
  /** One tab is created at a time (FR-LOOP-005 AC-3). */
  private placementChain: Promise<unknown> = Promise.resolve();
  /** FR-LOOP-008 AC-6: runs into one tab go one after the other. */
  private readonly tabChains = new Map<string, Promise<unknown>>();
  private writeChain: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;
  private disposed = false;

  constructor(options: LoopServiceOptions) {
    this.dataFilePath = path.resolve(options.dataPath ?? './data/loops.json');
    this.runtime = options.runtime;
    this.now = options.now ?? (() => new Date());
    this.startTimer = options.startTimer ?? true;
    this.busyConfirmMs = options.busyConfirmMs ?? LOOP_BUSY_CONFIRM_MS;
  }

  async initialize(): Promise<void> {
    this.file = await this.load();
    // FR-LOOP-008 AC-1: loops saved before targets existed are new-session loops.
    this.file.loops = this.file.loops.map(withTarget);
    // FR-LOOP-005 AC-2: a run cut off by a restart is not left "running".
    for (const runs of Object.values(this.file.runs)) {
      for (const run of runs) {
        if (run.result === 'running') Object.assign(run, { result: 'aborted', reason: 'restart', detail: null });
      }
    }
    // FR-LOOP-002 AC-6: times passed while the server was off are not run.
    for (const loop of this.file.loops) this.reschedule(loop);
    await this.persist();
    this.arm();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  list(): LoopDefinition[] {
    return this.file.loops.map((loop) => structuredClone(loop));
  }

  get(id: string): LoopDefinition | null {
    const loop = this.file.loops.find((current) => current.id === id);
    return loop ? structuredClone(loop) : null;
  }

  history(id: string): LoopRun[] {
    return structuredClone(this.file.runs[id] ?? []);
  }

  isScheduleWorkspace(workspaceId: string): boolean {
    return this.file.scheduleWorkspaces.some((ws) => ws.id === workspaceId);
  }

  /** FR-LOOP-008 AC-7: tabs an existing-session loop can send to; the loops' own tabs are left out. */
  sessions(): LoopSessionOption[] {
    return this.runtime.listTabs()
      .filter((tab) => !this.isScheduleWorkspace(tab.workspaceId))
      .map(({ sessionId, ...tab }) => ({ ...tab, alive: sessionId !== null }));
  }

  /** FR-LOOP-008 AC-9: whether a run's tab is still open, so the history can offer 「탭 열기」. */
  tabOpen(run: Pick<LoopRun, 'tabId'>): boolean {
    return run.tabId !== null && this.runtime.tabExists(run.tabId);
  }

  /** FR-LOOP-008 AC-7: whether an existing-session loop's tab is gone. */
  targetMissing(loop: Pick<LoopDefinition, 'target'>): boolean {
    return loop.target.kind === 'session' && this.runtime.inspectTab(loop.target.tabId) === null;
  }

  async create(input: unknown): Promise<LoopDefinition> {
    const value = this.validate(input);
    const stamp = this.now().toISOString();
    const loop: LoopDefinition = { ...value, id: uuidv4(), nextRunAt: null, createdAt: stamp, updatedAt: stamp };
    this.reschedule(loop);
    this.file.loops.push(loop);
    await this.persist();
    this.arm();
    return structuredClone(loop);
  }

  async update(id: string, input: unknown): Promise<LoopDefinition> {
    const loop = this.require(id);
    const value = this.validate(input);
    // Only switching it off stops a run; saving a loop that was already off does not.
    if (loop.enabled && !value.enabled && this.running.has(id)) this.cancelled.add(id);
    Object.assign(loop, value, { updatedAt: this.now().toISOString() });
    this.reschedule(loop);
    await this.persist();
    this.arm();
    return structuredClone(loop);
  }

  async remove(id: string): Promise<void> {
    this.require(id);
    if (this.running.has(id)) this.cancelled.add(id);
    this.file.loops = this.file.loops.filter((loop) => loop.id !== id);
    delete this.file.runs[id];
    delete this.file.counters[id];
    delete this.file.keptTabs[id];
    await this.persist();
    this.arm();
  }

  /** FR-LOOP-001 AC-5: run once now, whatever the schedule or switch, and wait for it to end. */
  async runNow(id: string): Promise<LoopRun> {
    return this.begin(this.require(id), 'manual').done;
  }

  /** The same, answering at once with the run's first record (running, or skipped). */
  startNow(id: string): LoopRun {
    const { record, done } = this.begin(this.require(id), 'manual');
    done.catch((error) => console.warn('[LoopService] run failed:', error));
    return structuredClone(record);
  }

  /** Runs every loop that is due and moves each one's next time on. */
  async tick(): Promise<LoopRun[]> {
    const now = this.now();
    const due: LoopDefinition[] = [];
    for (const loop of this.file.loops) {
      if (!loop.enabled || !loop.nextRunAt) continue;
      const at = new Date(loop.nextRunAt);
      if (at > now) continue;
      if (now.getTime() - at.getTime() <= LOOP_LATE_GRACE_MS) due.push(loop);
      this.reschedule(loop);
    }
    await this.persist();
    const runs = await Promise.all(due.map((loop) => this.begin(loop, 'schedule').done));
    this.arm();
    return runs;
  }

  private begin(loop: LoopDefinition, trigger: LoopRun['trigger']): { record: LoopRun; done: Promise<LoopRun> } {
    const record: LoopRun = {
      id: uuidv4(), loopId: loop.id, trigger, startedAt: this.now().toISOString(), finishedAt: null,
      result: 'running', stepsSent: 0, totalSteps: loop.steps.length,
      workspaceId: null, workspaceName: null, tabId: null, tabName: null, reason: null, detail: null,
    };
    // FR-LOOP-005 AC-1: running lasts until the last step is sent.
    if (this.running.has(loop.id)) {
      Object.assign(record, { result: 'skipped', reason: 'previousRunning' });
      return { record, done: this.finish(record, 'skipped', 'previousRunning') };
    }
    this.running.add(loop.id);
    this.addRun(record);
    const startedAsNew = loop.target.kind === 'new';
    const done = this.execute(loop, record)
      .catch((error: unknown) => (error instanceof InputRejectedError
        ? this.finish(record, 'failed', 'inputRejected')
        : this.finish(record, 'failed', 'error', errorDetail(error))))
      .then(async (finished) => {
        // FR-LOOP-004 AC-4: a tab left open — by a run without a session end, or one that was
        // stopped or failed after it opened — counts toward the tabs this loop keeps.
        // The kind the run started with decides: a user's tab is never counted, whatever the loop is now.
        if (startedAsNew && record.tabId && this.runtime.tabExists(record.tabId)) await this.keepTab(loop.id, record.tabId);
        await this.persist();
        return finished;
      })
      .finally(() => {
        this.running.delete(loop.id);
        this.cancelled.delete(loop.id);
      });
    return { record, done };
  }

  private async execute(loop: LoopDefinition, record: LoopRun): Promise<LoopRun> {
    const target = loop.target;
    if (target.kind === 'session') return this.serializeTab(target.tabId, () => this.executeInSession(loop, target, record));
    if (!(await this.runtime.directoryExists(target.cwd))) {
      return this.finish(record, 'failed', 'directoryMissing', target.cwd);
    }
    const opened = await this.serializePlacement(() => this.openRunTab(loop, target, record));
    if (!opened) return this.finish(record, 'skipped', 'tabCap');
    await this.persist();
    return this.sendSteps(loop, record, opened.tabId, () => opened.sessionId);
  }

  /** FR-LOOP-008 AC-3..5. */
  private async executeInSession(loop: LoopDefinition, target: Extract<LoopTarget, { kind: 'session' }>, record: LoopRun): Promise<LoopRun> {
    Object.assign(record, { workspaceName: target.label.workspaceName, tabId: target.tabId, tabName: target.label.tabName });
    const tab = this.runtime.inspectTab(target.tabId);
    if (!tab) {
      // AC-4 (Q1): a deleted tab's id never comes back, so the loop is turned off.
      const current = this.file.loops.find((entry) => entry.id === loop.id);
      if (current?.enabled) {
        current.enabled = false;
        this.reschedule(current);
      }
      return this.finish(record, 'skipped', 'sessionMissing');
    }
    Object.assign(record, { workspaceId: tab.workspaceId, workspaceName: tab.workspaceName, tabName: tab.tabName });
    if (tab.sessionId === null) return this.finish(record, 'skipped', 'sessionStopped');
    if (target.skipWhenBusy && (await this.agentWorking(target.tabId, tab))) return this.finish(record, 'skipped', 'agentBusy');
    await this.persist();
    // AC-3: found again for every step, so a restarted tab's new session is followed.
    return this.sendSteps(loop, record, target.tabId, () => this.runtime.inspectTab(target.tabId)?.sessionId ?? null);
  }

  /** AC-5: working on the first look, or on any of the later looks across busyConfirmMs. */
  private async agentWorking(tabId: string, first: LoopTabInfo): Promise<boolean> {
    const working = (tab: LoopTabInfo | null) => Boolean(tab?.agent && AGENT_WORKING.has(tab.agent.status));
    if (working(first)) return true;
    if (this.busyConfirmMs <= 0) return false;
    for (let look = 0; look < BUSY_CONFIRM_LOOKS; look += 1) {
      await this.runtime.sleep(this.busyConfirmMs / BUSY_CONFIRM_LOOKS);
      if (working(this.runtime.inspectTab(tabId))) return true;
    }
    return false;
  }

  private async sendSteps(loop: LoopDefinition, record: LoopRun, tabId: string, sessionOf: () => string | null): Promise<LoopRun> {
    for (const step of loop.steps) {
      if (this.cancelled.has(loop.id)) return this.finish(record, 'aborted', 'cancelled');
      if (!this.runtime.tabExists(tabId)) return this.finish(record, 'aborted', 'tabClosed');
      await this.send(step, tabId, sessionOf);
      record.stepsSent += 1;
    }
    return this.finish(record, 'success', null);
  }

  private async send(step: LoopStep, tabId: string, sessionOf: () => string | null): Promise<void> {
    switch (step.kind) {
      case 'command':
      case 'prompt': {
        const sessionId = sessionOf();
        if (sessionId === null || !(await this.runtime.submit(sessionId, step.text))) throw new InputRejectedError();
        return;
      }
      case 'delay':
        await this.runtime.sleep(step.ms);
        return;
      case 'end':
        await this.runtime.closeTab(tabId);
    }
  }

  /** FR-LOOP-004 AC-1..3, AC-5. Null when the tab cap is reached. */
  private async openRunTab(loop: LoopDefinition, target: Extract<LoopTarget, { kind: 'new' }>, record: LoopRun) {
    this.file.scheduleWorkspaces = this.file.scheduleWorkspaces.filter((ws) => this.runtime.workspaceExists(ws.id));
    const total = this.file.scheduleWorkspaces.reduce((sum, ws) => sum + this.runtime.countTabs(ws.id), 0);
    if (total >= SCHEDULE_TAB_CAP) return null;

    const max = this.runtime.maxTabsPerWorkspace();
    let workspace = [...this.file.scheduleWorkspaces]
      .sort((a, b) => a.n - b.n)
      .find((ws) => this.runtime.countTabs(ws.id) < max);
    if (!workspace) {
      const n = this.file.scheduleWorkspaces.reduce((top, ws) => Math.max(top, ws.n), -1) + 1;
      workspace = { id: await this.runtime.createWorkspace(`@schedule-${n}`), n };
      this.file.scheduleWorkspaces.push(workspace);
    }

    const count = (this.file.counters[loop.id] ?? 0) + 1;
    this.file.counters[loop.id] = count;
    const suffix = ` #${count}`;
    const tabName = `${loop.name.slice(0, TAB_NAME_MAX - suffix.length).trim()}${suffix}`;
    const tab = await this.runtime.openTab(workspace.id, { name: tabName, shell: target.shell, cwd: target.cwd });
    Object.assign(record, { workspaceId: workspace.id, workspaceName: `@schedule-${workspace.n}`, tabId: tab.tabId, tabName });
    return tab;
  }

  /** FR-LOOP-004 AC-4: the oldest beyond keepTabs close; one that cannot be closed is let go. */
  private async keepTab(loopId: string, tabId: string): Promise<void> {
    const loop = this.file.loops.find((current) => current.id === loopId);
    if (!loop) return;
    // A loop switched to an existing session mid-run keeps one tab: the last run's.
    const keepTabs = loop.target.kind === 'new' ? loop.target.keepTabs : 1;
    const kept = (this.file.keptTabs[loopId] ?? []).filter((entry) => this.runtime.tabExists(entry.tabId));
    kept.push({ tabId });
    while (kept.length > keepTabs) {
      const oldest = kept.shift()!;
      await this.runtime.closeTab(oldest.tabId).catch((error: unknown) => {
        console.warn('[LoopService] could not close a kept tab:', error);
      });
    }
    this.file.keptTabs[loopId] = kept;
  }

  private serializePlacement<T>(work: () => Promise<T>): Promise<T> {
    const next = this.placementChain.then(work, work);
    this.placementChain = next.catch(() => undefined);
    return next;
  }

  private serializeTab<T>(tabId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tabChains.get(tabId) ?? Promise.resolve();
    const next = previous.then(work, work);
    const settled = next.catch(() => undefined);
    this.tabChains.set(tabId, settled);
    void settled.then(() => {
      if (this.tabChains.get(tabId) === settled) this.tabChains.delete(tabId);
    });
    return next;
  }

  private async finish(record: LoopRun, result: LoopRunResult, reason: LoopRunReason | null, detail: string | null = null): Promise<LoopRun> {
    record.result = result;
    record.reason = reason;
    record.detail = detail;
    record.finishedAt = this.now().toISOString();
    this.addRun(record);
    await this.persist();
    return structuredClone(record);
  }

  /** FR-LOOP-005 AC-2: newest first, at most 50. Adding a record twice keeps one. */
  private addRun(record: LoopRun): void {
    const runs = (this.file.runs[record.loopId] ?? []).filter((run) => run.id !== record.id);
    if (!this.file.loops.some((loop) => loop.id === record.loopId)) return;
    this.file.runs[record.loopId] = [record, ...runs].slice(0, LOOP_HISTORY_MAX);
  }

  /** FR-LOOP-002: the next time after now; a one-time loop with none left turns off (AC-3). */
  private reschedule(loop: LoopDefinition): void {
    const next = loop.enabled ? nextRunAfter(loop.schedule, this.now()) : null;
    loop.nextRunAt = next ? next.toISOString() : null;
    if (loop.enabled && !next && loop.schedule.kind === 'once') loop.enabled = false;
  }

  private arm(): void {
    if (!this.startTimer || this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    const times = this.file.loops.flatMap((loop) => (loop.enabled && loop.nextRunAt ? [new Date(loop.nextRunAt).getTime()] : []));
    if (times.length === 0) {
      this.timer = null;
      return;
    }
    const wait = Math.min(TIMER_MAX_MS, Math.max(0, Math.min(...times) - this.now().getTime()));
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick().catch((error) => console.warn('[LoopService] tick failed:', error));
      this.arm();
    }, wait);
    this.timer.unref?.();
  }

  private validate(input: unknown): ValidLoopInput {
    const result = validateLoopInput(input, this.now());
    if (!result.ok) throw new LoopValidationError(result.reason);
    const value = result.value;
    // FR-LOOP-008 AC-2: the tab must be one the user opened, and there while the loop is on.
    if (value.target.kind === 'session') {
      const tab = this.runtime.inspectTab(value.target.tabId);
      if (tab && this.isScheduleWorkspace(tab.workspaceId)) throw new LoopValidationError('session');
      if (!tab && value.enabled) throw new LoopValidationError('sessionMissing');
      if (tab) value.target.label = { workspaceName: tab.workspaceName, tabName: tab.tabName };
    }
    return value;
  }

  private require(id: string): LoopDefinition {
    const loop = this.file.loops.find((current) => current.id === id);
    if (!loop) throw new LoopNotFoundError(id);
    return loop;
  }

  private async load(): Promise<LoopFile> {
    let raw: string;
    try {
      raw = await fs.readFile(this.dataFilePath, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyFile();
      throw error;
    }
    const parsed = JSON.parse(raw) as Partial<LoopFile>;
    return { ...emptyFile(), ...parsed, version: 1 };
  }

  private persist(): Promise<void> {
    const contents = JSON.stringify(this.file, null, 2);
    this.writeChain = this.writeChain
      .catch(() => undefined)
      .then(() => publishStoreAtomically(this.dataFilePath, contents, { ensureDirectory: true }));
    return this.writeChain;
  }
}

/** FR-LOOP-008 AC-1: a loop stored with top-level shell, cwd and keepTabs becomes a new-session loop. */
function withTarget(stored: LoopDefinition): LoopDefinition {
  const legacy = stored as LoopDefinition & { shell?: ShellType; cwd?: string; keepTabs?: number };
  if (legacy.target) return stored;
  const { shell, cwd, keepTabs, ...rest } = legacy;
  return { ...rest, target: { kind: 'new', shell: shell ?? 'auto', cwd: cwd ?? '', keepTabs: keepTabs ?? 1 } };
}

class InputRejectedError extends Error {
  constructor() {
    super('the session did not take the input');
  }
}

/** An error's code when it has one (AppError), else its text. */
function errorDetail(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && code !== '') return code;
  return error instanceof Error ? error.message : String(error);
}

export class LoopValidationError extends Error {
  constructor(readonly reason: string) {
    super(`Invalid loop: ${reason}`);
  }
}

export class LoopNotFoundError extends Error {
  constructor(readonly loopId: string) {
    super(`Loop not found: ${loopId}`);
  }
}

function emptyFile(): LoopFile {
  return { version: 1, loops: [], runs: {}, counters: {}, scheduleWorkspaces: [], keptTabs: {} };
}
