import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { SessionSnapshotService, type SnapshotTabRecord, type SnapshotTabRuntime } from './SessionSnapshotService.js';
import type { AgentKind, AgentRoots, ProcessInfo } from './agentSession/agentSessionResolver.js';
import { AppError } from '../utils/errors.js';

// FR-AITUI-013 / FR-AITUI-014 — every terminal saved at once, and resumed on its own after a restart.

const CWD_A = process.platform === 'win32' ? 'C:\\Work\\pm\\server' : '/work/pm/server';
const CWD_B = process.platform === 'win32' ? 'C:\\Work\\pm' : '/work/pm';
const CWD_C = process.platform === 'win32' ? 'C:\\Work\\pm\\frontend' : '/work/pm/frontend';
const CLAUDE_ID = '3f2a9c1e-5b7d-4c11-9a2e-0d6f81b4c7aa';
const CLAUDE_OTHER = '5d0c7e21-1a2b-4c3d-8e9f-0a1b2c3d4e5f';
const CODEX_ID = '0199a2c4-7e1b-7d30-b1c2-44f0e9a1d3b8';

interface Fixture {
  dir: string;
  dataPath: string;
  tabs: SnapshotTabRecord[];
  runtime: Record<string, SnapshotTabRuntime>;
  scheduled: Array<{ tabId: string; command: string; args: string[] }>;
  make: () => SessionSnapshotService;
}

