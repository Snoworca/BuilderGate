// ============================================================================
// BuilderGate Pane Split System - Pure Immutable Tree Manipulation
// No React, no DOM, no browser globals. Pure functions only.
// ============================================================================

import type {
  PaneNode,
  PaneLeaf,
  PaneSplit,
  PaneLayout,
  Direction,
  FocusDirection,
  PresetType,
} from '../types/pane.types';
import { PANE_CONSTANTS, PLACEHOLDER_SESSION_ID } from '../types/pane.types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLeaf(sessionId: string): PaneLeaf {
  return { type: 'terminal', id: crypto.randomUUID(), sessionId };
}

function makeSplit(
  direction: Direction,
  ratio: number,
  child1: PaneNode,
  child2: PaneNode,
): PaneSplit {
  return {
    type: 'split',
    id: crypto.randomUUID(),
    direction,
    ratio,
    children: [child1, child2],
  };
}

function isLeaf(node: PaneNode): node is PaneLeaf {
  return node.type === 'terminal';
}

function isSplit(node: PaneNode): node is PaneSplit {
  return node.type === 'split';
}

function clampRatio(ratio: number): number {
  return Math.min(PANE_CONSTANTS.MAX_RATIO, Math.max(PANE_CONSTANTS.MIN_RATIO, ratio));
}

/**
 * Generic deep-map over the tree. Visits every node bottom-up and lets the
 * visitor return a replacement (or the same node for no change).
 */
function mapTree(
  node: PaneNode,
  fn: (n: PaneNode) => PaneNode,
): PaneNode {
  if (isLeaf(node)) {
    return fn(node);
  }
  const left = mapTree(node.children[0], fn);
  const right = mapTree(node.children[1], fn);
  const rebuilt: PaneSplit =
    left === node.children[0] && right === node.children[1]
      ? node
      : { ...node, children: [left, right] };
  return fn(rebuilt);
}

/**
 * Return the leftmost (first) leaf of a subtree.
 */
function leftmostLeaf(node: PaneNode): PaneLeaf {
  if (isLeaf(node)) return node;
  return leftmostLeaf(node.children[0]);
}

/**
 * Return the rightmost (last) leaf of a subtree.
 */
function rightmostLeaf(node: PaneNode): PaneLeaf {
  if (isLeaf(node)) return node;
  return rightmostLeaf(node.children[1]);
}

// ---------------------------------------------------------------------------
// 1. splitPane
// ---------------------------------------------------------------------------

export function splitPane(
  root: PaneNode,
  paneId: string,
  direction: Direction,
  newSessionId: string,
): PaneNode {
  let found = false;

  const result = mapTree(root, (node) => {
    if (isLeaf(node) && node.id === paneId) {
      found = true;
      const originalLeaf: PaneLeaf = { ...node };
      const newLeaf = makeLeaf(newSessionId);
      return makeSplit(direction, 0.5, originalLeaf, newLeaf);
    }
    return node;
  });

  if (!found) {
    throw new Error(`splitPane: pane "${paneId}" not found`);
  }

  return result;
}

// ---------------------------------------------------------------------------
// 2. closePane
// ---------------------------------------------------------------------------

export function closePane(root: PaneNode, paneId: string): PaneNode | null {
  // If root IS the target leaf, return null
  if (isLeaf(root) && root.id === paneId) {
    return null;
  }

  // Recursive: if a split contains the target as a direct child,
  // replace the split with the sibling.
  function remove(node: PaneNode): PaneNode | undefined {
    if (isLeaf(node)) return undefined;

    const split = node as PaneSplit;

    // Check if either direct child is the target leaf
    if (isLeaf(split.children[0]) && split.children[0].id === paneId) {
      return split.children[1]; // return sibling
    }
    if (isLeaf(split.children[1]) && split.children[1].id === paneId) {
      return split.children[0]; // return sibling
    }

    // Recurse into children
    const leftResult = remove(split.children[0]);
    if (leftResult !== undefined) {
      return { ...split, children: [leftResult, split.children[1]] };
    }

    const rightResult = remove(split.children[1]);
    if (rightResult !== undefined) {
      return { ...split, children: [split.children[0], rightResult] };
    }

    return undefined; // not found in this subtree
  }

  const result = remove(root);
  return result !== undefined ? result : root;
}

