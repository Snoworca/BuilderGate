import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type * as EditorDocumentModeModule from '../../src/components/editor/editorDocumentMode.ts';

// FR-MDE-023 -- a markdown document can switch between the md editor (live
// preview) and its raw source in the code-mode editor.
//
// Contracts fixed here:
//   editorDocumentMode.ts  effectiveDocumentComponent(component, raw)
//       -> 'code' for markdown shown raw; otherwise the component unchanged
//   EditorDocumentToolbar  prop markdownView?: { raw: boolean; onToggle: () => void }
//       drawn left of the theme toggle, class editor-markdown-view-toggle
//   languages.ts           the id 'markdown' resolves to the vendored Markdown grammar
const testDir = dirname(fileURLToPath(import.meta.url));
const read = (path: string): string => readFileSync(resolve(testDir, '../../src', path), 'utf8');

// TC-REQ-FR-MDE-023-AC3-01
test('TC-REQ-FR-MDE-023-AC3-01: a markdown document shown raw draws the code editor; nothing else changes', async () => {
  const mod = await import('../../src/components/editor/editorDocumentMode.ts') as typeof EditorDocumentModeModule;
  assert.equal(mod.effectiveDocumentComponent('markdown', true), 'code');
  assert.equal(mod.effectiveDocumentComponent('markdown', false), 'markdown');
  assert.equal(mod.effectiveDocumentComponent('code', true), 'code');
  assert.equal(mod.effectiveDocumentComponent('image', true), 'image');
  assert.equal(mod.effectiveDocumentComponent(null, true), null);
});

// TC-REQ-FR-MDE-023-AC1-01
test('TC-REQ-FR-MDE-023-AC1-01: the raw-view toggle sits left of the theme toggle, for markdown only', () => {
  const toolbar = read('components/editor/EditorDocumentToolbar.tsx');
  assert.match(toolbar, /editor-markdown-view-toggle/);
  assert.ok(toolbar.indexOf('editor-markdown-view-toggle') < toolbar.indexOf('editor-theme-toggle'),
    'the raw-view toggle renders before (left of) the theme toggle');
  assert.match(toolbar, /markdownView\s*!==\s*undefined/);
  const panel = read('components/editor/EditorDocumentPanel.tsx');
  assert.match(panel, /markdownView=\{component === 'markdown' \?/);
});

// TC-REQ-FR-MDE-023-AC2-01
test('TC-REQ-FR-MDE-023-AC2-01: the toggle shows a source icon in the md editor and a markdown icon in the raw view', () => {
  const toolbar = read('components/editor/EditorDocumentToolbar.tsx');
  assert.match(toolbar, /data-icon="source"/);
  assert.match(toolbar, /data-icon="markdown"/);
  assert.match(toolbar, /aria-pressed=\{markdownView\.raw\}/);
  assert.match(toolbar, /markdownView\.raw \? <MarkdownIcon \/> : <SourceIcon \/>/);
});

// TC-REQ-FR-MDE-023-AC4-01
test('TC-REQ-FR-MDE-023-AC4-01: switching views remounts with the text being edited and keeps the one save controller', () => {
  const panel = read('components/editor/EditorDocumentPanel.tsx');
  // The text currently in the editor, kept by the save listener, is what the next view mounts with.
  assert.match(panel, /liveBodyRef\.current = update\.state\.sliceDoc\(\)/);
  assert.match(panel, /markdownSource: mountBody/);
  assert.match(panel, /setMountBody\(liveBodyRef\.current\)/);
  // The code editor draws markdown with the markdown grammar.
  assert.match(panel, /language=\{shown === 'markdown-raw' \? 'markdown' : mode\.language\}/);
  // Still exactly one save controller.
  assert.equal((panel.match(/createEditorWindowSaveController\(/g) ?? []).length, 1);
  const languages = read('editor/languages.ts');
  assert.match(languages, /markdown:\s*'Markdown'/);
});
