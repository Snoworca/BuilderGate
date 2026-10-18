// The app-wide store of client-side file transfers: uploads and ZIP downloads (#139). They are
// file jobs the browser drives itself, so no server event reaches fileJobStore for them; the
// status bar and the popover read both stores and show one list (FR-FEX-024 AC-1).
//
// Like fileJobStore the reducer is pure and reads no clock: every action that matters for
// speed carries its own `at`, and recency is a sequence number.
// @req FR-FEX-024
// @req FR-FEX-025

import { t, tn } from '../../i18n/i18n.ts';
import { formatTransferBytes, topLevelOf, transferReasonText } from './fileTransferModel.ts';

export type UploadFileState = 'queued' | 'sending' | 'done' | 'skipped' | 'failed' | 'interrupted';

export interface UploadFileEntry {
  readonly id: string;
  readonly relPath: string;
  readonly size: number;
  readonly sent: number;
  readonly state: UploadFileState;
  /** A server code or NETWORK / INTERRUPTED, for the failure line. */
  readonly reason: string | null;
  /** The name the server gave the top-level item (a kept-both rename differs). */
  readonly resultName: string | null;
  /** An overwrite hides the existing row while the new one arrives (FR-FEX-024 AC-4). */
  readonly hidesExisting: boolean;
}

export interface UploadJob {
  readonly kind: 'upload';
  readonly jobId: string;
  readonly workspaceId: string;
  readonly tabId: string;
  readonly sessionId: string;
  readonly dir: string;
  readonly dirLabel: string;
  readonly files: readonly UploadFileEntry[];
  readonly state: 'running' | 'done' | 'partial' | 'cancelled';
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly seq: number;
}

export interface ZipJob {
  readonly kind: 'zip';
  readonly jobId: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly name: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly sentBytes: number;
  /** 'confirm' while the confirm bar asks; the popover does not list it then. */
  readonly state: 'counting' | 'confirm' | 'running' | 'done';
  readonly seq: number;
}

export type TransferJob = UploadJob | ZipJob;

export interface FileTransferState {
  readonly seq: number;
  readonly jobs: Readonly<Record<string, TransferJob>>;
  /**
   * FR-FEX-024 AC-7: uploads that finished since the window last showed, by workspace. Kept
   * apart from the jobs, which leave the list once done, so a minimized window keeps its badge.
   */
  readonly unseen: Readonly<Record<string, number>>;
}

export const initialFileTransferState: FileTransferState = Object.freeze({ seq: 0, jobs: Object.freeze({}), unseen: Object.freeze({}) });

export type FileTransferAction =
  | {
    type: 'UPLOAD_STARTED';
    jobId: string;
    workspaceId: string;
    tabId: string;
    sessionId: string;
    dir: string;
    dirLabel: string;
    files: readonly { id: string; relPath: string; size: number; hidesExisting?: boolean }[];
    at: number;
  }
  | { type: 'FILE_PROGRESS'; jobId: string; fileId: string; sent: number; at: number }
  | { type: 'FILE_STATE'; jobId: string; fileId: string; state: UploadFileState; reason?: string | null; resultName?: string | null; at: number }
  | { type: 'UPLOAD_SETTLED'; jobId: string; at: number }
  | { type: 'UPLOAD_RETRY'; jobId: string; at: number }
  | { type: 'JOB_REMOVED'; jobId: string }
  | { type: 'WORKSPACE_SEEN'; workspaceId: string }
  | { type: 'ZIP_STARTED'; jobId: string; workspaceId: string; sessionId: string; name: string }
  | { type: 'ZIP_COUNTED'; jobId: string; name: string; fileCount: number; totalBytes: number; confirm: boolean }
  | { type: 'ZIP_RUNNING'; jobId: string }
  | { type: 'ZIP_PROGRESS'; jobId: string; sentBytes: number; totalBytes: number }
  | { type: 'ZIP_DONE'; jobId: string };

function withJob(state: FileTransferState, job: TransferJob): FileTransferState {
  return { ...state, jobs: { ...state.jobs, [job.jobId]: job } };
}

function updateUpload(state: FileTransferState, jobId: string, update: (job: UploadJob) => UploadJob): FileTransferState {
  const job = state.jobs[jobId];
  if (job?.kind !== 'upload') return state;
  return withJob(state, update(job));
}

