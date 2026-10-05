// Turns on mouse tracking the way Claude Code does (alternate screen, any-motion tracking, SGR
// reports), waits EXIT_AFTER_MS, then exits. With CLEAN=1 it turns everything off before exiting,
// as a well-behaved application does; with CLEAN=0 it exits leaving the modes on, as a killed
// one would.
const exitAfter = Number(process.env.EXIT_AFTER_MS ?? 8000);
const clean = process.env.CLEAN !== '0';
// Read console input in raw mode as Claude Code (Ink) does. Under ConPTY the mouse-mode requests
// reach the terminal only for a client that reads VT input; one that never reads stdin gets none.
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on('data', () => {});
process.stdout.write('\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h');
process.stdout.write('MOUSE-APP-RUNNING\r\n');
setTimeout(() => {
  if (clean) process.stdout.write('\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?1049l');
  process.stdout.write(`MOUSE-APP-EXITED clean=${clean}\r\n`);
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.exit(0);
}, exitAfter);
