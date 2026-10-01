// Input-latency probe: echoes every byte back the moment it arrives, so the time from a
// keypress to its glyph on screen is BuilderGate's input + output path and nothing else
// (no shell line editor in between). Ctrl+C exits.
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdout.write('ECHO-READY\r\n');
process.stdin.on('data', (chunk) => {
  if (chunk.includes(3)) process.exit(0);
  process.stdout.write(chunk);
});
