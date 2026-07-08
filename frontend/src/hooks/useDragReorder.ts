import { useState, useRef, useEffect, useCallback } from 'react';

export type DragReorderAxis = 'x' | 'y';

export interface DragReorderRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ComputeDragReorderTargetInput {
  axis: DragReorderAxis;
  pointer: number;
  itemRects: DragReorderRect[];
}

interface UseDragReorderOptions {
  onReorder: (fromIndex: number, toIndex: number) => void;
  isLocked: (index: number) => boolean;
  longPressMs?: number;
  axis?: DragReorderAxis;
}

export interface UseDragReorderReturn {
  dragIndex: number | null;
  dropTargetIndex: number | null;
  ghostStyle: React.CSSProperties | null;
  getTabHandlers: (index: number) => {
    onPointerDown: (e: React.PointerEvent) => void;
  };
  tabRefs: React.MutableRefObject<(HTMLElement | null)[]>;
}

export function computeDragReorderTarget({
  axis,
  pointer,
  itemRects,
}: ComputeDragReorderTargetInput): number {
  for (let i = 0; i < itemRects.length; i += 1) {
    const rect = itemRects[i];
    const mid = axis === 'x'
      ? rect.left + rect.width / 2
      : rect.top + rect.height / 2;
    if (pointer < mid) {
      return i;
    }
  }
  return itemRects.length;
}

export function useDragReorder({
  onReorder,
  isLocked,
  longPressMs = 300,
  axis = 'x',
}: UseDragReorderOptions): UseDragReorderReturn {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropTargetIndex, setDropTargetIndex] = useState<number | null>(null);
  const [ghostStyle, setGhostStyle] = useState<React.CSSProperties | null>(null);

  const tabRefs = useRef<(HTMLElement | null)[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startPos = useRef({ x: 0, y: 0 });
  const isDragging = useRef(false);
  const dragIndexRef = useRef<number | null>(null);
  const onReorderRef = useRef(onReorder);
  // Store the original rect of the dragged tab for ghost offset
  const dragOriginRect = useRef<DOMRect | null>(null);
  // Offset from pointer to tab left edge
  const pointerOffset = useRef({ x: 0, y: 0 });

  useEffect(() => {
    onReorderRef.current = onReorder;
  }, [onReorder]);

  // Compute drop target from pointer position on the configured axis.
  function computeDropTarget(pointer: number): number | null {
    const fromIdx = dragIndexRef.current;
    if (fromIdx === null) return null;

    const itemRects = tabRefs.current
      .map((el) => el?.getBoundingClientRect() ?? null)
      .filter((rect): rect is DOMRect => rect !== null);
    return computeDragReorderTarget({ axis, pointer, itemRects });
  }

  function onPointerMove(e: PointerEvent) {
    if (!isDragging.current) {
      // Before long press triggers, check if moved too far → cancel
      const dx = e.clientX - startPos.current.x;
      const dy = e.clientY - startPos.current.y;
      if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
        if (timerRef.current) {
          clearTimeout(timerRef.current);
          timerRef.current = null;
        }
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', onPointerUp);
        window.removeEventListener('pointercancel', onPointerUp);
      }
      return;
    }

    // Update ghost position
    const originRect = dragOriginRect.current;
    if (originRect) {
      setGhostStyle({
        position: 'fixed',
        left: axis === 'x' ? e.clientX - pointerOffset.current.x : originRect.left,
        top: axis === 'y' ? e.clientY - pointerOffset.current.y : originRect.top,
        width: originRect.width,
        height: originRect.height,
        pointerEvents: 'none',
        zIndex: 9999,
        opacity: 0.85,
      });
    }

    // Compute drop target
    const target = computeDropTarget(axis === 'x' ? e.clientX : e.clientY);
    setDropTargetIndex(target);
  }

  function onPointerUp() {
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerUp);

    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    if (isDragging.current && dragIndexRef.current !== null) {
      const from = dragIndexRef.current;
      setDropTargetIndex(prev => {
        if (prev !== null && prev !== from) {
          // Adjust: if dropping after the dragged item, account for removal
          const to = prev > from ? prev - 1 : prev;
          if (to !== from) {
            onReorderRef.current(from, to);
          }
        }
        return null;
      });
    }

    isDragging.current = false;
    dragIndexRef.current = null;
    dragOriginRect.current = null;
    setDragIndex(null);
    setGhostStyle(null);
  }

  const getTabHandlers = useCallback((index: number) => ({
    onPointerDown: (e: React.PointerEvent) => {
      if (isLocked(index)) return;
      if (e.button !== 0) return;

      // Prevent default to avoid text selection and browser drag on mobile
      e.preventDefault();

      startPos.current = { x: e.clientX, y: e.clientY };

      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerUp);
      window.addEventListener('pointercancel', onPointerUp);

      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        isDragging.current = true;
        dragIndexRef.current = index;

        // Capture the original rect for ghost
        const el = tabRefs.current[index];
        if (el) {
          const rect = el.getBoundingClientRect();
          dragOriginRect.current = rect;
          pointerOffset.current = {
            x: startPos.current.x - rect.left,
            y: startPos.current.y - rect.top,
          };
          // Set initial ghost at current position
          setGhostStyle({
            position: 'fixed',
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
            pointerEvents: 'none',
            zIndex: 9999,
            opacity: 0.85,
          });
        }

        setDragIndex(index);
        setDropTargetIndex(index);
      }, longPressMs);
    },
  }), [axis, isLocked, longPressMs]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
    };
  }, []);

  return { dragIndex, dropTargetIndex, ghostStyle, getTabHandlers, tabRefs };
}
