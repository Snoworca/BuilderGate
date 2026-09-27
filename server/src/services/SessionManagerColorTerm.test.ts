import assert from 'node:assert/strict';
import test from 'node:test';

import { SessionManager } from './SessionManager.js';

/**
 * REL-BGSTAB-034 — sessions advertise 24-bit colour.
 *
 * xterm.js renders truecolor, but the PTY environment never said so. Codex decides RGB vs a
 * dim/bold approximation from `COLORTERM` (Windows Terminal is recognised by `WT_SESSION`), so
 * its shimmer and palette came out coarse in BuilderGate and fine in native terminals.
 */

function spawnEnv(extra: Record<string, string | undefined>, platform: NodeJS.Platform = 'win32'): Record<string, string> {
  const saved = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(extra)) {
    saved.set(k, process.env[k]);
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  let env: Record<string, string> | null = null;
  const manager = new SessionManager({
    pty: { termName: 'xterm-256color', defaultCols: 80, defaultRows: 24, useConpty: platform === 'win32', scrollbackLines: 100, maxSnapshotBytes: 1024, shell: 'bash' },
    session: { idleDelayMs: 200 },
  } as never, {
    platform,
    isCommandAvailableFn: () => true,
    spawnPty: ((_f: string, _a: string[], o: { env: Record<string, string> }) => {
      env = o.env;
      return { pid: 4242, onData: () => {}, onExit: () => {}, write: () => {}, resize: () => {}, kill: () => {} };
    }) as never,
  });
  const id = manager.createSession('colorterm', 'bash').id;
  try {
    assert.ok(env, 'pty was not spawned');
    return env;
  } finally {
    manager.deleteSession(id, 'direct-session-delete');
    manager.stopAllCwdWatching();
    for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

test('REL-BGSTAB-034 AC-1 a session gets COLORTERM=truecolor', () => {
  assert.equal(spawnEnv({ COLORTERM: undefined }).COLORTERM, 'truecolor');
});

test('REL-BGSTAB-034 AC-2 an inherited COLORTERM is kept', () => {
  assert.equal(spawnEnv({ COLORTERM: '24bit' }).COLORTERM, '24bit');
});

test('REL-BGSTAB-034 AC-3 on Windows COLORTERM is forwarded into WSL without dropping WSLENV entries', () => {
  const env = spawnEnv({ COLORTERM: undefined, WSLENV: 'FOO/u' });
  assert.deepEqual(env.WSLENV.split(':').sort(), ['COLORTERM', 'FOO/u']);
});

for (const platform of ['linux', 'darwin'] as const) {
  test(`REL-BGSTAB-034 AC-4 ${platform} sessions also get COLORTERM=truecolor and no WSLENV is invented`, () => {
    const env = spawnEnv({ COLORTERM: undefined, WSLENV: undefined }, platform);
    assert.equal(env.COLORTERM, 'truecolor');
    assert.equal(env.WSLENV, undefined);
  });
}
