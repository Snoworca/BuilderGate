/**
 * A yes/no preference kept in this browser and shared by everything on the page that reads
 * it: a change made in one window is heard by every other. A blocked or full storage keeps
 * the choice for this page only.
 */
export type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>;

export interface BooleanPreferenceStore {
  get: () => boolean;
  set: (on: boolean) => void;
  subscribe: (listener: () => void) => () => void;
}

export function createBooleanPreferenceStore(
  key: string,
  defaultValue: boolean,
  storage: () => PreferenceStorage | null,
): BooleanPreferenceStore {
  let value: boolean | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => {
      if (value === null) {
        const stored = storage()?.getItem(key) ?? null;
        value = stored === null ? defaultValue : stored === '1';
      }
      return value;
    },
    set: (on) => {
      value = on;
      try {
        storage()?.setItem(key, on ? '1' : '0');
      } catch {
        // Kept for this page only.
      }
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function browserPreferenceStorage(): PreferenceStorage | null {
  try { return window.localStorage; } catch { return null; }
}
