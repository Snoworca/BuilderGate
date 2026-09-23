// Which explorer panel a file job's events belong to. Every panel on a session
// receives every file-job event, and those events race the POST that started
// the job: a question or even the finish can arrive before submit() returns the
// job id. So a panel keeps what it cannot yet attribute, and settles it when
// its own submit claims the id.
//
// Pure and React-free, with every effect injected, so the orderings can be
// staged by hand in tests and the app-wide job store planned for fx-step4
// (PH-003) can absorb this as it is.
// @req FR-FEX-005
// @req FR-FEX-001

import type { FileJobRoute } from './fileJobEvents.ts';

export type FileJobDecideRoute = Extract<FileJobRoute, { kind: 'decide' }>;

export interface FileJobDoneEvent {
  jobId: string;
  outcome: 'completed' | 'cancelled' | 'failed';
  errorCode?: string;
}

export interface FileJobOwnershipDeps {
  /** Put the question in front of the user and send the answer. */
  answer: (route: FileJobDecideRoute) => void;
  /** The job finished: withdraw any question of it still on screen. */
  withdraw: (jobId: string) => void;
  showFailure: (errorCode: string | undefined) => void;
  /** Stop a job whose question nobody is left to answer. */
  cancel: (jobId: string) => void;
  now?: () => number;
}

export interface FileJobOwnership {
  /** submit() returned this id: the job is this panel's. */
  claim(jobId: string): void;
  onDecision(route: FileJobDecideRoute): void;
  onDone(event: FileJobDoneEvent): void;
  /** The question on screen was answered or withdrawn. */
  decisionSettled(jobId: string): void;
  /** The panel is going away. */
  dispose(): void;
  readonly disposed: boolean;
  isOwned(jobId: string): boolean;
  size(): { own: number; waitingDecisions: number; earlyDone: number };
}

// Other panels' events land here too and are never claimed, so both buffers are
// cut by age and by count. The window only has to cover the time between the
// server accepting a job and its 202 reaching this panel.
export const EARLY_EVENT_TTL_MS = 60_000;
export const EARLY_DONE_LIMIT = 64;
export const WAITING_DECISION_LIMIT = 64;

interface Stamped<T> {
  value: T;
  at: number;
}

function prune<T>(map: Map<string, Stamped<T>>, now: number, limit: number): void {
  for (const [key, entry] of map) {
    if (now - entry.at > EARLY_EVENT_TTL_MS) map.delete(key);
  }
  // Insertion order is arrival order, so the oldest go first.
  while (map.size > limit) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

/** @req FR-FEX-005 */
export function createFileJobOwnership(deps: FileJobOwnershipDeps): FileJobOwnership {
  const now = deps.now ?? Date.now;
  const own = new Set<string>();
  const waitingDecisions = new Map<string, Stamped<FileJobDecideRoute>>();
  const earlyDone = new Map<string, Stamped<FileJobDoneEvent>>();
  // Owned jobs with a question on screen, counted per job.
  const openQuestions = new Map<string, number>();
  let disposed = false;

  const reportFailure = (event: FileJobDoneEvent): void => {
    if (event.outcome === 'failed') deps.showFailure(event.errorCode);
  };

  const ask = (route: FileJobDecideRoute): void => {
    openQuestions.set(route.jobId, (openQuestions.get(route.jobId) ?? 0) + 1);
    deps.answer(route);
  };

  return {
    claim(jobId) {
      const waiting = waitingDecisions.get(jobId);
      waitingDecisions.delete(jobId);
      if (disposed) {
        // Its question has no UI left to reach; a job with none keeps running.
        if (waiting !== undefined) deps.cancel(jobId);
        return;
      }
      const finished = earlyDone.get(jobId);
      if (finished !== undefined) {
        // Already over: report it, and never own it, since no later done would
        // come to release it.
        earlyDone.delete(jobId);
        reportFailure(finished.value);
        return;
      }
      own.add(jobId);
      if (waiting !== undefined) ask(waiting.value);
    },

    onDecision(route) {
      if (disposed) return;
      if (own.has(route.jobId)) {
        ask(route);
        return;
      }
      waitingDecisions.set(route.jobId, { value: route, at: now() });
      prune(waitingDecisions, now(), WAITING_DECISION_LIMIT);
    },

    onDone(event) {
      if (disposed) return;
      const { jobId } = event;
      waitingDecisions.delete(jobId);
      openQuestions.delete(jobId);
      deps.withdraw(jobId);
      if (own.delete(jobId)) {
        reportFailure(event);
        return;
      }
      // Possibly this panel's job whose submit has not returned yet.
      earlyDone.set(jobId, { value: event, at: now() });
      prune(earlyDone, now(), EARLY_DONE_LIMIT);
    },

    decisionSettled(jobId) {
      const count = openQuestions.get(jobId);
      if (count === undefined) return;
      if (count <= 1) openQuestions.delete(jobId);
      else openQuestions.set(jobId, count - 1);
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      for (const jobId of openQuestions.keys()) {
        if (own.has(jobId)) deps.cancel(jobId);
      }
      own.clear();
      openQuestions.clear();
      earlyDone.clear();
      // Kept: a submit still in flight may claim one of these after unmount.
    },

    get disposed() {
      return disposed;
    },

    isOwned(jobId) {
      return own.has(jobId);
    },

    size() {
      return { own: own.size, waitingDecisions: waitingDecisions.size, earlyDone: earlyDone.size };
    },
  };
}
