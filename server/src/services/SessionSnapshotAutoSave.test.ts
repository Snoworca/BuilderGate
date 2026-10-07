import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { SessionSnapshotService, type SnapshotTabRecord, type SnapshotTabRuntime } from './SessionSnapshotService.js';
import type { AgentRoots, ProcessInfo } from './agentSession/agentSessionResolver.js';
import { AppError } from '../utils/errors.js';

// FR-AITUI-016 (auto save) / FR-AITUI-017 (the list of manual saves) /
// FR-AITUI-018 (the newest save restored at start, and a save restored by hand).

const CWD_A = process.platform === 'win32' ? 'C:\\Work\\pm\\server' : '/work/pm/server';
const CWD_B = process.platform === 'win32' ? 'C:\\Work\\pm' : '/work/pm';
const CWD_C = process.platform === 'win32' ? 'C:\\Work\\pm\\frontend' : '/work/pm/frontend';
const CLAUDE_ID = '3f2a9c1e-5b7d-4c11-9a2e-0d6f81b4c7aa';
const CODEX_ID = '0199a2c4-7e1b-7d30-b1c2-44f0e9a1d3b8';
const CODEX_OLD = '0199a2c4-7e1b-7d30-b1c2-44f0e9a1d3b9';

interface Fixture {
  dir: string;
  dataDir: string;
  tabs: SnapshotTabRecord[];
  runtime: Record<string, SnapshotTabRuntime>;
  scheduled: Array<{ tabId: string; command: string; args: string[] }>;
  added: Array<{ workspaceId: string; name: string; cwd: string | null; tabId: string; fallbackWorkspaceId?: string | null }>;
  clock: { at: number };
  retention: { value: number };
  processCalls: { count: number };
  alive: Set<number>;
  timing: { confirmTimeoutMs: number };
  make: () => SessionSnapshotService;
}

function fixture(): Fixture {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bg-snapshot-auto-'));
  const roots: AgentRoots = {
    claudeHome: path.join(dir, 'claude'),
    codexHome: path.join(dir, 'codex'),
    opencodeData: path.join(dir, 'opencode'),
    hermesHome: path.join(dir, 'hermes'),
  };
  mkdirSync(path.join(roots.claudeHome, 'sessions'), { recursive: true });
  writeFileSync(path.join(roots.claudeHome, 'sessions', '40.json'), JSON.stringify({ pid: 40, sessionId: CLAUDE_ID, cwd: CWD_A, startedAt: 1000 }));
  const tabs: SnapshotTabRecord[] = [
    { workspaceId: 'w1', workspaceName: 'ProjectMaster', tab: { id: 't1', name: 'build', sessionId: 's1', lastCwd: CWD_A } },
    { workspaceId: 'w1', workspaceName: 'ProjectMaster', tab: { id: 't2', name: 'reviewer', sessionId: 's2', lastCwd: CWD_B } },
    { workspaceId: 'w1', workspaceName: 'ProjectMaster', tab: { id: 't3', name: 'dev-server', sessionId: 's3', lastCwd: CWD_C } },
    { workspaceId: 'w2', workspaceName: 'agent-tools', tab: { id: 't4', name: 'shell', sessionId: 's4', lastCwd: CWD_B } },
  ];
  const clock = { at: Date.parse('2026-10-08T05:00:00.000Z') };
  const runtime: Record<string, SnapshotTabRuntime> = {
    s1: { foregroundAppId: 'claude', foregroundStartedAt: clock.at - 60_000, ptyPid: 20, cwd: CWD_A, launchCommand: 'claudep --model opus' },
    // The codex tab has no live thread on disk: its id is not found.
    s2: { foregroundAppId: 'codex', foregroundStartedAt: clock.at - 60_000, ptyPid: 21, cwd: CWD_B, launchCommand: 'codex --full-auto' },
    s3: { foregroundAppId: null, ptyPid: 22, cwd: CWD_C, runningCommand: 'npm run dev' },
    s4: { foregroundAppId: null, ptyPid: 23, cwd: CWD_B },
  };
  const processes: ProcessInfo[] = [
    { pid: 20, ppid: 1, name: 'powershell.exe' },
    { pid: 40, ppid: 20, name: 'claude.exe', createdAtMs: 1000 },
  ];
  const scheduled: Array<{ tabId: string; command: string; args: string[] }> = [];
  const added: Fixture['added'] = [];
  const retention = { value: 10 };
  const processCalls = { count: 0 };
  const alive = new Set<number>([40]);
  const timing = { confirmTimeoutMs: 60 };
  const dataDir = path.join(dir, 'data');
  const make = () => new SessionSnapshotService({
    dataPath: path.join(dataDir, 'session-snapshot.json'),
    listTabs: () => tabs,
    getRuntime: (sessionId) => runtime[sessionId] ?? null,
    scheduleResume: (tabId, command, args) => {
      if (!tabs.some((record) => record.tab.id === tabId) && !added.some((a) => a.tabId === tabId)) return false;
      scheduled.push({ tabId, command, args });
      return true;
    },
    addTab: async (workspaceId, name, cwd, fallbackWorkspaceId) => {
      const tabId = `new-${added.length + 1}`;
      added.push({ workspaceId, name, cwd, tabId, fallbackWorkspaceId: fallbackWorkspaceId ?? null });
      return tabId;
    },
    listProcesses: async () => {
      processCalls.count += 1;
      return processes;
    },
    rootsFor: async () => roots,
    listLaunchers: () => ({ claude: ['claude', 'claude-code', 'claudep'], codex: ['codex'], hermes: ['hermes'], opencode: ['opencode'] }),
    isPidAlive: (pid) => alive.has(pid),
    retention: () => retention.value,
    get confirmTimeoutMs() { return timing.confirmTimeoutMs; },
    confirmPollMs: 5,
    now: () => new Date(clock.at),
    // One "minute" of the auto save interval is 10 ms here.
    minuteMs: 10,
  });
  return { dir, dataDir, tabs, runtime, scheduled, added, clock, retention, processCalls, alive, timing, make };
}

