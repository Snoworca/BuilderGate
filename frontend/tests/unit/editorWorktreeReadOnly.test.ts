import './i18nTestSetup.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decideDocumentAccess } from '../../src/components/editor/editorDocumentAccess.ts';
import { documentSaveBinding, loadDocument, planOpenDocument, type DocumentLoadDeps } from '../../src/hooks/editorDocumentLoad.ts';
import { createSvgSourceSession, initialSvgTabState, toSource } from '../../src/components/editor/svgTabModel.ts';

// SEC-FOP-002 AC-6 -- a document the server read from another worktree of the
// session folder's repository (its read answer carries `worktree`) opens
// read-only, says which worktree, and never saves. A document without the
// field behaves exactly as before.

const WORKTREE = { root: 'C:\\w\\d-1', name: 'd-1' };

function depsReading(file: { content: string; encoding?: string; worktree?: { root: string; name: string } }): DocumentLoadDeps {
  return {
    readFile: async () => file,
    readImage: async () => new Blob([]),
  };
}

test('SEC-FOP-002 AC-6: a worktree document is read-only and its notice names the worktree', () => {
  const access = decideDocumentAccess('utf-8', 'd-1');
  assert.equal(access.readOnly, true);
  assert.ok(access.notice !== null && access.notice.includes('d-1'), `notice names the worktree: ${access.notice}`);
  assert.deepEqual(decideDocumentAccess('utf-8'), { readOnly: false, notice: null }, 'no worktree: unchanged');
});

test('SEC-FOP-002 AC-6: the load carries the worktree into the open record and the save binding is read-only', async () => {
  const loaded = await loadDocument({ filePath: 'C:\\w\\d-1\\notes.md', sessionId: 's1' }, depsReading({ content: '# n', worktree: WORKTREE }));
  assert.equal(loaded.status, 'loaded');
  if (loaded.status !== 'loaded') return;
  const record = planOpenDocument({ filePath: 'C:\\w\\d-1\\notes.md', tabId: 't1', workspaceId: 'w1', document: loaded.document });
  assert.equal(record.worktree, 'd-1');
  assert.equal(documentSaveBinding(record).readOnly, true);

  const local = await loadDocument({ filePath: 'C:\\w\\d\\README.md', sessionId: 's1' }, depsReading({ content: '# r' }));
  assert.equal(local.status, 'loaded');
  if (local.status !== 'loaded') return;
  const localRecord = planOpenDocument({ filePath: 'C:\\w\\d\\README.md', tabId: 't1', workspaceId: 'w1', document: local.document });
  assert.equal(localRecord.worktree, undefined);
  assert.equal(documentSaveBinding(localRecord).readOnly, false);
});

test('SEC-FOP-002 AC-6: an SVG source from another worktree is read-only and an edit writes nothing', async () => {
  const state = await toSource(initialSvgTabState(), { sessionId: 's1', filePath: 'C:\\w\\d-1\\i.svg' }, {
    readFile: async () => ({ content: '<svg/>', encoding: 'utf-8', worktree: WORKTREE }),
  });
  assert.equal(state.source?.worktree, 'd-1');
  const writes: string[] = [];
  const session = createSvgSourceSession({
    tabId: 'tab-1',
    filePath: 'C:\\w\\d-1\\i.svg',
    source: state.source!,
    deps: {
      resolveTabSession: () => 'session-1',
      writeFile: async (_s: string, path: string) => {
        writes.push(path);
        return { success: true };
      },
    },
  });
  assert.equal(session.access.readOnly, true);
  session.handleEditorText('<svg width="2"/>');
  await session.controller.save();
  assert.deepEqual(writes, []);
});
