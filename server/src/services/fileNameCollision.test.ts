import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveNameCollision } from './fileNameCollision.js';

/**
 * FR-FOP-004 AC-1 and AC-2 — what a copy is called when the name is taken.
 *
 * The rule is `name (2).ext`, counting up while the candidate is also taken.
 * Two is the first suffix because the original is the first.
 *
 * The function never touches the filesystem. It is handed a predicate and asks
 * it; the job that owns the real directory owns the predicate. That is what
 * makes the exhausted-suffix and double-extension cases testable at all.
 */

/** A predicate over a fixed set, in place of a directory. */
const taken = (...names: string[]) => (candidate: string) => names.includes(candidate);

test('FR-FOP-004 AC-1 a taken file name gains (2), and the number climbs while that is taken too', () => {
  assert.equal(resolveNameCollision('report.md', taken('report.md')), 'report (2).md');

  assert.equal(
    resolveNameCollision('report.md', taken('report.md', 'report (2).md')),
    'report (3).md',
  );

  assert.equal(
    resolveNameCollision('report.md', taken('report.md', 'report (2).md', 'report (3).md')),
    'report (4).md',
  );
});

test('FR-FOP-004 AC-1 a free name is returned unchanged', () => {
  // The control. Without it a function that always appended (2) would pass
  // every other case here.
  assert.equal(resolveNameCollision('report.md', taken()), 'report.md');
  assert.equal(resolveNameCollision('report.md', taken('other.md')), 'report.md');
});

test('FR-FOP-004 AC-1 the suffix goes before the extension, not after the whole name', () => {
  // `report.md (2)` would open in nothing. The extension has to stay last.
  const result = resolveNameCollision('report.md', taken('report.md'));

  assert.ok(result.endsWith('.md'), `extension moved: ${result}`);
  assert.ok(!result.endsWith(')'), `suffix landed after the extension: ${result}`);
});

test('FR-FOP-004 AC-1 a dotfile keeps its leading dot and takes the suffix at the end', () => {
  // `.gitignore` is one name, not an empty name with a `.gitignore` extension.
  assert.equal(resolveNameCollision('.gitignore', taken('.gitignore')), '.gitignore (2)');
});

test('FR-FOP-004 AC-1 only the last extension is treated as the extension', () => {
  // A decided behaviour rather than an obvious one: `path.extname` reads
  // `.gz`, so the rest stays with the name. Pinned here so a later change to
  // `archive (2).tar.gz` is a choice somebody makes rather than a drift.
  assert.equal(
    resolveNameCollision('archive.tar.gz', taken('archive.tar.gz')),
    'archive.tar (2).gz',
  );
});

test('FR-FOP-004 AC-2 a directory has no extension, so the suffix ends the name', () => {
  assert.equal(resolveNameCollision('reports', taken('reports')), 'reports (2)');
  assert.equal(
    resolveNameCollision('reports', taken('reports', 'reports (2)')),
    'reports (3)',
  );
});

test('FR-FOP-004 AC-1 a name that already ends in a suffix counts on from there', () => {
  // `report (2).md` copied into a directory that holds it must not become
  // `report (2) (2).md`.
  assert.equal(
    resolveNameCollision('report (2).md', taken('report (2).md')),
    'report (3).md',
  );
});

/**
 * Wraps a predicate so a loop that cannot end fails instead of hanging.
 *
 * `resolveNameCollision` is synchronous, so a loop that never leaves blocks the
 * event loop and node:test's own timeout never fires — the run would sit there
 * until something outside killed it, which reads as infrastructure trouble
 * rather than as the defect it is. The budget sits above the function's own
 * attempt cap so a run that legitimately reaches that cap still gets to throw
 * its own error rather than this one.
 */
const PROBE_BUDGET = 20_000;
const budgeted = (isTaken: (candidate: string) => boolean) => {
  let probes = 0;
  return (candidate: string) => {
    probes += 1;
    if (probes > PROBE_BUDGET) {
      // Named, so that an assertion naming an error type can never be
      // satisfied by this one. The budget message carries the candidate it
      // stopped on, and a candidate is exactly what a test about a stuck
      // counter would otherwise look for.
      const exhausted = new Error(
        `asked about ${probes} names without settling; the last was "${candidate}"`,
      );
      exhausted.name = 'ProbeBudgetExceeded';
      throw exhausted;
    }
    return isTaken(candidate);
  };
};

