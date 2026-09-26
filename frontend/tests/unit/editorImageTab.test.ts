import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DocumentLoadDeps } from '../../src/hooks/editorDocumentLoad.ts';
import { listEditorTrayEntries } from '../../src/components/editor/editorTrayModel.ts';
import { decideEditorWindowClosePrompt } from '../../src/components/editor/editorWindowClose.ts';
import { createEditorWindowSaveController } from '../../src/components/editor/editorWindowSave.ts';

// FR-MDE-018 -- how an image file becomes a tab of the editor window.
//
// The open and restore branches of useEditorWindows are judged through the pure
// module they are extracted into (src/hooks/editorDocumentLoad.ts):
//
//   loadDocument({ filePath, sessionId }, deps)
//     decides the mode from the path (FR-MDE-013) and reads through
//     deps.readImage for an image, deps.readFile otherwise. Resolves to
//       { status: 'loaded', document: LoadedDocument }
//       { status: 'missing' }        -- text only: the FR-MDE-007 create prompt
//       { status: 'error', error }
//     where LoadedDocument is
//       { kind: 'text', bodyAtOpen, encoding }
//       { kind: 'image', image: { status: 'ready', blob, size } | { status: 'error', error } }
//
//   planOpenDocument({ filePath, tabId, workspaceId, document })
//     the tab record the window list keeps.
//
//   documentSaveBinding(record)
//     the binding its save controller is built with.
//
// Imported per test so each case reports on its own while the module is absent.
const loadModule = () => import('../../src/hooks/editorDocumentLoad.ts');

// The deps are recording stubs, not mocks of the transport: each one answers
// what the real fileApi would answer for the case and keeps the calls it got.

interface Recorded {
  readFile: string[];
  readImage: string[];
}

function makeDeps(answers: {
  readFile?: () => Promise<{ content: string; encoding?: string }>;
  readImage?: () => Promise<Blob>;
}): { deps: DocumentLoadDeps; calls: Recorded } {
  const calls: Recorded = { readFile: [], readImage: [] };
  const deps: DocumentLoadDeps = {
    readFile: (sessionId, path) => {
      calls.readFile.push(`${sessionId}:${path}`);
      return (answers.readFile ?? (() => Promise.resolve({ content: '', encoding: 'utf-8' })))();
    },
    readImage: (sessionId, path) => {
      calls.readImage.push(`${sessionId}:${path}`);
      return (answers.readImage ?? (() => Promise.resolve(new Blob([new Uint8Array(4)], { type: 'image/png' }))))();
    },
  };
  return { deps, calls };
}

test('TC-REQ-FR-MDE-018-AC1-01 an image opens as a tab record shaped like a document tab', async () => {
  const { loadDocument, planOpenDocument } = await loadModule();
  const { deps } = makeDeps({});
  const imageLoad = await loadDocument({ filePath: '/w/logo.png', sessionId: 's1' }, deps);
  const textLoad = await loadDocument({ filePath: '/w/README.md', sessionId: 's1' }, deps);
  assert.equal(imageLoad.status, 'loaded');
  assert.equal(textLoad.status, 'loaded');
  if (imageLoad.status !== 'loaded' || textLoad.status !== 'loaded') return;

  const image = planOpenDocument({ filePath: '/w/logo.png', tabId: 't1', workspaceId: 'ws', document: imageLoad.document });
  const text = planOpenDocument({ filePath: '/w/README.md', tabId: 't1', workspaceId: 'ws', document: textLoad.document });

  assert.equal(image.kind, 'image');
  assert.equal(text.kind, 'text');
  // The fields the tab bar, the tray and the close path read are the same ones.
  for (const key of ['filePath', 'tabId', 'workspaceId', 'dirty'] as const) {
    assert.ok(key in image, `image record lacks ${key}`);
    assert.equal(typeof image[key], typeof text[key], `${key} differs in type`);
  }
  assert.equal(image.filePath, '/w/logo.png');
  assert.equal(image.tabId, 't1');
  assert.equal(image.workspaceId, 'ws');
  assert.equal(image.dirty, false);

  // Tray: the label is built exactly as a document's, with no dirty marker.
  const [imageEntry] = listEditorTrayEntries([{ ...image, tabName: 'bash', workspaceName: 'W' }]);
  const [textEntry] = listEditorTrayEntries([{ ...text, tabName: 'bash', workspaceName: 'W' }]);
  assert.equal(imageEntry.label, textEntry.label.replace('README.md', 'logo.png'));

  // Close: a clean tab closes without a prompt, as a clean document does.
  assert.deepEqual(decideEditorWindowClosePrompt({ dirty: image.dirty, tabClosed: false }), { kind: 'none' });
});