async function withFixture(run: (f: Fixture) => Promise<void>): Promise<void> {
  const f = fixture();
  try {
    await run(f);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const autoPath = (f: Fixture) => path.join(f.dataDir, 'session-autosave.json');
const manualDir = (f: Fixture) => path.join(f.dataDir, 'session-snapshots');
const manualFiles = (f: Fixture) => (existsSync(manualDir(f)) ? readdirSync(manualDir(f)).filter((name) => name.endsWith('.json')) : []);
const readAuto = (f: Fixture) => JSON.parse(readFileSync(autoPath(f), 'utf8'));
const entryOf = (snapshot: { entries: Array<{ tabId: string }> }, tabId: string) => snapshot.entries.find((e) => e.tabId === tabId) as Record<string, unknown> | undefined;

// ---------------------------------------------------------------------------
// FR-AITUI-016 — auto save
// ---------------------------------------------------------------------------

test('FR-AITUI-016 AC-1/AC-2: one auto save holds every tab and touches no manual save', async () => {
  await withFixture(async (f) => {
    const service = f.make();
    await service.initialize();
    const outcome = await service.autoSave();
    assert.equal(outcome.result, 'saved');
    const saved = readAuto(f);
    assert.equal(saved.origin, 'auto');
    assert.equal(saved.savedAt, new Date(f.clock.at).toISOString());
    assert.deepEqual(saved.entries.map((e: { tabId: string }) => e.tabId), ['t1', 't2', 't3', 't4'], 'every tab, agent or not');
    assert.equal(entryOf(saved, 't1')?.mode, 'agent');
    assert.equal(entryOf(saved, 't1')?.sessionId, CLAUDE_ID);
    assert.equal(entryOf(saved, 't1')?.confidence, 'exact');
    assert.equal(entryOf(saved, 't4')?.mode, 'shell');
    assert.deepEqual(manualFiles(f), [], 'an auto save adds nothing to the manual list');
  });
});

test('FR-AITUI-016 AC-1: each auto save overwrites the one auto save file', async () => {
  await withFixture(async (f) => {
    const service = f.make();
    await service.initialize();
    await service.autoSave();
    f.clock.at += 5 * 60_000;
    await service.autoSave();
    assert.equal(readAuto(f).savedAt, new Date(f.clock.at).toISOString());
    assert.deepEqual(readdirSync(f.dataDir).filter((name) => name.startsWith('session-autosave')), ['session-autosave.json']);
  });
});

test('FR-AITUI-016 AC-2: an estimated session id is saved as it is', async () => {
  await withFixture(async (f) => {
    // Two live Claude sessions in the folder and none in the tab's process tree: a guess.
    f.runtime.s1.ptyPid = 99;
    writeFileSync(path.join(f.dir, 'claude', 'sessions', '41.json'), JSON.stringify({ pid: 41, sessionId: '5d0c7e21-1a2b-4c3d-8e9f-0a1b2c3d4e5f', cwd: CWD_A, startedAt: 900 }));
    f.alive.add(41);
    const service = f.make();
    await service.initialize();
    await service.autoSave();
    assert.equal(entryOf(readAuto(f), 't1')?.confidence, 'estimated');
    assert.equal(entryOf(readAuto(f), 't1')?.mode, 'agent');
  });
});

test('FR-AITUI-016 AC-3: a running command is recorded on a shell entry and never typed at start', async () => {
  await withFixture(async (f) => {
    const first = f.make();
    await first.initialize();
    await first.autoSave();
    const dev = entryOf(readAuto(f), 't3');
    assert.equal(dev?.mode, 'shell');
    assert.equal(dev?.runningCommand, 'npm run dev');

    const restarted = f.make();
    await restarted.initialize();
    await restarted.autoRestore();
    assert.deepEqual(f.scheduled.map((s) => s.tabId), ['t1'], 'only the agent is typed, not npm run dev');
  });
});

test('FR-AITUI-016 AC-4: an id not found now comes from a manual save made after the agent started', async () => {
  await withFixture(async (f) => {
    const service = f.make();
    await service.initialize();
    await service.saveAll([{ tabId: 't2', mode: 'agent', agent: 'codex', launcher: 'codex', args: ['--full-auto'], sessionId: CODEX_ID }]);
    f.clock.at += 60_000;
    await service.autoSave();
    const reviewer = entryOf(readAuto(f), 't2');
    assert.equal(reviewer?.mode, 'agent');
    assert.equal(reviewer?.sessionId, CODEX_ID);
    assert.equal(reviewer?.confidence, 'manual');
  });
});

test('FR-AITUI-016 AC-4: a manual save older than the running agent is not inherited', async () => {
  await withFixture(async (f) => {
    const service = f.make();
    await service.initialize();
    await service.saveAll([{ tabId: 't2', mode: 'agent', agent: 'codex', launcher: 'codex', sessionId: CODEX_ID }]);
    // The agent in the tab was started after that save: the saved id belongs to an earlier run.
    f.clock.at += 60_000;
    f.runtime.s2.foregroundStartedAt = f.clock.at - 1000;
    await service.autoSave();
    assert.equal(entryOf(readAuto(f), 't2')?.mode, 'shell');
  });
});

test('FR-AITUI-016 AC-4: an id not found now comes from the auto save it overwrites', async () => {
  await withFixture(async (f) => {
    mkdirSync(f.dataDir, { recursive: true });
    writeFileSync(autoPath(f), JSON.stringify({
      version: 1, origin: 'auto', id: 'auto', savedAt: new Date(f.clock.at - 300_000).toISOString(),
      entries: [{
        tabId: 't2', workspaceId: 'w1', workspaceName: 'ProjectMaster', tabName: 'reviewer', cwd: CWD_B,
        mode: 'agent', agent: 'codex', sessionId: CODEX_OLD, method: 'codex-writer-lock', confidence: 'exact',
        resumeCommand: 'codex', resumeArguments: ['resume', CODEX_OLD], restore: 'pending',
      }],
    }));
    const service = f.make();
    await service.initialize();
    await service.autoSave();
    assert.equal(entryOf(readAuto(f), 't2')?.sessionId, CODEX_OLD);
  });
});

test('FR-AITUI-016 AC-5: no auto save while resumed agents are still being looked for', async () => {
  await withFixture(async (f) => {
    const first = f.make();
    await first.initialize();
    await first.autoSave();
    const restarted = f.make();
    await restarted.initialize();
    // The resumed claude is not up yet: no foreground app and nothing in its shell's process tree.
    f.runtime.s1.foregroundAppId = null;
    f.runtime.s1.ptyPid = 99;
    f.timing.confirmTimeoutMs = 400;
    await restarted.autoRestore();
    const before = readFileSync(autoPath(f), 'utf8');
    f.clock.at += 300_000;
    const outcome = await restarted.autoSave();
    assert.equal(outcome.result, 'deferred');
    assert.equal(readFileSync(autoPath(f), 'utf8'), before, 'the good auto save is not overwritten');
    await sleep(500);
    assert.equal((await restarted.autoSave()).result, 'saved', 'once the wait is settled, saving resumes');
  });
});

test('FR-AITUI-016 AC-6: an overlapping cycle is skipped and one cycle lists processes once', async () => {
  await withFixture(async (f) => {
    const service = f.make();
    await service.initialize();
    const [a, b] = await Promise.all([service.autoSave(), service.autoSave()]);
    assert.deepEqual([a.result, b.result].sort(), ['saved', 'skipped']);
    assert.equal(f.processCalls.count, 1);
  });
});

test('FR-AITUI-016 AC-7: the file is 0600, and a failed write keeps the previous auto save', async () => {
  await withFixture(async (f) => {
    const service = f.make();
    await service.initialize();
    await service.autoSave();
    if (process.platform !== 'win32') assert.equal(statSync(autoPath(f)).mode & 0o777, 0o600);
    const before = readFileSync(autoPath(f), 'utf8');
    // The temporary file's name is taken by a directory: the write fails.
    mkdirSync(`${autoPath(f)}.tmp-${process.pid}`, { recursive: true });
    f.clock.at += 300_000;
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      assert.equal((await service.autoSave()).result, 'failed');
    } finally {
      console.warn = warn;
    }
    assert.equal(readFileSync(autoPath(f), 'utf8'), before);
  });
});

test('FR-AITUI-016 AC-8: the status carries the last auto save time and result', async () => {
  await withFixture(async (f) => {
    const service = f.make();
    await service.initialize();
    assert.equal(service.getStatus().autoSave.lastAt, null);
    await service.autoSave();
    const status = service.getStatus();
    assert.equal(status.autoSave.lastAt, new Date(f.clock.at).toISOString());
    assert.equal(status.autoSave.lastResult, 'saved');
  });
});

// ---------------------------------------------------------------------------
// FR-AITUI-017 — the manual list
// ---------------------------------------------------------------------------

test('FR-AITUI-017 AC-1/AC-2/AC-3: manual saves pile up as files and the oldest go past the retention', async () => {
  await withFixture(async (f) => {
    f.retention.value = 2;
    const service = f.make();
    await service.initialize();
    await service.autoSave();
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      f.clock.at += 60_000;
      const { snapshot } = await service.saveAll([{ tabId: 't4', mode: 'shell' }]);
      assert.equal(snapshot.origin, 'manual');
      ids.push(String(snapshot.id));
    }
    assert.equal(new Set(ids).size, 3, 'each save has its own id');
    assert.equal(manualFiles(f).length, 2);
    const { manual, auto } = service.listSnapshots();
    assert.deepEqual(manual.map((m) => m.id), [ids[2], ids[1]], 'newest first, the oldest went');
    assert.ok(auto, 'the auto save is not counted against the retention');
    if (process.platform !== 'win32') {
      for (const name of manualFiles(f)) assert.equal(statSync(path.join(manualDir(f), name)).mode & 0o777, 0o600);
    }
  });
});

