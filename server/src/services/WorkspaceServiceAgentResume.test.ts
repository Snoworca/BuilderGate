/**
 * FR-AITUI-008 AC-1/AC-2/AC-4 — orphan recovery leaves saved tabs as shells,
 * and a resume command is typed into the tab quoted for its shell.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceService } from './WorkspaceService.js';

function stubSessionManager(): any {
  let seq = 0;
  const manager: any = {
    live: new Set<string>(),
    scheduled: [] as Array<{ sessionId: string; input: string }>,
    onCwdChange() {},
    onTerminalTitleChange() {},
    onSessionFinalized() {},
    hasSession(id: string) { return manager.live.has(id); },
    createSession() {
      const id = `pty-${++seq}`;
      manager.live.add(id);
      return { id };
    },
    getResolvedShellType() { return 'bash'; },
    scheduleRestoreInput(sessionId: string, input: string) {
      manager.scheduled.push({ sessionId, input });
    },
  };
  return manager;
}

async function makeService() {
  const sessions = stubSessionManager();
  const recoveryOptionService: any = {
    findEnabledById: (id: string) => (id === 'opt-claude' ? { id, command: 'claude', arguments: ['--continue'] } : null),
  };
  const service = new WorkspaceService(sessions, { recoveryOptionService, restoreInputDelayMs: 0 });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-agent-resume-'));
  (service as any).dataFilePath = path.join(dir, 'workspaces.json');
  const tab = (id: string, name: string) => ({
    id, workspaceId: 'w1', sessionId: `dead-${id}`, currentSessionId: `dead-${id}`, name, sortOrder: 0, colorIndex: 0,
    shellType: 'bash', lastCwd: '/work', recoveryOptionId: 'opt-claude', recoveryCommand: 'claude', recoveryArguments: ['--continue'],
  });
  (service as any).state = {
    workspaces: [{ id: 'w1', name: 'W1', sortOrder: 0, viewMode: 'tab', activeTabId: 't1', colorCounter: 2, createdAt: 'x', updatedAt: 'x' }],
    tabs: [tab('t1', 'saved'), tab('t2', 'plain')],
    gridLayouts: [],
  };
  return { service, sessions };
}

test('AC-1: a tab with a pending saved session is recovered as a shell only', async () => {
  const { service, sessions } = await makeService();
  service.setAgentResumePendingChecker((tabId) => tabId === 't1');
  const recovered = await service.checkOrphanTabs();
  assert.deepEqual(recovered.sort(), ['t1', 't2'], 'both tabs get a new shell');
  // FR-AITUI-012 AC-1: nothing is typed on its own, not even for the tab without a saved session.
  assert.equal(sessions.scheduled.length, 0);
});

test('FR-AITUI-012 AC-1/AC-2: orphan recovery never types a recovery command such as claude --continue', async () => {
  const { service, sessions } = await makeService();
  await service.checkOrphanTabs();
  assert.equal(sessions.scheduled.length, 0);
});

test('FR-AITUI-012 AC-1: a tab restart types nothing into the new shell', async () => {
  const { service, sessions } = await makeService();
  sessions.terminateSession = async () => {};
  sessions.getSessionCwd = () => '/work';
  await service.checkOrphanTabs();
  await service.restartTab('w1', 't1');
  assert.equal(sessions.scheduled.length, 0);
});

test('AC-2/AC-4: scheduleAgentResume types the quoted resume command into the tab', async () => {
  const { service, sessions } = await makeService();
  service.setAgentResumePendingChecker(() => true);
  await service.checkOrphanTabs();
  assert.equal(sessions.scheduled.length, 0);
  assert.equal(service.scheduleAgentResume('t1', 'claude', ['--resume', '7c1e0b52-4a0e-4f7b-9d61-2b8e5f0c3a19']), true);
  assert.equal(sessions.scheduled.length, 1);
  assert.match(sessions.scheduled[0].input, /claude\s+'?--resume'?\s+'?7c1e0b52-4a0e-4f7b-9d61-2b8e5f0c3a19'?/);
  assert.equal(service.scheduleAgentResume('missing', 'claude', ['--resume', 'x']), false, 'a missing tab is reported, not thrown');
});

test('FR-AITUI-014 AC-1: a tab in the snapshot reopens in the saved folder, the others in their own', async () => {
  const { service, sessions } = await makeService();
  const cwds: Array<string | undefined> = [];
  sessions.createSession = (_name: string, _shell: string, cwd?: string) => {
    const id = `pty-cwd-${cwds.length}`;
    cwds.push(cwd);
    sessions.live.add(id);
    return { id };
  };
  service.setRestoreCwdResolver((tabId) => (tabId === 't1' ? '/work/saved' : null));
  await service.checkOrphanTabs();
  assert.deepEqual(cwds, ['/work/saved', '/work']);
  assert.equal(service.getTab('t1').lastCwd, '/work/saved', 'the tab remembers the folder it reopened in');
});

// #242: the shells die in the last seconds before the server does; those exits are saved
// as stopped tabs. A tab the restored save holds, stopped after that save was taken, was live
// when it was saved, so it is recovered like any orphan. A tab stopped before the save was
// stopped by the user, and stays stopped.
test('FR-AITUI-014 AC-8: a tab stopped by a process exit after the restored save is recovered', async () => {
  const { service } = await makeService();
  const state = (service as any).state;
  const stop = (tab: any, at: string) => Object.assign(tab, { lifecycleState: 'stopped', recoverable: false, lifecycleReason: 'process-exit', lastExitCode: 0, lifecycleUpdatedAt: at });
  stop(state.tabs[0], '2026-11-17T23:41:10.000Z');
  stop(state.tabs[1], '2026-11-17T23:41:10.000Z');
  const asked: Array<[string, string | undefined]> = [];
  service.setStoppedTabRecoveryChecker((tabId, stoppedAt) => {
    asked.push([tabId, stoppedAt]);
    return tabId === 't1';
  });
  const recovered = await service.checkOrphanTabs();
  assert.deepEqual(recovered, ['t1'], 'only the tab the checker accepts');
  assert.deepEqual(asked, [['t1', '2026-11-17T23:41:10.000Z'], ['t2', '2026-11-17T23:41:10.000Z']], 'asked with the time the tab stopped');
  const t1 = state.tabs.find((tab: any) => tab.id === 't1');
  assert.equal(t1.lifecycleState, 'active');
  assert.equal(t1.recoverable, true);
  assert.equal(state.tabs.find((tab: any) => tab.id === 't2').lifecycleState, 'stopped');
});

test('FR-AITUI-014 AC-8: a tab stopped by a delete is not recovered even when the checker accepts it', async () => {
  const { service } = await makeService();
  const state = (service as any).state;
  Object.assign(state.tabs[0], { lifecycleState: 'stopped', recoverable: false, lifecycleReason: 'direct-session-delete' });
  Object.assign(state.tabs[1], { lifecycleState: 'stopped', recoverable: false, lifecycleReason: 'tab-delete' });
  service.setStoppedTabRecoveryChecker(() => true);
  assert.deepEqual(await service.checkOrphanTabs(), []);
});

test('FR-AITUI-014 AC-8: without a checker a stopped tab stays stopped', async () => {
  const { service } = await makeService();
  const state = (service as any).state;
  Object.assign(state.tabs[0], { lifecycleState: 'stopped', recoverable: false, lifecycleReason: 'process-exit' });
  service.setAgentResumePendingChecker(() => true);
  assert.deepEqual(await service.checkOrphanTabs(), ['t2']);
});
