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
