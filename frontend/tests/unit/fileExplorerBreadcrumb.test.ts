import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildBreadcrumb, collapseBreadcrumb } from '../../src/components/fileExplorer/fileExplorerPathBarModel.ts';

// FR-FEX-016 — the list-mode path reads ./a/b/c relative to the session root.

const text = (segments: ReturnType<typeof buildBreadcrumb>) =>
  segments === null ? null : segments.map((s) => (s.kind === 'root' ? '.' : s.label)).join('/');

test('FR-FEX-016 AC-1 segments are relative to the session root; the root renders as . before the separator', () => {
  const segs = buildBreadcrumb('C:\\Work\\pm\\server\\src\\services', 'C:\\Work\\pm');
  assert.equal(text(segs), './server/src/services');
  assert.equal(segs![0].kind, 'root');
  const posix = buildBreadcrumb('/home/u/pm/a/b', '/home/u/pm');
  assert.equal(text(posix), './a/b');
});

test('FR-FEX-016 AC-2/AC-3/AC-4 ancestors navigate, the current segment refreshes, the root goes to the session base', () => {
  const segs = buildBreadcrumb('/r/a/b', '/r')!;
  assert.deepEqual(segs.map((s) => [s.path, s.action]), [['/r', 'navigate'], ['/r/a', 'navigate'], ['/r/a/b', 'refresh']]);
});

test('FR-FEX-016 AC-5 at the session root only the root segment is shown and it refreshes', () => {
  const segs = buildBreadcrumb('C:\\Work\\pm\\', 'c:\\work\\PM')!;
  assert.equal(segs.length, 1);
  assert.equal(segs[0].action, 'refresh');
});

test('FR-FEX-016 a root outside the session root has no breadcrumb (the full path is shown instead)', () => {
  assert.equal(buildBreadcrumb('/other/x', '/r'), null);
  assert.equal(buildBreadcrumb('/r2/x', '/r'), null, 'a sibling sharing the prefix is not inside');
  assert.equal(buildBreadcrumb('/r/x', null), null);
});

test('FR-FEX-016 AC-6 long paths keep the root and the last segments and collapse the middle to …', () => {
  const segs = buildBreadcrumb('/r/a/b/c/d/e/f', '/r')!;
  const shown = collapseBreadcrumb(segs, 5);
  assert.deepEqual(shown.map((s) => (s.kind === 'ellipsis' ? '…' : s.kind === 'root' ? '.' : s.label)), ['.', '…', 'd', 'e', 'f']);
  const ellipsis = shown[1];
  assert.equal(ellipsis.kind, 'ellipsis');
  assert.equal(collapseBreadcrumb(buildBreadcrumb('/r/a/b', '/r')!, 5).length, 3, 'short paths are untouched');
});
