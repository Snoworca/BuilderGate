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
  killFn?: (pid: number, signal?: NodeJS.Signals | number) => void;
  processInfoProvider?: (pid: number) => Promise<ProcessInfoSnapshot>;
  platform?: NodeJS.Platform;
}

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

function parseWindowsProcessJson(pid: number, raw: string): ProcessInfoSnapshot {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === 'null' || trimmed === '{}') {
    return {
      pid,
      running: false,
      startIdentity: null,
      cwd: null,
      childPids: [],
    };
  }

  const parsed = JSON.parse(trimmed) as {
    ProcessId?: number;
    CreationDate?: string | null;
    ExecutablePath?: string | null;
    CommandLine?: string | null;
    Children?: number[] | number | null;
  };
  const children = Array.isArray(parsed.Children)
    ? parsed.Children
    : typeof parsed.Children === 'number'
      ? [parsed.Children]
      : [];
  const creationDate = typeof parsed.CreationDate === 'string' && parsed.CreationDate.length > 0
    ? parsed.CreationDate
    : null;

  return {
    pid,
    running: normalizePid(parsed.ProcessId) === pid,
    startIdentity: creationDate ? `win32:${pid}:${creationDate}` : null,
    cwd: null,
    commandLine: parsed.CommandLine ?? null,
    executablePath: parsed.ExecutablePath ?? null,
    childPids: normalizePids(children, 256),
  };
}

function buildWindowsProcessQueryScript(pid: number): string {
  return [
    '$ErrorActionPreference = "Stop"',
    `$root = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"`,
    'if ($null -eq $root) { Write-Output "{}"; exit 0 }',
    '$seen = @{}',
    '$children = New-Object "System.Collections.Generic.List[int]"',
    '$pending = New-Object "System.Collections.Generic.Queue[int]"',
    '$seen[[int]$root.ProcessId] = $true',
    '$pending.Enqueue([int]$root.ProcessId)',
    'while ($pending.Count -gt 0) {',
    '  $parent = $pending.Dequeue()',
    '  Get-CimInstance Win32_Process -Filter "ParentProcessId=$parent" | ForEach-Object {',
    '    $childPid = [int]$_.ProcessId',
    '    if (-not $seen.ContainsKey($childPid)) {',
    '      $seen[$childPid] = $true',
    '      [void]$children.Add($childPid)',
    '      $pending.Enqueue($childPid)',
    '    }',
    '  }',
    '}',
    '$creation = if ($root.CreationDate) { $root.CreationDate.ToUniversalTime().ToString("o") } else { $null }',
    '[pscustomobject]@{',
    '  ProcessId = [int]$root.ProcessId;',
    '  CreationDate = $creation;',
    '  ExecutablePath = $root.ExecutablePath;',
    '  CommandLine = $root.CommandLine;',
    '  Children = @($children.ToArray())',
    '} | ConvertTo-Json -Compress',
  ].join('; ');
}

function queryWindowsProcessInfo(
  pid: number,
  execFileFn: typeof execFile,
): Promise<ProcessInfoSnapshot> {
  return new Promise((resolve) => {
    execFileFn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', buildWindowsProcessQueryScript(pid)],
      { windowsHide: true, shell: false, timeout: 1500 },
      (error, stdout) => {
        if (error) {
          resolve({
            pid,
            running: isProcessRunning(pid),
            startIdentity: null,
            cwd: null,
            childPids: [],
          });
          return;
        }
        try {
          resolve(parseWindowsProcessJson(pid, String(stdout)));
        } catch {
          resolve({
            pid,
            running: isProcessRunning(pid),
            startIdentity: null,
            cwd: null,
            childPids: [],
          });
        }
      },
    );
  });
}

export async function readProcessStartIdentity(
  pid: number | null,
  platform: NodeJS.Platform = process.platform,
  execFileFn: typeof execFile = execFile,
  timeoutMs = 3000,
): Promise<string | null> {
  const normalizedPid = normalizePid(pid);
  if (normalizedPid === null || !isProcessRunning(normalizedPid)) {
    return null;
  }

  if (platform === 'win32') {
    return await new Promise<string | null>((resolve) => {
      execFileFn(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          [
            '$ErrorActionPreference = "Stop"',
            `$root = Get-CimInstance Win32_Process -Filter "ProcessId=${normalizedPid}"`,
            'if ($null -eq $root -or $null -eq $root.CreationDate) { exit 0 }',
            '$root.CreationDate.ToUniversalTime().ToString("o")',
          ].join('; '),
        ],
        { encoding: 'utf8', windowsHide: true, timeout: timeoutMs },
        (error, stdout) => {
          if (error) {
            resolve(null);
            return;
          }
          const trimmed = String(stdout ?? '').trim();
          resolve(trimmed ? `win32:${normalizedPid}:${trimmed}` : null);
        },
      );
    });
  }

  const stat = readLinuxProcStat(normalizedPid);
  return stat?.startTicks ? `procfs:${normalizedPid}:${stat.startTicks}` : null;
}

export function createDefaultProcessInfoProvider(
  deps: {
    platform?: NodeJS.Platform;
    execFileFn?: typeof execFile;
  } = {},
): (pid: number) => Promise<ProcessInfoSnapshot> {
  const platform = deps.platform ?? process.platform;
  const execFileFn = deps.execFileFn ?? execFile;
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
      return queryWindowsProcessInfo(rootPid, execFileFn);
    }
    return readPosixProcessInfo(rootPid);
  };
}

export class DefaultProcessTreeTerminator implements ProcessTreeTerminator {
  private readonly execFileFn: typeof execFile;
  private readonly killFn: (pid: number, signal?: NodeJS.Signals | number) => void;
  private readonly processInfoProvider: (pid: number) => Promise<ProcessInfoSnapshot>;
  private readonly platform: NodeJS.Platform;

  constructor(deps: ProcessTreeTerminatorDeps = {}) {
    this.execFileFn = deps.execFileFn ?? execFile;
    this.killFn = deps.killFn ?? process.kill.bind(process);
    this.platform = deps.platform ?? process.platform;
    this.processInfoProvider = deps.processInfoProvider ?? createDefaultProcessInfoProvider({
      platform: this.platform,
      execFileFn: this.execFileFn,
    });
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
      const remaining = await this.inspectAfterDelay(metadata, options.gracefulWaitMs, options, inspection.descendantPids);
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
    let remaining = await this.inspectAfterDelay(metadata, options.gracefulWaitMs, options, inspection.descendantPids);
    if (remaining.remainingPids.length > 0 && remaining.unverifiedPids.length === 0) {
      const forcePids = this.signalPosixTree(rootPid, remaining.remainingPids.filter(pid => pid !== rootPid), method, 'SIGKILL');
      for (const pid of forcePids) {
        if (!terminatedPids.includes(pid)) {
          terminatedPids.push(pid);
        }
      }
      remaining = await this.inspectAfterDelay(metadata, options.forceWaitMs, options, inspection.descendantPids);
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
          const info = await this.processInfoProvider(pid);
          if (info.running) {
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
