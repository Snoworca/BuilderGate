// One upload from pick or drop to finish (FR-FEX-024): ask the server which names clash and
// which files it refuses, ask the clashes in the window's modal one by one, then send at most
// three files at a time, retrying a failed file once. The job lives in fileTransferStore; the
// File objects and the request controllers live here, keyed by job, so cancel and retry reach
// them. Everything outside is injected, so the flow runs in a test without a network.
// @req FR-FEX-024
// @req FR-FOP-006

import type { DecideAnswer, DecideDetail } from './fileExplorerPorts.ts';
import type { FileTransferAction } from './fileTransferStore.ts';
import { TransferError, type PutFileRequest, type PutFileResult, type UploadCheckRequest, type UploadCheckResult, type UploadConflictMode } from './fileTransferClient.ts';
import { classifyUploadFailure, decideDroppedUpload, keepBothName, topLevelOf } from './fileTransferModel.ts';

export type { PutFileRequest } from './fileTransferClient.ts';

/** FR-FEX-024 AC-1: files in flight at once. */
export const UPLOAD_CONCURRENCY = 3;

export interface UploadSource {
  file: Blob;
  /** Relative to the target folder, '/'-separated; a folder upload keeps its subfolders. */
  relPath: string;
}

export interface UploadStartInput {
  sessionId: string;
  dir: string;
  /** The folder's own name, for labels. */
  dirLabel: string;
  workspaceId: string;
  tabId: string;
  sources: readonly UploadSource[];
  /** Names already in the folder, to name a kept-both folder. */
  existingNames: readonly string[];
  /** Asks one clash in the window's modal (FR-FOP-006). */
  ask: (detail: DecideDetail) => Promise<DecideAnswer>;
  /** FR-FEX-024 AC-8: the refused files, together. */
  onRejected: (items: readonly { path: string; code: string }[]) => void;
}

export interface UploadFinishedEvent {
  jobId: string;
  sessionId: string;
  dir: string;
  workspaceId: string;
  tabId: string;
  /** Top-level names that arrived, as the server named them. */
  arrived: string[];
  failed: number;
}

export interface UploadControllerDeps {
  client: {
    checkUpload: (sessionId: string, request: UploadCheckRequest) => Promise<UploadCheckResult>;
    putFile: (request: PutFileRequest) => Promise<PutFileResult>;
  };
  dispatch: (action: FileTransferAction) => void;
  now: () => number;
  /** When the page last went to the background, or null; a failure after it is an interruption (AC-6). */
  hiddenSince: () => number | null;
  onFinished: (event: UploadFinishedEvent) => void;
  newId: () => string;
  concurrency?: number;
}

interface PlannedFile {
  id: string;
  relPath: string;
  file: Blob;
  conflict: UploadConflictMode;
}

interface LiveJob {
  input: UploadStartInput;
  files: Map<string, PlannedFile>;
  controller: AbortController;
  /** Files that ended failed or interrupted, which 재시도 sends again. */
  failed: Set<string>;
}

export interface UploadController {
  /** Resolves when the job settles; null when nothing was sent (all refused, or the clash was cancelled). */
  start(input: UploadStartInput): Promise<string | null>;
  cancel(jobId: string): void;
  retry(jobId: string): Promise<void>;
  /** The job was dismissed: its files are no longer kept for a retry. */
  forget(jobId: string): void;
}

function matchesTop(relPath: string, path: string): boolean {
  return relPath === path || topLevelOf(relPath) === path;
}

