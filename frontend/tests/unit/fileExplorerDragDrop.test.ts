import './i18nTestSetup.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  INTERNAL_DRAG_TYPE,
  buildDropJobRequest,
  decideDragOperation,
  decideDragSources,
  decideInternalDrop,
  isInternalDrag,
  resolveInternalDropDir,
} from '../../src/components/fileExplorer/fileExplorerDragModel.ts';

// FR-FEX-030 (#154): dragging explorer entries onto a folder moves them, or copies with
// Ctrl (Option on macOS), through the same job request paste builds.

test('FR-FEX-030 AC-1: a selected row carries the selection, an unselected row only itself', () => {
  const selected = new Set(['/p/a', '/p/b']);
  assert.deepEqual(decideDragSources(selected, '/p/b'), { paths: ['/p/a', '/p/b'], reselect: false });
  assert.deepEqual(decideDragSources(selected, '/p/c'), { paths: ['/p/c'], reselect: true });
  assert.deepEqual(decideDragSources(new Set(), '/p/a'), { paths: ['/p/a'], reselect: true });
});

test('FR-FEX-030 AC-2: Ctrl copies elsewhere, Option copies on macOS, otherwise move', () => {
  assert.equal(decideDragOperation({ ctrlKey: false, altKey: false, metaKey: false }, false), 'move');
  assert.equal(decideDragOperation({ ctrlKey: true, altKey: false, metaKey: false }, false), 'copy');
  assert.equal(decideDragOperation({ ctrlKey: false, altKey: true, metaKey: false }, false), 'move');
  assert.equal(decideDragOperation({ ctrlKey: false, altKey: true, metaKey: false }, true), 'copy');
  assert.equal(decideDragOperation({ ctrlKey: true, altKey: false, metaKey: false }, true), 'move');
});

// FR-FEX-033 AC-1 supersedes the file-row refusal: a file row takes the drop for its folder
// (fileExplorerDropOnFile.test.ts).
test('FR-FEX-030 AC-3: folder rows and empty space accept', () => {
  assert.equal(resolveInternalDropDir({ row: { path: '/p/dir', isDir: true }, shownFolder: '/p' }), '/p/dir');
  assert.equal(resolveInternalDropDir({ row: null, shownFolder: '/p' }), '/p');
});

test('FR-FEX-030 AC-3: itself, inside itself and its own folder are refused', () => {
  const drag = { sessionId: 's1', paths: ['/p/src', '/p/a.txt'] };
  assert.deepEqual(decideInternalDrop(drag, { sessionId: 's1', dir: '/p/src' }), { allowed: false, reason: 'self' });
  assert.deepEqual(decideInternalDrop(drag, { sessionId: 's1', dir: '/p/src/lib' }), { allowed: false, reason: 'inside' });
  assert.deepEqual(decideInternalDrop(drag, { sessionId: 's1', dir: '/p' }), { allowed: false, reason: 'same-folder' });
  assert.deepEqual(decideInternalDrop(drag, { sessionId: 's1', dir: '/p/docs' }), { allowed: true });
  // Windows separators are judged the same way.
  assert.deepEqual(decideInternalDrop({ sessionId: 's1', paths: ['C:\\p\\src'] }, { sessionId: 's1', dir: 'C:\\p\\src\\x' }), { allowed: false, reason: 'inside' });
  // '/p/srcx' is not inside '/p/src'.
  assert.deepEqual(decideInternalDrop({ sessionId: 's1', paths: ['/p/src'] }, { sessionId: 's1', dir: '/p/srcx' }), { allowed: true });
  // Another session's folder is another tree.
  assert.deepEqual(decideInternalDrop(drag, { sessionId: 's2', dir: '/p' }), { allowed: true });
});

test('FR-FEX-030 AC-2: the job is the request paste would build', () => {
  const drag = { sessionId: 's1', paths: ['/p/a.txt', '/p/b.txt'] };
  assert.deepEqual(buildDropJobRequest(drag, { sessionId: 's1', dir: '/p/docs' }, 'move'), {
    operation: 'move', sourceSessionId: 's1', sources: ['/p/a.txt', '/p/b.txt'], destSessionId: 's1', destPath: '/p/docs',
  });
  assert.equal(buildDropJobRequest(drag, { sessionId: 's1', dir: '/p/docs' }, 'copy')?.operation, 'copy');
  assert.equal(buildDropJobRequest({ sessionId: 's1', paths: ['/p/src'] }, { sessionId: 's1', dir: '/p/src/x' }, 'move'), null);
});

test('FR-FEX-030 AC-5: an operating-system file drag is not an internal one', () => {
  assert.equal(isInternalDrag([INTERNAL_DRAG_TYPE]), true);
  assert.equal(isInternalDrag(['Files']), false);
  assert.equal(isInternalDrag(['Files', INTERNAL_DRAG_TYPE]), false);
  assert.equal(isInternalDrag(null), false);
});

test('FR-FEX-030: the explorer wires drag start, drop and the touch guard', () => {
  const win = readFileSync(new URL('../../src/components/fileExplorer/FileExplorerWindow.tsx', import.meta.url), 'utf8');
  assert.match(win, /onDragStart=\{handleRowDragStart\}/);
  assert.match(win, /buildDropJobRequest\(/);
  assert.match(win, /pointer: coarse/);
  for (const view of ['FileListView.tsx', 'FileTreeView.tsx']) {
    const source = readFileSync(new URL(`../../src/components/fileExplorer/${view}`, import.meta.url), 'utf8');
    assert.match(source, /draggable=\{rowsDraggable\}/, view);
  }
});
