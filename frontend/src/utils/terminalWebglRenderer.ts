/**
 * Issue #15 — visible-only WebGL renderer with a DOM fallback.
 *
 * Two properties drive this design, and neither is about speed:
 *
 * 1. A WebGL context can be taken away at any time — sleep/wake, a driver
 *    restart, a backgrounded tab, or simply another context being created once
 *    the browser's per-page budget is full. That is normal operation, not an
 *    error path, so losing it has to land somewhere safe. xterm falls back to
 *    its DOM renderer when the addon is disposed, so the fallback is "dispose
 *    and let the terminal repaint", not "leave a dead addon attached".
 *
 * 2. The browser's context budget is finite and BuilderGate opens many
 *    terminals. If hidden tabs hold contexts, opening a new one evicts an old
 *    one and breaks a terminal the user is not even looking at. So the addon is
 *    attached only while a terminal is visible and released as soon as it is
 *    hidden.
 *
 * The addon is injected rather than imported here so the lifecycle — including
 * context loss, which needs a GPU to provoke for real — is exercisable in
 * ordinary unit tests.
 *
 * PERF-BGSTAB-020: releasing on every hide made every reveal rebuild the
 * renderer — a new context, shader compile, char measure and glyph atlas
 * upload, about 40 ms per terminal. A grid workspace of three terminals paid
 * ~130-150 ms of blocked main thread on every workspace switch. A hidden
 * terminal now keeps its context for a while, and point 2 is kept by a
 * page-wide budget instead: when visible plus kept contexts exceed it, the
 * least recently hidden ones are released first.
 */

export interface WebglContextPoolEntry {
  /** Releases the entry's context; the entry then leaves the pool itself. */
  release: () => void;
}

export interface WebglContextPool {
  attach: (entry: WebglContextPoolEntry) => void;
  hide: (entry: WebglContextPoolEntry) => void;
  reveal: (entry: WebglContextPoolEntry) => void;
  remove: (entry: WebglContextPoolEntry) => void;
}

export interface WebglContextPoolOptions {
  /** Page-wide cap on attached contexts, visible and kept hidden together. */
  maxAttached: number;
  /** How long a hidden terminal keeps its context; 0 releases at once. */
  hiddenTtlMs: number;
  setTimeout?: (run: () => void, ms: number) => unknown;
  clearTimeout?: (id: unknown) => void;
}

export function createWebglContextPool(options: WebglContextPoolOptions): WebglContextPool {
  const setTimer = options.setTimeout ?? ((run, ms) => globalThis.setTimeout(run, ms));
  const clearTimer = options.clearTimeout ?? ((id) => globalThis.clearTimeout(id as ReturnType<typeof setTimeout>));
  const visible = new Set<WebglContextPoolEntry>();
  // Insertion order is hide order, so the first key is the least recently hidden.
  const hidden = new Map<WebglContextPoolEntry, unknown>();

  const forget = (entry: WebglContextPoolEntry): void => {
    visible.delete(entry);
    if (hidden.has(entry)) {
      clearTimer(hidden.get(entry));
      hidden.delete(entry);
    }
  };
  const enforceBudget = (): void => {
    while (visible.size + hidden.size > options.maxAttached && hidden.size > 0) {
      const oldest = hidden.keys().next().value as WebglContextPoolEntry;
      forget(oldest);
      oldest.release();
    }
  };

  return {
    attach(entry) {
      visible.add(entry);
      enforceBudget();
    },
    hide(entry) {
      visible.delete(entry);
      if (options.hiddenTtlMs <= 0) {
        entry.release();
        return;
      }
      hidden.set(entry, setTimer(() => {
        hidden.delete(entry);
        entry.release();
      }, options.hiddenTtlMs));
      enforceBudget();
    },
    reveal(entry) {
      forget(entry);
      visible.add(entry);
      enforceBudget();
    },
    remove(entry) {
      forget(entry);
    },
  };
}

/**
 * Chrome keeps 16 WebGL contexts per page and reclaims the oldest beyond that;
 * 12 leaves room for other canvases. Five minutes covers going back and forth
 * between workspaces without holding GPU memory for tabs left alone.
 */
