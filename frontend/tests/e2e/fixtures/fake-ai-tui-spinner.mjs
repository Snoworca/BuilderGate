// FR-AITUI-010 E2E fixture: replays what an AI TUI's screen does while it waits
// on a subagent or a long tool call, without calling any model. A transcript
// first (substantive output), then only the working indicator, then the idle
// prompt.
//
// Modes, each read off the installed tool:
// - claude (Claude Code 2.1.281 bundle): the glyph walks · ✢ * ✶ ✻ ✽ on a 2 s
//   cosine cycle, redrawn in place only when it changes (the end frames stay up
//   about 0.4 s), and the elapsed timer changes once a second.
// - codex (Codex 0.157, which BuilderGate starts with tui.animations=false):
//   "• Working (Ns • esc to interrupt)"; with animations off only the seconds
//   digit changes, once a second.
// - hermes (hermes-agent cli_status_bar_mixin): "  (◔_◔) pondering...  ( 5.2s)"
//   redrawn about once a second (cli_refresh_interval 1.0), so usually only the
//   whole-seconds digit changes.
//
// usage: node fake-ai-tui-spinner.mjs <claude|codex|hermes> <busyMs> <idleMs>
const mode = process.argv[2] ?? 'claude';
const busyMs = Number(process.argv[3] ?? 8000);
const idleMs = Number(process.argv[4] ?? 4000);
const ROW = 6;
const out = (text) => process.stdout.write(text);

const start = Date.now();
let lastSecond = 0;
let tick;

function finish() {
  clearInterval(tick);
  out(`\x1b[${ROW};1H\x1b[2K`);
  out(`\x1b[${ROW + 2};1H> `);
  setTimeout(() => process.exit(0), idleMs);
}

out('\x1b[2J\x1b[H');
if (mode === 'claude') {
  const FRAMES = ['·', '✢', '*', '✶', '✻', '✽'];
  let lastFrame = 0;
  out('⏺ Task(Research the codebase)\r\n  ⎿  Read(src/index.ts)\r\n     +3 more tool uses\r\n\r\n');
  out(`\x1b[${ROW};1H· Channelling… (0s · subagent working)`);
  tick = setInterval(() => {
    const elapsed = Date.now() - start;
    if (elapsed >= busyMs) return finish();
    const phase = (1 - Math.cos((2 * Math.PI * elapsed) / 2000)) / 2;
    const frame = Math.round(phase * (FRAMES.length - 1));
    if (frame !== lastFrame) {
      lastFrame = frame;
      out(`\x1b[${ROW};1H${FRAMES[frame]}`);
    }
    const second = Math.floor(elapsed / 1000);
    if (second !== lastSecond) {
      lastSecond = second;
      out(`\x1b[${ROW};16H${second}s`);
    }
  }, 50);
} else if (mode === 'codex') {
  out('• Ran npm test -- --runInBand\r\n  └ waiting for the test run\r\n\r\n');
  const line = '• Working (0s • esc to interrupt)';
  out(`\x1b[${ROW};1H${line}`);
  const digitCol = line.indexOf('0s') + 1;
  tick = setInterval(() => {
    const elapsed = Date.now() - start;
    if (elapsed >= busyMs) return finish();
    const second = Math.floor(elapsed / 1000);
    if (second !== lastSecond && second < 10) {
      lastSecond = second;
      out(`\x1b[${ROW};${digitCol}H${second}`);
    }
  }, 50);
} else if (mode === 'hermes') {
  out('Welcome to Hermes Agent! Type your message or /help for commands.\r\n\r\n');
  out('┊ ⚙ terminal: npm test -- --runInBand\r\n┊ running the test suite\r\n\r\n');
  const line = '  (◔_◔) pondering...  ( 0.3s)';
  out(`\x1b[${ROW};1H${line}`);
  const digitCol = line.indexOf('0.3s') + 1;
  tick = setInterval(() => {
    const elapsed = Date.now() - start;
    if (elapsed >= busyMs) return finish();
    const second = Math.floor(elapsed / 1000);
    if (second !== lastSecond && second < 10) {
      lastSecond = second;
      out(`\x1b[${ROW};${digitCol}H${second}`);
    }
  }, 50);
} else {
  process.stderr.write(`unknown mode ${mode}\n`);
  process.exit(2);
}
