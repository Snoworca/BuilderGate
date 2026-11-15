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
