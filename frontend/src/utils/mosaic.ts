import type { MosaicNode, MosaicParent } from '../types/workspace';

export type EqualLayoutArrangement = 'rows' | 'cols';

export interface EqualLayoutMetrics {
  containerWidth: number;
  containerHeight: number;
  cellWidth?: number;
  cellHeight?: number;
  targetColumns?: number;
  targetRows?: number;
  targetAspectRatio?: number;
}

export interface EqualGridSpec {
  arrangement: EqualLayoutArrangement;
  columns: number;
  rows: number;
  bandCounts: number[];
  outerDirection: 'row' | 'column';
  innerDirection: 'row' | 'column';
}

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
// Build linear tree from tab IDs for a single row/column band
// ============================================================================

function buildLinearMosaicTree(
  ids: string[],
  direction: 'row' | 'column',
): MosaicNode<string> {
  if (ids.length === 0) throw new Error('Cannot build tree from empty ids');
  if (ids.length === 1) return ids[0];
  if (ids.length === 2) {
    return { direction, first: ids[0], second: ids[1], splitPercentage: 50 };
  }
  const mid = Math.ceil(ids.length / 2);
  return {
    direction,
    first: buildLinearMosaicTree(ids.slice(0, mid), direction),
    second: buildLinearMosaicTree(ids.slice(mid), direction),
    splitPercentage: (mid / ids.length) * 100,
  };
}

function buildBalancedMosaicTree(
  nodes: MosaicNode<string>[],
  direction: 'row' | 'column',
): MosaicNode<string> {
  if (nodes.length === 0) throw new Error('Cannot build tree from empty nodes');
  if (nodes.length === 1) return nodes[0];

  return {
    direction,
    first: nodes[0],
    second: buildBalancedMosaicTree(nodes.slice(1), direction),
    splitPercentage: 100 / nodes.length,
  };
}

function isLinearMosaicTree(
  node: MosaicNode<string>,
  direction: 'row' | 'column',
): boolean {
  if (typeof node === 'string') return true;
  return (
    node.direction === direction &&
    isLinearMosaicTree(node.first, direction) &&
    isLinearMosaicTree(node.second, direction)
  );
}

function resolveEqualScreenArrangement(
  metrics?: EqualLayoutMetrics,
  fallbackArrangement: EqualLayoutArrangement = 'rows',
): EqualLayoutArrangement {
  const width = metrics?.containerWidth ?? 0;
  const height = metrics?.containerHeight ?? 0;

  if (width > 0 && height > 0) {
    if (height > width) return 'cols';
    if (width > height) return 'rows';
  }

  return fallbackArrangement;
}

function resolveEqualDimensions(
  metrics?: EqualLayoutMetrics,
  fallbackArrangement: EqualLayoutArrangement = 'rows',
): { width: number; height: number } {
  const width = metrics?.containerWidth ?? 0;
  const height = metrics?.containerHeight ?? 0;

  if (width > 0 && height > 0) {
    return { width, height };
  }

  return fallbackArrangement === 'cols'
    ? { width: 900, height: 1600 }
    : { width: 1600, height: 900 };
}

function resolveEqualTargetAspectRatio(metrics?: EqualLayoutMetrics): number {
  const cellWidth = metrics?.cellWidth ?? 0;
  const cellHeight = metrics?.cellHeight ?? 0;

  if (cellWidth > 0 && cellHeight > 0) {
    return ((metrics?.targetColumns ?? 80) * cellWidth)
      / ((metrics?.targetRows ?? 24) * cellHeight);
  }

  if (metrics?.targetAspectRatio && metrics.targetAspectRatio > 0) {
    return metrics.targetAspectRatio;
  }

  return 1.6;
}

function getResearchBaselineGrid(
  tabCount: number,
  arrangement: EqualLayoutArrangement,
): { columns: number; rows: number } | null {
  if (tabCount < 4 || tabCount > 8) {
    return null;
  }

  if (tabCount === 4) {
    return { columns: 2, rows: 2 };
  }

  if (tabCount <= 6) {
    return arrangement === 'cols'
      ? { columns: 2, rows: 3 }
      : { columns: 3, rows: 2 };
  }

  return { columns: 3, rows: 3 };
}

