// ============================================================================
// BuilderGate Pane Split System - Context Menu Builders
// FR-6201: Pane area menu, FR-6202: Resizer menu, FR-6203: TabBar preset menu
// ============================================================================

import type { PaneContextMenuItem, PresetType, Direction } from '../../types/pane.types';
import { PANE_CONSTANTS, BUILT_IN_PRESETS } from '../../types/pane.types';

// ---------------------------------------------------------------------------
// PaneManager interface (subset needed by menu builders)
// ---------------------------------------------------------------------------

export interface PaneManagerForMenu {
  layout: { root: import('../../types/pane.types').PaneNode; focusedPaneId: string; zoomedPaneId: string | null };
  paneCount: number;
  treeDepth: number;
  canSplit: boolean;
  isZoomed: boolean;

  splitPane: (paneId: string, direction: Direction) => Promise<void>;
  closePane: (paneId: string) => Promise<void>;
  closeOtherPanes: (keepPaneId: string) => Promise<void>;
  toggleZoom: (paneId?: string) => void;
  startSwap: (paneId: string) => void;

  equalizePanes: (splitId: string) => void;
  toggleDirection: (splitId: string) => void;

  applyPreset: (preset: PresetType) => Promise<void>;
}

// ---------------------------------------------------------------------------
// FR-6201: Pane area context menu
// ---------------------------------------------------------------------------

export function buildPaneContextMenu(
  paneId: string,
  paneManager: PaneManagerForMenu,
): PaneContextMenuItem[] {
  const {
    paneCount,
    treeDepth,
    canSplit,
    isZoomed,
    splitPane,
    closePane,
    closeOtherPanes,
    toggleZoom,
    startSwap,
  } = paneManager;

  const atMaxPanes = paneCount >= PANE_CONSTANTS.MAX_PANES;
  const atMaxDepth = treeDepth >= PANE_CONSTANTS.MAX_DEPTH;
  const splitDisabled = atMaxPanes || atMaxDepth || !canSplit;
  const isSinglePane = paneCount <= 1;

  const items: PaneContextMenuItem[] = [];

  // Split horizontal (위/아래)
  items.push({
    label: '수평 분할 (위/아래)',
    shortcut: 'Ctrl+B, "',
    disabled: splitDisabled,
    onClick: () => splitPane(paneId, 'horizontal'),
  });

  // Split vertical (좌/우)
  items.push({
    label: '수직 분할 (좌/우)',
    shortcut: 'Ctrl+B, %',
    disabled: splitDisabled,
    onClick: () => splitPane(paneId, 'vertical'),
  });

  // Separator
  items.push({ label: '', separator: true });

  // Zoom toggle
  items.push({
    label: isZoomed ? '줌 해제' : '줌 토글',
    shortcut: 'Ctrl+B, z',
    disabled: isSinglePane && !isZoomed,
    onClick: () => toggleZoom(paneId),
  });

  // Pane swap
  items.push({
    label: 'Pane 교환',
    disabled: isSinglePane,
    onClick: () => startSwap(paneId),
  });

  // Separator
  items.push({ label: '', separator: true });

  // Copy output
  items.push({
    label: '출력 복사',
    onClick: () => {
      // Copy currently selected text or visible terminal text to clipboard
      const selection = window.getSelection();
      if (selection && selection.toString().length > 0) {
        navigator.clipboard.writeText(selection.toString()).catch(() => {
          // silent fail
        });
      }
    },
  });

  // Separator
  items.push({ label: '', separator: true });

  // Close pane
  items.push({
    label: 'Pane 닫기',
    shortcut: 'Ctrl+B, x',
    disabled: isSinglePane,
    destructive: !isSinglePane,
    onClick: () => closePane(paneId),
  });

  // Close other panes
  items.push({
    label: '다른 Pane 모두 닫기',
    disabled: isSinglePane,
    destructive: !isSinglePane,
    onClick: () => closeOtherPanes(paneId),
  });

  return items;
}

// ---------------------------------------------------------------------------
// FR-6202: Resizer context menu
// ---------------------------------------------------------------------------

export function buildResizerContextMenu(
  splitId: string,
  paneManager: PaneManagerForMenu,
): PaneContextMenuItem[] {
  const { layout, equalizePanes, toggleDirection, closePane } = paneManager;

  // Find the split node to determine direction and children
  const split = findSplitNode(layout.root, splitId);
  if (!split) return [];

  const isVertical = split.direction === 'vertical';

  // Labels based on direction
  const firstLabel = isVertical ? '왼쪽' : '위';
  const secondLabel = isVertical ? '오른쪽' : '아래';

  // Find first leaves of each child for close actions
  const firstLeaf = findFirstLeaf(split.children[0]);
  const secondLeaf = findFirstLeaf(split.children[1]);

  const items: PaneContextMenuItem[] = [];

  // Equalize
  items.push({
    label: '균등 분할',
    onClick: () => equalizePanes(splitId),
  });

  // Toggle direction
  items.push({
    label: `방향 전환 (${isVertical ? '↔ → ↕' : '↕ → ↔'})`,
    onClick: () => toggleDirection(splitId),
  });

  // Separator
  items.push({ label: '', separator: true });

  // Close first pane
  items.push({
    label: `${firstLabel} Pane 닫기`,
    destructive: true,
    disabled: !firstLeaf,
    onClick: () => {
      if (firstLeaf) closePane(firstLeaf.id);
    },
  });

  // Close second pane
  items.push({
    label: `${secondLabel} Pane 닫기`,
    destructive: true,
    disabled: !secondLeaf,
    onClick: () => {
      if (secondLeaf) closePane(secondLeaf.id);
    },
  });

  return items;
}

// ---------------------------------------------------------------------------
// FR-6203: TabBar extension - preset layout submenu items
// ---------------------------------------------------------------------------

export function buildTabBarPaneMenu(
  paneManager: PaneManagerForMenu,
): PaneContextMenuItem[] {
  const { applyPreset } = paneManager;

  const presetChildren: PaneContextMenuItem[] = BUILT_IN_PRESETS.map((preset) => ({
    label: `${preset.name} (${preset.paneCount})`,
    onClick: () => applyPreset(preset.type),
  }));

  const items: PaneContextMenuItem[] = [
    { label: '', separator: true },
    {
      label: '프리셋 레이아웃',
      children: presetChildren,
    },
  ];

  return items;
}

// ---------------------------------------------------------------------------
// Internal helpers (tree traversal)
// ---------------------------------------------------------------------------

import type { PaneNode, PaneLeaf, PaneSplit } from '../../types/pane.types';

function findSplitNode(node: PaneNode, splitId: string): PaneSplit | null {
  if (node.type === 'terminal') return null;
  if (node.id === splitId) return node;
  return findSplitNode(node.children[0], splitId) ?? findSplitNode(node.children[1], splitId);
}

function findFirstLeaf(node: PaneNode): PaneLeaf | null {
  if (node.type === 'terminal') return node;
  return findFirstLeaf(node.children[0]);
}
