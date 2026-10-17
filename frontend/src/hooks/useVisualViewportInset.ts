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

/**
 * While active, keeps the element's --app-viewport-top/--app-viewport-height in
 * step with the visual viewport. Writes go straight to the element's style and
 * are coalesced to one per animation frame, so the owner never re-renders on a
 * viewport resize or scroll (iOS fires scroll continuously during a pan).
 */
// @req FR-MKB-007
export function useVisualViewportLock(active: boolean, targetRef: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const element = targetRef.current;
    if (!active || element === null) return undefined;
    applyViewportBox(element, measure());
    const vv = window.visualViewport;
    if (!vv) {
      return () => { applyViewportBox(element, null); };
    }
    let frame: number | null = null;
    const flush = (): void => {
      frame = null;
      applyViewportBox(element, measure());
    };
    const schedule = (): void => {
      if (frame === null) frame = window.requestAnimationFrame(flush);
    };
    vv.addEventListener('resize', schedule);
    vv.addEventListener('scroll', schedule);
    return () => {
      vv.removeEventListener('resize', schedule);
      vv.removeEventListener('scroll', schedule);
      if (frame !== null) window.cancelAnimationFrame(frame);
      applyViewportBox(element, null);
    };
  }, [active, targetRef]);
}
