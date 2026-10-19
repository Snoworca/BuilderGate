/**
 * FR-ARCH-011: iOS Safari does not shrink the layout when the on-screen
 * keyboard opens. It pans the visual viewport instead, which pushed the header
 * and the tab bar above the visible area of a 100%-high, overflow-hidden app.
 * This publishes the visible height as a CSS custom property while the
 * keyboard is open and scrolls the layout back to the top.
 */

export const APP_HEIGHT_PROPERTY = '--app-height';

export interface VisualViewportLike {
  height: number;
  offsetTop: number;
  scale: number;
  addEventListener(type: 'resize' | 'scroll', listener: () => void): void;
  removeEventListener(type: 'resize' | 'scroll', listener: () => void): void;
}

export interface ViewportWindowLike {
  innerHeight: number;
  scrollY: number;
  visualViewport?: VisualViewportLike | null;
  scrollTo(x: number, y: number): void;
}

export interface StyleRootLike {
  style: {
    setProperty(name: string, value: string): void;
    removeProperty(name: string): unknown;
  };
}

/** A zoom other than 1 means the user is pinch-zooming; leave the page alone. */
const SCALE_EPSILON = 0.01;

export function installVisualViewportHeightSync(win: ViewportWindowLike, root: StyleRootLike): () => void {
  const viewport = win.visualViewport;
  if (!viewport) {
    return () => {};
  }

  const sync = () => {
    if (Math.abs(viewport.scale - 1) > SCALE_EPSILON) {
      root.style.removeProperty(APP_HEIGHT_PROPERTY);
      return;
    }

    const visibleHeight = Math.floor(viewport.height);
    if (visibleHeight < win.innerHeight - 1) {
      root.style.setProperty(APP_HEIGHT_PROPERTY, `${visibleHeight}px`);
    } else {
      root.style.removeProperty(APP_HEIGHT_PROPERTY);
    }

    if (win.scrollY !== 0 || viewport.offsetTop !== 0) {
      win.scrollTo(0, 0);
    }
  };

  viewport.addEventListener('resize', sync);
  viewport.addEventListener('scroll', sync);
  sync();

  return () => {
    viewport.removeEventListener('resize', sync);
    viewport.removeEventListener('scroll', sync);
    root.style.removeProperty(APP_HEIGHT_PROPERTY);
  };
}
