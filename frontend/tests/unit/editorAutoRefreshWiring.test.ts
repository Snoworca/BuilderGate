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
  assert.match(win, /watcherRef\.current\.noteSave\(/, 'saves go through the watcher');
});

// @req FR-MDE-030
test('FR-MDE-030 AC-3~AC-6: reload, close and the two bars', () => {
  assert.match(hook, /const reloadDocument = useCallback\(/);
  assert.match(hook, /revision: \(current\.revision \?\? 0\) \+ 1/);
  assert.match(win, /key=\{`\$\{tab\.filePath\}#\$\{tab\.revision \?\? 0\}`\}/, 'a reload remounts the panel');
  assert.match(win, /t\('editor\.autoRefresh\.changed'\)/);
  assert.match(win, /t\('editor\.autoRefresh\.deleted'\)/);
  assert.match(win, /handlesRef\.current\.get\(prompt\.filePath\)\?\.save\(\)/, '다시 저장 writes the edits');
  assert.match(win, /onNotice\(t\('editor\.autoRefresh\.closed', \{ name: fileNameOf\(filePath\) \}\)\)/);
  assert.match(app, /onReloadDocument=\{editor\.reloadDocument\}/);
  assert.match(app, /onNotice=\{editor\.showNotice\}/);
  assert.match(layer, /className="editor-notice"/);
});