/** @req FR-FEX-024 */
export function createUploadController(deps: UploadControllerDeps): UploadController {
  const live = new Map<string, LiveJob>();
  const concurrency = deps.concurrency ?? UPLOAD_CONCURRENCY;

  async function sendOne(jobId: string, job: LiveJob, planned: PlannedFile, results: Map<string, PutFileResult>): Promise<void> {
    const { input } = job;
    for (let attempts = 1; ; attempts += 1) {
      if (job.controller.signal.aborted) return;
      const startedAt = deps.now();
      deps.dispatch({ type: 'FILE_STATE', jobId, fileId: planned.id, state: 'sending', at: startedAt });
      try {
        const result = await deps.client.putFile({
          sessionId: input.sessionId,
          dir: input.dir,
          path: planned.relPath,
          conflict: planned.conflict,
          body: planned.file,
          signal: job.controller.signal,
          onProgress: (sent) => deps.dispatch({ type: 'FILE_PROGRESS', jobId, fileId: planned.id, sent, at: deps.now() }),
        });
        results.set(planned.id, result);
        job.failed.delete(planned.id);
        deps.dispatch({
          type: 'FILE_STATE',
          jobId,
          fileId: planned.id,
          state: result.skipped ? 'skipped' : 'done',
          resultName: result.name,
          at: deps.now(),
        });
        return;
      } catch (error) {
        if (job.controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) return;
        const status = error instanceof TransferError ? error.status : 0;
        const code = error instanceof TransferError ? error.code : null;
        const hidden = deps.hiddenSince();
        const verdict = classifyUploadFailure({ status, code, hiddenDuringAttempt: hidden !== null && hidden >= startedAt, attempts });
        if (verdict === 'retry' && status === 0) {
          // The drop may have come after the file landed: ask the folder before sending again.
          const outcome = await verifyDropped(job, planned);
          if (job.controller.signal.aborted) return;
          if (outcome === 'arrived') {
            results.set(planned.id, { name: planned.relPath, path: planned.relPath, size: planned.file.size, skipped: false });
            job.failed.delete(planned.id);
            deps.dispatch({ type: 'FILE_STATE', jobId, fileId: planned.id, state: 'done', resultName: planned.relPath, at: deps.now() });
            return;
          }
          if (outcome !== 'retry') {
            job.failed.add(planned.id);
            deps.dispatch({
              type: 'FILE_STATE',
              jobId,
              fileId: planned.id,
              state: 'failed',
              reason: outcome === 'in-the-way' ? 'FILE_ALREADY_EXISTS' : 'UNSURE',
              at: deps.now(),
            });
            return;
          }
        }
        if (verdict === 'retry') {
          deps.dispatch({ type: 'FILE_STATE', jobId, fileId: planned.id, state: 'queued', at: deps.now() });
          continue;
        }
        job.failed.add(planned.id);
        deps.dispatch({
          type: 'FILE_STATE',
          jobId,
          fileId: planned.id,
          state: verdict === 'interrupted' ? 'interrupted' : 'failed',
          reason: verdict === 'interrupted' ? 'INTERRUPTED' : code ?? 'NETWORK',
          at: deps.now(),
        });
        return;
      }
    }
  }

  async function verifyDropped(job: LiveJob, planned: PlannedFile): Promise<ReturnType<typeof decideDroppedUpload>> {
    const nested = planned.relPath !== topLevelOf(planned.relPath);
    const early = decideDroppedUpload({ conflict: planned.conflict, nested, size: planned.file.size, found: null });
    if (early === 'unsure') return early;
    try {
      const check = await deps.client.checkUpload(job.input.sessionId, { dir: job.input.dir, files: [{ path: planned.relPath, size: planned.file.size }] });
      const found = check.conflicts.find((conflict) => conflict.path === planned.relPath)?.existing ?? null;
      return decideDroppedUpload({ conflict: planned.conflict, nested, size: planned.file.size, found });
    } catch {
      return 'unsure';
    }
  }

  async function runQueue(jobId: string, job: LiveJob, queue: PlannedFile[]): Promise<void> {
    const results = new Map<string, PutFileResult>();
    const pending = [...queue];
    const worker = async () => {
      for (let next = pending.shift(); next !== undefined; next = pending.shift()) {
        if (job.controller.signal.aborted) return;
        await sendOne(jobId, job, next, results);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker));
    if (job.controller.signal.aborted) return;
    deps.dispatch({ type: 'UPLOAD_SETTLED', jobId, at: deps.now() });
    const arrived = new Set<string>();
    for (const planned of queue) {
      const result = results.get(planned.id);
      if (result === undefined || result.skipped) continue;
      // The top-level item as it landed; a file right in the folder carries the server's name.
      const top = topLevelOf(planned.relPath);
      arrived.add(planned.relPath === top ? result.name : top);
    }
    const failed = queue.filter((file) => !results.has(file.id)).length;
    deps.onFinished({
      jobId,
      sessionId: job.input.sessionId,
      dir: job.input.dir,
      workspaceId: job.input.workspaceId,
      tabId: job.input.tabId,
      arrived: [...arrived],
      failed,
    });
  }

  async function decideConflicts(input: UploadStartInput, conflicts: UploadCheckResult['conflicts']): Promise<Map<string, 'overwrite' | 'rename' | 'skip'> | null> {
    const decisions = new Map<string, 'overwrite' | 'rename' | 'skip'>();
    let applyAll: 'overwrite' | 'rename' | 'skip' | null = null;
    for (let index = 0; index < conflicts.length; index += 1) {
      const conflict = conflicts[index];
      const offered = conflict.decisions;
      if (applyAll !== null && offered.includes(applyAll)) {
        decisions.set(conflict.path, applyAll);
        continue;
      }
      const incomingFiles = input.sources.filter((source) => matchesTop(source.relPath, conflict.path));
      const isFolder = incomingFiles.some((source) => source.relPath !== conflict.path);
      const answer = await input.ask({
        kind: 'conflict',
        path: conflict.path,
        choices: [...offered],
        folder: input.dirLabel,
        remaining: conflicts.length - index - 1,
        position: { index: index + 1, total: conflicts.length },
        existing: conflict.existing,
        incoming: { size: isFolder ? null : incomingFiles.reduce((sum, source) => sum + source.file.size, 0), isDirectory: isFolder },
      });
      if (answer.kind === 'cancel-job') return null;
      const choice = answer.choice === 'retry' ? 'skip' : answer.choice;
      decisions.set(conflict.path, choice);
      if (answer.applyToAll) applyAll = choice;
    }
    return decisions;
  }

  function plan(
    input: UploadStartInput,
    rejected: ReadonlySet<string>,
    decisions: Map<string, 'overwrite' | 'rename' | 'skip'>,
    proposed: ReadonlyMap<string, string>,
  ): { files: PlannedFile[]; hides: Set<string> } {
    const taken = new Set(input.existingNames);
    const renamedFolders = new Map<string, string>();
    const hides = new Set<string>();
    const files: PlannedFile[] = [];
    for (const source of input.sources) {
      const top = topLevelOf(source.relPath);
      if (rejected.has(source.relPath) || rejected.has(top)) continue;
      const decision = decisions.get(source.relPath) ?? decisions.get(top);
      if (decision === 'skip') continue;
      let relPath = source.relPath;
      let conflict: UploadConflictMode = 'fail';
      const inFolder = source.relPath !== top;
      if (decision === 'overwrite') {
        conflict = 'overwrite';
        hides.add(top);
      } else if (decision === 'rename') {
        if (inFolder) {
          // A kept-both folder takes the server's free name (renameTo); its files then land in a
          // fresh folder with conflict=fail. The listing is only the fallback for an older server.
          const renamed = renamedFolders.get(top) ?? proposed.get(top) ?? keepBothName(top, taken);
          renamedFolders.set(top, renamed);
          taken.add(renamed);
          relPath = `${renamed}${source.relPath.slice(top.length)}`;
        } else {
          conflict = 'rename';
        }
      }
      files.push({ id: deps.newId(), relPath, file: source.file, conflict });
    }
    return { files, hides };
  }

  return {
    async start(input) {
      const check = await deps.client.checkUpload(input.sessionId, {
        dir: input.dir,
        files: input.sources.map((source) => ({ path: source.relPath, size: source.file.size })),
      });
      if (check.rejected.length > 0) input.onRejected(check.rejected);
      const rejected = new Set(check.rejected.map((item) => item.path));
      const decisions = await decideConflicts(input, check.conflicts.filter((conflict) => !rejected.has(conflict.path)));
      if (decisions === null) return null;
      const proposed = new Map(check.conflicts.flatMap((conflict) => (conflict.renameTo === undefined ? [] : [[conflict.path, conflict.renameTo] as const])));
      const { files, hides } = plan(input, rejected, decisions, proposed);
      if (files.length === 0) return null;
      const jobId = deps.newId();
      const job: LiveJob = { input, files: new Map(files.map((file) => [file.id, file])), controller: new AbortController(), failed: new Set() };
      live.set(jobId, job);
      deps.dispatch({
        type: 'UPLOAD_STARTED',
        jobId,
        workspaceId: input.workspaceId,
        tabId: input.tabId,
        sessionId: input.sessionId,
        dir: input.dir,
        dirLabel: input.dirLabel,
        files: files.map((file) => ({ id: file.id, relPath: file.relPath, size: file.file.size, hidesExisting: hides.has(topLevelOf(file.relPath)) })),
        at: deps.now(),
      });
      await runQueue(jobId, job, files);
      return jobId;
    },

    cancel(jobId) {
      const job = live.get(jobId);
      // Aborting each request makes the server drop its temp file (FR-FEX-023 AC-5).
      job?.controller.abort();
      live.delete(jobId);
      deps.dispatch({ type: 'JOB_REMOVED', jobId });
    },

    async retry(jobId) {
      const job = live.get(jobId);
      if (job === undefined) return;
      // FR-FEX-024 AC-3: only what failed goes again; the store knows which.
      const queue = [...job.failed].map((id) => job.files.get(id)).filter((file): file is PlannedFile => file !== undefined);
      if (queue.length === 0) return;
      job.controller = new AbortController();
      deps.dispatch({ type: 'UPLOAD_RETRY', jobId, at: deps.now() });
      await runQueue(jobId, job, queue);
    },

    forget(jobId) {
      live.delete(jobId);
    },
  };
}
