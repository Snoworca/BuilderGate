import { useRef, useCallback } from 'react';

/**
 * Detects a long-press gesture on touch devices.
 * - Triggers `callback` after `ms` milliseconds of continuous press.
 * - Cancelled if the finger moves more than a small threshold.
 * - Fires navigator.vibrate(50) feedback when the threshold is reached.
 */
export function useLongPress(
  callback: (e: { clientX: number; clientY: number }) => void,
  ms: number = 500,
): {
  onTouchStart: (e: React.TouchEvent) => void;
  onTouchEnd: () => void;
  onTouchMove: () => void;
} {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startPosRef = useRef<{ x: number; y: number } | null>(null);

  const clear = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    startPosRef.current = null;
  }, []);

  const onTouchStart = useCallback(
    (e: React.TouchEvent) => {
      const touch = e.touches[0];
      if (!touch) return;
      startPosRef.current = { x: touch.clientX, y: touch.clientY };
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        if (navigator.vibrate) {
          navigator.vibrate(50);
        }
        if (startPosRef.current) {
          callback({ clientX: startPosRef.current.x, clientY: startPosRef.current.y });
        }
      }, ms);
    },
    [callback, ms],
  );

  const onTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (!startPosRef.current || timerRef.current === null) return;
      const touch = e.touches[0];
      if (!touch) return;
      const dx = touch.clientX - startPosRef.current.x;
      const dy = touch.clientY - startPosRef.current.y;
      // Cancel if moved more than 10px
      if (Math.sqrt(dx * dx + dy * dy) > 10) {
        clear();
      }
    },
    [clear],
  );

  const onTouchEnd = useCallback(() => {
    clear();
  }, [clear]);

  return { onTouchStart, onTouchEnd, onTouchMove };
}