test('FR-FOP-004 AC-1 a carried number it could not count past stays in the name', () => {
  // 2^53-1 is the last integer this language can add one to. Carried, the
  // counter would stall there: every later candidate reads the same as the one
  // before it, the predicate answers the same, and the loop never leaves.
  const directory = new Set(['r (9007199254740991).md', 'r (9007199254740992).md']);

  assert.equal(
    resolveNameCollision('r (9007199254740991).md', budgeted(c => directory.has(c))),
    'r (9007199254740991) (2).md',
  );
});

test('FR-FOP-004 AC-1 counting stops rather than repeating a name it cannot leave behind', () => {
  // Reached from below: the first candidate is legal, and the increment after
  // it is the one that stalls. Saying so is better than handing back a name
  // that is about to be produced again.
  //
  // What is asserted is the error, not a number in it. Matching /9007199254740991/
  // alone read as a strong pin and was not one: the cheapest thing satisfying it
  // is any error mentioning that number, and the probe budget above throws
  // exactly that — its message carries the candidate the counter stalled on,
  // which here is `r (9007199254740991).md`. Measured 2026-09-23 by reverting
  // all three guards (the in-loop isSafeInteger check, a saturating increment,
  // MAX_ATTEMPTS at Infinity): on a genuine endless spin the old assertion
  // passed. It was red only because MAX_ATTEMPTS fired first and its message
  // happens not to carry that number — raising the cap would have made this
  // test measure nothing, silently.
  const directory = new Set(['r (9007199254740990).md', 'r (9007199254740991).md']);

  assert.throws(
    () => resolveNameCollision('r (9007199254740990).md', budgeted(c => directory.has(c))),
    {
      name: 'RangeError',
      message: /counting past 9007199254740991 would name .* the same way twice/,
    },
  );
});

test('FR-FOP-004 AC-1 a number that does not survive the round trip stays in the name', () => {
  // Number('1000000000000000000000') prints back as 1e+21, so counting from it
  // would name the copy `r (1e+21).md` — which is not a number anybody wrote.
  const name = 'r (1000000000000000000000).md';

  assert.equal(
    resolveNameCollision(name, budgeted(taken(name))),
    'r (1000000000000000000000) (2).md',
  );
});

test('FR-FOP-004 AC-1 the suffix never counts below two', () => {
  // (1) is the original's own place. A copy that took it would announce itself
  // as the first of the pair.
  assert.equal(
    resolveNameCollision('report (0).md', taken('report (0).md')),
    'report (0) (2).md',
  );
  assert.equal(
    resolveNameCollision('report (1).md', taken('report (1).md')),
    'report (1) (2).md',
  );
});

test('FR-FOP-004 AC-1 a zero-padded number belongs to the name, not to us', () => {
  // We never write a leading zero, so `(007)` is somebody's own naming.
  // Counting from it returns `report (8).md` and loses the padding the name
  // was chosen for.
  assert.equal(
    resolveNameCollision('report (007).md', taken('report (007).md')),
    'report (007) (2).md',
  );
});

test('FR-FOP-004 AC-1 a directory that is taken all the way down throws instead of spinning', () => {
  // The caller's bug, not ours — but a synchronous loop that never leaves
  // takes the whole process with it, not one request.
  assert.throws(
    () => resolveNameCollision('report.md', budgeted(() => true)),
    /10000 attempts/,
  );
});

test('FR-FOP-004 AC-1 a path is refused, because this names one segment', () => {
  // Splitting a path here dropped the directory: the same argument came back
  // as a whole path when the name was free and as a bare name when it was
  // taken. One argument, two shapes, decided by the predicate.
  assert.throws(
    () => resolveNameCollision('sub/report.md', taken('sub/report.md')),
    /single path segment/,
  );

  // Refused before the predicate is consulted, so a free name is refused too —
  // otherwise the shape still depends on the answer.
  assert.throws(
    () => resolveNameCollision('sub\\report.md', taken()),
    /single path segment/,
  );
});

test('FR-FOP-004 AC-1 a colon is an ordinary character in a name', () => {
  // `node:path` resolves to path.win32 on Windows, where `c:` reads as a drive
  // root and the stem loses it. The rule has to read the same on both.
  assert.equal(
    resolveNameCollision('c:report.md', taken('c:report.md')),
    'c:report (2).md',
  );
});
