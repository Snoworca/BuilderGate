// FR-MCP-028: the operating system behind SystemStatsDeps. Read-only: nothing here changes or stops
// anything but the one PowerShell reader it starts itself.
import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import {
  parseProcDiskstats,
  parseProcMounts,
  parseWindowsDiskCounters,
  SYSTEM_STATS_INTERVAL_MS,
  type DiskCounters,
  type SystemStatsDeps,
  type VolumeUsage,
} from './systemStats.js';

const WINDOWS_DISK_QUERY = [
  '$ErrorActionPreference = "SilentlyContinue";',
  'while ($true) {',
  '  Get-CimInstance Win32_PerfRawData_PerfDisk_PhysicalDisk |',
  '    Select-Object Name,DiskReadBytesPersec,DiskWriteBytesPersec,PercentIdleTime,Timestamp_Sys100NS |',
  '    ConvertTo-Json -Compress;',
  `  Start-Sleep -Milliseconds ${SYSTEM_STATS_INTERVAL_MS}`,
  '}',
].join(' ');

/**
 * AC-3: one PowerShell for as long as sampling runs, printing a JSON line per reading. Performance
 * counter names are localized on Windows; the WMI class and property names are not.
 */
function createWindowsDiskReader() {
  let child: ChildProcess | undefined;
  let latest: DiskCounters[] = [];
  let buffer = '';
  // Review M4: a PowerShell that ends right away is not started again and again.
  let quickExits = 0;
  return {
    read: async (): Promise<DiskCounters[]> => {
      if (!child && quickExits < MAX_QUICK_EXITS) {
        const startedAt = Date.now();
        const self = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_DISK_QUERY], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
        child = self;
        // Review H2: a PowerShell that cannot start must not take the server down.
        self.on('error', () => { if (child === self) child = undefined; quickExits += 1; });
        self.stdout?.setEncoding('utf8');
        self.stdout?.on('data', (chunk: string) => {
          // Review M6: output of a reader that was stopped is ignored.
          if (child !== self) return;
          buffer = (buffer + chunk).slice(-MAX_BUFFER_CHARS);
          const lines = buffer.split(/\r?\n/u);
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            const counters = line.trim() ? parseWindowsDiskCounters(line) : [];
            if (counters.length > 0) latest = counters;
          }
        });
        // Review H3: only this process's own exit clears the reference.
        self.on('exit', () => {
          if (Date.now() - startedAt < QUICK_EXIT_MS) quickExits += 1;
          if (child === self) child = undefined;
        });
      }
      return latest;
    },
    stop: () => {
      child?.kill();
      child = undefined;
      latest = [];
      buffer = '';
    },
  };
}

const QUICK_EXIT_MS = 10_000;
const MAX_QUICK_EXITS = 3;
/** Review L7: one JSON line is a few kilobytes; never keep more than this of an unended line. */
const MAX_BUFFER_CHARS = 1_000_000;

async function linuxVolumes(): Promise<VolumeUsage[]> {
  const mounts = parseProcMounts(await fs.readFile('/proc/mounts', 'utf8'));
  return statVolumes(mounts);
}

/**
 * Review M5: no synchronous drive checks on the event loop (a lost network drive can hang them).
 * statfs runs off the loop and a missing letter fails at once; the answer is kept for a while.
 */
let windowsVolumeCache: { at: number; value: Promise<VolumeUsage[]> } | undefined;
function windowsVolumes(): Promise<VolumeUsage[]> {
  const now = Date.now();
  if (!windowsVolumeCache || now - windowsVolumeCache.at > WINDOWS_VOLUME_TTL_MS) {
    const letters: string[] = [];
    for (let code = 'C'.charCodeAt(0); code <= 'Z'.charCodeAt(0); code += 1) letters.push(`${String.fromCharCode(code)}:\\`);
    windowsVolumeCache = { at: now, value: statVolumes(letters) };
  }
  return windowsVolumeCache.value;
}
const WINDOWS_VOLUME_TTL_MS = 30_000;

async function statVolumes(mounts: readonly string[]): Promise<VolumeUsage[]> {
  const out: VolumeUsage[] = [];
  for (const mount of mounts) {
    const stat = await fs.statfs(mount).catch(() => undefined);
    if (!stat || stat.blocks === 0) continue;
    out.push({ mount, totalBytes: stat.blocks * stat.bsize, usedBytes: (stat.blocks - stat.bfree) * stat.bsize });
  }
  return out;
}

/** The deps for this machine; `sessions` comes from the caller (the workspace service). */
export function createOsSystemStatsDeps(sessions: SystemStatsDeps['sessions']): SystemStatsDeps {
  const platform = process.platform;
  const windowsDisks = platform === 'win32' ? createWindowsDiskReader() : undefined;
  const readDiskCounters = platform === 'linux'
    ? async () => parseProcDiskstats(await fs.readFile('/proc/diskstats', 'utf8'), Date.now() / 1000)
    : windowsDisks?.read;
  return {
    now: () => Date.now(),
    setInterval: (fn, ms) => {
      const handle = setInterval(fn, ms);
      handle.unref?.();
      return handle;
    },
    clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
    hostname: () => os.hostname(),
    platform,
    cpuModel: () => os.cpus()[0]?.model.trim() ?? 'unknown',
    readCpuTimes: () => os.cpus().map((core) => core.times),
    loadAvg: () => os.loadavg().map((value) => Math.round(value * 100) / 100),
    memory: () => ({ totalBytes: os.totalmem(), freeBytes: os.freemem() }),
    volumes: platform === 'linux' ? linuxVolumes : platform === 'win32' ? windowsVolumes : () => statVolumes(['/']),
    ...(readDiskCounters ? { readDiskCounters } : {}),
    ...(windowsDisks ? { onStop: windowsDisks.stop } : {}),
    sessions,
  };
}
