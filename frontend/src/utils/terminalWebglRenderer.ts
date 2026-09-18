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
 */

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

  const release = (): void => {
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
        }
        return;
      }
      release();
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
