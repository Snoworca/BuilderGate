import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildEqualMosaicTree,
  extractLeafIds,
  inferEqualLayoutArrangement,
  isFixedEqualMosaicTree,
  selectEqualGridSpec,
  type EqualLayoutArrangement,
} from '../../src/utils/mosaic.ts';
import type { MosaicNode, MosaicParent } from '../../src/types/workspace.ts';

const wideMetrics = { containerWidth: 1280, containerHeight: 720 };
const tallMetrics = { containerWidth: 820, containerHeight: 1200 };
const ultrawideMetrics = { containerWidth: 2000, containerHeight: 600 };

function ids(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `tab-${index + 1}`);
}

function isParent(node: MosaicNode<string>): node is MosaicParent<string> {
  return typeof node !== 'string';
}

function expectLinearTree(
  tree: MosaicNode<string>,
  direction: 'row' | 'column',
): void {
  if (!isParent(tree)) {
    return;
  }

  assert.equal(tree.direction, direction);
  expectLinearTree(tree.first, direction);
  expectLinearTree(tree.second, direction);
}

function countLeaves(tree: MosaicNode<string>): number {
  if (!isParent(tree)) return 1;
  return countLeaves(tree.first) + countLeaves(tree.second);
}

function collectBands(
  tree: MosaicNode<string>,
  outerDirection: 'row' | 'column',
): MosaicNode<string>[] {
  if (!isParent(tree)) return [tree];
  if (tree.direction !== outerDirection) return [tree];
  return [
    ...collectBands(tree.first, outerDirection),
    ...collectBands(tree.second, outerDirection),
  ];
}

function bandCounts(
  tree: MosaicNode<string>,
  arrangement: EqualLayoutArrangement,
): number[] {
  if (countLeaves(tree) <= 3) {
    return [countLeaves(tree)];
  }

  const outerDirection = arrangement === 'rows' ? 'column' : 'row';
  return collectBands(tree, outerDirection).map(countLeaves);
}

test('FR-GRID-013 selects a single row for wide containers up to three tabs', () => {
  for (const count of [1, 2, 3]) {
    const spec = selectEqualGridSpec(count, wideMetrics);
    assert.equal(spec.arrangement, 'rows', `count=${count}`);
    assert.equal(spec.columns, count, `count=${count}`);
    assert.equal(spec.rows, 1, `count=${count}`);
    assert.deepEqual(spec.bandCounts, [count], `count=${count}`);

    const tree = buildEqualMosaicTree(ids(count), 'rows', wideMetrics);
    expectLinearTree(tree, 'row');
  }
});

test('FR-GRID-013 selects a single column for tall containers up to three tabs', () => {
  for (const count of [1, 2, 3]) {
    const spec = selectEqualGridSpec(count, tallMetrics);
    assert.equal(spec.arrangement, 'cols', `count=${count}`);
    assert.equal(spec.columns, 1, `count=${count}`);
    assert.equal(spec.rows, count, `count=${count}`);
    assert.deepEqual(spec.bandCounts, [count], `count=${count}`);

    const tree = buildEqualMosaicTree(ids(count), 'rows', tallMetrics);
    expectLinearTree(tree, 'column');
  }
});

test('FR-GRID-013 preserves fallback arrangement for square containers', () => {
  const squareMetrics = { containerWidth: 900, containerHeight: 900 };
  assert.equal(selectEqualGridSpec(3, squareMetrics, 'cols').arrangement, 'cols');
  assert.equal(selectEqualGridSpec(3, squareMetrics, 'rows').arrangement, 'rows');
  assert.equal(selectEqualGridSpec(3, squareMetrics).arrangement, 'rows');
});

test('FR-GRID-014 rejects empty Equal layout input', () => {
  assert.throws(() => selectEqualGridSpec(0, wideMetrics), /empty ids/);
  assert.throws(() => buildEqualMosaicTree([], 'rows', wideMetrics), /empty ids/);
});

test('FR-GRID-014 FR-GRID-015 returns the wide 4-8 baseline grid and bands', () => {
  const expected = [
    { count: 4, columns: 2, rows: 2, bandCounts: [2, 2] },
    { count: 5, columns: 3, rows: 2, bandCounts: [3, 2] },
    { count: 6, columns: 3, rows: 2, bandCounts: [3, 3] },
    { count: 7, columns: 3, rows: 3, bandCounts: [3, 2, 2] },
    { count: 8, columns: 3, rows: 3, bandCounts: [3, 3, 2] },
  ];

  for (const item of expected) {
    const spec = selectEqualGridSpec(item.count, wideMetrics);
    assert.equal(spec.arrangement, 'rows', `count=${item.count}`);
    assert.equal(spec.columns, item.columns, `count=${item.count}`);
    assert.equal(spec.rows, item.rows, `count=${item.count}`);
    assert.deepEqual(spec.bandCounts, item.bandCounts, `count=${item.count}`);

    const tree = buildEqualMosaicTree(ids(item.count), 'rows', wideMetrics);
    assert.deepEqual(bandCounts(tree, 'rows'), item.bandCounts, `count=${item.count}`);
  }
});

test('FR-GRID-014 FR-GRID-015 selects a single row when wide row pane width beats grid pane height', () => {
  for (const count of [4, 5, 8]) {
    const spec = selectEqualGridSpec(count, ultrawideMetrics);
    assert.equal(spec.arrangement, 'rows', `count=${count}`);
    assert.equal(spec.columns, count, `count=${count}`);
    assert.equal(spec.rows, 1, `count=${count}`);
    assert.deepEqual(spec.bandCounts, [count], `count=${count}`);

    const tabIds = ids(count);
    const tree = buildEqualMosaicTree(tabIds, 'rows', ultrawideMetrics);
    expectLinearTree(tree, 'row');
    assert.deepEqual(extractLeafIds(tree), tabIds, `count=${count}`);
  }
});

