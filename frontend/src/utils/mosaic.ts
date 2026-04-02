import type { MosaicNode, MosaicParent } from '../types/workspace';

// ============================================================================
// Minimum size percentage by session count
// ============================================================================

export function getMinPercentage(sessionCount: number): number {
  if (sessionCount <= 2) return 15;
  if (sessionCount === 3) return 10;
  if (sessionCount === 4) return 8;
  if (sessionCount <= 6) return 6;
  return 5; // 7~8
}

// ============================================================================
// Build equal binary split tree from tab IDs
// ============================================================================

export function buildEqualMosaicTree(ids: string[]): MosaicNode<string> {
  if (ids.length === 0) throw new Error('Cannot build tree from empty ids');
  if (ids.length === 1) return ids[0];
  if (ids.length === 2) {
    return { direction: 'row', first: ids[0], second: ids[1], splitPercentage: 50 };
  }
  const mid = Math.ceil(ids.length / 2);
  const depth = Math.ceil(Math.log2(Math.max(ids.length, 1)));
  return {
    direction: depth % 2 === 0 ? 'row' : 'column',
    first: buildEqualMosaicTree(ids.slice(0, mid)),
    second: buildEqualMosaicTree(ids.slice(mid)),
    splitPercentage: (mid / ids.length) * 100,
  };
}

// ============================================================================
// Remove a leaf from the tree
// ============================================================================

export function removeFromMosaicTree(
  tree: MosaicNode<string> | null,
  tabId: string,
): MosaicNode<string> | null {
  if (tree === null) return null;
  if (typeof tree === 'string') return tree === tabId ? null : tree;

  const parent = tree as MosaicParent<string>;
  if (parent.first === tabId) return parent.second;
  if (parent.second === tabId) return parent.first;

  const newFirst = removeFromMosaicTree(parent.first, tabId);
  const newSecond = removeFromMosaicTree(parent.second, tabId);

  if (newFirst === null) return newSecond;
  if (newSecond === null) return newFirst;

  return { ...parent, first: newFirst, second: newSecond };
}

// ============================================================================
// Tree helpers
// ============================================================================

export function countLeaves(node: MosaicNode<string>): number {
  if (typeof node === 'string') return 1;
  return countLeaves(node.first) + countLeaves(node.second);
}

export function containsLeaf(node: MosaicNode<string>, targetId: string): boolean {
  if (typeof node === 'string') return node === targetId;
  return containsLeaf(node.first, targetId) || containsLeaf(node.second, targetId);
}

export function findLeafSide(
  tree: MosaicParent<string>,
  targetId: string,
): 'first' | 'second' | null {
  if (containsLeaf(tree.first, targetId)) return 'first';
  if (containsLeaf(tree.second, targetId)) return 'second';
  return null;
}

export function extractLeafIds(node: MosaicNode<string>): string[] {
  if (typeof node === 'string') return [node];
  return [...extractLeafIds(node.first), ...extractLeafIds(node.second)];
}

export function replaceLeafId(
  tree: MosaicNode<string>,
  oldId: string,
  newId: string,
): MosaicNode<string> {
  if (typeof tree === 'string') return tree === oldId ? newId : tree;
  return {
    ...tree,
    first: replaceLeafId(tree.first, oldId, newId),
    second: replaceLeafId(tree.second, oldId, newId),
  };
}

export function isValidMosaicTree(tree: unknown): tree is MosaicNode<string> {
  if (typeof tree === 'string') return tree.length > 0;
  if (tree === null || tree === undefined) return false;
  if (typeof tree !== 'object') return false;
  const t = tree as MosaicParent<string>;
  if (t.direction !== 'row' && t.direction !== 'column') return false;
  return isValidMosaicTree(t.first) && isValidMosaicTree(t.second);
}

// ============================================================================
// Apply equal mode (rebuild tree with same IDs)
// ============================================================================

export function applyEqualMode(tree: MosaicNode<string>): MosaicNode<string> {
  return buildEqualMosaicTree(extractLeafIds(tree));
}

// ============================================================================
// Clamp split percentages to min value
// ============================================================================

export function clampSplitPercentages(
  tree: MosaicNode<string> | null,
  minPercent: number,
): MosaicNode<string> | null {
  if (tree === null || typeof tree === 'string') return tree;
  const parent = tree as MosaicParent<string>;
  const pct = parent.splitPercentage ?? 50;
  const clamped = Math.max(minPercent, Math.min(100 - minPercent, pct));
  return {
    ...parent,
    splitPercentage: clamped,
    first: clampSplitPercentages(parent.first, minPercent) as MosaicNode<string>,
    second: clampSplitPercentages(parent.second, minPercent) as MosaicNode<string>,
  };
}
