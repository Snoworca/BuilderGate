import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const LEN = Number(process.argv[2] || 200);
const ROUNDS = Number(process.argv[3] || 300);
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'i24-'));
await fs.writeFile(path.join(dir,'store.json'), '{"seed":true}');
const run = (tag, len) => new Promise(res => execFile(process.execPath,
  ['worker.mjs', dir, tag, String(ROUNDS), String(len)],
  (e,so,se) => res(e ? {tag, fatal: se.toString().slice(0,300)} : JSON.parse(so))));
// DIFFERENT payload lengths: this is the case two real instances produce.
const [a,b] = await Promise.all([run('A', LEN), run('B', Math.round(LEN*1.7))]);
const dest = await fs.readFile(path.join(dir,'store.json'),'utf-8');
let parse='ok'; try { JSON.parse(dest); } catch(e){ parse='INVALID: '+e.message.slice(0,80); }
const bak = await fs.readFile(path.join(dir,'store.json.bak'),'utf-8').catch(()=>null);
let bakParse='ok'; if(bak!==null){ try{JSON.parse(bak);}catch(e){bakParse='INVALID: '+e.message.slice(0,80);} } else bakParse='absent';
console.log(JSON.stringify({ node: process.version, platform: os.platform(), payloadBytes:{A:LEN,B:Math.round(LEN*1.7)}, rounds:ROUNDS, A:a, B:b, finalDestParse:parse, finalBakParse:bakParse }, null, 2));
