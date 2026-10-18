// FR-FEX-025 AC-1·AC-2·AC-3·AC-6, client side (#139): several items or a directory download as one
// ZIP, after a pre-count that asks before a large download; the token is issued only when the
// transfer starts, and the job shows a determinate bar that can be cancelled.
import './i18nTestSetup.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildFileExplorerContextMenuItems,
  buildMobileBarSlots,
  type FileExplorerMenuHandlers,
  type FileExplorerMenuInfo,
} from '../../src/components/fileExplorer/fileExplorerContextMenu.ts';
import { downloadButtonLabel } from '../../src/components/fileExplorer/fileTransferModel.ts';
import { createZipDownloader, decideZipConfirm, ZIP_POLL_MS } from '../../src/components/fileExplorer/fileZipDownload.ts';
import {
  fileTransferReducer,
  initialFileTransferState,
  selectTransferJobRows,
  type FileTransferAction,
  type FileTransferState,
} from '../../src/components/fileExplorer/fileTransferStore.ts';

const noop = () => {};
const handlers: FileExplorerMenuHandlers = {
  open: noop, newtab: noop, download: noop, upload: noop, uploadFolder: noop, copy: noop, cut: noop, paste: noop,
  rename: noop, delete: noop, newdir: noop, refresh: noop, info: noop,
};
const info = (o: Partial<FileExplorerMenuInfo> = {}): FileExplorerMenuInfo => ({
  target: 'item', isDir: false, openable: true, count: 1, clipboardEmpty: true, mode: 'list', context: 'explorer-window',
  uploadable: true, folderUploadSupported: true, zipDownload: true, uploadTargetName: null, ...o,
});
type Item = { label?: string; disabled?: boolean };
const downloadItem = (o: Partial<FileExplorerMenuInfo>) => (buildFileExplorerContextMenuItems(info(o), handlers) as Item[])[o.isDir ? 1 : 1];

test('FR-FEX-025 AC-1: several items or one directory offer ZIP으로 다운로드 (with the count); one file stays 다운로드', () => {
  assert.deepEqual(downloadItem({ count: 3 }), { ...downloadItem({ count: 3 }), label: 'ZIP으로 다운로드 (3개)', disabled: false });
  const dir = (buildFileExplorerContextMenuItems(info({ isDir: true }), handlers) as Item[]).find((i) => i.label?.startsWith('ZIP'));
  assert.equal(dir?.label, 'ZIP으로 다운로드');
  assert.equal(dir?.disabled, false);
  assert.equal(downloadButtonLabel({ count: 1, singleFile: true }), '다운로드');
  assert.equal(downloadButtonLabel({ count: 1, singleFile: false }), 'ZIP으로 다운로드');
  assert.equal(downloadButtonLabel({ count: 2, singleFile: false }), 'ZIP으로 다운로드 (2개)');
  const slot = (count: number) => buildMobileBarSlots({ count, clipboardEmpty: true }, { upload: noop, download: noop, paste: noop, more: noop }).find((s) => s.id === 'download');
  assert.equal(slot(2)?.disabled, false, 'the mobile bar offers it too');
  assert.equal(slot(0)?.disabled, true);
});

test('FR-FEX-025 AC-2: more than 1 GiB, more than 10,000 files, or a pre-count over 1 s asks first', () => {
  const GiB = 1024 ** 3;
  assert.equal(decideZipConfirm({ totalBytes: GiB, fileCount: 10_000, elapsedMs: 1000 }), 'direct');
  assert.equal(decideZipConfirm({ totalBytes: GiB + 1, fileCount: 1, elapsedMs: 10 }), 'confirm');
  assert.equal(decideZipConfirm({ totalBytes: 1, fileCount: 10_001, elapsedMs: 10 }), 'confirm');
  assert.equal(decideZipConfirm({ totalBytes: 1, fileCount: 1, elapsedMs: 1001 }), 'confirm');
});

function zipHarness(precount: { fileCount: number; totalBytes: number }, statuses: Array<{ state: string; sentBytes: number; totalBytes: number }> = []) {
  let state: FileTransferState = initialFileTransferState;
  const order: string[] = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  let clock = 0;
  const downloader = createZipDownloader({
    client: {
      zipPrecount: async () => { order.push('precount'); return { name: 'src.zip', excluded: ['.git', 'node_modules'], skippedBlocked: 0, ...precount }; },
      zipToken: async () => { order.push('token'); return { token: 't', url: '/api/downloads/t', name: 'src.zip', jobId: 'j1' }; },
      zipJob: async () => { order.push('job'); return statuses.shift() ?? { state: 'done', sentBytes: precount.totalBytes, totalBytes: precount.totalBytes }; },
      zipCancel: async () => { order.push('cancel'); },
    },
    dispatch: (action: FileTransferAction) => { state = fileTransferReducer(state, action); },
    now: () => (clock += 5),
    openUrl: (url) => order.push(`open ${url}`),
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimer: () => {},
    newId: () => 'z1',
  });
  const tick = async () => { const next = timers.shift(); assert.ok(next, 'a poll is scheduled'); assert.equal(next.ms, ZIP_POLL_MS); next.fn(); await new Promise((r) => setTimeout(r, 0)); };
  return { downloader, order, get: () => state, tick, timers };
}

test('FR-FEX-025 AC-2·AC-3: a small selection gets its token right after the pre-count and opens the link', async () => {
  const h = zipHarness({ fileCount: 3, totalBytes: 100 });
  let asked = false;
  await h.downloader.start({ sessionId: 's1', workspaceId: 'ws1', paths: ['/w/src'], confirm: async () => { asked = true; return true; } });
  assert.equal(asked, false);
  assert.deepEqual(h.order, ['precount', 'token', 'open /api/downloads/t']);
});

test('FR-FEX-025 AC-2·AC-3: a large selection waits for 받기 before any token; 취소 downloads nothing', async () => {
  const h = zipHarness({ fileCount: 12_300, totalBytes: 100 });
  let release: (ok: boolean) => void = () => {};
  const started = h.downloader.start({ sessionId: 's1', workspaceId: 'ws1', paths: ['/w/src'], confirm: (summary) => {
    assert.equal(summary.fileCount, 12_300);
    assert.deepEqual(summary.excluded, ['.git', 'node_modules']);
    return new Promise((resolve) => { release = resolve; });
  } });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(h.order, ['precount'], 'no token while the confirm bar is up');
  release(false);
  await started;
  assert.deepEqual(h.order, ['precount']);
  assert.equal(selectTransferJobRows(h.get(), 0).length, 0);
});

test('FR-FEX-025 AC-6: the job polls every 500 ms for a determinate bar and cancelling sends DELETE', async () => {
  const h = zipHarness({ fileCount: 3, totalBytes: 100 }, [{ state: 'streaming', sentBytes: 40, totalBytes: 100 }, { state: 'streaming', sentBytes: 60, totalBytes: 100 }]);
  await h.downloader.start({ sessionId: 's1', workspaceId: 'ws1', paths: ['/w/a', '/w/b'], confirm: async () => true });
  await h.tick();
  const [row] = selectTransferJobRows(h.get(), 0);
  assert.equal(row.indeterminate, false);
  assert.equal(row.fraction, 0.4);
  assert.equal(row.canCancel, true);
  await h.downloader.cancel(row.jobId);
  assert.ok(h.order.includes('cancel'));
  assert.equal(selectTransferJobRows(h.get(), 0).length, 0);
});
