import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { guardPtyConsoleKill } from './ptyConsoleKillGuard.js';

/**
 * REL-BGSTAB-022 AC-4 — node-pty's ConPTY kill() must not take the server.
 *
 * node-pty 1.1.0 kills a ConPTY session by forking an agent that attaches to
 * the console of the shell PID and returns every process on it, then calls
 * process.kill on each one from the server. Our verified tree kill has usually
 * killed the shell already, so that PID can belong to a PowerShell helper the
 * server has just started, whose console is the server's own: the list then
 * holds the server, and the server kills itself. Seen 2026-09-26 as 2222
 * vanishing without a log line during workspace deletes.
 */

function fakePty(list: number[]) {
  return {
    _agent: {
      _innerPid: 4321,
      _getConsoleProcessList(this: { _innerPid: number }) {
        return Promise.resolve([this._innerPid, ...list]);
      },
    },
  };
}

test('REL-BGSTAB-022 AC-4: the server and its parent are dropped from the console kill list', async () => {
  const pty = fakePty([process.pid, 777, process.ppid]);
  const dropped: number[][] = [];
  assert.equal(guardPtyConsoleKill(pty, [process.pid, process.ppid], pids => dropped.push(pids)), true);
  const list = await pty._agent._getConsoleProcessList();
  assert.deepEqual(list, [4321, 777], 'only the shell and the other process remain, in order');
  assert.deepEqual(dropped, [[process.pid, process.ppid]]);
});

test('REL-BGSTAB-022 AC-4: a list without the server passes through unchanged and logs nothing', async () => {
  const pty = fakePty([777]);
  let calls = 0;
  guardPtyConsoleKill(pty, [process.pid], () => { calls += 1; });
  assert.deepEqual(await pty._agent._getConsoleProcessList(), [4321, 777]);
  assert.equal(calls, 0);
});

test('REL-BGSTAB-022 AC-4: a PTY without the ConPTY agent is left alone', () => {
  assert.equal(guardPtyConsoleKill({}, [process.pid]), false);
  assert.equal(guardPtyConsoleKill(null, [process.pid]), false);
  assert.equal(guardPtyConsoleKill({ _agent: {} }, [process.pid]), false);
});

test('REL-BGSTAB-022 AC-4: every PTY the session manager spawns is guarded', () => {
  const source = readFileSync(new URL('../services/SessionManager.ts', import.meta.url), 'utf8');
  const spawnAt = source.indexOf('const ptyProcess = this.spawnPty(');
  assert.notEqual(spawnAt, -1);
  const guardAt = source.indexOf('guardPtyConsoleKill(ptyProcess', spawnAt);
  assert.ok(guardAt > spawnAt && guardAt - spawnAt < 1200, 'the guard is applied right after the spawn');
  assert.match(source.slice(guardAt, guardAt + 200), /process\.pid/);
});
