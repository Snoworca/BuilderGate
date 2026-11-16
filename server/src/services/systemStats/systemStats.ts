// FR-MCP-028: what buildergate.system.stats reports -- CPU, memory, volumes, disk speed and how many
// sessions run -- so a leading session can spread work over the linked servers by their load.
// Sampling starts with the first call and stops when nobody has asked for a while.

export interface CpuTimes {
  user: number;
  nice: number;
  sys: number;
  idle: number;
  irq: number;
}

/** Cumulative counters of one physical disk at one moment. */
export interface DiskCounters {
  name: string;
  readBytes: number;
  writeBytes: number;
  /** Time the disk was busy since boot. */
  busySeconds: number;
  atSeconds: number;
}

export interface DiskRate {
  name: string;
  readBytesPerSec: number;
  writeBytesPerSec: number;
  busyPercent: number;
}

export interface VolumeUsage {
  mount: string;
  totalBytes: number;
  usedBytes: number;
}

export interface SystemStats {
  hostname: string;
  platform: string;
  cpu: { model: string; cores: number; usagePercent: number; avg1mPercent: number; loadAvg: number[] };
  memory: { totalBytes: number; usedBytes: number; usedPercent: number };
  volumes: Array<VolumeUsage & { usedPercent: number }>;
  /** null where disk speed cannot be read on this OS; empty until two readings exist. */
  disks: DiskRate[] | null;
  sessions: { total: number; agents: number };
  sampledAt: string;
}

export interface SystemStatsDeps {
  now: () => number;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
  hostname: () => string;
  platform: string;
  cpuModel: () => string;
  readCpuTimes: () => CpuTimes[];
  loadAvg: () => number[];
  memory: () => { totalBytes: number; freeBytes: number };
  volumes: () => Promise<VolumeUsage[]>;
  /** Absent where disk speed cannot be read. */
  readDiskCounters?: () => Promise<DiskCounters[]>;
  /** Called when sampling stops, so a long-lived reader can end. */
  onStop?: () => void;
  sessions: () => { total: number; agents: number };
}

/** AC-4. */
export const SYSTEM_STATS_INTERVAL_MS = 2_000;
export const IDLE_STOP_MS = 10 * 60_000;
const AVERAGE_WINDOW_MS = 60_000;

const round1 = (value: number) => Math.round(value * 10) / 10;
const percent = (part: number, whole: number) => (whole > 0 ? round1((part / whole) * 100) : 0);

/** AC-2: the busy share of the time between two readings, over all cores. */
export function cpuUsagePercent(before: readonly CpuTimes[], after: readonly CpuTimes[]): number {
  if (before.length !== after.length) return 0;
  let busy = 0;
  let total = 0;
  after.forEach((next, index) => {
    const prev = before[index]!;
    const nextBusy = next.user + next.nice + next.sys + next.irq;
    const prevBusy = prev.user + prev.nice + prev.sys + prev.irq;
    busy += nextBusy - prevBusy;
    total += nextBusy + next.idle - prevBusy - prev.idle;
  });
  return total > 0 ? percent(Math.max(0, busy), total) : 0;
}

const PHYSICAL_DISK = /^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|hd[a-z]+|nvme\d+n\d+|mmcblk\d+)$/u;
const SECTOR_BYTES = 512;

/** AC-3: /proc/diskstats, whole physical disks only (no partitions, loop or ram devices). */
export function parseProcDiskstats(text: string, atSeconds: number): DiskCounters[] {
  const out: DiskCounters[] = [];
  for (const line of text.split('\n')) {
    const field = line.trim().split(/\s+/u);
    const name = field[2];
    if (!name || !PHYSICAL_DISK.test(name) || field.length < 13) continue;
    out.push({
      name,
      readBytes: Number(field[5]) * SECTOR_BYTES,
      writeBytes: Number(field[9]) * SECTOR_BYTES,
      busySeconds: Number(field[12]) / 1000,
      atSeconds,
    });
  }
  return out;
}

const HUNDRED_NS_PER_SECOND = 10_000_000;

/** AC-3: one line of Win32_PerfRawData_PerfDisk_PhysicalDisk as JSON (an array, or one object). */
export function parseWindowsDiskCounters(line: string): DiskCounters[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const out: DiskCounters[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const record = row as Record<string, unknown>;
    const name = String(record.Name ?? '');
    const at = Number(record.Timestamp_Sys100NS);
    if (!name || name === '_Total' || !Number.isFinite(at)) continue;
    out.push({
      name,
      readBytes: Number(record.DiskReadBytesPersec),
      writeBytes: Number(record.DiskWriteBytesPersec),
      busySeconds: (at - Number(record.PercentIdleTime)) / HUNDRED_NS_PER_SECOND,
      atSeconds: at / HUNDRED_NS_PER_SECOND,
    });
  }
  return out;
}

