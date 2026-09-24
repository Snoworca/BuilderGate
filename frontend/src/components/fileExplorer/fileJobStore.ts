// The app-wide file-job store. A job outlives the explorer window that started
// it: closing or minimizing that window must neither lose the job's progress
// nor drop the question it is waiting on. So jobs live here, keyed by id, and
// windows only read them through selectors; the question is asked again when
// the window that started the job is shown again (FR-FEX-009).
//
// It also carries the attribution rules the removed per-panel ownership
// object kept: every file-job event reaches every client and races the POST
// that started the job, so a question or a finish that arrives before JOB_STARTED is held,
// only the window that started a job is asked, and a finish withdraws the
// question. Unlike that object the store never cancels a job because a
// window went away -- that rule is exactly what FR-FEX-009 replaces.
//
// The reducer is pure and reads no clock: recency is a sequence number, so the
// order of events is the order of dispatch and can be staged in tests.
// The store deliberately knows nothing about window records; a window close
// handler that could reach it would be tempted to drop jobs with the window.
// @req FR-FEX-008
// @req FR-FEX-009

import type { FileJobRoute } from './fileJobEvents.ts';
import type { FileJobChoice, FileJobProgress } from './fileExplorerPorts.ts';

export type FileJobOperation = 'copy' | 'move' | 'delete';
export type FileJobOutcome = 'completed' | 'cancelled' | 'failed';
export type FileJobDecideRoute = Extract<FileJobRoute, { kind: 'decide' }>;
export type FileJobProgressRoute = Extract<FileJobRoute, { kind: 'progress' }>;

export interface FileJobEntry {
  readonly jobId: string;
  /** The session whose envelope first named the job (the source session when known). */
  readonly sessionId: string;
  readonly destSessionId: string | null;
  readonly operation: FileJobOperation | null;
  /** Workspace of the window that started the job; null while nobody here has claimed it. */
  readonly workspaceId: string | null;
  /** The explorer tab that started the job, so its failure is shown there; null when only a list named it. */
  readonly originTabId: string | null;
  /** True once JOB_STARTED named the origin; a session lookup only fills a gap until then. */
  readonly claimed: boolean;
  readonly startedSeq: number;
  readonly progress: FileJobProgress | null;
  readonly pending: FileJobDecideRoute | null;
  /** The last decision this client answered, so a re-sent copy of it is not asked again. */
  readonly answeredDecisionId: string | null;
}

export interface FileJobEarlyDone {
  readonly jobId: string;
  readonly outcome: FileJobOutcome;
  readonly errorCode?: string;
}

export interface FileJobFailure {
  readonly jobId: string;
  readonly workspaceId: string;
  /** The explorer tab that started the job, or null when it is not known. */
  readonly tabId: string | null;
  readonly errorCode?: string;
}

export interface FileJobStoreState {
  readonly seq: number;
  readonly jobs: Readonly<Record<string, FileJobEntry>>;
  /** Finishes of jobs nobody here has claimed yet (possibly another client's). */
  readonly earlyDone: readonly FileJobEarlyDone[];
  /** Ids that finished, so a late event from the job's other session envelope cannot revive it. */
  readonly finished: readonly string[];
  readonly failures: readonly FileJobFailure[];
}

// Other clients' finishes land in earlyDone and are never claimed, so it is cut
// by count, oldest first. It only has to cover the time between the server
// accepting a job and its 202 reaching this client.
export const EARLY_DONE_LIMIT = 64;
export const FINISHED_LIMIT = 256;
export const FAILURE_LIMIT = 64;

export const initialFileJobStoreState: FileJobStoreState = Object.freeze({
  seq: 0,
  jobs: Object.freeze({}),
  earlyDone: Object.freeze([]),
  finished: Object.freeze([]),
  failures: Object.freeze([]),
});

