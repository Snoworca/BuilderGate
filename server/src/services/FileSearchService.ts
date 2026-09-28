// FR-FEX-013: name search under a directory, run asynchronously and cancellable.
//
// A search walks with fs.opendir and yields to the event loop every few entries, so a
// large tree never blocks the server. Results are kept in the order found and read back
// by polling with a cursor (`poll(id, after)` returns only what is new), which is how the
// explorer shows them as they arrive. Cancel aborts the walk at its next step.
//
// Boundaries: the start directory is validated by the caller (resolveRoot) against the
// session root, and the walk never follows a symlinked directory, so it cannot leave the
// root or loop. One search per session: starting another cancels the running one.
import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { AppError, ErrorCode } from '../utils/errors.js';
import { isFileJobTempName } from './fileJobs/fileJobRunner.js';

export interface FileSearchResult {
  name: string;
  /** Relative to the session root, with forward slashes. */
  relativePath: string;
  /** Absolute path on the server. */
  path: string;
  type: 'file' | 'directory';
}

export type FileSearchOutcome = 'running' | 'completed' | 'cancelled' | 'truncated' | 'failed';

export interface FileSearchPage {
  results: FileSearchResult[];
  /** Cursor for the next poll. */
  next: number;
  total: number;
  examined: number;
  currentPath: string;
  done: boolean;
  outcome: FileSearchOutcome;
  error?: string;
}

export interface FileSearchDeps {
  /** The session root and the validated start directory; throws for a path outside the root. */
  resolveRoot: (sessionId: string, targetPath: string) => Promise<{ sessionRoot: string; dir: string }>;
}

export interface FileSearchOptions {
  maxResults?: number;
  /** A search nobody polls for this long is cancelled and forgotten. */
  idleTtlMs?: number;
}

interface SearchState {
  sessionId: string;
  results: FileSearchResult[];
  examined: number;
  currentPath: string;
  outcome: FileSearchOutcome;
  error?: string;
  cancelled: boolean;
  lastPolledAt: number;
}

/** Skipped unless the caller asks for them (FR-FEX-013 AC-5). */
const IGNORED_DIRECTORY_NAMES = new Set(['.git', 'node_modules']);
const YIELD_EVERY = 64;
const DEFAULT_MAX_RESULTS = 5000;
const DEFAULT_IDLE_TTL_MS = 60_000;

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

export class FileSearchService {
  private readonly searches = new Map<string, SearchState>();
  private readonly bySession = new Map<string, string>();
  private readonly maxResults: number;
  private readonly idleTtlMs: number;

  constructor(private readonly deps: FileSearchDeps, options: FileSearchOptions = {}) {
    this.maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
    this.idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
  }

  async start(sessionId: string, input: { path: string; query: string; includeIgnored?: boolean }): Promise<{ id: string }> {
    const query = input.query.trim().toLowerCase();
    if (query === '') throw new AppError(ErrorCode.INVALID_INPUT, 'query is required');
    const { sessionRoot, dir } = await this.deps.resolveRoot(sessionId, input.path);
    this.sweep();

    const previous = this.bySession.get(sessionId);
    if (previous !== undefined) this.cancel(previous);

    const id = randomUUID();
    const state: SearchState = {
      sessionId,
      results: [],
      examined: 0,
      currentPath: '',
      outcome: 'running',
      cancelled: false,
      lastPolledAt: Date.now(),
    };
    this.searches.set(id, state);
    this.bySession.set(sessionId, id);
    void this.walk(state, sessionRoot, dir, query, input.includeIgnored === true);
    return { id };
  }

  poll(id: string, after: number): FileSearchPage {
    const state = this.searches.get(id);
    if (state === undefined) throw new AppError(ErrorCode.INVALID_INPUT, 'Unknown search');
    state.lastPolledAt = Date.now();
    const from = Math.max(0, Math.min(after, state.results.length));
    return {
      results: state.results.slice(from),
      next: state.results.length,
      total: state.results.length,
      examined: state.examined,
      currentPath: state.currentPath,
      done: state.outcome !== 'running',
      outcome: state.outcome,
      ...(state.error !== undefined ? { error: state.error } : {}),
    };
  }

  cancel(id: string): void {
    const state = this.searches.get(id);
    if (state === undefined) return;
    state.cancelled = true;
    if (state.outcome === 'running') state.outcome = 'cancelled';
  }

  /** The session that owns a search, so a route can refuse another session's id. */
  ownerOf(id: string): string | undefined {
    return this.searches.get(id)?.sessionId;
  }

  private sweep(): void {
    const cutoff = Date.now() - this.idleTtlMs;
    for (const [id, state] of this.searches) {
      if (state.lastPolledAt >= cutoff) continue;
      state.cancelled = true;
      this.searches.delete(id);
      if (this.bySession.get(state.sessionId) === id) this.bySession.delete(state.sessionId);
    }
  }

  private async walk(state: SearchState, sessionRoot: string, start: string, query: string, includeIgnored: boolean): Promise<void> {
    const realRoot = await fs.realpath(sessionRoot).catch(() => sessionRoot);
    const queue: string[] = [start];
    let sinceYield = 0;
    try {
      while (queue.length > 0) {
        if (state.cancelled) return;
        const dir = queue.shift()!;
        state.currentPath = toRelative(realRoot, dir);
        let handle;
        try {
          handle = await fs.opendir(dir);
        } catch {
          continue; // unreadable directory: skip it, keep searching
        }
        for await (const dirent of handle) {
          if (state.cancelled) return;
          state.examined += 1;
          if (isFileJobTempName(dirent.name)) continue;
          const full = path.join(dir, dirent.name);
          // Symlinks are matched by name but never descended into (no escape, no loops).
          const isDir = dirent.isDirectory();
          if (isDir && !includeIgnored && IGNORED_DIRECTORY_NAMES.has(dirent.name)) continue;
          if (dirent.name.toLowerCase().includes(query)) {
            state.results.push({
              name: dirent.name,
              relativePath: toRelative(realRoot, full),
              path: full,
              type: isDir ? 'directory' : 'file',
            });
            if (state.results.length >= this.maxResults) {
              state.outcome = 'truncated';
              state.cancelled = true;
              return;
            }
          }
          if (isDir) queue.push(full);
          sinceYield += 1;
          if (sinceYield >= YIELD_EVERY) {
            sinceYield = 0;
            await yieldToEventLoop();
          }
        }
      }
      if (!state.cancelled) state.outcome = 'completed';
    } catch (error) {
      if (!state.cancelled) {
        state.outcome = 'failed';
        state.error = error instanceof Error ? error.message : String(error);
      }
    }
  }
}

function toRelative(root: string, target: string): string {
  const relative = path.relative(root, target);
  return relative === '' ? '.' : relative.split(path.sep).join('/');
}