test('FR-AITUI-017 AC-4: the list gives each save its time, tab count and whether a start used it', async () => {
  await withFixture(async (f) => {
    const service = f.make();
    await service.initialize();
    await service.saveAll([{ tabId: 't4', mode: 'shell' }, { tabId: 't3', mode: 'shell' }]);
    f.clock.at += 60_000;
    await service.autoSave();
    const restarted = f.make();
    await restarted.initialize();
    await restarted.autoRestore();
    const list = restarted.listSnapshots();
    assert.equal(list.manual.length, 1);
    assert.equal(list.manual[0].tabCount, 2);
    assert.equal(list.manual[0].usedForRestore, false);
    assert.equal(list.auto?.tabCount, 4);
    assert.equal(list.auto?.usedForRestore, true, 'the newer auto save was the one restored');
  });
});

test('FR-AITUI-017 AC-5: one manual save is deleted by id; an unknown id is a 404', async () => {
  await withFixture(async (f) => {
    const service = f.make();
    await service.initialize();
    const { snapshot } = await service.saveAll([{ tabId: 't4', mode: 'shell' }]);
    await service.deleteSnapshot(String(snapshot.id));
    assert.deepEqual(manualFiles(f), []);
    await assert.rejects(service.deleteSnapshot('nope'), (error: unknown) => error instanceof AppError && error.statusCode === 404);
  });
});

