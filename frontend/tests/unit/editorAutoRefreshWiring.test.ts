// FR-MDE-030: how the editor window, its hook and the layer wire the auto refresh.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (rel: string) => readFileSync(new URL(`../../src/${rel}`, import.meta.url), 'utf8');
const win = read('components/editor/EditorWindow.tsx');
const hook = read('hooks/useEditorWindows.ts');
const layer = read('components/editor/EditorWindowLayer.tsx');
const app = read('App.tsx');

// @req FR-MDE-030
test('FR-MDE-030 AC-1: the title bar toggle reads and writes the shared store', () => {
  assert.match(win, /useSyncExternalStore\(autoRefreshStore\.subscribe, autoRefreshStore\.get\)/);
  assert.match(win, /className="editor-auto-refresh"[^>]*aria-pressed=\{autoRefresh\}/);
  assert.match(win, /onClick=\{\(\) => autoRefreshStore\.set\(!autoRefresh\)\}/);
});

// @req FR-MDE-030
test('FR-MDE-030 AC-2: the window watches its active tab only while on and on screen', () => {
  assert.match(win, /createEditorFileWatcher\(/);
  assert.match(win, /autoRefresh && !hidden && pageVisible && activeTab !== null/);
  assert.match(win, /watcherRef\.current\??\.noteSave\(/, 'saves go through the watcher');
});

// @req FR-MDE-030
test('FR-MDE-030 AC-3~AC-6: reload, close and the two bars', () => {
  assert.match(hook, /const reloadDocument = useCallback\(/);
  assert.match(win, /key=\{`\$\{tab\.filePath\}#\$\{tab\.revision \?\? 0\}`\}/, 'a reload remounts the panel');
  assert.match(win, /t\('editor\.autoRefresh\.changed'\)/);
  assert.match(win, /t\('editor\.autoRefresh\.deleted'\)/);
  assert.match(win, /handlesRef\.current\.get\(activeFilePath\)\?\.save\(\)/, '다시 저장 writes the edits');
  assert.match(win, /onNotice\(t\('editor\.autoRefresh\.closed', \{ name: fileNameOf\(filePath\) \}\)\)/);
  assert.match(app, /onReloadDocument=\{editor\.reloadDocument\}/);
  assert.match(app, /onNotice=\{editor\.showNotice\}/);
  assert.match(layer, /className="editor-notice"/);
});

// @req FR-MDE-030
test('FR-MDE-030 AC-3/AC-4: a reload re-checks unsaved edits before it lands, and only the latest read lands', () => {
  assert.match(hook, /const reloadDocument = useCallback\(\(filePath: string, canApply: \(\) => boolean\): Promise<ReloadOutcome>/);
  assert.match(hook, /reloadSeqRef\.current\.get\(filePath\) !== seq/, 'a slower, older read is dropped');
  assert.match(hook, /if \(!canApply\(\)\) return 'skipped'/);
  assert.match(hook, /revision: \(existing\.revision \?\? 0\) \+ 1/);
  assert.match(win, /if \(outcome === 'skipped'\)/, 'edits typed while reading turn the reload into the question');
  assert.match(win, /if \(outcome === 'failed'\) watcherRef\.current\?\.retry\(filePath\)/);
});

// @req FR-MDE-030
test('FR-MDE-030 AC-4/AC-6: each tab keeps its own bar, and a save clears its bar', () => {
  assert.match(win, /useState<ReadonlyMap<string, 'changed' \| 'deleted'>>/);
  assert.match(win, /dropPrompt\(path\)/, 'a successful write drops that file\'s bar');
});

// @req FR-MDE-030
test('FR-MDE-030 AC-3: a reloaded tab keeps its view (markdown source, HTML source or rendered)', () => {
  const panel = read('components/editor/EditorDocumentPanel.tsx');
  const html = read('components/editor/HtmlFileTab.tsx');
  assert.match(panel, /recallEditorView\(filePath, 'raw'\)/);
  assert.match(panel, /recallEditorView\(filePath, 'html'\)/);
  assert.match(html, /rememberEditorView\(filePath, 'html', view\)/);
  assert.match(win, /reloaded=\{\(tab\.revision \?\? 0\) > 0\}/);
});
