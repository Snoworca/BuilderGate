import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { SessionSnapshotService, type SnapshotTabRecord } from './SessionSnapshotService.js';
import type { AgentRoots, ProcessInfo } from './agentSession/agentSessionResolver.js';

// FR-AITUI-007 / FR-AITUI-008 — saving the sessions and resuming them.

const CWD_A = process.platform === 'win32' ? 'C:\\Work\\og\\api' : '/work/og/api';
const CWD_B = process.platform === 'win32' ? 'C:\\Work\\og\\web' : '/work/og/web';
const CLAUDE_ID = '7c1e0b52-4a0e-4f7b-9d61-2b8e5f0c3a19';

function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bg-snapshot-'));
  const roots: AgentRoots = {
    claudeHome: path.join(dir, 'claude'),
    codexHome: path.join(dir, 'codex'),
    opencodeData: path.join(dir, 'opencode'),
    hermesHome: path.join(dir, 'hermes'),
  };
  mkdirSync(path.join(roots.claudeHome, 'sessions'), { recursive: true });
  writeFileSync(path.join(roots.claudeHome, 'sessions', '40.json'), JSON.stringify({ pid: 40, sessionId: CLAUDE_ID, cwd: CWD_A, startedAt: 1000 }));
  const tabs: SnapshotTabRecord[] = [
    {
      workspaceId: 'w1', workspaceName: 'orchestrationgrid',
      tab: { id: 't1', name: 'api-server', sessionId: 's1', lastCwd: CWD_A, recoveryCommand: 'claudep', recoveryArguments: ['--dangerously-skip-permissions', '--continue'] },
    },
    {
      workspaceId: 'w1', workspaceName: 'orchestrationgrid',
      tab: { id: 't2', name: 'web-ui', sessionId: 's2', lastCwd: CWD_B },
    },
    {
      workspaceId: 'w1', workspaceName: 'orchestrationgrid',
      tab: { id: 't3', name: 'shell', sessionId: 's3', lastCwd: CWD_B },
    },
  ];
  const processes: ProcessInfo[] = [
    { pid: 20, ppid: 1, name: 'powershell.exe' },
    { pid: 40, ppid: 20, name: 'claude.exe', createdAtMs: 1000 },
  ];
  const scheduled: Array<{ tabId: string; command: string; args: string[] }> = [];
  const runtime: Record<string, { foregroundAppId: 'claude' | 'codex' | 'hermes' | 'opencode' | null; ptyPid: number; foregroundStartedAt?: number; launchCommand?: string | null }> = {
    s1: { foregroundAppId: null, ptyPid: 20 },
    s2: { foregroundAppId: 'codex', ptyPid: 21, foregroundStartedAt: 5000 },
    s3: { foregroundAppId: null, ptyPid: 22 },
  };
  const service = new SessionSnapshotService({
    dataPath: path.join(dir, 'data', 'session-snapshot.json'),
    listTabs: () => tabs,
    getRuntime: (sessionId) => {
      const value = runtime[sessionId];
      return value ? { ...value, outputHint: null } : null;
    },
    scheduleResume: (tabId, command, args) => {
      if (!tabs.some((record) => record.tab.id === tabId)) return false;
      scheduled.push({ tabId, command, args });
      return true;
    },
    listProcesses: async () => processes,
    rootsFor: async () => roots,
    now: () => new Date('2026-09-26T04:40:00.000Z'),
  });
  return { dir, service, tabs, scheduled, runtime };
}

