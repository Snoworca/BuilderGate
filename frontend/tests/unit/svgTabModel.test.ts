import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type * as SvgTabModelModule from '../../src/components/editor/svgTabModel.ts';
import { createBlobUrlSlot } from '../../src/components/editor/imageViewerModel.ts';
import { decideEditorWindowClosePrompt } from '../../src/components/editor/editorWindowClose.ts';

// FR-MDE-019 AC-1..AC-4, FR-MDE-015 AC-1/AC-4, FR-MDE-016 AC-1/AC-2,
// SEC-MDE-001 AC-2 -- one SVG tab switching between the image viewer and its
// XML source, as a pure model the panel drives.
//
// Contract fixed here for src/components/editor/svgTabModel.ts (pure, loads
// under `node --experimental-strip-types`):
//
//   type SvgView = 'preview' | 'source'
//   type SvgSource = { raw: string; encoding: DocumentEncoding }
//       raw is the read endpoint's content exactly as received (BOM, CRLF kept).
//   type SvgTabState = { view: SvgView; source: SvgSource | null }
//
//   initialSvgTabState() -> { view: 'preview', source: null }
//       An SVG opens in the image viewer; the source is not read until asked.
//   toSource(state, { sessionId, filePath }, { readFile }) -> Promise<SvgTabState>
//       view 'source'. When state.source is null the body is fetched through
//       readFile (the shape of fileApi.readFile, GET .../files/read) exactly
//       once and its encoding is judged with documentEncodingOf; a loaded
//       source is reused without another read.
//   toPreview(state, { editorBody, slot }) -> SvgTabState
//       view 'preview', source kept. When editorBody is a string the preview is
//       redrawn from it: slot.replace(new Blob([editorBody],
//       { type: 'image/svg+xml' })) -- the unsaved edit is what is drawn, and
//       the slot revokes the previous URL. null leaves the slot alone.
//   createSvgSourceSession({ tabId, filePath, source, deps, onStateChange? })
//       -> { layout, access, controller, handleEditorText(text) }
//       layout     = analyzeText(source.raw)
//       access     = decideDocumentAccess(source.encoding)
//       controller = createEditorWindowSaveController with
//                    binding documentSaveBinding({ tabId, filePath, kind: 'text',
//                    encoding }) and bodyAtOpen encodeForSave(layout.body, layout)
//                    -- the same save path as every code-mode document.
//       handleEditorText(text) feeds encodeForSave(text, layout) to the
//                    controller (text is what the editor's sliceDoc returns).
//   svgTabClosePrompt(session, { tabClosed }) -> EditorWindowClosePrompt
//       delegates to decideEditorWindowClosePrompt with the controller's dirty.
//
// The module is loaded inside each test: a static import of a missing module
// kills the runner before any test is named. The `import type` line is erased
// at runtime and lets tsc check the calls against the real signatures.
const MODULE_PATH = '../../src/components/editor/svgTabModel.ts';
type Mod = typeof SvgTabModelModule;

async function loadModule(): Promise<Mod> {
  return await import(MODULE_PATH) as Mod;
}

const testDir = dirname(fileURLToPath(import.meta.url));
const modelPath = resolve(testDir, '../../src/components/editor/svgTabModel.ts');

type ReadCall = { sessionId: string; path: string };

function fakeReadFile(content: string, encoding: string = 'utf-8') {
  const calls: ReadCall[] = [];
  const readFile = async (sessionId: string, path: string) => {
    calls.push({ sessionId, path });
    return { content, encoding };
  };
  return { calls, readFile };
}

type WriteCall = { sessionId: string; path: string; content: string };

function fakeSaveDeps() {
  const writes: WriteCall[] = [];
  return {
    writes,
    deps: {
      resolveTabSession: (tabId: string) => (tabId === 'tab-1' ? 'session-1' : undefined),
      writeFile: async (sessionId: string, path: string, content: string) => {
        writes.push({ sessionId, path, content });
        return { success: true };
      },
    },
  };
}