function shouldUseWideSingleRow(
  tabCount: number,
  baseline: { columns: number; rows: number } | null,
  metrics?: EqualLayoutMetrics,
): boolean {
  const width = metrics?.containerWidth ?? 0;
  const height = metrics?.containerHeight ?? 0;

  if (!baseline || width <= 0 || height <= 0 || width <= height) {
    return false;
  }

  const singleRowPaneWidth = width / tabCount;
  const baselineGridPaneHeight = height / baseline.rows;
  return singleRowPaneWidth > baselineGridPaneHeight;
}

function resolveArrangementFromGrid(
  columns: number,
  rows: number,
  metrics?: EqualLayoutMetrics,
  fallbackArrangement: EqualLayoutArrangement = 'rows',
): EqualLayoutArrangement {
  if (columns > rows) return 'rows';
  if (rows > columns) return 'cols';
  return resolveEqualScreenArrangement(metrics, fallbackArrangement);
}

function distributeEqualBandCounts(
  tabCount: number,
  bandCount: number,
  maxPerBand: number,
): number[] {
  const counts: number[] = [];
  let remaining = tabCount;

  for (let index = 0; index < bandCount; index += 1) {
    const remainingBands = bandCount - index;
    const nextCount = Math.min(maxPerBand, Math.ceil(remaining / remainingBands));
    if (nextCount <= 0) {
      throw new Error('Equal grid band count must be positive');
    }
    counts.push(nextCount);
    remaining -= nextCount;
  }

  if (remaining !== 0) {
    throw new Error('Equal grid band counts do not match tab count');
  }

  return counts;
}

function createEqualGridSpec(
  tabCount: number,
  columns: number,
  rows: number,
  arrangement: EqualLayoutArrangement,
): EqualGridSpec {
  const outerDirection = arrangement === 'rows' ? 'column' : 'row';
  const innerDirection = arrangement === 'rows' ? 'row' : 'column';
  const bandCount = arrangement === 'rows' ? rows : columns;
  const maxPerBand = arrangement === 'rows' ? columns : rows;

  return {
    arrangement,
    columns,
    rows,
    bandCounts: distributeEqualBandCounts(tabCount, bandCount, maxPerBand),
    outerDirection,
    innerDirection,
  };
}

function compareEqualCandidateScores(
  left: [number, number, number],
  right: [number, number, number],
): number {
  for (let index = 0; index < left.length; index += 1) {
    const delta = left[index] - right[index];
    if (Math.abs(delta) > Number.EPSILON) {
      return delta;
    }
  }
  return 0;
}

export function selectEqualGridSpec(
  tabCount: number,
  metrics?: EqualLayoutMetrics,
  fallbackArrangement: EqualLayoutArrangement = 'rows',
): EqualGridSpec {
  if (tabCount <= 0) throw new Error('Cannot build tree from empty ids');

  const screenArrangement = resolveEqualScreenArrangement(metrics, fallbackArrangement);

  if (tabCount <= 3) {
    const columns = screenArrangement === 'rows' ? tabCount : 1;
    const rows = screenArrangement === 'cols' ? tabCount : 1;
    return createEqualGridSpec(tabCount, columns, rows, screenArrangement);
  }

  const { width, height } = resolveEqualDimensions(metrics, fallbackArrangement);
  const targetAspectRatio = resolveEqualTargetAspectRatio(metrics);
  const baseline = getResearchBaselineGrid(tabCount, screenArrangement);

  if (screenArrangement === 'rows' && shouldUseWideSingleRow(tabCount, baseline, metrics)) {
    return createEqualGridSpec(tabCount, tabCount, 1, 'rows');
  }

  const candidates: Array<{
    columns: number;
    rows: number;
    score: [number, number, number];
  }> = [];

  for (let columns = 2; columns <= tabCount; columns += 1) {
    for (let rows = 2; rows <= tabCount; rows += 1) {
      if (columns * rows < tabCount) {
        continue;
      }

      const tileAspectRatio = (width / columns) / (height / rows);
      const aspectDistance = Math.abs(Math.log(tileAspectRatio / targetAspectRatio));
      const emptySlots = columns * rows - tabCount;
      const longAxisPenalty = width >= height
        ? (columns >= rows ? 0 : 1)
        : (rows >= columns ? 0 : 1);

      candidates.push({
        columns,
        rows,
        score: [aspectDistance, emptySlots, longAxisPenalty],
      });
    }
  }

  if (candidates.length === 0) {
    throw new Error('Cannot select Equal grid candidate');
  }

  candidates.sort((left, right) => {
    const scoreComparison = compareEqualCandidateScores(left.score, right.score);
    if (scoreComparison !== 0) return scoreComparison;

    const leftArrangement = resolveArrangementFromGrid(
      left.columns,
      left.rows,
      metrics,
      fallbackArrangement,
    );
    const rightArrangement = resolveArrangementFromGrid(
      right.columns,
      right.rows,
      metrics,
      fallbackArrangement,
    );

    if (leftArrangement === fallbackArrangement && rightArrangement !== fallbackArrangement) {
      return -1;
    }
    if (rightArrangement === fallbackArrangement && leftArrangement !== fallbackArrangement) {
      return 1;
    }
    return 0;
  });

  const selected = baseline
    ? candidates.find(candidate => candidate.columns === baseline.columns && candidate.rows === baseline.rows)
      ?? candidates[0]
    : candidates[0];
  const arrangement = resolveArrangementFromGrid(
    selected.columns,
    selected.rows,
    metrics,
    fallbackArrangement,
  );
  return createEqualGridSpec(tabCount, selected.columns, selected.rows, arrangement);
}

