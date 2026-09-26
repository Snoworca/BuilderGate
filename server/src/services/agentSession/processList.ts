// The OS process table, read once per save so a tab's agent can be found
// under its PTY shell (FR-AITUI-006 AC-1). Read-only: nothing here signals
// or stops a process.

import { execFile } from 'node:child_process';
import type { ProcessInfo } from './agentSessionResolver.js';

const WINDOWS_QUERY = [
  'Get-CimInstance Win32_Process |',
  'Select-Object ProcessId,ParentProcessId,Name,CommandLine,',
  "@{n='Created';e={ if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { 0 } }} |",
  'ConvertTo-Json -Compress -Depth 2',
].join(' ');

export function parseWindowsProcessJson(text: string): ProcessInfo[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed) as unknown;
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const out: ProcessInfo[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const record = row as Record<string, unknown>;
    const pid = Number(record.ProcessId);
    const ppid = Number(record.ParentProcessId);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    const created = Number(record.Created);
    out.push({
      pid,
      ppid,
      name: String(record.Name ?? ''),
      ...(created > 0 ? { createdAtMs: created } : {}),
      ...(typeof record.CommandLine === 'string' ? { commandLine: record.CommandLine } : {}),
    });
  }
  return out;
}

/** `ps -eo pid=,ppid=,etimes=,comm=,args=` */
export function parsePsOutput(text: string, nowMs: number): ProcessInfo[] {
  const out: ProcessInfo[] = [];
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(line);
    if (!match) continue;
    out.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      createdAtMs: nowMs - Number(match[3]) * 1000,
      name: match[4],
      commandLine: match[5],
    });
  }
  return out;
}

function run(file: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

export async function listProcesses(): Promise<ProcessInfo[]> {
  if (process.platform === 'win32') {
    const stdout = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_QUERY], 20_000);
    return parseWindowsProcessJson(stdout);
  }
  const stdout = await run('ps', ['-eo', 'pid=,ppid=,etimes=,comm=,args='], 10_000);
  return parsePsOutput(stdout, Date.now());
}
