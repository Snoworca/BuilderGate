// Height the system keyboard takes from the bottom of the screen, read from
// window.visualViewport. The mobile key bar sits right above it, and the app
// root follows the visual viewport while the bar is shown so the terminal's last
// row is not hidden behind the keyboard.
import { useEffect, useLayoutEffect, useState } from 'react';
import type { RefObject } from 'react';

export interface ViewportBox {
  top: number;
  height: number;
  inset: number;
}

let lastKeyboardInset = 0;

/** Pure: inset = max(0, innerHeight - (vv.height + vv.offsetTop)). */
// @req FR-MKB-007
export function computeViewportBox(win: Window): ViewportBox {
  const vv = win.visualViewport;
  if (!vv) return { top: 0, height: win.innerHeight, inset: 0 };
  const inset = Math.max(0, win.innerHeight - (vv.height + vv.offsetTop));
  return { top: vv.offsetTop, height: vv.height, inset };
}

/** Last inset greater than 0 that any measurement saw, else 0. */
// @req FR-MKB-007
export function getLastKeyboardInset(): number {
  return lastKeyboardInset;
}

function measure(): ViewportBox {
  const box = computeViewportBox(window);
  if (box.inset > 0) lastKeyboardInset = box.inset;
  return box;
}

function sameBox(a: ViewportBox, b: ViewportBox): boolean {
  return a.top === b.top && a.height === b.height && a.inset === b.inset;
}

/** Re-measures on visualViewport resize and scroll while active. */
// @req FR-MKB-007
export function useVisualViewportInset(active: boolean): ViewportBox {
  const [box, setBox] = useState<ViewportBox>(() => computeViewportBox(window));

  useEffect(() => {
    if (!active) return undefined;
    const update = (): void => {
      const next = measure();
      setBox(prev => (sameBox(prev, next) ? prev : next));
    };
    update();
    const vv = window.visualViewport;
    if (!vv) return undefined;
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, [active]);

  return box;
}

const VIEWPORT_TOP_VAR = '--app-viewport-top';
const VIEWPORT_HEIGHT_VAR = '--app-viewport-height';

/** Writes the box onto the element as the two CSS variables the locked .app reads, or removes them. */
// @req FR-MKB-007
export function applyViewportBox(element: HTMLElement, box: ViewportBox | null): void {
  if (box === null) {
    element.style.removeProperty(VIEWPORT_TOP_VAR);
    element.style.removeProperty(VIEWPORT_HEIGHT_VAR);
    return;
  }
  element.style.setProperty(VIEWPORT_TOP_VAR, `${box.top}px`);
  element.style.setProperty(VIEWPORT_HEIGHT_VAR, `${box.height}px`);
}

/** How long the system keyboard's open/close animation is given to finish. */
export const KEYBOARD_SETTLE_MS = 300;

/**
 * The browser scrolls the document to show the focused input while the keyboard
 * is up, even with overflow hidden on the root. Once the keyboard is down that
 * scroll only shifts the app up and leaves the keyboard's place blank (#143).
 */
// @req FR-MKB-012
function resetDocumentScroll(): void {
  if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0);
}

/**
 * While active, keeps the element's --app-viewport-top/--app-viewport-height in
 * step with the visual viewport. Writes go straight to the element's style and
 * are coalesced to one per animation frame, so the owner never re-renders on a
 * viewport resize or scroll (iOS fires scroll continuously during a pan).
 */
// @req FR-MKB-007
// @req FR-MKB-012
export function useVisualViewportLock(active: boolean, targetRef: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const element = targetRef.current;
    if (!active || element === null) return undefined;
    const apply = (): void => {
      const box = measure();
      applyViewportBox(element, box);
      if (box.inset === 0) resetDocumentScroll();
    };
    apply();
    const vv = window.visualViewport;
    if (!vv) {
      return () => {
        applyViewportBox(element, null);
        resetDocumentScroll();
      };
    }
    let frame: number | null = null;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    const flush = (): void => {
      frame = null;
      apply();
    };
    const schedule = (): void => {
      if (frame === null) frame = window.requestAnimationFrame(flush);
      // The last event can carry a value from the middle of the keyboard
      // animation; measure once more after it has had time to finish.
      if (settleTimer !== null) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        settleTimer = null;
        remeasure();
      }, KEYBOARD_SETTLE_MS);
    };
    const remeasure = (): void => {
      if (frame === null) frame = window.requestAnimationFrame(flush);
    };
    vv.addEventListener('resize', schedule);
    vv.addEventListener('scroll', schedule);
    window.addEventListener('resize', schedule);
    return () => {
      vv.removeEventListener('resize', schedule);
      vv.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      if (frame !== null) window.cancelAnimationFrame(frame);
      if (settleTimer !== null) clearTimeout(settleTimer);
      applyViewportBox(element, null);
      resetDocumentScroll();
      // The keyboard is usually still closing when focus leaves; the browser
      // can scroll the document once more before it is done.
      setTimeout(() => {
        if (computeViewportBox(window).inset === 0) resetDocumentScroll();
      }, KEYBOARD_SETTLE_MS);
    };
  }, [active, targetRef]);
}
