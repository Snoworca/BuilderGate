// REL-BGSTAB-052 AC-9: small caches that used to grow for the life of the tab.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rememberRecent } from '../../src/utils/boundedRecent.ts';
import { getCachedSize, setCachedSize, MERMAID_SIZE_CACHE_LIMIT } from '../../src/editor/core/mermaid-render.ts';

test('REL-BGSTAB-052 AC-9: rememberRecent keeps the newest ids up to the limit', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 1000; i += 1) rememberRecent(seen, `id${i}`, 256);
  assert.equal(seen.size, 256);
  assert.ok(!seen.has('id0') && seen.has('id999') && seen.has('id744'));
});

test('REL-BGSTAB-052 AC-9: the Mermaid size cache keeps the most recently used diagrams', () => {
  for (let i = 0; i < MERMAID_SIZE_CACHE_LIMIT + 40; i += 1) setCachedSize(`graph TD; A${i}-->B`, { width: i, height: 1 } as never);
  assert.equal(getCachedSize('graph TD; A0-->B'), undefined, 'the oldest is dropped');
  assert.deepEqual(getCachedSize(`graph TD; A${MERMAID_SIZE_CACHE_LIMIT + 39}-->B`), { width: MERMAID_SIZE_CACHE_LIMIT + 39, height: 1 });
});
