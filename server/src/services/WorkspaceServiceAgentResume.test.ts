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
