// ============================================================================
// BuilderGate Pane Split System - PaneCarousel (Phase 4: Mobile)
// Horizontal swipe carousel for mobile pane navigation.
// ============================================================================

import React, { useRef, useState, useCallback } from 'react';
import type { PaneLeaf } from '../../types/pane.types';

interface PaneCarouselProps {
  leaves: PaneLeaf[];
  focusedIndex: number;
  onSwipe: (newIndex: number) => void;
  renderTerminal: (sessionId: string, paneId: string) => React.ReactNode;
  onLongPress?: (paneId: string) => void;
}

export const PaneCarousel: React.FC<PaneCarouselProps> = ({
  leaves,
  focusedIndex,
  onSwipe,
  renderTerminal,
  onLongPress,
}) => {
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragOffset, setDragOffset] = useState(0);
  const [isDragging, setIsDragging] = useState(false);

  // Touch state refs (avoid re-renders during gesture)
  const touchState = useRef<{
    startX: number;
    startY: number;
    startTime: number;
    isSwipeMode: boolean | null; // null = undecided
    longPressTimer: ReturnType<typeof setTimeout> | null;
    moved: boolean;
  }>({
    startX: 0,
    startY: 0,
    startTime: 0,
    isSwipeMode: null,
    longPressTimer: null,
    moved: false,
  });

  const clearLongPress = useCallback(() => {
    if (touchState.current.longPressTimer !== null) {
      clearTimeout(touchState.current.longPressTimer);
      touchState.current.longPressTimer = null;
    }
  }, []);

  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      const touch = e.touches[0];
      const ts = touchState.current;
      ts.startX = touch.clientX;
      ts.startY = touch.clientY;
      ts.startTime = Date.now();
      ts.isSwipeMode = null;
      ts.moved = false;

      setIsDragging(true);
      setDragOffset(0);

      // Long-press detection: 500ms hold without >10px movement
      clearLongPress();
      if (onLongPress) {
        ts.longPressTimer = setTimeout(() => {
          if (!ts.moved) {
            onLongPress(leaves[focusedIndex]?.id ?? '');
          }
        }, 500);
      }
    },
    [clearLongPress, onLongPress, leaves, focusedIndex],
  );

  const handleTouchMove = useCallback(
    (e: React.TouchEvent) => {
      const touch = e.touches[0];
      const ts = touchState.current;
      const deltaX = touch.clientX - ts.startX;
      const deltaY = touch.clientY - ts.startY;

      // Check if movement exceeds 10px → cancel long-press
      if (Math.abs(deltaX) > 10 || Math.abs(deltaY) > 10) {
        ts.moved = true;
        clearLongPress();
      }

      // Decide swipe vs scroll within first 50ms or first significant movement
      if (ts.isSwipeMode === null) {
        const elapsed = Date.now() - ts.startTime;
        if (elapsed < 50 && Math.abs(deltaX) < 5 && Math.abs(deltaY) < 5) {
          return; // Wait for more data
        }
        ts.isSwipeMode = Math.abs(deltaX) > Math.abs(deltaY);
      }

      if (!ts.isSwipeMode) return;

      // Bounce effect at edges
      let offset = deltaX;
      if (
        (focusedIndex === 0 && deltaX > 0) ||
        (focusedIndex === leaves.length - 1 && deltaX < 0)
      ) {
        offset = deltaX * 0.3; // Rubber-band
      }

      setDragOffset(offset);
    },
    [focusedIndex, leaves.length, clearLongPress],
  );

  const handleTouchEnd = useCallback(() => {
    clearLongPress();
    const ts = touchState.current;

    setIsDragging(false);

    if (ts.isSwipeMode && ts.moved) {
      if (dragOffset > 50 && focusedIndex > 0) {
        onSwipe(focusedIndex - 1);
      } else if (dragOffset < -50 && focusedIndex < leaves.length - 1) {
        onSwipe(focusedIndex + 1);
      }
    }

    setDragOffset(0);
  }, [clearLongPress, dragOffset, focusedIndex, leaves.length, onSwipe]);

  const translateX = -focusedIndex * 100;
  const pxOffset = isDragging ? dragOffset : 0;

  return (
    <div
      className="pane-carousel"
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchEnd}
    >
      <div
        ref={trackRef}
        className={`pane-carousel-track${!isDragging ? ' snapping' : ''}`}
        style={{
          transform: `translateX(calc(${translateX}% + ${pxOffset}px))`,
        }}
      >
        {leaves.map((leaf) => (
          <div key={leaf.id} className="pane-carousel-item">
            {renderTerminal(leaf.sessionId, leaf.id)}
          </div>
        ))}
      </div>
    </div>
  );
};