test('FR-AITUI-017 AC-6: the snapshot file from before the list becomes one manual save', async () => {
  await withFixture(async (f) => {
    mkdirSync(f.dataDir, { recursive: true });
    writeFileSync(path.join(f.dataDir, 'session-snapshot.json'), JSON.stringify({
      version: 1, savedAt: '2026-10-01T00:00:00.000Z',
      entries: [{
        tabId: 't1', workspaceId: 'w1', workspaceName: 'ProjectMaster', tabName: 'build', cwd: CWD_A,
        mode: 'agent', agent: 'claude', sessionId: CLAUDE_ID, method: 'claude-pid-file', confidence: 'exact',
        resumeCommand: 'claude', resumeArguments: ['--resume', CLAUDE_ID], restore: 'pending',
      }],
    }));
    const service = f.make();
    await service.initialize();
    const { manual } = service.listSnapshots();
    assert.equal(manual.length, 1);
    assert.equal(manual[0].savedAt, '2026-10-01T00:00:00.000Z');
    assert.equal(existsSync(path.join(f.dataDir, 'session-snapshot.json')), false, 'moved, not copied');
  });
});

// ---------------------------------------------------------------------------
// FR-AITUI-018 — restored at start, and restored by hand
// ---------------------------------------------------------------------------

test('FR-AITUI-018 AC-1: the newer of the newest manual save and the auto save is restored, every start', async () => {
  await withFixture(async (f) => {
    const service = f.make();
    await service.initialize();
    await service.saveAll([{ tabId: 't4', mode: 'command', command: 'echo manual' }]);
    f.clock.at += 60_000;
    await service.autoSave();

    for (let start = 0; start < 2; start += 1) {
      f.scheduled.length = 0;
      const restarted = f.make();
      await restarted.initialize();
      await restarted.autoRestore();
      assert.deepEqual(f.scheduled.map((s) => s.tabId), ['t1'], `start ${start + 1}: the auto save (newer) is used again`);
      await sleep(80);
    }
  });
});

