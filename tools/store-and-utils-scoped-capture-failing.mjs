#!/usr/bin/env node
// Captures the set of failing test names across the suites that touch the
// stores under server/data/, so a post-change run can be diffed against it by
// name rather than by exit code.
//
// A file that never completed contributes zero failure lines, which is
// indistinguishable from a file that passed. So the capture records what it
// enumerated and how each child ended, and the diff refuses to compare two
// captures unless both ran the same files to completion.
// #60: THIS IS NOT A PROJECT-WIDE REGRESSION GATE.
//
// It collects server/src/services and server/src/utils only -- deliberately, to keep the run
// short for the store work it was built for. src/ws, src/routes, src/benchmarks, src/schemas,
// src/testing and src/types are NOT collected, so a store change whose blast radius reaches
// the router or the WS layer will pass this and still be a regression.
//
// The file was called issue24-capture-failing.mjs, which said nothing about that. A later
// reader had no way to learn the scope except by reading the collector. Renamed so the
// limitation travels with the tool.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Why a child process did not complete normally, or `null` when it did.
 *
 * `execFileSync` throws for an ordinary non-zero exit too, and that case is the
 * signal this capture exists to record — a suite that ran and failed. What must
 * not be swallowed is a child that was killed (the timeout), died on a signal,
 * or never produced an exit status at all (a spawn failure). Judging that by
 * "was the output empty" misses a hang that printed something before it stalled,
 * which is the more likely shape of a deadlocked suite.
 */
export function describeChildFailure(error) {
  if (!error) return null;
  if (error.killed === true) {
    return `killed before it completed (${error.signal ?? 'no signal'}): ${error.message}`;
  }
  if (error.signal) {
    return `terminated by ${error.signal}: ${error.message}`;
  }
  if (typeof error.status !== 'number') {
    return `never reported an exit status (${error.code ?? 'no errno'}): ${error.message}`;
  }
  const output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
  if (!output.trim()) {
    return `exited ${error.status} without producing any output: ${error.message}`;
  }
  return null;
}

/**
 * The per-file summary node:test prints at the end of a run, or `null` when the
 * output carries no such summary.
 *
 * A file that stops registering tests exits 0 and contributes no failure lines,
 * so it is invisible to a comparison over failing names alone. CLAUDE.md records
 * this repository hitting exactly that: a `node --test` process passes
 * NODE_TEST_CONTEXT to its children, node's recursion guard prints only
 * `skipping running files` and exits 0 having executed nothing, and an assertion
 * over that outcome "passes vacuously with stdout empty". The count of tests a
 * file registered is the only thing that distinguishes that from a clean pass.
 *
 * Absence of a summary is deliberately `null` and never zero. Zero is a claim
 * ("this file registered no tests"); null is the absence of a claim, and the
 * diff must treat the two differently — a claim of zero can be compared
 * against the baseline, an absent summary can only be refused.
 *
 * The block is read as a unit rather than label by label. Reading each label
 * independently with last-wins composes a record out of different runs when the
 * output carries more than one summary and the later one is truncated: a
 * complete `tests 5 / pass 5 / fail 3` followed by a cut-off `tests 9 / pass 8`
 * yielded `{tests: 9, pass: 8, fail: 3}`, a triple that describes neither run.
 * So contiguous runs of `ℹ <label> <number>` lines are grouped, and the last
 * group carrying all three labels is returned — the last run that actually
 * finished printing its summary.
 */
export function parseFileSummary(output) {
  const COUNT_LINE = /^\s*ℹ\s+(\w+)\s+(\d+(?:\.\d+)?)\s*$/;
  const blocks = [];
  let current = null;
  for (const line of String(output ?? '').split('\n')) {
    const m = line.match(COUNT_LINE);
    if (!m) {
      current = null;
      continue;
    }
    if (!current) {
      current = {};
      blocks.push(current);
    }
    // Last-wins within one block only, where a repeated label would be the
    // same run restating itself rather than a different run's number.
    current[m[1]] = Number(m[2]);
  }
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const { tests, pass, fail } = blocks[i];
    if (Number.isInteger(tests) && Number.isInteger(pass) && Number.isInteger(fail)) {
      return { tests, pass, fail };
    }
  }
  return null;
}

export function enumerateFiles(server) {
  return fs.readdirSync(path.join(server, 'src', 'services'))
    .filter(f => f.endsWith('.test.ts'))
    .map(f => `src/services/${f}`)
    .concat(
      fs.readdirSync(path.join(server, 'src', 'utils'))
        .filter(f => f.endsWith('.test.ts'))
        .map(f => `src/utils/${f}`),
    )
    .sort();
}

function main() {
  const SERVER = path.resolve(process.argv[2] ?? 'server');
  const OUT = path.resolve(process.argv[3] ?? 'out.json');
  const FILES = enumerateFiles(SERVER);

  const failing = [];
  const errors = [];
  const perFileCounts = {};
  for (const file of FILES) {
    let out = '';
    try {
      // #60: NODE_TEST_* must not reach the child. A `node --test` parent exports
      // NODE_TEST_CONTEXT, node's recursion guard then prints `skipping running files` and the
      // child exits 0 having run NOTHING -- so this capture would record a clean sweep it never
      // performed. CLAUDE.md documents this exact trap; the capture was subject to it.
      const childEnv = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith('NODE_TEST_')),
      );
      out = execFileSync('npx', ['tsx', '--test', file],
        { cwd: SERVER, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000,
          env: childEnv });
    } catch (e) {
      out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
      const reason = describeChildFailure(e);
      if (reason) errors.push(`${file}: ${reason}`);
    }
    // Recorded even when it is null: the diff needs to see that the file was
    // enumerated and produced no summary, which is a different fact from the
    // file not having been enumerated at all.
    perFileCounts[file] = parseFileSummary(out);
    // node:test prints each failure under "✖ failing tests:" as "✖ <name>"
    for (const line of out.split('\n')) {
      const m = line.match(/^\s*(?:✖|not ok \d+ -)\s+(.*?)\s*(?:\(\d+(?:\.\d+)?ms\))?\s*$/);
      if (m && m[1] && !/^failing tests:?$/.test(m[1])) failing.push(`${file} :: ${m[1]}`);
    }
  }
  fs.writeFileSync(OUT, JSON.stringify({
    capturedAt: new Date().toISOString(),
    files: FILES.length,
    // The names, not just the count: two captures can agree on how many files
    // they ran while having run different ones.
    fileList: FILES,
    failing: [...new Set(failing)].sort(),
    // How many tests each file registered. A suite that stops registering tests
    // exits 0 and drops out of the failing-name comparison entirely; this is the
    // only field that makes that visible.
    perFileCounts,
    harnessErrors: errors,
  }, null, 2));
  const unparsed = Object.values(perFileCounts).filter(c => c === null).length;
  console.log(`files ${FILES.length} | failing ${new Set(failing).size} | harness errors ${errors.length} | no summary ${unparsed}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
