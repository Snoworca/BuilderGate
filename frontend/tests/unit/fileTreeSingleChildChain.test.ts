import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFileTreeController } from '../../src/components/fileExplorer/fileTreeController.ts';
import { createInitialFileTreeState, fileTreeReducer, selectVisibleRows, type FileTreeAction, type FileTreeMode } from '../../src/components/fileExplorer/fileTreeState.ts';
import type { DirectoryEntry, DirectoryListing } from '../../src/types/index.ts';

// FR-FEX-015 — a directory whose only child is a directory opens all the way down.

const M = '2026-09-01T00:00:00.000Z';
const d = (name: string): DirectoryEntry => ({ name, type: 'directory', size: 0, modified: M });
const f = (name: string): DirectoryEntry => ({ name, type: 'file', size: 1, modified: M });

function harness(fs: Record<string, DirectoryEntry[] | 'fail'>, mode: FileTreeMode) {
  let state = createInitialFileTreeState({ root: '/r', mode });
  const listed: string[] = [];
  const controller = createFileTreeController({
    sessionId: 's',
    listDirectory: async (_s, path) => {
      const key = path ?? '/r';
      listed.push(key);
      const entries = fs[key];
      if (entries === undefined || entries === 'fail') throw new Error(`no ${key}`);
      const listing: DirectoryListing = { cwd: '/r', path: key, entries: [d('..'), ...entries], totalEntries: entries.length + 1 };
      return listing;
    },
    getState: () => state,
    dispatch: (action: FileTreeAction) => { state = fileTreeReducer(state, action); },
  });
  return { controller, get state() { return state; }, listed };
}

const CHAIN = { '/r': [d('a'), f('x')], '/r/a': [d('b')], '/r/a/b': [d('c')], '/r/a/b/c': [d('d')], '/r/a/b/c/d': [f('main.ts'), f('util.ts')] };

test('FR-FEX-015 AC-1 list mode: entering A lands on D', async () => {
  const h = harness(CHAIN, 'list');
  await h.controller.setRoot('/r');
  await h.controller.enterChain('/r/a');
  assert.equal(h.state.root, '/r/a/b/c/d');
});

test('FR-FEX-015 AC-2 tree mode: expanding A expands A, B, C and D', async () => {
  const h = harness(CHAIN, 'tree');
  await h.controller.setRoot('/r');
  await h.controller.expandChain('/r/a');
  assert.deepEqual([...h.state.expandedPaths].sort(), ['/r/a', '/r/a/b', '/r/a/b/c', '/r/a/b/c/d']);
  const names = selectVisibleRows(h.state).flatMap((row) => (row.kind === 'node' ? [row.name] : []));
  assert.deepEqual(names, ['a', 'b', 'c', 'd', 'main.ts', 'util.ts', 'x']);
});

test('FR-FEX-015 AC-3 descending stops at an empty dir, at two or more entries, and at a single file', async () => {
  const empty = harness({ '/r': [d('a')], '/r/a': [d('b')], '/r/a/b': [] }, 'list');
  await empty.controller.enterChain('/r/a');
  assert.equal(empty.state.root, '/r/a/b');
  const two = harness({ '/r': [d('a')], '/r/a': [d('b'), d('c')] }, 'list');
  await two.controller.enterChain('/r/a');
  assert.equal(two.state.root, '/r/a');
  const oneFile = harness({ '/r': [d('a')], '/r/a': [f('only.txt')] }, 'list');
  await oneFile.controller.enterChain('/r/a');
  assert.equal(oneFile.state.root, '/r/a');
});

test('FR-FEX-015 AC-4 collapsing is one level; going up is one level', async () => {
  const t = harness(CHAIN, 'tree');
  await t.controller.expandChain('/r/a');
  t.controller.collapse('/r/a/b/c/d');
  assert.equal(t.state.expandedPaths.has('/r/a/b/c'), true);
  assert.equal(t.state.expandedPaths.has('/r/a/b/c/d'), false);
  const l = harness(CHAIN, 'list');
  await l.controller.enterChain('/r/a');
  await l.controller.goUp();
  assert.equal(l.state.root, '/r/a/b/c');
});

test('FR-FEX-015 AC-5 a listing failure stops at the last reached directory; depth is capped at 32', async () => {
  const broken = harness({ '/r': [d('a')], '/r/a': [d('b')], '/r/a/b': 'fail' }, 'list');
  await broken.controller.enterChain('/r/a');
  assert.equal(broken.state.root, '/r/a');
  const deep: Record<string, DirectoryEntry[]> = {};
  let p = '/r';
  for (let i = 0; i < 40; i += 1) { deep[p] = [d('n')]; p += '/n'; }
  deep[p] = [];
  const h = harness(deep, 'list');
  await h.controller.enterChain('/r/n');
  assert.equal(h.state.root.split('/n').length - 1, 33, 'entered /r/n plus 32 more levels');
});
