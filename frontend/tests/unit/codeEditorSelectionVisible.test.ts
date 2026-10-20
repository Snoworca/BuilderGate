import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// FR-MDE-029 (#158): CodeMirror's drawSelection() paints the selection on a layer behind the
// lines, so an opaque active-line background hid a selection within the cursor's line (the
// whole of a one-line selection). The active line is translucent now; its gutter stays opaque
// because text scrolled sideways passes under the sticky gutter.

const source = readFileSync(new URL('../../src/components/editor/codeEditorExtensions.ts', import.meta.url), 'utf8');

function ruleBody(selector: string): string {
  const at = source.indexOf(`'${selector}': {`);
  assert.ok(at >= 0, `${selector} has its own rule`);
  return source.slice(at, source.indexOf('}', at));
}

test('FR-MDE-029 AC-1: the active line is translucent, its gutter opaque', () => {
  assert.doesNotMatch(source, /'\.cm-activeLine, \.cm-activeLineGutter'/, 'the two are no longer one opaque rule');
  assert.match(ruleBody('.cm-activeLine'), /backgroundColor: 'color-mix\(in srgb, var\(--atomic-editor-bg-panel\) \d+%, transparent\)'/);
  assert.match(ruleBody('.cm-activeLineGutter'), /backgroundColor: 'var\(--atomic-editor-bg-panel\)'/);
});

test('FR-MDE-029 AC-2: the selection is still drawn by drawSelection (the layer behind the lines)', () => {
  assert.match(source, /drawSelection\(\)/);
  assert.match(source, /highlightActiveLine\(\)/);
});

test('FR-MDE-029 AC-2: code mode draws the selection stronger than the reader tint', () => {
  assert.match(source, /'&\.cm-focused > \.cm-scroller > \.cm-selectionLayer \.cm-selectionBackground, \.cm-selectionBackground': \{\s*backgroundColor: 'color-mix\(in srgb, var\(--atomic-editor-accent\) 30%, transparent\)'/);
});
