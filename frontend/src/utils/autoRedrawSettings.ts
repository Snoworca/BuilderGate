/**
 * Automatic redraw after a workspace or tab switch (REL-BGSTAB-053 AC-5). Kept in this browser
 * only: how a screen settles depends on the device, so the server does not share it.
 */

export interface AutoRedrawSettings {
  onWorkspaceSwitch: boolean;
  onTabSwitch: boolean;
  delayMs: number;
}

export interface AutoRedrawStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const AUTO_REDRAW_DELAY_DEFAULT_MS = 1500;
export const AUTO_REDRAW_DELAY_MIN_MS = 500;
export const AUTO_REDRAW_DELAY_MAX_MS = 5000;

const KEYS = {
  onWorkspaceSwitch: 'buildergate.autoRedraw.onWorkspaceSwitch',
  onTabSwitch: 'buildergate.autoRedraw.onTabSwitch',
  delayMs: 'buildergate.autoRedraw.delayMs',
} as const;

export const AUTO_REDRAW_DEFAULTS: AutoRedrawSettings = {
  onWorkspaceSwitch: true,
  onTabSwitch: true,
  delayMs: AUTO_REDRAW_DELAY_DEFAULT_MS,
};

export function clampAutoRedrawDelay(ms: number): number {
  if (!Number.isFinite(ms)) return AUTO_REDRAW_DELAY_DEFAULT_MS;
  return Math.min(AUTO_REDRAW_DELAY_MAX_MS, Math.max(AUTO_REDRAW_DELAY_MIN_MS, Math.round(ms)));
}

function readItem(storage: AutoRedrawStorage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null; // private mode or blocked site data: the defaults apply
  }
}

export function readAutoRedrawSettings(storage: AutoRedrawStorage): AutoRedrawSettings {
  const flag = (key: string, fallback: boolean) => {
    const value = readItem(storage, key);
    return value === null ? fallback : value === 'true';
  };
  const delay = readItem(storage, KEYS.delayMs);
  return {
    onWorkspaceSwitch: flag(KEYS.onWorkspaceSwitch, AUTO_REDRAW_DEFAULTS.onWorkspaceSwitch),
    onTabSwitch: flag(KEYS.onTabSwitch, AUTO_REDRAW_DEFAULTS.onTabSwitch),
    delayMs: delay === null ? AUTO_REDRAW_DELAY_DEFAULT_MS : clampAutoRedrawDelay(Number(delay)),
  };
}

export function writeAutoRedrawSettings(storage: AutoRedrawStorage, settings: AutoRedrawSettings): void {
  try {
    storage.setItem(KEYS.onWorkspaceSwitch, String(settings.onWorkspaceSwitch));
    storage.setItem(KEYS.onTabSwitch, String(settings.onTabSwitch));
    storage.setItem(KEYS.delayMs, String(clampAutoRedrawDelay(settings.delayMs)));
  } catch {
    // Not stored; this page keeps using the values it has.
  }
}

/** This browser's settings; the defaults when its storage cannot be reached. */
export function readBrowserAutoRedrawSettings(): AutoRedrawSettings {
  try {
    return readAutoRedrawSettings(globalThis.localStorage);
  } catch {
    return { ...AUTO_REDRAW_DEFAULTS };
  }
}

export function writeBrowserAutoRedrawSettings(settings: AutoRedrawSettings): void {
  try {
    writeAutoRedrawSettings(globalThis.localStorage, settings);
  } catch {
    // No storage here: the setting lasts until the page reloads.
  }
}
