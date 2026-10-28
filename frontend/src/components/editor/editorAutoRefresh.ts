/**
 * FR-MDE-030: the editor window follows its file on disk. The active tab of a window on screen
 * is checked by the file's modification time and size (`/files/stat`), which works the same on
 * Windows and on WSL paths, where a server-side watch does not deliver events reliably
 * (docs/research/2026-10-28.editor-auto-refresh.md).
 *
 * The watcher decides; the window acts. It never reads a file itself.
 *
 * @req FR-MDE-030
 */
import { browserPreferenceStorage, createBooleanPreferenceStore, type BooleanPreferenceStore, type PreferenceStorage } from '../../utils/booleanPreferenceStore.ts';

export const AUTO_REFRESH_KEY = 'buildergate.editor.autoRefresh';

/** AC-1: on by default, shared by every editor window. */
export function createAutoRefreshStore(storage: () => PreferenceStorage | null): BooleanPreferenceStore {
  return createBooleanPreferenceStore(AUTO_REFRESH_KEY, true, storage);
}

export const autoRefreshStore = createAutoRefreshStore(browserPreferenceStorage);

export interface FileStamp {
  modified: string;
  size: number;
}

export type StatResult = FileStamp | 'missing';

/** What was last seen: a stamp, or the file being gone. */
type Baseline = StatResult;

export type FileChange = 'baseline' | 'same' | 'changed' | 'deleted';

export function compareFileStamp(baseline: Baseline | null, next: StatResult): FileChange {
  if (next === 'missing') return baseline === 'missing' ? 'same' : 'deleted';
  if (baseline === null) return 'baseline';
  if (baseline === 'missing') return 'changed';
  return baseline.modified === next.modified && baseline.size === next.size ? 'same' : 'changed';
}

export type ExternalAction = 'none' | 'reload' | 'ask-reload' | 'close' | 'ask-deleted';

/** AC-3~AC-6: a tab without unsaved edits follows the file; one with edits asks. */
export function decideExternalAction(input: { change: FileChange; dirty: boolean }): ExternalAction {
  if (input.change === 'changed') return input.dirty ? 'ask-reload' : 'reload';
  if (input.change === 'deleted') return input.dirty ? 'ask-deleted' : 'close';
  return 'none';
}

const POLL_MS = 2000;
const POLL_MAX_MS = 30_000;
/**
 * A file first seen missing is asked about again this soon before it counts as deleted: agents
 * and editors often save by writing a temp file and renaming it over the old one.
 */
const MISSING_RECHECK_MS = 700;

/** AC-2: every 2 s; five times a slow answer's duration, at most 30 s. */
export function nextPollDelay(lastDurationMs: number): number {
  return Math.min(POLL_MAX_MS, Math.max(POLL_MS, lastDurationMs * 5));
}

export interface WatchTarget {
  filePath: string;
  sessionId: string;
  isDirty: () => boolean;
}

export interface EditorFileWatcherDeps {
  /** The file's stamp, or 'missing'; any other failure throws and the next poll tries again. */
  stat: (sessionId: string, filePath: string) => Promise<StatResult>;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  now: () => number;
  onAction: (action: Exclude<ExternalAction, 'none'>, filePath: string) => void;
}

export interface EditorFileWatcher {
  /** Watches this target from now on, or nothing (off, hidden, no tab). */
  watch: (target: WatchTarget | null) => void;
  /** AC-2: this editor is writing the file; its result is the new baseline, not a change. */
  noteSave: (filePath: string, sessionId: string, write: Promise<unknown>) => void;
  /** AC-3: reading the changed file failed; the next check reports it as changed again. */
  retry: (filePath: string) => void;
  stop: () => void;
}

export function createEditorFileWatcher(deps: EditorFileWatcherDeps): EditorFileWatcher {
  const baselines = new Map<string, Baseline>();
  const saving = new Map<string, number>();
  const suspectedMissing = new Set<string>();
  // Counts saves per path, so an answer sent before a save that has since finished is dropped.
  const saveSeq = new Map<string, number>();
  let target: WatchTarget | null = null;
  let timer: unknown = null;
  // Bumped on every watch() and stop(), so an answer for an earlier target is dropped.
  let generation = 0;

  const clear = () => {
    if (timer !== null) deps.clearTimer(timer);
    timer = null;
  };
  const schedule = (ms: number, gen: number) => {
    clear();
    timer = deps.setTimer(() => {
      timer = null;
      void poll(gen);
    }, ms);
  };

  async function poll(gen: number): Promise<void> {
    const current = target;
    if (current === null || gen !== generation) return;
    if ((saving.get(current.filePath) ?? 0) > 0) {
      schedule(POLL_MS, gen);
      return;
    }
    const started = deps.now();
    const seqAtSend = saveSeq.get(current.filePath) ?? 0;
    let result: StatResult;
    try {
      result = await deps.stat(current.sessionId, current.filePath);
    } catch {
      if (gen === generation) schedule(nextPollDelay(deps.now() - started), gen);
      return;
    }
    // A save that began while this answer was out decides the baseline instead.
    if (gen !== generation || (saving.get(current.filePath) ?? 0) > 0 || (saveSeq.get(current.filePath) ?? 0) !== seqAtSend) {
      if (gen === generation) schedule(POLL_MS, gen);
      return;
    }
    const change = compareFileStamp(baselines.get(current.filePath) ?? null, result);
    if (result !== 'missing') suspectedMissing.delete(current.filePath);
    if (change === 'deleted' && !suspectedMissing.has(current.filePath)) {
      suspectedMissing.add(current.filePath);
      schedule(MISSING_RECHECK_MS, gen);
      return;
    }
    suspectedMissing.delete(current.filePath);
    const action = decideExternalAction({ change, dirty: current.isDirty() });
    // A change asked about is asked once: '내 편집 유지' needs no call back, the next poll is 'same'.
    if (change !== 'same') baselines.set(current.filePath, result);
    if (action === 'close') {
      baselines.delete(current.filePath);
      target = null;
      generation += 1;
      clear();
      deps.onAction(action, current.filePath);
      return;
    }
    schedule(nextPollDelay(deps.now() - started), gen);
    if (action !== 'none') deps.onAction(action, current.filePath);
  }

  return {
    watch(next) {
      const same = next !== null && target !== null && next.filePath === target.filePath && next.sessionId === target.sessionId;
      if (same) {
        target = next;
        return;
      }
      generation += 1;
      clear();
      target = next;
      if (next !== null) void poll(generation);
    },
    noteSave(filePath, sessionId, write) {
      saving.set(filePath, (saving.get(filePath) ?? 0) + 1);
      saveSeq.set(filePath, (saveSeq.get(filePath) ?? 0) + 1);
      const done = () => saving.set(filePath, (saving.get(filePath) ?? 1) - 1);
      // A written file's stamp is the new baseline. A failed write changed nothing of ours, so the
      // old baseline stays and an outside change made meanwhile is still seen.
      write.then(async () => {
        try {
          baselines.set(filePath, await deps.stat(sessionId, filePath));
        } catch {
          baselines.delete(filePath);
        }
        saveSeq.set(filePath, (saveSeq.get(filePath) ?? 0) + 1);
        done();
      }, done);
    },
    retry(filePath) {
      baselines.set(filePath, { modified: '', size: -1 });
    },
    stop() {
      generation += 1;
      target = null;
      clear();
    },
  };
}
