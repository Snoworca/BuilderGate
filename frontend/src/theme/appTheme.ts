// The app theme (FR-UIDS-018): dark, light, or the OS choice, kept in
// localStorage. public/theme-boot.js applies the stored choice before the first
// paint (AC-6) and has to stay in step with this module: same key, same
// resolution (tests/unit/appTheme.test.ts runs both). The settings card of
// FR-UIDS-020 chooses through setThemePreference, and startAppTheme takes over
// from the boot script at app start; both follow the OS with SYSTEM_DARK_QUERY
// while the choice is 'system'.
// @req FR-UIDS-018 AC-6

export type ThemePreference = 'dark' | 'light' | 'system';
export type ResolvedTheme = 'dark' | 'light';

export const APP_THEME_STORAGE_KEY = 'buildergate.theme';

/** The media query the OS dark preference is read from. */
export const SYSTEM_DARK_QUERY = '(prefers-color-scheme: dark)';

type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>;
/** The part of a MediaQueryList the theme reads and, for 'system', listens to. */
interface SystemDarkQuery {
  matches: boolean;
  addEventListener?(type: 'change', listener: (event: { matches: boolean }) => void): void;
  removeEventListener?(type: 'change', listener: (event: { matches: boolean }) => void): void;
}
type MediaQueryHost = { matchMedia?: (query: string) => SystemDarkQuery };

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

type AppliedThemeListener = (theme: ResolvedTheme) => void;

const appliedThemeListeners = new Set<AppliedThemeListener>();

function defaultRoot(): Pick<HTMLElement, 'dataset'> | null {
  return typeof document === 'undefined' ? null : document.documentElement;
}

// @req FR-UIDS-019 AC-3
/** The theme on the root element now, as theme-boot.js or applyTheme put it there. */
export function readAppliedTheme(root: Pick<HTMLElement, 'dataset'> | null = defaultRoot()): ResolvedTheme {
  return root?.dataset.theme === 'light' ? 'light' : 'dark';
}

// @req FR-UIDS-019 AC-3
/**
 * Calls `listener` with each theme applyTheme puts on the root from now on, which is
 * how the open terminals repaint without a reload. Returns the unsubscribe.
 */
export function subscribeAppliedTheme(listener: AppliedThemeListener): () => void {
  appliedThemeListeners.add(listener);
  return () => {
    appliedThemeListeners.delete(listener);
  };
}

// @req FR-UIDS-018 AC-1
// @req FR-UIDS-019 AC-3
/**
 * Puts the theme on the root element, where tokens.css reads it (`:root[data-theme="light"]`),
 * and tells the subscribers when it changed. A failing subscriber is reported and
 * skipped, so one terminal cannot keep the others or the page on the old theme.
 */
export function applyTheme(
  theme: ResolvedTheme,
  root: Pick<HTMLElement, 'dataset'> = document.documentElement,
): void {
  if (root.dataset.theme === theme) return;
  root.dataset.theme = theme;
  for (const listener of [...appliedThemeListeners]) {
    try {
      listener(theme);
    } catch (error) {
      console.warn('[theme] a theme listener failed', error);
    }
  }
}

// ---- the settings choice (FR-UIDS-020) --------------------------------------------

interface ThemeEnvironment {
  storage?: PreferenceStorage | null;
  host?: MediaQueryHost | null;
  root?: Pick<HTMLElement, 'dataset'> | null;
}

/** The choice in effect on this page, once startAppTheme or the settings card has made one. */
let activePreference: ThemePreference | null = null;
/** Set while the choice in effect is 'system'. */
let stopFollowingSystem: (() => void) | null = null;

// @req FR-UIDS-020 AC-4
/** Re-applies the theme on each change of the OS dark preference. Returns the stop. */
function followSystem(host: MediaQueryHost | null, root: Pick<HTMLElement, 'dataset'>): () => void {
  let query: SystemDarkQuery | undefined;
  try {
    query = host?.matchMedia?.(SYSTEM_DARK_QUERY);
  } catch {
    query = undefined;
  }
  const watched = query;
  if (!watched || typeof watched.addEventListener !== 'function') return () => {};
  const onChange = (event: { matches: boolean }) => applyTheme(resolveTheme('system', event.matches), root);
  watched.addEventListener('change', onChange);
  return () => watched.removeEventListener?.('change', onChange);
}

// @req FR-UIDS-020 AC-3
// @req FR-UIDS-020 AC-4
function activate(
  preference: ThemePreference,
  host: MediaQueryHost | null,
  root: Pick<HTMLElement, 'dataset'> | null,
): void {
  activePreference = preference;
  stopFollowingSystem?.();
  stopFollowingSystem = null;
  if (root === null) return;
  applyTheme(resolveTheme(preference, systemPrefersDark(host)), root);
  if (preference === 'system') stopFollowingSystem = followSystem(host, root);
}

// @req FR-UIDS-020 AC-2
// @req FR-UIDS-020 AC-4
/**
 * Runs once as the app starts. theme-boot.js has already put the stored choice on the root;
 * this applies the same answer through applyTheme, so readAppliedTheme and the subscribers
 * agree with it, and from here on follows the OS while the choice is 'system'.
 */
export function startAppTheme({
  storage = defaultStorage(),
  host = defaultHost(),
  root = defaultRoot(),
}: ThemeEnvironment = {}): void {
  activate(readThemePreference(storage), host, root);
}

// @req FR-UIDS-020 AC-2
// @req FR-UIDS-020 AC-3
// @req FR-UIDS-020 AC-4
/**
 * The settings card's choice: stored for the next visit and applied to this page at once.
 * Where the storage refuses the write the choice still holds for this page, and the next
 * visit starts dark.
 */
export function setThemePreference(
  preference: ThemePreference,
  { storage = defaultStorage(), host = defaultHost(), root = defaultRoot() }: ThemeEnvironment = {},
): void {
  writeThemePreference(preference, storage);
  activate(preference, host, root);
}

// @req FR-UIDS-020 AC-1
/** The choice in effect on this page: the one made here, else the stored one (dark by default). */
export function currentThemePreference(storage: PreferenceStorage | null = defaultStorage()): ThemePreference {
  return activePreference ?? readThemePreference(storage);
}
