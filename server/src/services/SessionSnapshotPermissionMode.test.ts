/**
 * FR-AITUI-025 — a Claude tab is saved, and resumed, in the permission mode it runs in, not in
 * whatever mode the tab's first launch line carried (or none, when that line was never seen).
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { SessionSnapshotService, type SnapshotTabRecord, type SnapshotTabRuntime } from './SessionSnapshotService.js';
import type { AgentRoots, ProcessInfo } from './agentSession/agentSessionResolver.js';
import {
  applyClaudePermissionMode,
  decideLivePermissionMode,
  permissionModeOfCommandLine,
  readClaudePermissionModes,
} from './agentSession/claudePermissionMode.js';

const SHARED = process.platform === 'win32' ? 'C:\\Work\\og' : '/work/og';
const WORKTREE = process.platform === 'win32' ? 'C:\\Work\\og-2136' : '/work/og-2136';
const BG_ID = '63cdfaba-cc1c-4945-a156-d43b646e6cef';
const MINE_ID = '0616912d-d940-4375-8847-24d90c851c05';
const ID = 'a6670098-4833-4fd2-807e-c2290d86a45e';
/** When the tab's Claude started in the fixtures. */
const STARTED = Date.parse('2026-11-23T10:00:00.000Z');
const BEFORE = '2026-11-23T09:00:00.000Z';
const AFTER = '2026-11-23T11:00:00.000Z';

/** Claude's project folder name for a cwd: every character but [A-Za-z0-9] becomes '-'. */
const slug = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, '-');

/** A user message as Claude records it, with the mode it was sent in. */
function message(mode: string, at: string): string {
  return JSON.stringify({ type: 'user', permissionMode: mode, timestamp: at, message: { role: 'user', content: 'hi' } });
}

/** The entry Claude writes after a turn; it carries no time. */
function modeEntry(mode: string): string {
  return JSON.stringify({ type: 'permission-mode', permissionMode: mode, sessionId: ID });
}

