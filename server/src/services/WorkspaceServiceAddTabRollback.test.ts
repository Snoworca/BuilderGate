/**
 * REL-BGSTAB-021 — addTab rolls back the session and the tab when the store
 * write is rejected.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceService } from './WorkspaceService.js';

interface StubSessionManager {
  live: Set<string>;
  terminated: Array<{ id: string; reason: string }>;
  failTermination: boolean;
  lastCreatedId: string | null;
  emitTitle(sessionId: string, title: string): void;
}

function stubSessionManager(): any {
  let seq = 0;
  const manager: any = {
    live: new Set<string>(),
    terminated: [] as Array<{ id: string; reason: string }>,
    failTermination: false,
    lastCreatedId: null as string | null,
    onCwdChange() {},
    onTerminalTitleChange(cb: (sessionId: string, title: string) => void) {
      manager.emitTitle = cb;
    },
    emitTitle(_sessionId: string, _title: string) {
      throw new Error('the service never registered a terminal-title listener');
    },
    onSessionFinalized() {},
    hasSession(id: string) { return manager.live.has(id); },
    createSession() {
      const id = `pty-${++seq}`;
      manager.live.add(id);
      manager.lastCreatedId = id;
      return { id };
    },
    async terminateSession(id: string, options: { reason: string }) {
      if (manager.failTermination) {
        throw new Error('terminate failed');
      }
      manager.live.delete(id);
      manager.terminated.push({ id, reason: options.reason });
    },
  };
  return manager;
}

/**
 * `writable` decides whether the store write succeeds: the unwritable variant
 * points the store at a directory that was never created, which is the same
 * injection WorkspaceServiceFlushConcurrency.test.ts uses for a real I/O
 * failure.
 */
