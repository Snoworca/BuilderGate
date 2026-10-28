/**
 * How fast a one-finger drag scrolls a mobile terminal (FR-ARCH-015). Kept in this browser only:
 * how fast a drag feels depends on the device, so the server does not share it.
 */

export interface MobileScrollStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

// The default keeps the scrolling every user had before the setting existed.
export const MOBILE_SCROLL_SPEED_DEFAULT = 1;
export const MOBILE_SCROLL_SPEED_MIN = 0.25;
export const MOBILE_SCROLL_SPEED_MAX = 2;
export const MOBILE_SCROLL_SPEED_OPTIONS = [0.25, 0.5, 0.75, 1, 1.5, 2] as const;

const KEY = 'buildergate.mobileScroll.speed';

export function clampMobileScrollSpeed(speed: number): number {
  if (!Number.isFinite(speed)) return MOBILE_SCROLL_SPEED_DEFAULT;
  return Math.min(MOBILE_SCROLL_SPEED_MAX, Math.max(MOBILE_SCROLL_SPEED_MIN, speed));
}

export function readMobileScrollSpeed(storage: MobileScrollStorage): number {
  let value: string | null;
  try {
    value = storage.getItem(KEY);
  } catch {
    return MOBILE_SCROLL_SPEED_DEFAULT; // private mode or blocked site data
  }
  return value === null ? MOBILE_SCROLL_SPEED_DEFAULT : clampMobileScrollSpeed(Number(value));
}

export function writeMobileScrollSpeed(storage: MobileScrollStorage, speed: number): void {
  try {
    storage.setItem(KEY, String(clampMobileScrollSpeed(speed)));
  } catch {
    // Not stored; this page keeps using the value it has.
  }
}

/** This browser's speed; the default when its storage cannot be reached. */
export function readBrowserMobileScrollSpeed(): number {
  try {
    return readMobileScrollSpeed(globalThis.localStorage);
  } catch {
    return MOBILE_SCROLL_SPEED_DEFAULT;
  }
}

export function writeBrowserMobileScrollSpeed(speed: number): void {
  try {
    writeMobileScrollSpeed(globalThis.localStorage, speed);
  } catch {
    // No storage here: the setting lasts until the page reloads.
  }
}
