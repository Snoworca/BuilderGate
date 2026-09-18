#!/usr/bin/env node
// Guards the issue #24 regression gate itself.
//
// The gate's whole job is to tell "failed only for the known Linux/WSL2
// baseline reasons" apart from "additionally failed because a store broke".
// A capture that never ran a file produces no failure lines for it, so a change
// that deadlocks a suite otherwise reaches the diff looking exactly like a
// change that fixed it. These cases pin the shapes that must be refused.
//
// The real capture runs every service and util suite and takes minutes, so it
// is never invoked here: the capture's classification of a child process is
// tested as a pure function, and the diff is tested against constructed
// capture documents.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIFF = path.join(HERE, 'store-and-utils-scoped-regression-diff.mjs');

const FILES = ['src/services/A.test.ts', 'src/utils/B.test.ts'];

function capture(overrides = {}) {
  return {
    capturedAt: '2026-09-16T00:00:00.000Z',
    files: FILES.length,
    fileList: [...FILES],
    failing: [],
    harnessErrors: [],
    ...overrides,
  };
}

let tmp;
function write(name, document) {
  tmp ??= fs.mkdtempSync(path.join(os.tmpdir(), 'issue24-diff-'));
  const file = path.join(tmp, name);
  fs.writeFileSync(file, JSON.stringify(document, null, 2));
  return file;
}

