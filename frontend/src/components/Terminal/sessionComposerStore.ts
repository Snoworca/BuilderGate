// Each session's composer state (open, draft, history) and the one height they all share.
// The toggle in the status row, the composer, the terminal shortcut and the menus sit in
// unrelated parts of the tree, so they read one module store with useSyncExternalStore.
// Everything is kept in the browser; every storage access may throw (private mode, blocked
// site data) and the composer keeps working from memory when it does.
// @req FR-CMP-001 FR-CMP-002 FR-CMP-003

import { useSyncExternalStore } from 'react';
import {
  COMPOSER_DEFAULT_HEIGHT_PX,
  COMPOSER_DRAFT_SAVE_DELAY_MS,
  COMPOSER_HISTORY_LIMIT,
  pushComposerHistory,
} from './sessionComposerModel.ts';

export const COMPOSER_HEIGHT_STORAGE_KEY = 'buildergate.composer.height';
const SESSION_STORAGE_KEY_PREFIX = 'buildergate.composer.session.';

export function composerSessionStorageKey(tabId: string): string {
  return `${SESSION_STORAGE_KEY_PREFIX}${tabId}`;
}

export interface ComposerStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface ComposerSessionState {
  readonly open: boolean;
  readonly draft: string;
  readonly history: readonly string[];
  /** Bumped by a focus request so the composer re-renders and takes it. */
  readonly focusSeq: number;
}

export interface SessionComposerStore {
  subscribe(listener: () => void): () => void;
  getSession(tabId: string): ComposerSessionState;
  getHeight(): number;
  setOpen(tabId: string, open: boolean): void;
  /** Memory at once; storage after the user stops typing. */
  setDraft(tabId: string, draft: string): void;
  /** A sent draft: the box empties and the text joins the history. */
  recordSent(tabId: string, text: string): void;
  setHeight(height: number): void;
  resetHeight(): void;
  requestFocus(tabId: string): void;
  /** True once per request. */
  takeFocusRequest(tabId: string): boolean;
  /** The session closed: forget its composer. */
  clear(tabId: string): void;
  /** Saves every pending draft now (the page is going away). */
  flush(): void;
}

type Schedule = (fn: () => void, ms: number) => () => void;

const defaultSchedule: Schedule = (fn, ms) => {
  const timer = setTimeout(fn, ms);
  return () => clearTimeout(timer);
};

const EMPTY_SESSION: ComposerSessionState = Object.freeze({ open: false, draft: '', history: Object.freeze([]), focusSeq: 0 });

function parseSession(raw: string | null): ComposerSessionState {
  if (raw === null) return EMPTY_SESSION;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return EMPTY_SESSION;
  }
  if (!value || typeof value !== 'object') return EMPTY_SESSION;
  const record = value as Record<string, unknown>;
  const history = Array.isArray(record.history)
    ? record.history.filter((entry): entry is string => typeof entry === 'string').slice(-COMPOSER_HISTORY_LIMIT)
    : [];
  return {
    open: record.open === true,
    draft: typeof record.draft === 'string' ? record.draft : '',
    history,
    focusSeq: 0,
  };
}

function parseHeight(raw: string | null): number {
  const value = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(value) && value > 0 ? value : COMPOSER_DEFAULT_HEIGHT_PX;
}

