import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// FR-MDE-031 (#205): under the dark theme no `--atomic-editor-code-bg` is defined, so the
// rendered code block (`.dl-code`) fell back to the light grey in editor.css and the dark shiki
// palette was drawn on a light backdrop.
// FR-MDE-032 (#204): the vendor table is `width: max-content`, so on a desktop a wide table ran
// past the reading column. Desktop fits it to the column; a phone keeps it wide and scrolls.

const editorCss = readFileSync(new URL('../../src/editor/styles/editor.css', import.meta.url), 'utf8');
const windowCss = readFileSync(new URL('../../src/components/editor/EditorWindow.css', import.meta.url), 'utf8');

/** The body of the first rule whose selector list is exactly `selector`, within `scope`. */
function ruleBody(css: string, selector: string): string {
  const at = css.indexOf(`${selector} {`);
  assert.ok(at >= 0, `${selector} has its own rule`);
  return css.slice(at, css.indexOf('}', at));
}

/** The text of the phone media block the editor window already uses. */
function phoneBlock(css: string): string {
  const query = '@media (max-width: 767px), (pointer: coarse) and (max-height: 500px) and (max-width: 950px) {';
  const blocks = css.split(query).slice(1);
  assert.ok(blocks.length > 0, 'the phone media query exists');
  return blocks.map((block) => block.slice(0, block.indexOf('\n}\n'))).join('\n');
}

const VENDOR_DARK_CODE_BG = 'var(--atomic-editor-code-bg, color-mix(in srgb, #2d2d2d 88%, black 12%))';

test('FR-MDE-031 AC-1: under the dark theme the rendered code block takes the dark code backdrop', () => {
  const body = ruleBody(editorCss, "[data-editor-theme='dark'] .dl-code");
  assert.ok(body.includes(`background: ${VENDOR_DARK_CODE_BG}`), body);
});

test('FR-MDE-031 AC-2: under the dark theme the code block text uses the dark shiki palette', () => {
  assert.match(editorCss, /\[data-editor-theme='dark'\] \.dl-code pre\.shiki span,[\s\S]*?color: var\(--shiki-dark\) !important;/);
});

test('FR-MDE-031 AC-3: the light code block stays grey', () => {
  assert.match(windowCss, /--atomic-editor-code-bg: #eef0f2;/);
  assert.match(editorCss, /\.dl-code \{\n  padding: 0\.75em 0\.75rem;\n  background: var\(--atomic-editor-code-bg, #f3f4f6\);/);
});

test('FR-MDE-032 AC-1: on a desktop a table fits the reading column and wraps its cells', () => {
  const body = ruleBody(windowCss, '.editor-window-surface .cm-atomic-table table');
  assert.match(body, /width: 100%;/);
  assert.doesNotMatch(body, /max-content/);
});

test('FR-MDE-032 AC-2: on a phone a table keeps its content width and its wrapper scrolls sideways', () => {
  const phone = phoneBlock(windowCss);
  assert.match(phone, /\.editor-window-surface \.cm-atomic-table table \{[^}]*width: max-content;/);
  // A phone browser's overlay scrollbar shows only while scrolling, so the cut-off columns gave no
  // sign they were there. A styled scrollbar is drawn all the time.
  assert.match(phone, /\.editor-window-surface \.cm-atomic-table::-webkit-scrollbar \{[^}]*height: \d+px;/);
  assert.match(phone, /\.editor-window-surface \.cm-atomic-table::-webkit-scrollbar-thumb \{[^}]*background: var\(--accent\);/);
  const vendor = readFileSync(new URL('../../src/editor/vendor/atomic-editor/styles/inline-preview.css', import.meta.url), 'utf8');
  assert.match(ruleBody(vendor, '.cm-atomic-table'), /overflow-x: auto;/);
});

test('FR-MDE-032 AC-3: a narrow table fills the column at either width', () => {
  const vendor = readFileSync(new URL('../../src/editor/vendor/atomic-editor/styles/inline-preview.css', import.meta.url), 'utf8');
  assert.match(ruleBody(vendor, '.cm-atomic-table table'), /min-width: 100%;/);
});
