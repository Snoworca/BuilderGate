// FR-FEX-033: a file row takes a drop for the folder that holds it, and a drop shows that its job
// is running from the moment it is dropped until the job is over.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { decideInternalDrop, isDropPending, resolveInternalDropDir } from '../../src/components/fileExplorer/fileExplorerDragModel.ts';
import { rowsCss } from '../../src/components/fileExplorer/fileExplorerPickUp.ts';

const windowSource = readFileSync(new URL('../../src/components/fileExplorer/FileExplorerWindow.tsx', import.meta.url), 'utf8');
const opsSource = readFileSync(new URL('../../src/hooks/useFileTreeOperations.ts', import.meta.url), 'utf8');

// @req FR-FEX-033
test('FR-FEX-033 AC-1: a file row is its folder -- the shown folder in the list, the parent in the tree', () => {
  assert.equal(resolveInternalDropDir({ row: { path: '/r/a.txt', isDir: false }, shownFolder: '/r' }), '/r');
  assert.equal(resolveInternalDropDir({ row: { path: '/r/sub/b.txt', isDir: false }, shownFolder: '/r' }), '/r/sub');
  assert.equal(resolveInternalDropDir({ row: { path: 'C:\\r\\sub\\b.txt', isDir: false }, shownFolder: 'C:\\r' }), 'C:\\r\\sub');
  assert.equal(resolveInternalDropDir({ row: { path: 'C:\\b.txt', isDir: false }, shownFolder: 'C:\\' }), 'C:\\');
  assert.equal(resolveInternalDropDir({ row: { path: '/b.txt', isDir: false }, shownFolder: '/' }), '/');
});

// @req FR-FEX-033
test('FR-FEX-033 AC-1: a file beside the carried entries refuses as their own folder; a root file takes a nested one', () => {
  const drag = { sessionId: 's', paths: ['/r/sub/a.txt'] };
  const sibling = resolveInternalDropDir({ row: { path: '/r/sub/b.txt', isDir: false }, shownFolder: '/r' })!;
  assert.deepEqual(decideInternalDrop(drag, { sessionId: 's', dir: sibling }), { allowed: false, reason: 'same-folder' });
  const rootFile = resolveInternalDropDir({ row: { path: '/r/top.txt', isDir: false }, shownFolder: '/r' })!;
  assert.deepEqual(decideInternalDrop(drag, { sessionId: 's', dir: rootFile }), { allowed: true });
});

// @req FR-FEX-033
test('FR-FEX-033 AC-2/AC-3: a drop is pending while its POST is out and while its job runs', () => {
  assert.equal(isDropPending({ jobId: null }, {}), true, 'the request has not answered yet');
  assert.equal(isDropPending({ jobId: 'j1' }, { j1: {} }), true, 'the job runs');
  assert.equal(isDropPending({ jobId: 'j1' }, {}), false, 'the job is over');
  assert.equal(isDropPending(null, { j1: {} }), false);
});

// @req FR-FEX-033
test('FR-FEX-033 AC-2: the dropped rows are dimmed by a scoped rule', () => {
  const css = rowsCss(['/r/a.txt'], (v) => v, '.fx-scroll[data-fx-tab="t"]', 'opacity: 0.45;');
  assert.match(css, /^\.fx-scroll\[data-fx-tab="t"\] \[data-path="\/r\/a\.txt"\]/);
  assert.match(css, /\{ opacity: 0\.45; \}$/);
});

// @req FR-FEX-033
test('FR-FEX-033 AC-2/AC-3: the window keeps a pending drop from the drop until the job is gone', () => {
  const drop = windowSource.slice(windowSource.indexOf('const dropInternal ='), windowSource.indexOf('/** FR-FEX-030 AC-1: what a press'));
  assert.match(drop, /setDropPending\(\{ seq, paths: internal\.paths, operation, jobId: null \}\)/);
  assert.match(drop, /ops\.submitDrop\(request\)/);
  // A late answer for an earlier drop must not touch a later one.
  assert.match(drop, /current\?\.seq === seq/);
  assert.match(windowSource, /isDropPending\(dropPending, fileJobs\.jobs\)/);
  assert.match(windowSource, /<FileExplorerDropPending /);
  assert.match(opsSource, /const submitDrop = \(request: PasteJobRequest\): Promise<string \| null> =>/);
});
