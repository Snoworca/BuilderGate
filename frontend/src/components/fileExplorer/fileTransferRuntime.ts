// The one upload controller and ZIP downloader of the page, wired to the real client, the
// transfer store, the clock and the page's visibility. Components call these functions; the
// flows themselves live in fileUploadController.ts and fileZipDownload.ts, where tests reach them.
// @req FR-FEX-024
// @req FR-FEX-025

import { fileTransferApi } from '../../services/api.ts';
import { createUploadController, type UploadFinishedEvent, type UploadStartInput } from './fileUploadController.ts';
import { createZipDownloader, type ZipStartInput } from './fileZipDownload.ts';
import { dispatchFileTransfer, getFileTransferSnapshot } from './fileTransferStore.ts';

export type FileTransferEvent =
  | ({ type: 'upload-finished' } & UploadFinishedEvent)
  | { type: 'upload-cancelled'; workspaceId: string };

const listeners = new Set<(event: FileTransferEvent) => void>();

/** Every explorer panel listens: a finished upload reloads each view of its folder (FR-FEX-024 AC-7). */
export function subscribeFileTransferEvents(listener: (event: FileTransferEvent) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emit(event: FileTransferEvent): void {
  for (const listener of [...listeners]) listener(event);
}

// FR-FEX-024 AC-6: when the page last went to the background. Installed on first use, so a page
// that never uploads registers nothing.
let hiddenAt: number | null = null;
let tracking = false;
function trackVisibility(): void {
  if (tracking || typeof document === 'undefined') return;
  tracking = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') hiddenAt = Date.now();
  });
}

const DONE_LINGER_MS = 1800;
let sequence = 0;
const newId = () => `ft-${Date.now().toString(36)}-${(sequence += 1).toString(36)}`;

const uploads = createUploadController({
  client: fileTransferApi,
  dispatch: dispatchFileTransfer,
  now: () => Date.now(),
  hiddenSince: () => hiddenAt,
  onFinished: (event) => {
    emit({ type: 'upload-finished', ...event });
    // A clean finish leaves the list after a moment; one with failures stays for 재시도.
    if (event.failed === 0) setTimeout(() => dismissFileTransfer(event.jobId), DONE_LINGER_MS);
  },
  newId,
});

function openUrl(url: string): void {
  // As startFileDownload: a plain link, no download attribute (WebKit ignores a scripted click
  // on one after an await); Content-Disposition makes it a download that keeps the page.
  const link = document.createElement('a');
  link.href = url;
  link.rel = 'noopener';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

const zips = createZipDownloader({
  client: fileTransferApi,
  dispatch: dispatchFileTransfer,
  now: () => performance.now(),
  openUrl,
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  newId,
});

export function startUpload(input: UploadStartInput): Promise<string | null> {
  trackVisibility();
  return uploads.start(input);
}

export function startZipDownload(input: ZipStartInput): Promise<void> {
  return zips.start(input);
}

/** The popover's cancel, for either kind of transfer. */
export function cancelFileTransfer(jobId: string): void {
  const job = getFileTransferSnapshot().jobs[jobId];
  if (job === undefined) return;
  if (job.kind === 'zip') {
    zips.cancel(jobId).catch((error: unknown) => console.warn('[file-transfer] zip cancel failed', jobId, error));
    return;
  }
  uploads.cancel(jobId);
  emit({ type: 'upload-cancelled', workspaceId: job.workspaceId });
}

export function retryFileTransfer(jobId: string): void {
  trackVisibility();
  uploads.retry(jobId).catch((error: unknown) => console.warn('[file-transfer] retry failed', jobId, error));
}

export function dismissFileTransfer(jobId: string): void {
  uploads.forget(jobId);
  dispatchFileTransfer({ type: 'JOB_REMOVED', jobId });
}