after(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

// Every refusal the gate is capable of announces itself under one of these
// banners. A non-zero exit that carries none of them is not a refusal — it is
// the diff tool crashing — and the two must never be confused.
const REFUSAL_BANNERS = ['GATE UNUSABLE', 'TEST COUNT DROPPED', 'NEW FAILURES'];

/**
 * Runs the diff and returns its exit status plus combined output.
 *
 * A case that only asserts `status !== 0` cannot tell a deliberate refusal from
 * a crash in the tool under test: measured 2026-09-16, replacing the whole diff
 * tool with `throw new Error(...)` left such a case green. So the helper itself
 * refuses to report a crash as a refusal — a non-zero status whose output
 * carries no refusal banner fails here, for every case, whether or not that
 * case goes on to assert on the output.
 */
function runDiff(baseline, afterPath) {
  try {
    const stdout = execFileSync(process.execPath, [DIFF, '--baseline', baseline, '--after', afterPath], {
      encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, output: stdout };
  } catch (error) {
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    if (!REFUSAL_BANNERS.some(banner => output.includes(banner))) {
      assert.fail(
        `the diff tool exited ${error.status ?? `on ${error.signal}`} without announcing any refusal ` +
        `(${REFUSAL_BANNERS.join(' / ')}), so this is a crash and not a gate decision:\n${output}`,
      );
    }
    return { status: error.status, output };
  }
}

test('issue #24 gate: two clean, identical captures pass', () => {
  const result = runDiff(write('base-clean.json', capture()), write('after-clean.json', capture()));
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /no new failures/);
});

test('issue #24 gate: a genuinely new failure still fails the gate', () => {
  const result = runDiff(
    write('base-newfail.json', capture()),
    write('after-newfail.json', capture({ failing: ['src/services/A.test.ts :: something broke'] })),
  );
  assert.notEqual(result.status, 0, 'a new failure must fail the gate');
  assert.match(result.output, /NEW FAILURES/);
});

test('issue #24 gate: a harness error on the after side fails the gate', () => {
  // This is the hang. The child was killed by the timeout, contributed zero
  // failure lines, and the failing-name sets are therefore equal.
  const result = runDiff(
    write('base-h1.json', capture()),
    write('after-h1.json', capture({ harnessErrors: ['src/utils/B.test.ts: timed out after 180000ms (SIGTERM)'] })),
  );
  assert.notEqual(result.status, 0, 'a file that did not run cannot be reported as "no new failures"');
  assert.match(result.output, /src\/utils\/B\.test\.ts/);
});

test('issue #24 gate: a harness error on the baseline side fails the gate', () => {
  // A baseline that never ran a file cannot establish what that file's failures
  // were, so the comparison it anchors is not evidence of anything.
  const result = runDiff(
    write('base-h2.json', capture({ harnessErrors: ['src/services/A.test.ts: spawn npx ENOENT'] })),
    write('after-h2.json', capture()),
  );
  assert.notEqual(result.status, 0, 'a baseline with a file that did not run cannot anchor the comparison');
  assert.match(result.output, /src\/services\/A\.test\.ts/);
});

test('issue #24 gate: captures that enumerated different files fail the gate', () => {
  const result = runDiff(
    write('base-set.json', capture()),
    write('after-set.json', capture({
      files: 2,
      fileList: ['src/services/A.test.ts', 'src/utils/C.test.ts'],
    })),
  );
  assert.notEqual(result.status, 0, 'a file deleted and another added must not cancel out');
  assert.match(result.output, /C\.test\.ts/);
  assert.match(result.output, /B\.test\.ts/);
});

test('issue #24 gate: a capture that recorded no file list fails the gate', () => {
  const stale = capture();
  delete stale.fileList;
  const result = runDiff(write('base-nolist.json', stale), write('after-nolist.json', capture()));
  assert.notEqual(result.status, 0, 'a capture that cannot say which files it ran cannot be compared');
  // Not just non-zero: the refusal has to name the field it refused over and
  // say which side carried it, or the case cannot tell a refusal from a crash.
  assert.match(result.output, /GATE UNUSABLE/);
  assert.match(result.output, /baseline: recorded no fileList/);
  assert.doesNotMatch(result.output, /no new failures/);
});

test('issue #24 capture: a child killed by the timeout is recorded as errored even with partial output', async () => {
  const { describeChildFailure } = await import('./store-and-utils-scoped-capture-failing.mjs');
  const killed = Object.assign(new Error('spawnSync npx ETIMEDOUT'), {
    status: null, signal: 'SIGTERM', killed: true,
    stdout: '▶ some suite\n  ✔ a case that did run\n', stderr: '',
  });
  assert.notEqual(
    describeChildFailure(killed),
    null,
    'a hang that produced partial output is still a file that never completed',
  );
});

test('issue #24 capture: an ordinary failing run is not recorded as a harness error', async () => {
  const { describeChildFailure } = await import('./store-and-utils-scoped-capture-failing.mjs');
  const failed = Object.assign(new Error('Command failed'), {
    status: 1, signal: null, killed: false,
    stdout: '✖ a genuine assertion failure\n', stderr: '',
  });
  assert.equal(
    describeChildFailure(failed),
    null,
    'a suite that ran and failed is the signal this gate compares, not a harness error',
  );
});

test('issue #24 capture: a child that produced no output at all is recorded as errored', async () => {
  const { describeChildFailure } = await import('./store-and-utils-scoped-capture-failing.mjs');
  const silent = Object.assign(new Error('spawnSync npx ENOENT'), {
    status: null, signal: null, killed: false, stdout: '', stderr: '',
  });
  assert.notEqual(describeChildFailure(silent), null);
});

// The relaxation that makes the gate usable at all: a TDD change adds test
// files, so an after run that covers everything the baseline did plus more is
// the normal case. Only the other direction — a file the baseline ran and the
// after run did not — hides failures.
test('issue #24 gate: an after run that adds files but drops none is accepted', () => {
  const result = runDiff(
    write('base-superset.json', capture()),
    write('after-superset.json', capture({
      files: 3,
      fileList: [...FILES, 'src/utils/NEW.test.ts'],
    })),
  );
  assert.equal(result.status, 0, 'adding a test file must not make the gate unusable');
  assert.match(result.output, /no new failures/);
  assert.match(result.output, /files added since the baseline/);
});

test('issue #24 gate: an after run that drops a file the baseline ran is rejected', () => {
  const result = runDiff(
    write('base-dropped.json', capture()),
    write('after-dropped.json', capture({
      files: 1,
      fileList: [FILES[0]],
    })),
  );
  assert.notEqual(result.status, 0, 'a suite that stopped running must not read as green');
  assert.match(result.output, /did not enumerate/);
  assert.match(result.output, new RegExp(FILES[1].replace(/[.]/g, '\\.')));
});

// FND-101. The preflight refuses a capture that cannot say which files it ran.
// It must refuse a capture that cannot say which tests failed for the same
// reason: `new Set(undefined ?? [])` is zero failures, which is indistinguishable
// from a clean run and is exactly the falsely-green shape the preflight exists
// to close.
test('issue #24 gate: a capture with no failing list fails the gate', () => {
  const stale = capture();
  delete stale.failing;
  const result = runDiff(write('base-nofailing.json', capture({ failing: ['src/services/A.test.ts :: known'] })), write('after-nofailing.json', stale));
  assert.notEqual(result.status, 0, 'a capture that cannot say which tests failed cannot be compared');
  assert.match(result.output, /GATE UNUSABLE/);
  assert.doesNotMatch(result.output, /no new failures/);
});

test('issue #24 gate: a capture whose failing list is not an array fails the gate', () => {
  const result = runDiff(
    write('base-failingstr.json', capture()),
    write('after-failingstr.json', capture({ failing: 'none' })),
  );
  assert.notEqual(result.status, 0, 'a non-array failing field is not a failure set');
  assert.match(result.output, /GATE UNUSABLE/);
});

test('issue #24 gate: a capture with no harnessErrors list fails the gate', () => {
  const stale = capture();
  delete stale.harnessErrors;
  const result = runDiff(write('base-noharness.json', stale), write('after-noharness.json', capture()));
  assert.notEqual(result.status, 0, 'a capture that cannot say whether its files completed cannot anchor the comparison');
  assert.match(result.output, /GATE UNUSABLE/);
});

test('issue #24 gate: a capture whose harnessErrors is not an array fails the gate', () => {
  const result = runDiff(
    write('base-harnessobj.json', capture()),
    write('after-harnessobj.json', capture({ harnessErrors: { 'src/utils/B.test.ts': 'timed out' } })),
  );
  assert.notEqual(result.status, 0, 'a non-array harnessErrors field is not an error list');
  assert.match(result.output, /GATE UNUSABLE/);
});

// FND-102. A suite that stops registering tests exits 0 having run nothing.
// CLAUDE.md records this exact trap in this repository: a `node --test` process
// passes NODE_TEST_CONTEXT to its children, node's recursion guard then prints
// only `skipping running files` and exits 0 having executed nothing, and an
// assertion over that outcome "passes vacuously with stdout empty".
const SUMMARY_FIXTURE = [
  '✔ REL-BGSTAB-022 AC-5: EPERM on the destination rename is retried (17.044807ms)',
  '✔ REL-BGSTAB-022 AC-6: ENOSPC rejects on the first attempt (1.139562ms)',
  'ℹ tests 10',
  'ℹ suites 0',
  'ℹ pass 9',
  'ℹ fail 1',
  'ℹ cancelled 0',
  'ℹ skipped 0',
  'ℹ todo 0',
  'ℹ duration_ms 660.129503',
  '',
].join('\n');

test('issue #24 capture: the per-file summary counts are parsed out of node:test output', async () => {
  const { parseFileSummary } = await import('./store-and-utils-scoped-capture-failing.mjs');
  assert.deepEqual(parseFileSummary(SUMMARY_FIXTURE), { tests: 10, pass: 9, fail: 1 });
});

test('issue #24 capture: output with no summary at all parses as unknown, not as zero', async () => {
  const { parseFileSummary } = await import('./store-and-utils-scoped-capture-failing.mjs');
  // The NODE_TEST_CONTEXT recursion guard: nothing ran, stdout is empty, exit 0.
  assert.equal(parseFileSummary(''), null);
  assert.equal(parseFileSummary('skipping running files\n'), null);
});

test('issue #24 capture: a partial summary is unknown rather than a count of zero', async () => {
  const { parseFileSummary } = await import('./store-and-utils-scoped-capture-failing.mjs');
  assert.equal(parseFileSummary('ℹ pass 3\nℹ fail 0\n'), null, 'a missing tests line cannot be read as zero tests');
});

// FND-203. Reading each label independently with last-wins composes a record
// out of two different runs. Measured 2026-09-16: a complete block followed by
// a truncated one yielded {tests: 9, pass: 8, fail: 3} — a triple that belongs
// to neither run and whose pass+fail does not even reach its own tests count.
test('issue #24 capture: a truncated later summary does not borrow counts from an earlier one', async () => {
  const { parseFileSummary } = await import('./store-and-utils-scoped-capture-failing.mjs');
  const twoBlocks = [
    'ℹ tests 5',
    'ℹ pass 5',
    'ℹ fail 3',
    'ℹ duration_ms 12.5',
    '',
    '▶ a second run whose output was cut off',
    'ℹ tests 9',
    'ℹ pass 8',
    '',
  ].join('\n');
  assert.deepEqual(
    parseFileSummary(twoBlocks),
    { tests: 5, pass: 5, fail: 3 },
    'the last complete summary block is the only one that describes a whole run',
  );
});

test('issue #24 capture: output whose only summary block is truncated parses as unknown', async () => {
  const { parseFileSummary } = await import('./store-and-utils-scoped-capture-failing.mjs');
  assert.equal(
    parseFileSummary('▶ suite\nℹ tests 9\nℹ pass 8\n'),
    null,
    'no complete block means no run can be described',
  );
});

test('issue #24 gate: a file whose test count dropped fails the gate', () => {
  const result = runDiff(
    write('base-count-drop.json', capture({ perFileCounts: { [FILES[0]]: { tests: 10, pass: 10, fail: 0 }, [FILES[1]]: { tests: 4, pass: 4, fail: 0 } } })),
    write('after-count-drop.json', capture({ perFileCounts: { [FILES[0]]: { tests: 10, pass: 10, fail: 0 }, [FILES[1]]: { tests: 0, pass: 0, fail: 0 } } })),
  );
  assert.notEqual(result.status, 0, 'a file that registered fewer tests must not read as green');
  // FND-204. A count drop is a legitimate outcome of splitting a file or of
  // deliberately shrinking a parameterised set, so the refusal must state the
  // observation and not a conclusion about the suite, and must carry a banner
  // of its own rather than sharing the one for structurally broken captures.
  assert.match(result.output, /TEST COUNT DROPPED/);
  assert.doesNotMatch(result.output, /GATE UNUSABLE/, 'a legitimate count drop is not a broken capture');
  assert.match(result.output, new RegExp(`${FILES[1].replace(/[.]/g, '\\.')} ran 4 test\\(s\\) at baseline and 0 now`));
  assert.match(result.output, /can only see cases that ran/, 'the refusal must say why it blocks the comparison');
  assert.match(result.output, /if the drop is intentional/i, 'the refusal must name the operator\'s next step');
  assert.doesNotMatch(result.output, /stopped registering tests/, 'the tool cannot know why the count fell');
  assert.doesNotMatch(result.output, /no new failures/);
});

test('issue #24 gate: a file whose summary could not be parsed fails the gate', () => {
  const result = runDiff(
    write('base-count-null.json', capture({ perFileCounts: { [FILES[0]]: { tests: 10, pass: 10, fail: 0 }, [FILES[1]]: { tests: 4, pass: 4, fail: 0 } } })),
    write('after-count-null.json', capture({ perFileCounts: { [FILES[0]]: { tests: 10, pass: 10, fail: 0 }, [FILES[1]]: null } })),
  );
  assert.notEqual(result.status, 0, 'a file that printed no summary ran an unknown number of tests');
  assert.match(result.output, /GATE UNUSABLE/);
  assert.match(result.output, new RegExp(FILES[1].replace(/[.]/g, '\\.')));
});

test('issue #24 gate: a capture that carries counts but omits an enumerated file fails the gate', () => {
  const result = runDiff(
    write('base-count-missing.json', capture({ perFileCounts: { [FILES[0]]: { tests: 10, pass: 10, fail: 0 }, [FILES[1]]: { tests: 4, pass: 4, fail: 0 } } })),
    write('after-count-missing.json', capture({ perFileCounts: { [FILES[0]]: { tests: 10, pass: 10, fail: 0 } } })),
  );
  assert.notEqual(result.status, 0, 'a file with no recorded count is not a file with zero failures');
  assert.match(result.output, /GATE UNUSABLE/);
});

test('issue #24 gate: a test count that legitimately rose is accepted', () => {
  // TDD adds cases to an existing file. That is the normal direction and must
  // not make the gate unusable.
  const result = runDiff(
    write('base-count-rise.json', capture({ perFileCounts: { [FILES[0]]: { tests: 10, pass: 10, fail: 0 }, [FILES[1]]: { tests: 4, pass: 4, fail: 0 } } })),
    write('after-count-rise.json', capture({ perFileCounts: { [FILES[0]]: { tests: 13, pass: 13, fail: 0 }, [FILES[1]]: { tests: 4, pass: 4, fail: 0 } } })),
  );
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /no new failures/);
  // FND-205. The count dimension was live on both sides, so the run must not
  // claim it went unchecked — that banner is what tells an operator the
  // comparison covered failing names only.
  assert.doesNotMatch(
    result.output,
    /UNVERIFIED DIMENSION/,
    'both captures carried per-file counts, so no dimension went unverified',
  );
});

