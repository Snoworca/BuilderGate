import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// FR-MDE-028 AC-9: the HTML tab's controls stay on one line and scroll sideways when the window
// is narrower than they are. The toolbar also carries .editor-code-toolbar, whose
// justify-content: flex-end pushes an overflowing row's start to the left, where no scroll can
// reach it: on a phone the 렌더링/소스 segment, then 자원 and 다시 불러오기, vanished. The HTML
// toolbar must put the row back at flex-start and right-align with the first control's auto margin.

const css = readFileSync(new URL('../../src/components/editor/EditorWindow.css', import.meta.url), 'utf8');

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  assert.ok(match, `rule ${selector} not found`);
  return match[1];
}

test('FR-MDE-028 AC-9: the shared code toolbar still right-aligns with flex-end', () => {
  assert.match(ruleBody('.editor-window-surface .editor-code-toolbar'), /justify-content:\s*flex-end/);
});

test('FR-MDE-028 AC-9: the HTML toolbar overrides flex-end so an overflowing row scrolls from its start', () => {
  const body = ruleBody('.editor-window-surface .html-tab-toolbar');
  assert.match(body, /justify-content:\s*flex-start/);
  assert.match(body, /overflow-x:\s*auto/);
  assert.match(css, /\.editor-window-surface \.html-tab-toolbar > :first-child \{ margin-left: auto; \}/);
});
