import { useRef, useCallback } from 'react';

const STORAGE_KEY = 'terminal_font_size';

interface UsePinchZoomOptions {
  minSize: number;
  maxSize: number;
  defaultSize: number;
  onFontSizeChange: (size: number) => void;
}

export function usePinchZoom({
  minSize,
  maxSize,
  defaultSize,
  onFontSizeChange,
}: UsePinchZoomOptions) {
  const startDistanceRef = useRef(0);
  const startFontSizeRef = useRef(defaultSize);
  const rafRef = useRef<number | null>(null);

  const getDistance = useCallback((t1: Touch, t2: Touch) => {
    return Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
  }, []);

  const clamp = useCallback(
    (value: number) => Math.max(minSize, Math.min(maxSize, value)),
    [minSize, maxSize]
  );

  const handleTouchStart = useCallback(
    (e: TouchEvent) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        startDistanceRef.current = getDistance(e.touches[0], e.touches[1]);
        const saved = localStorage.getItem(STORAGE_KEY);
        startFontSizeRef.current = saved ? parseInt(saved, 10) || defaultSize : defaultSize;
      }
    },
    [getDistance, defaultSize]
  );

  const handleTouchMove = useCallback(
    (e: TouchEvent) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        if (rafRef.current) cancelAnimationFrame(rafRef.current);

        rafRef.current = requestAnimationFrame(() => {
          const currentDistance = getDistance(e.touches[0], e.touches[1]);
          const ratio = currentDistance / startDistanceRef.current;
          const newSize = clamp(Math.round(startFontSizeRef.current * ratio));
          onFontSizeChange(newSize);
          localStorage.setItem(STORAGE_KEY, newSize.toString());
        });
      }
    },
    [getDistance, clamp, onFontSizeChange]
  );

  const handleTouchEnd = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const getInitialFontSize = useCallback(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const size = parseInt(saved, 10);
      if (!isNaN(size) && size >= minSize && size <= maxSize) return size;
    }
    return defaultSize;
  }, [minSize, maxSize, defaultSize]);

  return { handleTouchStart, handleTouchMove, handleTouchEnd, getInitialFontSize };
}
