import assert from 'node:assert/strict';
import test from 'node:test';

import { SessionManager } from './SessionManager.js';

/**
 * FR-AITUI-010 — an AI TUI stays "running" while its screen keeps animating.
 *
 * While Claude Code waits on a subagent, the only output is its spinner and its
 * elapsed timer. Read off the 2.1.281 bundle: the glyph walks
 * `· ✢ * ✶ ✻ ✽` and back on a 2 s cosine cycle, so the end frames stay up about
 * 0.4 s, and the timer text changes once a second. The `·` frame and a `12s`
 * tick are classified repaint_only, and one repaint_only chunk used to turn the
 * session idle on the spot; the 200 ms idleDelayMs was also shorter than the
 * gap between frames.
 */

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** The grace the fix promises (AC-2), written out rather than imported. */
const AI_BUSY_GRACE_MS = 1500;

/** Claude Code redraws single cells in place; these two are the ones that read as repaint_only. */
const SPINNER_DOT_FRAME = '\x1b[20;1H\xB7';
const TIMER_TICK = (seconds: number) => `\x1b[20;30H${seconds}s`;

function createHarness() {
  let onData: ((data: string) => void) | null = null;
  const manager = new SessionManager({
    pty: {
      termName: 'xterm-256color',
      defaultCols: 80,
      defaultRows: 24,
      useConpty: true,
      scrollbackLines: 1000,
      maxSnapshotBytes: 16,
      shell: 'bash',
    },
    session: { idleDelayMs: 40, runningDelayMs: 30 },
  } as any, {
    platform: 'linux',
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
  const session = manager.createSession('AI busy', 'bash', process.cwd());
  return {
    manager,
    id: session.id,
    emit(chunk: string) {
      if (!onData) throw new Error('PTY onData was not registered');
      onData(chunk);
    },
    status: () => manager.getSession(session.id)?.status,
    cleanup: () => manager.deleteSession(session.id),
  };
}

/** Polls rather than sleeping a fixed time: how long running lasts is what is under test. */
async function waitForRunning(harness: ReturnType<typeof createHarness>, what: string): Promise<void> {
  for (let waited = 0; waited < 300; waited += 5) {
    if (harness.status() === 'running') return;
    await delay(5);
  }
  assert.fail(`${what}: never reached running`);
}

async function startRunningClaude(harness: ReturnType<typeof createHarness>): Promise<void> {
  harness.manager.writeInput(harness.id, 'claude\r');
  harness.emit('⏺ Task(Research the codebase)\r\n  ⎿  Read(src/index.ts)\r\n');
  await waitForRunning(harness, 'precondition: substantive Claude output runs');
}

test('FR-AITUI-010 AC-1: spinner and timer repaints keep a running Claude session running', async () => {
  const harness = createHarness();
  try {
    await startRunningClaude(harness);
    const samples: string[] = [];
    for (let tick = 0; tick < 8; tick += 1) {
      harness.emit(tick % 2 === 0 ? SPINNER_DOT_FRAME : TIMER_TICK(tick));
      await delay(300);
      samples.push(String(harness.status()));
    }
    console.log(`[ai-busy] samples=${samples.join(',')}`);
    assert.deepEqual(samples, Array(8).fill('running'));
  } finally {
    harness.cleanup();
  }
});

test('FR-AITUI-010 AC-2: a running Claude session goes idle only after the busy grace', async () => {
  const harness = createHarness();
  try {
    await startRunningClaude(harness);
    // 0.4 s is the longest gap between two spinner frames; still running.
    await delay(400);
    assert.equal(harness.status(), 'running', 'a spinner pause is not the end of the work');
    await delay(AI_BUSY_GRACE_MS);
    assert.equal(harness.status(), 'idle', 'no output for the whole grace: idle');
  } finally {
    harness.cleanup();
  }
});

test('FR-AITUI-010 AC-3: repaints alone never start running, and typing still returns to idle', async () => {
  const harness = createHarness();
  try {
    harness.manager.writeInput(harness.id, 'claude\r');
    await delay(80);
    assert.equal(harness.status(), 'idle');
    for (let tick = 0; tick < 4; tick += 1) {
      harness.emit(tick % 2 === 0 ? SPINNER_DOT_FRAME : TIMER_TICK(tick));
      await delay(100);
    }
    assert.equal(harness.status(), 'idle', 'repaint_only output alone does not start running');

    harness.emit('⏺ Bash(npm test)\r\n  ⎿  Running…\r\n');
    await waitForRunning(harness, 'substantive output after the repaints');
    harness.manager.writeInput(harness.id, 'h');
    await delay(10);
    assert.equal(harness.status(), 'idle', 'typing into the AI prompt is waiting for input, as before');
  } finally {
    harness.cleanup();
  }
});

test('FR-AITUI-010 AC-1: repaints alone cannot hold running for long once the substantive output stops', async () => {
  // A status line with a refresh interval repaints about once a second after
  // the work is done, and none of those chunks is a spinner frame.
  const harness = createHarness();
  try {
    await startRunningClaude(harness);
    const STATUS_LINE = '\x1b[24;1H\x1b[2KOpus 5.5 \u00B7 context [42% used]';
    let lastRunningAt = Date.now();
    const started = Date.now();
    while (Date.now() - started < 6000) {
      harness.emit(STATUS_LINE);
      await delay(250);
      if (harness.status() === 'running') lastRunningAt = Date.now();
    }
    const heldMs = lastRunningAt - started;
    console.log(`[ai-busy] status-line repaints held running for ${heldMs} ms`);
    assert.equal(harness.status(), 'idle', 'periodic repaints without spinner frames end in idle');
    assert.ok(heldMs <= 4000, `held for ${heldMs} ms; the keepalive window is 3 s`);
  } finally {
    harness.cleanup();
  }
});

test('FR-AITUI-010 AC-5: an agent known only through its recovery option (claudep) gets the same grace', async () => {
  // The recovery option names the command the user actually types, e.g. an
  // alias like `claudep`; the built-in detector only knows exact names.
  const harness = createHarness();
  try {
    harness.manager.writeInput(harness.id, 'claudep\r');
    harness.manager.markRecoveryCommandForeground(harness.id, 'claudep');
    harness.emit('⏺ Task(Research the codebase)\r\n  ⎿  Read(src/index.ts)\r\n');
    await waitForRunning(harness, 'precondition: substantive output from claudep runs');
    const samples: string[] = [];
    for (let tick = 0; tick < 6; tick += 1) {
      harness.emit(tick % 2 === 0 ? SPINNER_DOT_FRAME : '\x1b[20;1H\u2736');
      await delay(400);
      samples.push(String(harness.status()));
    }
    console.log(`[ai-busy] claudep samples=${samples.join(',')}`);
    assert.deepEqual(samples, Array(6).fill('running'));
  } finally {
    harness.cleanup();
  }
});

test('FR-AITUI-010 AC-6: a ticking elapsed timer keeps Codex running through a long quiet wait', async () => {
  // BuilderGate starts Codex with tui.animations=false, so during a long tool
  // call or subagent wait the only change is the seconds digit of
  // "Working (Ns • esc to interrupt)", once a second.
  const harness = createHarness();
  try {
    harness.manager.writeInput(harness.id, 'codex\r');
    harness.emit('• Ran npm test -- --runInBand\r\n  └ waiting for the test run\r\n');
    await waitForRunning(harness, 'precondition: substantive Codex output runs');
    const samples: string[] = [];
    for (let second = 1; second <= 6; second += 1) {
      await delay(1000);
      harness.emit(`\x1b[4;12H${second}`);
      await delay(20);
      samples.push(String(harness.status()));
    }
    console.log(`[ai-busy] codex samples=${samples.join(',')}`);
    assert.deepEqual(samples, Array(6).fill('running'));
    await delay(AI_BUSY_GRACE_MS + 300);
    assert.equal(harness.status(), 'idle', 'once the timer stops, the grace runs out');
  } finally {
    harness.cleanup();
  }
});

test('FR-AITUI-010 AC-7: a Hermes status repaint keeps a running Hermes session running', async () => {
  // Hermes redraws "  (◔_◔) pondering...  ( 5.2s)" about once a second; when
  // only the whole-seconds digit changes, its detector reports repaint_only.
  const harness = createHarness();
  try {
    harness.manager.writeInput(harness.id, 'hermes\r');
    harness.emit('Welcome to Hermes Agent! Type your message or /help for commands.\r\n');
    await delay(50);
    harness.emit('┊ ⚙ terminal: npm test -- --runInBand\r\n┊ running the test suite\r\n');
    await waitForRunning(harness, 'precondition: substantive Hermes output runs');
    const samples: string[] = [];
    for (let second = 1; second <= 6; second += 1) {
      await delay(1000);
      harness.emit(`\x1b[6;30H${second}`);
      await delay(20);
      samples.push(String(harness.status()));
    }
    console.log(`[ai-busy] hermes samples=${samples.join(',')}`);
    assert.deepEqual(samples, Array(6).fill('running'));
  } finally {
    harness.cleanup();
  }
});

/**
 * Captured 2026-09-27 from a real Claude Code (claudep alias) session on 2222
 * with the server's debug capture: every ~110 ms a spinner frame, and ~20 ms
 * later a separate 3-byte chunk that only resets the colour. That empty chunk
 * was classified repaint_only and cancelled the pending running transition, so
 * a session that was visibly working never became running.
 */
const REAL_CLAUDE_FRAMES = [
  '\x1b[?25l\x1b[38;2;215;119;87m\x1b[87;1H\u2736\x1b[38;2;153;153;153m\x1b[21C9\x1b[91;3H\x1b[?25h',
  '\x1b[?25l\x1b[38;2;215;119;87m\x1b[87;1H\u273B\x1b[38;2;235;159;127m\x1b[8Cg\x1b[38;2;153;153;153m\x1b[3C8\x1b[7C21\x1b[91;3H\x1b[?25h',
  '\x1b[?25l\x1b[38;2;153;153;153m\x1b[87;23H2\x1b[91;3H\x1b[?25h',
  '\x1b[?25l\x1b[38;2;215;119;87m\x1b[87;1H\u273D\x1b[38;2;235;159;127m\x1b[7Cn\x1b[38;2;153;153;153m\x1b[13C4\x1b[91;3H\x1b[?25h',
  '\x1b[?25l\x1b[38;2;235;159;127m\x1b[87;8Hi\x1b[38;2;215;119;87m\x1b[2C\u2026\x1b[38;2;153;153;153m\x1b[10C35\x1b[91;3H\x1b[?25h',
  '\x1b[?25l\x1b[38;2;215;119;87m\x1b[87;1H\u00B7\x1b[38;2;235;159;127m\x1b[2Cn\x1b[38;2;215;119;87m\x1b[2Cs\x1b[38;2;153;153;153m\x1b[15C2\x1b[91;3H\x1b[?25h',
];
const SGR_RESET = '\x1b[m';

test('FR-AITUI-010 AC-8: the real Claude Code frame stream, each frame followed by a colour reset, reaches and holds running', async () => {
  const harness = createHarness();
  try {
    harness.manager.writeInput(harness.id, 'claudep\r');
    harness.manager.markRecoveryCommandForeground(harness.id, 'claudep');
    await delay(60);
    const samples: string[] = [];
    for (let frame = 0; frame < 30; frame += 1) {
      harness.emit(REAL_CLAUDE_FRAMES[frame % REAL_CLAUDE_FRAMES.length]);
      await delay(20);
      harness.emit(SGR_RESET);
      await delay(90);
      if (frame >= 6) samples.push(String(harness.status()));
    }
    console.log(`[ai-busy] real claude stream samples=${samples.join(',')}`);
    assert.deepEqual(samples, Array(samples.length).fill('running'), 'running within ~0.7 s and held while frames keep coming');
  } finally {
    harness.cleanup();
  }
});

const TITLE = (text: string) => `\x1b]0;${text}\x07`;

test('FR-AITUI-010 AC-9: a spinner in the terminal title keeps an AI session running with no other output', async () => {
  // Claude Code 2.1.228+ animates ◐◑◒◓ in the window title while it works (seen
  // on 2222: ◐/◑ alternating about once a second) and shows ✳ when idle; Orca
  // reads the same glyphs when it has no hook for the pane.
  const harness = createHarness();
  try {
    harness.manager.writeInput(harness.id, 'claudep\r');
    harness.manager.markRecoveryCommandForeground(harness.id, 'claudep');
    await delay(60);
    const samples: string[] = [];
    for (let second = 0; second < 5; second += 1) {
      harness.emit(TITLE(`${second % 2 === 0 ? '\u25D0' : '\u25D1'} 프로젝트 목적 확인`));
      await delay(950);
      samples.push(String(harness.status()));
    }
    console.log(`[ai-busy] title spinner samples=${samples.join(',')}`);
    assert.deepEqual(samples, Array(5).fill('running'));
  } finally {
    harness.cleanup();
  }
});

test('FR-AITUI-010 AC-10: an idle title (✳) ends running promptly, and a brief ✳ between working titles does not', async () => {
  const harness = createHarness();
  try {
    harness.manager.writeInput(harness.id, 'claudep\r');
    harness.manager.markRecoveryCommandForeground(harness.id, 'claudep');
    harness.emit(TITLE('\u25D0 task'));
    await delay(50);
    assert.equal(harness.status(), 'running');
    // Seen on 2222: ✳ for ~13 ms, then the spinner again.
    harness.emit(TITLE('\u2733 task'));
    await delay(15);
    harness.emit(TITLE('\u25D1 task'));
    await delay(400);
    assert.equal(harness.status(), 'running', 'a flicker of ✳ mid-work is not the end');
    harness.emit(TITLE('\u2733 task'));
    await delay(400);
    assert.equal(harness.status(), 'idle', 'the idle title ends running without waiting out the grace');
  } finally {
    harness.cleanup();
  }
});

test('FR-AITUI-010 AC-9: a spinner title in a plain shell does not make it running', async () => {
  const harness = createHarness();
  try {
    harness.manager.writeInput(harness.id, 'npm install\r');
    await delay(100);
    const before = harness.status();
    harness.emit(TITLE('\u280B npm install'));
    await delay(300);
    assert.equal(harness.status(), before, 'titles only count for an AI screen');
  } finally {
    harness.cleanup();
  }
});

test('FR-AITUI-010 AC-2: a plain shell keeps the short idleDelayMs', async () => {
  const harness = createHarness();
  try {
    harness.manager.writeInput(harness.id, 'ls\r');
    harness.emit('file-a\r\nfile-b\r\n');
    await delay(20);
    assert.equal(harness.status(), 'running');
    await delay(200);
    assert.equal(harness.status(), 'idle', 'a non-AI shell is not held by the AI grace');
  } finally {
    harness.cleanup();
  }
});
