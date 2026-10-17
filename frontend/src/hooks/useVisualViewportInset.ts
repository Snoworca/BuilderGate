// Height the system keyboard takes from the bottom of the screen, read from
// window.visualViewport. The mobile key bar sits right above it, and the app
// root follows the visual viewport while the bar is shown so the terminal's last
// row is not hidden behind the keyboard.
import { useEffect, useState } from 'react';

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
