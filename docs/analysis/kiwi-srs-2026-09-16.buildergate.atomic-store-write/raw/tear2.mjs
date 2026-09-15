// Does a rename of a SHARED temp path publish a PARTIALLY WRITTEN peer document?
// Two real processes; one writes the temp path in a loop, the other renames it
// onto the destination in a loop; we then check whether the destination ever
// holds something that parses as neither writer's whole document.
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'i24-tear2-'));
await fs.writeFile(path.join(dir, 'seed'), 'x');

await fs.writeFile(path.join(dir, 'writer.mjs'), `
import fs from 'node:fs/promises';
const dir = process.argv[2], tag = process.argv[3], size = Number(process.argv[4]);
const tmp = dir + '/store.json.tmp';
const payload = JSON.stringify({ writer: tag, pad: tag.repeat(size) });
for (let i = 0; i < 4000; i++) {
  try { await fs.writeFile(tmp, payload, { encoding:'utf-8', mode:0o600 }); } catch {}
}
`);
await fs.writeFile(path.join(dir, 'publisher.mjs'), `
import fs from 'node:fs/promises';
const dir = process.argv[2], tag = process.argv[3], size = Number(process.argv[4]);
const tmp = dir + '/store.json.tmp', dest = dir + '/store.json';
const payload = JSON.stringify({ writer: tag, pad: tag.repeat(size) });
let published = 0, torn = 0, renameErr = 0, samples = [];
for (let i = 0; i < 4000; i++) {
  try { await fs.writeFile(tmp, payload, { encoding:'utf-8', mode:0o600 }); } catch {}
  try { await fs.rename(tmp, dest); published++; } catch { renameErr++; continue; }
  const got = await fs.readFile(dest, 'utf-8');
  let ok = false;
  try { JSON.parse(got); ok = true; } catch {}
  if (!ok) { torn++; if (samples.length < 2) samples.push({ len: got.length, head: got.slice(0,40), tail: got.slice(-40) }); }
}
console.log(JSON.stringify({ published, renameErr, publishedUnparseable: torn, samples }));
`);

const run = (script, tag, size) => new Promise(res => execFile(process.execPath,
  [path.join(dir, script), dir, tag, String(size)], { maxBuffer: 1<<24 },
  (e, so, se) => res(e ? { fatal: String(se).slice(0,200) } : (so.trim() ? JSON.parse(so) : {}))));

// Peer writes a payload of a very different length onto the SAME temp path.
const [peer, pub] = await Promise.all([run('writer.mjs','B',60000), run('publisher.mjs','A',400)]);
console.log(JSON.stringify({ platform: os.platform(), node: process.version, peer, publisher: pub }, null, 2));