const defaultWebglContextPool = createWebglContextPool({ maxAttached: 12, hiddenTtlMs: 300_000 });

export type TerminalWebglState = 'detached' | 'attached' | 'unavailable';

export type TerminalWebglFallbackReason =
  | 'activation-failed'
  | 'context-loss'
  | 'context-loss-budget-exhausted';

export interface WebglAddonLike {
  onContextLoss: (handler: () => void) => { dispose: () => void };
  dispose: () => void;
}

export interface TerminalWebglRendererOptions {
  /** Constructs the addon. Separate from loadAddon so a throw in either is handled. */
  createAddon: () => WebglAddonLike;
  /** Hands the addon to the terminal. Throws when WebGL is unavailable. */
  loadAddon: (addon: WebglAddonLike) => void;
  /**
   * Called when the terminal drops to the DOM renderer. The caller is expected
   * to make sure a DOM frame is produced — a fallback that leaves a blank
   * viewport is not a fallback.
   */
  onFallback?: (reason: TerminalWebglFallbackReason) => void;
  /**
   * How many context losses to absorb before giving up on WebGL for this
   * terminal. Without a budget, a machine whose driver keeps reclaiming
   * contexts would reattach on every reveal and flicker indefinitely.
   */
  maxContextLossRetries?: number;
  /** PERF-BGSTAB-020: the page-wide pool that decides when a hidden context is released. */
  pool?: WebglContextPool;
}

export interface TerminalWebglRenderer {
  /** Idempotent: attaches when visible, releases when hidden. */
  sync: (isVisible: boolean) => void;
  getState: () => TerminalWebglState;
  dispose: () => void;
}

const DEFAULT_MAX_CONTEXT_LOSS_RETRIES = 2;

export function createTerminalWebglRenderer(
  options: TerminalWebglRendererOptions,
): TerminalWebglRenderer {
  const maxContextLossRetries
    = options.maxContextLossRetries ?? DEFAULT_MAX_CONTEXT_LOSS_RETRIES;

  let state: TerminalWebglState = 'detached';
  let addon: WebglAddonLike | null = null;
  let contextLossSubscription: { dispose: () => void } | null = null;
  let contextLossCount = 0;
  let disposed = false;
  let hidden = false;
  const pool = options.pool ?? defaultWebglContextPool;
  const poolEntry: WebglContextPoolEntry = { release: () => release() };

  const release = (): void => {
    pool.remove(poolEntry);
    hidden = false;
    contextLossSubscription?.dispose();
    contextLossSubscription = null;
    if (addon) {
      try {
        addon.dispose();
      } catch {
        // A dead context can throw on dispose. The terminal is already back on
        // the DOM renderer at this point, so there is nothing to recover.
      }
      addon = null;
    }
    if (state === 'attached') {
      state = 'detached';
    }
  };

  const fallback = (reason: TerminalWebglFallbackReason): void => {
    options.onFallback?.(reason);
  };

  const attach = (): void => {
    let created: WebglAddonLike;
    try {
      created = options.createAddon();
      options.loadAddon(created);
    } catch {
      // No WebGL here at all. Stay on the DOM renderer permanently rather than
      // retrying on every reveal.
      state = 'unavailable';
      fallback('activation-failed');
      return;
    }

    addon = created;
    state = 'attached';
    hidden = false;
    pool.attach(poolEntry);
    contextLossSubscription = created.onContextLoss(() => {
      contextLossCount += 1;
      release();
      if (contextLossCount >= maxContextLossRetries) {
        state = 'unavailable';
        fallback('context-loss-budget-exhausted');
        return;
      }
      fallback('context-loss');
    });
  };

  return {
    sync(isVisible: boolean): void {
      if (disposed || state === 'unavailable') {
        return;
      }
      if (isVisible) {
        if (state === 'detached') {
          attach();
        } else if (hidden) {
          hidden = false;
          pool.reveal(poolEntry);
        }
        return;
      }
      if (state === 'attached' && !hidden) {
        hidden = true;
        pool.hide(poolEntry);
      }
    },

    getState(): TerminalWebglState {
      return state;
    },

    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      release();
    },
  };
}
