import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import type { Session } from '../types/index.js';
import { SessionManager } from './SessionManager.js';

test('SessionManager.updateRuntimeConfig affects later idle timers and cached snapshots', async (t) => {
  const manager = new SessionManager({
    pty: {
      termName: 'xterm-256color',
      defaultCols: 80,
      defaultRows: 24,
      useConpty: true,
      scrollbackLines: 1000,
      maxSnapshotBytes: 16,
      shell: 'auto',
    },
    session: {
      idleDelayMs: 200,
    },
  });

  const fakeSession: Session = {
    id: 'session-1',
    name: 'Session 1',
    status: 'running',
    createdAt: new Date(),
    lastActiveAt: new Date(),
    sortOrder: 0,
  };

  const sessionData = {
    session: fakeSession,
    pty: {} as never,
    idleTimer: null as NodeJS.Timeout | null,
    headless: null,
    headlessHealth: 'degraded',
    headlessWriteChain: Promise.resolve(),
    headlessCloseSignal: { promise: new Promise<void>(() => {}), resolve: () => {} },
    pendingHeadlessWrites: 0,
    cols: 80,
    rows: 24,
    screenSeq: 1,
    snapshotCache: {
      seq: 1,
      cols: 80,
      rows: 24,
      data: 'cached',
      truncated: false,
      generatedAt: Date.now(),
      dirty: false,
    },
    degradedReplayBuffer: '',
    degradedReplayTruncated: false,
    pendingOutputChunks: [],
    unsnapshottedOutput: '',
    unsnapshottedOutputTruncated: false,
    initialCwd: process.cwd(),
  };

  (manager as any).sessions.set(fakeSession.id, sessionData);
  t.after(() => {
    if (sessionData.idleTimer) {
      clearTimeout(sessionData.idleTimer);
    }
  });

  manager.updateRuntimeConfig({
    idleDelayMs: 20,
    pty: {
      defaultCols: 120,
      maxSnapshotBytes: 4,
      shell: 'bash',
    },
  });

  assert.equal((manager as any).runtimePtyConfig.defaultCols, 120);
  assert.equal((manager as any).runtimePtyConfig.shell, 'bash');
  assert.equal((manager as any).runtimeSessionConfig.idleDelayMs, 20);
  assert.equal(sessionData.snapshotCache, null);

  (manager as any).scheduleIdleTransition(fakeSession.id);
  await delay(40);

  assert.equal(fakeSession.status, 'idle');
});

// #112: writeInput()'s three `return false` points used to be indistinguishable to every
// caller. A live 15,000-line flood measurement could tell the write did not reach the PTY,
// but not whether the session had died or the client's mutation identity had gone stale --
// two facts that call for opposite fixes. writeInputDetailed() names which one happened;
// writeInput() must keep returning a plain boolean for its ~50 existing callers.
test('SessionManager.writeInputDetailed reports session-gone for an id no session holds', () => {
  const manager = new SessionManager({
    pty: {
      termName: 'xterm-256color',
      defaultCols: 80,
      defaultRows: 24,
      useConpty: true,
      scrollbackLines: 1000,
      maxSnapshotBytes: 16,
      shell: 'auto',
    },
    session: { idleDelayMs: 200 },
  });

  const result = manager.writeInputDetailed('no-such-session', 'x');

  assert.equal(result.ok, false);
  assert.equal(result.denialReason, 'session-gone');
  // The boolean wrapper must still agree with the detailed result.
  assert.equal(manager.writeInput('no-such-session', 'x'), false);
});

test('SessionManager.writeInputDetailed reports mutation-identity-stale distinctly from session-gone', () => {
  const manager = new SessionManager({
    pty: {
      termName: 'xterm-256color',
      defaultCols: 80,
      defaultRows: 24,
      useConpty: true,
      scrollbackLines: 1000,
      maxSnapshotBytes: 16,
      shell: 'auto',
    },
    session: { idleDelayMs: 200 },
  });

  const fakeSession: Session = {
    id: 'shadow-session',
    name: 'Shadow Session',
    status: 'running',
    createdAt: new Date(),
    lastActiveAt: new Date(),
    sortOrder: 0,
  };
  const sessionData = {
    session: fakeSession,
    pty: { write: () => { throw new Error('must not be reached -- identity check must reject first'); } } as never,
    idleTimer: null as NodeJS.Timeout | null,
  };
  (manager as any).sessions.set(fakeSession.id, sessionData);

  // Put the retained-terminal state into shadow mode with server admission open, then call
  // writeInputDetailed() with NO retainedIdentity -- acceptRetainedTerminalMutationIdentity()
  // treats a missing identity under server admission as a refusal (it must prove the exact
  // browser binding that was suspended at the positional handoff). This exercises the real
  // rejection branch rather than mocking it.
  const retained = (manager as any).ensureRetainedTerminalSessionState(sessionData);
  retained.mode = 'shadow';
  const runtime = (manager as any).ensureTerminalAuthorityRuntimePortState(retained);
  runtime.admission.mode = 'server';

  const result = manager.writeInputDetailed(fakeSession.id, 'x');

  assert.equal(result.ok, false);
  assert.equal(result.denialReason, 'mutation-identity-stale');
});
