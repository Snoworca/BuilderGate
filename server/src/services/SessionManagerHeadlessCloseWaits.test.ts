import assert from 'node:assert/strict';
import test from 'node:test';

import { SessionManager } from './SessionManager.js';

// REL-BGSTAB-061 (#208): every headless write raced the session's long-lived close promise, which
// kept one reaction per output chunk until the session closed. Production grew to 3.56 GB and died.

function createHarness(writeHeadlessTerminalFn?: (...args: any[]) => Promise<void>) {
  let onData: ((data: string) => void) | null = null;
  const manager = new SessionManager({
    pty: { termName: 'xterm-256color', defaultCols: 80, defaultRows: 24, useConpty: true, scrollbackLines: 1000, maxSnapshotBytes: 16, shell: 'bash' },
    session: { idleDelayMs: 40, runningDelayMs: 30 },
  } as any, {
    platform: 'linux',
    ...(writeHeadlessTerminalFn ? { writeHeadlessTerminalFn } : {}),
    spawnPty: ((spawnShell: string, _args: string[], options: { cols?: number; rows?: number }) => ({
      pid: 1,
      cols: options.cols ?? 80,
      rows: options.rows ?? 24,
      process: spawnShell,
      handleFlowControl: false,
      onData(callback: (data: string) => void) { onData = callback; return { dispose() {} }; },
      onExit() { return { dispose() {} }; },
      write() {},
      resize() {},
      kill() {},
    })) as any,
  } as any);
  (manager as any).isCommandAvailable = (cmd: string) => cmd === 'bash' || cmd === 'sh';
  const session = manager.createSession('leak', 'bash', process.cwd());
  const data = (manager as any).sessions.get(session.id);
  return {
    manager,
    id: session.id,
    data,
    emit(chunk: string) {
      if (!onData) throw new Error('PTY onData was not registered');
      onData(chunk);
    },
  };
}

/** Counts reactions attached to whatever long-lived promise the close signal exposes. */
function countReactions(signal: Record<string, unknown>): () => number {
  let reactions = 0;
  const promise = signal.promise as Promise<unknown> | undefined;
  if (promise) {
    const original = promise.then.bind(promise);
    (promise as any).then = (...args: any[]) => { reactions += 1; return original(...args); };
  }
  return () => reactions;
}

test('REL-BGSTAB-061 AC-1: 1,000 output chunks leave nothing waiting on the session close signal', async () => {
  const harness = createHarness();
  try {
    const reactions = countReactions(harness.data.headlessCloseSignal);
    for (let i = 0; i < 1000; i += 1) {
      harness.emit(`line ${i}\r\n`);
      if (i % 100 === 99) await harness.manager.waitForTerminalResourcePolicyHeadlessDrain(harness.id);
    }
    await harness.manager.waitForTerminalResourcePolicyHeadlessDrain(harness.id);
    assert.equal(reactions(), 0, 'no reaction is attached to a promise that lives as long as the session');
    assert.equal(harness.data.headlessCloseSignal.pendingWaits(), 0);
  } finally {
    harness.manager.deleteSession(harness.id);
  }
});

test('REL-BGSTAB-061 AC-2: a headless write that never settles is released when the session closes', async () => {
  let started = 0;
  const harness = createHarness(() => { started += 1; return new Promise<void>(() => {}); });
  harness.emit('stuck\r\n');
  for (let i = 0; i < 200 && started === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(started, 1, 'the write started');
  assert.equal(harness.data.headlessCloseSignal.pendingWaits(), 1);
  harness.manager.deleteSession(harness.id);
  for (let i = 0; i < 200 && harness.data.headlessCloseSignal.pendingWaits() > 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(harness.data.headlessCloseSignal.pendingWaits(), 0);
});