test('FR-AITUI-018 AC-1: on a tie the manual save wins', async () => {
  await withFixture(async (f) => {
    const service = f.make();
    await service.initialize();
    await service.autoSave();
    await service.saveAll([{ tabId: 't4', mode: 'command', command: 'echo manual' }]);
    const restarted = f.make();
    await restarted.initialize();
    await restarted.autoRestore();
    assert.deepEqual(f.scheduled.map((s) => [s.tabId, s.command]), [['t4', 'echo']]);
  });
});

test('FR-AITUI-018 AC-2: the report names the save it came from', async () => {
  await withFixture(async (f) => {
    const service = f.make();
    await service.initialize();
    await service.autoSave();
    const restarted = f.make();
    await restarted.initialize();
    await restarted.autoRestore();
    const { reportSource } = restarted.getStatus();
    assert.deepEqual(reportSource, { origin: 'auto', id: 'auto', savedAt: new Date(f.clock.at).toISOString() });
  });
});

test('FR-AITUI-018 AC-3: once a report notice was shown, the status says so; the next start shows its own', async () => {
  await withFixture(async (f) => {
    const service = f.make();
    await service.initialize();
    await service.autoSave();
    const restarted = f.make();
    await restarted.initialize();
    await restarted.autoRestore();
    const { reportId, reportNoticeShown } = restarted.getStatus();
    assert.equal(reportNoticeShown, false);
    await restarted.acknowledgeReport(String(reportId));
    assert.equal(restarted.getStatus().reportNoticeShown, true);
    assert.ok(readdirSync(f.dataDir).includes('session-restore-state.json'), 'recorded under server/data');

    const again = f.make();
    await again.initialize();
    await again.autoRestore();
    assert.notEqual(again.getStatus().reportId, reportId);
    assert.equal(again.getStatus().reportNoticeShown, false);
  });
});

test('FR-AITUI-018 AC-5/AC-6: a hand restore types into an idle tab and opens a new tab for a busy or missing one', async () => {
  await withFixture(async (f) => {
    const service = f.make();
    await service.initialize();
    // A save with: t1 claude (its tab is busy now), t4 a command (idle), t9 a tab that is gone, t3 a running command.
    const saved = await service.saveAll([
      { tabId: 't1', mode: 'agent', agent: 'claude', launcher: 'claude', sessionId: CLAUDE_ID },
      { tabId: 't4', mode: 'command', command: 'echo hi' },
    ]);
    await service.autoSave();
    const detail = service.getSnapshot(String(saved.snapshot.id));
    assert.deepEqual(detail.entries.map((e) => [e.tabId, e.target, e.targetReason]), [['t1', 'new-tab', 'busy'], ['t4', 'tab', 'idle']]);

    const results = await service.restoreFrom(String(saved.snapshot.id), [{ tabId: 't1' }, { tabId: 't4' }]);
    assert.deepEqual(f.added.map((a) => [a.workspaceId, a.name, a.cwd]), [['w1', 'build', CWD_A]]);
    assert.deepEqual(f.scheduled.map((s) => [s.tabId, s.command]), [['new-1', 'claude'], ['t4', 'echo']]);
    assert.deepEqual(results.map((r) => [r.tabId, r.result]), [['new-1', 'waiting'], ['t4', 'typed']]);
  });
});

