import './i18nTestSetup.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  buildFileExplorerContextMenuItems,
  buildMobileMoreSheet,
  type FileExplorerMenuHandlers,
  type FileExplorerMenuInfo,
} from '../../src/components/fileExplorer/fileExplorerContextMenu.ts';
import { isFileExistsError, validateNewFileName } from '../../src/components/fileExplorer/newFileModel.ts';

// FR-FEX-029 (#153): 새 파일 in the context menu and the mobile sheet, and the name check
// the window runs on every keystroke. FR-FOP-008 is the server half (fileRoutes.create.test.ts).

const noop = () => {};
const handlers = new Proxy({}, { get: () => noop }) as FileExplorerMenuHandlers;

function labels(info: Partial<FileExplorerMenuInfo>): string[] {
  const full: FileExplorerMenuInfo = {
    target: 'item', isDir: false, openable: true, count: 1, clipboardEmpty: true,
    mode: 'list', context: 'explorer-window', uploadable: true, newFile: true, ...info,
  };
  return buildFileExplorerContextMenuItems(full, handlers).flatMap((item) => ('label' in item && item.label ? [item.label] : []));
}

test('FR-FEX-029 AC-1: 새 파일 sits directly above 새 폴더, on an item and on empty space', () => {
  for (const target of ['item', 'empty'] as const) {
    const list = labels({ target, isDir: target === 'empty' });
    const at = list.indexOf('새 파일');
    assert.ok(at >= 0, `${target}: 새 파일 is missing from ${list.join(', ')}`);
    assert.equal(list[at + 1], '새 폴더', `${target}: ${list.join(', ')}`);
  }
});

test('FR-FEX-029 AC-1: 새 파일 is enabled wherever 새 폴더 is', () => {
  const full = (info: Partial<FileExplorerMenuInfo>) => buildFileExplorerContextMenuItems({
    target: 'item', isDir: false, openable: true, count: 1, clipboardEmpty: true,
    mode: 'list', context: 'explorer-window', newFile: true, ...info,
  }, handlers);
  for (const info of [{ target: 'empty' as const, isDir: true }, { target: 'item' as const, isDir: true }, { target: 'item' as const, isDir: false }]) {
    const items = full(info);
    const state = (label: string) => {
      const found = items.find((item) => 'label' in item && item.label === label);
      return found !== undefined && 'disabled' in found ? found.disabled : undefined;
    };
    assert.equal(state('새 파일'), state('새 폴더'), JSON.stringify(info));
  }
});

test('FR-FEX-029: a surface without the new-file window shows no 새 파일', () => {
  assert.equal(labels({ newFile: false }).includes('새 파일'), false);
  assert.equal(labels({ newFile: undefined }).includes('새 파일'), false);
});

test('FR-FEX-029 AC-1: the mobile sheet lists 새 파일 directly above 새 폴더, always enabled', () => {
  const sheet = buildMobileMoreSheet(
    { count: 0, isDir: false, clipboardEmpty: true, folderUploadSupported: true },
    new Proxy({}, { get: () => noop }) as Parameters<typeof buildMobileMoreSheet>[1],
  ).filter((entry) => entry !== 'sep');
  const at = sheet.findIndex((entry) => entry.id === 'newfile');
  assert.ok(at >= 0, 'newfile is in the sheet');
  assert.equal(sheet[at + 1].id, 'newdir');
  assert.equal(sheet[at].label, '새 파일');
  assert.equal(sheet[at].disabled, false);
});

test('FR-FEX-029 AC-2: an empty or blank name only disables 만들기', () => {
  assert.deepEqual(validateNewFileName('', []), { kind: 'empty' });
  assert.deepEqual(validateNewFileName('   ', []), { kind: 'empty' });
});

test('FR-FEX-029 AC-3: separators, . and .. are refused', () => {
  for (const name of ['a/b.txt', 'a\\b.txt', '/x']) assert.deepEqual(validateNewFileName(name, []), { kind: 'invalid', reason: 'separator' });
  for (const name of ['.', '..', ' .. ']) assert.deepEqual(validateNewFileName(name, []), { kind: 'invalid', reason: 'reserved' });
});

test('FR-FEX-029 AC-4: a name already listed (file or folder) is refused', () => {
  const entries = [{ name: 'README.md', type: 'file' as const }, { name: 'docs', type: 'directory' as const }];
  assert.deepEqual(validateNewFileName('README.md', entries), { kind: 'exists', name: 'README.md', isDir: false });
  assert.deepEqual(validateNewFileName(' docs ', entries), { kind: 'exists', name: 'docs', isDir: true });
  // Only an exact match is judged here; the server's filesystem decides case (D-2).
  assert.deepEqual(validateNewFileName('readme.md', entries), { kind: 'ok', name: 'readme.md' });
  assert.deepEqual(validateNewFileName('  notes.md ', entries), { kind: 'ok', name: 'notes.md' });
});

test('FR-FEX-029 AC-5: the server refusal for an existing name is recognised', () => {
  assert.equal(isFileExistsError(Object.assign(new Error('x'), { code: 'FILE_ALREADY_EXISTS' })), true);
  assert.equal(isFileExistsError(new Error('x')), false);
  assert.equal(isFileExistsError('FILE_ALREADY_EXISTS'), false);
});

test('FR-FEX-029: the explorer window wires the dialog and the API', () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
  const ops = read('../../src/hooks/useFileTreeOperations.ts');
  assert.match(ops, /newfile:\s*\(\)\s*=>/);
  assert.match(ops, /fileApi\.createFile\(/);
  const win = read('../../src/components/fileExplorer/FileExplorerWindow.tsx');
  assert.match(win, /<NewFileDialog\b/);
  assert.match(win, /newfile:\s*ops\.menuHandlers\.newfile/);
  assert.match(read('../../src/services/api.ts'), /\/files\/create`/);
});
