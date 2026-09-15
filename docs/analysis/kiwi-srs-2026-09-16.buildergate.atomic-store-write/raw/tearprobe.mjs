// Q1: can two concurrent writeFile() calls on ONE path, with DIFFERENT payload
//     lengths, leave a file that is neither payload (byte-level tearing)?
// Q2: does a shared tmp path make a publish resolve successfully while moving
//     a PEER's bytes into place (lost update reported as success)?
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'i24-tear-'));
const p = path.join(dir, 'x.json');

// ---- Q1: in-process concurrent writeFile, mismatched lengths, many rounds
let torn = 0, seen = new Set();
for (let i = 0; i < 400; i++) {
  const a = JSON.stringify({ w: 'A', pad: 'a'.repeat(50_000) });
  const b = JSON.stringify({ w: 'B', pad: 'b'.repeat(900_000) }); // > 512KiB chunk threshold
  await Promise.all([fs.writeFile(p, a), fs.writeFile(p, b)]);
  const got = await fs.readFile(p, 'utf-8');
  if (got !== a && got !== b) { torn++; }
  seen.add(got === a ? 'A' : got === b ? 'B' : 'TORN');
}
console.log(JSON.stringify({ Q1_concurrent_writeFile_mismatched_lengths: { rounds: 400, tornCount: torn, outcomes: [...seen] } }));

// ---- Q2: deterministic lost update through a shared tmp path
const dest = path.join(dir, 'store.json');
const tmp = dest + '.tmp';
await fs.writeFile(dest, '{"seed":true}');
const mine = JSON.stringify({ writer: 'A', value: 'A-change' });
const peers = JSON.stringify({ writer: 'B', value: 'B-change' });

// A writes its temp file...
await fs.writeFile(tmp, mine, { encoding: 'utf-8', mode: 0o600 });
// ...B, in another process, writes the SAME temp path before A renames...
await fs.writeFile(tmp, peers, { encoding: 'utf-8', mode: 0o600 });
// ...A renames. A's call resolves with no error.
let aResolved = true;
try { await fs.rename(tmp, dest); } catch { aResolved = false; }
const published = await fs.readFile(dest, 'utf-8');
console.log(JSON.stringify({
  Q2_shared_tmp_lost_update: {
    A_publish_resolved: aResolved,
    A_wrote: JSON.parse(mine).value,
    on_disk_after_A_publish: JSON.parse(published).value,
    A_change_lost_but_reported_success: aResolved && JSON.parse(published).value !== 'A-change'
  }
}));

// ---- Q2b: and B's own rename then fails, because A moved the shared temp away
let bErr = null;
try { await fs.rename(tmp, dest); } catch (e) { bErr = e.code; }
console.log(JSON.stringify({ Q2b_peer_rename_after: { code: bErr } }));
