/**
 * #242 — a tab showing a background session (`claude attach <id>`) is saved as that
 * attach and restored by it; when the background session has ended, it is resumed.
 * FR-AITUI-016 AC-9 (save) / FR-AITUI-014 AC-9 (restore).
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { SessionSnapshotService, type SnapshotTabRecord, type SnapshotTabRuntime } from './SessionSnapshotService.js';
import type { AgentRoots, ProcessInfo } from './agentSession/agentSessionResolver.js';

const SHARED = process.platform === 'win32' ? 'C:\\Work\\og' : '/work/og';
const WORKTREE = process.platform === 'win32' ? 'C:\\Work\\og-2136' : '/work/og-2136';
const BG_ID = '63cdfaba-cc1c-4945-a156-d43b646e6cef';
const OTHER_ID = '6507086a-b3bd-48e5-a0fd-0c0eae3d40c6';
const MINE_ID = '0616912d-d940-4375-8847-24d90c851c05';

interface Fixture {
  dir: string;
  roots: AgentRoots;
  dataDir: string;
  runtime: Record<string, SnapshotTabRuntime>;
  scheduled: Array<{ tabId: string; command: string; args: string[] }>;
  alive: Set<number>;
  make: () => SessionSnapshotService;
}

function pidFile(roots: AgentRoots, pid: number, sessionId: string, cwd: string, kind: string): void {
  writeFileSync(path.join(roots.claudeHome, 'sessions', `${pid}.json`), JSON.stringify({ pid, sessionId, cwd, startedAt: 1000 + pid, kind }));
}

function fixture(): Fixture {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bg-snapshot-attach-'));
  const roots: AgentRoots = {
    claudeHome: path.join(dir, 'claude'),
    codexHome: path.join(dir, 'codex'),
    opencodeData: path.join(dir, 'opencode'),
    hermesHome: path.join(dir, 'hermes'),
  };
  mkdirSync(path.join(roots.claudeHome, 'sessions'), { recursive: true });
  // The background session runs in its worktree, apart from the tab that shows it.
  pidFile(roots, 50, BG_ID, WORKTREE, 'bg');
  // Another background session in the tab's folder, shown by no tab: the guess the old save made.
  pidFile(roots, 51, OTHER_ID, SHARED, 'bg');
  // An interactive Claude in the second tab, in the same folder.
  pidFile(roots, 61, MINE_ID, SHARED, 'interactive');
  const tabs: SnapshotTabRecord[] = [
    { workspaceId: 'w1', workspaceName: 'og', tab: { id: 'ta', name: 'og-flow 2136', sessionId: 'sa', lastCwd: SHARED } },
    { workspaceId: 'w1', workspaceName: 'og', tab: { id: 'tb', name: 'issue 2025', sessionId: 'sb', lastCwd: SHARED } },
  ];
  const runtime: Record<string, SnapshotTabRuntime> = {
    // The attach client is a claude process in the tab, but it writes no pid file.
    sa: { foregroundAppId: 'claude', foregroundStartedAt: 5000, agentStartedAt: 5000, ptyPid: 30, cwd: SHARED, launchCommand: 'claude attach 63cdfaba' },
    sb: { foregroundAppId: 'claude', foregroundStartedAt: 5000, agentStartedAt: 5000, ptyPid: 60, cwd: SHARED, launchCommand: 'claude --dangerously-skip-permissions' },
  };
  const processes: ProcessInfo[] = [
    { pid: 30, ppid: 1, name: 'powershell.exe' },
    { pid: 31, ppid: 30, name: 'claude.exe', createdAtMs: 5000 },
    { pid: 60, ppid: 1, name: 'powershell.exe' },
    { pid: 61, ppid: 60, name: 'claude.exe', createdAtMs: 5000 },
  ];
  const scheduled: Fixture['scheduled'] = [];
  const alive = new Set<number>([50, 51, 61]);
  const dataDir = path.join(dir, 'data');
  const make = () => new SessionSnapshotService({
    dataPath: path.join(dataDir, 'session-snapshot.json'),
    listTabs: () => tabs,
    getRuntime: (sessionId) => runtime[sessionId] ?? null,
    scheduleResume: (tabId, command, args) => {
      scheduled.push({ tabId, command, args });
      return true;
    },
    addTab: async () => 'unused',
    listProcesses: async () => processes,
    rootsFor: async () => roots,
    listLaunchers: () => ({ claude: ['claude'], codex: ['codex'], hermes: ['hermes'], opencode: ['opencode'] }),
    isPidAlive: (pid) => alive.has(pid),
    confirmTimeoutMs: 30,
    confirmPollMs: 5,
    now: () => new Date('2026-11-18T00:00:00.000Z'),
    minuteMs: 10,
  });
  return { dir, roots, dataDir, runtime, scheduled, alive, make };
}

async function withFixture(run: (f: Fixture) => Promise<void>): Promise<void> {
  const f = fixture();
  try {
    await run(f);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
}

const autoPath = (f: Fixture) => path.join(f.dataDir, 'session-autosave.json');
const readAuto = (f: Fixture) => JSON.parse(readFileSync(autoPath(f), 'utf8'));
const entryOf = (f: Fixture, tabId: string) => readAuto(f).entries.find((e: { tabId: string }) => e.tabId === tabId);

async function saveAndRestart(f: Fixture): Promise<SessionSnapshotService> {
  const first = f.make();
  await first.initialize();
  assert.equal((await first.autoSave()).result, 'saved');
  return f.make();
}

/** Rewrites the saved entry of one tab, as a save made by an older server left it. */
function rewriteEntry(f: Fixture, tabId: string, patch: Record<string, unknown>): void {
  const saved = readAuto(f);
  saved.entries = saved.entries.map((e: { tabId: string }) => (e.tabId === tabId ? { ...e, ...patch } : e));
  writeFileSync(autoPath(f), JSON.stringify(saved));
}

