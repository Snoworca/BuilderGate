// FR-AITUI-010 E2E fixture: replays what Claude Code's screen does while a
// subagent works, without calling any model. A transcript first (substantive
// output), then nothing but the spinner glyph and the elapsed timer, then the
// idle prompt.
//
// The cadence is Claude Code 2.1.281's, read off its bundle: the glyph walks
// · ✢ * ✶ ✻ ✽ on a 2 s cosine cycle (so the end frames stay up about 0.4 s),
// redrawn in place only when it changes, and the timer changes once a second.
//
// usage: node fake-claude-spinner.mjs <busyMs> <idleMs>
const FRAMES = ['·', '✢', '*', '✶', '✻', '✽'];
const busyMs = Number(process.argv[2] ?? 8000);
const idleMs = Number(process.argv[3] ?? 4000);
const ROW = 6;
const out = (text) => process.stdout.write(text);

out('\x1b[2J\x1b[H');
out('⏺ Task(Research the codebase)\r\n  ⎿  Read(src/index.ts)\r\n     +3 more tool uses\r\n\r\n');
out(`\x1b[${ROW};1H· Channelling… (0s · subagent working)`);

const start = Date.now();
let lastFrame = 0;
let lastSecond = 0;
const tick = setInterval(() => {
  const elapsed = Date.now() - start;
  if (elapsed >= busyMs) {
    clearInterval(tick);
    out(`\x1b[${ROW};1H\x1b[2K`);
    out(`\x1b[${ROW + 2};1H> `);
    setTimeout(() => process.exit(0), idleMs);
    return;
  }
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
