// FR-FEX-013: the browser half of the name search. Starts a server search, polls it with a
// cursor so results appear as they are found, and cancels it. Timers and the API are
// injected so the order of answers can be tested.

export type FileSearchOutcome = 'running' | 'completed' | 'cancelled' | 'truncated' | 'failed';

export interface FileSearchResult {
  name: string;
  relativePath: string;
  path: string;
  type: 'file' | 'directory';
}

export interface FileSearchPage {
  results: FileSearchResult[];
  next: number;
  total: number;
  examined: number;
  currentPath: string;
  done: boolean;
  outcome: FileSearchOutcome;
  error?: string;
}

export interface FileSearchApi {
  start(sessionId: string, input: { path: string; query: string; includeIgnored: boolean }): Promise<{ searchId: string }>;
  poll(sessionId: string, searchId: string, after: number): Promise<FileSearchPage>;
  cancel(sessionId: string, searchId: string): Promise<void>;
}

export interface FileSearchView {
  query: string;
  running: boolean;
  results: FileSearchResult[];
  examined: number;
  currentPath: string;
  outcome: FileSearchOutcome | null;
  error: string | null;
}

export interface FileSearchControllerDeps {
  sessionId: string;
  api: FileSearchApi;
  onChange: (view: FileSearchView) => void;
  schedule?: (fn: () => void, ms: number) => unknown;
  unschedule?: (handle: unknown) => void;
  pollIntervalMs?: number;
}

export const EMPTY_SEARCH_VIEW: FileSearchView = {
  query: '', running: false, results: [], examined: 0, currentPath: '', outcome: null, error: null,
};

export function createFileSearchController(deps: FileSearchControllerDeps) {
  const schedule = deps.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const unschedule = deps.unschedule ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const interval = deps.pollIntervalMs ?? 250;
  let view: FileSearchView = EMPTY_SEARCH_VIEW;
  // Every start bumps the generation; an answer for an older one is dropped.
  let generation = 0;
  let searchId: string | null = null;
  let cursor = 0;
  let timer: unknown = null;

  const emit = (next: Partial<FileSearchView>) => {
    view = { ...view, ...next };
    deps.onChange(view);
  };

  const stopTimer = () => {
    if (timer !== null) unschedule(timer);
    timer = null;
  };

  const pollOnce = async (gen: number): Promise<void> => {
    timer = null;
    if (gen !== generation || searchId === null) return;
    let page: FileSearchPage;
    try {
      page = await deps.api.poll(deps.sessionId, searchId, cursor);
    } catch (error) {
      if (gen !== generation) return;
      emit({ running: false, outcome: 'failed', error: error instanceof Error ? error.message : String(error) });
      return;
    }
    if (gen !== generation) return;
    cursor = page.next;
    emit({
      results: page.results.length > 0 ? [...view.results, ...page.results] : view.results,
      examined: page.examined,
      currentPath: page.currentPath,
      running: !page.done,
      outcome: page.outcome,
      error: page.error ?? null,
    });
    if (!page.done) timer = schedule(() => void pollOnce(gen), interval);
  };

  return {
    async start(input: { path: string; query: string; includeIgnored: boolean }): Promise<void> {
      await this.cancel(false);
      const gen = ++generation;
      cursor = 0;
      view = { ...EMPTY_SEARCH_VIEW, query: input.query, running: true, outcome: 'running' };
      deps.onChange(view);
      try {
        const started = await deps.api.start(deps.sessionId, input);
        if (gen !== generation) {
          void deps.api.cancel(deps.sessionId, started.searchId).catch(() => undefined);
          return;
        }
        searchId = started.searchId;
      } catch (error) {
        if (gen !== generation) return;
        emit({ running: false, outcome: 'failed', error: error instanceof Error ? error.message : String(error) });
        return;
      }
      timer = schedule(() => void pollOnce(gen), 0);
    },

    /** Stops the search on the server and here; results found so far stay on screen. */
    async cancel(announce = true): Promise<void> {
      stopTimer();
      generation += 1;
      const id = searchId;
      searchId = null;
      if (id !== null) await deps.api.cancel(deps.sessionId, id).catch(() => undefined);
      if (announce && view.running) emit({ running: false, outcome: 'cancelled' });
    },

    /** Leaves search mode entirely. */
    async close(): Promise<void> {
      await this.cancel(false);
      view = EMPTY_SEARCH_VIEW;
      deps.onChange(view);
    },

    get view(): FileSearchView {
      return view;
    },
  };
}

export type FileSearchController = ReturnType<typeof createFileSearchController>;
