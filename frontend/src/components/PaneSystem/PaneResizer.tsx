// ============================================================================
// BuilderGate Pane Split System - PaneResizer
// Drag resize handle between split panes.
// ============================================================================

import React, { useCallback, useRef } from 'react';

interface PaneResizerProps {
  splitId: string;
  direction: 'horizontal' | 'vertical';
  onResize: (splitId: string, ratio: number) => void;
  onResizeEnd: () => void;
  onContextMenu: (e: React.MouseEvent, splitId: string) => void;
}

export const PaneResizer: React.FC<PaneResizerProps> = ({
  splitId,
  direction,
  onResize,
  onResizeEnd,
  onContextMenu,
}) => {
  const resizerRef = useRef<HTMLDivElement>(null);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const resizer = resizerRef.current;
      if (!resizer) return;

      // Capture pointer for reliable tracking
      resizer.setPointerCapture(e.pointerId);

      // Get parent container (the .pane-split flex container)
      const parent = resizer.parentElement;
      if (!parent) return;

      const parentRect = parent.getBoundingClientRect();

      // Set body cursor to prevent flicker
      document.body.style.cursor =
        direction === 'vertical' ? 'col-resize' : 'row-resize';
      document.body.classList.add('pane-drag-active');

      const handlePointerMove = (moveEvent: PointerEvent) => {
        let newRatio: number;

        if (direction === 'vertical') {
          newRatio = (moveEvent.clientX - parentRect.left) / parentRect.width;
        } else {
          newRatio = (moveEvent.clientY - parentRect.top) / parentRect.height;
        }

        // Clamping is handled by resizePane in paneTree.ts, but clamp loosely
        // here to avoid excessive calls outside valid range
        newRatio = Math.max(0.05, Math.min(0.95, newRatio));
        onResize(splitId, newRatio);
      };

      const handlePointerUp = () => {
        document.removeEventListener('pointermove', handlePointerMove);
        document.removeEventListener('pointerup', handlePointerUp);

        document.body.style.cursor = '';
        document.body.classList.remove('pane-drag-active');

        onResizeEnd();
      };

      document.addEventListener('pointermove', handlePointerMove);
      document.addEventListener('pointerup', handlePointerUp);
    },
    [splitId, direction, onResize, onResizeEnd],
  );

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      onContextMenu(e, splitId);
    },
    [onContextMenu, splitId],
  );

  return (
    <div
      ref={resizerRef}
      className={`pane-resizer pane-resizer-${direction}`}
      onPointerDown={handlePointerDown}
      onContextMenu={handleContextMenu}
      role="separator"
      aria-orientation={direction === 'vertical' ? 'vertical' : 'horizontal'}
      tabIndex={-1}
    />
  );
};