function buildBandedMosaicTree(
  ids: string[],
  outerDirection: 'row' | 'column',
  innerDirection: 'row' | 'column',
  bandCounts: number[],
): MosaicNode<string> {
  if (ids.length === 0) throw new Error('Cannot build tree from empty ids');

  const totalBandLeaves = bandCounts.reduce((sum, count) => sum + count, 0);
  if (totalBandLeaves !== ids.length) {
    throw new Error('Equal grid band counts must match ids length');
  }

  const bands: MosaicNode<string>[] = [];
  let offset = 0;
  for (const count of bandCounts) {
    if (count <= 0) {
      throw new Error('Equal grid band count must be positive');
    }
    bands.push(buildLinearMosaicTree(ids.slice(offset, offset + count), innerDirection));
    offset += count;
  }

  if (bands.length === 1) {
    return bands[0];
  }

  return buildBalancedMosaicTree(bands, outerDirection);
}

// ============================================================================
// Build equal layout from tab IDs
// rows: row-major logical grid
// cols: column-major logical grid
// ============================================================================

export function buildEqualMosaicTree(
  ids: string[],
  arrangement: EqualLayoutArrangement = 'rows',
  metrics?: EqualLayoutMetrics,
): MosaicNode<string> {
  if (ids.length === 0) throw new Error('Cannot build tree from empty ids');

  const spec = selectEqualGridSpec(ids.length, metrics, arrangement);
  if (ids.length <= 3 || spec.bandCounts.length === 1) {
    return buildLinearMosaicTree(ids, spec.innerDirection);
  }

  return buildBandedMosaicTree(
    ids,
    spec.outerDirection,
    spec.innerDirection,
    spec.bandCounts,
  );
}

export function buildRecoveredEqualMosaicTree(
  sourceTree: MosaicNode<string> | null,
  currentTabIds: string[],
  arrangement: EqualLayoutArrangement = 'rows',
  metrics?: EqualLayoutMetrics,
): MosaicNode<string> {
  if (currentTabIds.length === 0) {
    throw new Error('Cannot build tree from empty ids');
  }

  if (!sourceTree) {
    return buildEqualMosaicTree(currentTabIds, arrangement, metrics);
  }

  const recoveredTree = restoreLayoutWithSessionRecovery(sourceTree, currentTabIds).tree;
  return buildEqualMosaicTree(extractLeafIds(recoveredTree), arrangement, metrics);
}

export function inferEqualLayoutArrangement(tree: MosaicNode<string> | null): EqualLayoutArrangement {
  if (!tree || typeof tree === 'string') {
    return 'rows';
  }

  const leafCount = countLeaves(tree);
  if (leafCount <= 3) {
    if (isLinearMosaicTree(tree, 'row')) return 'rows';
    if (isLinearMosaicTree(tree, 'column')) return 'cols';
  }

  if (isLinearMosaicTree(tree, 'row')) {
    return 'rows';
  }

  return tree.direction === 'column' ? 'rows' : 'cols';
}

function collectEqualBands(
  node: MosaicNode<string>,
  outerDirection: 'row' | 'column',
): MosaicNode<string>[] {
  if (typeof node === 'string') return [node];
  if (node.direction !== outerDirection) return [node];
  return [
    ...collectEqualBands(node.first, outerDirection),
    ...collectEqualBands(node.second, outerDirection),
  ];
}

