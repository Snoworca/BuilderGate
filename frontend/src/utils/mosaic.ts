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
// Apply focus mode: keep existing tree structure, adjust ancestor splitPercentages
// so the subtree containing focusTabId gets more space.
// Focus side = 100 - (opposite leaf count × minPercent)
// ============================================================================

export function applyFocusMode(
  tree: MosaicNode<string>,
  focusTabId: string,
  minPercent: number,
): MosaicNode<string> {
  if (typeof tree === 'string') return tree;

  const parent = tree as MosaicParent<string>;
  const firstHasFocus = containsLeaf(parent.first, focusTabId);
  const secondHasFocus = containsLeaf(parent.second, focusTabId);

  let splitPercentage = parent.splitPercentage ?? 50;

  if (firstHasFocus && !secondHasFocus) {
    const oppositeLeaves = countLeaves(parent.second);
    const opponentSpace = oppositeLeaves * minPercent;
    splitPercentage = Math.min(100 - minPercent, Math.max(minPercent, 100 - opponentSpace));
    return {
      ...parent,
      first: applyFocusMode(parent.first, focusTabId, minPercent),
      second: applyEqualMode(parent.second),
      splitPercentage,
    };
  } else if (secondHasFocus && !firstHasFocus) {
    const oppositeLeaves = countLeaves(parent.first);
    const opponentSpace = oppositeLeaves * minPercent;
    splitPercentage = Math.max(minPercent, Math.min(100 - minPercent, opponentSpace));
    return {
      ...parent,
      first: applyEqualMode(parent.first),
      second: applyFocusMode(parent.second, focusTabId, minPercent),
      splitPercentage,
    };
  }

  return { ...parent, splitPercentage };
}

// ============================================================================
// Apply multi-focus approx: idle sessions get less space, non-idle get more.
// The side with more idle sessions is shrunk by ~30%.
// ============================================================================

export function applyMultiFocusApprox(
  tree: MosaicNode<string>,
  idleIds: Set<string>,
  minPercent: number,
): MosaicNode<string> {
  if (typeof tree === 'string') return tree;

  const parent = tree as MosaicParent<string>;

  // Recurse into children
  const newFirst = applyMultiFocusApprox(parent.first, idleIds, minPercent);
  const newSecond = applyMultiFocusApprox(parent.second, idleIds, minPercent);

  const firstLeaves = extractLeafIds(parent.first);
  const secondLeaves = extractLeafIds(parent.second);

  const firstIdleCount = firstLeaves.filter(id => idleIds.has(id)).length;
  const secondIdleCount = secondLeaves.filter(id => idleIds.has(id)).length;

  const firstActiveCount = firstLeaves.length - firstIdleCount;
  const secondActiveCount = secondLeaves.length - secondIdleCount;

  let splitPercentage = parent.splitPercentage ?? 50;

  if (firstActiveCount !== secondActiveCount) {
    // Bias toward whichever side has more active (non-idle) sessions
    const totalLeaves = firstLeaves.length + secondLeaves.length;
    const baseSplit = (firstLeaves.length / totalLeaves) * 100;

    // ±30% correction based on active count difference
    const totalActive = firstActiveCount + secondActiveCount;
    const activeRatio = totalActive > 0 ? firstActiveCount / totalActive : 0.5;
    const correction = (activeRatio - 0.5) * 60; // maps [-0.5, 0.5] → [-30, 30]

    splitPercentage = Math.max(minPercent, Math.min(100 - minPercent, baseSplit + correction));
  }

  return { ...parent, first: newFirst, second: newSecond, splitPercentage };
}

// ============================================================================
// Restore layout with session recovery
// ============================================================================

export function restoreLayoutWithSessionRecovery(
  persistedTree: MosaicNode<string>,
  currentTabIds: string[],
): { tree: MosaicNode<string>; missingIds: string[] } {
  const persistedIds = extractLeafIds(persistedTree);
  const currentSet = new Set(currentTabIds);
  const validIds = persistedIds.filter(id => currentSet.has(id));
  const missingIds = persistedIds.filter(id => !currentSet.has(id));

  if (validIds.length === 0) {
    // 전부 소멸 → 균등 폴백
    return { tree: buildEqualMosaicTree(currentTabIds), missingIds };
  }

  if (missingIds.length === 0) {
    // 모든 세션 존재 → 그대로 복원
    return { tree: persistedTree, missingIds: [] };
  }

  // 부분 소멸: 소멸된 leaf를 currentTabIds에서 아직 미배치된 ID로 교체
  // 미배치 ID = currentTabIds 중 persistedIds에 없는 것
  const persistedSet = new Set(persistedIds);
  const unassigned = currentTabIds.filter(id => !persistedSet.has(id));
  let tree: MosaicNode<string> = persistedTree;

  for (let i = 0; i < missingIds.length; i++) {
    if (i < unassigned.length) {
      tree = replaceLeafId(tree, missingIds[i], unassigned[i]);
    } else {
      // 교체할 ID가 없으면 leaf 제거
      tree = removeFromMosaicTree(tree, missingIds[i]) ?? buildEqualMosaicTree(currentTabIds);
    }
  }

  return { tree, missingIds };
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