async function makeService(writable: boolean, existingTabs = 0): Promise<{
  service: WorkspaceService;
  sessions: StubSessionManager;
}> {
  const sessions = stubSessionManager();
  const service = new WorkspaceService(sessions, {});
  const dir = writable
    ? await fs.mkdtemp(path.join(os.tmpdir(), 'ws-addtab-'))
    : path.join(os.tmpdir(), `ws-addtab-absent-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  (service as any).dataFilePath = path.join(dir, 'workspaces.json');

  // Neighbours the call under test never touches. Without them a rollback that
  // clears every tab, or terminates every session, is indistinguishable from
  // one that undoes only its own work.
  const tabs = Array.from({ length: existingTabs }, (_, i) => {
    const sessionId = sessions.createSession().id;
    return {
      id: `existing-${i}`, workspaceId: 'w1', sessionId, currentSessionId: sessionId,
      name: `Existing-${i}`, sortOrder: i, colorIndex: i, shellType: 'auto',
    };
  });
  (service as any).state = {
    workspaces: [{
      id: 'w1', name: 'W1', sortOrder: 0, viewMode: 'tab',
      activeTabId: existingTabs > 0 ? `existing-${existingTabs - 1}` : null, colorCounter: 3,
      createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-02T00:00:00.000Z',
    }],
    tabs,
    gridLayouts: [],
  };

  // The private overrides above must be in effect, or every assertion is vacuous.
  assert.equal(service.getDataFilePath(), path.join(dir, 'workspaces.json'));
  assert.equal((service as any).state.tabs.length, existingTabs);
  assert.equal(sessions.live.size, existingTabs);
  assert.equal(typeof (service as any).sessionManager.createSession, 'function');
  assert.equal(typeof (service as any).sessionManager.terminateSession, 'function');

  return { service, sessions };
}

// AC-1
test('a rejected store write leaves no session behind', async () => {
  const { service, sessions } = await makeService(false);

  await assert.rejects(() => service.addTab('w1'), /ENOENT/);

  assert.deepEqual(
    [...sessions.live],
    [],
    'the PTY created by the failed addTab is still running',
  );
  assert.equal(
    sessions.terminated.length,
    1,
    'the failed addTab must terminate exactly the session it created',
  );
});

// AC-2
test('a rejected store write leaves no tab in memory', async () => {
  const { service, sessions } = await makeService(false);

  await assert.rejects(() => service.addTab('w1'), /ENOENT/);

  assert.deepEqual(
    (service as any).state.tabs,
    [],
    'the tab from the failed addTab is still in the in-memory state',
  );
  assert.equal(
    (service as any).state.workspaces[0].activeTabId,
    null,
    'activeTabId still points at a tab that no longer exists',
  );
  // Without this the case would also pass on a failure raised before the tab
  // was ever created, because the starting state already matches.
  assert.equal(
    sessions.terminated.length,
    1,
    'the case must observe a rollback, not a failure that came before the tab existed',
  );
});

// AC-3 — boundary control: a rollback that also swallowed the error would pass AC-1 and AC-2.
test('the store failure still reaches the caller', async () => {
  const { service } = await makeService(false);

  await assert.rejects(
    () => service.addTab('w1'),
    (error: NodeJS.ErrnoException) => {
      assert.equal(error.code, 'ENOENT', 'the original I/O failure must reach the caller unchanged');
      return true;
    },
  );
});

// AC-3 — the cleanup path must not replace the failure the caller needs to see.
test('a cleanup failure does not mask the store failure', async () => {
  const { service, sessions } = await makeService(false);
  sessions.failTermination = true;

  await assert.rejects(
    () => service.addTab('w1'),
    (error: NodeJS.ErrnoException) => {
      assert.equal(error.code, 'ENOENT', 'the terminate failure replaced the store failure');
      return true;
    },
  );
  assert.deepEqual((service as any).state.tabs, [], 'the tab must be dropped even when cleanup fails');
});

// AC-1 / AC-2 — the rollback must be exactly as wide as the call was. Without a
// neighbouring tab and session to observe, clearing the whole workspace passes.
test('a rejected store write leaves the other tabs and sessions alone', async () => {
  // Two neighbours, with the second one active: an active tab that is not
  // tabs[0] is what makes an unconditional re-pick observable.
  const { service, sessions } = await makeService(false, 2);
  const existingSessionIds = (service as any).state.tabs.map((tab: { sessionId: string }) => tab.sessionId);

  await assert.rejects(() => service.addTab('w1'), /ENOENT/);

  assert.deepEqual(
    (service as any).state.tabs.map((tab: { id: string }) => tab.id),
    ['existing-0', 'existing-1'],
    'the rollback removed a tab the failed call did not create',
  );
  assert.deepEqual(
    [...sessions.live],
    existingSessionIds,
    'the rollback terminated a session the failed call did not create',
  );
  assert.equal(
    sessions.terminated.length,
    1,
    'exactly one session — the one the failed addTab created — may be terminated',
  );
  assert.equal(
    (service as any).state.workspaces[0].activeTabId,
    'existing-1',
    'activeTabId must be left alone when the failed call never became the active tab',
  );
});

// AC-4 — restoring a snapshot taken before the await would erase whatever a
// concurrent add did during it. Only the first call's write is rejected here.
test('a rejected add does not undo a concurrent add', async () => {
  const { service } = await makeService(true);
  const write = (service as any).writeStateToDisk.bind(service);
  let writes = 0;
  (service as any).writeStateToDisk = async function injectFirstFailure() {
    writes += 1;
    if (writes === 1) {
      const injected: NodeJS.ErrnoException = new Error('ENOENT: injected store failure');
      injected.code = 'ENOENT';
      throw injected;
    }
    return write();
  };

  const [first, second] = await Promise.allSettled([
    service.addTab('w1'),
    service.addTab('w1'),
  ]);

  assert.equal(first.status, 'rejected', 'the injected failure must reject the first add');
  assert.equal(second.status, 'fulfilled', 'the second add must still succeed');
  const survivor = (second as PromiseFulfilledResult<{ id: string }>).value;

  assert.deepEqual(
    (service as any).state.tabs.map((tab: { id: string }) => tab.id),
    [survivor.id],
    'the rollback removed the tab the concurrent add created',
  );
  assert.equal(
    (service as any).state.workspaces[0].activeTabId,
    survivor.id,
    'the rollback undid the activation the concurrent add performed',
  );
});

// A pending title outlives the session it was armed for, and a later tab that
// reuses the session id — which the MCP path lets a caller ask for — inherits it.
test('a rejected store write leaves no pending title for the dropped session', async () => {
  const { service, sessions } = await makeService(false);
  const write = (service as any).writeStateToDisk.bind(service);
  (service as any).writeStateToDisk = async function emitTitleThenWrite() {
    // The shell emits its title while the store write is in flight. The tab is
    // already in state by then, so the title is accepted and a timer is armed.
    sessions.emitTitle(sessions.lastCreatedId as string, 'inherited-title');
    return write();
  };

  await assert.rejects(() => service.addTab('w1'), /ENOENT/);

  assert.equal(
    (service as any).pendingTerminalTitles.has(sessions.lastCreatedId),
    false,
    'a pending title survived the rollback and can rename a later tab that reuses the session id',
  );
});

// Boundary control: the rollback must not fire when the write succeeds.
test('a successful add keeps its session and its tab', async () => {
  const { service, sessions } = await makeService(true);

  const tab = await service.addTab('w1');

  assert.equal(sessions.live.size, 1, 'a successful add must leave its PTY running');
  assert.deepEqual(sessions.terminated, [], 'a successful add must not terminate anything');
  assert.equal((service as any).state.tabs.length, 1);
  assert.equal((service as any).state.workspaces[0].activeTabId, tab.id);
});