export function isFixedEqualMosaicTree(
  tree: MosaicNode<string> | null,
  arrangement: EqualLayoutArrangement,
): boolean {
  if (!tree || typeof tree === 'string') {
    return true;
  }

  const outerDirection = arrangement === 'rows' ? 'column' : 'row';
  const innerDirection = arrangement === 'rows' ? 'row' : 'column';
  const leafCount = countLeaves(tree);

  if (leafCount <= 3) {
    return isLinearMosaicTree(tree, innerDirection);
  }

  if (arrangement === 'rows' && isLinearMosaicTree(tree, 'row')) {
    return true;
  }

  if (arrangement === 'cols' && isLinearMosaicTree(tree, 'row')) {
    return false;
  }

  if (tree.direction !== outerDirection) {
    return false;
  }

  const bands = collectEqualBands(tree, outerDirection);
  const bandLeafCounts = bands.map(countLeaves);
  const minBandLeaves = Math.min(...bandLeafCounts);
  const maxBandLeaves = Math.max(...bandLeafCounts);

  return (
    maxBandLeaves - minBandLeaves <= 1 &&
    bands.every(band => isLinearMosaicTree(band, innerDirection))
  );
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
  directionHint: 'row' | 'column' = 'row',
): MosaicNode<string> {
  if (typeof tree === 'string') {
    return {
      direction: directionHint,
      first: tree,
      second: newId,
      splitPercentage: 50,
    };
  }

  const firstLeaves = countLeaves(tree.first);
  const secondLeaves = countLeaves(tree.second);
  if (firstLeaves <= secondLeaves) {
    return {
      ...tree,
      first: appendLeafToMosaicTree(tree.first, newId, tree.direction),
    };
  }

  return {
    ...tree,
    second: appendLeafToMosaicTree(tree.second, newId, tree.direction),
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

export function applyEqualModePreservingTopology(
  tree: MosaicNode<string>,
  minPercent: number,
): MosaicNode<string> {
  if (typeof tree === 'string') return tree;

  function apply(node: MosaicNode<string>): MosaicNode<string> {
    if (typeof node === 'string') return node;

    const parent = node as MosaicParent<string>;
    const first = apply(parent.first);
    const second = apply(parent.second);
    const firstLeaves = countLeaves(first);
    const secondLeaves = countLeaves(second);
    const totalLeaves = firstLeaves + secondLeaves;

    let split = totalLeaves > 0 ? (firstLeaves / totalLeaves) * 100 : 50;
    split = Math.max(minPercent, Math.min(100 - minPercent, split));

    return {
      ...parent,
      first,
      second,
      splitPercentage: split,
    };
  }

  return apply(tree);
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
): { tree: MosaicNode<string>; missingIds: string[]; replacements: Record<string, string> } {
  const persistedIds = extractLeafIds(persistedTree);
  const currentSet = new Set(currentTabIds);
  const persistedSet = new Set(persistedIds);
  const validIds = persistedIds.filter(id => currentSet.has(id));
  const missingIds = persistedIds.filter(id => !currentSet.has(id));
  const unassigned = currentTabIds.filter(id => !persistedSet.has(id));
  const replacements: Record<string, string> = {};

  if (validIds.length === 0) {
    // 전부 소멸 → 균등 폴백
    return { tree: buildEqualMosaicTree(currentTabIds), missingIds, replacements };
  }

  if (missingIds.length === 0 && unassigned.length === 0) {
    // 모든 세션 존재 → 그대로 복원
    return { tree: persistedTree, missingIds: [], replacements };
  }

  if (missingIds.length === 0) {
    let tree: MosaicNode<string> = persistedTree;
    for (const newId of unassigned) {
      tree = appendLeafToMosaicTree(tree, newId);
    }
    return { tree, missingIds: [], replacements };
  }

  // 부분 소멸: 소멸된 leaf를 currentTabIds에서 아직 미배치된 ID로 교체
  // 미배치 ID = currentTabIds 중 persistedIds에 없는 것
  let tree: MosaicNode<string> = persistedTree;

  for (let i = 0; i < missingIds.length; i++) {
    if (i < unassigned.length) {
      replacements[missingIds[i]] = unassigned[i];
      tree = replaceLeafId(tree, missingIds[i], unassigned[i]);
    } else {
      // 교체할 ID가 없으면 leaf 제거
      tree = removeFromMosaicTree(tree, missingIds[i]) ?? buildEqualMosaicTree(currentTabIds);
    }
  }

  for (let i = missingIds.length; i < unassigned.length; i++) {
    tree = appendLeafToMosaicTree(tree, unassigned[i]);
  }

  return { tree, missingIds, replacements };
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