test('FR-GRID-015 keeps the grid baseline on equality, tall screens, and square screens', () => {
  const equalitySpec = selectEqualGridSpec(5, { containerWidth: 1500, containerHeight: 600 });
  assert.equal(equalitySpec.columns, 3);
  assert.equal(equalitySpec.rows, 2);
  assert.deepEqual(equalitySpec.bandCounts, [3, 2]);

  const missingMetricsSpec = selectEqualGridSpec(5);
  assert.equal(missingMetricsSpec.arrangement, 'rows');
  assert.equal(missingMetricsSpec.columns, 3);
  assert.equal(missingMetricsSpec.rows, 2);
  assert.deepEqual(missingMetricsSpec.bandCounts, [3, 2]);

  const tallSpec = selectEqualGridSpec(5, tallMetrics);
  assert.equal(tallSpec.arrangement, 'cols');
  assert.equal(tallSpec.columns, 2);
  assert.equal(tallSpec.rows, 3);
  assert.deepEqual(tallSpec.bandCounts, [3, 2]);

  const squareSpec = selectEqualGridSpec(4, { containerWidth: 900, containerHeight: 900 });
  assert.equal(squareSpec.columns, 2);
  assert.equal(squareSpec.rows, 2);
  assert.deepEqual(squareSpec.bandCounts, [2, 2]);
});

test('FR-GRID-014 FR-GRID-015 returns the tall 4-8 transposed baseline grid and bands', () => {
  const expected = [
    { count: 4, columns: 2, rows: 2, bandCounts: [2, 2] },
    { count: 5, columns: 2, rows: 3, bandCounts: [3, 2] },
    { count: 6, columns: 2, rows: 3, bandCounts: [3, 3] },
    { count: 7, columns: 3, rows: 3, bandCounts: [3, 2, 2] },
    { count: 8, columns: 3, rows: 3, bandCounts: [3, 3, 2] },
  ];

  for (const item of expected) {
    const spec = selectEqualGridSpec(item.count, tallMetrics);
    assert.equal(spec.arrangement, 'cols', `count=${item.count}`);
    assert.equal(spec.columns, item.columns, `count=${item.count}`);
    assert.equal(spec.rows, item.rows, `count=${item.count}`);
    assert.deepEqual(spec.bandCounts, item.bandCounts, `count=${item.count}`);

    const tree = buildEqualMosaicTree(ids(item.count), 'rows', tallMetrics);
    assert.deepEqual(bandCounts(tree, 'cols'), item.bandCounts, `count=${item.count}`);
  }
});

test('FR-GRID-014 runs the cell measurement target aspect path', () => {
  const baselineSpec = selectEqualGridSpec(4, {
    containerWidth: 1200,
    containerHeight: 700,
    cellWidth: 8,
    cellHeight: 16,
    targetColumns: 80,
    targetRows: 24,
  });

  assert.equal(baselineSpec.columns, 2);
  assert.equal(baselineSpec.rows, 2);
  assert.deepEqual(baselineSpec.bandCounts, [2, 2]);

  const defaultAspectSpec = selectEqualGridSpec(9, {
    containerWidth: 1600,
    containerHeight: 900,
  });
  const measuredCellSpec = selectEqualGridSpec(9, {
    containerWidth: 1600,
    containerHeight: 900,
    cellWidth: 4,
    cellHeight: 16,
    targetColumns: 80,
    targetRows: 24,
  });

  assert.deepEqual(
    [defaultAspectSpec.columns, defaultAspectSpec.rows],
    [9, 8],
  );
  assert.deepEqual(
    [measuredCellSpec.columns, measuredCellSpec.rows],
    [9, 4],
  );
});

test('FR-GRID-015 preserves leaf order for wide and tall Equal trees', () => {
  for (const metrics of [wideMetrics, tallMetrics]) {
    for (let count = 1; count <= 8; count += 1) {
      const tabIds = ids(count);
      const tree = buildEqualMosaicTree(tabIds, 'rows', metrics);
      assert.deepEqual(extractLeafIds(tree), tabIds, `count=${count}`);
    }
  }
});

test('FR-GRID-015 infers and validates fixed Equal trees across wide and tall layouts', () => {
  for (let count = 1; count <= 8; count += 1) {
    const wideTree = buildEqualMosaicTree(ids(count), 'rows', wideMetrics);
    assert.equal(isFixedEqualMosaicTree(wideTree, 'rows'), true, `wide count=${count}`);
    assert.equal(inferEqualLayoutArrangement(wideTree), 'rows', `wide count=${count}`);

    const tallTree = buildEqualMosaicTree(ids(count), 'rows', tallMetrics);
    assert.equal(isFixedEqualMosaicTree(tallTree, 'cols'), true, `tall count=${count}`);
    assert.equal(inferEqualLayoutArrangement(tallTree), count === 1 ? 'rows' : 'cols', `tall count=${count}`);
  }

  const wideSeven = buildEqualMosaicTree(ids(7), 'rows', wideMetrics);
  assert.equal(isFixedEqualMosaicTree(wideSeven, 'cols'), false);

  const smartRowFour = buildEqualMosaicTree(ids(4), 'rows', ultrawideMetrics);
  assert.equal(isFixedEqualMosaicTree(smartRowFour, 'rows'), true);
  assert.equal(isFixedEqualMosaicTree(smartRowFour, 'cols'), false);
  assert.equal(inferEqualLayoutArrangement(smartRowFour), 'rows');
});
