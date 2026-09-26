#!/usr/bin/env node
// Compares two captures. Acceptance for issue #24's regression gate is set
// equality, not an exit code: a run that fails only for the known Linux/WSL2
// baseline reasons and a run that additionally fails because a store broke both
// exit non-zero, so an exit code cannot tell them apart.
//
// Set equality over failing names is necessary but not sufficient. A file that
// never ran contributes no failure names, so a change that deadlocks a suite
// would otherwise read as "no new failures". Before comparing names this
// therefore requires that both captures ran every file they enumerated, that
// they enumerated the same files, and that no file registered fewer tests than
// it did in the baseline — a suite that stops registering tests exits 0 and is
// otherwise invisible here.
import fs from 'node:fs';

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
}
const baselinePath = arg('--baseline');
const afterPath = arg('--after');
if (!baselinePath || !afterPath) {
  console.error('usage: store-and-utils-scoped-regression-diff.mjs --baseline <json> --after <json>');
  process.exit(2);
}

const read = p => JSON.parse(fs.readFileSync(p, 'utf-8'));
const baseline = read(baselinePath);
const after = read(afterPath);

const problems = [];
// Kept apart from `problems` on purpose. A capture that cannot say which files
// it ran is broken; a file whose test count fell is a legitimate thing to do
// deliberately — splitting a file in two, or shrinking a parameterised set —
// that this tool cannot distinguish from a suite losing cases. Both block the
// comparison, but sharing one banner would tell an operator the wrong thing
// about what they are looking at.
const countDrops = [];

// A capture predating the per-file counts is recognised by the absence of the
// whole `perFileCounts` key, and only then. The two captures already recorded
// under docs/analysis/ were taken before the field existed and cannot be
// re-taken against the pre-change tree, so refusing them outright would destroy
// evidence rather than protect it. They are therefore still compared on failing
// names, but the run announces UNVERIFIED DIMENSION and names what it could not
// check — the alternative, accepting them in silence, would let a vacuous suite
// read as green with nothing in the output to say so. A capture that does carry
// the key gets no leniency at all: every file it enumerated must have a parsed
// count, or the gate is unusable.
const legacyCaptures = [];

for (const [label, capture] of [['baseline', baseline], ['after', after]]) {
  for (const field of ['failing', 'harnessErrors']) {
    // `new Set(capture.failing ?? [])` reads a missing field as zero failures,
    // which is indistinguishable from a clean run. The same silence applies to
    // harnessErrors, whose whole job is to report the files that did not run.
    if (!Array.isArray(capture[field])) {
      problems.push(
        `${label}: recorded no ${field} array (got ${capture[field] === undefined ? 'nothing' : JSON.stringify(capture[field])}), so it cannot be compared; re-capture with the current tools/store-and-utils-scoped-capture-failing.mjs`,
      );
    }
  }
  const harnessErrors = Array.isArray(capture.harnessErrors) ? capture.harnessErrors : [];
  if (harnessErrors.length) {
    problems.push(
      `${label}: ${harnessErrors.length} file(s) did not run to completion, so their failures are unknown:\n    ` +
      harnessErrors.join('\n    '),
    );
  }
  if (!Array.isArray(capture.fileList)) {
    problems.push(
      `${label}: recorded no fileList, so there is no way to tell which files it ran; re-capture with the current tools/store-and-utils-scoped-capture-failing.mjs`,
    );
  }
  if (capture.perFileCounts === undefined) {
    legacyCaptures.push(label);
  } else if (capture.perFileCounts === null || typeof capture.perFileCounts !== 'object' || Array.isArray(capture.perFileCounts)) {
    problems.push(`${label}: perFileCounts is present but is not an object of per-file counts`);
  } else if (Array.isArray(capture.fileList)) {
    const missing = capture.fileList.filter(f => !(f in capture.perFileCounts)).sort();
    const unparsed = capture.fileList.filter(f => capture.perFileCounts[f] === null
      || typeof capture.perFileCounts[f]?.tests !== 'number').sort();
    if (missing.length) {
      problems.push(
        `${label}: ${missing.length} enumerated file(s) have no recorded test count, so whether they ran anything is unknown:\n    ` +
        missing.join('\n    '),
      );
    }
    if (unparsed.length) {
      // node:test prints no summary when its recursion guard skips the run:
      // nothing executed, stdout empty, exit 0. That must never read as green.
      problems.push(
        `${label}: ${unparsed.length} file(s) printed no parseable node:test summary, so they may have registered no tests at all:\n    ` +
        unparsed.join('\n    '),
      );
    }
  }
}

