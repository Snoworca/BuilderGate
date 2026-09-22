import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { selectRestorableDocuments } from '../../src/hooks/editorRestoreAdmission.ts';

// FR-MDE-009 AC-13 — a document the user closed is not brought back by a
// reopen that lands afterwards.
//
// Measured in a browser on 2026-09-22 with the file read delayed to 5s: the
// reopen's reads were still in flight, the user opened CLAUDE.md by hand into
// the empty screen, closed it, and the reopen then put it back. The reopen
// compares its results against whatever happens to be open at the moment it
// lands, and at that moment a document the user closed on purpose looks
// exactly like one that was never opened.
//
//   3 closed it:                     []                        windows=0
//   4 after the reads land:          ["AGENTS.md","CLAUDE.md"] windows=1
//
// AGENTS.md there is the reopen doing its job late. CLAUDE.md is the defect.

const D = (filePath: string) => ({ filePath, tabId: 't1' });

test('FR-MDE-009 AC-13 a document closed during the reopen is not put back', () => {
  const added = selectRestorableDocuments({
    restored: [D('/repo/CLAUDE.md'), D('/repo/AGENTS.md')],
    alreadyOpen: [],
    closedByUser: ['/repo/CLAUDE.md'],
  });

  assert.deepEqual(added.map(document => document.filePath), ['/repo/AGENTS.md']);
});

test('FR-MDE-009 AC-13 closing one document does not suppress the rest of the reopen', () => {
  // The control that matters most: the cheapest way to pass the test above is
  // to stop reopening anything once the user has closed something.
  const added = selectRestorableDocuments({
    restored: [D('/repo/a.md'), D('/repo/b.md'), D('/repo/c.md')],
    alreadyOpen: [],
    closedByUser: ['/repo/b.md'],
  });

  assert.deepEqual(added.map(document => document.filePath), ['/repo/a.md', '/repo/c.md']);
});

test('FR-MDE-009 AC-3/AC-4 an untouched reopen still adds everything, in order', () => {
  const added = selectRestorableDocuments({
    restored: [D('/repo/a.md'), D('/repo/b.md'), D('/repo/c.md')],
    alreadyOpen: [],
    closedByUser: [],
  });

  assert.deepEqual(added.map(document => document.filePath), ['/repo/a.md', '/repo/b.md', '/repo/c.md']);
});

test('FR-MDE-009 a document already open is not added a second time', () => {
  // Pre-existing behaviour, kept as a case so the new filter cannot be built
  // by replacing the old one.
  const added = selectRestorableDocuments({
    restored: [D('/repo/a.md'), D('/repo/b.md')],
    alreadyOpen: ['/repo/a.md'],
    closedByUser: [],
  });

  assert.deepEqual(added.map(document => document.filePath), ['/repo/b.md']);
});

test('FR-MDE-009 AC-13 a path both closed and open again is admitted', () => {
  // Reopening by hand after closing is a new decision and rescinds the old
  // one. Here the reopen has nothing to add for it anyway, and the point is
  // that the two lists do not have to be kept consistent by the caller for
  // this to answer sensibly.
  const added = selectRestorableDocuments({
    restored: [D('/repo/a.md')],
    alreadyOpen: ['/repo/a.md'],
    closedByUser: ['/repo/a.md'],
  });

  assert.deepEqual(added, []);
});

function code(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(line => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');
}

test('FR-MDE-009 AC-13 the hook records closes and the reopen consults them', () => {
  // The pure function above cannot be wrong on its own; it can only be unused.
  // These three are what tie it to the defect that was measured.
  const hook = code('../../src/hooks/useEditorWindows.ts');

  assert.match(hook, /selectRestorableDocuments\(/, 'the reopen must go through the admission');
  assert.match(
    hook,
    /closedByUserRef\.current\.add\(filePath\)/,
    'closing a document must be recorded, or the admission has nothing to read',
  );
  assert.match(
    hook,
    /closedByUserRef\.current\.delete\(filePath\)/,
    'opening a path by hand must rescind an earlier close, or that path could never be reopened again',
  );
});
