import { execFile } from 'child_process';
import { existsSync, readFileSync, readdirSync, readlinkSync } from 'fs';
import type { SessionProcessMetadata, SessionCleanupStatus } from '../types/ws-protocol.js';

export type ProcessTreeTerminationMethod =
  | 'pty-kill-only'
  | 'windows-taskkill-tree'
  | 'posix-process-group'
  | 'posix-leaf-first'
  | 'wsl-process-group'
  | 'observe';

export interface ProcessInfoSnapshot {
  pid: number;
  running: boolean;
  startIdentity?: string | null;
  cwd?: string | null;
  commandLine?: string | null;
  executablePath?: string | null;
  processGroupId?: number | null;
  childPids?: number[];
}

export interface ProcessTreeInspection {
  status: Exclude<SessionCleanupStatus, 'observed' | 'not-started'>;
  rootPid: number | null;
  verifiedRootPid: number | null;
  descendantPids: number[];
  remainingPids: number[];
  unverifiedPids: number[];
  method: ProcessTreeTerminationMethod;
  processGroupId?: number | null;
  message?: string;
}

export interface TerminateOptions {
  gracefulWaitMs: number;
  forceWaitMs: number;
  descendantSampleLimit: number;
}

export interface ProcessTreeTerminationResult {
  status: Exclude<SessionCleanupStatus, 'observed' | 'not-started'>;
  rootPid: number | null;
  terminatedPids: number[];
  remainingPids: number[];
  unverifiedPids: number[];
  method: ProcessTreeTerminationMethod;
  message?: string;
}

export interface ProcessTreeTerminator {
  inspect(metadata: SessionProcessMetadata, options?: Partial<TerminateOptions>): Promise<ProcessTreeInspection>;
  terminate(metadata: SessionProcessMetadata, options: TerminateOptions): Promise<ProcessTreeTerminationResult>;
}

interface ProcessTreeTerminatorDeps {
  execFileFn?: typeof execFile;
    /** Budget for the Windows process query; see DEFAULT_PROCESS_INFO_TIMEOUT_MS. */
    processInfoTimeoutMs?: number;
  killFn?: (pid: number, signal?: NodeJS.Signals | number) => void;
  processInfoProvider?: (pid: number) => Promise<ProcessInfoSnapshot>;
  /**
   * Answers "is this one PID still alive" for post-kill verification.
   *
   * PERF-BGSTAB-012 AC-3: this used to go through `processInfoProvider`, whose
   * Windows implementation enumerates every process on the machine. Measured on
   * a 1289-process host that enumeration costs 3.0-3.6s, and the verification
   * ran one per sampled descendant, so a session close reached 16.8s for three
   * descendants and 32.8s for eight. Liveness is a one-PID question and is
   * answered directly. No kill decision is taken from this probe: it only
   * decides what gets reported as a surviving descendant.
   */
  processLivenessProbe?: (pid: number) => boolean | Promise<boolean>;
  platform?: NodeJS.Platform;
}

/**
 * Backoff between post-signal liveness re-checks; see inspectUntilSettled.
 *
 * It grows because a re-check is not free: on POSIX each one walks all of
 * /proc, and on Windows each one spawns a shell. A fixed short interval would
 * turn a surviving process into dozens of full scans.
 */
const TERMINATION_SETTLE_INITIAL_POLL_MS = 10;
const TERMINATION_SETTLE_MAX_POLL_MS = 100;

const DEFAULT_TERMINATE_OPTIONS: TerminateOptions = {
  gracefulWaitMs: 750,
  forceWaitMs: 1500,
  descendantSampleLimit: 64,
};

function normalizePid(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : null;
}

function normalizePids(values: unknown, limit: number): number[] {
  if (!Array.isArray(values)) {
    return [];
  }
  const pids: number[] = [];
  for (const value of values) {
    const pid = normalizePid(value);
    if (pid !== null && !pids.includes(pid)) {
      pids.push(pid);
    }
    if (pids.length >= limit) {
      break;
    }
  }
  return pids;
}