function updateZip(state: FileTransferState, jobId: string, update: (job: ZipJob) => ZipJob): FileTransferState {
  const job = state.jobs[jobId];
  if (job?.kind !== 'zip') return state;
  return withJob(state, update(job));
}

const FAILED_STATES: ReadonlySet<UploadFileState> = new Set(['failed', 'interrupted']);
const OPEN_STATES: ReadonlySet<UploadFileState> = new Set(['queued', 'sending']);

/** @req FR-FEX-024 */
export function fileTransferReducer(state: FileTransferState, action: FileTransferAction): FileTransferState {
  switch (action.type) {
    case 'UPLOAD_STARTED': {
      const seq = state.seq + 1;
      return withJob({ ...state, seq }, {
        kind: 'upload',
        jobId: action.jobId,
        workspaceId: action.workspaceId,
        tabId: action.tabId,
        sessionId: action.sessionId,
        dir: action.dir,
        dirLabel: action.dirLabel,
        files: action.files.map((file) => ({
          id: file.id,
          relPath: file.relPath,
          size: file.size,
          sent: 0,
          state: 'queued',
          reason: null,
          resultName: null,
          hidesExisting: file.hidesExisting === true,
        })),
        state: 'running',
        startedAt: action.at,
        updatedAt: action.at,
        seq,
      });
    }
    case 'FILE_PROGRESS':
      return updateUpload(state, action.jobId, (job) => ({
        ...job,
        updatedAt: action.at,
        files: job.files.map((file) => (file.id === action.fileId ? { ...file, sent: Math.min(file.size, Math.max(0, action.sent)) } : file)),
      }));
    case 'FILE_STATE':
      return updateUpload(state, action.jobId, (job) => ({
        ...job,
        updatedAt: action.at,
        files: job.files.map((file) => (file.id === action.fileId
          ? {
            ...file,
            state: action.state,
            reason: action.reason ?? (FAILED_STATES.has(action.state) ? file.reason : null),
            resultName: action.resultName ?? file.resultName,
            // A finished file counts in full; a queued one again from zero.
            sent: action.state === 'done' || action.state === 'skipped' ? file.size : action.state === 'queued' ? 0 : file.sent,
          }
          : file)),
      }));
    case 'UPLOAD_SETTLED': {
      const job = state.jobs[action.jobId];
      if (job?.kind !== 'upload') return state;
      const next = updateUpload(state, action.jobId, (upload) => ({
        ...upload,
        updatedAt: action.at,
        state: upload.files.some((file) => FAILED_STATES.has(file.state)) ? 'partial' : 'done',
      }));
      return { ...next, unseen: { ...next.unseen, [job.workspaceId]: (next.unseen[job.workspaceId] ?? 0) + 1 } };
    }
    case 'UPLOAD_RETRY':
      return updateUpload(state, action.jobId, (job) => ({
        ...job,
        state: 'running',
        startedAt: action.at,
        updatedAt: action.at,
        files: job.files.map((file) => (FAILED_STATES.has(file.state) ? { ...file, state: 'queued', sent: 0, reason: null } : file)),
      }));
    case 'JOB_REMOVED': {
      if (!(action.jobId in state.jobs)) return state;
      const jobs = { ...state.jobs };
      delete jobs[action.jobId];
      return { ...state, jobs };
    }
    case 'WORKSPACE_SEEN': {
      if (!state.unseen[action.workspaceId]) return state;
      const unseen = { ...state.unseen };
      delete unseen[action.workspaceId];
      return { ...state, unseen };
    }
    case 'ZIP_STARTED': {
      const seq = state.seq + 1;
      return withJob({ ...state, seq }, {
        kind: 'zip',
        jobId: action.jobId,
        workspaceId: action.workspaceId,
        sessionId: action.sessionId,
        name: action.name,
        fileCount: 0,
        totalBytes: 0,
        sentBytes: 0,
        state: 'counting',
        seq,
      });
    }
    case 'ZIP_COUNTED':
      return updateZip(state, action.jobId, (job) => ({
        ...job,
        name: action.name,
        fileCount: action.fileCount,
        totalBytes: action.totalBytes,
        state: action.confirm ? 'confirm' : job.state,
      }));
    case 'ZIP_RUNNING':
      return updateZip(state, action.jobId, (job) => ({ ...job, state: 'running', sentBytes: 0 }));
    case 'ZIP_PROGRESS':
      return updateZip(state, action.jobId, (job) => ({
        ...job,
        sentBytes: action.sentBytes,
        totalBytes: action.totalBytes > 0 ? action.totalBytes : job.totalBytes,
      }));
    case 'ZIP_DONE':
      return updateZip(state, action.jobId, (job) => ({ ...job, state: 'done', sentBytes: job.totalBytes }));
    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

function uploads(state: FileTransferState): UploadJob[] {
  return Object.values(state.jobs).filter((job): job is UploadJob => job.kind === 'upload');
}

function byRecency<T extends { seq: number }>(jobs: T[]): T[] {
  return [...jobs].sort((a, b) => b.seq - a.seq);
}

/** FR-FEX-024 AC-5/AC-6: the leave warning and the wake lock exist only while this is true. */
export function selectUploadRunning(state: FileTransferState): boolean {
  return uploads(state).some((job) => job.state === 'running');
}

/** Files still to send in running uploads, of one workspace's window or of all. */
export function selectRunningUploadCount(state: FileTransferState, workspaceId?: string): number {
  return uploads(state)
    .filter((job) => job.state === 'running' && (workspaceId === undefined || job.workspaceId === workspaceId))
    .reduce((sum, job) => sum + job.files.filter((file) => OPEN_STATES.has(file.state)).length, 0);
}

export interface PendingUploadRow {
  key: string;
  /** The top-level name that will land in the folder. */
  name: string;
  fraction: number;
  hidesExisting: boolean;
}

function sameDir(a: string, b: string): boolean {
  const trim = (p: string) => p.replace(/[\\/]+$/, '') || p;
  return trim(a) === trim(b);
}

/**
 * FR-FEX-024 AC-2: the dimmed rows a folder's list shows at its bottom — one per top-level
 * item still arriving, a folder upload once for its folder.
 */
export function selectPendingUploadRows(state: FileTransferState, sessionId: string, dir: string): PendingUploadRow[] {
  const rows: PendingUploadRow[] = [];
  for (const job of byRecency(uploads(state)).reverse()) {
    if (job.state !== 'running' || job.sessionId !== sessionId || !sameDir(job.dir, dir)) continue;
    const groups = new Map<string, { size: number; sent: number; open: boolean; hidesExisting: boolean }>();
    for (const file of job.files) {
      if (file.state === 'skipped' || FAILED_STATES.has(file.state)) continue;
      const name = topLevelOf(file.relPath);
      const group = groups.get(name) ?? { size: 0, sent: 0, open: false, hidesExisting: false };
      group.size += file.size;
      group.sent += file.sent;
      group.open ||= OPEN_STATES.has(file.state);
      group.hidesExisting ||= file.hidesExisting;
      groups.set(name, group);
    }
    for (const [name, group] of groups) {
      if (!group.open) continue;
      rows.push({ key: `${job.jobId}:${name}`, name, fraction: group.size > 0 ? Math.min(1, group.sent / group.size) : 0, hidesExisting: group.hidesExisting });
    }
  }
  return rows;
}

export interface TransferFailureView {
  name: string;
  reason: string;
}

export interface FileTransferJobRow {
  jobId: string;
  kind: 'upload' | 'zip';
  /** 'running' while it moves, 'warn' when files failed, 'done' when it finished cleanly. */
  tone: 'running' | 'warn' | 'done';
  title: string;
  fraction: number;
  indeterminate: boolean;
  /** The file being sent now: `i/n · name`. */
  detail: string | null;
  /** `sent / total · speed/s`. */
  bytes: string | null;
  failed: TransferFailureView[];
  canCancel: boolean;
  canRetry: boolean;
  canDismiss: boolean;
}

function uploadRow(job: UploadJob, now: number): FileTransferJobRow {
  const total = job.files.reduce((sum, file) => sum + file.size, 0);
  const sent = job.files.reduce((sum, file) => sum + file.sent, 0);
  const failedFiles = job.files.filter((file) => FAILED_STATES.has(file.state));
  const failed = failedFiles.map((file) => ({
    name: file.relPath,
    reason: transferReasonText(file.state === 'interrupted' ? 'INTERRUPTED' : file.reason ?? 'NETWORK'),
  }));
  const running = job.state === 'running';
  const currentIndex = job.files.findIndex((file) => file.state === 'sending');
  const current = currentIndex === -1 ? null : job.files[currentIndex];
  const seconds = Math.max(0.1, (Math.max(now, job.updatedAt) - job.startedAt) / 1000);
  const count = job.files.length;
  const title = running
    ? tn('fileTransfer.job.upload', count, { folder: job.dirLabel })
    : failed.length > 0
      ? tn('fileTransfer.job.partial', failed.length, { folder: job.dirLabel })
      : t('fileTransfer.job.done', { folder: job.dirLabel });
  return {
    jobId: job.jobId,
    kind: 'upload',
    tone: running ? 'running' : failed.length > 0 ? 'warn' : 'done',
    title,
    fraction: total > 0 ? Math.min(1, sent / total) : running ? 0 : 1,
    indeterminate: false,
    detail: running && current !== null
      ? t('fileTransfer.job.current', { index: currentIndex + 1, total: count, name: current.relPath })
      : null,
    bytes: running
      ? t('fileTransfer.job.bytes', { sent: formatTransferBytes(sent), total: formatTransferBytes(total), speed: formatTransferBytes(sent / seconds) })
      : null,
    failed,
    canCancel: running,
    canRetry: !running && failed.length > 0,
    canDismiss: !running,
  };
}

function zipRow(job: ZipJob): FileTransferJobRow {
  const counting = job.state === 'counting';
  return {
    jobId: job.jobId,
    kind: 'zip',
    tone: job.state === 'done' ? 'done' : 'running',
    title: counting ? t('fileTransfer.zip.counting', { name: job.name }) : job.name,
    fraction: job.totalBytes > 0 ? Math.min(1, job.sentBytes / job.totalBytes) : job.state === 'done' ? 1 : 0,
    indeterminate: counting,
    detail: counting
      ? t('fileTransfer.zip.countingDetail')
      : job.state === 'done' ? t('fileTransfer.zip.done') : tn('fileTransfer.zip.detail', job.fileCount),
    bytes: counting ? null : `${formatTransferBytes(job.sentBytes)} / ${formatTransferBytes(job.totalBytes)}`,
    failed: [],
    canCancel: job.state === 'running',
    canRetry: false,
    canDismiss: false,
  };
}

/** The popover rows for client-side transfers, most recent first. @req FR-FEX-024 @req FR-FEX-025 */
export function selectTransferJobRows(state: FileTransferState, now: number): FileTransferJobRow[] {
  return byRecency(Object.values(state.jobs))
    .filter((job) => !(job.kind === 'zip' && job.state === 'confirm'))
    .map((job) => (job.kind === 'upload' ? uploadRow(job, now) : zipRow(job)));
}

/** FR-FEX-024 AC-7: finished uploads a window has not shown yet. */
export function selectTrayBadge(state: FileTransferState, workspaceId: string): number {
  return state.unseen[workspaceId] ?? 0;
}

export interface MobileUploadBand {
  jobId: string;
  text: string;
  fraction: number;
}

/** FR-FEX-026 AC-5: the phone's progress band for the latest running upload of a window. */
export function selectMobileUploadBand(state: FileTransferState, workspaceId: string): MobileUploadBand | null {
  const [job] = byRecency(uploads(state).filter((candidate) => candidate.state === 'running' && candidate.workspaceId === workspaceId));
  if (job === undefined) return null;
  const remaining = job.files.filter((file) => OPEN_STATES.has(file.state)).length;
  const total = job.files.reduce((sum, file) => sum + file.size, 0);
  const sent = job.files.reduce((sum, file) => sum + file.sent, 0);
  return {
    jobId: job.jobId,
    text: tn('fileTransfer.band.uploading', remaining, { folder: job.dirLabel }),
    fraction: total > 0 ? Math.min(1, sent / total) : 0,
  };
}

/** Running uploads of one window, for its close confirm. */
export function selectRunningUploadJobIds(state: FileTransferState, workspaceId: string): string[] {
  return uploads(state).filter((job) => job.state === 'running' && job.workspaceId === workspaceId).map((job) => job.jobId);
}

// ---------------------------------------------------------------------------
// Module store (useSyncExternalStore)
// ---------------------------------------------------------------------------

let current: FileTransferState = initialFileTransferState;
const listeners = new Set<() => void>();

export function getFileTransferSnapshot(): FileTransferState {
  return current;
}

export function dispatchFileTransfer(action: FileTransferAction): void {
  const next = fileTransferReducer(current, action);
  if (next === current) return;
  current = next;
  for (const listener of [...listeners]) listener();
}

export function subscribeFileTransfers(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