function fixture(): Fixture {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bg-snapshot-all-'));
  const roots: AgentRoots = {
    claudeHome: path.join(dir, 'claude'),
    codexHome: path.join(dir, 'codex'),
    opencodeData: path.join(dir, 'opencode'),
    hermesHome: path.join(dir, 'hermes'),
  };
  mkdirSync(path.join(roots.claudeHome, 'sessions'), { recursive: true });
  // Two live Claude sessions in the same folder: the pid in the tab's tree is exact, the other is a candidate.
  writeFileSync(path.join(roots.claudeHome, 'sessions', '40.json'), JSON.stringify({ pid: 40, sessionId: CLAUDE_ID, cwd: CWD_A, startedAt: 1000 }));
  writeFileSync(path.join(roots.claudeHome, 'sessions', '41.json'), JSON.stringify({ pid: 41, sessionId: CLAUDE_OTHER, cwd: CWD_A, startedAt: 900 }));
  const tabs: SnapshotTabRecord[] = [
    { workspaceId: 'w1', workspaceName: 'ProjectMaster', tab: { id: 't1', name: 'build', sessionId: 's1', lastCwd: CWD_A } },
    { workspaceId: 'w1', workspaceName: 'ProjectMaster', tab: { id: 't2', name: 'reviewer', sessionId: 's2', lastCwd: CWD_B } },
    { workspaceId: 'w1', workspaceName: 'ProjectMaster', tab: { id: 't3', name: 'dev-server', sessionId: 's3', lastCwd: CWD_C } },
    { workspaceId: 'w2', workspaceName: 'agent-tools', tab: { id: 't4', name: 'shell', sessionId: 's4', lastCwd: CWD_B } },
  ];
  const runtime: Record<string, SnapshotTabRuntime> = {
    s1: { foregroundAppId: 'claude', ptyPid: 20, cwd: CWD_A, launchCommand: 'claudep --model opus --continue' },
    s2: { foregroundAppId: 'codex', ptyPid: 21, cwd: CWD_B, launchCommand: 'mycodex --full-auto' },
    s3: { foregroundAppId: null, ptyPid: 22, cwd: CWD_C, runningCommand: 'npm run dev' },
    s4: { foregroundAppId: null, ptyPid: 23, cwd: CWD_B },
  };
  const processes: ProcessInfo[] = [
    { pid: 20, ppid: 1, name: 'powershell.exe' },
    { pid: 40, ppid: 20, name: 'claude.exe', createdAtMs: 1000 },
    { pid: 41, ppid: 1, name: 'claude.exe', createdAtMs: 900 },
  ];
  const scheduled: Array<{ tabId: string; command: string; args: string[] }> = [];
  const dataPath = path.join(dir, 'data', 'session-snapshot.json');
  const make = () => new SessionSnapshotService({
    dataPath,
    listTabs: () => tabs,
    getRuntime: (sessionId) => runtime[sessionId] ?? null,
    scheduleResume: (tabId, command, args) => {
      if (!tabs.some((record) => record.tab.id === tabId)) return false;
      scheduled.push({ tabId, command, args });
      return true;
    },
    listProcesses: async () => processes,
    rootsFor: async () => roots,
    // FR-AITUI-013 AC-2: what Tools › Agent commands registered.
    listLaunchers: () => ({ claude: ['claude', 'claude-code', 'claudep'], codex: ['codex', 'codexp'], hermes: ['hermes'], opencode: ['opencode'] }),
    isPidAlive: (pid) => pid === 40 || pid === 41,
    confirmTimeoutMs: 60,
    confirmPollMs: 5,
    now: () => new Date('2026-09-28T12:40:00.000Z'),
  });
  return { dir, dataPath, tabs, runtime, scheduled, make };
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

test('FR-AITUI-013 AC-1: preview lists every tab of every workspace with cwd, command, agent and id', async () => {
  await withFixture(async (f) => {
    const service = f.make();
    await service.initialize();
    const { tabs } = await service.preview();
    assert.deepEqual(tabs.map((t) => [t.tabId, t.workspaceName, t.agent]), [
      ['t1', 'ProjectMaster', 'claude'], ['t2', 'ProjectMaster', 'codex'], ['t3', 'ProjectMaster', null], ['t4', 'agent-tools', null],
    ]);
    const build = tabs[0];
    assert.equal(build.cwd, CWD_A);
    assert.equal(build.runningCommand, 'claudep --model opus --continue');
    assert.equal(build.sessionId, CLAUDE_ID);
    assert.equal(build.confidence, 'exact');
    assert.deepEqual(build.candidates.map((c) => c.sessionId), [CLAUDE_ID, CLAUDE_OTHER], 'the resolved id first, then the other live sessions in the folder');
    assert.equal(tabs[1].confidence, 'missing', 'a codex tab with no live thread has no id');
    assert.equal(tabs[1].sessionId, null);
    assert.equal(tabs[2].runningCommand, 'npm run dev');
    assert.equal(tabs[2].confidence, null, 'a shell tab has no id to be sure about');
    assert.equal(tabs[3].runningCommand, null);
  });
});

test('FR-AITUI-013 AC-2: a registered launcher is kept, an unregistered one falls back, selectors are dropped', async () => {
  await withFixture(async (f) => {
    const service = f.make();
    await service.initialize();
    const { tabs, launchers } = await service.preview();
    assert.equal(tabs[0].launcher, 'claudep');
    assert.deepEqual(tabs[0].args, ['--model', 'opus'], '--continue is a selector, not an argument to keep');
    assert.equal(tabs[1].launcher, 'codex', 'mycodex is not registered in Tools › Agent commands');
    assert.deepEqual(tabs[1].args, ['--full-auto']);
    assert.deepEqual(launchers.claude, ['claude', 'claude-code', 'claudep']);
    assert.deepEqual(launchers.codex, ['codex', 'codexp']);
  });
});

test('FR-AITUI-013 AC-3/AC-4: saveAll writes agent, command and shell entries with their cwd', async () => {
  await withFixture(async (f) => {
    const service = f.make();
    await service.initialize();
    const { snapshot } = await service.saveAll([
      { tabId: 't1', mode: 'agent', agent: 'claude', launcher: 'claudep', args: ['--model', 'opus'], sessionId: CLAUDE_ID },
      { tabId: 't2', mode: 'agent', agent: 'codex', launcher: 'codexp', args: ['--full-auto'], sessionId: CODEX_ID },
      { tabId: 't3', mode: 'command', command: 'npm run dev' },
      { tabId: 't4', mode: 'shell' },
    ]);
    const byTab = new Map(snapshot.entries.map((entry) => [entry.tabId, entry]));
    const build = byTab.get('t1')!;
    assert.equal(build.mode, 'agent');
    assert.equal(build.cwd, CWD_A);
    assert.equal(build.resumeCommand, 'claudep');
    assert.deepEqual(build.resumeArguments, ['--model', 'opus', '--resume', CLAUDE_ID]);
    const reviewer = byTab.get('t2')!;
    assert.equal(reviewer.resumeCommand, 'codexp');
    assert.deepEqual(reviewer.resumeArguments, ['--full-auto', 'resume', CODEX_ID]);
    const dev = byTab.get('t3')!;
    assert.equal(dev.mode, 'command');
    assert.equal(dev.resumeCommand, 'npm');
    assert.deepEqual(dev.resumeArguments, ['run', 'dev']);
    assert.equal(dev.cwd, CWD_C);
    const shell = byTab.get('t4')!;
    assert.equal(shell.mode, 'shell');
    assert.equal(shell.resumeCommand, '');
    assert.equal(shell.cwd, CWD_B);
    assert.ok(snapshot.entries.every((entry) => entry.restore === 'pending'));
    const onDisk = JSON.parse(readFileSync(f.dataPath, 'utf8'));
    assert.equal(onDisk.entries.length, 4);
  });
});

test('FR-AITUI-013 AC-3: an agent entry with no id is saved as a shell', async () => {
  await withFixture(async (f) => {
    const service = f.make();
    await service.initialize();
    const { snapshot } = await service.saveAll([{ tabId: 't2', mode: 'agent', agent: 'codex', launcher: 'codex', args: [], sessionId: '' }]);
    assert.equal(snapshot.entries[0].mode, 'shell');
    assert.equal(snapshot.entries[0].resumeCommand, '');
  });
});

test('FR-AITUI-013 AC-3: a wrong id or an unregistered launcher is refused and nothing is written', async () => {
  await withFixture(async (f) => {
    const service = f.make();
    await service.initialize();
    await assert.rejects(
      service.saveAll([
        { tabId: 't1', mode: 'agent', agent: 'claude', launcher: 'claude', args: [], sessionId: CLAUDE_ID },
        { tabId: 't2', mode: 'agent', agent: 'codex', launcher: 'codex', args: [], sessionId: 'not-a-uuid' },
      ]),
      (error: unknown) => error instanceof AppError && error.statusCode === 400
        && JSON.stringify(error.details?.tabIds) === JSON.stringify(['t2']),
    );
    await assert.rejects(
      service.saveAll([{ tabId: 't1', mode: 'agent', agent: 'claude', launcher: 'mycodex', args: [], sessionId: CLAUDE_ID }]),
      (error: unknown) => error instanceof AppError && JSON.stringify(error.details?.tabIds) === JSON.stringify(['t1']),
    );
    assert.equal(service.getStatus().snapshot, null, 'a refused save writes nothing');
  });
});

test('FR-AITUI-013 AC-5: a command with a line break is refused', async () => {
  await withFixture(async (f) => {
    const service = f.make();
    await service.initialize();
    await assert.rejects(
      service.saveAll([{ tabId: 't3', mode: 'command', command: 'npm run dev\rrm -rf /' }]),
      (error: unknown) => error instanceof AppError && error.statusCode === 400,
    );
  });
});

test('FR-AITUI-013 AC-6: an entry saved before modes existed reads as an agent entry', async () => {
  await withFixture(async (f) => {
    mkdirSync(path.dirname(f.dataPath), { recursive: true });
    writeFileSync(f.dataPath, JSON.stringify({
      version: 1,
      savedAt: '2026-09-27T00:00:00.000Z',
      entries: [{ tabId: 't1', workspaceId: 'w1', workspaceName: 'ProjectMaster', tabName: 'build', cwd: CWD_A, agent: 'claude', sessionId: CLAUDE_ID, method: 'claude-pid-file', confidence: 'exact', resumeCommand: 'claude', resumeArguments: ['--resume', CLAUDE_ID], restore: 'pending' }],
    }));
    const service = f.make();
    await service.initialize();
    assert.equal(service.getStatus().snapshot?.entries[0].mode, 'agent');
  });
});

test('FR-AITUI-014 AC-1: a pending entry supplies the cwd its tab reopens in', async () => {
  await withFixture(async (f) => {
    const first = f.make();
    await first.initialize();
    await first.saveAll([{ tabId: 't3', mode: 'command', command: 'npm run dev' }]);
    const restarted = f.make();
    await restarted.initialize();
    assert.equal(restarted.restoreCwdFor('t3'), CWD_C);
    assert.equal(restarted.restoreCwdFor('t4'), null, 'a tab not in the snapshot keeps its own lastCwd');
  });
});

test('FR-AITUI-014 AC-2/AC-3/AC-4: after a restart every entry is typed once and confirmed by the agent appearing', async () => {
  await withFixture(async (f) => {
    const first = f.make();
    await first.initialize();
    await first.saveAll([
      { tabId: 't1', mode: 'agent', agent: 'claude', launcher: 'claudep', args: ['--model', 'opus'], sessionId: CLAUDE_ID },
      { tabId: 't2', mode: 'agent', agent: 'codex', launcher: 'codex', args: [], sessionId: CODEX_ID },
      { tabId: 't3', mode: 'command', command: 'npm run dev' },
      { tabId: 't4', mode: 'shell' },
    ]);
    assert.deepEqual(await first.autoRestore(), [], 'a snapshot saved in this run is not restored by this run');

    // Restart: the tabs come back as shells with no agent in front.
    for (const runtime of Object.values(f.runtime)) runtime.foregroundAppId = null;
    const restarted = f.make();
    await restarted.initialize();
    const report = await restarted.autoRestore();
    assert.deepEqual(f.scheduled, [
      { tabId: 't1', command: 'claudep', args: ['--model', 'opus', '--resume', CLAUDE_ID] },
      { tabId: 't2', command: 'codex', args: ['resume', CODEX_ID] },
      { tabId: 't3', command: 'npm', args: ['run', 'dev'] },
    ]);
    assert.deepEqual(report.map((item) => [item.tabId, item.result]), [
      ['t1', 'waiting'], ['t2', 'waiting'], ['t3', 'typed'], ['t4', 'shell'],
    ]);
    // Claude comes up in t1; codex never does in t2.
    f.runtime.s1.foregroundAppId = 'claude';
    await sleep(120);
    const settled = restarted.getStatus().report;
    assert.deepEqual(settled.map((item) => [item.tabId, item.result]), [
      ['t1', 'confirmed'], ['t2', 'unconfirmed'], ['t3', 'typed'], ['t4', 'shell'],
    ]);
    assert.equal(settled[0].commandLine, 'claudep --model opus --resume 3f2a9c1e-5b7d-4c11-9a2e-0d6f81b4c7aa');
    assert.equal(settled[0].launcher, 'claudep', 'the report carries what the retry editor starts from');
    assert.deepEqual(settled[0].args, ['--model', 'opus']);
    assert.equal(settled[0].sessionId, CLAUDE_ID);
    assert.equal(restarted.getStatus().pendingCount, 0, 'the snapshot is used up');

    // AC-3: the next restart types nothing.
    const again = f.make();
    await again.initialize();
    assert.deepEqual(await again.autoRestore(), []);
    assert.equal(f.scheduled.length, 3);
  });
});

test('FR-AITUI-014 AC-4: an entry whose tab is gone fails with a reason', async () => {
  await withFixture(async (f) => {
    const first = f.make();
    await first.initialize();
    await first.saveAll([{ tabId: 't1', mode: 'agent', agent: 'claude', launcher: 'claude', args: [], sessionId: CLAUDE_ID }]);
    f.tabs.splice(0, 1);
    const restarted = f.make();
    await restarted.initialize();
    const report = await restarted.autoRestore();
    assert.equal(report[0].result, 'failed');
    assert.equal(report[0].reason, 'tab-missing');
  });
});

test('FR-AITUI-014 AC-6: retry types the corrected command and updates that tab only', async () => {
  await withFixture(async (f) => {
    const first = f.make();
    await first.initialize();
    await first.saveAll([
      { tabId: 't1', mode: 'agent', agent: 'claude', launcher: 'claude', args: [], sessionId: CLAUDE_ID },
      { tabId: 't2', mode: 'agent', agent: 'codex', launcher: 'codex', args: [], sessionId: CODEX_ID },
    ]);
    for (const runtime of Object.values(f.runtime)) runtime.foregroundAppId = null;
    f.runtime.s1.ptyPid = 99; // no agent under t1's shell this time
    const restarted = f.make();
    await restarted.initialize();
    await restarted.autoRestore();
    await sleep(120);
    const OTHER_CODEX = '0199a1f0-2c9e-7a11-8d4f-0b3e7c55a912';
    const item = await restarted.retry({ tabId: 't2', mode: 'agent', agent: 'codex', launcher: 'codexp', args: [], sessionId: OTHER_CODEX });
    assert.equal(item.result, 'waiting');
    assert.deepEqual(f.scheduled.at(-1), { tabId: 't2', command: 'codexp', args: ['resume', OTHER_CODEX] });
    f.runtime.s2.foregroundAppId = 'codex';
    await sleep(120);
    const report = restarted.getStatus().report;
    assert.deepEqual(report.map((entry) => [entry.tabId, entry.result]), [['t1', 'unconfirmed'], ['t2', 'confirmed']]);
    await assert.rejects(
      restarted.retry({ tabId: 't2', mode: 'agent', agent: 'codex', launcher: 'codex', args: [], sessionId: 'bad' }),
      (error: unknown) => error instanceof AppError && error.statusCode === 400,
    );
  });
});

test('FR-AITUI-014 AC-7: tabs left out of the snapshot are not in the report and get nothing typed', async () => {
  await withFixture(async (f) => {
    const first = f.make();
    await first.initialize();
    await first.saveAll([{ tabId: 't4', mode: 'shell' }]);
    const restarted = f.make();
    await restarted.initialize();
    const report = await restarted.autoRestore();
    assert.deepEqual(report.map((item) => item.tabId), ['t4']);
    assert.equal(f.scheduled.length, 0);
  });
});

test('FR-AITUI-014 AC-4: an agent found in the tab\'s process tree confirms the resume, even when the launcher is not registered', async () => {
  await withFixture(async (f) => {
    const first = f.make();
    await first.initialize();
    await first.saveAll([{ tabId: 't1', mode: 'agent', agent: 'claude', launcher: 'claude', args: [], sessionId: CLAUDE_ID }]);
    // After the restart nothing marks the tab as running an agent (e.g. it was started through an
    // unregistered wrapper), but claude.exe (pid 40) runs under the tab's shell (pid 20).
    for (const runtime of Object.values(f.runtime)) runtime.foregroundAppId = null;
    const restarted = f.make();
    await restarted.initialize();
    await restarted.autoRestore();
    await sleep(120);
    assert.equal(restarted.getStatus().report[0].result, 'confirmed');
  });
});

test('FR-AITUI-013 AC-1: the running command is shown without the shell quoting the resume was typed with', async () => {
  await withFixture(async (f) => {
    f.runtime.s2.launchCommand = `codexp 'resume' '${CODEX_ID}'`;
    const service = f.make();
    await service.initialize();
    const { tabs } = await service.preview();
    assert.equal(tabs[1].runningCommand, `codexp resume ${CODEX_ID}`);
    assert.equal(tabs[1].launcher, 'codexp');
    assert.deepEqual(tabs[1].args, []);
  });
});

test('FR-AITUI-015 AC-7: each automatic restore gets its own report id, so a dismissed report stays dismissed', async () => {
  await withFixture(async (f) => {
    const first = f.make();
    await first.initialize();
    assert.equal(first.getStatus().reportId, null, 'no restore yet, nothing to dismiss');
    await first.saveAll([{ tabId: 't3', mode: 'command', command: 'npm run dev' }]);
    await first.autoRestore();
    assert.equal(first.getStatus().reportId, null, 'a snapshot saved in this run is not restored, so there is no report');

    const restarted = f.make();
    await restarted.initialize();
    await restarted.autoRestore();
    const id = restarted.getStatus().reportId;
    assert.equal(typeof id, 'string');
    assert.ok(id);
    assert.equal(restarted.getStatus().reportId, id, 'reading the status again (a page reload) returns the same id');

    // The next restart restores a newer snapshot: a new report, a new id.
    await restarted.saveAll([{ tabId: 't3', mode: 'command', command: 'npm run dev' }]);
    const again = f.make();
    await again.initialize();
    await again.autoRestore();
    const next = again.getStatus().reportId;
    assert.ok(next);
    assert.notEqual(next, id);
  });
});