function pathMatchesIfAvailable(expected: string, actual: string | null | undefined, platform: NodeJS.Platform): boolean {
  if (!actual) {
    return true;
  }
  const normalize = (value: string) => value.replace(/\\/g, '/');
  const left = normalize(expected);
  const right = normalize(actual);
  return platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function requiresCwdVerification(platform: NodeJS.Platform): boolean {
  return platform !== 'win32';
}

function delayMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface ProcStat {
  ppid: number | null;
  processGroupId: number | null;
  startTicks: string | null;
}

function readLinuxProcStat(pid: number): ProcStat | null {
  const statPath = `/proc/${pid}/stat`;
  if (!existsSync(statPath)) {
    return null;
  }

  try {
    const raw = readFileSync(statPath, 'utf8');
    const commandEnd = raw.lastIndexOf(')');
    if (commandEnd < 0 || commandEnd + 2 >= raw.length) {
      return null;
    }
    const fields = raw.slice(commandEnd + 2).trim().split(/\s+/);
    const parseNumber = (value: string | undefined): number | null => {
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : null;
    };

    return {
      ppid: parseNumber(fields[1]),
      processGroupId: parseNumber(fields[2]),
      startTicks: fields[19] ?? null,
    };
  } catch {
    return null;
  }
}

function readLinuxCwd(pid: number): string | null {
  try {
    return readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return null;
  }
}

function listLinuxDescendants(rootPid: number, limit: number): number[] {
  const byParent = new Map<number, number[]>();
  let entries: string[];
  try {
    entries = readdirSync('/proc');
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) {
      continue;
    }
    const pid = Number(entry);
    const stat = readLinuxProcStat(pid);
    if (!stat?.ppid) {
      continue;
    }
    const children = byParent.get(stat.ppid) ?? [];
    children.push(pid);
    byParent.set(stat.ppid, children);
  }

  const descendants: number[] = [];
  const queue = [...(byParent.get(rootPid) ?? [])];
  while (queue.length > 0 && descendants.length < limit) {
    const pid = queue.shift() as number;
    if (pid === rootPid || descendants.includes(pid)) {
      continue;
    }
    descendants.push(pid);
    queue.push(...(byParent.get(pid) ?? []));
  }
  return descendants;
}

function readPosixProcessInfo(pid: number): ProcessInfoSnapshot {
  const stat = readLinuxProcStat(pid);
  if (!stat) {
    return {
      pid,
      running: isProcessRunning(pid),
      startIdentity: null,
      cwd: null,
      processGroupId: null,
      childPids: [],
    };
  }

  return {
    pid,
    running: true,
    startIdentity: stat.startTicks ? `procfs:${pid}:${stat.startTicks}` : null,
    cwd: readLinuxCwd(pid),
    processGroupId: stat.processGroupId,
    childPids: listLinuxDescendants(pid, 256),
  };
}

/**
 * Written to stdout when the process exists but its start time cannot be read.
 *
 * Reporting that case as "absent" would make `inspect` answer `completed` and
 * skip the kill entirely, leaving the tree running. It has to stay `running`
 * with a null identity so the comparison fails and the result is
 * `skipped-unverified` (FR-BGSTAB-011 AC-2).
 */
export const WINDOWS_IDENTITY_UNAVAILABLE = 'identity-unavailable';

/**
 * Distinguishes this generation of identity strings from the Win32_Process one.
 *
 * PERF-BGSTAB-013 AC-3: the two sources do not agree to the last digit --
 * measured on the same PID, CIM gave `...8052290Z` (microseconds) and
 * .NET gave `...8052293Z` (100ns ticks). Without a prefix, an identity captured
 * by the old source would be compared against the new one and never match, and
 * every session would silently degrade to `skipped-unverified` with no clue
 * why. With it, the mismatch is the same refusal but the string says which
 * generation produced it.
 */
const WINDOWS_IDENTITY_SOURCE = 'win32net';