test('TC-REQ-FR-MDE-018-AC2-01 loading an image reads through readImage and never readFile', async () => {
  const { loadDocument } = await loadModule();
  const blob = new Blob([new Uint8Array(1234)], { type: 'image/png' });
  const { deps, calls } = makeDeps({ readImage: () => Promise.resolve(blob) });

  const outcome = await loadDocument({ filePath: '/w/photo.PNG', sessionId: 's9' }, deps);

  assert.deepEqual(calls.readImage, ['s9:/w/photo.PNG']);
  assert.deepEqual(calls.readFile, []);
  assert.equal(outcome.status, 'loaded');
  if (outcome.status !== 'loaded') return;
  assert.equal(outcome.document.kind, 'image');
  if (outcome.document.kind !== 'image') return;
  assert.equal(outcome.document.image.status, 'ready');
  if (outcome.document.image.status !== 'ready') return;
  assert.equal(outcome.document.image.blob, blob);
  assert.equal(outcome.document.image.size, 1234);
});

test('TC-REQ-FR-MDE-018-AC7-01 an image tab never turns dirty and its save writes nothing', async () => {
  const { loadDocument, planOpenDocument, documentSaveBinding } = await loadModule();
  const { deps } = makeDeps({});
  const outcome = await loadDocument({ filePath: '/w/icon.webp', sessionId: 's1' }, deps);
  assert.equal(outcome.status, 'loaded');
  if (outcome.status !== 'loaded') return;
  const record = planOpenDocument({ filePath: '/w/icon.webp', tabId: 't1', workspaceId: 'ws', document: outcome.document });

  const writes: string[] = [];
  const controller = createEditorWindowSaveController({
    binding: documentSaveBinding(record),
    bodyAtOpen: '',
    deps: {
      resolveTabSession: () => 's1',
      writeFile: (sessionId, path) => {
        writes.push(`${sessionId}:${path}`);
        return Promise.resolve({ success: true });
      },
    },
  });

  controller.handleEditorChange('anything');
  assert.equal(controller.isDirty(), false);
  // The title bar button and Ctrl+S both call this one save.
  await controller.save();
  await controller.save();
  assert.deepEqual(writes, []);
  assert.equal(record.dirty, false);
});

test('TC-REQ-FR-MDE-018-AC8-02 a missing image becomes an in-tab error, not the create prompt', async () => {
  const { loadDocument } = await loadModule();
  const notFound = new Error('PATH_NOT_FOUND: /w/gone.png');
  const { deps, calls } = makeDeps({ readImage: () => Promise.reject(notFound) });

  const outcome = await loadDocument({ filePath: '/w/gone.png', sessionId: 's1' }, deps);

  assert.notEqual(outcome.status, 'missing');
  assert.equal(outcome.status, 'loaded');
  if (outcome.status !== 'loaded') return;
  assert.equal(outcome.document.kind, 'image');
  if (outcome.document.kind !== 'image') return;
  assert.equal(outcome.document.image.status, 'error');
  if (outcome.document.image.status !== 'error') return;
  assert.equal(outcome.document.image.error, notFound);
  assert.deepEqual(calls.readFile, []);

  // Control: the same answer for a text file is still the FR-MDE-007 prompt.
  const text = makeDeps({ readFile: () => Promise.reject(new Error('PATH_NOT_FOUND: /w/new.md')) });
  const textOutcome = await loadDocument({ filePath: '/w/new.md', sessionId: 's1' }, text.deps);
  assert.equal(textOutcome.status, 'missing');
});

test('TC-REQ-FR-MDE-018-AC9-01 a restored record is re-judged by path, so png and svg reopen through readImage', async () => {
  const { loadDocument, planOpenDocument } = await loadModule();
  // A restore record carries only the path and the tab; the mode is decided again.
  const records = [
    { filePath: '/w/shot.png', tabId: 't1' },
    { filePath: '/w/diagram.svg', tabId: 't1' },
    { filePath: '/w/notes.md', tabId: 't1' },
  ];
  const { deps, calls } = makeDeps({ readFile: () => Promise.resolve({ content: '# n', encoding: 'utf-8' }) });

  const kinds: string[] = [];
  for (const record of records) {
    const outcome = await loadDocument({ filePath: record.filePath, sessionId: 's1' }, deps);
    assert.equal(outcome.status, 'loaded');
    if (outcome.status !== 'loaded') continue;
    kinds.push(planOpenDocument({ ...record, workspaceId: 'ws', document: outcome.document }).kind);
  }

  assert.deepEqual(calls.readImage, ['s1:/w/shot.png', 's1:/w/diagram.svg']);
  assert.deepEqual(calls.readFile, ['s1:/w/notes.md']);
  assert.deepEqual(kinds, ['image', 'image', 'text']);
});