/** One element of GET /api/file-jobs: FileJobSummary plus the pending decision payload. */
export interface FileJobListedJob {
  readonly jobId: string;
  readonly sourceSessionId: string;
  readonly destSessionId: string;
  readonly operation: FileJobOperation;
  readonly state: string;
  readonly pendingDecision: {
    readonly jobId: string;
    readonly decisionId: string;
    readonly kind: 'conflict' | 'error';
    readonly path: string;
    readonly detail: string | null;
    readonly choices: readonly FileJobChoice[];
  } | null;
}

export type FileJobStoreAction =
  | { type: 'JOB_STARTED'; jobId: string; sessionId: string; origin: { workspaceId: string; tabId: string }; operation: FileJobOperation }
  | { type: 'PROGRESS'; route: FileJobProgressRoute }
  | { type: 'DECISION_REQUIRED'; route: FileJobDecideRoute }
  | { type: 'DECISION_ANSWERED'; jobId: string; decisionId: string }
  | { type: 'DONE'; jobId: string; sessionId: string; outcome: FileJobOutcome; errorCode?: string }
  | {
    type: 'SYNC_LIST';
    sessionId?: string;
    /** The store's seq when the list was requested; entries started after it are not reaped. */
    sinceSeq?: number;
    jobs: readonly FileJobListedJob[];
    workspaceOfSession: Readonly<Record<string, string>>;
  }
  | { type: 'FAILURE_SHOWN'; jobId: string };

function withoutJob(jobs: Readonly<Record<string, FileJobEntry>>, jobId: string): Record<string, FileJobEntry> {
  const next = { ...jobs };
  delete next[jobId];
  return next;
}

function withFinished(finished: readonly string[], jobId: string): readonly string[] {
  if (finished.includes(jobId)) return finished;
  return [...finished, jobId].slice(-FINISHED_LIMIT);
}

function addFailure(failures: readonly FileJobFailure[], failure: FileJobFailure): readonly FileJobFailure[] {
  // The same job's done arrives once per session envelope; report it once.
  if (failures.some((f) => f.jobId === failure.jobId)) return failures;
  // A failure is dropped only when its window shows it; a window that never returns must not grow this forever.
  return [...failures, failure].slice(-FAILURE_LIMIT);
}

function freshEntry(jobId: string, sessionId: string, seq: number): FileJobEntry {
  return {
    jobId,
    sessionId,
    destSessionId: null,
    operation: null,
    workspaceId: null,
    originTabId: null,
    claimed: false,
    startedSeq: seq,
    progress: null,
    pending: null,
    answeredDecisionId: null,
  };
}

function progressOf(route: FileJobProgressRoute): FileJobProgress {
  return {
    sessionId: route.sessionId,
    jobId: route.jobId,
    phase: route.phase,
    processedBytes: route.processedBytes,
    totalBytes: route.totalBytes,
    processedEntries: route.processedEntries,
    totalEntries: route.totalEntries,
    currentPath: route.currentPath,
  };
}

function isFinished(state: FileJobStoreState, jobId: string): boolean {
  return state.finished.includes(jobId) || state.earlyDone.some((e) => e.jobId === jobId);
}