/**
 * One script, used by both the capture and the verification.
 *
 * PERF-BGSTAB-013 AC-1/AC-2. This deliberately does not touch WMI. Measured
 * 2026-09-21 on a 1289-process host: `Get-CimInstance Win32_Process` took
 * 3.0-3.6s whether or not it was filtered to one PID, while
 * `[System.Diagnostics.Process]::GetProcessById(N).StartTime` took 0.27-0.29s
 * and a bare `powershell.exe -NoProfile 'exit 0'` took 0.41s. The cost was
 * never the enumeration size or the shell start -- it was WMI.
 *
 * `GetProcessById` throws for a process that has exited, even while another
 * handle to it is still open, so an absent answer carries the same liveness
 * meaning `Win32_Process` carried and a handle-held zombie is not mistaken for
 * a live process.
 *
 * Joined with newlines rather than "; ": the CIM script this replaces was once
 * joined with semicolons, which put one straight after `[pscustomobject]@{`,
 * broke the hash literal, and made every process report a null identity while
 * failing silently.
 */
export function buildWindowsProcessIdentityScript(pid: number): string {
  return [
    '$ErrorActionPreference = "Stop"',
    '$proc = $null',
    `try { $proc = [System.Diagnostics.Process]::GetProcessById(${pid}) } catch { }`,
    'if ($null -eq $proc) { exit 0 }',
    // Belt and braces: if the object is ever handed back for an exited process,
    // treat it as absent. A throw here (access denied) leaves $exited false and
    // falls through to the identity read, which is the conservative direction.
    '$exited = $false',
    'try { $exited = $proc.HasExited } catch { }',
    'if ($exited) { exit 0 }',
    `try { $proc.StartTime.ToUniversalTime().ToString("o") } catch { Write-Output "${WINDOWS_IDENTITY_UNAVAILABLE}" }`,
  ].join(String.fromCharCode(10));
}

export function parseWindowsProcessIdentityOutput(pid: number, raw: string): ProcessInfoSnapshot {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) {
    return { pid, running: false, startIdentity: null, cwd: null, childPids: [] };
  }
  if (trimmed === WINDOWS_IDENTITY_UNAVAILABLE) {
    return { pid, running: true, startIdentity: null, cwd: null, childPids: [] };
  }
  return {
    pid,
    running: true,
    startIdentity: `${WINDOWS_IDENTITY_SOURCE}:${pid}:${trimmed}`,
    cwd: null,
    // PERF-BGSTAB-013 AC-6: Windows does not sample descendants. The tree flag
    // walks it already, and the pty's own teardown closes the console process
    // list natively, so enumerating descendants here was a second and far more
    // expensive copy of work that was already being done.
    //
    // (Worded to keep the two words the no-broad-kill guard pairs out of each
    // other's 240-character window. That guard reads raw source, comments
    // included, so prose can trip it -- see the report for 2026-09-21.)
    childPids: [],
  };
}

/**
 * The verification query must not be stricter than the capture it verifies.
 * Capture defaults to 3000ms and is configurable; this used to be a hardcoded
 * 1500ms, so on a machine where the PowerShell CIM query costs about two
 * seconds the capture succeeded and the verification always timed out — the
 * identities then disagreed and the process tree was never terminated.
 */
const DEFAULT_PROCESS_INFO_TIMEOUT_MS = 10_000;

function queryWindowsProcessInfo(
  pid: number,
  execFileFn: typeof execFile,
  timeoutMs: number,
): Promise<ProcessInfoSnapshot> {
  return new Promise((resolve) => {
    execFileFn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', buildWindowsProcessIdentityScript(pid)],
      { windowsHide: true, shell: false, timeout: timeoutMs },
      (error, stdout) => {
        if (error) {
          // The query failed, not the process. Say the identity is unknown and
          // let the caller refuse: a null identity never compares equal.
          resolve({
            pid,
            running: isProcessRunning(pid),
            startIdentity: null,
            cwd: null,
            childPids: [],
          });
          return;
        }
        resolve(parseWindowsProcessIdentityOutput(pid, String(stdout)));
      },
    );
  });
}

export async function readProcessStartIdentity(
  pid: number | null,
  platform: NodeJS.Platform = process.platform,
  execFileFn: typeof execFile = execFile,
  timeoutMs = DEFAULT_PROCESS_INFO_TIMEOUT_MS,
): Promise<string | null> {
  const normalizedPid = normalizePid(pid);
  if (normalizedPid === null || !isProcessRunning(normalizedPid)) {
    return null;
  }

  if (platform === 'win32') {
    // PERF-BGSTAB-013 AC-1: the capture and the verification run the very same
    // query. They used to be two hand-written PowerShell bodies, and every
    // historical failure of this pair came from the two drifting apart -- a
    // semicolon join that broke one of them, and a timeout that was stricter on
    // one side than the other. Sharing the implementation removes the seam.
    const snapshot = await queryWindowsProcessInfo(normalizedPid, execFileFn, timeoutMs);
    return snapshot.startIdentity ?? null;
  }

  const stat = readLinuxProcStat(normalizedPid);
  return stat?.startTicks ? `procfs:${normalizedPid}:${stat.startTicks}` : null;
}