function writeTranscript(claudeHome: string, folder: string, sessionId: string, lines: string[]): void {
  const dir = path.join(claudeHome, 'projects', folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${sessionId}.jsonl`), `${lines.join('\n')}\n`);
}

// ---------------------------------------------------------------------------
// AC-2 / AC-3: the flags
// ---------------------------------------------------------------------------

test('FR-AITUI-025 AC-2: bypassPermissions adds --dangerously-skip-permissions before the selector', () => {
  assert.deepEqual(applyClaudePermissionMode(['--resume', ID], 'bypassPermissions'), ['--dangerously-skip-permissions', '--resume', ID]);
  assert.deepEqual(
    applyClaudePermissionMode(['--dangerously-skip-permissions', '--resume', ID], 'bypassPermissions'),
    ['--dangerously-skip-permissions', '--resume', ID],
    'not added twice',
  );
});

test('FR-AITUI-025 AC-2: the other modes go through --permission-mode, default adds nothing', () => {
  for (const mode of ['acceptEdits', 'plan', 'auto', 'dontAsk'] as const) {
    assert.deepEqual(applyClaudePermissionMode(['--model', 'opus', '--resume', ID], mode), ['--model', 'opus', '--permission-mode', mode, '--resume', ID]);
  }
  assert.deepEqual(applyClaudePermissionMode(['--model', 'opus', '--resume', ID], 'default'), ['--model', 'opus', '--resume', ID]);
});

test('FR-AITUI-025 AC-3: the old permission flags go first, in both spellings', () => {
  assert.deepEqual(applyClaudePermissionMode(['--permission-mode', 'plan', '--resume', ID], 'bypassPermissions'), ['--dangerously-skip-permissions', '--resume', ID]);
  assert.deepEqual(applyClaudePermissionMode(['--permission-mode=plan', '--resume', ID], 'default'), ['--resume', ID]);
  assert.deepEqual(applyClaudePermissionMode(['--permission-mode', 'acceptEdits', '--resume', ID], 'auto'), ['--permission-mode', 'auto', '--resume', ID]);
});

test('FR-AITUI-025 AC-3: leaving bypass keeps the way back to it through Shift+Tab', () => {
  assert.deepEqual(
    applyClaudePermissionMode(['--dangerously-skip-permissions', '--resume', ID], 'auto'),
    ['--allow-dangerously-skip-permissions', '--permission-mode', 'auto', '--resume', ID],
  );
  assert.deepEqual(applyClaudePermissionMode(['--dangerously-skip-permissions', '--resume', ID], 'default'), ['--allow-dangerously-skip-permissions', '--resume', ID]);
  assert.deepEqual(
    applyClaudePermissionMode(['--allow-dangerously-skip-permissions', '--dangerously-skip-permissions', '--resume', ID], 'default'),
    ['--allow-dangerously-skip-permissions', '--resume', ID],
    'not added twice',
  );
});

// ---------------------------------------------------------------------------
// AC-1: the sources and their order
// ---------------------------------------------------------------------------

test('FR-AITUI-025 AC-1: a process command line names its mode; a prompt argument never reads as a flag', () => {
  assert.equal(permissionModeOfCommandLine(`C:\\npm\\claude.exe --dangerously-skip-permissions --resume ${ID}`), 'bypassPermissions');
  assert.equal(permissionModeOfCommandLine('claude --permission-mode plan'), 'plan');
  assert.equal(permissionModeOfCommandLine('claude --permission-mode=acceptEdits'), 'acceptEdits');
  assert.equal(permissionModeOfCommandLine(`claude --resume ${ID}`), 'default');
  assert.equal(permissionModeOfCommandLine('claude -n x "run with --dangerously-skip-permissions please"'), 'default');
  assert.equal(permissionModeOfCommandLine('claude --permission-mode yolo'), 'unknown', 'a mode this server does not know');
  assert.equal(permissionModeOfCommandLine(null), null);
});

const none = { last: null, lastStamped: null };

test('FR-AITUI-025 AC-1: a message sent since the agent started tells the mode it runs in now', () => {
  assert.equal(decideLivePermissionMode({
    launchKnown: true, processCommandLine: 'claude --dangerously-skip-permissions', agentStartedAtMs: STARTED,
    transcript: { last: 'auto', lastStamped: { mode: 'auto', atMs: Date.parse(AFTER) } },
  }), 'auto', 'changed with Shift+Tab after launch');
});

test('FR-AITUI-025 AC-1: a transcript older than the launch does not override it', () => {
  // Resumed with a new flag, no message sent yet: the transcript still ends in the old mode.
  assert.equal(decideLivePermissionMode({
    launchKnown: true, processCommandLine: 'claude --dangerously-skip-permissions', agentStartedAtMs: STARTED,
    transcript: { last: 'default', lastStamped: { mode: 'default', atMs: Date.parse(BEFORE) } },
  }), null, 'the launch flags already in the resume arguments stand');
  assert.equal(decideLivePermissionMode({
    launchKnown: false, processCommandLine: 'claude --dangerously-skip-permissions', agentStartedAtMs: STARTED,
    transcript: { last: 'default', lastStamped: { mode: 'default', atMs: Date.parse(BEFORE) } },
  }), 'bypassPermissions', 'the process command line when the launch line was never seen');
});

test('FR-AITUI-025 AC-1: a mode changed during the turn of the last message is the one saved', () => {
  // Sent in plan mode, switched to auto before the turn ended: the entry after the message says auto.
  assert.equal(decideLivePermissionMode({
    launchKnown: true, processCommandLine: null, agentStartedAtMs: STARTED,
    transcript: { last: 'auto', lastStamped: { mode: 'plan', atMs: Date.parse(AFTER) } },
  }), 'auto');
});

test('FR-AITUI-025 AC-1: a process mode this server does not know keeps the command as it is', () => {
  assert.equal(decideLivePermissionMode({
    launchKnown: false, processCommandLine: 'claude --permission-mode someNewMode', agentStartedAtMs: STARTED,
    transcript: { last: 'bypassPermissions', lastStamped: null },
  }), null, 'not the record of an earlier run');
});

test('FR-AITUI-025 AC-1: with neither launch line nor process, the transcript last record is used', () => {
  assert.equal(decideLivePermissionMode({ launchKnown: false, processCommandLine: null, agentStartedAtMs: STARTED, transcript: { last: 'bypassPermissions', lastStamped: null } }), 'bypassPermissions');
  assert.equal(decideLivePermissionMode({ launchKnown: false, processCommandLine: null, agentStartedAtMs: undefined, transcript: none }), null, 'nothing known');
  assert.equal(decideLivePermissionMode({ launchKnown: true, processCommandLine: null, agentStartedAtMs: undefined, transcript: { last: 'default', lastStamped: null } }), null);
});

async function withHome(run: (claudeHome: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bg-permission-mode-'));
  try {
    await run(path.join(dir, 'claude'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('FR-AITUI-025 AC-1: the transcript gives its last record and its last timestamped one', async () => {
  await withHome(async (home) => {
    writeTranscript(home, slug(SHARED), ID, [
      message('bypassPermissions', BEFORE),
      modeEntry('bypassPermissions'),
      message('auto', AFTER),
      modeEntry('auto'),
      modeEntry('default'),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'ok' } }),
    ]);
    assert.deepEqual(await readClaudePermissionModes(home, ID, [SHARED]), { last: 'default', lastStamped: { mode: 'auto', atMs: Date.parse(AFTER) } });
  });
});

test('FR-AITUI-025 AC-1: a mode far before the end of a long transcript is still found', async () => {
  await withHome(async (home) => {
    const filler = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'x'.repeat(4000) } });
    writeTranscript(home, slug(SHARED), ID, [message('bypassPermissions', BEFORE), ...Array.from({ length: 300 }, () => filler)]);
    assert.deepEqual(await readClaudePermissionModes(home, ID, [SHARED]), { last: 'bypassPermissions', lastStamped: { mode: 'bypassPermissions', atMs: Date.parse(BEFORE) } });
  });
});

test('FR-AITUI-025 AC-1: a message longer than one read chunk is read whole', async () => {
  await withHome(async (home) => {
    // A pasted screenshot makes a user line of several hundred KB.
    const long = JSON.stringify({ type: 'user', permissionMode: 'auto', timestamp: AFTER, message: { role: 'user', content: 'x'.repeat(600 * 1024) } });
    writeTranscript(home, slug(SHARED), ID, [message('bypassPermissions', BEFORE), long, modeEntry('auto')]);
    assert.deepEqual(await readClaudePermissionModes(home, ID, [SHARED]), { last: 'auto', lastStamped: { mode: 'auto', atMs: Date.parse(AFTER) } });
  });
});

test('FR-AITUI-025 AC-1: a transcript outside the folder the cwd names is found by its id', async () => {
  await withHome(async (home) => {
    writeTranscript(home, 'some-other-folder', ID, [modeEntry('bypassPermissions')]);
    assert.deepEqual(await readClaudePermissionModes(home, ID, [SHARED]), { last: 'bypassPermissions', lastStamped: null });
  });
});

test('FR-AITUI-025 AC-1: no transcript, no mode in it, or an unknown mode gives no answer', async () => {
  await withHome(async (home) => {
    assert.deepEqual(await readClaudePermissionModes(home, ID, [SHARED]), none, 'no transcript');
    writeTranscript(home, slug(SHARED), ID, [JSON.stringify({ type: 'assistant' })]);
    assert.deepEqual(await readClaudePermissionModes(home, ID, [SHARED]), none, 'no mode recorded');
    writeTranscript(home, slug(SHARED), ID, [message('yolo', AFTER)]);
    assert.deepEqual(await readClaudePermissionModes(home, ID, [SHARED]), none, 'a mode this server does not know');
    assert.deepEqual(await readClaudePermissionModes(home, '../escape', [SHARED]), none, 'not a session id');
  });
});

// ---------------------------------------------------------------------------
// The service: saves (AC-1) and restores (AC-4 / AC-5)
// ---------------------------------------------------------------------------

interface Fixture {
  dir: string;
  roots: AgentRoots;
  dataDir: string;
  runtime: Record<string, SnapshotTabRuntime>;
  processes: ProcessInfo[];
  scheduled: Array<{ tabId: string; command: string; args: string[] }>;
  alive: Set<number>;
  make: () => SessionSnapshotService;
}

function pidFile(roots: AgentRoots, pid: number, sessionId: string, cwd: string, kind: string): void {
  writeFileSync(path.join(roots.claudeHome, 'sessions', `${pid}.json`), JSON.stringify({ pid, sessionId, cwd, startedAt: 1000 + pid, kind }));
}

function fixture(): Fixture {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bg-snapshot-permission-'));
  const roots: AgentRoots = {
    claudeHome: path.join(dir, 'claude'),
    codexHome: path.join(dir, 'codex'),
    opencodeData: path.join(dir, 'opencode'),
    hermesHome: path.join(dir, 'hermes'),
  };
  mkdirSync(path.join(roots.claudeHome, 'sessions'), { recursive: true });
  pidFile(roots, 50, BG_ID, WORKTREE, 'bg');
  pidFile(roots, 61, MINE_ID, SHARED, 'interactive');
  const tabs: SnapshotTabRecord[] = [
    { workspaceId: 'w1', workspaceName: 'og', tab: { id: 'ta', name: 'og-flow 2136', sessionId: 'sa', lastCwd: SHARED } },
    { workspaceId: 'w1', workspaceName: 'og', tab: { id: 'tb', name: 'issue 2025', sessionId: 'sb', lastCwd: SHARED } },
  ];
  const runtime: Record<string, SnapshotTabRuntime> = {
    sa: { foregroundAppId: 'claude', foregroundStartedAt: STARTED, agentStartedAt: STARTED, ptyPid: 30, cwd: SHARED, launchCommand: 'claude attach 63cdfaba' },
    sb: { foregroundAppId: 'claude', foregroundStartedAt: STARTED, agentStartedAt: STARTED, ptyPid: 60, cwd: SHARED, launchCommand: 'claude --dangerously-skip-permissions' },
  };
  const processes: ProcessInfo[] = [
    { pid: 30, ppid: 1, name: 'powershell.exe' },
    { pid: 31, ppid: 30, name: 'claude.exe', createdAtMs: STARTED, commandLine: 'claude.exe attach 63cdfaba' },
    { pid: 60, ppid: 1, name: 'powershell.exe' },
    { pid: 61, ppid: 60, name: 'claude.exe', createdAtMs: STARTED, commandLine: `claude.exe --dangerously-skip-permissions --resume ${MINE_ID}` },
  ];
  const scheduled: Fixture['scheduled'] = [];
  const alive = new Set<number>([50, 61]);
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
    now: () => new Date('2026-11-23T12:00:00.000Z'),
    minuteMs: 10,
  });
  return { dir, roots, dataDir, runtime, processes, scheduled, alive, make };
}

async function withFixture(run: (f: Fixture) => Promise<void>): Promise<void> {
  const f = fixture();
  try {
    await run(f);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
}

const readAuto = (f: Fixture) => JSON.parse(readFileSync(path.join(f.dataDir, 'session-autosave.json'), 'utf8'));
const autoArgs = (f: Fixture, tabId: string): string[] => readAuto(f).entries.find((e: { tabId: string }) => e.tabId === tabId)?.resumeArguments;

async function autoSaved(f: Fixture): Promise<void> {
  const service = f.make();
  await service.initialize();
  assert.equal((await service.autoSave()).result, 'saved');
}

test('FR-AITUI-025 AC-1: a tab whose launch line was never seen is saved in the mode its process runs in', async () => {
  await withFixture(async (f) => {
    // Launched before this server run (or recalled from shell history): no launch line.
    delete f.runtime.sb.launchCommand;
    await autoSaved(f);
    assert.deepEqual(autoArgs(f, 'tb'), ['--dangerously-skip-permissions', '--resume', MINE_ID]);
  });
});

test('FR-AITUI-025 AC-1: a tab resumed with a new flag keeps it while its transcript still ends in the old mode', async () => {
  await withFixture(async (f) => {
    writeTranscript(f.roots.claudeHome, slug(SHARED), MINE_ID, [message('default', BEFORE), modeEntry('default')]);
    await autoSaved(f);
    assert.deepEqual(autoArgs(f, 'tb'), ['--dangerously-skip-permissions', '--resume', MINE_ID]);
  });
});

test('FR-AITUI-025 AC-1: a mode changed with Shift+Tab after the launch is saved', async () => {
  await withFixture(async (f) => {
    writeTranscript(f.roots.claudeHome, slug(SHARED), MINE_ID, [message('bypassPermissions', AFTER), message('auto', AFTER)]);
    await autoSaved(f);
    assert.deepEqual(autoArgs(f, 'tb'), ['--allow-dangerously-skip-permissions', '--permission-mode', 'auto', '--resume', MINE_ID]);
  });
});

test('FR-AITUI-025 AC-1: with no launch line and no process list, the transcript last record is used', async () => {
  await withFixture(async (f) => {
    delete f.runtime.sb.launchCommand;
    f.processes.splice(0, f.processes.length);
    writeTranscript(f.roots.claudeHome, slug(SHARED), MINE_ID, [message('bypassPermissions', BEFORE)]);
    await autoSaved(f);
    assert.deepEqual(autoArgs(f, 'tb'), ['--dangerously-skip-permissions', '--resume', MINE_ID]);
  });
});

test('FR-AITUI-025 AC-1: a save picked in the save list follows the same rule', async () => {
  await withFixture(async (f) => {
    delete f.runtime.sb.launchCommand;
    const service = f.make();
    await service.initialize();
    const { snapshot } = await service.save(['tb']);
    assert.deepEqual(snapshot.entries.find((e) => e.tabId === 'tb')?.resumeArguments, ['--dangerously-skip-permissions', '--resume', MINE_ID]);
  });
});

/** What the save dialog sends back for a tab when the user changes nothing. */
async function dialogItem(service: SessionSnapshotService, tabId: string) {
  const { tabs } = await service.preview();
  const tab = tabs.find((t) => t.tabId === tabId);
  assert.ok(tab && tab.agent && tab.sessionId && tab.launcher);
  return { tab, item: { tabId, mode: 'agent' as const, agent: tab.agent, sessionId: tab.sessionId, launcher: tab.launcher, args: tab.args } };
}

test('FR-AITUI-025 AC-6: the save dialog shows the mode the tab runs in when the launch line was never seen', async () => {
  await withFixture(async (f) => {
    delete f.runtime.sb.launchCommand;
    const service = f.make();
    await service.initialize();
    const { tab, item } = await dialogItem(service, 'tb');
    assert.deepEqual(tab.args, ['--dangerously-skip-permissions']);
    const { snapshot } = await service.saveAll([item]);
    assert.deepEqual(snapshot.entries.find((e) => e.tabId === 'tb')?.resumeArguments, ['--dangerously-skip-permissions', '--resume', MINE_ID]);
  });
});

test('FR-AITUI-025 AC-6: the save dialog shows a mode changed after a flag-less launch', async () => {
  await withFixture(async (f) => {
    // Resumed without a flag by an older build, then switched to bypass with Shift+Tab.
    f.runtime.sb.launchCommand = `claude --resume ${MINE_ID}`;
    f.processes[3] = { ...f.processes[3], commandLine: `claude.exe --resume ${MINE_ID}` };
    writeTranscript(f.roots.claudeHome, slug(SHARED), MINE_ID, [message('bypassPermissions', AFTER)]);
    const service = f.make();
    await service.initialize();
    const { tab, item } = await dialogItem(service, 'tb');
    assert.deepEqual(tab.args, ['--dangerously-skip-permissions']);
    const { snapshot } = await service.saveAll([item]);
    assert.deepEqual(snapshot.entries.find((e) => e.tabId === 'tb')?.resumeArguments, ['--dangerously-skip-permissions', '--resume', MINE_ID]);
  });
});

test('FR-AITUI-025 AC-6: arguments the user edits in the save dialog are saved as edited', async () => {
  await withFixture(async (f) => {
    delete f.runtime.sb.launchCommand;
    const service = f.make();
    await service.initialize();
    const { item } = await dialogItem(service, 'tb');
    const { snapshot } = await service.saveAll([{ ...item, args: [] }]);
    assert.deepEqual(snapshot.entries.find((e) => e.tabId === 'tb')?.resumeArguments, ['--resume', MINE_ID]);
  });
});

test('FR-AITUI-025 AC-6: a tab whose Claude runs in default mode shows no permission flag', async () => {
  await withFixture(async (f) => {
    f.runtime.sb.launchCommand = 'claude';
    f.processes[3] = { ...f.processes[3], commandLine: `claude.exe --resume ${MINE_ID}` };
    const service = f.make();
    await service.initialize();
    const { tab } = await dialogItem(service, 'tb');
    assert.deepEqual(tab.args, []);
  });
});

test('FR-AITUI-025 AC-4/AC-5: a restore types the saved command, and the report shows it', async () => {
  await withFixture(async (f) => {
    await autoSaved(f);
    // After the save the transcript says otherwise (an older record); the save stands.
    writeTranscript(f.roots.claudeHome, slug(SHARED), MINE_ID, [modeEntry('default')]);
    const restarted = f.make();
    await restarted.initialize();
    const report = await restarted.autoRestore();
    assert.deepEqual(f.scheduled.find((s) => s.tabId === 'tb')?.args, ['--dangerously-skip-permissions', '--resume', MINE_ID]);
    const item = report.find((r) => r.tabId === 'tb');
    assert.equal(item?.commandLine, `claude --dangerously-skip-permissions --resume ${MINE_ID}`);
  });
});

test('FR-AITUI-025 AC-4/AC-5: an ended attach resumed by its id gets the mode its transcript recorded', async () => {
  await withFixture(async (f) => {
    writeTranscript(f.roots.claudeHome, slug(WORKTREE), BG_ID, [message('bypassPermissions', BEFORE), modeEntry('bypassPermissions')]);
    await autoSaved(f);
    f.alive.delete(50);
    rmSync(path.join(f.roots.claudeHome, 'sessions', '50.json'));
    const restarted = f.make();
    await restarted.initialize();
    const report = await restarted.autoRestore();
    assert.deepEqual(f.scheduled.find((s) => s.tabId === 'ta')?.args, ['--dangerously-skip-permissions', '--resume', BG_ID]);
    assert.equal(report.find((r) => r.tabId === 'ta')?.commandLine, `claude --dangerously-skip-permissions --resume ${BG_ID}`);
  });
});

test('FR-AITUI-025 AC-4: a live attach is saved and attached again unchanged', async () => {
  await withFixture(async (f) => {
    writeTranscript(f.roots.claudeHome, slug(WORKTREE), BG_ID, [message('bypassPermissions', AFTER)]);
    await autoSaved(f);
    assert.deepEqual(autoArgs(f, 'ta'), ['attach', '63cdfaba']);
    const restarted = f.make();
    await restarted.initialize();
    await restarted.autoRestore();
    assert.deepEqual(f.scheduled.find((s) => s.tabId === 'ta')?.args, ['attach', '63cdfaba']);
  });
});

test('FR-AITUI-025 AC-4: a retry with arguments the user corrected is typed as corrected', async () => {
  await withFixture(async (f) => {
    writeTranscript(f.roots.claudeHome, slug(SHARED), MINE_ID, [message('bypassPermissions', AFTER)]);
    const service = f.make();
    await service.initialize();
    await service.retry({ tabId: 'tb', mode: 'agent', agent: 'claude', sessionId: MINE_ID, launcher: 'claude', args: ['--model', 'opus'] });
    assert.deepEqual(f.scheduled.find((s) => s.tabId === 'tb')?.args, ['--model', 'opus', '--resume', MINE_ID]);
  });
});
