import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('../../src/components/Workspace/WorkspaceItem.tsx', import.meta.url), 'utf8');

test('workspace running count badge uses orange background instead of green', () => {
  assert.match(source, /backgroundColor:\s*'#f97316'/);
  assert.doesNotMatch(source, /backgroundColor:\s*'#22c55e'/);
});

test('workspace rename input stops pointer down from starting drag reorder', () => {
  assert.match(source, /onPointerDown=\{\(e\) => e\.stopPropagation\(\)\}/);
});
