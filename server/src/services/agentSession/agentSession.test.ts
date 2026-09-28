import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  descendantsOf,
  detectAgentFromProcesses,
  isValidAgentSessionId,
  normalizeCwdForCompare,
  resolveAgentSession,
  type AgentRoots,
  type ProcessInfo,
} from './agentSessionResolver.js';
import { buildResumeCommand } from './resumeCommand.js';
import { AgentOutputHintTracker } from './agentOutputHints.js';

// FR-AITUI-006 — resolving the running agent's session id without touching it.
// Every agent record lives in a temp tree built here, so the tests read the
// same shapes the real homes hold (measured 2026-09-26) without reading them.

function makeRoots(): { roots: AgentRoots; dir: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bg-agent-session-'));
  const roots: AgentRoots = {
    claudeHome: path.join(dir, 'claude'),
    codexHome: path.join(dir, 'codex'),
    opencodeData: path.join(dir, 'opencode'),
    hermesHome: path.join(dir, 'hermes'),
  };
  return { roots, dir };
}

const CWD = process.platform === 'win32' ? 'C:\\Work\\git\\og\\server-java' : '/work/git/og/server-java';
const OTHER = process.platform === 'win32' ? 'C:\\Work\\git\\og\\frontend' : '/work/git/og/frontend';

function writeClaudeSession(roots: AgentRoots, pid: number, sessionId: string, cwd: string, startedAt: number) {
  mkdirSync(path.join(roots.claudeHome, 'sessions'), { recursive: true });
  writeFileSync(path.join(roots.claudeHome, 'sessions', `${pid}.json`), JSON.stringify({
    pid, sessionId, cwd, startedAt, procStart: 'x', version: '2.1.281', kind: 'interactive', entrypoint: 'cli', status: 'idle',
  }));
}

const alive = () => true;

test('process tree: descendants and agent detection by executable name', () => {
  const procs: ProcessInfo[] = [
    { pid: 10, ppid: 1, name: 'node.exe' },
    { pid: 20, ppid: 10, name: 'powershell.exe' },
    { pid: 30, ppid: 20, name: 'cmd.exe' },
    { pid: 40, ppid: 30, name: 'claude.exe', createdAtMs: 5000 },
    { pid: 50, ppid: 99, name: 'codex.exe' },
  ];
  assert.deepEqual(descendantsOf(20, procs).map((p) => p.pid).sort(), [30, 40]);
  const found = detectAgentFromProcesses(descendantsOf(20, procs));
  assert.equal(found?.agent, 'claude');
  assert.equal(found?.process.pid, 40);
  assert.equal(detectAgentFromProcesses([{ pid: 1, ppid: 0, name: 'node.exe', commandLine: 'node C:\\x\\opencode\\bin\\opencode' }])?.agent, 'opencode');
  assert.equal(detectAgentFromProcesses([{ pid: 1, ppid: 0, name: 'bash' }]), null);
});

test('id formats are checked per agent', () => {
  assert.equal(isValidAgentSessionId('claude', '7c1e0b52-4a0e-4f7b-9d61-2b8e5f0c3a19'), true);
  assert.equal(isValidAgentSessionId('claude', 'my session'), true);
  assert.equal(isValidAgentSessionId('claude', '-rf'), false);
  assert.equal(isValidAgentSessionId('claude', 'a;rm -rf /'), false);
  assert.equal(isValidAgentSessionId('codex', '01a0e3c9-5b21-7d40-9f1e-3a6b8c2d4e10'), true);
  assert.equal(isValidAgentSessionId('codex', 'nope'), false);
  assert.equal(isValidAgentSessionId('hermes', '20260926_131205_a4f9c2'), true);
  assert.equal(isValidAgentSessionId('hermes', '2026_1'), false);
  assert.equal(isValidAgentSessionId('opencode', 'ses_2b4d91c0affe7Kq2xR8mNcPz3L'), true);
  assert.equal(isValidAgentSessionId('opencode', 'ses_short'), false);
});

test('cwd comparison ignores case on Windows, trailing separators and the \\\\?\\ prefix', () => {
  if (process.platform === 'win32') {
    assert.equal(normalizeCwdForCompare('\\\\?\\C:\\Work\\X\\'), normalizeCwdForCompare('c:/work/x'));
  } else {
    assert.equal(normalizeCwdForCompare('/work/x/'), normalizeCwdForCompare('/work/x'));
  }
});

