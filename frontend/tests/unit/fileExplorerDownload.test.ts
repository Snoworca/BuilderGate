// FR-FEX-021 AC-1, AC-4 (#130): the 다운로드 menu item and mobile button, and how the browser is
// handed the download.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { installCatalog } from '../../src/i18n/i18n.ts';
import {
  buildFileExplorerContextMenuItems,
  buildMobileActionButtons,
  type FileExplorerMenuHandlers,
  type FileExplorerMenuInfo,
} from '../../src/components/fileExplorer/fileExplorerContextMenu.ts';

installCatalog('ko', JSON.parse(readFileSync(new URL('../../public/locales/messages.ko.json', import.meta.url), 'utf8')));

const noop = () => {};
const handlers: FileExplorerMenuHandlers = {
  open: noop, newtab: noop, download: noop, copy: noop, cut: noop, paste: noop,
  rename: noop, delete: noop, newdir: noop, refresh: noop, info: noop,
};
function info(overrides: Partial<FileExplorerMenuInfo> = {}): FileExplorerMenuInfo {
  return { target: 'item', isDir: false, openable: true, count: 1, clipboardEmpty: true, mode: 'tree', context: 'explorer-window', ...overrides };
}
function download(items: ReturnType<typeof buildFileExplorerContextMenuItems>): { disabled?: boolean } | undefined {
  const item = items.find(entry => 'label' in entry && entry.label === '다운로드');
  return item && 'label' in item ? { disabled: item.disabled } : undefined;
}

test('FR-FEX-021 AC-1: 다운로드 is enabled for one file and disabled for a directory or several items', () => {
  assert.equal(download(buildFileExplorerContextMenuItems(info(), handlers))?.disabled, false);
  assert.equal(download(buildFileExplorerContextMenuItems(info({ openable: false }), handlers))?.disabled, false, 'a file the editor cannot open still downloads');
  assert.equal(download(buildFileExplorerContextMenuItems(info({ isDir: true }), handlers))?.disabled, true);
  assert.equal(download(buildFileExplorerContextMenuItems(info({ count: 2 }), handlers))?.disabled, true);
  assert.equal(download(buildFileExplorerContextMenuItems(info({ context: 'editor-panel' }), handlers))?.disabled, false);
  assert.equal(download(buildFileExplorerContextMenuItems(info({ target: 'empty' }), handlers)), undefined, 'not on empty space');
});

test('FR-FEX-021 AC-1: the mobile bar has a 다운로드 button enabled only for exactly one selected file', () => {
  const button = (singleFileSelected: boolean, count: number) =>
    buildMobileActionButtons({ count, clipboardEmpty: true, singleFileSelected }, handlers).find(b => b.id === 'download');
  assert.equal(button(true, 1)?.label, '다운로드');
  assert.equal(button(true, 1)?.disabled, false);
  assert.equal(button(false, 1)?.disabled, true, 'one directory');
  assert.equal(button(false, 0)?.disabled, true);
  assert.equal(button(false, 2)?.disabled, true);
});

test('FR-FEX-021 AC-4: the download is handed to the browser through a link to the token URL', () => {
  const source = readFileSync(new URL('../../src/components/fileExplorer/fileDownload.ts', import.meta.url), 'utf8');
  assert.match(source, /createDownloadToken\(/);
  assert.match(source, /document\.createElement\('a'\)/);
  assert.match(source, /\.click\(\)/);
  assert.doesNotMatch(source, /\.blob\(\)|createObjectURL/, 'the file is not held in page memory');
});
