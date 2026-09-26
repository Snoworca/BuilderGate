import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('../../src/components/Workspace/WorkspaceItem.tsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../../src/components/Workspace/Workspace.css', import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

// The badge's tone now comes from a token (CON-UIDS-001) rather than an inline
// hex. What the original guard protected still holds: the running count is
// amber (the warn tone, the palette's nearest to the old orange), never green.
test('workspace running count badge uses the amber warn tone instead of green', () => {
  assert.match(source, /className="[^"]*\bworkspace-item-running\b[^"]*"/);
  const rule = /\.workspace-item-running\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule, 'Workspace.css styles .workspace-item-running');
  assert.match(rule[1], /background(?:-color)?:\s*var\(--warn\)/);
  assert.doesNotMatch(rule[1], /var\(--ok(?:-text)?\)|#22c55e/);
  assert.doesNotMatch(source, /backgroundColor:\s*'#22c55e'/);
});

test('workspace rename input stops pointer down from starting drag reorder', () => {
  assert.match(source, /onPointerDown=\{\(e\) => e\.stopPropagation\(\)\}/);
});
