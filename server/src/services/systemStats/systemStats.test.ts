// FR-MCP-028: CPU, memory and disk figures for buildergate.system.stats, so a leading session can
// spread work over the linked servers by their load.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cpuUsagePercent,
  createSystemStatsSampler,
  diskRates,
  parseProcDiskstats,
  parseProcMounts,
  parseWindowsDiskCounters,
  type CpuTimes,
  type DiskCounters,
  type SystemStatsDeps,
} from './systemStats.js';

const cpu = (user: number, idle: number): CpuTimes => ({ user, nice: 0, sys: 0, idle, irq: 0 });

test('FR-MCP-028 AC-2: CPU usage is the busy share of the time between two readings, over all cores', () => {
  assert.equal(cpuUsagePercent([cpu(100, 900), cpu(100, 900)], [cpu(150, 950), cpu(200, 900)]), 75);
  assert.equal(cpuUsagePercent([cpu(0, 0)], [cpu(0, 0)]), 0, 'no time passed');
  assert.equal(cpuUsagePercent([cpu(0, 0)], [cpu(0, 0), cpu(5, 5)]), 0, 'a changed core list is not compared');
});

test('FR-MCP-028 AC-3: /proc/diskstats gives physical disks only, in bytes and busy seconds', () => {
  const text = [
    '   8       0 sda 100 0 2048 0 50 0 4096 0 0 1500 0',
    '   8       1 sda1 90 0 2000 0 40 0 4000 0 0 1400 0',
    ' 259       0 nvme0n1 10 0 1024 0 10 0 512 0 0 250 0',
    ' 259       1 nvme0n1p1 9 0 1000 0 9 0 500 0 0 240 0',
    '   7       0 loop0 5 0 80 0 0 0 0 0 0 10 0',
    ' 252       0 vda 1 0 8 0 1 0 8 0 0 2000 0',
  ].join('\n');
  assert.deepEqual(parseProcDiskstats(text, 10), [
    { name: 'sda', readBytes: 2048 * 512, writeBytes: 4096 * 512, busySeconds: 1.5, atSeconds: 10 },
    { name: 'nvme0n1', readBytes: 1024 * 512, writeBytes: 512 * 512, busySeconds: 0.25, atSeconds: 10 },
    { name: 'vda', readBytes: 8 * 512, writeBytes: 8 * 512, busySeconds: 2, atSeconds: 10 },
  ]);
});

test('FR-MCP-028 AC-3: Windows raw disk counters become the same counters (busy = time not idle)', () => {
  const line = JSON.stringify([
    { Name: '0 C:', DiskReadBytesPersec: 5_000_000, DiskWriteBytesPersec: 1_000_000, PercentIdleTime: 30_000_000, Timestamp_Sys100NS: 100_000_000 },
    { Name: '_Total', DiskReadBytesPersec: 9, DiskWriteBytesPersec: 9, PercentIdleTime: 9, Timestamp_Sys100NS: 9 },
  ]);
  assert.deepEqual(parseWindowsDiskCounters(line), [
    { name: '0 C:', readBytes: 5_000_000, writeBytes: 1_000_000, busySeconds: 7, atSeconds: 10 },
  ]);
  // One disk is answered as an object, not an array.
  assert.equal(parseWindowsDiskCounters(JSON.stringify({ Name: '1 D:', DiskReadBytesPersec: 1, DiskWriteBytesPersec: 1, PercentIdleTime: 0, Timestamp_Sys100NS: 10_000_000 })).length, 1);
  assert.deepEqual(parseWindowsDiskCounters('not json'), []);
});

test('FR-MCP-028 AC-3: rates are the difference between two readings of the same disk', () => {
  const before: DiskCounters[] = [{ name: 'sda', readBytes: 1_000, writeBytes: 0, busySeconds: 1, atSeconds: 10 }];
  const after: DiskCounters[] = [
    { name: 'sda', readBytes: 5_001_000, writeBytes: 2_000_000, busySeconds: 1.5, atSeconds: 12 },
    { name: 'sdb', readBytes: 9, writeBytes: 9, busySeconds: 9, atSeconds: 12 },
  ];
  assert.deepEqual(diskRates(before, after), [{ name: 'sda', readBytesPerSec: 2_500_000, writeBytesPerSec: 1_000_000, busyPercent: 25 }]);
  // A counter that went backwards (a disk replugged) gives no rate, and busy stays within 0..100.
  assert.deepEqual(diskRates([{ ...before[0]!, readBytes: 9e9 }], [after[0]!]), []);
  assert.equal(diskRates(before, [{ ...after[0]!, busySeconds: 9 }])[0]!.busyPercent, 100);
});

