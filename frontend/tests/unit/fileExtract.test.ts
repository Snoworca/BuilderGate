// FR-FEX-027 AC-1~AC-6 (#140): extracting one archive from the explorer — two fixed menu
// entries, the job request, no extraction on double click, the confirm for a large archive, the
// job on the status bar and phone band, and where the result lands.
import './i18nTestSetup.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  buildFileExplorerContextMenuItems,
  buildMobileBarSlots,
  buildMobileMoreSheet,
  type FileExplorerMenuHandlers,
  type FileExplorerMenuInfo,
} from '../../src/components/fileExplorer/fileExplorerContextMenu.ts';
import { decideDoubleClick } from '../../src/components/fileExplorer/fileRowInteraction.ts';
import {
  buildExtractJobRequest,
  decideExtractConfirm,
  describeExtractDone,
  isExtractableArchive,
  runExtract,
} from '../../src/components/fileExplorer/fileExtract.ts';
import {
  fileJobStoreReducer,
  initialFileJobStoreState,
  selectExtractBand,
  selectPopoverRows,
} from '../../src/components/fileExplorer/fileJobStore.ts';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const noop = () => {};
const handlers: FileExplorerMenuHandlers = {
  open: noop, newtab: noop, download: noop, upload: noop, uploadFolder: noop, extract: noop, extractHere: noop,
  copy: noop, cut: noop, paste: noop, rename: noop, delete: noop, newdir: noop, refresh: noop, info: noop,
};
const info = (o: Partial<FileExplorerMenuInfo> = {}): FileExplorerMenuInfo => ({
  target: 'item', isDir: false, openable: false, count: 1, clipboardEmpty: true, mode: 'list', context: 'explorer-window',
  uploadable: true, folderUploadSupported: true, zipDownload: true, uploadTargetName: null, archiveSelected: true, ...o,
});
type Item = { label?: string; disabled?: boolean; separator?: boolean };
const labels = (items: unknown[]) => (items as Item[]).map((i) => (i.separator ? '|' : i.label));
const find = (items: unknown[], label: string) => (items as Item[]).find((i) => i.label === label);

test('FR-FEX-027 AC-1: 압축 풀기 · 여기에 풀기 follow the transfer entries as flat items, enabled only for one archive', () => {
  for (const name of ['a.zip', 'B.TAR', 'c.tar.gz', 'd.tgz']) assert.equal(isExtractableArchive(name), true, name);
  for (const name of ['a.gz', 'a.7z', 'a.rar', 'zip', 'a.zip.txt']) assert.equal(isExtractableArchive(name), false, name);

  const onArchive = buildFileExplorerContextMenuItems(info(), handlers);
  assert.deepEqual(labels(onArchive).slice(0, 6), ['편집기로 열기', '다운로드', '업로드…', '폴더 업로드…', '압축 풀기', '여기에 풀기']);
  assert.equal(find(onArchive, '압축 풀기')?.disabled, false);
  assert.equal(find(onArchive, '여기에 풀기')?.disabled, false);
  assert.ok((onArchive as Array<{ children?: unknown }>).every((i) => i.children === undefined), 'no submenu');
  for (const other of [info({ archiveSelected: false }), info({ count: 2 }), info({ isDir: true, archiveSelected: false })]) {
    const items = buildFileExplorerContextMenuItems(other, handlers);
    assert.equal(find(items, '압축 풀기')?.disabled, true);
    assert.equal(find(items, '여기에 풀기')?.disabled, true);
  }
  const onEmpty = buildFileExplorerContextMenuItems(info({ target: 'empty', isDir: true, count: 0, archiveSelected: false }), handlers);
  assert.deepEqual(labels(onEmpty).slice(0, 5), ['다운로드', '업로드…', '폴더 업로드…', '압축 풀기', '여기에 풀기']);

  const sheet = buildMobileMoreSheet({ count: 1, isDir: false, clipboardEmpty: true, folderUploadSupported: true, archiveSelected: true }, {
    download: noop, upload: noop, uploadFolder: noop, extract: noop, extractHere: noop, copy: noop, cut: noop, paste: noop, rename: noop, newdir: noop, info: noop, delete: noop,
  });
  assert.deepEqual(sheet.slice(0, 5).map((e) => (e === 'sep' ? '|' : e.id)), ['download', 'upload', 'uploadFolder', 'extract', 'extractHere']);
  assert.equal(sheet.filter((e) => e !== 'sep').find((e) => e.id === 'extract')?.disabled, false);
  const slots = buildMobileBarSlots({ count: 1, clipboardEmpty: true }, { upload: noop, download: noop, paste: noop, more: noop });
  assert.deepEqual(slots.map((s) => s.id), ['upload', 'download', 'paste', 'more'], 'the four slots do not change');
});

