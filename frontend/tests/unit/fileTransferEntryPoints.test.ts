// FR-FEX-022 AC-1~AC-7 (#139): where an upload starts and which folder it goes to.
import './i18nTestSetup.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  buildFileExplorerContextMenuItems,
  type FileExplorerMenuHandlers,
  type FileExplorerMenuInfo,
} from '../../src/components/fileExplorer/fileExplorerContextMenu.ts';
import { PATH_BAR_CONTROLS } from '../../src/components/fileExplorer/fileExplorerPathBarModel.ts';
import { decideFileExplorerShortcut } from '../../src/components/fileExplorer/fileExplorerShortcuts.ts';
import {
  decideDropAllowed,
  hasDraggedFiles,
  isFolderUploadSupported,
  resolveDropTarget,
  springDelay,
} from '../../src/components/fileExplorer/fileTransferModel.ts';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const noop = () => {};
const handlers: FileExplorerMenuHandlers = {
  open: noop, newtab: noop, download: noop, upload: noop, uploadFolder: noop, copy: noop, cut: noop, paste: noop,
  rename: noop, delete: noop, newdir: noop, refresh: noop, info: noop,
};
function info(overrides: Partial<FileExplorerMenuInfo> = {}): FileExplorerMenuInfo {
  return {
    target: 'item', isDir: false, openable: true, count: 1, clipboardEmpty: true, mode: 'list', context: 'explorer-window',
    uploadable: true, folderUploadSupported: true, zipDownload: true, uploadTargetName: null, ...overrides,
  };
}
type Item = { label?: string; disabled?: boolean; separator?: boolean; title?: string };
const entries = (items: unknown[]) => (items as Item[]).map((item) => (item.separator ? '|' : item.label ?? '?'));
const find = (items: unknown[], label: string) => (items as Item[]).find((item) => item.label === label);

test('FR-FEX-022 AC-1: the path bar ends with upload then download, unstyled, and no shortcut is bound to upload', () => {
  assert.deepEqual([...PATH_BAR_CONTROLS].slice(-2), ['upload', 'download']);
  const bar = read('../../src/components/fileExplorer/FileExplorerPathBar.tsx');
  assert.match(bar, /case 'upload':/);
  assert.match(bar, /case 'download':/);
  assert.doesNotMatch(bar, /primary/i, 'neither button is styled as primary');
  for (const key of ['u', 'U']) {
    const decision = decideFileExplorerShortcut({ event: { key, ctrlKey: true, metaKey: false, altKey: false }, focusedInSurface: true, selectionCount: 1, hasTextSelection: false });
    assert.equal(decision.kind, 'ignore', `Ctrl+${key}`);
  }
});

test('FR-FEX-022 AC-2: 다운로드 · 업로드… · 폴더 업로드… sit in the same place on an item and on empty space', () => {
  const onFile = entries(buildFileExplorerContextMenuItems(info(), handlers));
  assert.deepEqual(onFile.slice(0, 4), ['편집기로 열기', '다운로드', '업로드…', '폴더 업로드…']);
  const onEmpty = buildFileExplorerContextMenuItems(info({ target: 'empty', isDir: true, count: 0 }), handlers);
  assert.deepEqual(entries(onEmpty).slice(0, 3), ['다운로드', '업로드…', '폴더 업로드…']);
  assert.equal(find(onEmpty, '다운로드')?.disabled, true, 'nothing selected: kept in place, disabled');
  assert.equal(find(onEmpty, '업로드…')?.disabled, false);
  // A directory row names the directory it uploads into.
  const onDir = buildFileExplorerContextMenuItems(info({ isDir: true, uploadTargetName: 'src' }), handlers);
  assert.equal(find(onDir, "'src' 에 업로드…")?.disabled, false);
  // A surface that cannot upload (the editor's tree pane) shows no upload entries.
  const panel = entries(buildFileExplorerContextMenuItems(info({ context: 'editor-panel', uploadable: false }), handlers));
  assert.ok(!panel.includes('업로드…'));
});

test('FR-FEX-022 AC-3: folder upload follows feature detection of webkitdirectory, and says why when unsupported', () => {
  assert.equal(isFolderUploadSupported(() => ({ webkitdirectory: false })), true);
  assert.equal(isFolderUploadSupported(() => ({})), false);
  const off = find(buildFileExplorerContextMenuItems(info({ folderUploadSupported: false }), handlers), '폴더 업로드…');
  assert.equal(off?.disabled, true);
  assert.equal(off?.title, '이 브라우저는 폴더 업로드를 지원하지 않습니다');
  assert.doesNotMatch(read('../../src/components/fileExplorer/fileTransferModel.ts'), /pointer\s*:\s*coarse|innerWidth|matchMedia/);
});

test('FR-FEX-022 AC-4: the drop target is the shown folder for empty space or a file, the directory for a directory row or tree node', () => {
  const shown = '/w/src';
  assert.deepEqual(resolveDropTarget({ row: null, shownFolder: shown }), { dir: shown, highlightPath: null });
  assert.deepEqual(resolveDropTarget({ row: { path: '/w/src/a.ts', isDir: false }, shownFolder: shown }), { dir: shown, highlightPath: null });
  assert.deepEqual(resolveDropTarget({ row: { path: '/w/src/lib', isDir: true }, shownFolder: shown }), { dir: '/w/src/lib', highlightPath: '/w/src/lib' });
  assert.deepEqual(resolveDropTarget({ row: { path: '/w/src/lib/deep', isDir: true }, shownFolder: shown }), { dir: '/w/src/lib/deep', highlightPath: '/w/src/lib/deep' });
});

test('FR-FEX-022 AC-5: a collapsed tree directory springs open after 700 ms, an inactive tab switches after 500 ms', () => {
  assert.equal(springDelay({ kind: 'tree-dir', expanded: false }), 700);
  assert.equal(springDelay({ kind: 'tree-dir', expanded: true }), null);
  assert.equal(springDelay({ kind: 'tab', active: false }), 500);
  assert.equal(springDelay({ kind: 'tab', active: true }), null);
  assert.equal(springDelay({ kind: 'other' }), null);
});

test('FR-FEX-022 AC-6/AC-7: a modal blocks the drop; a drag without files is ignored', () => {
  assert.equal(hasDraggedFiles(['Files', 'text/plain']), true);
  assert.equal(hasDraggedFiles(['text/plain', 'text/uri-list']), false);
  assert.equal(hasDraggedFiles(undefined), false);
  assert.equal(decideDropAllowed({ hasFiles: true, modalOpen: false }), 'upload');
  assert.equal(decideDropAllowed({ hasFiles: true, modalOpen: true }), 'blocked');
  assert.equal(decideDropAllowed({ hasFiles: false, modalOpen: false }), 'ignore');
  assert.equal(decideDropAllowed({ hasFiles: false, modalOpen: true }), 'ignore');
});
