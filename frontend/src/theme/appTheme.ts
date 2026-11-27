// The app theme (FR-UIDS-018): dark, light, or the OS choice, kept in
// localStorage. public/theme-boot.js applies the stored choice before the first
// paint (AC-6) and has to stay in step with this module: same key, same
// resolution (tests/unit/appTheme.test.ts runs both). The settings card of
// FR-UIDS-020 writes through writeThemePreference and follows the OS with
// SYSTEM_DARK_QUERY when the choice is 'system'.
// @req FR-UIDS-018 AC-6

export type ThemePreference = 'dark' | 'light' | 'system';
export type ResolvedTheme = 'dark' | 'light';

export const APP_THEME_STORAGE_KEY = 'buildergate.theme';

/** The media query the OS dark preference is read from. */
export const SYSTEM_DARK_QUERY = '(prefers-color-scheme: dark)';

type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>;
type MediaQueryHost = { matchMedia?: (query: string) => { matches: boolean } };

function defaultStorage(): PreferenceStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function defaultHost(): MediaQueryHost | null {
  return typeof window === 'undefined' ? null : window;
}

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'dark' || value === 'light' || value === 'system';
}

/** The stored choice. Dark unless the user chose light or system. */
export function readThemePreference(storage: PreferenceStorage | null = defaultStorage()): ThemePreference {
  if (storage === null) return 'dark';
  try {
    const stored = storage.getItem(APP_THEME_STORAGE_KEY);
    return isThemePreference(stored) ? stored : 'dark';
  } catch {
    // Blocked storage (private mode, sandbox) reads as the default.
    return 'dark';
  }
}

/** Stores the choice. A storage failure only loses the preference. */
export function writeThemePreference(
  preference: ThemePreference,
  storage: PreferenceStorage | null = defaultStorage(),
): void {
  if (storage === null) return;
  try {
    storage.setItem(APP_THEME_STORAGE_KEY, preference);
  } catch (error) {
    console.warn('[theme] could not store the theme preference', error);
  }
}

/** Whether the OS asks for dark. Dark where it cannot be read, as the app default is dark. */
export function systemPrefersDark(host: MediaQueryHost | null = defaultHost()): boolean {
  if (!host || typeof host.matchMedia !== 'function') return true;
  try {
    return host.matchMedia(SYSTEM_DARK_QUERY).matches;
  } catch {
    return true;
  }
}

export function resolveTheme(preference: ThemePreference, prefersDark: boolean): ResolvedTheme {
  if (preference === 'system') return prefersDark ? 'dark' : 'light';
  return preference;
}

// @req FR-UIDS-018 AC-1
/** Puts the theme on the root element, where tokens.css reads it (`:root[data-theme="light"]`). */
export function applyTheme(
  theme: ResolvedTheme,
  root: Pick<HTMLElement, 'dataset'> = document.documentElement,
): void {
  root.dataset.theme = theme;
}