test('FR-AITUI-018 AC-5: a running command from the auto save is typed only when asked', async () => {
  await withFixture(async (f) => {
    const service = f.make();
    await service.initialize();
    await service.autoSave();
    const plain = await service.restoreFrom('auto', [{ tabId: 't3' }]);
    assert.equal(plain[0].result, 'shell');
    assert.equal(f.scheduled.length, 0);
    const withCommand = await service.restoreFrom('auto', [{ tabId: 't3', includeCommand: true }]);
    assert.equal(withCommand[0].result, 'typed');
    assert.deepEqual(f.scheduled.map((s) => [s.command, s.args]), [['npm', ['run', 'dev']]]);
    // t3 is busy (its command runs), so both restores opened their own tab.
    assert.deepEqual(f.added.map((a) => a.cwd), [CWD_C, CWD_C]);
  });
});

test('FR-AITUI-018 AC-6: a tab that is gone reopens in its saved workspace and folder', async () => {
  await withFixture(async (f) => {
    const service = f.make();
    await service.initialize();
    await service.autoSave();
    f.tabs.splice(3, 1); // t4 closed
    const detail = service.getSnapshot('auto');
    assert.deepEqual(detail.entries.find((e) => e.tabId === 't4') && [detail.entries.find((e) => e.tabId === 't4')!.target, detail.entries.find((e) => e.tabId === 't4')!.targetReason], ['new-tab', 'missing']);
    const results = await service.restoreFrom('auto', [{ tabId: 't4' }], { fallbackWorkspaceId: 'w-active' });
    assert.deepEqual(f.added.map((a) => [a.workspaceId, a.name, a.cwd]), [['w2', 'shell', CWD_B]]);
    assert.equal(f.added[0].fallbackWorkspaceId, 'w-active', 'the client\'s active workspace goes along for a workspace that is gone');
    assert.equal(results[0].result, 'shell');
  });
});

test('FR-AITUI-018 AC-5: restoring from an unknown save is a 404', async () => {
  await withFixture(async (f) => {
    const service = f.make();
    await service.initialize();
    await assert.rejects(service.restoreFrom('nope', [{ tabId: 't1' }]), (error: unknown) => error instanceof AppError && error.statusCode === 404);
  });
});

// ---------------------------------------------------------------------------
// FR-AITUI-019 AC-3 — the timer follows the settings without a restart
// ---------------------------------------------------------------------------

test('FR-AITUI-019 AC-3: turned on, the auto save runs every interval; turned off, it stops', async () => {
  await withFixture(async (f) => {
    const service = f.make();
    await service.initialize();
    service.configureAutoSave({ enabled: true, intervalMinutes: 5 }); // 50 ms here
    await sleep(180);
    const runs = f.processCalls.count;
    assert.ok(runs >= 2, `ran ${runs} times in 180 ms at a 50 ms interval`);
    assert.equal(service.getStatus().autoSave.lastResult, 'saved');

    service.configureAutoSave({ enabled: false, intervalMinutes: 5 });
    const atStop = f.processCalls.count;
    await sleep(150);
    assert.equal(f.processCalls.count, atStop, 'no cycle after it was turned off');
    assert.equal(service.getStatus().autoSave.enabled, false);
  });
});

test('FR-AITUI-019 AC-3: a new interval reschedules the next cycle at once', async () => {
  await withFixture(async (f) => {
    const service = f.make();
    await service.initialize();
    service.configureAutoSave({ enabled: true, intervalMinutes: 100 }); // 1 s here
    await sleep(120);
    assert.equal(f.processCalls.count, 0, 'the long interval has not come round');
    service.configureAutoSave({ enabled: true, intervalMinutes: 5 }); // 50 ms here
    await sleep(120);
    assert.ok(f.processCalls.count >= 1, 'the short interval took over without waiting out the long one');
    service.stopAutoSave();
  });
});
