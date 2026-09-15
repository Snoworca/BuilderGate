#!/usr/bin/env node
// Captures the set of failing test names across the suites that touch the
// stores under server/data/, so a post-change run can be diffed against it by
// name rather than by exit code.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const SERVER = path.resolve(process.argv[2] ?? 'server');
const OUT = path.resolve(process.argv[3] ?? 'out.json');
const FILES = fs.readdirSync(path.join(SERVER, 'src', 'services'))
  .filter(f => f.endsWith('.test.ts'))
  .map(f => `src/services/${f}`)
  .concat(
    fs.readdirSync(path.join(SERVER, 'src', 'utils'))
      .filter(f => f.endsWith('.test.ts'))
      .map(f => `src/utils/${f}`),
  )
  .sort();

const failing = [];
const errors = [];
for (const file of FILES) {
  let out = '';
  try {
    out = execFileSync('npx', ['tsx', '--test', file],
      { cwd: SERVER, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000 });
  } catch (e) {
    out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    if (!out.trim()) errors.push(`${file}: ${e.message}`);
  }
  // node:test prints each failure under "✖ failing tests:" as "✖ <name>"
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(?:✖|not ok \d+ -)\s+(.*?)\s*(?:\(\d+(?:\.\d+)?ms\))?\s*$/);
    if (m && m[1] && !/^failing tests:?$/.test(m[1])) failing.push(`${file} :: ${m[1]}`);
  }
}
fs.writeFileSync(OUT, JSON.stringify({
  capturedAt: new Date().toISOString(),
  files: FILES.length,
  failing: [...new Set(failing)].sort(),
  harnessErrors: errors,
}, null, 2));
console.log(`files ${FILES.length} | failing ${new Set(failing).size} | harness errors ${errors.length}`);