test('AC-2 Claude: the pid file of the agent process in the PTY tree is exact', async () => {
  const { roots, dir } = makeRoots();
  try {
    writeClaudeSession(roots, 40, '7c1e0b52-4a0e-4f7b-9d61-2b8e5f0c3a19', CWD, 5000);
    writeClaudeSession(roots, 41, '11111111-2222-4333-8444-555555555555', CWD, 5100);
    const procs: ProcessInfo[] = [
      { pid: 20, ppid: 1, name: 'powershell.exe' },
      { pid: 40, ppid: 20, name: 'claude.exe', createdAtMs: 5000 },
    ];
    const result = await resolveAgentSession({ tabId: 't1', cwd: CWD, agent: null, ptyPid: 20 }, { roots, processes: procs, isPidAlive: alive });
    assert.deepEqual(result, { agent: 'claude', sessionId: '7c1e0b52-4a0e-4f7b-9d61-2b8e5f0c3a19', method: 'claude-pid-file', confidence: 'exact' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AC-2 Claude: without the tree, cwd plus launch time narrows to one, else nearest is estimated', async () => {
  const { roots, dir } = makeRoots();
  try {
    writeClaudeSession(roots, 40, '7c1e0b52-4a0e-4f7b-9d61-2b8e5f0c3a19', CWD, 10_000);
    writeClaudeSession(roots, 41, '11111111-2222-4333-8444-555555555555', OTHER, 10_050);
    const one = await resolveAgentSession({ tabId: 't1', cwd: CWD, agent: 'claude', agentStartedAtMs: 9_000 }, { roots, isPidAlive: alive });
    assert.equal(one?.sessionId, '7c1e0b52-4a0e-4f7b-9d61-2b8e5f0c3a19');
    assert.equal(one?.confidence, 'exact');

    writeClaudeSession(roots, 42, '22222222-2222-4333-8444-555555555555', CWD, 30_000);
    const two = await resolveAgentSession({ tabId: 't1', cwd: CWD, agent: 'claude', agentStartedAtMs: 29_500 }, { roots, isPidAlive: alive });
    assert.equal(two?.sessionId, '22222222-2222-4333-8444-555555555555');
    assert.equal(two?.confidence, 'estimated');

    const claimed = await resolveAgentSession(
      { tabId: 't1', cwd: CWD, agent: 'claude', agentStartedAtMs: 29_500 },
      { roots, isPidAlive: alive, claimedSessionIds: new Set(['22222222-2222-4333-8444-555555555555']) },
    );
    assert.equal(claimed?.sessionId, '7c1e0b52-4a0e-4f7b-9d61-2b8e5f0c3a19', 'an id another tab already took is not reused');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AC-2 Claude: dead pids are ignored', async () => {
  const { roots, dir } = makeRoots();
  try {
    writeClaudeSession(roots, 40, '7c1e0b52-4a0e-4f7b-9d61-2b8e5f0c3a19', CWD, 10_000);
    const result = await resolveAgentSession({ tabId: 't1', cwd: CWD, agent: 'claude' }, { roots, isPidAlive: () => false });
    assert.equal(result, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeCodexThread(roots: AgentRoots, id: string, cwd: string, createdMs: number, locked = true, extra: Record<string, unknown> = {}) {
  const day = path.join(roots.codexHome, 'sessions', '2026', '09', '26');
  mkdirSync(day, { recursive: true });
  const stamp = new Date(createdMs).toISOString().replace(/[:.]/g, '-').slice(0, 19);
  writeFileSync(path.join(day, `rollout-${stamp}-${id}.jsonl`), `${JSON.stringify({
    timestamp: new Date(createdMs).toISOString(), type: 'session_meta', payload: { id, timestamp: new Date(createdMs).toISOString(), cwd: process.platform === 'win32' ? `\\\\?\\${cwd}` : cwd, ...extra },
  })}\n{"type":"response_item"}\n`);
  if (locked) {
    mkdirSync(path.join(roots.codexHome, 'thread-writer-locks'), { recursive: true });
    writeFileSync(path.join(roots.codexHome, 'thread-writer-locks', `${id}.lock`), '');
  }
}

test('AC-3 Codex: the one live thread whose rollout cwd matches is exact', async () => {
  const { roots, dir } = makeRoots();
  try {
    writeCodexThread(roots, '01a0e3c9-5b21-7d40-9f1e-3a6b8c2d4e10', CWD, 1_000_000);
    writeCodexThread(roots, '01a0e4f2-7d13-7a9b-8c02-5e4f6a1b3c27', OTHER, 1_000_500);
    writeCodexThread(roots, '01a0aaaa-7d13-7a9b-8c02-5e4f6a1b3c27', CWD, 900_000, false);
    const result = await resolveAgentSession({ tabId: 't', cwd: CWD, agent: 'codex' }, { roots, isFileLocked: () => true });
    assert.deepEqual(result, { agent: 'codex', sessionId: '01a0e3c9-5b21-7d40-9f1e-3a6b8c2d4e10', method: 'codex-writer-lock', confidence: 'exact' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AC-3 Codex: two live threads in one cwd resolve to the one nearest the launch, estimated', async () => {
  const { roots, dir } = makeRoots();
  try {
    writeCodexThread(roots, '01a0e3c9-5b21-7d40-9f1e-3a6b8c2d4e10', CWD, 1_000_000);
    writeCodexThread(roots, '01a0e4f2-7d13-7a9b-8c02-5e4f6a1b3c27', CWD, 2_000_000);
    const result = await resolveAgentSession({ tabId: 't', cwd: CWD, agent: 'codex', agentStartedAtMs: 1_999_000 }, { roots, isFileLocked: () => true });
    assert.equal(result?.sessionId, '01a0e4f2-7d13-7a9b-8c02-5e4f6a1b3c27');
    assert.equal(result?.confidence, 'estimated');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeOpencodeLog(roots: AgentRoots, startMs: number, lines: string[]) {
  mkdirSync(path.join(roots.opencodeData, 'log'), { recursive: true });
  const name = new Date(startMs).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace(/^(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
  writeFileSync(path.join(roots.opencodeData, 'log', `${name}.log`), `${lines.join('\n')}\n`);
}

test('AC-4 OpenCode: the log started with the process holds the last prompted session', async () => {
  const { roots, dir } = makeRoots();
  try {
    const start = Date.UTC(2026, 8, 26, 4, 0, 0);
    writeOpencodeLog(roots, start, [
      'INFO  2026-09-26T04:00:05 +1ms service=session id=ses_2a559dc6affeHH3n5zfzP1Qvg6 created',
      'INFO  2026-09-26T04:00:06 +1ms service=session.prompt session.id=ses_2a559dc6affeHH3n5zfzP1Qvg6 step=0',
      'INFO  2026-09-26T04:10:06 +1ms service=session.prompt sessionID=ses_2b4d91c0affe7Kq2xR8mNcPz3L step=0',
    ]);
    writeOpencodeLog(roots, start - 3_600_000, ['INFO service=session.prompt session.id=ses_1a111111affe7Kq2xR8mNcPz3L']);
    const procs: ProcessInfo[] = [
      { pid: 20, ppid: 1, name: 'powershell.exe' },
      { pid: 60, ppid: 20, name: 'opencode.exe', createdAtMs: start + 400 },
    ];
    const result = await resolveAgentSession({ tabId: 't', cwd: CWD, agent: null, ptyPid: 20 }, { roots, processes: procs });
    assert.deepEqual(result, { agent: 'opencode', sessionId: 'ses_2b4d91c0affe7Kq2xR8mNcPz3L', method: 'opencode-process-log', confidence: 'exact' });
    const byLaunch = await resolveAgentSession({ tabId: 't', cwd: CWD, agent: 'opencode', agentStartedAtMs: start - 1_000 }, { roots });
    assert.equal(byLaunch?.sessionId, 'ses_2b4d91c0affe7Kq2xR8mNcPz3L');
    assert.equal(byLaunch?.confidence, 'estimated');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AC-5 Hermes: the tracked output marker is used and is estimated', async () => {
  const { roots, dir } = makeRoots();
  try {
    const result = await resolveAgentSession(
      { tabId: 't', cwd: '/home/dev/og', agent: 'hermes', outputHint: { agent: 'hermes', sessionId: '20260926_131205_a4f9c2', source: 'hermes-banner', atMs: 1 } },
      { roots },
    );
    assert.deepEqual(result, { agent: 'hermes', sessionId: '20260926_131205_a4f9c2', method: 'hermes-banner', confidence: 'estimated' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('output hints: banner, resume and exit lines are tracked across chunk splits, ANSI stripped', () => {
  const tracker = new AgentOutputHintTracker();
  tracker.observe('s1', '\u001b[2mSession: 20260926_1312');
  tracker.observe('s1', '05_a4f9c2\u001b[0m\r\n');
  assert.deepEqual(tracker.get('s1'), { agent: 'hermes', sessionId: '20260926_131205_a4f9c2', source: 'hermes-banner', atMs: tracker.get('s1')?.atMs });
  tracker.observe('s1', '↻ Resumed session 20260926_140000_bbbbbb (3 messages)');
  assert.equal(tracker.get('s1')?.sessionId, '20260926_140000_bbbbbb');
  tracker.observe('s2', ' Resume this session with: claude --resume 7c1e0b52-4a0e-4f7b-9d61-2b8e5f0c3a19 ');
  assert.equal(tracker.get('s2')?.agent, 'claude');
  tracker.observe('s3', 'To continue this session, run:\r\n  \u001b[36mcodex resume 01a0e3c9-5b21-7d40-9f1e-3a6b8c2d4e10\u001b[0m');
  assert.equal(tracker.get('s3')?.sessionId, '01a0e3c9-5b21-7d40-9f1e-3a6b8c2d4e10');
  tracker.observe('s4', '  Continue  \u001b[1mopencode -s ses_2b4d91c0affe7Kq2xR8mNcPz3L\u001b[0m');
  assert.equal(tracker.get('s4')?.agent, 'opencode');
  tracker.observe('s5', 'plain output with no markers');
  assert.equal(tracker.get('s5'), null);
  tracker.forget('s1');
  assert.equal(tracker.get('s1'), null);
});

test('FR-AITUI-008 AC-3: resume commands keep the option command and swap the selector', () => {
  assert.deepEqual(
    buildResumeCommand('claude', 'x-id', { command: 'claudep', args: ['--dangerously-skip-permissions', '--continue'] }),
    { command: 'claudep', args: ['--dangerously-skip-permissions', '--resume', 'x-id'] },
  );
  assert.deepEqual(buildResumeCommand('claude', 'x-id', { command: 'claude', args: ['-r', 'old', '--model', 'opus'] }), { command: 'claude', args: ['--model', 'opus', '--resume', 'x-id'] });
  assert.deepEqual(
    buildResumeCommand('codex', 'c-id', { command: 'codex', args: ['--dangerously-bypass-approvals-and-sandbox', 'resume', '--last'] }),
    { command: 'codex', args: ['--dangerously-bypass-approvals-and-sandbox', 'resume', 'c-id'] },
  );
  assert.deepEqual(buildResumeCommand('hermes', 'h-id', { command: 'hermes', args: ['-c'] }), { command: 'hermes', args: ['--resume', 'h-id'] });
  assert.deepEqual(buildResumeCommand('opencode', 'ses_x', null), { command: 'opencode', args: ['--session', 'ses_x'] });
  assert.deepEqual(buildResumeCommand('codex', 'c-id', null), { command: 'codex', args: ['resume', 'c-id'] });
});

// FR-AITUI-006: a Codex subagent writes its own locked thread in the parent's cwd. It is not a
// session the user can resume on its own, so it must not turn the parent into a guess.
test('FR-AITUI-006 AC-3 Codex: subagent threads are ignored, so the parent session stays exact', async () => {
  const { roots, dir } = makeRoots();
  try {
    const parent = '01a0bf9d-9ff5-73d3-aa12-b1663692c7b2';
    writeCodexThread(roots, parent, CWD, 1_000_000, true, { source: 'cli' });
    writeCodexThread(roots, '01a0e44d-5fee-7e90-997d-c007ca833826', CWD, 2_000_000, true, {
      source: { subagent: { thread_spawn: { parent_thread_id: parent, depth: 1 } } },
      parent_thread_id: parent,
    });
    const result = await resolveAgentSession({ tabId: 't', cwd: CWD, agent: 'codex', agentStartedAtMs: 1_999_000 }, { roots, isFileLocked: () => true });
    assert.deepEqual(result, { agent: 'codex', sessionId: parent, method: 'codex-writer-lock', confidence: 'exact' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('FR-AITUI-006 AC-3 Codex: a terminal (cli) thread wins over an editor thread in the same folder', async () => {
  const { roots, dir } = makeRoots();
  try {
    writeCodexThread(roots, '01a0dcfa-2f10-7fe2-adb6-020d5c1dc5e7', CWD, 1_000_000, true, { source: 'vscode' });
    writeCodexThread(roots, '01a0e618-5e46-7880-8896-159d8350b34d', CWD, 2_000_000, true, { source: 'cli' });
    const result = await resolveAgentSession({ tabId: 't', cwd: CWD, agent: 'codex', agentStartedAtMs: 1_000_100 }, { roots, isFileLocked: () => true });
    assert.deepEqual(result, { agent: 'codex', sessionId: '01a0e618-5e46-7880-8896-159d8350b34d', method: 'codex-writer-lock', confidence: 'exact' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