/** Replaces URL.createObjectURL / revokeObjectURL for the duration of `run`. */
async function withUrlStub<T>(run: (log: { created: Blob[]; revoked: string[] }) => Promise<T> | T): Promise<T> {
  const log = { created: [] as Blob[], revoked: [] as string[] };
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  URL.createObjectURL = ((blob: Blob) => {
    log.created.push(blob);
    return `blob:svg-${log.created.length}`;
  }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = ((url: string) => {
    log.revoked.push(url);
  }) as typeof URL.revokeObjectURL;
  try {
    return await run(log);
  } finally {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  }
}

const SVG_PATH = 'art/logo.svg';
const SVG_BODY = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>';

test('TC-REQ-FR-MDE-019-AC1-01: an SVG tab opens in the image viewer', async () => {
  const mod = await loadModule();
  const state = mod.initialSvgTabState();
  assert.equal(state.view, 'preview');
  assert.equal(state.source, null, 'the source is not read until the user asks for it');
});

test('TC-REQ-FR-MDE-019-AC2-01: toSource reads the body once through readFile; toPreview switches back', async () => {
  const mod = await loadModule();
  const { calls, readFile } = fakeReadFile(SVG_BODY);

  const initial = mod.initialSvgTabState();
  const source = await mod.toSource(initial, { sessionId: 'session-1', filePath: SVG_PATH }, { readFile });
  assert.equal(source.view, 'source');
  assert.deepEqual(calls, [{ sessionId: 'session-1', path: SVG_PATH }], 'the body comes from the file read path');
  assert.deepEqual(source.source, { raw: SVG_BODY, encoding: 'utf-8' });

  const back = await withUrlStub(() => mod.toPreview(source, { editorBody: null, slot: createBlobUrlSlot() }));
  assert.equal(back.view, 'preview');
  assert.deepEqual(back.source, source.source, 'the loaded source stays with the tab');

  const again = await mod.toSource(back, { sessionId: 'session-1', filePath: SVG_PATH }, { readFile });
  assert.equal(again.view, 'source');
  assert.equal(calls.length, 1, 'a loaded source is reused, not read again');
});

test('TC-REQ-FR-MDE-019-AC3-01: returning to preview draws the unsaved edit and revokes the previous URL', async () => {
  const mod = await loadModule();
  const { readFile } = fakeReadFile(SVG_BODY);
  const edited = SVG_BODY.replace('<rect', '<circle r="4"/><rect');

  await withUrlStub(async (log) => {
    const slot = createBlobUrlSlot();
    slot.replace(new Blob([SVG_BODY], { type: 'image/svg+xml' }));
    const firstUrl = slot.current();
    assert.equal(firstUrl, 'blob:svg-1');

    const source = await mod.toSource(mod.initialSvgTabState(), { sessionId: 'session-1', filePath: SVG_PATH }, { readFile });
    const preview = mod.toPreview(source, { editorBody: edited, slot });

    assert.equal(preview.view, 'preview');
    assert.equal(log.created.length, 2, 'the preview is rebuilt from the edit');
    const drawn = log.created[1];
    assert.equal(drawn.type, 'image/svg+xml');
    assert.equal(await drawn.text(), edited, 'the drawn bytes are the unsaved edit');
    assert.equal(slot.current(), 'blob:svg-2');
    assert.deepEqual(log.revoked, [firstUrl], 'the previous preview URL is revoked');
  });
});

test('TC-REQ-FR-MDE-019-AC4-01: a source edit turns dirty, saves through the code-mode controller, and closing asks first', async () => {
  const mod = await loadModule();
  const { writes, deps } = fakeSaveDeps();
  const session = mod.createSvgSourceSession({
    tabId: 'tab-1',
    filePath: SVG_PATH,
    source: { raw: SVG_BODY, encoding: 'utf-8' },
    deps,
  });

  assert.equal(session.controller.isDirty(), false);
  assert.equal(mod.svgTabClosePrompt(session, { tabClosed: false }).kind, 'none', 'a clean tab closes without a prompt');

  const edited = SVG_BODY.replace('width="10"', 'width="20"');
  session.handleEditorText(edited);
  assert.equal(session.controller.isDirty(), true, 'an edit marks the tab dirty');

  const prompt = mod.svgTabClosePrompt(session, { tabClosed: false });
  assert.deepEqual(prompt, decideEditorWindowClosePrompt({ dirty: true, tabClosed: false }), 'the FR-MDE-011 close prompt');
  assert.equal(prompt.kind, 'unsaved-changes');

  const outcome = await session.controller.save();
  assert.deepEqual(outcome, { status: 'saved' });
  assert.deepEqual(writes, [{ sessionId: 'session-1', path: SVG_PATH, content: edited }]);
  assert.equal(session.controller.isDirty(), false, 'a saved tab is clean again');
});

test('TC-REQ-FR-MDE-015-AC4-03: a BOM + CRLF source saved without edits writes the original bytes', async () => {
  const mod = await loadModule();
  const raw = '﻿<svg xmlns="http://www.w3.org/2000/svg">\r\n  <rect width="1" height="1"/>\r\n</svg>\r\n';
  const { writes, deps } = fakeSaveDeps();
  const session = mod.createSvgSourceSession({
    tabId: 'tab-1',
    filePath: SVG_PATH,
    source: { raw, encoding: 'utf-8' },
    deps,
  });

  assert.equal(session.layout.eol, '\r\n');
  assert.equal(session.layout.bom, true);

  // What the editor's sliceDoc hands back when nothing was typed: the body
  // without its BOM, joined with the file's own line ending.
  session.handleEditorText(session.layout.body);
  await session.controller.save();

  assert.equal(writes.length, 1);
  assert.equal(writes[0].content, raw, 'BOM and CRLF are written back byte for byte');
});

test('TC-REQ-FR-MDE-016-AC1-02: a non-UTF-8 SVG source is read-only and never written', async () => {
  const mod = await loadModule();
  const { readFile } = fakeReadFile('<svg>�</svg>', 'unknown');
  const state = await mod.toSource(mod.initialSvgTabState(), { sessionId: 'session-1', filePath: SVG_PATH }, { readFile });
  assert.equal(state.source?.encoding, 'unknown');

  const { writes, deps } = fakeSaveDeps();
  const session = mod.createSvgSourceSession({
    tabId: 'tab-1',
    filePath: SVG_PATH,
    source: state.source!,
    deps,
  });

  assert.equal(session.access.readOnly, true);
  assert.ok(session.access.notice, 'the tab says why it is read-only');
  session.handleEditorText('<svg>changed</svg>');
  assert.equal(session.controller.isDirty(), false);
  assert.deepEqual(await session.controller.save(), { status: 'read-only' });
  assert.equal(writes.length, 0, 'no write request is sent');
});

test('TC-REQ-SEC-MDE-001-AC2-01: a hostile SVG preview only goes through a blob URL, never a DOM insertion API', async () => {
  const mod = await loadModule();
  const hostile = '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script></svg>';
  const { readFile } = fakeReadFile(hostile);

  const domCalls: string[] = [];
  const element = new Proxy({} as Record<string, unknown>, {
    set(_target, key) {
      if (key === 'innerHTML' || key === 'outerHTML') domCalls.push(String(key));
      return true;
    },
    get(_target, key) {
      if (key === 'insertAdjacentHTML') return () => domCalls.push('insertAdjacentHTML');
      return () => element;
    },
  });
  const globals = globalThis as Record<string, unknown>;
  const hadDocument = 'document' in globals;
  const originalDocument = globals.document;
  globals.document = {
    createElement: () => element,
    body: element,
    write: () => domCalls.push('document.write'),
    writeln: () => domCalls.push('document.writeln'),
  };

  try {
    await withUrlStub(async (log) => {
      const source = await mod.toSource(mod.initialSvgTabState(), { sessionId: 'session-1', filePath: SVG_PATH }, { readFile });
      const slot = createBlobUrlSlot();
      mod.toPreview(source, { editorBody: hostile, slot });

      assert.equal(log.created.length, 1, 'the preview becomes a blob URL');
      assert.equal(log.created[0].type, 'image/svg+xml');
      assert.equal(slot.current(), 'blob:svg-1');
    });
  } finally {
    if (hadDocument) globals.document = originalDocument;
    else delete globals.document;
  }

  assert.deepEqual(domCalls, [], 'no markup is inserted into the page');

  assert.ok(existsSync(modelPath), 'svgTabModel.ts exists');
  const code = readFileSync(modelPath, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/[^\n]*$/gm, '');
  for (const api of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'dangerouslySetInnerHTML', 'document.write', 'DOMParser']) {
    assert.equal(code.includes(api), false, `svgTabModel.ts does not use ${api}`);
  }
});
