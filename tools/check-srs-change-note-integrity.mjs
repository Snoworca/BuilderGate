#!/usr/bin/env node
// Issue #65: `speckiwi edit-requirement-table-rows` rewrites a requirement block from a stale
// read, and a Change Note added between the read and the write disappears with no error and no
// warning. `speckiwi validate` then reports 0 errors and 0 warnings, because a missing note is
// not a structural fault -- the record is merely poorer than it was.
//
// The defect is in the external package (speckiwi ^3.0.0) and cannot be fixed here. What can be
// done here is to stop a silent loss from reaching history: Change Note rows are append-only in
// this repository, so a requirement holding FEWER of them than the committed version means a
// write ate one.
//
// Compares the working tree against HEAD (or against the commit named in argv[2]).
//   node tools/check-srs-change-note-integrity.mjs [ref]
// Exit 0 when no requirement lost a Change Note row, 1 otherwise.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const specDirectory = join(repositoryRoot, 'docs', 'spec');
const ref = process.argv[2] ?? 'HEAD';

// A requirement's Change Notes are the table rows under its `#### Change Notes` heading, counted
// per requirement heading. Counting rows rather than comparing text keeps this insensitive to
// rewording, which is allowed, while still catching a row that vanished, which is not.
function changeNoteCounts(markdown) {
  const counts = new Map();
  let requirement = null;
  let inChangeNotes = false;
  for (const line of markdown.split('\n')) {
    const heading = /^### ([A-Z][A-Z0-9-]*-\d+)\b/u.exec(line);
    if (heading) { requirement = heading[1]; inChangeNotes = false; continue; }
    if (/^#### /u.test(line)) { inChangeNotes = /^#### Change Notes\s*$/u.test(line); continue; }
    if (!requirement || !inChangeNotes) continue;
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map(cell => cell.trim());
    if (cells.length === 0) continue;
    if (cells[0] === 'Date' || /^-{2,}$/u.test(cells[0].replace(/\s/gu, ''))) continue;
    counts.set(requirement, (counts.get(requirement) ?? 0) + 1);
  }
  return counts;
}

function committed(relativePath) {
  try {
    return execFileSync('git', ['show', `${ref}:${relativePath}`], {
      cwd: repositoryRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null; // A new spec file has nothing to lose.
  }
}

const losses = [];
let checked = 0;
for (const name of readdirSync(specDirectory).filter(entry => entry.endsWith('.md')).sort()) {
  const relativePath = `docs/spec/${name}`;
  const before = committed(relativePath);
  if (before === null) continue;
  const after = readFileSync(join(specDirectory, name), 'utf8');
  const beforeCounts = changeNoteCounts(before);
  const afterCounts = changeNoteCounts(after);
  checked += beforeCounts.size;
  for (const [requirement, count] of beforeCounts) {
    const now = afterCounts.get(requirement) ?? 0;
    if (now < count) losses.push({ relativePath, requirement, before: count, after: now });
  }
}

if (checked === 0) {
  console.error(`No requirement with Change Notes was found under docs/spec at ${ref}; nothing was checked.`);
  process.exit(1);
}

if (losses.length > 0) {
  console.error(`${losses.length} requirement(s) lost Change Note rows against ${ref}:`);
  for (const loss of losses) {
    console.error(`  ${loss.requirement} in ${loss.relativePath}: ${loss.before} -> ${loss.after}`);
  }
  console.error('\nThis is issue #65: edit-requirement-table-rows rewrites the block from a stale read and');
  console.error('drops notes added since, with no error. Restore the rows, then add Change Notes only');
  console.error('AFTER every table-row write for that requirement has finished.');
  process.exit(1);
}

console.log(`No Change Note rows were lost: ${checked} requirement(s) with notes checked against ${ref}.`);