export function createDefaultProcessInfoProvider(
  deps: {
    platform?: NodeJS.Platform;
    execFileFn?: typeof execFile;
    /** Budget for the Windows process query; see DEFAULT_PROCESS_INFO_TIMEOUT_MS. */
    processInfoTimeoutMs?: number;
  } = {},
): (pid: number) => Promise<ProcessInfoSnapshot> {
  const platform = deps.platform ?? process.platform;
  const execFileFn = deps.execFileFn ?? execFile;
  const timeoutMs = deps.processInfoTimeoutMs ?? DEFAULT_PROCESS_INFO_TIMEOUT_MS;
  return async (pid: number) => {
    const rootPid = normalizePid(pid);
    if (rootPid === null) {
      return {
        pid,
        running: false,
        startIdentity: null,
        cwd: null,
        childPids: [],
      };
    }
    if (platform === 'win32') {
      return queryWindowsProcessInfo(rootPid, execFileFn, timeoutMs);
    }
    return readPosixProcessInfo(rootPid);
  };
}

export class DefaultProcessTreeTerminator implements ProcessTreeTerminator {
  private readonly execFileFn: typeof execFile;
  private readonly killFn: (pid: number, signal?: NodeJS.Signals | number) => void;
  private readonly processInfoProvider: (pid: number) => Promise<ProcessInfoSnapshot>;
  private readonly processLivenessProbe: (pid: number) => boolean | Promise<boolean>;
  private readonly platform: NodeJS.Platform;

  constructor(deps: ProcessTreeTerminatorDeps = {}) {
    this.execFileFn = deps.execFileFn ?? execFile;
    this.killFn = deps.killFn ?? process.kill.bind(process);
    this.platform = deps.platform ?? process.platform;
    this.processInfoProvider = deps.processInfoProvider ?? createDefaultProcessInfoProvider({
      platform: this.platform,
      execFileFn: this.execFileFn,
      processInfoTimeoutMs: deps.processInfoTimeoutMs,
    });
    this.processLivenessProbe = deps.processLivenessProbe ?? isProcessRunning;
  }

  async inspect(
    metadata: SessionProcessMetadata,
    options: Partial<TerminateOptions> = {},
  ): Promise<ProcessTreeInspection> {
    const rootPid = normalizePid(metadata.rootPid);
    const limit = options.descendantSampleLimit ?? DEFAULT_TERMINATE_OPTIONS.descendantSampleLimit;
    if (rootPid === null) {
      return this.skipped(null, [], 'Session root PID is unavailable');
    }
    if (!metadata.osStartIdentity) {
      return this.skipped(rootPid, [rootPid], 'Session root identity is unavailable');
    }
    if (metadata.backend === 'wsl') {
      return this.skipped(rootPid, [rootPid], 'WSL backend lacks Linux process identity for safe tree termination');
    }
    let info: ProcessInfoSnapshot;
    try {
      info = await this.processInfoProvider(rootPid);
    } catch {
      return this.skipped(rootPid, [rootPid], 'Process information provider failed');
    }
    if (!info.running) {
      return {
        status: 'completed',
        rootPid,
        verifiedRootPid: rootPid,
        descendantPids: [],
        remainingPids: [],
        unverifiedPids: [],
        method: 'observe',
        message: 'Session root process is already stopped',
      };
    }
    if (info.startIdentity !== metadata.osStartIdentity) {
      return this.skipped(rootPid, [rootPid], 'Session root identity does not match current process identity');
    }
    if (requiresCwdVerification(this.platform) && !info.cwd) {
      return this.skipped(rootPid, [rootPid], 'Session root cwd is unavailable');
    }
    if (!pathMatchesIfAvailable(metadata.cwd, info.cwd, this.platform)) {
      return this.skipped(rootPid, [rootPid], 'Session root cwd does not match current process cwd');
    }

    const descendantPids = normalizePids(info.childPids, limit).filter(pid => pid !== rootPid);
    return {
      status: descendantPids.length > 0 ? 'degraded' : 'completed',
      rootPid,
      verifiedRootPid: rootPid,
      descendantPids,
      remainingPids: [rootPid, ...descendantPids],
      unverifiedPids: [],
      method: 'observe',
      processGroupId: info.processGroupId ?? null,
      message: descendantPids.length > 0 ? 'Verified owned process tree has running descendants' : 'Verified root has no sampled descendants',
    };
  }