// ---------------------------------------------------------------------------
// 3. resizePane
// ---------------------------------------------------------------------------

export function resizePane(
  root: PaneNode,
  splitId: string,
  ratio: number,
): PaneNode {
  const clamped = clampRatio(ratio);

  return mapTree(root, (node) => {
    if (isSplit(node) && node.id === splitId) {
      return { ...node, ratio: clamped };
    }
    return node;
  });
}

// ---------------------------------------------------------------------------
// 4. swapPanes
// ---------------------------------------------------------------------------

export function swapPanes(
  root: PaneNode,
  paneIdA: string,
  paneIdB: string,
): PaneNode {
  const leafA = findPane(root, paneIdA);
  const leafB = findPane(root, paneIdB);

  if (!leafA || !leafB) return root;

  const sessionA = leafA.sessionId;
  const sessionB = leafB.sessionId;

  return mapTree(root, (node) => {
    if (isLeaf(node)) {
      if (node.id === paneIdA) return { ...node, sessionId: sessionB };
      if (node.id === paneIdB) return { ...node, sessionId: sessionA };
    }
    return node;
  });
}

// ---------------------------------------------------------------------------
// 5. toggleDirection
// ---------------------------------------------------------------------------

export function toggleDirection(root: PaneNode, splitId: string): PaneNode {
  return mapTree(root, (node) => {
    if (isSplit(node) && node.id === splitId) {
      const newDir: Direction =
        node.direction === 'horizontal' ? 'vertical' : 'horizontal';
      return { ...node, direction: newDir };
    }
    return node;
  });
}

// ---------------------------------------------------------------------------
// 6. flattenPaneTree
// ---------------------------------------------------------------------------

export function flattenPaneTree(root: PaneNode): PaneLeaf[] {
  if (isLeaf(root)) return [root];
  return [
    ...flattenPaneTree(root.children[0]),
    ...flattenPaneTree(root.children[1]),
  ];
}

// ---------------------------------------------------------------------------
// 7. findPane
// ---------------------------------------------------------------------------

export function findPane(root: PaneNode, paneId: string): PaneLeaf | null {
  if (isLeaf(root)) {
    return root.id === paneId ? root : null;
  }
  return findPane(root.children[0], paneId) ?? findPane(root.children[1], paneId);
}

// ---------------------------------------------------------------------------
// 8. findSplit
// ---------------------------------------------------------------------------

export function findSplit(root: PaneNode, splitId: string): PaneSplit | null {
  if (isLeaf(root)) return null;
  if (root.id === splitId) return root;
  return findSplit(root.children[0], splitId) ?? findSplit(root.children[1], splitId);
}

// ---------------------------------------------------------------------------
// 9. findParentSplit
// ---------------------------------------------------------------------------

export function findParentSplit(root: PaneNode, paneId: string): PaneSplit | null {
  if (isLeaf(root)) return null;

  const split = root as PaneSplit;

  // Check if either child matches
  for (const child of split.children) {
    if (child.id === paneId) return split;
  }

  // Recurse
  return (
    findParentSplit(split.children[0], paneId) ??
    findParentSplit(split.children[1], paneId)
  );
}

// ---------------------------------------------------------------------------
// 10. getAdjacentPane
// ---------------------------------------------------------------------------

interface PathEntry {
  split: PaneSplit;
  childIndex: 0 | 1;
}

function buildPath(root: PaneNode, targetId: string): PathEntry[] | null {
  if (isLeaf(root)) {
    return root.id === targetId ? [] : null;
  }

  const split = root as PaneSplit;

  const leftPath = buildPath(split.children[0], targetId);
  if (leftPath !== null) {
    return [{ split, childIndex: 0 }, ...leftPath];
  }

  const rightPath = buildPath(split.children[1], targetId);
  if (rightPath !== null) {
    return [{ split, childIndex: 1 }, ...rightPath];
  }

  return null;
}