test('FR-AITUI-016 AC-9: an attach tab is saved as the attach of its background session, not a guess from its folder', async () => {
  await withFixture(async (f) => {
    const service = f.make();
    await service.initialize();
    await service.autoSave();
    const attach = entryOf(f, 'ta');
    assert.equal(attach.mode, 'agent');
    assert.equal(attach.sessionId, BG_ID, 'the background session the id names, not another session in the folder');
    assert.equal(attach.method, 'claude-attach');
    assert.equal(attach.confidence, 'exact');
    assert.equal(attach.resumeCommand, 'claude');
    assert.deepEqual(attach.resumeArguments, ['attach', '63cdfaba'], 'attached again as it was, no --resume');
    const mine = entryOf(f, 'tb');
    assert.equal(mine.sessionId, MINE_ID, 'the other tab keeps its own session');
    assert.deepEqual(mine.resumeArguments, ['--dangerously-skip-permissions', '--resume', MINE_ID]);
  });
});

test('FR-AITUI-014 AC-9: an attach tab whose background session still runs is attached again', async () => {
  await withFixture(async (f) => {
    const restarted = await saveAndRestart(f);
    await restarted.initialize();
    await restarted.autoRestore();
    const typed = f.scheduled.find((s) => s.tabId === 'ta');
    assert.deepEqual(typed, { tabId: 'ta', command: 'claude', args: ['attach', '63cdfaba'] });
  });
});

test('FR-AITUI-014 AC-9: an attach tab whose background session has ended is resumed by its full id', async () => {
  await withFixture(async (f) => {
    const restarted = await saveAndRestart(f);
    f.alive.delete(50);
    rmSync(path.join(f.roots.claudeHome, 'sessions', '50.json'));
    await restarted.initialize();
    await restarted.autoRestore();
    const typed = f.scheduled.find((s) => s.tabId === 'ta');
    assert.deepEqual(typed, { tabId: 'ta', command: 'claude', args: ['--resume', BG_ID] });
  });
});

test('FR-AITUI-014 AC-9: an older save of an attach tab (attach X --resume <guess>) is attached without the guess', async () => {
  await withFixture(async (f) => {
    const restarted = await saveAndRestart(f);
    rewriteEntry(f, 'ta', { sessionId: OTHER_ID, method: 'claude-pid-file', confidence: 'estimated', resumeArguments: ['attach', '63cdfaba', '--resume', OTHER_ID] });
    await restarted.initialize();
    await restarted.autoRestore();
    assert.deepEqual(f.scheduled.find((s) => s.tabId === 'ta')?.args, ['attach', '63cdfaba']);
  });
});

test('FR-AITUI-014 AC-9: an older save of an ended attach is resumed by the id its transcript carries, not the guess', async () => {
  await withFixture(async (f) => {
    const restarted = await saveAndRestart(f);
    rewriteEntry(f, 'ta', { sessionId: OTHER_ID, method: 'claude-pid-file', confidence: 'estimated', resumeArguments: ['attach', '63cdfaba', '--resume', OTHER_ID] });
    f.alive.delete(50);
    rmSync(path.join(f.roots.claudeHome, 'sessions', '50.json'));
    const project = path.join(f.roots.claudeHome, 'projects', 'C--Work-og-2136');
    mkdirSync(project, { recursive: true });
    writeFileSync(path.join(project, `${BG_ID}.jsonl`), '{}\n');
    await restarted.initialize();
    await restarted.autoRestore();
    assert.deepEqual(f.scheduled.find((s) => s.tabId === 'ta')?.args, ['--resume', BG_ID]);
  });
});
