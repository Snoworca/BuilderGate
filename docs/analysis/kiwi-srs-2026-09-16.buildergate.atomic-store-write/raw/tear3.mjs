// Classifies HOW a torn publish is torn, to test the stated mechanism:
// each writer opens the shared temp path with O_TRUNC and writes from offset
// zero, so a shorter document laid over a longer one should leave exactly
// short + long.slice(short.length).
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'i24-tear3-'));
const SHORT = JSON.stringify({ writer: 'A', pad: 'A'.repeat(400) });
const LONG  = JSON.stringify({ writer: 'B', pad: 'B'.repeat(60000) });
await fs.writeFile(path.join(dir, 'payloads.json'), JSON.stringify({ SHORT, LONG }));

await fs.writeFile(path.join(dir, 'peer.mjs'), `
import fs from 'node:fs/promises';
const { LONG } = JSON.parse(await fs.readFile(process.argv[2] + '/payloads.json','utf-8'));
const tmp = process.argv[2] + '/store.json.tmp';
for (let i = 0; i < 4000; i++) { try { await fs.writeFile(tmp, LONG, {encoding:'utf-8',mode:0o600}); } catch {} }
`);
await fs.writeFile(path.join(dir, 'pub.mjs'), `
import fs from 'node:fs/promises';
const d = process.argv[2];
const { SHORT, LONG } = JSON.parse(await fs.readFile(d + '/payloads.json','utf-8'));
const tmp = d + '/store.json.tmp', dest = d + '/store.json';
const overlay = SHORT + LONG.slice(SHORT.length);
let published=0, torn=0, overlayMatch=0, other=0, otherLens=[];
for (let i = 0; i < 4000; i++) {
  try { await fs.writeFile(tmp, SHORT, {encoding:'utf-8',mode:0o600}); } catch {}
  try { await fs.rename(tmp, dest); published++; } catch { continue; }
  const got = await fs.readFile(dest, 'utf-8');
  if (got === SHORT || got === LONG) continue;
  torn++;
  if (got === overlay) overlayMatch++; else { other++; if (otherLens.length < 5) otherLens.push(got.length); }
}
console.log(JSON.stringify({ published, torn, overlayMatch, other, otherLens }));
`);
const run = (s, ...a) => new Promise(r => execFile(process.execPath, [path.join(dir,s), dir, ...a], {maxBuffer:1<<24},
  (e,so,se) => r(e ? {fatal:String(se).slice(0,200)} : (so.trim()?JSON.parse(so):{}))));
const [, pub] = await Promise.all([run('peer.mjs'), run('pub.mjs')]);
console.log(JSON.stringify({ node: process.version, platform: os.platform(),
  shortBytes: SHORT.length, longBytes: LONG.length, publisher: pub }, null, 2));
