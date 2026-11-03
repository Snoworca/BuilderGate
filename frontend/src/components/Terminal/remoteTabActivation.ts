// REL-BGSTAB-058 AC-9: the active tab is shared between screens. A terminal that comes into view
// because another screen switched tabs is not this screen being used, so it does not assert its
// size; the screen that switched does. The broadcast marks the session it shows, and the reveal
// that follows within the window reads the mark.

/** Long enough for the broadcast's render to reveal the terminal, short enough to miss a later click. */
export const REMOTE_TAB_ACTIVATION_WINDOW_MS = 2_000;

export interface RemoteTabActivations {
  mark: (sessionId: string) => void;
  clear: (sessionId: string) => void;
  isRemote: (sessionId: string) => boolean;
}

export function createRemoteTabActivations(options: {
  windowMs: number;
  now?: () => number;
}): RemoteTabActivations {
  const now = options.now ?? (() => Date.now());
  const markedAt = new Map<string, number>();
  return {
    mark(sessionId) {
      markedAt.set(sessionId, now());
    },
    clear(sessionId) {
      markedAt.delete(sessionId);
    },
    isRemote(sessionId) {
      const at = markedAt.get(sessionId);
      if (at === undefined) return false;
      if (now() - at > options.windowMs) {
        markedAt.delete(sessionId);
        return false;
      }
      return true;
    },
  };
}

// @req REL-BGSTAB-058
export const remoteTabActivations = createRemoteTabActivations({ windowMs: REMOTE_TAB_ACTIVATION_WINDOW_MS });
