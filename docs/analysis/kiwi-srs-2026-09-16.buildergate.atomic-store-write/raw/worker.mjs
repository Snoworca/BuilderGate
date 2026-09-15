// Reproduces the exact publish sequence of CommandPresetService.flushToDisk
// against a SHARED fixed tmp path, from two independent processes.
import fs from 'node:fs/promises';
const [,, dir, tag, rounds, len] = process.argv;
const dest = `${dir}/store.json`;
const tmp  = dest + '.tmp';
const bak  = dest + '.bak';
const out = { tag, ok:0, errors:{}, publishedOther:0 };
for (let i = 0; i < Number(rounds); i++) {
  const payload = JSON.stringify({ writer: tag, round: i, pad: tag.repeat(Number(len)) });
  try {
    await fs.writeFile(tmp, payload, { encoding:'utf-8', mode:0o600 });
    try { await fs.copyFile(dest, bak); } catch {}
    await fs.rename(tmp, dest);
    out.ok++;
    // Did this call publish its OWN payload, or a peer's?
    const got = await fs.readFile(dest, 'utf-8');
    if (got !== payload) out.publishedOther++;
  } catch (e) {
    out.errors[e.code || e.message] = (out.errors[e.code || e.message] || 0) + 1;
  }
}
console.log(JSON.stringify(out));
