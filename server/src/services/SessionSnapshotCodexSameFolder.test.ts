import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { SessionSnapshotService, type SnapshotTabRecord, type SnapshotTabRuntime } from './SessionSnapshotService.js';
import type { AgentRoots, ProcessInfo } from './agentSession/agentSessionResolver.js';

// FR-AITUI-021 (#203): two tabs run Codex in one folder and only one of them has opened a thread
// (a Codex that has written nothing holds no writer lock). The one locked thread was saved for
// both tabs, so a restore reopened the same conversation twice.

const CWD = process.platform === 'win32' ? 'C:\\Work\\pm' : '/work/pm';
const THREAD = '0199a2c4-7e1b-7d30-b1c2-44f0e9a1d3b8';

function codexTab(ptyPid: number, codexPid: number, startedAtMs: number): ProcessInfo[] {
  return [
    { pid: ptyPid, ppid: 1, name: 'cmd.exe' },
    { pid: codexPid, ppid: ptyPid, name: 'codex.exe', commandLine: 'C:\\npm\\vendor\\codex.exe', createdAtMs: startedAtMs },
  ];
}

async function previewTwoCodexTabs(startA: number, startB: number, lockedAt: number, listed = true) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bg-snapshot-codex-'));
  try {
    const roots: AgentRoots = {
      claudeHome: path.join(dir, 'claude'),
      codexHome: path.join(dir, 'codex'),
      opencodeData: path.join(dir, 'opencode'),
      hermesHome: path.join(dir, 'hermes'),
    };
    const day = path.join(roots.codexHome, 'sessions', '2026', '10', '29');
    mkdirSync(day, { recursive: true });
    writeFileSync(path.join(day, `rollout-2026-10-29T00-00-00-${THREAD}.jsonl`), `${JSON.stringify({
      type: 'session_meta',
      payload: { id: THREAD, timestamp: new Date(lockedAt).toISOString(), cwd: CWD, source: 'cli', originator: 'codex-tui' },
    })}\n`);
    const lockDir = path.join(roots.codexHome, 'thread-writer-locks');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(path.join(lockDir, `${THREAD}.lock`), '');
    utimesSync(path.join(lockDir, `${THREAD}.lock`), lockedAt / 1000, lockedAt / 1000);

    const tabs: SnapshotTabRecord[] = [
      { workspaceId: 'w1', workspaceName: 'pm', tab: { id: 'tA', name: 'a', sessionId: 'sA', lastCwd: CWD } },
      { workspaceId: 'w1', workspaceName: 'pm', tab: { id: 'tB', name: 'b', sessionId: 'sB', lastCwd: CWD } },
    ];
    const runtime: Record<string, SnapshotTabRuntime> = {
      sA: { foregroundAppId: 'codex', ptyPid: 20, cwd: CWD },
      sB: { foregroundAppId: 'codex', ptyPid: 21, cwd: CWD },
    };
    const processes = [...codexTab(20, 30, startA), ...codexTab(21, 31, startB)];
    const service = new SessionSnapshotService({
      dataPath: path.join(dir, 'data', 'session-snapshot.json'),
      listTabs: () => tabs,
      getRuntime: (sessionId) => runtime[sessionId] ?? null,
      scheduleResume: () => true,
      listProcesses: async () => {
        if (!listed) throw new Error('process list timed out');
        return processes;
      },
      rootsFor: async () => roots,
      isFileLocked: () => true,
      now: () => new Date('2026-10-29T00:00:00.000Z'),
    });
    await service.initialize();
    const { tabs: rows } = await service.preview();
    return rows.map((row) => row.sessionId);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('FR-AITUI-021 AC-4: the thread A opened is saved for A only, when B started after it', async () => {
  // A started at 1 000 000 and opened its thread at 1 010 000; B started later and is idle.
  assert.deepEqual(await previewTwoCodexTabs(1_000_000, 1_020_000, 1_010_000), [THREAD, null]);
});

test('FR-AITUI-021 AC-4: the same order of tabs, reversed start times — still one tab only', async () => {
  // B started first and is idle; A started later and opened the thread.
  assert.deepEqual(await previewTwoCodexTabs(1_020_000, 1_000_000, 1_030_000).then((ids) => ids.filter(Boolean).length), 1);
});

test('FR-AITUI-021 AC-4: without a process list both tabs read the thread as exact, and it is still saved once', async () => {
  // No start times and no trees: the resolver has nothing to tell the tabs apart. The save must
  // not record the one thread twice.
  assert.equal(await previewTwoCodexTabs(1_000_000, 1_020_000, 1_010_000, false).then((ids) => ids.filter(Boolean).length), 1);
});
