import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeDragReorderTarget } from '../../src/hooks/useDragReorder.ts';

const horizontalRects = [
  { left: 0, top: 0, width: 100, height: 24 },
  { left: 100, top: 0, width: 100, height: 24 },
  { left: 200, top: 0, width: 100, height: 24 },
] as DOMRect[];

const verticalRects = [
  { left: 0, top: 0, width: 200, height: 40 },
  { left: 0, top: 40, width: 200, height: 40 },
  { left: 0, top: 80, width: 200, height: 40 },
] as DOMRect[];

test('computeDragReorderTarget keeps horizontal tab reorder insertion semantics', () => {
  assert.equal(computeDragReorderTarget({ axis: 'x', pointer: 10, itemRects: horizontalRects }), 0);
  assert.equal(computeDragReorderTarget({ axis: 'x', pointer: 150, itemRects: horizontalRects }), 2);
  assert.equal(computeDragReorderTarget({ axis: 'x', pointer: 350, itemRects: horizontalRects }), 3);
});

test('computeDragReorderTarget supports vertical workspace list insertion semantics', () => {
  assert.equal(computeDragReorderTarget({ axis: 'y', pointer: 10, itemRects: verticalRects }), 0);
  assert.equal(computeDragReorderTarget({ axis: 'y', pointer: 62, itemRects: verticalRects }), 2);
  assert.equal(computeDragReorderTarget({ axis: 'y', pointer: 150, itemRects: verticalRects }), 3);
});