/** @req FR-FEX-008 */
export function fileJobStoreReducer(state: FileJobStoreState, action: FileJobStoreAction): FileJobStoreState {
  switch (action.type) {
    case 'JOB_STARTED': {
      const early = state.earlyDone.find((e) => e.jobId === action.jobId);
      if (early !== undefined) {
        // Already over before the POST returned: report a failure to the window that
        // started it, and never list it as running, since no later done would remove it.
        const failures = early.outcome === 'failed'
          ? addFailure(state.failures, {
            jobId: action.jobId,
            workspaceId: action.origin.workspaceId,
            tabId: action.origin.tabId,
            errorCode: early.errorCode,
          })
          : state.failures;
        return {
          ...state,
          jobs: action.jobId in state.jobs ? withoutJob(state.jobs, action.jobId) : state.jobs,
          earlyDone: state.earlyDone.filter((e) => e !== early),
          finished: withFinished(state.finished, action.jobId),
          failures,
        };
      }
      if (state.finished.includes(action.jobId)) return state;
      const prev = state.jobs[action.jobId];
      if (prev?.claimed === true) return state;
      const seq = state.seq + 1;
      // Recency is the order JOB_STARTED arrived, even for a job events had announced earlier.
      const base = prev ?? freshEntry(action.jobId, action.sessionId, seq);
      const entry: FileJobEntry = {
        ...base,
        sessionId: action.sessionId,
        operation: action.operation,
        workspaceId: action.origin.workspaceId,
        originTabId: action.origin.tabId,
        claimed: true,
        startedSeq: seq,
      };
      return { ...state, seq, jobs: { ...state.jobs, [action.jobId]: entry } };
    }

    case 'PROGRESS': {
      const { route } = action;
      if (isFinished(state, route.jobId)) return state;
      const prev = state.jobs[route.jobId];
      let seq = state.seq;
      const base = prev ?? freshEntry(route.jobId, route.sessionId, (seq += 1));
      return { ...state, seq, jobs: { ...state.jobs, [route.jobId]: { ...base, progress: progressOf(route) } } };
    }

    case 'DECISION_REQUIRED': {
      const { route } = action;
      if (isFinished(state, route.jobId)) return state;
      const prev = state.jobs[route.jobId];
      // A re-sent question (the second session envelope, or GET's resend on reconnect)
      // must change nothing, or the window would put the same modal up again.
      if (prev !== undefined && (prev.pending?.decisionId === route.decisionId || prev.answeredDecisionId === route.decisionId)) {
        return state;
      }
      let seq = state.seq;
      const base = prev ?? freshEntry(route.jobId, route.sessionId, (seq += 1));
      return { ...state, seq, jobs: { ...state.jobs, [route.jobId]: { ...base, pending: route } } };
    }

    case 'DECISION_ANSWERED': {
      const job = state.jobs[action.jobId];
      // A late answer to an older decision must not remove the job's newer question.
      if (job?.pending == null || job.pending.decisionId !== action.decisionId) return state;
      return {
        ...state,
        jobs: { ...state.jobs, [action.jobId]: { ...job, pending: null, answeredDecisionId: action.decisionId } },
      };
    }

    case 'DONE': {
      const job = state.jobs[action.jobId];
      if (job?.workspaceId != null) {
        const failures = action.outcome === 'failed'
          ? addFailure(state.failures, {
            jobId: action.jobId,
            workspaceId: job.workspaceId,
            tabId: job.originTabId,
            errorCode: action.errorCode,
          })
          : state.failures;
        return {
          ...state,
          jobs: withoutJob(state.jobs, action.jobId),
          finished: withFinished(state.finished, action.jobId),
          failures,
        };
      }
      // The second envelope of a finish already handled.
      if (isFinished(state, action.jobId)) {
        return job === undefined ? state : { ...state, jobs: withoutJob(state.jobs, action.jobId) };
      }
      // Possibly this client's job whose POST has not returned yet.
      const earlyDone = [...state.earlyDone, { jobId: action.jobId, outcome: action.outcome, errorCode: action.errorCode }]
        .slice(-EARLY_DONE_LIMIT);
      return { ...state, jobs: job === undefined ? state.jobs : withoutJob(state.jobs, action.jobId), earlyDone };
    }

    case 'SYNC_LIST': {
      let seq = state.seq;
      const listed = new Set(action.jobs.map((j) => j.jobId));
      const jobs: Record<string, FileJobEntry> = {};
      // A done lost while the socket was down would otherwise keep a job on the
      // status bar forever: reap what the server no longer lists, within the list's scope.
      // A job started after the list was requested cannot be in it yet, so it is kept.
      for (const [jobId, job] of Object.entries(state.jobs)) {
        const inScope = action.sessionId === undefined || job.sessionId === action.sessionId || job.destSessionId === action.sessionId;
        const newerThanList = action.sinceSeq !== undefined && job.startedSeq > action.sinceSeq;
        if (!inScope || listed.has(jobId) || newerThanList) jobs[jobId] = job;
      }
      for (const item of action.jobs) {
        // The snapshot can predate a done the socket already delivered (held in earlyDone
        // while unclaimed); adopting it again would leave a job no later done removes.
        if (isFinished(state, item.jobId)) continue;
        const prev = jobs[item.jobId];
        // After a reload no JOB_STARTED exists; the session's workspace is the best owner we have.
        // Only for a job this list names first: one already heard over the socket and never
        // claimed may be another client's, since every client hears every job.
        const workspaceId = prev === undefined
          ? action.workspaceOfSession[item.sourceSessionId] ?? action.workspaceOfSession[item.destSessionId] ?? null
          : prev.workspaceId;
        const pd = item.pendingDecision;
        const listedPending: FileJobDecideRoute | null = pd === null || pd.decisionId === prev?.answeredDecisionId
          ? null
          : {
            kind: 'decide',
            sessionId: item.sourceSessionId,
            jobId: item.jobId,
            decisionId: pd.decisionId,
            detail: { kind: pd.kind, path: pd.path, choices: [...pd.choices] },
          };
        jobs[item.jobId] = {
          ...(prev ?? freshEntry(item.jobId, item.sourceSessionId, (seq += 1))),
          destSessionId: item.destSessionId,
          operation: item.operation,
          workspaceId,
          // The list is a snapshot taken before the response arrived; a question the socket
          // delivered after it is kept, since losing it would leave the job waiting forever.
          pending: listedPending ?? prev?.pending ?? null,
        };
      }
      return { ...state, seq, jobs };
    }

    case 'FAILURE_SHOWN': {
      if (!state.failures.some((f) => f.jobId === action.jobId)) return state;
      return { ...state, failures: state.failures.filter((f) => f.jobId !== action.jobId) };
    }

    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

const OPERATION_LABEL: Record<FileJobOperation, string> = { copy: '복사', move: '이동', delete: '삭제' };
export const AWAITING_LABEL = '응답 대기 중';

export interface FileJobProgressRowView {
  jobId: string;
  label: string;
  fraction: number;
  indeterminate: boolean;
  processedEntries: number;
  totalEntries: number;
  moreCount: number;
}

export interface FileJobAwaiting {
  workspaceId: string;
  jobId: string;
  label: string;
}

export type FileJobStatusBarView =
  | { kind: 'hidden' }
  | { kind: 'single'; jobId: string; fraction: number; indeterminate: boolean; currentFile: string | null; awaiting: FileJobAwaiting | null }
  | { kind: 'multiple'; count: number; spinner: true; awaiting: FileJobAwaiting | null };

export interface FileJobPopoverRow {
  jobId: string;
  label: string;
  fraction: number;
  indeterminate: boolean;
  /** The job is waiting on a question. */
  awaiting: boolean;
}

/** A row whose operation is not known yet (a job only heard over the socket) still says what it is. */
export const UNKNOWN_JOB_LABEL = '파일 작업';

// Display only: the last name in either separator style. Path policy stays on the server.
function lastSegment(path: string): string {
  const parts = path.split(/[\\/]/).filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? path;
}

function fractionOf(job: FileJobEntry): number {
  const p = job.progress;
  // Empty files report totalBytes 0; a NaN width would draw nothing.
  if (p === null || !(p.totalBytes > 0)) return 0;
  return Math.min(1, Math.max(0, p.processedBytes / p.totalBytes));
}

function indeterminateOf(job: FileJobEntry): boolean {
  // Before any progress the phase is unknown: spin rather than draw an empty bar.
  return job.progress === null || job.progress.phase === 'scanning';
}

function labelOf(job: FileJobEntry): string {
  return job.operation === null ? '' : OPERATION_LABEL[job.operation];
}

function byRecency(jobs: Iterable<FileJobEntry>): FileJobEntry[] {
  return [...jobs].sort((a, b) => b.startedSeq - a.startedSeq);
}

/** Jobs started by the window of `workspaceId`, most recent first. @req FR-FEX-008 */
export function selectWindowJobs(state: FileJobStoreState, workspaceId: string): FileJobEntry[] {
  return byRecency(Object.values(state.jobs).filter((job) => job.workspaceId === workspaceId));
}

/** @req FR-FEX-008 */
export function selectProgressRowView(jobs: readonly FileJobEntry[]): FileJobProgressRowView | null {
  const [latest] = byRecency(jobs);
  if (latest === undefined) return null;
  return {
    jobId: latest.jobId,
    label: labelOf(latest),
    fraction: fractionOf(latest),
    indeterminate: indeterminateOf(latest),
    processedEntries: latest.progress?.processedEntries ?? 0,
    totalEntries: latest.progress?.totalEntries ?? 0,
    moreCount: jobs.length - 1,
  };
}

/** @req FR-FEX-008 @req FR-FEX-009 */
export function selectStatusBarView(state: FileJobStoreState): FileJobStatusBarView {
  const jobs = byRecency(Object.values(state.jobs));
  const [only] = jobs;
  if (only === undefined) return { kind: 'hidden' };
  // Only a question some window here can answer gets the button that opens that window.
  const waiting = jobs.find((job) => job.pending !== null && job.workspaceId !== null);
  const awaiting = waiting === undefined || waiting.workspaceId === null
    ? null
    : { workspaceId: waiting.workspaceId, jobId: waiting.jobId, label: AWAITING_LABEL };
  if (jobs.length === 1) {
    // Before any progress arrives, a job stopped on a question is about that file.
    const path = only.progress?.currentPath ?? only.pending?.detail.path ?? null;
    return {
      kind: 'single',
      jobId: only.jobId,
      fraction: fractionOf(only),
      indeterminate: indeterminateOf(only),
      currentFile: path === null ? null : lastSegment(path),
      awaiting,
    };
  }
  return { kind: 'multiple', count: jobs.length, spinner: true, awaiting };
}

/** @req FR-FEX-008 */
export function selectPopoverRows(state: FileJobStoreState): FileJobPopoverRow[] {
  return byRecency(Object.values(state.jobs)).map((job) => ({
    jobId: job.jobId,
    label: job.operation === null ? UNKNOWN_JOB_LABEL : labelOf(job),
    fraction: fractionOf(job),
    indeterminate: indeterminateOf(job),
    awaiting: job.pending !== null,
  }));
}

/** Questions the window of `workspaceId` must ask; nobody is asked for an unclaimed job. @req FR-FEX-009 */
export function selectPendingDecisionsForWindow(state: FileJobStoreState, workspaceId: string): FileJobDecideRoute[] {
  return selectWindowJobs(state, workspaceId).flatMap((job) => (job.pending === null ? [] : [job.pending]));
}

/** @req FR-FEX-009 */
export function selectWindowFailures(state: FileJobStoreState, workspaceId: string): FileJobFailure[] {
  return state.failures.filter((failure) => failure.workspaceId === workspaceId);
}

export function selectStoreSize(state: FileJobStoreState): { jobs: number; earlyDone: number; finished: number; failures: number } {
  return {
    jobs: Object.keys(state.jobs).length,
    earlyDone: state.earlyDone.length,
    finished: state.finished.length,
    failures: state.failures.length,
  };
}

/**
 * The status bar toggles the popover itself, so a press on it is not an outside
 * press: closing on its pointerdown would reopen the popover on the click.
 * @req FR-FEX-008
 */
export function decidePopoverOutsideClose(inPopover: boolean, inStatusBar: boolean): boolean {
  return !inPopover && !inStatusBar;
}

// ---------------------------------------------------------------------------
// Module store (useSyncExternalStore)
// ---------------------------------------------------------------------------

let current: FileJobStoreState = initialFileJobStoreState;
const listeners = new Set<() => void>();

/** Same object until something changes, as useSyncExternalStore requires. */
export function getFileJobSnapshot(): FileJobStoreState {
  return current;
}

/** @req FR-FEX-009 */
export function dispatchFileJob(action: FileJobStoreAction): void {
  const next = fileJobStoreReducer(current, action);
  // A no-op keeps the snapshot and wakes nobody, so re-sent events cost no render.
  if (next === current) return;
  current = next;
  for (const listener of [...listeners]) listener();
}

export function subscribeFileJobs(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