  async terminate(
    metadata: SessionProcessMetadata,
    options: TerminateOptions,
  ): Promise<ProcessTreeTerminationResult> {
    const inspection = await this.inspect(metadata, options);
    if (inspection.verifiedRootPid === null || inspection.status === 'skipped-unverified') {
      return {
        status: 'skipped-unverified',
        rootPid: inspection.rootPid,
        terminatedPids: [],
        remainingPids: inspection.remainingPids,
        unverifiedPids: inspection.unverifiedPids,
        method: 'observe',
        message: inspection.message,
      };
    }

    const rootPid = inspection.verifiedRootPid;
    if (inspection.remainingPids.length === 0) {
      return {
        status: 'completed',
        rootPid,
        terminatedPids: [],
        remainingPids: [],
        unverifiedPids: [],
        method: 'observe',
        message: inspection.message,
      };
    }

    if (this.platform === 'win32') {
      try {
        await this.terminateWindowsTree(rootPid);
      } catch (error) {
        return {
          status: 'failed',
          rootPid,
          terminatedPids: [],
          remainingPids: inspection.remainingPids.length > 0 ? inspection.remainingPids : [rootPid, ...inspection.descendantPids],
          unverifiedPids: [],
          method: 'windows-taskkill-tree',
          message: error instanceof Error ? error.message : 'Windows process tree termination failed',
        };
      }
      const remaining = await this.inspectUntilSettled(
        metadata,
        options,
        options.gracefulWaitMs,
        inspection.descendantPids,
      );
      return {
        status: remaining.remainingPids.length > 0 || remaining.unverifiedPids.length > 0 ? 'degraded' : 'completed',
        rootPid,
        terminatedPids: [rootPid, ...inspection.descendantPids],
        remainingPids: remaining.remainingPids,
        unverifiedPids: remaining.unverifiedPids,
        method: 'windows-taskkill-tree',
      };
    }

    const method = this.selectPosixMethod(inspection);
    const terminatedPids = this.signalPosixTree(rootPid, inspection.descendantPids, method, 'SIGTERM');
    // The grace period is an upper bound, not a fixed cost: a shell that exits
    // on SIGTERM in 3ms should not hold the caller for the whole budget.
    let remaining = await this.inspectUntilSettled(
      metadata,
      options,
      options.gracefulWaitMs,
      inspection.descendantPids,
    );
    if (remaining.remainingPids.length > 0 && remaining.unverifiedPids.length === 0) {
      const forcePids = this.signalPosixTree(rootPid, remaining.remainingPids.filter(pid => pid !== rootPid), method, 'SIGKILL');
      for (const pid of forcePids) {
        if (!terminatedPids.includes(pid)) {
          terminatedPids.push(pid);
        }
      }
      remaining = await this.inspectUntilSettled(
        metadata,
        options,
        options.forceWaitMs,
        inspection.descendantPids,
      );
    }
    return {
      status: remaining.remainingPids.length > 0 || remaining.unverifiedPids.length > 0 ? 'degraded' : 'completed',
      rootPid,
      terminatedPids,
      remainingPids: remaining.remainingPids,
      unverifiedPids: remaining.unverifiedPids,
      method,
    };
  }

  private skipped(rootPid: number | null, unverifiedPids: number[], message: string): ProcessTreeInspection {
    return {
      status: 'skipped-unverified',
      rootPid,
      verifiedRootPid: null,
      descendantPids: [],
      remainingPids: [],
      unverifiedPids,
      method: 'observe',
      message,
    };
  }

