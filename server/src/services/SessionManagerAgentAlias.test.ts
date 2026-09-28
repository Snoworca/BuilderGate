import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { SessionManager } from './SessionManager.js';

// FR-AITUI-011 AC-3/AC-4 — a registered alias (claudep) is the agent itself, and the launch
// line is kept for the resume command.

function createHarness() {
  let onData: ((data: string) => void) | null = null;
  const manager = new SessionManager({
    pty: { termName: 'xterm-256color', defaultCols: 80, defaultRows: 24, useConpty: true, scrollbackLines: 1000, maxSnapshotBytes: 16, shell: 'bash' },
    session: { idleDelayMs: 40, runningDelayMs: 30 },
  } as any, {
    platform: 'linux',
    spawnPty: ((spawnShell: string, _args: string[], options: { cols?: number; rows?: number }) => ({
      pid: 1, cols: options.cols ?? 80, rows: options.rows ?? 24, process: spawnShell, handleFlowControl: false,
      onData(callback: (data: string) => void) { onData = callback; return { dispose() {} }; },
      onExit() { return { dispose() {} }; },
      write() {}, resize() {}, kill() {},
    })) as any,
  } as any);
  (manager as any).isCommandAvailable = (cmd: string) => cmd === 'bash' || cmd === 'sh';
  const session = manager.createSession('alias', 'bash', process.cwd());
  return {
    manager,
    id: session.id,
    emit(chunk: string) { onData?.(chunk); },
    runtime: () => manager.getAgentRuntimeInfo(session.id),
    cleanup: () => manager.deleteSession(session.id),
  };
}

async function launch(h: ReturnType<typeof createHarness>, line: string) {
  h.manager.writeInput(h.id, `${line}\r`);
  h.emit('⏺ Task(Research the codebase)\r\n  ⎿  Read(src/index.ts)\r\n');
  for (let waited = 0; waited < 300 && h.runtime()?.foregroundAppId == null; waited += 5) await delay(5);
}

test('FR-AITUI-011 AC-3: a typed alias is detected as its agent and the launch line is kept', async () => {
  const h = createHarness();
  try {
    h.manager.setAgentAliasResolver((exe) => (exe === 'claudep' ? 'claude' : exe === 'codexp' ? 'codex' : null));
    await launch(h, 'claudep --model opus');
    assert.equal(h.runtime()?.foregroundAppId, 'claude');
    assert.equal(h.runtime()?.launchCommand, 'claudep --model opus');
    // A prompt typed inside the agent does not replace the launch line (AC-4).
    h.manager.writeInput(h.id, 'hello there\r');
    assert.equal(h.runtime()?.launchCommand, 'claudep --model opus');
  } finally {
    h.cleanup();
  }
});

test('FR-AITUI-011 AC-3 boundary: without the alias registered, claudep is not an agent', async () => {
  const h = createHarness();
  try {
    await launch(h, 'claudep --model opus');
    assert.equal(h.runtime()?.foregroundAppId, null);
    assert.equal(h.runtime()?.launchCommand, null);
  } finally {
    h.cleanup();
  }
});

test('FR-AITUI-011 AC-3/AC-4: codex resume <id> is detected, and its launch line is kept', async () => {
  const h = createHarness();
  try {
    h.manager.setAgentAliasResolver((exe) => (exe === 'codexp' ? 'codex' : null));
    for (const line of ['codex resume 01a0e618-5e46-7880-8896-159d8350b34d', 'codexp resume 01a0e618-5e46-7880-8896-159d8350b34d']) {
      const run = createHarness();
      try {
        run.manager.setAgentAliasResolver((exe) => (exe === 'codexp' ? 'codex' : null));
        await launch(run, line);
        assert.equal(run.runtime()?.foregroundAppId, 'codex', line);
        assert.equal(run.runtime()?.launchCommand, line);
      } finally {
        run.cleanup();
      }
    }
  } finally {
    h.cleanup();
  }
});
