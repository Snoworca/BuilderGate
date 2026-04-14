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

export function appendLeafToMosaicTree(
  tree: MosaicNode<string>,
  newId: string,
): MosaicNode<string> {
  const leafCount = extractLeafIds(tree).length;
  return {
    direction: leafCount % 2 === 0 ? 'row' : 'column',
    first: tree,
    second: newId,
    splitPercentage: Math.max(20, Math.min(80, (leafCount / (leafCount + 1)) * 100)),
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

export const FOCUS_RATIO_KEY = 'grid_focus_ratio';
export const FOCUS_RATIO_DEFAULT = 0.6;

export function applyFocusMode(
  tree: MosaicNode<string>,
  focusTabId: string,
  minPercent: number,
  focusRatio: number = FOCUS_RATIO_DEFAULT,
): MosaicNode<string> {
  if (typeof tree === 'string') return tree;

  // 가중치 기반: 포커스 세션 = focusRatio, 나머지 각각 = (1-focusRatio)/n
  const allLeaves = extractLeafIds(tree);
  const otherCount = allLeaves.length - 1;
  const focusWeight = focusRatio;
  const otherWeight = otherCount > 0 ? (1 - focusRatio) / otherCount : 0;

  function subtreeArea(node: MosaicNode<string>): number {
    if (typeof node === 'string') {
      return node === focusTabId ? focusWeight : otherWeight;
    }
    const p = node as MosaicParent<string>;
    return subtreeArea(p.first) + subtreeArea(p.second);
  }

  function apply(node: MosaicNode<string>): MosaicNode<string> {
    if (typeof node === 'string') return node;

    const p = node as MosaicParent<string>;
    const newFirst = apply(p.first);
    const newSecond = apply(p.second);

    const firstArea = subtreeArea(p.first);
    const secondArea = subtreeArea(p.second);
    const total = firstArea + secondArea;

    let split = total > 0 ? (firstArea / total) * 100 : 50;
    split = Math.max(minPercent, Math.min(100 - minPercent, split));

    return { ...p, first: newFirst, second: newSecond, splitPercentage: split };
  }

  return apply(tree);
}

// ============================================================================
// Auto mode: 세션별 가중치 기반 면적 분배
// idleRatio로 idle 세션이 running 대비 몇 배 큰지 결정 (기본 1.7)
// ============================================================================

export const AUTO_FOCUS_RATIO_KEY = 'grid_auto_focus_ratio';
export const AUTO_FOCUS_RATIO_DEFAULT = 1.7;

export function applyMultiFocusApprox(
  tree: MosaicNode<string>,
  idleIds: Set<string>,
  minPercent: number,
  idleRatio: number = AUTO_FOCUS_RATIO_DEFAULT,
): MosaicNode<string> {
  if (typeof tree === 'string') return tree;

  // 서브트리의 가중치 합산 (idle = idleRatio, running = 1)
  function subtreeArea(node: MosaicNode<string>): number {
    if (typeof node === 'string') {
      return idleIds.has(node) ? idleRatio : 1;
    }
    const p = node as MosaicParent<string>;
    return subtreeArea(p.first) + subtreeArea(p.second);
  }

  // 각 내부 노드의 splitPercentage를 목표 면적 비율로 설정
  function apply(node: MosaicNode<string>): MosaicNode<string> {
    if (typeof node === 'string') return node;

    const p = node as MosaicParent<string>;
    const newFirst = apply(p.first);
    const newSecond = apply(p.second);

    const firstArea = subtreeArea(p.first);
    const secondArea = subtreeArea(p.second);
    const total = firstArea + secondArea;

    let split = total > 0 ? (firstArea / total) * 100 : 50;
    split = Math.max(minPercent, Math.min(100 - minPercent, split));

    return { ...p, first: newFirst, second: newSecond, splitPercentage: split };
  }

  return apply(tree);
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
  const persistedSet = new Set(persistedIds);
  const unassigned = currentTabIds.filter(id => !persistedSet.has(id));

  if (validIds.length === 0) {
    // 전부 소멸 → 균등 폴백
    return { tree: buildEqualMosaicTree(currentTabIds), missingIds };
  }

  if (unassigned.length > 0) {
    let tree: MosaicNode<string> = persistedTree;
    for (const tabId of unassigned) {
      tree = appendLeafToMosaicTree(tree, tabId);
    }
    return { tree, missingIds };
  }

  if (missingIds.length === 0) {
    // 모든 세션 존재 → 그대로 복원
    return { tree: persistedTree, missingIds: [] };
  }

  // 부분 소멸: 소멸된 leaf를 currentTabIds에서 아직 미배치된 ID로 교체
  // 미배치 ID = currentTabIds 중 persistedIds에 없는 것
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