export function getAdjacentPane(
  root: PaneNode,
  paneId: string,
  direction: FocusDirection,
): PaneLeaf | null {
  const path = buildPath(root, paneId);
  if (!path) return null;

  // Map direction to axis
  const axis: Direction =
    direction === 'left' || direction === 'right' ? 'vertical' : 'horizontal';

  // Walk path from bottom (nearest ancestor) to top
  for (let i = path.length - 1; i >= 0; i--) {
    const { split, childIndex } = path[i];

    if (split.direction !== axis) continue;

    if (
      (direction === 'right' || direction === 'down') &&
      childIndex === 0
    ) {
      // Target is in children[0], get nearest leaf from children[1]
      return leftmostLeaf(split.children[1]);
    }

    if (
      (direction === 'left' || direction === 'up') &&
      childIndex === 1
    ) {
      // Target is in children[1], get nearest leaf from children[0]
      return rightmostLeaf(split.children[0]);
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// 11. countPanes
// ---------------------------------------------------------------------------

export function countPanes(root: PaneNode): number {
  if (isLeaf(root)) return 1;
  return countPanes(root.children[0]) + countPanes(root.children[1]);
}

// ---------------------------------------------------------------------------
// 12. getTreeDepth
// ---------------------------------------------------------------------------

export function getTreeDepth(root: PaneNode): number {
  if (isLeaf(root)) return 1;
  return 1 + Math.max(getTreeDepth(root.children[0]), getTreeDepth(root.children[1]));
}

// ---------------------------------------------------------------------------
// 13. equalizeRatios
// ---------------------------------------------------------------------------

export function equalizeRatios(root: PaneNode, splitId: string): PaneNode {
  return resizePane(root, splitId, 0.5);
}

// ---------------------------------------------------------------------------
// 14. buildPresetLayout
// ---------------------------------------------------------------------------

const PRESET_PANE_COUNTS: Record<PresetType, number> = {
  single: 1,
  'vertical-2': 2,
  'horizontal-2': 2,
  quad: 4,
  'main-side': 3,
  'agent-monitor': 3,
};

export function buildPresetLayout(
  preset: PresetType,
  sessionIds: string[],
): PaneLayout {
  const expected = PRESET_PANE_COUNTS[preset];
  if (sessionIds.length !== expected) {
    throw new Error(
      `buildPresetLayout: preset "${preset}" requires ${expected} sessionId(s), got ${sessionIds.length}`,
    );
  }

  let root: PaneNode;

  switch (preset) {
    case 'single': {
      root = makeLeaf(sessionIds[0]);
      break;
    }
    case 'vertical-2': {
      root = makeSplit('vertical', 0.5, makeLeaf(sessionIds[0]), makeLeaf(sessionIds[1]));
      break;
    }
    case 'horizontal-2': {
      root = makeSplit('horizontal', 0.5, makeLeaf(sessionIds[0]), makeLeaf(sessionIds[1]));
      break;
    }
    case 'quad': {
      const topSplit = makeSplit('vertical', 0.5, makeLeaf(sessionIds[0]), makeLeaf(sessionIds[1]));
      const bottomSplit = makeSplit('vertical', 0.5, makeLeaf(sessionIds[2]), makeLeaf(sessionIds[3]));
      root = makeSplit('horizontal', 0.5, topSplit, bottomSplit);
      break;
    }
    case 'main-side': {
      const sideSplit = makeSplit('horizontal', 0.5, makeLeaf(sessionIds[1]), makeLeaf(sessionIds[2]));
      root = makeSplit('vertical', 0.6, makeLeaf(sessionIds[0]), sideSplit);
      break;
    }
    case 'agent-monitor': {
      const leftSplit = makeSplit('vertical', 0.5, makeLeaf(sessionIds[0]), makeLeaf(sessionIds[1]));
      root = makeSplit('horizontal', 0.7, leftSplit, makeLeaf(sessionIds[2]));
      break;
    }
    default: {
      const _exhaustive: never = preset;
      throw new Error(`Unknown preset: ${_exhaustive}`);
    }
  }

  const firstLeaf = leftmostLeaf(root);

  return {
    root,
    focusedPaneId: firstLeaf.id,
    zoomedPaneId: null,
  };
}