test('issue #24 gate: a file new in the after run has no baseline count to compare and is accepted', () => {
  const result = runDiff(
    write('base-count-new.json', capture({ perFileCounts: { [FILES[0]]: { tests: 10, pass: 10, fail: 0 }, [FILES[1]]: { tests: 4, pass: 4, fail: 0 } } })),
    write('after-count-new.json', capture({
      files: 3,
      fileList: [...FILES, 'src/utils/NEW.test.ts'],
      perFileCounts: {
        [FILES[0]]: { tests: 10, pass: 10, fail: 0 },
        [FILES[1]]: { tests: 4, pass: 4, fail: 0 },
        'src/utils/NEW.test.ts': { tests: 2, pass: 2, fail: 0 },
      },
    })),
  );
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /no new failures/);
});

test('issue #24 gate: a capture predating per-file counts is accepted but reports the dimension as unverified', () => {
  // The two captures already recorded under docs/analysis/ have no per-file
  // counts. Refusing them outright would invalidate evidence that cannot be
  // re-taken against the pre-change tree; accepting them without saying so
  // would reopen the hole. So they are compared on names and the output states
  // that the count dimension was not checked.
  const result = runDiff(write('base-legacy.json', capture()), write('after-legacy.json', capture()));
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /no new failures/);
  assert.match(result.output, /UNVERIFIED DIMENSION/);
  assert.match(result.output, /per-file test counts/);
});
