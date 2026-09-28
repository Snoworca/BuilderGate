import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildFileExplorerContextMenuItems, type FileExplorerMenuHandlers, type FileExplorerMenuInfo } from '../../src/components/fileExplorer/fileExplorerContextMenu.ts';
import { buildInfoRows, formatInfoTable } from '../../src/components/fileExplorer/fileInfoModel.ts';
import { installCatalog } from '../../src/i18n/i18n.ts';

installCatalog('en', { 'fileExplorer.menu.info': 'Info', 'fileExplorer.info.bytes': '{bytes} bytes' });

// FR-FEX-018 — Info is the last item of an entry's menu and opens a copyable attribute table.

const noop = () => {};
const handlers = new Proxy({}, { get: () => noop }) as FileExplorerMenuHandlers;
const info = (over: Partial<FileExplorerMenuInfo>): FileExplorerMenuInfo => ({
  target: 'item', isDir: false, openable: true, count: 1, clipboardEmpty: true, mode: 'list', context: 'explorer-window', ...over,
});

test('FR-FEX-018 AC-1 an entry menu ends with an enabled Info item; empty space has none', () => {
  for (const mode of ['list', 'tree'] as const) {
    const items = buildFileExplorerContextMenuItems(info({ mode }), handlers).filter((item) => !('separator' in item)) as Array<{ label: string; disabled?: boolean }>;
    const last = items[items.length - 1];
    assert.equal(last.label, 'Info', mode);
    assert.equal(last.disabled ?? false, false);
  }
  const empty = buildFileExplorerContextMenuItems(info({ target: 'empty', count: 0 }), handlers);
  assert.equal(empty.some((item) => 'label' in item && item.label === 'Info'), false);
});

const STAT = {
  name: 'config.json5', path: 'C:\\pm\\server\\config.json5', relativePath: 'server\\config.json5', kind: 'file' as const,
  size: 3458, extension: '.json5', modified: '2026-09-27T23:11:34.000Z', accessed: '2026-09-28T00:02:10.000Z',
  changed: '2026-09-27T23:11:34.000Z', mode: '0644', permissions: 'rw-r--r--',
};

test('FR-FEX-018 AC-3 rows list every available attribute and omit the unavailable ones', () => {
  const rows = buildInfoRows(STAT, (iso) => `T(${iso})`);
  const keys = rows.map((row) => row.labelKey);
  assert.deepEqual(keys, [
    'fileExplorer.info.name', 'fileExplorer.info.fullPath', 'fileExplorer.info.relativePath', 'fileExplorer.info.kind',
    'fileExplorer.info.size', 'fileExplorer.info.modified', 'fileExplorer.info.accessed', 'fileExplorer.info.changed',
    'fileExplorer.info.permissions', 'fileExplorer.info.extension',
  ]);
  assert.equal(rows.find((r) => r.labelKey === 'fileExplorer.info.relativePath')!.value, './server/config.json5');
  assert.match(rows.find((r) => r.labelKey === 'fileExplorer.info.size')!.value, /3,458/);
  assert.equal(rows.find((r) => r.labelKey === 'fileExplorer.info.permissions')!.value, 'rw-r--r-- (0644)');
  const withDir = buildInfoRows({ ...STAT, kind: 'directory', childCount: 4, created: '2026-09-02T00:00:00.000Z', extension: undefined }, (iso) => iso);
  assert.ok(withDir.some((r) => r.labelKey === 'fileExplorer.info.childCount' && r.value === '4'));
  assert.ok(withDir.some((r) => r.labelKey === 'fileExplorer.info.created'));
});

test('FR-FEX-018 AC-5 times show the localized form and the ISO value', () => {
  const rows = buildInfoRows(STAT, (iso) => `local:${iso}`);
  assert.equal(rows.find((r) => r.labelKey === 'fileExplorer.info.modified')!.value, 'local:2026-09-27T23:11:34.000Z · 2026-09-27T23:11:34.000Z');
});

test('FR-FEX-018 AC-4 Copy all is a label<TAB>value table', () => {
  const text = formatInfoTable([{ labelKey: 'fileExplorer.info.name', value: 'a' }, { labelKey: 'fileExplorer.info.size', value: '1 B' }], (key) => key.split('.').pop()!);
  assert.equal(text, 'name\ta\nsize\t1 B');
});