test('FR-FEX-027 AC-2/AC-3: the job extracts next to the archive, smart or here', () => {
  assert.deepEqual(buildExtractJobRequest('s1', '/w/src/pkg.tar.gz', 'smart'), {
    operation: 'extract', sourceSessionId: 's1', sources: ['/w/src/pkg.tar.gz'], destSessionId: 's1', destPath: '/w/src', mode: 'smart',
  });
  assert.equal(buildExtractJobRequest('s1', 'C:\\w\\a.zip', 'here').destPath, 'C:\\w');
  // FR-FEX-027 AC-3: a clash under 여기에 풀기 is the FR-FOP-006 question.
  const ko = JSON.parse(read('../../public/locales/messages.ko.json')) as Record<string, string>;
  assert.equal(ko['fileExplorer.menu.extract'], '압축 풀기');
  assert.equal(ko['fileExplorer.menu.extractHere'], '여기에 풀기');
});

test('FR-FEX-027 AC-4: a double click on an archive does not extract it', () => {
  for (const name of ['a.zip', 'a.tar', 'a.tar.gz', 'a.tgz']) {
    assert.deepEqual(decideDoubleClick({ kind: 'node', path: `/w/${name}`, name, type: 'file', depth: 0 }, 'list'), { type: 'noop' }, name);
  }
});

test('FR-FEX-027 AC-5: over 1 GiB or 10,000 entries asks first, and nothing is submitted before 풀기', async () => {
  const GiB = 1024 ** 3;
  assert.equal(decideExtractConfirm({ totalBytes: GiB, entryCount: 10_000 }), 'direct');
  assert.equal(decideExtractConfirm({ totalBytes: GiB + 1, entryCount: 1 }), 'confirm');
  assert.equal(decideExtractConfirm({ totalBytes: 1, entryCount: 10_001 }), 'confirm');

  const order: string[] = [];
  const deps = (answer: boolean, entryCount: number) => ({
    precount: async () => { order.push('precount'); return { entryCount, totalBytes: 10, rootName: 'pkg' }; },
    confirm: async (summary: { entryCount: number; destPath: string }) => { order.push(`confirm ${summary.entryCount} ${summary.destPath}`); return answer; },
    submit: async () => { order.push('submit'); return { jobId: 'j1' }; },
  });
  assert.equal(await runExtract({ sessionId: 's1', archive: '/w/a.zip', mode: 'smart' }, deps(false, 20_000)), null);
  assert.deepEqual(order, ['precount', 'confirm 20000 /w'], 'refused: nothing written');
  order.length = 0;
  assert.deepEqual(await runExtract({ sessionId: 's1', archive: '/w/a.zip', mode: 'here' }, deps(true, 20_000)), { jobId: 'j1' });
  assert.deepEqual(order, ['precount', 'confirm 20000 /w', 'submit']);
  order.length = 0;
  await runExtract({ sessionId: 's1', archive: '/w/a.zip', mode: 'smart' }, deps(false, 3));
  assert.deepEqual(order, ['precount', 'submit'], 'small: no confirm');
});

test('FR-FEX-027 AC-5: the job shows as 압축 풀기 with entries done of total, and on the phone band with its folder', () => {
  let state = fileJobStoreReducer(initialFileJobStoreState, {
    type: 'JOB_STARTED', jobId: 'j1', sessionId: 's1', origin: { workspaceId: 'ws1', tabId: 't1' }, operation: 'extract', destPath: '/w/src',
  });
  state = fileJobStoreReducer(state, {
    type: 'PROGRESS',
    route: { kind: 'progress', sessionId: 's1', jobId: 'j1', phase: 'transferring', processedBytes: 5, totalBytes: 10, processedEntries: 3, totalEntries: 12, currentPath: '/w/src/pkg/a.txt' },
  });
  assert.equal(selectPopoverRows(state)[0].label, '압축 풀기 → src · 3/12');
  assert.deepEqual(selectExtractBand(state, 'ws1'), { jobId: 'j1', text: 'src 에 푸는 중 · 3/12', fraction: 0.5 });
  assert.equal(selectExtractBand(state, 'ws2'), null);
});

test('FR-FEX-027 AC-6: the end names the count and folder, selects what was made, and lists skipped entries', () => {
  const smart = describeExtractDone({ destPath: '/w/src', createdPaths: ['/w/src/pkg (2)'], processedEntries: 12, skipped: [] });
  assert.deepEqual(smart.select, 'pkg (2)');
  assert.equal(smart.toast, "12개 항목을 'src' 폴더에 풀었습니다");
  assert.deepEqual(smart.skipped, []);
  const here = describeExtractDone({ destPath: '/w/src', createdPaths: ['/w/src/a.txt', '/w/src/b.txt'], processedEntries: 2, skipped: [{ path: '../evil', reason: 'PATH_TRAVERSAL' }] });
  assert.equal(here.select, 'a.txt', 'the first extracted item');
  assert.deepEqual(here.skipped, [{ path: '../evil', code: 'PATH_TRAVERSAL' }]);
  const ko = JSON.parse(read('../../public/locales/messages.ko.json')) as Record<string, string>;
  assert.doesNotMatch(ko['fileTransfer.toast.extracted.other'], /\}(?:을|를|이|가|은|는|와|과|으로|로)/);
  for (const code of ['ARCHIVE_TOO_LARGE', 'ARCHIVE_UNSUPPORTED', 'ARCHIVE_CORRUPT']) assert.equal(typeof ko[`apiError.${code}`], 'string', code);
});
