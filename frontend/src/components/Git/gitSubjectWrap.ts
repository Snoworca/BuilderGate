/**
 * FR-GIT-013: whether commit subjects wrap in the commit list. Off by default, kept in this
 * browser, and shared by every open Git window, so toggling it in one changes them all.
 *
 * @req FR-GIT-013
 */
export const SUBJECT_WRAP_KEY = 'buildergate.git.wrapSubjects';

type OptionStorage = Pick<Storage, 'getItem' | 'setItem'>;

export interface SubjectWrapStore {
  get: () => boolean;
  set: (on: boolean) => void;
  subscribe: (listener: () => void) => () => void;
}

export function createSubjectWrapStore(storage: () => OptionStorage | null): SubjectWrapStore {
  let value: boolean | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => {
      value ??= storage()?.getItem(SUBJECT_WRAP_KEY) === '1';
      return value;
    },
    set: (on) => {
      value = on;
      try {
        storage()?.setItem(SUBJECT_WRAP_KEY, on ? '1' : '0');
      } catch {
        // A full or blocked storage keeps the choice for this page only.
      }
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function browserStorage(): OptionStorage | null {
  try { return window.localStorage; } catch { return null; }
}

export const subjectWrapStore = createSubjectWrapStore(browserStorage);
