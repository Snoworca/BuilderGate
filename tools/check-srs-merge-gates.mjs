#!/usr/bin/env node
// Issue #75: a merge gate that lives only in an issue is a gate nobody runs.
//
// REL-BGSTAB-007 carries Stability=stable and Risk=high, and five requirements inherit its
// contract text (REL-BGSTAB-010, FR-BGSTAB-022, REL-BGSTAB-011, MIG-BGSTAB-002,
// REL-BGSTAB-012). Four unmerged branches hold it with 11 or 12 of its 12 ACs checked, and
// issue #27 re-derived those checks rather than inheriting the claim: it REFUTED three of the
// six doubts -- the remount tests are not vacuous, the Ordinal64 rejection tests do exist, and
// 'no-local-cache-parity-missing' is asserted -- and confirmed that two are unfounded:
//
//   AC-9   WsRouter collapses every rejection but replay-pending into 'server-error', so the
//          wire-level observability the AC requires is not there to observe.
//   AC-12  the six-step rollback ordering it claims is MIG-BGSTAB-002 AC-5's test, borrowed.
//
// (AC-8 was the third, and it was fixed on the integration branch rather than left unfounded.)
//
// Merging any of those branches would bring the checks back in with the file. This refuses that
// silently-arriving state. It does not judge the other ten ACs -- their evidence is per-AC work,
// and a guard that guessed about them would be the unfounded-check problem in a new place.
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const specPath = join(repositoryRoot, 'docs/spec/30.buildergate-stability.srs.md');

// Each entry names an AC that must not be checked, and why. Removing one is a decision that
// needs the evidence #27 asked for, not a tidy-up.
const UNFOUNDED = new Map([
  ['AC-9', 'wire-level rejection observability is collapsed into server-error (WsRouter); issue #27'],
  ['AC-12', 'the six-step rollback ordering test belongs to MIG-BGSTAB-002 AC-5; issue #27'],
]);
const REQUIREMENT = 'REL-BGSTAB-007';

const markdown = await readFile(specPath, 'utf8');
const lines = markdown.split('\n');
const start = lines.findIndex(line => line.startsWith(`### ${REQUIREMENT} `));
if (start < 0) {
  console.error(`${REQUIREMENT} is not in ${specPath}; the gate cannot check what it cannot find.`);
  process.exit(1);
}
const end = lines.findIndex((line, index) => index > start && line.startsWith('### '));
const block = lines.slice(start, end < 0 ? lines.length : end);

const criteria = new Map();
for (const line of block) {
  const match = /^- \[(x| )\] (AC-\d+):/u.exec(line);
  if (match) criteria.set(match[2], match[1] === 'x');
}

if (criteria.size === 0) {
  console.error(`${REQUIREMENT} has no acceptance criteria to check; nothing was verified.`);
  process.exit(1);
}

const missing = [...UNFOUNDED.keys()].filter(acId => !criteria.has(acId));
if (missing.length > 0) {
  // The ACs were renumbered or removed. Either way this guard is now pointing at nothing, and
  // saying so is better than passing.
  console.error(`${REQUIREMENT} no longer has ${missing.join(', ')}; re-derive the gate before trusting it.`);
  process.exit(1);
}

const violations = [...UNFOUNDED].filter(([acId]) => criteria.get(acId) === true);
if (violations.length > 0) {
  console.error(`${REQUIREMENT} carries ${violations.length} acceptance criterion check that issue #27 found unfounded:`);
  for (const [acId, reason] of violations) console.error(`  ${acId}: ${reason}`);
  console.error('\nThis is the issue #75 merge gate. A branch that checked these is being merged, or the');
  console.error('checks were restored by hand. Keep them unchecked, or replace the gate entry with the');
  console.error('evidence that closes the AC.');
  process.exit(1);
}

const checked = [...criteria.values()].filter(Boolean).length;
console.log(`${REQUIREMENT}: ${checked}/${criteria.size} acceptance criteria checked; none of ${[...UNFOUNDED.keys()].join(', ')} is among them.`);