test('FR-MCP-028 AC-1: volumes are the real file systems from /proc/mounts, once per device', () => {
  const text = [
    '/dev/vda4 / ext4 rw,relatime 0 0',
    'tmpfs /run tmpfs rw 0 0',
    '/dev/vda4 /var/lib/docker ext4 rw 0 0',
    '/dev/vda2 /boot ext4 rw 0 0',
    'overlay /var/lib/docker/overlay2/x/merged overlay rw 0 0',
    '/dev/loop3 /snap/core/1 squashfs ro 0 0',
    'C:\\134 /mnt/c 9p rw 0 0',
    '/dev/sdb1 /data xfs rw 0 0',
  ].join('\n');
  assert.deepEqual(parseProcMounts(text), ['/', '/boot', '/data']);
});

class FakeClock {
  now = 0;
  private timers: Array<{ at: number; fn: () => void; every?: number }> = [];
  setInterval = (fn: () => void, ms: number) => { const t = { at: this.now + ms, fn, every: ms }; this.timers.push(t); return t; };
  clearInterval = (t: unknown) => { this.timers = this.timers.filter((x) => x !== t); };
  async advance(ms: number) {
    const end = this.now + ms;
    for (;;) {
      const next = this.timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      this.now = next.at;
      next.at += next.every ?? Infinity;
      next.fn();
      await new Promise((r) => setImmediate(r));
    }
    this.now = end;
    await new Promise((r) => setImmediate(r));
  }
}

function deps(clock: FakeClock, overrides: Partial<SystemStatsDeps> = {}): SystemStatsDeps {
  let reads = 0;
  return {
    now: () => clock.now,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
    hostname: () => 'beom-5700g',
    platform: 'linux',
    cpuModel: () => 'AMD Ryzen 7 5700G with Radeon Graphics',
    // Every read adds 1 busy and 1 idle tick per core: 50 % busy.
    readCpuTimes: () => { reads += 1; return [cpu(reads, reads), cpu(reads, reads)]; },
    loadAvg: () => [1.5, 1.2, 1.0],
    memory: () => ({ totalBytes: 64e9, freeBytes: 16e9 }),
    volumes: async () => [{ mount: '/', totalBytes: 1000, usedBytes: 380 }],
    readDiskCounters: async () => [{ name: 'vda', readBytes: clock.now * 1000, writeBytes: 0, busySeconds: clock.now / 10_000, atSeconds: clock.now / 1000 }],
    sessions: () => ({ total: 4, agents: 2 }),
    ...overrides,
  };
}

test('FR-MCP-028 AC-1/AC-4: the first call waits for one CPU reading; later calls answer the latest at once', async () => {
  const clock = new FakeClock();
  const sampler = createSystemStatsSampler(deps(clock));
  const first = sampler.snapshot();
  let done = false;
  void first.then(() => { done = true; });
  await clock.advance(1_999);
  assert.equal(done, false, 'still waiting for the first interval');
  await clock.advance(1);
  const stats = await first;
  assert.equal(stats.hostname, 'beom-5700g');
  assert.deepEqual(stats.cpu, { model: 'AMD Ryzen 7 5700G with Radeon Graphics', cores: 2, usagePercent: 50, avg1mPercent: 50, loadAvg: [1.5, 1.2, 1.0] });
  assert.deepEqual(stats.memory, { totalBytes: 64e9, usedBytes: 48e9, usedPercent: 75 });
  assert.deepEqual(stats.volumes, [{ mount: '/', totalBytes: 1000, usedBytes: 380, usedPercent: 38 }]);
  assert.deepEqual(stats.disks, [{ name: 'vda', readBytesPerSec: 1_000_000, writeBytesPerSec: 0, busyPercent: 10 }]);
  assert.deepEqual(stats.sessions, { total: 4, agents: 2 });
  await clock.advance(2_000);
  const again = await sampler.snapshot();
  assert.equal(again.sampledAt, new Date(4_000).toISOString());
  sampler.stop();
});