test('FR-AITUI-007 AC-4: candidates are the tabs running an agent or matched to an AI recovery command', async () => {
  const { dir, service } = fixture();
  try {
    await service.initialize();
    const candidates = service.getCandidates();
    assert.deepEqual(candidates.map((c) => [c.tabId, c.agent]), [['t1', 'claude'], ['t2', 'codex']]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('FR-AITUI-007 AC-1/AC-2: save resolves ids, writes the snapshot and reports found and not found', async () => {
  const { dir, service } = fixture();
  try {
    await service.initialize();
    const { snapshot, results } = await service.save(['t1', 't2']);
    assert.equal(snapshot.savedAt, '2026-09-26T04:40:00.000Z');
    assert.deepEqual(results.map((r) => [r.tabId, r.status]), [['t1', 'found'], ['t2', 'not-found']]);
    const entry = snapshot.entries[0];
    assert.equal(entry.sessionId, CLAUDE_ID);
    assert.equal(entry.confidence, 'exact');
    assert.equal(entry.restore, 'pending');
    assert.equal(entry.resumeCommand, 'claudep');
    assert.deepEqual(entry.resumeArguments, ['--dangerously-skip-permissions', '--resume', CLAUDE_ID]);
    assert.equal(snapshot.entries.length, 1, 'a tab without an id is not a resumable entry');
    // FR-AITUI-017 AC-1/AC-2: a manual save is its own file in the list.
    const onDisk = JSON.parse(readFileSync(path.join(dir, 'data', 'session-snapshots', `${snapshot.id}.json`), 'utf8'));
    assert.equal(onDisk.entries[0].sessionId, CLAUDE_ID);
    assert.equal(service.getStatus().pendingCount, 1);
    assert.equal(service.getStatus().restorable, false, 'a snapshot saved in this run is not offered for resuming yet');
    assert.equal(service.hasPendingForTab('t1'), false, 'FR-AITUI-018 AC-1: a save of this run is restored by the next start, not this one');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('FR-AITUI-008 AC-2/AC-5: restore sends the selected, skips the rest, and never asks twice', async () => {
  const { dir, service, scheduled } = fixture();
  try {
    await service.initialize();
    await service.save(['t1']);
    const { results } = await service.restore(['t1']);
    assert.deepEqual(results, [{ tabId: 't1', restore: 'restored' }]);
    assert.deepEqual(scheduled, [{ tabId: 't1', command: 'claudep', args: ['--dangerously-skip-permissions', '--resume', CLAUDE_ID] }]);
    assert.equal(service.getStatus().pendingCount, 0);
    assert.equal(service.hasPendingForTab('t1'), false);
    const again = await service.restore(['t1']);
    assert.deepEqual(again.results, [], 'a processed entry is not restored again');
    assert.equal(scheduled.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('FR-AITUI-008 AC-2: an unselected pending entry is skipped and a missing tab fails', async () => {
  const { dir, service, tabs } = fixture();
  try {
    await service.initialize();
    await service.save(['t1']);
    tabs.splice(0, 1);
    const skipped = await service.restore([]);
    assert.deepEqual(skipped.results, [{ tabId: 't1', restore: 'skipped' }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const second = fixture();
  try {
    await second.service.initialize();
    await second.service.save(['t1']);
    second.tabs.splice(0, 1);
    const failed = await second.service.restore(['t1']);
    assert.deepEqual(failed.results, [{ tabId: 't1', restore: 'failed' }]);
  } finally {
    rmSync(second.dir, { recursive: true, force: true });
  }
});

test('FR-AITUI-007 AC-3: the snapshot survives a restart and can be discarded', async () => {
  const { dir, service } = fixture();
  try {
    await service.initialize();
    await service.save(['t1']);
    const reloaded = fixture();
    // point the second service at the first one's file
    const other = new SessionSnapshotService({
      dataPath: path.join(dir, 'data', 'session-snapshot.json'),
      listTabs: () => [],
      getRuntime: () => null,
      scheduleResume: () => false,
    });
    await other.initialize();
    assert.equal(other.getStatus().pendingCount, 1);
    // FR-AITUI-018 AC-1 (2026-10-08): the newest save is restored at start without asking, so nothing is offered.
    assert.equal(other.getStatus().restorable, false);
    assert.equal(other.hasPendingForTab('t1'), true);
    await other.discard();
    assert.equal(other.getStatus().snapshot, null);
    assert.equal(existsSync(path.join(dir, 'data', 'session-snapshot.json')), false);
    rmSync(reloaded.dir, { recursive: true, force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a corrupt snapshot file is set aside rather than trusted', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bg-snapshot-bad-'));
  try {
    mkdirSync(path.join(dir, 'data'), { recursive: true });
    const file = path.join(dir, 'data', 'session-snapshot.json');
    writeFileSync(file, '{ not json');
    const service = new SessionSnapshotService({ dataPath: file, listTabs: () => [], getRuntime: () => null, scheduleResume: () => false });
    await service.initialize();
    assert.equal(service.getStatus().snapshot, null);
    const tampered = { version: 1, savedAt: 'x', entries: [{ tabId: 't', agent: 'claude', sessionId: '-rf; rm', resumeCommand: 'claude', resumeArguments: [], restore: 'pending' }] };
    writeFileSync(file, JSON.stringify(tampered));
    await service.initialize();
    assert.equal(service.getStatus().pendingCount, 0, 'an entry whose id fails the format check is dropped');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// FR-AITUI-011 AC-4/AC-5: an alias-launched agent with no recovery option is a candidate, and
// its resume command keeps the alias and the typed arguments, dropping --continue.
test('FR-AITUI-011 AC-4/AC-5: the resume command is rebuilt from the launch command line', async () => {
  const { dir, service, tabs, runtime } = fixture();
  try {
    delete tabs[0].tab.recoveryCommand;
    delete tabs[0].tab.recoveryArguments;
    runtime.s1 = { foregroundAppId: 'claude', ptyPid: 20, launchCommand: 'claudep --model opus --continue' };
    await service.initialize();
    assert.ok(service.getCandidates().some((c) => c.tabId === 't1' && c.agent === 'claude'));
    const { snapshot } = await service.save(['t1']);
    const entry = snapshot.entries[0];
    assert.equal(entry.resumeCommand, 'claudep');
    assert.deepEqual(entry.resumeArguments, ['--model', 'opus', '--resume', CLAUDE_ID]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('FR-AITUI-011 AC-4: a codex session started with resume <old id> is saved with the new id only', async () => {
  const { buildResumeCommand } = await import('./agentSession/resumeCommand.js');
  const { splitLaunchCommand } = await import('../utils/recoveryCommand.js');
  const launched = splitLaunchCommand('codexp resume 01a0e618-5e46-7880-8896-159d8350b34d');
  assert.ok(launched);
  const resume = buildResumeCommand('codex', '0199a3f2-7b41-7c30-9e5d-4f2a8b1c6d70', launched);
  assert.equal(resume.command, 'codexp');
  assert.deepEqual(resume.args, ['resume', '0199a3f2-7b41-7c30-9e5d-4f2a8b1c6d70']);
});
