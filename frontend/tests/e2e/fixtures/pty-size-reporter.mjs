// Prints the PTY size the program sees, so a test can compare it with the browser's xterm size.
// PTYSIZE comes from the 'resize' event (what a TUI such as Claude Code reacts to); PTYPOLL polls
// the console size directly every 500 ms, so the two tell "the PTY did not change" apart from
// "the PTY changed but the program was never told".
import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Also logged to a file, which does not depend on the output reaching the browser.
const logFile = process.env.PTYSIZE_LOG ?? join(tmpdir(), 'pty-size-reporter.log');
const log = (kind, size) => { try { appendFileSync(logFile, `${Date.now()} ${process.pid} ${kind} ${size}\n`); } catch {} };
// Read stdin in raw mode like a real TUI (Claude Code does). On Windows libuv learns about a
// console resize from the input event queue, so a program that never reads stdin never hears
// of one -- an earlier version of this fixture did not, and reported stale sizes.
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.on('data', (chunk) => { if (chunk.includes(3)) process.exit(0); });
let polled = '';
process.stdout.on('resize', () => {
  log('event', `${process.stdout.columns}x${process.stdout.rows}`);
  process.stdout.write(`\r\nPTYSIZE ${process.stdout.columns}x${process.stdout.rows}\r\n`);
});
process.stdout.write(`\r\nPTYSIZE ${process.stdout.columns}x${process.stdout.rows}\r\n`);
setInterval(() => {
  const [cols, rows] = process.stdout.getWindowSize();
  const size = `${cols}x${rows}`;
  if (size !== polled) {
    polled = size;
    log('poll', size);
    process.stdout.write(`\r\nPTYPOLL ${size}\r\n`);
  }
}, 500);