test('FR-MCP-028 AC-4: sampling stops after 10 minutes without a call and starts again on the next one', async () => {
  const clock = new FakeClock();
  let reads = 0;
  const sampler = createSystemStatsSampler(deps(clock, { readCpuTimes: () => { reads += 1; return [cpu(reads, reads)]; } }));
  const first = sampler.snapshot();
  await clock.advance(2_000);
  await first;
  await clock.advance(10 * 60_000 + 4_000);
  const stopped = reads;
  await clock.advance(60_000);
  assert.equal(reads, stopped, 'no readings while nobody asks');
  const later = sampler.snapshot();
  await clock.advance(2_000);
  await later;
  assert.ok(reads > stopped, 'a new call starts it again');
  sampler.stop();
});

test('FR-MCP-028 AC-3/AC-4: disks is null where speed cannot be read, and empty until two readings exist', async () => {
  const clock = new FakeClock();
  const none = createSystemStatsSampler(deps(clock, { readDiskCounters: undefined }));
  const n = none.snapshot();
  await clock.advance(2_000);
  assert.equal((await n).disks, null);
  none.stop();
  let call = 0;
  const slow = createSystemStatsSampler(deps(clock, { readDiskCounters: async () => (call++ === 0 ? [] : [{ name: 'd', readBytes: 0, writeBytes: 0, busySeconds: 0, atSeconds: clock.now / 1000 }]) }));
  const s = slow.snapshot();
  await clock.advance(2_000);
  assert.deepEqual((await s).disks, []);
  slow.stop();
});

test('FR-MCP-028 AC-2: avg1mPercent averages the readings of the last minute', async () => {
  const clock = new FakeClock();
  let reads = 0;
  // Busy share alternates 100 % and 0 %.
  const sampler = createSystemStatsSampler(deps(clock, {
    readCpuTimes: () => { reads += 1; const busy = Math.ceil(reads / 2) * 10; const idle = Math.floor(reads / 2) * 10; return [cpu(busy, idle)]; },
  }));
  const first = sampler.snapshot();
  await clock.advance(2_000);
  await first;
  await clock.advance(20_000);
  const stats = await sampler.snapshot();
  assert.ok(stats.cpu.avg1mPercent > 40 && stats.cpu.avg1mPercent < 60, String(stats.cpu.avg1mPercent));
  sampler.stop();
});

test('FR-MCP-028 (review H1): a reading that throws still answers the first call and raises no unhandled rejection', async () => {
  const clock = new FakeClock();
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  try {
    let calls = 0;
    const sampler = createSystemStatsSampler(deps(clock, { readCpuTimes: () => { calls += 1; if (calls > 1) throw new Error('cpu gone'); return [cpu(1, 1)]; } }));
    const first = sampler.snapshot();
    await clock.advance(2_000);
    const stats = await first;
    assert.equal(stats.cpu.usagePercent, 0);
    await clock.advance(4_000);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(unhandled, []);
    sampler.stop();
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('FR-MCP-028 (review M6): a reading still in flight when sampling stops does not touch the restarted sampler', async () => {
  const clock = new FakeClock();
  let release: (() => void) | undefined;
  let diskCalls = 0;
  const sampler = createSystemStatsSampler(deps(clock, {
    readDiskCounters: async () => {
      diskCalls += 1;
      if (diskCalls === 2) await new Promise<void>((resolve) => { release = resolve; });
      return [{ name: 'd', readBytes: diskCalls === 2 ? 9e9 : 0, writeBytes: 0, busySeconds: 0, atSeconds: diskCalls }];
    },
  }));
  const first = sampler.snapshot();
  await clock.advance(2_000); // tick 1 is now waiting in readDisks (call 2)
  sampler.stop();
  const restarted = sampler.snapshot(); // start: disk call 3
  release?.(); // the old tick wakes up after the restart
  await clock.advance(2_000); // tick of the new run: disk call 4
  const stats = await restarted;
  assert.notEqual(stats.cpu.usagePercent, undefined);
  assert.ok((stats.disks ?? []).every((disk) => disk.readBytesPerSec < 1e9), `old counters leaked: ${JSON.stringify(stats.disks)}`);
  void first;
  sampler.stop();
});
