#!/usr/bin/env node
// Compares two captured failing-test-name sets. Acceptance for issue #24's
// regression gate is set equality, not an exit code: a run that fails only for
// the known Linux/WSL2 baseline reasons and a run that additionally fails
// because a store broke both exit non-zero, so an exit code cannot tell them
// apart.
import fs from 'node:fs';

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
}
const baselinePath = arg('--baseline');
const afterPath = arg('--after');
if (!baselinePath || !afterPath) {
  console.error('usage: issue24-regression-diff.mjs --baseline <json> --after <json>');
  process.exit(2);
}
const read = p => new Set(JSON.parse(fs.readFileSync(p, 'utf-8')).failing);
const before = read(baselinePath);
const after = read(afterPath);
const added = [...after].filter(n => !before.has(n)).sort();
const fixed = [...before].filter(n => !after.has(n)).sort();

console.log(`baseline failing: ${before.size}`);
console.log(`after failing:    ${after.size}`);
if (fixed.length) console.log(`no longer failing (${fixed.length}):\n  ${fixed.join('\n  ')}`);
if (added.length) {
  console.log(`NEW FAILURES (${added.length}):\n  ${added.join('\n  ')}`);
  process.exit(1);
}
console.log('no new failures');
