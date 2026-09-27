import assert from 'node:assert/strict';
import test from 'node:test';

import { SessionManager } from './SessionManager.js';

/**
 * REL-BGSTAB-033 — ConPTY sessions use node-pty's bundled conpty.dll.
 *
 * The inbox ConPTY held Codex's in-place timer redraws (wrapped in DEC 2026
 * synchronized output) until the next input event: measured on the 0.10.1 exe,
 * the digits reached the browser at 6.4s/7.3s/11.4s/14.1s instead of every
 * second, while a plain `\r` loop updated on time. The bundled OpenConsole
 * passes those redraws through.
 */

interface SpawnCall {
  useConpty?: boolean;
  useConptyDll?: boolean;
}

function fakePty() {
  return { pid: 4242, onData: () => {}, onExit: () => {}, write: () => {}, resize: () => {}, kill: () => {} };
}

function setup(opts: { useConpty: boolean; useConptyDll?: boolean; failDll?: boolean }) {
  const calls: SpawnCall[] = [];
  const manager = new SessionManager({
    pty: {
      termName: 'xterm-256color',
      defaultCols: 80,
      defaultRows: 24,
      useConpty: opts.useConpty,
      ...(opts.useConptyDll === undefined ? {} : { useConptyDll: opts.useConptyDll }),
      scrollbackLines: 100,
      maxSnapshotBytes: 1024,
      shell: 'bash',
    },
    session: { idleDelayMs: 200 },
  } as never, {
    platform: 'win32',
    isCommandAvailableFn: () => true,
    spawnPty: ((_f: string, _a: string[], o: SpawnCall) => {
      calls.push({ useConpty: o.useConpty, useConptyDll: o.useConptyDll });
      if (opts.failDll && o.useConptyDll) throw new Error('Cannot find conpty.dll at X');
      return fakePty();
    }) as never,
  });
  return { manager, calls };
}

function run(opts: Parameters<typeof setup>[0]): SpawnCall[] {
  const { manager, calls } = setup(opts);
  const id = manager.createSession('conpty-dll', 'bash').id;
  try {
    return calls.filter((c) => c.useConpty !== undefined);
  } finally {
    manager.deleteSession(id, 'direct-session-delete');
    manager.stopAllCwdWatching();
  }
}

test('REL-BGSTAB-033 AC-1 a ConPTY session is spawned with the bundled conpty.dll by default', () => {
  const calls = run({ useConpty: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].useConptyDll, true);
});

test('REL-BGSTAB-033 AC-2 pty.useConptyDll=false keeps the inbox ConPTY', () => {
  const calls = run({ useConpty: true, useConptyDll: false });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].useConptyDll ?? false, false);
});

test('REL-BGSTAB-033 AC-3 when the bundled dll fails to load the session falls back to the inbox ConPTY', () => {
  const calls = run({ useConpty: true, failDll: true });
  assert.deepEqual(calls.map((c) => c.useConptyDll ?? false), [true, false]);
});
