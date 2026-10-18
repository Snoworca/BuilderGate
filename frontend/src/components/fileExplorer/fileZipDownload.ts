// Several items, or a directory, downloaded as one ZIP the server streams (FR-FEX-025): a
// pre-count first; a small and quick one is fetched at once, a large or slow one waits for 받기
// on the confirm bar, so the token is never issued for a download the user did not start. The
// stream is a plain link like FR-FEX-021, and the job follows the server's byte count.
// @req FR-FEX-025

import type { FileTransferAction } from './fileTransferStore.ts';
import type { ZipJobStatus, ZipPrecount, ZipToken } from './fileTransferClient.ts';

export const ZIP_CONFIRM_BYTES = 1024 ** 3;
export const ZIP_CONFIRM_FILES = 10_000;
export const ZIP_CONFIRM_MS = 1000;
export const ZIP_POLL_MS = 500;

/** FR-FEX-025 AC-2: over 1 GiB, over 10,000 files, or a pre-count slower than 1 s asks first. */
export function decideZipConfirm(input: { totalBytes: number; fileCount: number; elapsedMs: number }): 'direct' | 'confirm' {
  return input.totalBytes > ZIP_CONFIRM_BYTES || input.fileCount > ZIP_CONFIRM_FILES || input.elapsedMs > ZIP_CONFIRM_MS
    ? 'confirm'
    : 'direct';
}

export interface ZipDownloaderDeps {
  client: {
    zipPrecount: (sessionId: string, paths: readonly string[]) => Promise<ZipPrecount>;
    zipToken: (sessionId: string, paths: readonly string[]) => Promise<ZipToken>;
    zipJob: (sessionId: string, jobId: string) => Promise<ZipJobStatus>;
    zipCancel: (sessionId: string, jobId: string) => Promise<void>;
  };
  dispatch: (action: FileTransferAction) => void;
  now: () => number;
  /** Hands the browser the token URL (a link click, as startFileDownload does). */
  openUrl: (url: string) => void;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  newId: () => string;
}

export interface ZipStartInput {
  sessionId: string;
  workspaceId: string;
  paths: readonly string[];
  /** The confirm bar: name, size, count and what is left out; true on 받기. */
  confirm: (summary: ZipPrecount) => Promise<boolean>;
}

export interface ZipDownloader {
  start(input: ZipStartInput): Promise<void>;
  cancel(jobId: string): Promise<void>;
}

interface LiveZip {
  sessionId: string;
  serverJobId: string | null;
  timer: unknown;
  stopped: boolean;
}

/** @req FR-FEX-025 */
export function createZipDownloader(deps: ZipDownloaderDeps): ZipDownloader {
  const live = new Map<string, LiveZip>();

  const stop = (jobId: string) => {
    const zip = live.get(jobId);
    if (zip === undefined) return;
    zip.stopped = true;
    if (zip.timer !== null) deps.clearTimer(zip.timer);
    live.delete(jobId);
  };

  const poll = (jobId: string) => {
    const zip = live.get(jobId);
    if (zip === undefined || zip.stopped || zip.serverJobId === null) return;
    zip.timer = deps.setTimer(() => {
      void (async () => {
        if (zip.stopped || zip.serverJobId === null) return;
        try {
          const status = await deps.client.zipJob(zip.sessionId, zip.serverJobId);
          if (zip.stopped) return;
          if (status.state === 'done' || status.state === 'gone') {
            deps.dispatch({ type: 'ZIP_DONE', jobId });
            stop(jobId);
            // The finished line stays a moment so the user sees it was handed over.
            deps.setTimer(() => deps.dispatch({ type: 'JOB_REMOVED', jobId }), 1500);
            return;
          }
          if (status.state === 'cancelled' || status.state === 'failed') {
            stop(jobId);
            deps.dispatch({ type: 'JOB_REMOVED', jobId });
            return;
          }
          deps.dispatch({ type: 'ZIP_PROGRESS', jobId, sentBytes: status.sentBytes, totalBytes: status.totalBytes });
        } catch {
          // A missed poll is not the end of the stream; the next one reads it again.
        }
        poll(jobId);
      })();
    }, ZIP_POLL_MS);
  };

  return {
    async start(input) {
      const jobId = deps.newId();
      const zip: LiveZip = { sessionId: input.sessionId, serverJobId: null, timer: null, stopped: false };
      live.set(jobId, zip);
      deps.dispatch({ type: 'ZIP_STARTED', jobId, workspaceId: input.workspaceId, sessionId: input.sessionId, name: '' });
      try {
        const startedAt = deps.now();
        const precount = await deps.client.zipPrecount(input.sessionId, input.paths);
        const ask = decideZipConfirm({ totalBytes: precount.totalBytes, fileCount: precount.fileCount, elapsedMs: deps.now() - startedAt }) === 'confirm';
        deps.dispatch({ type: 'ZIP_COUNTED', jobId, name: precount.name, fileCount: precount.fileCount, totalBytes: precount.totalBytes, confirm: ask });
        if (ask && !(await input.confirm(precount))) {
          stop(jobId);
          deps.dispatch({ type: 'JOB_REMOVED', jobId });
          return;
        }
        if (zip.stopped) return;
        // FR-FEX-025 AC-3: the token only now, when the transfer starts.
        const token = await deps.client.zipToken(input.sessionId, input.paths);
        if (zip.stopped) return;
        zip.serverJobId = token.jobId;
        deps.dispatch({ type: 'ZIP_RUNNING', jobId });
        deps.openUrl(token.url);
        poll(jobId);
      } catch (error) {
        stop(jobId);
        deps.dispatch({ type: 'JOB_REMOVED', jobId });
        throw error;
      }
    },

    async cancel(jobId) {
      const zip = live.get(jobId);
      if (zip === undefined) return;
      const serverJobId = zip.serverJobId;
      stop(jobId);
      deps.dispatch({ type: 'JOB_REMOVED', jobId });
      // FR-FEX-025 AC-6: cancelling ends the stream on the server.
      if (serverJobId !== null) await deps.client.zipCancel(zip.sessionId, serverJobId);
    },
  };
}
