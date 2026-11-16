/**
 * FR-AITUI-024 AC-4: a session's waiting mark reaches every connection through
 * tab:updated, shows in the workspace state, and is never written to disk.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceService } from './WorkspaceService.js';

function stubSessionManager(): any {
  const manager: any = {
    awaitingInputCallback: null as null | ((sessionId: string, awaiting: boolean) => void),
    onCwdChange() {},
    onTerminalTitleChange() {},
    onSessionFinalized() {},
    onAwaitingInputChange(cb: (sessionId: string, awaiting: boolean) => void) { manager.awaitingInputCallback = cb; },
    hasSession() { return true; },
  };
  return manager;
}

async function makeService() {
  const sessions = stubSessionManager();
  const service = new WorkspaceService(sessions, { restoreInputDelayMs: 0 });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-awaiting-input-'));
  (service as any).dataFilePath = path.join(dir, 'workspaces.json');
  (service as any).state = {
    workspaces: [{ id: 'w1', name: 'W1', sortOrder: 0, viewMode: 'tab', activeTabId: 't1', colorCounter: 1, createdAt: 'x', updatedAt: 'x' }],
    tabs: [{ id: 't1', workspaceId: 'w1', sessionId: 'pty-1', name: 'claude', sortOrder: 0, colorIndex: 0, shellType: 'bash', createdAt: 'x' }],
    gridLayouts: [],
  };
  const events: Array<{ id: string; changes: Record<string, unknown> }> = [];
  service.onTabUpdated((event) => { events.push({ id: event.tab.id, changes: event.changes as Record<string, unknown> }); });
  return { service, sessions, events, file: (service as any).dataFilePath as string };
}

test('FR-AITUI-024 AC-4: the session manager\'s mark becomes a tab:updated change on that tab', async () => {
  const { service, sessions, events } = await makeService();
  assert.equal(typeof sessions.awaitingInputCallback, 'function', 'the service listens for the mark');
  sessions.awaitingInputCallback('pty-1', true);
  assert.deepEqual(events, [{ id: 't1', changes: { awaitingInput: true } }]);
  assert.equal(service.getState().tabs[0].awaitingInput, true, 'a client that loads the state now sees it too');
  sessions.awaitingInputCallback('pty-1', false);
  assert.deepEqual(events.at(-1), { id: 't1', changes: { awaitingInput: false } });
  assert.notEqual(service.getState().tabs[0].awaitingInput, true);
});

test('FR-AITUI-024 AC-4: a mark for a session without a tab is ignored', async () => {
  const { sessions, events } = await makeService();
  sessions.awaitingInputCallback('pty-unknown', true);
  assert.deepEqual(events, []);
});

test('FR-AITUI-024 AC-4: the mark is never written to the workspace file', async () => {
  const { service, sessions, file } = await makeService();
  sessions.awaitingInputCallback('pty-1', true);
  await service.save(true);
  const written = readFileSync(file, 'utf8');
  assert.doesNotMatch(written, /awaitingInput/);
  assert.equal(service.getState().tabs[0].awaitingInput, true, 'still in memory');
});

test('FR-AITUI-024 AC-4: a session manager without the hook (an older stub) still constructs', () => {
  const sessions = stubSessionManager();
  delete sessions.onAwaitingInputChange;
  assert.doesNotThrow(() => new WorkspaceService(sessions, { restoreInputDelayMs: 0 }));
});
