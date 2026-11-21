import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// FR-MDE-034: the app's `color-scheme: dark` reaches the page in the frame (Chrome 157 measured:
// prefers-color-scheme turns dark inside the iframe). `light dark` on the frame hands the choice
// back to the browser's own preference, as when the file is opened directly.
test('FR-MDE-034 AC-1: the rendered HTML frame takes its color scheme from the browser, not the app', () => {
  const css = readFileSync(new URL('../../src/components/editor/EditorWindow.css', import.meta.url), 'utf8');
  const rule = /\.editor-window-surface \.html-tab-frame \{([^}]*)\}/u.exec(css);
  assert.ok(rule, 'the frame rule exists');
  assert.match(rule[1], /color-scheme:\s*light dark;/u);
});