/** AC-3: the rate of each disk present in both readings. */
export function diskRates(before: readonly DiskCounters[], after: readonly DiskCounters[]): DiskRate[] {
  const out: DiskRate[] = [];
  for (const next of after) {
    const prev = before.find((disk) => disk.name === next.name);
    if (!prev) continue;
    const seconds = next.atSeconds - prev.atSeconds;
    const read = next.readBytes - prev.readBytes;
    const written = next.writeBytes - prev.writeBytes;
    if (seconds <= 0 || read < 0 || written < 0) continue;
    out.push({
      name: next.name,
      readBytesPerSec: Math.round(read / seconds),
      writeBytesPerSec: Math.round(written / seconds),
      busyPercent: Math.min(100, Math.max(0, round1(((next.busySeconds - prev.busySeconds) / seconds) * 100))),
    });
  }
  return out;
}

const REAL_FILE_SYSTEMS = new Set(['ext2', 'ext3', 'ext4', 'xfs', 'btrfs', 'zfs', 'f2fs', 'jfs', 'reiserfs', 'ntfs', 'ntfs3', 'vfat', 'exfat']);

/** AC-1: the mount points of real file systems in /proc/mounts, the first mount of each device. */
export function parseProcMounts(text: string): string[] {
  const devices = new Set<string>();
  const mounts: string[] = [];
  for (const line of text.split('\n')) {
    const [device, rawMount, type] = line.trim().split(/\s+/u);
    if (!device || !rawMount || !type || !REAL_FILE_SYSTEMS.has(type) || devices.has(device)) continue;
    const mount = rawMount.replace(/\\040/gu, ' ');
    if (mount.startsWith('/snap/')) continue;
    devices.add(device);
    mounts.push(mount);
  }
  return mounts;
}

/** AC-1/AC-4: samples while someone asks; the first call waits for one CPU reading. */
export function createSystemStatsSampler(deps: SystemStatsDeps) {
  let timer: unknown;
  let lastCpu: CpuTimes[] | undefined;
  let latestCpu: number | undefined;
  let history: Array<{ at: number; value: number }> = [];
  let prevDisks: DiskCounters[] | undefined;
  let latestDisks: DiskRate[] = [];
  let lastCallAt = 0;
  let firstReading: Promise<void> | undefined;
  let resolveFirst: (() => void) | undefined;

  // Review M6: a reading still running when sampling stops must not touch the next run.
  let generation = 0;

  const stop = () => {
    generation += 1;
    if (timer !== undefined) deps.clearInterval(timer);
    timer = undefined;
    lastCpu = undefined;
    latestCpu = undefined;
    history = [];
    prevDisks = undefined;
    latestDisks = [];
    resolveFirst?.();
    resolveFirst = undefined;
    firstReading = undefined;
    deps.onStop?.();
  };

  const readDisks = async (run: number) => {
    if (!deps.readDiskCounters) return;
    const counters = await deps.readDiskCounters().catch(() => undefined);
    if (!counters || run !== generation) return;
    if (prevDisks) latestDisks = diskRates(prevDisks, counters);
    prevDisks = counters;
  };

  const readCpu = (): CpuTimes[] | undefined => {
    try {
      return deps.readCpuTimes();
    } catch {
      return undefined;
    }
  };

  // Review H1: a tick never rejects, and it always lets the first call through.
  const tick = async () => {
    const run = generation;
    try {
      const now = deps.now();
      if (now - lastCallAt > IDLE_STOP_MS) {
        stop();
        return;
      }
      const times = readCpu();
      if (times && lastCpu) {
        latestCpu = cpuUsagePercent(lastCpu, times);
        history = [...history.filter((entry) => now - entry.at < AVERAGE_WINDOW_MS), { at: now, value: latestCpu }];
      }
      if (times) lastCpu = times;
      await readDisks(run);
    } catch {
      // A failed reading leaves the previous figures in place.
    } finally {
      if (run === generation) {
        resolveFirst?.();
        resolveFirst = undefined;
      }
    }
  };

  const start = () => {
    lastCpu = readCpu();
    firstReading = new Promise<void>((resolve) => { resolveFirst = resolve; });
    void readDisks(generation);
    timer = deps.setInterval(() => { void tick(); }, SYSTEM_STATS_INTERVAL_MS);
  };

  return {
    snapshot: async (): Promise<SystemStats> => {
      lastCallAt = deps.now();
      if (timer === undefined) start();
      if (latestCpu === undefined) await firstReading;
      const memory = deps.memory();
      const usedMemory = Math.max(0, memory.totalBytes - memory.freeBytes);
      const volumes = (await deps.volumes().catch(() => [])).map((volume) => ({ ...volume, usedPercent: percent(volume.usedBytes, volume.totalBytes) }));
      const average = history.length > 0 ? round1(history.reduce((sum, entry) => sum + entry.value, 0) / history.length) : latestCpu ?? 0;
      return {
        hostname: deps.hostname(),
        platform: deps.platform,
        cpu: { model: deps.cpuModel(), cores: lastCpu?.length ?? 0, usagePercent: latestCpu ?? 0, avg1mPercent: average, loadAvg: deps.loadAvg() },
        memory: { totalBytes: memory.totalBytes, usedBytes: usedMemory, usedPercent: percent(usedMemory, memory.totalBytes) },
        volumes,
        disks: deps.readDiskCounters ? latestDisks : null,
        sessions: deps.sessions(),
        sampledAt: new Date(deps.now()).toISOString(),
      };
    },
    stop,
  };
}