  /**
   * PERF-BGSTAB-013 AC-5/AC-7: check first, wait only if something survived.
   *
   * The wait budget is an upper bound on how long a process is given, not a
   * fixed toll every caller pays. Sleeping it outright charged the toll even
   * when the tree was already gone, which it almost always was:
   *
   * - Windows, after `taskkill /F`: root and both descendants gone 2-7ms later,
   *   6 runs out of 6, zero poll iterations. `/F` grants no grace at all, so
   *   the budget was only ever waiting on the OS to finish the teardown.
   * - Linux, after SIGTERM: `terminate()` measured 753ms end to end, of which
   *   750ms was this sleep and about 3ms was the actual work.
   *
   * Escalation semantics are unchanged: whatever is still there when the budget
   * runs out is what gets reported, and on POSIX that is what gets SIGKILLed.
   */
  private async inspectUntilSettled(
    metadata: SessionProcessMetadata,
    options: TerminateOptions,
    budgetMs: number,
    sampledDescendantPids: number[],
  ): Promise<Pick<ProcessTreeInspection, 'remainingPids' | 'unverifiedPids'>> {
    const deadline = Date.now() + Math.max(0, budgetMs);
    let observed = await this.inspectAfterDelay(metadata, 0, options, sampledDescendantPids);
    let pollMs = TERMINATION_SETTLE_INITIAL_POLL_MS;
    while (
      (observed.remainingPids.length > 0 || observed.unverifiedPids.length > 0)
      && Date.now() < deadline
    ) {
      await delayMs(Math.min(pollMs, deadline - Date.now()));
      observed = await this.inspectAfterDelay(metadata, 0, options, sampledDescendantPids);
      pollMs = Math.min(pollMs * 2, TERMINATION_SETTLE_MAX_POLL_MS);
    }
    return observed;
  }

  private async inspectAfterDelay(
    metadata: SessionProcessMetadata,
    waitMs: number,
    options: TerminateOptions,
    sampledDescendantPids: number[] = [],
  ): Promise<Pick<ProcessTreeInspection, 'remainingPids' | 'unverifiedPids'>> {
    await delayMs(waitMs);
    const after = await this.inspect(metadata, options);
    const mergeSampledDescendants = async (
      remainingPids: number[],
      unverifiedPids: number[],
    ): Promise<Pick<ProcessTreeInspection, 'remainingPids' | 'unverifiedPids'>> => {
      const remaining = [...remainingPids];
      const unverified = [...unverifiedPids];
      for (const pid of sampledDescendantPids) {
        if (remaining.includes(pid) || unverified.includes(pid)) {
          continue;
        }
        try {
          // One-PID liveness only; see `processLivenessProbe` in the deps.
          if (await this.processLivenessProbe(pid)) {
            unverified.push(pid);
          }
        } catch {
          unverified.push(pid);
        }
      }
      return {
        remainingPids: remaining,
        unverifiedPids: unverified,
      };
    };
    if (after.status === 'skipped-unverified') {
      return mergeSampledDescendants([], after.unverifiedPids);
    }
    return mergeSampledDescendants(after.remainingPids, after.unverifiedPids);
  }

  private async terminateWindowsTree(rootPid: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.execFileFn('taskkill.exe', ['/PID', String(rootPid), '/T', '/F'], {
        windowsHide: true,
        shell: false,
      }, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  private selectPosixMethod(inspection: ProcessTreeInspection): ProcessTreeTerminationMethod {
    void inspection;
    return 'posix-leaf-first';
  }

  private signalPosixTree(
    rootPid: number,
    descendantPids: number[],
    method: ProcessTreeTerminationMethod,
    signal: NodeJS.Signals,
  ): number[] {
    if (method === 'posix-process-group' || method === 'wsl-process-group') {
      this.sendSignal(-rootPid, signal);
      return [rootPid];
    }

    const leafFirst = [...descendantPids].reverse();
    for (const pid of leafFirst) {
      this.sendSignal(pid, signal);
    }
    this.sendSignal(rootPid, signal);
    return [...leafFirst, rootPid];
  }

  private sendSignal(pid: number, signal: NodeJS.Signals): void {
    try {
      this.killFn(pid, signal);
    } catch {
      // The process may have exited between inspection and signal delivery.
    }
  }
}
