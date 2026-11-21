/**
 * FR-ARCH-016 AC-6: BuilderGate opened from the iPhone home screen.
 *
 * With the opaque status bar style, iOS 26 starts the page below the status bar
 * but still sizes it to the whole screen, so the bottom of the app (the git
 * status row and a few terminal rows) fell off the screen from launch. In the
 * home-screen app the page now covers the whole screen (a translucent status
 * bar in index.html, viewport-fit=cover here) and globals.css keeps the content
 * inside the safe area with env(safe-area-inset-*) padding on the root.
 *
 * A browser tab is left exactly as it was (FR-ARCH-016 AC-4).
 */

export const STANDALONE_CLASS = 'standalone-app';

const COVER = 'viewport-fit=cover';

export interface StandaloneWindowLike {
  /** iOS adds a non-standard `standalone` flag to the navigator. */
  navigator: object;
  matchMedia?: (query: string) => { matches: boolean };
}

interface ViewportMetaLike {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
}

export interface StandaloneDocumentLike {
  querySelector(selector: string): ViewportMetaLike | null;
  documentElement: { classList: { add(name: string): void } };
}

/** Opened from the home screen: iOS sets navigator.standalone, other browsers report the display mode. */
// @req FR-ARCH-016
export function isStandaloneDisplay(win: StandaloneWindowLike): boolean {
  if ((win.navigator as { standalone?: unknown }).standalone === true) return true;
  return win.matchMedia?.('(display-mode: standalone)').matches === true;
}

/** In the home-screen app, covers the screen and marks the root for the safe-area padding. */
// @req FR-ARCH-016
export function installStandaloneViewport(win: StandaloneWindowLike, doc: StandaloneDocumentLike): boolean {
  if (!isStandaloneDisplay(win)) return false;
  const meta = doc.querySelector('meta[name="viewport"]');
  const content = meta?.getAttribute('content') ?? '';
  if (meta && !/viewport-fit\s*=/.test(content)) {
    meta.setAttribute('content', content ? `${content}, ${COVER}` : COVER);
  }
  doc.documentElement.classList.add(STANDALONE_CLASS);
  return true;
}

export interface SafeViewportSize {
  width: number;
  height: number;
}

/**
 * FR-ARCH-016 AC-7: the size a window that fills the screen gets. In a browser tab
 * it is the window; in the home-screen app it is the screen less the status bar
 * and the home indicator, measured because iOS may report innerHeight without
 * the status bar while still drawing the page from the top of the screen.
 */
// @req FR-ARCH-016
export function safeViewportSize(
  win: { innerWidth: number; innerHeight: number },
  standalone: boolean,
  measure: () => SafeViewportSize | null,
): SafeViewportSize {
  const plain = { width: win.innerWidth, height: win.innerHeight };
  if (!standalone) return plain;
  const measured = measure();
  return measured && measured.width > 0 && measured.height > 0 ? measured : plain;
}

const SAFE_AREA_PROBE = [
  'position:fixed',
  'visibility:hidden',
  'pointer-events:none',
  'top:0',
  'left:0',
  'width:calc(100vw - env(safe-area-inset-left, 0px) - env(safe-area-inset-right, 0px))',
  'height:calc(100lvh - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px))',
].join(';');

function measureSafeArea(): SafeViewportSize | null {
  if (typeof document === 'undefined' || !document.body) return null;
  const probe = document.createElement('div');
  probe.style.cssText = SAFE_AREA_PROBE;
  document.body.appendChild(probe);
  const rect = probe.getBoundingClientRect();
  probe.remove();
  return { width: Math.floor(rect.width), height: Math.floor(rect.height) };
}

/** The safe-area size for this page; the window layer is offset to match (globals.css). */
// @req FR-ARCH-016
export function readSafeViewportSize(): SafeViewportSize {
  const standalone = typeof document !== 'undefined'
    && document.documentElement.classList.contains(STANDALONE_CLASS);
  return safeViewportSize(window, standalone, measureSafeArea);
}
