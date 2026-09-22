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
