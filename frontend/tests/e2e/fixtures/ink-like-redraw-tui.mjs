// REL-BGSTAB-041 fixture: repaints a boxed frame the way Ink (Claude Code) does -- erase the
// previous frame with relative cursor-up moves, then write the new one. If the terminal ever
// holds a byte stream the program did not write (a chunk applied twice, or one lost), the
// relative moves land one row off and the frame's top border is left behind above it.
const ROWS = 14;
const pre = Number(process.env.PRE ?? 3000);
const tick = Number(process.env.TICK ?? 30);
let previousLines = 0;
let frame = 0;

function draw() {
  const width = Math.max(20, (process.stdout.columns || 80) - 2);
  const lines = ['┌' + '─'.repeat(width - 2) + '┐'];
  for (let row = 0; row < ROWS; row += 1) {
    const body = `F${String(frame).padStart(6, '0')} L${String(row).padStart(2, '0')} ${'x'.repeat((frame + row) % 12)}`;
    lines.push('│' + body.slice(0, width - 2).padEnd(width - 2) + '│');
  }
  lines.push('└' + '─'.repeat(width - 2) + '┘');
  let out = '';
  for (let i = 0; i < previousLines; i += 1) out += '\x1b[2K\x1b[1A';
  if (previousLines) out += '\x1b[2K\r';
  out += lines.join('\n');
  previousLines = lines.length - 1;
  frame += 1;
  process.stdout.write(out);
}

for (let i = 0; i < pre; i += 1) process.stdout.write(`scrollback ${i} ${'가나다라마바사 abc '.repeat(3)}\n`);
setInterval(draw, tick);
