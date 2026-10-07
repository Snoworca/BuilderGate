import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { test } from 'node:test';
import { SessionSnapshotService, type SnapshotTabRecord, type SnapshotTabRuntime } from './SessionSnapshotService.js';
import type { AgentRoots, ProcessInfo } from './agentSession/agentSessionResolver.js';

// NFR-AITUI-001 — one auto save cycle does not hold the event loop that relays terminal output.
// The fixture is the size the requirement names: 50 tabs, 200 Claude session records and
// 365 Codex day folders, with the Codex rollouts in the oldest days so the whole tree is walked.

const TABS = 50;
const CLAUDE_RECORDS = 200;
const CODEX_DAYS = 365;
const CODEX_THREADS = 10;

function uuid(n: number): string {
  const hex = n.toString(16).padStart(12, '0');
  return `0199a2c4-7e1b-7d30-b1c2-${hex}`;
}

function claudeId(n: number): string {
  const hex = n.toString(16).padStart(12, '0');
  return `3f2a9c1e-5b7d-4c11-9a2e-${hex}`;
}

function buildFixture(): { dir: string; make: () => SessionSnapshotService } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bg-snapshot-perf-'));
  const roots: AgentRoots = {
    claudeHome: path.join(dir, 'claude'),
    codexHome: path.join(dir, 'codex'),
    opencodeData: path.join(dir, 'opencode'),
    hermesHome: path.join(dir, 'hermes'),
  };
  const cwdOf = (i: number) => path.join(dir, 'work', `p${i}`);

  // 200 Claude records; the first 30 belong to processes under the first 30 tabs' shells.
  mkdirSync(path.join(roots.claudeHome, 'sessions'), { recursive: true });
  for (let i = 0; i < CLAUDE_RECORDS; i += 1) {
    const pid = 10_000 + i;
    writeFileSync(path.join(roots.claudeHome, 'sessions', `${pid}.json`), JSON.stringify({
      pid, sessionId: claudeId(i), cwd: i < 30 ? cwdOf(i) : path.join(dir, 'elsewhere', String(i)), startedAt: 1000 + i,
    }));
  }

  // 365 Codex day folders; 10 open threads whose rollouts sit in the oldest days.
  const start = Date.UTC(2025, 9, 8);
  const days: string[] = [];
  for (let d = 0; d < CODEX_DAYS; d += 1) {
    const at = new Date(start + d * 86_400_000);
    const day = path.join(roots.codexHome, 'sessions', String(at.getUTCFullYear()), String(at.getUTCMonth() + 1).padStart(2, '0'), String(at.getUTCDate()).padStart(2, '0'));
    mkdirSync(day, { recursive: true });
    writeFileSync(path.join(day, `rollout-filler-${d}.jsonl`), '{}\n');
    days.push(day);
  }
  mkdirSync(path.join(roots.codexHome, 'thread-writer-locks'), { recursive: true });
  for (let t = 0; t < CODEX_THREADS; t += 1) {
    const id = uuid(t);
    writeFileSync(path.join(roots.codexHome, 'thread-writer-locks', `${id}.lock`), '');
    writeFileSync(path.join(days[t], `rollout-2025-10-08T00-00-00-${id}.jsonl`), `${JSON.stringify({
      timestamp: '2025-10-08T00:00:00Z', payload: { cwd: cwdOf(30 + t), timestamp: '2025-10-08T00:00:00Z', source: 'cli' },
    })}\n`);
  }

  // 50 tabs: 30 Claude, 10 Codex, 10 shells.
  const tabs: SnapshotTabRecord[] = [];
  const runtime: Record<string, SnapshotTabRuntime> = {};
  const processes: ProcessInfo[] = [];
  for (let i = 0; i < TABS; i += 1) {
    const sessionId = `s${i}`;
    tabs.push({ workspaceId: `w${i % 5}`, workspaceName: `ws-${i % 5}`, tab: { id: `t${i}`, name: `tab-${i}`, sessionId, lastCwd: cwdOf(i) } });
    const ptyPid = 5000 + i;
    processes.push({ pid: ptyPid, ppid: 1, name: 'powershell.exe' });
    if (i < 30) {
      runtime[sessionId] = { foregroundAppId: 'claude', ptyPid, cwd: cwdOf(i) };
      processes.push({ pid: 10_000 + i, ppid: ptyPid, name: 'claude.exe', createdAtMs: 1000 + i });
    } else if (i < 40) {
      runtime[sessionId] = { foregroundAppId: 'codex', ptyPid, cwd: cwdOf(i) };
      processes.push({ pid: 20_000 + i, ppid: ptyPid, name: 'codex.exe' });
    } else {
      runtime[sessionId] = { foregroundAppId: null, ptyPid, cwd: cwdOf(i) };
    }
  }

  const make = () => new SessionSnapshotService({
    dataPath: path.join(dir, 'data', 'session-snapshot.json'),
    listTabs: () => tabs,
    getRuntime: (sessionId) => runtime[sessionId] ?? null,
    scheduleResume: () => true,
    listProcesses: async () => processes,
    rootsFor: async () => roots,
    isPidAlive: () => true,
    isFileLocked: () => true,
  });
  return { dir, make };
}

/** The longest gap between ticks of a 5 ms interval while `work` runs. */
async function longestTickGap(work: () => Promise<unknown>): Promise<number> {
  let last = performance.now();
  let longest = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    longest = Math.max(longest, now - last);
    last = now;
  }, 5);
  try {
    await work();
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    clearInterval(timer);
  }
  return longest;
}

test('NFR-AITUI-001 AC-1: an auto save of 50 tabs keeps the event loop delay under 50 ms', async () => {
  const { dir, make } = buildFixture();
  try {
    const service = make();
    await service.initialize();
    // Warm the module and file caches once, as a running server would have them.
    await service.autoSave();

    const histogram = monitorEventLoopDelay({ resolution: 10 });
    const started = performance.now();
    histogram.enable();
    const outcome = await service.autoSave();
    histogram.disable();
    const elapsed = performance.now() - started;
    assert.equal(outcome.result, 'saved');
    const maxMs = histogram.max / 1e6;
    console.log(`[NFR-AITUI-001] event loop delay max ${maxMs.toFixed(1)} ms, ${histogram.count} samples over ${elapsed.toFixed(0)} ms, one auto save of ${TABS} tabs`);
    // A loop held the whole time takes no samples and reports a max of 0. Measured 2026-10-08:
    // the old per-tab synchronous reads held it for 38 s and the histogram read 0.0 ms.
    // So the samples must cover the save before the max means anything (10 ms resolution;
    // Windows timers tick about every 15.6 ms, hence the slack).
    assert.ok(histogram.count >= Math.floor(elapsed / 40), `only ${histogram.count} samples over ${elapsed.toFixed(0)} ms: the loop was held`);
    assert.ok(maxMs < 50, `event loop delay max ${maxMs.toFixed(1)} ms`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('NFR-AITUI-001 AC-2: output keeps flowing during an auto save: the longest tick gap grows by under 50 ms', async () => {
  const { dir, make } = buildFixture();
  try {
    const service = make();
    await service.initialize();
    await service.autoSave();
    const idle = await longestTickGap(() => new Promise((resolve) => setTimeout(resolve, 300)));
    const saving = await longestTickGap(() => service.autoSave());
    console.log(`[NFR-AITUI-001] longest 5 ms tick gap: idle ${idle.toFixed(1)} ms, during auto save ${saving.toFixed(1)} ms`);
    assert.ok(saving - idle < 50, `idle ${idle.toFixed(1)} ms, during auto save ${saving.toFixed(1)} ms`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
