import './i18nTestSetup.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { TodoItem } from '../../src/components/Todo/todoModel.ts';
import { todoPieSlicePath, todoProgress, todoTreePath, type TodoTreeAnchor } from '../../src/components/Todo/todoTree.ts';

// FR-TODO-003 AC-10..AC-12: the dotted tree, the category status icon, the app checkbox.

function entry(id: number, parentId: number | null, done = false): TodoItem {
  return { id, parentId, title: `t${id}`, detail: '', done, createdAt: '', updatedAt: '' };
}

test('FR-TODO-003 AC-11: progress counts every entry under a category', () => {
  // 1 > 2 (done) > 3 (done) ; 1 > 4 ; 5 (no children)
  const items = [entry(1, null), entry(2, 1, true), entry(3, 2, true), entry(4, 1), entry(5, null)];
  assert.deepEqual(todoProgress(items, 1), { done: 2, total: 3 });
  assert.deepEqual(todoProgress(items, 5), { done: 0, total: 0 });
});

test('FR-TODO-003 AC-11: the pie fills by the ratio, never empty and never a closed circle', () => {
  const end = (d: string) => d.match(/(-?[\d.]+) (-?[\d.]+)z$/)!.slice(1).map(Number);
  // A quarter: the arc ends at 3 o'clock.
  const [qx, qy] = end(todoPieSlicePath(0.25));
  assert.ok(Math.abs(qx - 19) < 0.05 && Math.abs(qy - 12) < 0.05, `quarter ends at ${qx},${qy}`);
  // Half and more take the large arc.
  assert.match(todoPieSlicePath(0.75), /A7 7 0 1 1/);
  assert.match(todoPieSlicePath(0.25), /A7 7 0 0 1/);
  // Zero still shows a sliver; one stays drawable.
  const [zx] = end(todoPieSlicePath(0));
  assert.ok(zx > 12.5, 'zero shows a sliver');
  const [fx, fy] = end(todoPieSlicePath(1));
  assert.ok(fx < 12 && fy < 12, 'one is just short of a full turn');
});

test('FR-TODO-003 AC-10: each parent gets one trunk to its last visible child, and one branch per child', () => {
  const anchors = new Map<number, TodoTreeAnchor>([
    [1, { left: 8, right: 30, top: 10, bottom: 32 }],
    [2, { left: 30, right: 45, top: 50, bottom: 65 }],
    [3, { left: 52, right: 67, top: 90, bottom: 105 }],
    [4, { left: 30, right: 45, top: 130, bottom: 145 }],
    [5, { left: 8, right: 30, top: 170, bottom: 192 }],
  ]);
  const rows = [entry(1, null), entry(2, 1), entry(3, 2), entry(4, 1), entry(5, null)];
  const d = todoTreePath(rows, anchors);
  // Trunk of 1: from under its icon (x=19.5) to the last child's middle (y=137.5 -> 138.5 rounded + .5).
  assert.match(d, /M19\.5 34V137\.5/);
  // Branches of 1 to 2 and 4, ending just left of the box.
  assert.match(d, /M19\.5 57\.5H27/);
  assert.match(d, /M19\.5 137\.5H27/);
  // Trunk and branch of 2 to 3.
  assert.match(d, /M37\.5 67V97\.5/);
  assert.match(d, /M37\.5 97\.5H49/);
  // No line for a childless entry, nor one for a row without an anchor.
  assert.equal(todoTreePath([entry(5, null)], anchors), '');
  assert.equal(todoTreePath([entry(1, null), entry(9, 1)], anchors), '');
});

test('FR-TODO-003 AC-10..AC-12: the panel draws the tree, the status icon and the app checkbox', () => {
  const source = readFileSync(new URL('../../src/components/Todo/TodoPanel.tsx', import.meta.url), 'utf-8');
  assert.match(source, /todoTreePath\(/);
  assert.match(source, /ResizeObserver/);
  assert.match(source, /className="todo-tree-lines"/);
  assert.match(source, /todo-status/);
  assert.match(source, /todoPieSlicePath\(/);
  assert.match(source, /todo-row__progress/);
  assert.match(source, /className="todo-check"/);
  const css = readFileSync(new URL('../../src/components/Todo/TodoPanel.css', import.meta.url), 'utf-8');
  assert.match(css, /\.todo-tree-lines path\s*\{[^}]*stroke-dasharray/);
  assert.match(css, /\.todo-check\s*\{[^}]*appearance:\s*none/);
  assert.match(css, /\.todo-check:checked\s*\{[^}]*#2c4058/);
  assert.match(css, /\.todo-check:focus-visible\s*\{[^}]*box-shadow/);
  assert.match(css, /\.todo-row--d1 \.todo-row__title\s*\{[^}]*calc\(var\(--todo-font-size\) \+ 4px\)/);
});

test('FR-TODO-003 AC-13: a long title wraps instead of being cut, and the marks stay on its first line', () => {
  const css = readFileSync(new URL('../../src/components/Todo/TodoPanel.css', import.meta.url), 'utf-8');
  const rule = (selector: string) => {
    const blocks = [...css.matchAll(new RegExp(`(^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'g'))].map((m) => m[2]);
    return blocks.join('\n');
  };
  const title = rule('.todo-row__title');
  assert.doesNotMatch(title, /white-space:\s*nowrap/);
  assert.doesNotMatch(title, /text-overflow:\s*ellipsis/);
  assert.match(title, /white-space:\s*normal/);
  assert.match(title, /overflow-wrap:\s*anywhere/);
  assert.match(title, /line-height:\s*var\(--row-line\)/);
  assert.match(rule('.todo-row'), /align-items:\s*flex-start/);
  assert.match(rule('.todo-check'), /margin-top:\s*calc\(\(var\(--row-line\) - 15px\) \/ 2\)/);
  assert.match(rule('.todo-status'), /margin-top:\s*calc\(\(var\(--row-line\) - 20px\) \/ 2\)/);
  assert.match(rule('.todo-row__actions'), /top:\s*calc\(4px \+ var\(--row-line\) \/ 2\)/);
});
