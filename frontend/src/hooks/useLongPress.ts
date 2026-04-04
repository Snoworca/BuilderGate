import { useRef, useCallback, useEffect } from 'react';

/**
 * Detects a long-press gesture on touch devices and desktop (pointer events).
 * - Triggers `callback` after `ms` milliseconds of continuous press.
 * - Cancelled if the finger/pointer moves more than 10px threshold.
 * - Fires navigator.vibrate(50) feedback when the threshold is reached.
 */
export function useLongPress(
  callback: (e: { clientX: number; clientY: number }) => void,
  ms: number = 500,
): {
  onTouchStart: (e: React.TouchEvent) => void;
  onTouchEnd: () => void;
  onTouchMove: (e: React.TouchEvent) => void;
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerUp: () => void;
  onPointerMove: (e: React.PointerEvent) => void;
  wasLongPress: () => boolean;
} {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startPosRef = useRef<{ x: number; y: number } | null>(null);
  // Touch-specific fired flag (separate from pointer)
  const touchFiredRef = useRef(false);
  // Pointer-specific fired flag
  const firedRef = useRef(false);

  // ── Touch helpers ────────────────────────────────────────────────────────────

  const clearTouch = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    startPosRef.current = null;
    touchFiredRef.current = false;
  }, []);

  const onTouchStart = useCallback(
    (e: React.TouchEvent) => {
      const touch = e.touches[0];
      if (!touch) return;
      startPosRef.current = { x: touch.clientX, y: touch.clientY };
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        touchFiredRef.current = true;
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
        clearTouch();
      }
    },
    [clearTouch],
  );

  const onTouchEnd = useCallback(() => {
    clearTouch();
  }, [clearTouch]);

  // ── Pointer helpers (desktop) ────────────────────────────────────────────────

  const pointerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pointerStartPosRef = useRef<{ x: number; y: number } | null>(null);

  const clearPointer = useCallback(() => {
    if (pointerTimerRef.current !== null) {
      clearTimeout(pointerTimerRef.current);
      pointerTimerRef.current = null;
    }
    pointerStartPosRef.current = null;
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      // Only handle primary button (left click)
      if (e.button !== 0) return;
      firedRef.current = false;
      pointerStartPosRef.current = { x: e.clientX, y: e.clientY };
      pointerTimerRef.current = setTimeout(() => {
        pointerTimerRef.current = null;
        firedRef.current = true;
        if (navigator.vibrate) {
          navigator.vibrate(50);
        }
        if (pointerStartPosRef.current) {
          callback({ clientX: pointerStartPosRef.current.x, clientY: pointerStartPosRef.current.y });
        }
      }, ms);
    },
    [callback, ms],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!pointerStartPosRef.current || pointerTimerRef.current === null) return;
      const dx = e.clientX - pointerStartPosRef.current.x;
      const dy = e.clientY - pointerStartPosRef.current.y;
      // Cancel if moved more than 10px
      if (Math.sqrt(dx * dx + dy * dy) > 10) {
        clearPointer();
      }
    },
    [clearPointer],
  );

  const onPointerUp = useCallback(() => {
    clearPointer();
  }, [clearPointer]);

  /**
   * Returns true if a pointer long-press fired since last call, then resets.
   * Use in onClick to distinguish long-press from click.
   */
  const wasLongPress = useCallback(() => {
    const fired = firedRef.current;
    firedRef.current = false;
    return fired;
  }, []);

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      if (pointerTimerRef.current !== null) clearTimeout(pointerTimerRef.current);
    };
  }, []);

  return {
    onTouchStart,
    onTouchEnd,
    onTouchMove,
    onPointerDown,
    onPointerUp,
    onPointerMove,
    wasLongPress,
  };
}
