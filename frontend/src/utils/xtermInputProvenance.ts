// Tells typed input apart from replies that xterm's parser generates, for one terminal.
//
// Both reach term.onData. While a retained screen is replayed into the parser, the replies
// must be suppressed (REL-BGSTAB-009) but typing must not. A key, a paste or an input event
// grants a permit that lives until the next microtask, because xterm hands that data to
// onData in the same task. Some input is sent later: xterm sends a committed IME composition,
// and a character the IME inserts without composing (keyCode 229: a digit or Space in Hangul
// mode), from a setTimeout(0), and on a busy page that timer can run much later. Those grant a
// deferred permit that lasts COMPOSITION_COMMIT_PROVENANCE_MS. Only text that cannot be a
// terminal reply (no ESC) may use it, so a parser reply that arrives while it is open keeps
// parser provenance. Such text uses a deferred permit before a gesture permit: a key that ends
// a composition at once sends the syllable and then its own bytes in the same keydown.
// @req REL-BGSTAB-019

export const COMPOSITION_COMMIT_PROVENANCE_MS = 2_000;

const ESC = '\x1b';

export interface XtermInputProvenance {
  /** A key, paste or input event whose data xterm sends within the same task. */
  markUserGesture(): void;
  /** compositionend, or a keyCode 229 key: xterm sends that text from a later timer. */
  markDeferredInput(): void;
  /** Whether this onData payload is the user's input; uses up one permit if so. */
  takeUserProvenance(data: string): boolean;
  dispose(): void;
}

export interface XtermInputProvenanceOptions {
  queueMicrotask?: (callback: () => void) => void;
  setTimeout?: (callback: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

export function createXtermInputProvenance(options: XtermInputProvenanceOptions = {}): XtermInputProvenance {
  const enqueueMicrotask = options.queueMicrotask ?? ((callback) => queueMicrotask(callback));
  const setTimer = options.setTimeout ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer = options.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let gesturePermits = 0;
  // One expiry timer per open deferred permit, oldest first.
  const deferredPermits: unknown[] = [];
  let disposed = false;

  return {
    markUserGesture() {
      if (disposed) return;
      gesturePermits += 1;
      enqueueMicrotask(() => { gesturePermits = Math.max(0, gesturePermits - 1); });
    },
    markDeferredInput() {
      if (disposed) return;
      const handle = setTimer(() => {
        const index = deferredPermits.indexOf(handle);
        if (index >= 0) deferredPermits.splice(index, 1);
      }, COMPOSITION_COMMIT_PROVENANCE_MS);
      deferredPermits.push(handle);
    },
    takeUserProvenance(data) {
      if (deferredPermits.length > 0 && !data.includes(ESC)) {
        clearTimer(deferredPermits.shift());
        return true;
      }
      if (gesturePermits > 0) {
        gesturePermits -= 1;
        return true;
      }
      return false;
    },
    dispose() {
      disposed = true;
      gesturePermits = 0;
      for (const handle of deferredPermits.splice(0)) clearTimer(handle);
    },
  };
}
