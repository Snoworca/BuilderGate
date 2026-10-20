import { useCallback, useRef } from 'react';
import { createDoubleTapDetector, tapPointOf, DOUBLE_TAP_SLOP_PX, type TouchEndLike } from './doubleTap.ts';

/**
 * FR-UIDS-013: a double tap alone, for elements whose long press is the browser's own
 * contextmenu (Android only) rather than a timer: the status bar path, workspace tabs and
 * sidebar workspaces. The second touchend is cancelled, so it raises no click or dblclick.
 * `isolate` stops the touches here so an ancestor with its own menu does not see them.
 * @req FR-UIDS-013
 */
export function useDoubleTap(
  callback: (point: { clientX: number; clientY: number }, target: EventTarget | null) => void,
  options: { isolate?: boolean } = {},
): {
  onTouchStart: (e: React.TouchEvent) => void;
  onTouchEnd: (e: React.TouchEvent) => void;
} {
  const detectorRef = useRef(createDoubleTapDetector());
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const isolate = options.isolate === true;

  // No touchmove listener: a scroll is told apart by where the touch ended, so nothing here
  // can stand in the way of a scrolling strip (FR-ARCH-011 AC-5).
  const onTouchStart = useCallback((e: React.TouchEvent) => {
    if (isolate) e.stopPropagation();
    const touch = e.touches[0];
    startRef.current = e.touches.length === 1 && touch !== undefined ? { x: touch.clientX, y: touch.clientY } : null;
  }, [isolate]);

  const onTouchEnd = useCallback((e: React.TouchEvent) => {
    if (isolate) e.stopPropagation();
    const start = startRef.current;
    startRef.current = null;
    const point = start === null ? null : tapPointOf(e as TouchEndLike, Date.now());
    if (point === null || start === null || Math.hypot(point.x - start.x, point.y - start.y) > DOUBLE_TAP_SLOP_PX) {
      detectorRef.current.reset();
      return;
    }
    if (!detectorRef.current.tap(point)) return;
    e.preventDefault();
    callback({ clientX: point.x, clientY: point.y }, e.target);
  }, [callback, isolate]);

  return { onTouchStart, onTouchEnd };
}