export function createSessionComposerStore(options: {
  storage: () => ComposerStorage | null;
  schedule?: Schedule;
}): SessionComposerStore {
  const schedule = options.schedule ?? defaultSchedule;
  const sessions = new Map<string, ComposerSessionState>();
  const pendingSaves = new Map<string, () => void>();
  const focusRequests = new Set<string>();
  const listeners = new Set<() => void>();
  let height: number | null = null;

  const read = (key: string): string | null => {
    try {
      return options.storage()?.getItem(key) ?? null;
    } catch {
      return null;
    }
  };
  const write = (key: string, value: string | null): void => {
    try {
      const storage = options.storage();
      if (!storage) return;
      if (value === null) storage.removeItem(key);
      else storage.setItem(key, value);
    } catch {
      // Memory still holds it; it is just not kept across a reload.
    }
  };
  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };

  const getSession = (tabId: string): ComposerSessionState => {
    let session = sessions.get(tabId);
    if (!session) {
      session = parseSession(read(composerSessionStorageKey(tabId)));
      sessions.set(tabId, session);
    }
    return session;
  };

  const persist = (tabId: string): void => {
    pendingSaves.get(tabId)?.();
    pendingSaves.delete(tabId);
    const session = getSession(tabId);
    const empty = !session.open && session.draft === '' && session.history.length === 0;
    write(
      composerSessionStorageKey(tabId),
      empty ? null : JSON.stringify({ open: session.open, draft: session.draft, history: session.history }),
    );
  };

  const update = (tabId: string, change: Partial<ComposerSessionState>): boolean => {
    const current = getSession(tabId);
    const next = { ...current, ...change };
    if (
      next.open === current.open
      && next.draft === current.draft
      && next.history === current.history
      && next.focusSeq === current.focusSeq
    ) {
      return false;
    }
    sessions.set(tabId, next);
    notify();
    return true;
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSession,
    getHeight() {
      if (height === null) height = parseHeight(read(COMPOSER_HEIGHT_STORAGE_KEY));
      return height;
    },
    setOpen(tabId, open) {
      if (update(tabId, { open })) persist(tabId);
    },
    setDraft(tabId, draft) {
      if (!update(tabId, { draft })) return;
      pendingSaves.get(tabId)?.();
      pendingSaves.set(tabId, schedule(() => {
        pendingSaves.delete(tabId);
        persist(tabId);
      }, COMPOSER_DRAFT_SAVE_DELAY_MS));
    },
    recordSent(tabId, text) {
      update(tabId, { draft: '', history: pushComposerHistory(getSession(tabId).history, text) });
      persist(tabId);
    },
    setHeight(next) {
      if (height === next) return;
      height = next;
      write(COMPOSER_HEIGHT_STORAGE_KEY, String(next));
      notify();
    },
    resetHeight() {
      height = COMPOSER_DEFAULT_HEIGHT_PX;
      write(COMPOSER_HEIGHT_STORAGE_KEY, null);
      notify();
    },
    requestFocus(tabId) {
      focusRequests.add(tabId);
      update(tabId, { focusSeq: getSession(tabId).focusSeq + 1 });
    },
    takeFocusRequest(tabId) {
      return focusRequests.delete(tabId);
    },
    clear(tabId) {
      pendingSaves.get(tabId)?.();
      pendingSaves.delete(tabId);
      focusRequests.delete(tabId);
      const had = sessions.has(tabId);
      sessions.set(tabId, EMPTY_SESSION);
      write(composerSessionStorageKey(tabId), null);
      if (had) notify();
    },
    flush() {
      for (const tabId of [...pendingSaves.keys()]) persist(tabId);
    },
  };
}

function browserStorage(): ComposerStorage | null {
  return typeof window === 'undefined' ? null : window.localStorage;
}

export const sessionComposerStore = createSessionComposerStore({ storage: browserStorage });

if (typeof window !== 'undefined') {
  // FR-CMP-003 AC-5: a reload within the 300 ms wait keeps the last keystrokes.
  window.addEventListener('pagehide', () => sessionComposerStore.flush());
}

export function useComposerSession(tabId: string): ComposerSessionState {
  return useSyncExternalStore(
    sessionComposerStore.subscribe,
    () => sessionComposerStore.getSession(tabId),
  );
}

export function useComposerHeight(): number {
  return useSyncExternalStore(sessionComposerStore.subscribe, sessionComposerStore.getHeight);
}

/** @req FR-CMP-003 */
export function clearSessionComposer(tabId: string): void {
  sessionComposerStore.clear(tabId);
}
