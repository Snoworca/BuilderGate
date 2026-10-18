// FR-FEX-024 AC-1~AC-8 (#139): an upload as one client-side file job — progress, pinned pending
// rows, one automatic retry, cancel, leave warnings, interrupted transfers, reload and the tray badge.
import './i18nTestSetup.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { DecideAnswer, DecideDetail } from '../../src/components/fileExplorer/fileExplorerPorts.ts';
import {
  fileTransferReducer,
  initialFileTransferState,
  selectMobileUploadBand,
  selectPendingUploadRows,
  selectRunningUploadCount,
  selectTransferJobRows,
  selectTrayBadge,
  selectUploadRunning,
  type FileTransferAction,
  type FileTransferState,
} from '../../src/components/fileExplorer/fileTransferStore.ts';
import { classifyUploadFailure, decideArrivalScroll } from '../../src/components/fileExplorer/fileTransferModel.ts';
import { createUploadController, type PutFileRequest } from '../../src/components/fileExplorer/fileUploadController.ts';
import { TransferError } from '../../src/components/fileExplorer/fileTransferClient.ts';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

function storeHarness() {
  let state: FileTransferState = initialFileTransferState;
  const dispatch = (action: FileTransferAction) => { state = fileTransferReducer(state, action); };
  return { dispatch, get: () => state };
}

interface Pending { req: PutFileRequest; resolve: (v: { name: string; path: string; size: number; skipped: boolean }) => void; reject: (e: unknown) => void }

