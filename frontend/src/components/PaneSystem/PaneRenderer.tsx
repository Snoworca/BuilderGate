// ============================================================================
// BuilderGate Pane Split System - PaneRenderer
// Top-level responsive switch. Desktop renders full split tree,
// mobile renders single focused pane (Phase 4 will add PaneCarousel).
// ============================================================================

import React, { useMemo } from 'react';
import type { PaneLayout } from '../../types/pane.types';
import { flattenPaneTree, findPane } from '../../utils/paneTree';
import { SplitPane } from './SplitPane';
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
  // Mobile: render single focused pane only (Phase 4 → PaneCarousel)
  // -------------------------------------------------------------------

  if (isMobile) {
    const focusedLeaf = findPane(layout.root, layout.focusedPaneId);

    if (!focusedLeaf) {
      // Fallback: render first leaf if focused pane not found
      const leaves = flattenPaneTree(layout.root);
      if (leaves.length === 0) {
        return <div className="pane-renderer pane-renderer-empty">No panes</div>;
      }
      const fallback = leaves[0];
      return (
        <div className="pane-renderer pane-renderer-mobile">
          <div
            className="pane-leaf pane-leaf-focused"
            data-pane-id={fallback.id}
            onClick={() => onFocus(fallback.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              onContextMenu(e, fallback.id);
            }}
            style={{ width: '100%', height: '100%', position: 'relative' }}
          >
            <div className="pane-focus-bar" />
            {renderTerminal(fallback.sessionId, fallback.id)}
          </div>
        </div>
      );
    }

    return (
      <div className="pane-renderer pane-renderer-mobile">
        <div
          className="pane-leaf pane-leaf-focused"
          data-pane-id={focusedLeaf.id}
          onClick={() => onFocus(focusedLeaf.id)}
          onContextMenu={(e) => {
            e.preventDefault();
            onContextMenu(e, focusedLeaf.id);
          }}
          style={{ width: '100%', height: '100%', position: 'relative' }}
        >
          <div className="pane-focus-bar" />
          {renderTerminal(focusedLeaf.sessionId, focusedLeaf.id)}
        </div>
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
