// ============================================================================
// BuilderGate Pane Split System - SplitPane
// Recursive renderer for PaneNode tree.
// ============================================================================

import React, { useMemo } from 'react';
import type { PaneNode, PaneLeaf, PaneSplit } from '../../types/pane.types';
import { PaneResizer } from './PaneResizer';

interface SplitPaneProps {
  node: PaneNode;
  focusedPaneId: string;
  zoomedPaneId: string | null;
  swapSource: string | null;
  paneNumberOverlay: boolean;
  paneIndex?: Map<string, number>;
  onFocus: (paneId: string) => void;
  onContextMenu: (e: React.MouseEvent, paneId: string) => void;
  onResizerContextMenu: (e: React.MouseEvent, splitId: string) => void;
  onResize: (splitId: string, ratio: number) => void;
  onResizeEnd: () => void;
  renderTerminal: (sessionId: string, paneId: string) => React.ReactNode;
}

// ---------------------------------------------------------------------------
// Helper: find a leaf node by id in the tree
// ---------------------------------------------------------------------------

function findLeafById(node: PaneNode, id: string): PaneLeaf | null {
  if (node.type === 'terminal') {
    return node.id === id ? node : null;
  }
  return (
    findLeafById(node.children[0], id) ?? findLeafById(node.children[1], id)
  );
}

// ---------------------------------------------------------------------------
// Helper: check if a subtree contains a given pane id
// ---------------------------------------------------------------------------

function treeContainsPane(node: PaneNode, paneId: string): boolean {
  if (node.type === 'terminal') return node.id === paneId;
  return (
    treeContainsPane(node.children[0], paneId) ||
    treeContainsPane(node.children[1], paneId)
  );
}

// ---------------------------------------------------------------------------
// SplitPane Component
// ---------------------------------------------------------------------------

export const SplitPane: React.FC<SplitPaneProps> = ({
  node,
  focusedPaneId,
  zoomedPaneId,
  swapSource,
  paneNumberOverlay,
  paneIndex,
  onFocus,
  onContextMenu,
  onResizerContextMenu,
  onResize,
  onResizeEnd,
  renderTerminal,
}) => {
  // -------------------------------------------------------------------
  // Zoom: if a pane is zoomed, render only that leaf at full size
  // -------------------------------------------------------------------

  if (zoomedPaneId) {
    const zoomedLeaf = findLeafById(node, zoomedPaneId);

    if (zoomedLeaf) {
      // We are at the root (or a subtree that contains the zoomed pane).
      // Render only the zoomed leaf, full size.
      return (
        <div className="pane-zoom-container" style={{ width: '100%', height: '100%', position: 'relative' }}>
          <LeafPane
            leaf={zoomedLeaf}
            isFocused={zoomedLeaf.id === focusedPaneId}
            isSwapSource={zoomedLeaf.id === swapSource}
            paneNumber={paneIndex?.get(zoomedLeaf.id)}
            showOverlay={paneNumberOverlay}
            onFocus={onFocus}
            onContextMenu={onContextMenu}
            renderTerminal={renderTerminal}
          />
          <div className="pane-zoom-badge">[ZOOMED]</div>
        </div>
      );
    }

    // The zoomed pane is not in this subtree - hide entirely
    if (!treeContainsPane(node, zoomedPaneId)) {
      return <div style={{ display: 'none' }} />;
    }
  }

  // -------------------------------------------------------------------
  // Leaf node: render terminal wrapper
  // -------------------------------------------------------------------

  if (node.type === 'terminal') {
    return (
      <LeafPane
        leaf={node}
        isFocused={node.id === focusedPaneId}
        isSwapSource={node.id === swapSource}
        paneNumber={paneIndex?.get(node.id)}
        showOverlay={paneNumberOverlay}
        onFocus={onFocus}
        onContextMenu={onContextMenu}
        renderTerminal={renderTerminal}
      />
    );
  }

  // -------------------------------------------------------------------
  // Split node: flex container with resizer
  // -------------------------------------------------------------------

  const split = node as PaneSplit;
  const isVertical = split.direction === 'vertical';

  return (
    <div
      className={`pane-split pane-split-${split.direction}`}
      style={{
        display: 'flex',
        flexDirection: isVertical ? 'row' : 'column',
        width: '100%',
        height: '100%',
      }}
    >
      {/* First child */}
      <div
        className="pane-split-child"
        style={{ flex: split.ratio, minWidth: 0, minHeight: 0, overflow: 'hidden' }}
      >
        <SplitPane
          node={split.children[0]}
          focusedPaneId={focusedPaneId}
          zoomedPaneId={zoomedPaneId}
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

      {/* Resizer */}
      <PaneResizer
        splitId={split.id}
        direction={split.direction}
        onResize={onResize}
        onResizeEnd={onResizeEnd}
        onContextMenu={onResizerContextMenu}
      />

      {/* Second child */}
      <div
        className="pane-split-child"
        style={{ flex: 1 - split.ratio, minWidth: 0, minHeight: 0, overflow: 'hidden' }}
      >
        <SplitPane
          node={split.children[1]}
          focusedPaneId={focusedPaneId}
          zoomedPaneId={zoomedPaneId}
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
    </div>
  );
};

// ---------------------------------------------------------------------------
// LeafPane: individual terminal pane wrapper
// ---------------------------------------------------------------------------

interface LeafPaneProps {
  leaf: PaneLeaf;
  isFocused: boolean;
  isSwapSource: boolean;
  paneNumber?: number;
  showOverlay: boolean;
  onFocus: (paneId: string) => void;
  onContextMenu: (e: React.MouseEvent, paneId: string) => void;
  renderTerminal: (sessionId: string, paneId: string) => React.ReactNode;
}

const LeafPane: React.FC<LeafPaneProps> = ({
  leaf,
  isFocused,
  isSwapSource,
  paneNumber,
  showOverlay,
  onFocus,
  onContextMenu,
  renderTerminal,
}) => {
  const className = useMemo(() => {
    const classes = ['pane-leaf'];
    if (isFocused) classes.push('pane-leaf-focused');
    if (isSwapSource) classes.push('pane-swap-source');
    return classes.join(' ');
  }, [isFocused, isSwapSource]);

  return (
    <div
      className={className}
      data-pane-id={leaf.id}
      onClick={() => onFocus(leaf.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(e, leaf.id);
      }}
      style={{ width: '100%', height: '100%', position: 'relative' }}
    >
      {/* Focus indicator bar */}
      {isFocused && <div className="pane-focus-bar" />}

      {/* Terminal content */}
      {renderTerminal(leaf.sessionId, leaf.id)}

      {/* Number overlay for quick-switch */}
      {showOverlay && paneNumber !== undefined && (
        <div className="pane-number-overlay">{paneNumber}</div>
      )}
    </div>
  );
};