function controllerHarness(options: { conflicts?: Array<{ path: string; decisions: Array<'overwrite' | 'rename' | 'skip'> }>; rejected?: Array<{ path: string; code: string }>; hiddenAt?: () => number | null } = {}) {
  const store = storeHarness();
  const pending: Pending[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let clock = 1000;
  const finished: Array<{ sessionId: string; dir: string }> = [];
  const controller = createUploadController({
    client: {
      checkUpload: async () => ({
        conflicts: (options.conflicts ?? []).map((c) => ({ path: c.path, existing: { size: 1, modified: '2026-10-01T00:00:00.000Z', isDirectory: false }, decisions: c.decisions })),
        rejected: options.rejected ?? [],
      }),
      putFile: (req) => new Promise((resolve, reject) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        const settle = <T,>(fn: (v: T) => void) => (v: T) => { inFlight -= 1; fn(v); };
        req.signal.addEventListener('abort', () => settle(reject)(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        pending.push({ req, resolve: settle(resolve), reject: settle(reject) });
      }),
    },
    dispatch: store.dispatch,
    now: () => (clock += 10),
    hiddenSince: options.hiddenAt ?? (() => null),
    onFinished: (event) => finished.push({ sessionId: event.sessionId, dir: event.dir }),
    newId: (() => { let n = 0; return () => `u${++n}`; })(),
  });
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { store, pending, controller, flush, finished, max: () => maxInFlight };
}

const source = (relPath: string, size = 4) => ({ file: new Blob(['x'.repeat(size)]), relPath });
const base = { sessionId: 's1', dir: '/w/components', dirLabel: 'components', workspaceId: 'ws1', tabId: 't1', existingNames: [] as string[] };
const noAsk = async (): Promise<DecideAnswer> => { throw new Error('no question expected'); };

test('FR-FEX-024 AC-1: one pick is one job labelled with the count and folder; at most 3 files are sent at a time', async () => {
  const h = controllerHarness();
  const started = h.controller.start({ ...base, sources: ['a', 'b', 'c', 'd', 'e'].map((n) => source(`${n}.txt`)), ask: noAsk, onRejected: () => {} });
  await h.flush();
  assert.equal(h.pending.length, 3);
  assert.equal(h.max(), 3);
  const [row] = selectTransferJobRows(h.store.get(), 2000);
  assert.equal(row.title, '업로드 5개 → components');
  assert.equal(row.canCancel, true);
  assert.equal(row.indeterminate, false);
  h.pending[0].req.onProgress(2);
  const [withProgress] = selectTransferJobRows(h.store.get(), 3000);
  assert.ok(withProgress.fraction > 0);
  assert.match(withProgress.detail ?? '', /^\d\/5 · [a-e]\.txt$/);
  assert.match(withProgress.bytes ?? '', /\/s$/);
  while (h.pending.length > 0) {
    const next = h.pending.shift()!;
    next.resolve({ name: next.req.path, path: `/w/components/${next.req.path}`, size: 4, skipped: false });
    await h.flush();
  }
  await started;
  assert.equal(h.max(), 3);
  assert.equal(selectUploadRunning(h.store.get()), false);
});

test('FR-FEX-024 AC-2: dimmed rows with their percentage sit at the list bottom of the target folder only', async () => {
  const h = controllerHarness();
  void h.controller.start({ ...base, sources: [source('z.txt'), source('assets/a.png'), source('assets/b.png')], ask: noAsk, onRejected: () => {} });
  await h.flush();
  const rows = selectPendingUploadRows(h.store.get(), 's1', '/w/components');
  assert.deepEqual(rows.map((r) => r.name), ['z.txt', 'assets'], 'a folder upload shows its top-level folder once');
  assert.ok(rows.every((r) => r.fraction >= 0 && r.fraction <= 1));
  assert.deepEqual(selectPendingUploadRows(h.store.get(), 's1', '/w/other'), []);
  assert.deepEqual(selectPendingUploadRows(h.store.get(), 's2', '/w/components'), []);
  // Scrolled to on completion unless the user moved meanwhile.
  assert.equal(decideArrivalScroll({ userSelected: false, userScrolled: false }), 'scroll');
  assert.equal(decideArrivalScroll({ userSelected: true, userScrolled: false }), 'toast-only');
  assert.equal(decideArrivalScroll({ userSelected: false, userScrolled: true }), 'toast-only');
});

test('FR-FEX-024 AC-3: a failing file is retried once; failing again ends as 완료 · n개 실패 and 재시도 resends only it', async () => {
  const h = controllerHarness();
  const started = h.controller.start({ ...base, sources: [source('ok.txt'), source('bad.txt')], ask: noAsk, onRejected: () => {} });
  await h.flush();
  const ok = h.pending.find((p) => p.req.path === 'ok.txt')!;
  ok.resolve({ name: 'ok.txt', path: '/w/components/ok.txt', size: 4, skipped: false });
  h.pending.splice(h.pending.indexOf(ok), 1);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await h.flush();
    const bad = h.pending.shift()!;
    assert.equal(bad.req.path, 'bad.txt', `attempt ${attempt + 1}`);
    bad.reject(new TransferError(0, 'NETWORK', 'dropped'));
  }
  await started;
  assert.equal(h.pending.length, 0, 'no third attempt');
  const [row] = selectTransferJobRows(h.store.get(), 5000);
  assert.equal(row.title, '완료 · 1개 실패 → components');
  assert.deepEqual(row.failed.map((f) => f.name), ['bad.txt']);
  assert.ok(row.failed[0].reason.length > 0);
  assert.equal(row.canRetry, true);
  const retried = h.controller.retry(row.jobId);
  await h.flush();
  assert.deepEqual(h.pending.map((p) => p.req.path), ['bad.txt'], 'only the failed file is sent again');
  h.pending[0].resolve({ name: 'bad.txt', path: '/w/components/bad.txt', size: 4, skipped: false });
  await retried;
  assert.equal(classifyUploadFailure({ status: 403, code: 'PATH_BLOCKED', hiddenDuringAttempt: false, attempts: 1 }), 'failed', 'a refusal is not retried');
  assert.equal(classifyUploadFailure({ status: 0, code: 'NETWORK', hiddenDuringAttempt: false, attempts: 1 }), 'retry');
  assert.equal(classifyUploadFailure({ status: 0, code: 'NETWORK', hiddenDuringAttempt: false, attempts: 2 }), 'failed');
});

test('FR-FEX-024 AC-4: cancelling aborts the transfers, drops the pending rows and the job', async () => {
  const h = controllerHarness();
  const started = h.controller.start({ ...base, sources: [source('a.txt'), source('b.txt')], ask: noAsk, onRejected: () => {} });
  await h.flush();
  const jobId = selectTransferJobRows(h.store.get(), 2000)[0].jobId;
  const signals = h.pending.map((p) => p.req.signal);
  h.controller.cancel(jobId);
  await started;
  assert.ok(signals.every((s) => s.aborted), 'every request is aborted, so the server removes its temp file');
  assert.deepEqual(selectPendingUploadRows(h.store.get(), 's1', '/w/components'), []);
  assert.equal(selectTransferJobRows(h.store.get(), 3000).length, 0);
  const ko = JSON.parse(read('../../public/locales/messages.ko.json')) as Record<string, string>;
  assert.equal(ko['fileTransfer.toast.cancelled'], '업로드를 취소했습니다. 받던 파일은 남기지 않았습니다.');
});

test('FR-FEX-024 AC-5: the leave warning exists only while an upload runs; the close bar and the popover line are worded', async () => {
  const h = controllerHarness();
  assert.equal(selectUploadRunning(h.store.get()), false);
  void h.controller.start({ ...base, sources: [source('a.txt')], ask: noAsk, onRejected: () => {} });
  await h.flush();
  assert.equal(selectUploadRunning(h.store.get()), true);
  assert.equal(selectRunningUploadCount(h.store.get(), 'ws1'), 1);
  assert.equal(selectRunningUploadCount(h.store.get(), 'ws2'), 0);
  const ko = JSON.parse(read('../../public/locales/messages.ko.json')) as Record<string, string>;
  assert.equal(ko['fileTransfer.close.keep'], '계속 업로드');
  assert.equal(ko['fileTransfer.close.stop'], '중단하고 닫기');
  assert.equal(ko['fileTransfer.popover.warn'], '탭을 닫거나 화면이 꺼지면 업로드가 중단됩니다');
  const guards = read('../../src/hooks/useFileTransferPageGuards.ts');
  assert.match(guards, /beforeunload/);
  assert.match(guards, /selectUploadRunning/);
  assert.match(guards, /removeEventListener\(\s*'beforeunload'/);
});

test('FR-FEX-024 AC-6: a transfer cut by the page going to the background is 중단됨 · 다시 시도, never completed; a wake lock is held', async () => {
  let hiddenAt: number | null = null;
  const h = controllerHarness({ hiddenAt: () => hiddenAt });
  const started = h.controller.start({ ...base, sources: [source('a.txt')], ask: noAsk, onRejected: () => {} });
  await h.flush();
  hiddenAt = 999_999;
  h.pending.shift()!.reject(new TransferError(0, 'NETWORK', 'dropped'));
  await started;
  assert.equal(h.pending.length, 0, 'not retried behind the user’s back');
  const [row] = selectTransferJobRows(h.store.get(), 5000);
  assert.equal(row.failed[0].reason, '중단됨 · 다시 시도');
  assert.equal(row.canRetry, true);
  assert.equal(classifyUploadFailure({ status: 0, code: 'NETWORK', hiddenDuringAttempt: true, attempts: 1 }), 'interrupted');
  assert.match(read('../../src/hooks/useFileTransferPageGuards.ts'), /wakeLock/);
});

test('FR-FEX-024 AC-7: a finished upload tells every view of the folder to reload, and badges a minimized window', async () => {
  const h = controllerHarness();
  const started = h.controller.start({ ...base, sources: [source('a.txt')], ask: noAsk, onRejected: () => {} });
  await h.flush();
  h.pending.shift()!.resolve({ name: 'a.txt', path: '/w/components/a.txt', size: 4, skipped: false });
  await started;
  assert.deepEqual(h.finished, [{ sessionId: 's1', dir: '/w/components' }]);
  assert.equal(selectTrayBadge(h.store.get(), 'ws1'), 1);
  h.store.dispatch({ type: 'WORKSPACE_SEEN', workspaceId: 'ws1' });
  assert.equal(selectTrayBadge(h.store.get(), 'ws1'), 0);
});

test('FR-FEX-024 AC-8: refused files are reported together while the others go on', async () => {
  const h = controllerHarness({ rejected: [{ path: 'setup.exe', code: 'PATH_BLOCKED' }, { path: 'big.iso', code: 'FILE_TOO_LARGE' }] });
  const reported: Array<{ path: string; code: string }> = [];
  void h.controller.start({ ...base, sources: [source('setup.exe'), source('big.iso'), source('ok.txt')], ask: noAsk, onRejected: (items) => reported.push(...items) });
  await h.flush();
  assert.deepEqual(reported.map((r) => r.path), ['setup.exe', 'big.iso']);
  assert.deepEqual(h.pending.map((p) => p.req.path), ['ok.txt']);
});

test('FR-FOP-006 AC-2 · FR-FEX-024: upload conflicts are asked one by one with the remaining count; apply-to-all answers the rest', async () => {
  const asked: DecideDetail[] = [];
  const h = controllerHarness({ conflicts: [
    { path: 'a.txt', decisions: ['overwrite', 'rename', 'skip'] },
    { path: 'b.txt', decisions: ['overwrite', 'rename', 'skip'] },
    { path: 'c.txt', decisions: ['overwrite', 'rename', 'skip'] },
  ] });
  void h.controller.start({
    ...base,
    sources: [source('a.txt'), source('b.txt'), source('c.txt'), source('d.txt')],
    ask: async (detail) => {
      asked.push(detail);
      return asked.length === 1 ? { kind: 'decide', choice: 'skip', applyToAll: false } : { kind: 'decide', choice: 'overwrite', applyToAll: true };
    },
    onRejected: () => {},
  });
  await h.flush();
  await h.flush();
  assert.deepEqual(asked.map((d) => d.remaining), [2, 1]);
  assert.equal(asked[0].folder, 'components');
  assert.deepEqual(h.pending.map((p) => `${p.req.path}:${p.req.conflict}`).sort(), ['b.txt:overwrite', 'c.txt:overwrite', 'd.txt:fail']);
});

test('FR-FEX-024 AC-5 (phone band): the progress band names the folder and the remaining count', async () => {
  const h = controllerHarness();
  void h.controller.start({ ...base, sources: [source('a.txt'), source('b.txt')], ask: noAsk, onRejected: () => {} });
  await h.flush();
  h.pending.shift()!.resolve({ name: 'a.txt', path: '/w/components/a.txt', size: 4, skipped: false });
  await h.flush();
  const band = selectMobileUploadBand(h.store.get(), 'ws1');
  assert.equal(band?.text, 'components 에 업로드 중 · 1개 남음');
  assert.equal(selectMobileUploadBand(h.store.get(), 'ws2'), null);
});