if (legacyCaptures.length) {
  console.log(
    `UNVERIFIED DIMENSION: ${legacyCaptures.join(' and ')} capture(s) predate per-file test counts, ` +
    'so this comparison covers failing test names only. A suite that stopped registering tests ' +
    'would not be detected; re-capture both sides with the current tools/store-and-utils-scoped-capture-failing.mjs to cover it.',
  );
} else if (Array.isArray(baseline.fileList)) {
  // Both sides carry counts, so the count dimension is live. A file the after
  // run shares with the baseline must not have registered fewer tests than it
  // did before: whatever the reason, cases the baseline measured did not run,
  // and any failure among them is absent from the name comparison rather than
  // fixed by it. A count that rose is the normal TDD direction and is accepted.
  // A file that is new in the after run
  // has no baseline count to compare against, so there is nothing to check
  // beyond its summary having parsed at all, which the loop above already did.
  const dropped = baseline.fileList
    .filter(f => typeof baseline.perFileCounts?.[f]?.tests === 'number'
      && typeof after.perFileCounts?.[f]?.tests === 'number'
      && after.perFileCounts[f].tests < baseline.perFileCounts[f].tests)
    .map(f => `${f} ran ${baseline.perFileCounts[f].tests} test(s) at baseline and ${after.perFileCounts[f].tests} now`)
    .sort();
  countDrops.push(...dropped);
}

if (Array.isArray(baseline.fileList) && Array.isArray(after.fileList)) {
  const beforeFiles = new Set(baseline.fileList);
  const afterFiles = new Set(after.fileList);
  // The after side must cover every file the baseline ran. It may cover more:
  // a change that adds a test file is the normal case here and must not make
  // the gate unusable, or no TDD change could ever be measured by it. A file
  // that the baseline ran and the after run did not is the dangerous direction
  // — that is a suite which stopped running, and its failures would silently
  // drop out of the comparison.
  const onlyBaseline = [...beforeFiles].filter(f => !afterFiles.has(f)).sort();
  const onlyAfter = [...afterFiles].filter(f => !beforeFiles.has(f)).sort();
  if (onlyBaseline.length) {
    problems.push(
      `the after run did not enumerate ${onlyBaseline.length} file(s) the baseline ran, so failures in them would drop out of the comparison:\n    ` +
      onlyBaseline.join('\n    '),
    );
  }
  if (onlyAfter.length) {
    console.log(`files added since the baseline (${onlyAfter.length}, not a problem): ${onlyAfter.join(', ')}`);
  }
}

const before = new Set(Array.isArray(baseline.failing) ? baseline.failing : []);
const now = new Set(Array.isArray(after.failing) ? after.failing : []);
const added = [...now].filter(n => !before.has(n)).sort();
const fixed = [...before].filter(n => !now.has(n)).sort();

console.log(`baseline files:   ${baseline.fileList?.length ?? baseline.files ?? 'unknown'}`);
console.log(`after files:      ${after.fileList?.length ?? after.files ?? 'unknown'}`);
console.log(`baseline failing: ${before.size}`);
console.log(`after failing:    ${now.size}`);
if (fixed.length) console.log(`no longer failing (${fixed.length}):\n  ${fixed.join('\n  ')}`);

if (problems.length) {
  console.log(`GATE UNUSABLE (${problems.length}):\n  ${problems.join('\n  ')}`);
}
if (countDrops.length) {
  // States the observation and nothing beyond it: this tool sees two numbers
  // and cannot know whether the file was split, the set deliberately shrunk, or
  // the suite silently lost cases.
  console.log(
    `TEST COUNT DROPPED (${countDrops.length}):\n  ${countDrops.join('\n  ')}\n` +
    '  This blocks the comparison because the diff can only see cases that ran: a case that did not\n' +
    '  run contributes no failure line, so its failure is absent from the diff rather than fixed by it.\n' +
    '  If the drop is intentional (a file was split, or a parameterised set was deliberately reduced),\n' +
    '  re-take the baseline against a tree that already contains that change and re-run this gate, so\n' +
    '  both sides enumerate the same cases.',
  );
}
if (added.length) {
  console.log(`NEW FAILURES (${added.length}):\n  ${added.join('\n  ')}`);
}
if (problems.length || countDrops.length || added.length) {
  process.exit(1);
}
console.log('no new failures');
