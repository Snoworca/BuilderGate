// The editor's light/dark choice, a global user preference kept in
// localStorage so it survives a reload and a restart (FR-MDE-020 AC-4).
// Light is the vendor editor's opt-in palette; dark is its default one.
// @req FR-MDE-020

export type EditorTheme = 'light' | 'dark';

export const THEME_PREFERENCE_KEY = 'buildergate.editor.theme';

// Tells every mounted document panel that the theme changed.
export const THEME_CHANGE_EVENT = 'buildergate:editor-theme-change';

type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): PreferenceStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** The stored theme. Light unless the user chose dark. */
export function readThemePreference(storage: PreferenceStorage | null = defaultStorage()): EditorTheme {
  if (storage === null) return 'light';
  try {
    return storage.getItem(THEME_PREFERENCE_KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    // Blocked storage (private mode, sandbox) reads as the default.
    return 'light';
  }
}

/** Stores the theme. A storage failure only loses the preference. */
export function writeThemePreference(
  theme: EditorTheme,
  storage: PreferenceStorage | null = defaultStorage(),
): void {
  if (storage === null) return;
  try {
    storage.setItem(THEME_PREFERENCE_KEY, theme);
  } catch (error) {
    console.warn('[editor] could not store the theme preference', error);
  }
}
