import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { resolveAgentSession, type AgentRoots } from './agentSessionResolver.js';
import { wslAgentRoots } from './agentRoots.js';

// FR-AITUI-020: a Windows server reads a WSL tab's agents through the
// \\wsl.localhost share, where Windows cannot see Linux processes or locks. A temp
// tree stands in for the distro root: proc/<pid> for a live process, proc/locks
// for the held locks, as \\wsl.localhost\<distro>\proc shows them.

const CWD = '/home/dev/proj';
const CLAUDE_ID = '9b3df38c-bafa-467c-908e-f6435d599f35';
const CODEX_LIVE = '01a0e3c9-5b21-7d40-9f1e-3a6b8c2d4e10';
const CODEX_CLOSED = '01a0e4f2-7d13-7a9b-8c02-5e4f6a1b3c27';

function makeDistro(): { roots: AgentRoots; dir: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bg-wsl-distro-'));
  const home = path.join(dir, 'home', 'dev');
  mkdirSync(path.join(dir, 'proc'), { recursive: true });
  writeFileSync(path.join(dir, 'proc', 'locks'), '');
  return { roots: { ...wslAgentRoots(home, {}), wslRoot: dir }, dir };
}

function writeClaude(roots: AgentRoots, pid: number, sessionId: string) {
  mkdirSync(path.join(roots.claudeHome, 'sessions'), { recursive: true });
  writeFileSync(path.join(roots.claudeHome, 'sessions', `${pid}.json`), JSON.stringify({ pid, sessionId, cwd: CWD, startedAt: 1_000_000 }));
}

function writeCodex(roots: AgentRoots, dir: string, id: string, held: boolean) {
  const day = path.join(roots.codexHome, 'sessions', '2026', '10', '27');
  mkdirSync(day, { recursive: true });
  writeFileSync(path.join(day, `rollout-2026-10-27T00-00-00-${id}.jsonl`), `${JSON.stringify({
    timestamp: '2026-10-27T00:00:00.000Z', type: 'session_meta', payload: { id, timestamp: '2026-10-27T00:00:00.000Z', cwd: CWD, source: 'cli' },
  })}\n`);
  const lockDir = path.join(roots.codexHome, 'thread-writer-locks');
  mkdirSync(lockDir, { recursive: true });
  const lock = path.join(lockDir, `${id}.lock`);
  writeFileSync(lock, '');
  if (held) {
    const ino = statSync(lock, { bigint: true }).ino;
    writeFileSync(path.join(dir, 'proc', 'locks'), `1: FLOCK  ADVISORY  WRITE 76843 08:20:${ino} 0 EOF\n`, { flag: 'a' });
  }
}

// @req FR-AITUI-020
test('FR-AITUI-020 AC-1: WSL roots carry the distro root', () => {
  const roots = wslAgentRoots('\\\\wsl.localhost\\Ubuntu\\home\\dev', {});
  assert.equal(roots.wslRoot, '\\\\wsl.localhost\\Ubuntu');
});

// @req FR-AITUI-020
test('FR-AITUI-020 AC-1: a Claude record is live when proc/<pid> exists in the distro', async () => {
  const { roots, dir } = makeDistro();
  try {
    writeClaude(roots, 4242, CLAUDE_ID);
    writeClaude(roots, 4343, 'aaaaaaaa-bafa-467c-908e-f6435d599f35');
    liveProcess(dir, 4242, 'claude\0--dangerously-skip-permissions\0');
    const result = await resolveAgentSession({ tabId: 't', cwd: CWD, agent: 'claude' }, { roots });
    assert.equal(result?.sessionId, CLAUDE_ID);
    assert.equal(result?.confidence, 'exact', 'the dead 4343 record is not a rival');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function liveProcess(dir: string, pid: number, cmdline: string) {
  mkdirSync(path.join(dir, 'proc', String(pid)), { recursive: true });
  writeFileSync(path.join(dir, 'proc', String(pid), 'cmdline'), cmdline);
}

// @req FR-AITUI-020
test('FR-AITUI-020 AC-1: a pid reused by another program after a WSL restart is not the session', async () => {
  const { roots, dir } = makeDistro();
  try {
    writeClaude(roots, 4242, CLAUDE_ID);
    liveProcess(dir, 4242, '/bin/bash\0');
    assert.equal(await resolveAgentSession({ tabId: 't', cwd: CWD, agent: 'claude' }, { roots }), null);
    liveProcess(dir, 4242, 'node\0/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js\0');
    assert.equal((await resolveAgentSession({ tabId: 't', cwd: CWD, agent: 'claude' }, { roots }))?.sessionId, CLAUDE_ID, 'an npm install runs under node');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// @req FR-AITUI-020
test('FR-AITUI-020 AC-2: a Codex thread is open when its lock inode is in proc/locks', async () => {
  const { roots, dir } = makeDistro();
  try {
    writeCodex(roots, dir, CODEX_LIVE, true);
    writeCodex(roots, dir, CODEX_CLOSED, false);
    const result = await resolveAgentSession({ tabId: 't', cwd: CWD, agent: 'codex' }, { roots });
    assert.equal(result?.sessionId, CODEX_LIVE);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// @req FR-AITUI-020
test('FR-AITUI-020 AC-2: no held lock means no open thread', async () => {
  const { roots, dir } = makeDistro();
  try {
    writeCodex(roots, dir, CODEX_CLOSED, false);
    const result = await resolveAgentSession({ tabId: 't', cwd: CWD, agent: 'codex' }, { roots });
    assert.equal(result, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
