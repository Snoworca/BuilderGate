// ============================================================================
// BuilderGate Pane Split System - PaneRenderer
// Top-level responsive switch. Desktop renders full split tree,
// mobile renders single focused pane (Phase 4 will add PaneCarousel).
// ============================================================================

import React, { useMemo, useCallback } from 'react';
import type { PaneLayout } from '../../types/pane.types';
import { flattenPaneTree, findPane } from '../../utils/paneTree';
import { SplitPane } from './SplitPane';
import { PaneCarousel } from './PaneCarousel';
import { PaneIndicator } from './PaneIndicator';
import './PaneSystem.css';

interface PaneRendererProps {
  layout: PaneLayout;
  isMobile: boolean;
  swapSource: string | null;
  paneNumberOverlay: boolean;
  onFocus: (paneId: string) => void;
  onContextMenu: (e: React.MouseEvent, paneId: string) => void;
  onResizerContextMenu: (e: React.MouseEvent, splitId: string) => void;
  onResize: (splitId: string, ratio: number) => void;
  onResizeEnd: () => void;
  renderTerminal: (sessionId: string, paneId: string) => React.ReactNode;
}

export const PaneRenderer: React.FC<PaneRendererProps> = ({
  layout,
  isMobile,
  swapSource,
  paneNumberOverlay,
  onFocus,
  onContextMenu,
  onResizerContextMenu,
  onResize,
  onResizeEnd,
  renderTerminal,
}) => {
  // Build paneIndex map: paneId -> 1-based number (for number overlay)
  const paneIndex = useMemo(() => {
    const leaves = flattenPaneTree(layout.root);
    const map = new Map<string, number>();
    leaves.forEach((leaf, i) => {
      map.set(leaf.id, i + 1);
    });
    return map;
  }, [layout.root]);

  // -------------------------------------------------------------------
  // Mobile: PaneCarousel + PaneIndicator (Phase 4)
  // -------------------------------------------------------------------

  const leaves = useMemo(() => flattenPaneTree(layout.root), [layout.root]);
  const focusedIdx = useMemo(
    () => Math.max(0, leaves.findIndex((l) => l.id === layout.focusedPaneId)),
    [leaves, layout.focusedPaneId],
  );

  const handleSwipe = useCallback(
    (newIndex: number) => {
      if (newIndex >= 0 && newIndex < leaves.length) {
        onFocus(leaves[newIndex].id);
      }
    },
    [leaves, onFocus],
  );

  const handleDotClick = useCallback(
    (index: number) => {
      if (index >= 0 && index < leaves.length) {
        onFocus(leaves[index].id);
      }
    },
    [leaves, onFocus],
  );

  if (isMobile) {
    if (leaves.length === 0) {
      return <div className="pane-renderer pane-renderer-empty">No panes</div>;
    }

    return (
      <div className="pane-renderer pane-renderer-mobile">
        <PaneIndicator
          total={leaves.length}
          current={focusedIdx}
          onDotClick={handleDotClick}
        />
        <PaneCarousel
          leaves={leaves}
          focusedIndex={focusedIdx}
          onSwipe={handleSwipe}
          renderTerminal={renderTerminal}
        />
      </div>
    );
  }

  // -------------------------------------------------------------------
  // Desktop: full split tree
  // -------------------------------------------------------------------

  return (
    <div className="pane-renderer pane-renderer-desktop">
      <SplitPane
        node={layout.root}
        focusedPaneId={layout.focusedPaneId}
        zoomedPaneId={layout.zoomedPaneId}
        swapSource={swapSource}
        paneNumberOverlay={paneNumberOverlay}
        paneIndex={paneIndex}
        onFocus={onFocus}
        onContextMenu={onContextMenu}
        onResizerContextMenu={onResizerContextMenu}
        onResize={onResize}
        onResizeEnd={onResizeEnd}
        renderTerminal={renderTerminal}
      />
    </div>
  );
};
