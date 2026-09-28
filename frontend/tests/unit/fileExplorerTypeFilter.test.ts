import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyTypeFilterKey, filterTreeRows, matchRange } from '../../src/components/fileExplorer/fileExplorerTypeFilter.ts';
import type { VisibleRow } from '../../src/components/fileExplorer/fileTreeState.ts';

// FR-FEX-014 — type-to-filter over what is already on screen.

const key = (k: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, ...mods });

test('FR-FEX-014 AC-1 printable keys without Ctrl/Cmd/Alt append; modified keys are left alone', () => {
  assert.deepEqual(applyTypeFilterKey('', key('s')), { text: 's', handled: true });
  assert.deepEqual(applyTypeFilterKey('s', key('e')), { text: 'se', handled: true });
  assert.equal(applyTypeFilterKey('', key('c', { ctrlKey: true })).handled, false);
  assert.equal(applyTypeFilterKey('', key('v', { metaKey: true })).handled, false);
  assert.equal(applyTypeFilterKey('', key('x', { altKey: true })).handled, false);
});

test('FR-FEX-014 AC-4 Backspace edits and Esc clears; with no filter they are not taken', () => {
  assert.deepEqual(applyTypeFilterKey('ser', key('Backspace')), { text: 'se', handled: true });
  assert.deepEqual(applyTypeFilterKey('ser', key('Escape')), { text: '', handled: true });
  assert.equal(applyTypeFilterKey('', key('Backspace')).handled, false);
  assert.equal(applyTypeFilterKey('', key('Escape')).handled, false);
});

test('FR-FEX-014 AC-5 existing shortcut keys are not captured', () => {
  for (const k of ['Delete', 'F2', 'Enter', 'ArrowDown', 'Tab']) assert.equal(applyTypeFilterKey('', key(k)).handled, false, k);
  assert.equal(applyTypeFilterKey('', key(' ')).handled, false, 'a leading space does not start a filter');
});

test('FR-FEX-014 AC-2 matching is case-insensitive and returns the matched range', () => {
  assert.deepEqual(matchRange('serverApi.ts', 'API'), [6, 9]);
  assert.equal(matchRange('App.tsx', 'zz'), null);
  assert.deepEqual(matchRange('anything', ''), null);
});

test('FR-FEX-014 AC-3 tree mode keeps matching rows and their visible ancestors, and drops the up row', () => {
  const rows: VisibleRow[] = [
    { kind: 'up' },
    { kind: 'node', path: '/r/src', name: 'src', type: 'directory', depth: 0 },
    { kind: 'node', path: '/r/src/app.ts', name: 'app.ts', type: 'file', depth: 1 },
    { kind: 'node', path: '/r/src/util.ts', name: 'util.ts', type: 'file', depth: 1 },
    { kind: 'node', path: '/r/docs', name: 'docs', type: 'directory', depth: 0 },
  ];
  const shown = filterTreeRows(rows, 'app');
  assert.deepEqual(shown.map((r) => (r.kind === 'node' ? r.name : '..')), ['src', 'app.ts']);
  assert.deepEqual(filterTreeRows(rows, ''), rows, 'no filter, no change');
});

test('FR-FEX-014 AC-3 a deep match keeps every enclosing row, and only those', () => {
  const rows: VisibleRow[] = [
    { kind: 'node', path: '/r/a', name: 'a', type: 'directory', depth: 0 },
    { kind: 'node', path: '/r/a/b', name: 'b', type: 'directory', depth: 1 },
    { kind: 'node', path: '/r/a/b/hit.ts', name: 'hit.ts', type: 'file', depth: 2 },
    { kind: 'node', path: '/r/a/z', name: 'z', type: 'directory', depth: 1 },
    { kind: 'node', path: '/r/q', name: 'q', type: 'file', depth: 0 },
  ];
  assert.deepEqual(filterTreeRows(rows, 'hit').map((r) => (r.kind === 'node' ? r.name : '')), ['a', 'b', 'hit.ts']);
});
