// FR-UIDS-017: the grid toolbar's "stack horizontally" layout stacks every terminal
// top to bottom, for a monitor turned on its side.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  buildEqualColumnsMosaicTree,
  buildEqualRowsMosaicTree,
  buildLinearPresetMosaicTree,
  extractLeafIds,
  isLinearEqualPreset,
} from '../../src/utils/mosaic.ts';
import {
  readPersistedMosaicLayout,
  saveMosaicLayoutForWorkspace,
} from '../../src/hooks/mosaicLayoutStorage.ts';
import { ICON_GLYPHS } from '../../src/components/common/iconGlyphs.ts';
import type { MosaicNode } from '../../src/types/workspace.ts';

const read = (rel: string): string =>
  readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const toolbarSource = read('../../src/components/Grid/MosaicToolbar.tsx');
const containerSource = read('../../src/components/Grid/MosaicContainer.tsx');
const layoutHookSource = read('../../src/hooks/useMosaicLayout.ts');
const en = JSON.parse(read('../../public/locales/messages.en.json')) as Record<string, string>;
const ko = JSON.parse(read('../../public/locales/messages.ko.json')) as Record<string, string>;

const ids = (count: number): string[] => Array.from({ length: count }, (_, i) => `tab-${i + 1}`);

function directions(node: MosaicNode<string>): string[] {
  if (typeof node === 'string') return [];
  return [node.direction, ...directions(node.first), ...directions(node.second)];
}

function leafShares(node: MosaicNode<string>, share = 100): number[] {
  if (typeof node === 'string') return [share];
  const pct = node.splitPercentage ?? 50;
  return [...leafShares(node.first, share * pct / 100), ...leafShares(node.second, share * (100 - pct) / 100)];
}

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return Array.from(this.values.keys())[index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

test('FR-UIDS-017 AC-1: the toolbar order is equal, vertical, horizontal, focus, auto', () => {
  const labels = [...toolbarSource.matchAll(/label=\{t\('grid\.toolbar\.(\w+)'\)\}/g)].map((m) => m[1]);
  assert.deepEqual(labels, ['equal', 'vertical', 'horizontal', 'focus', 'auto']);
});

test('FR-UIDS-017 AC-1: the horizontal button reports its own preset and the equal button stays off for it', () => {
  assert.match(
    toolbarSource,
    /command="rows"\s+icon="rows"\s+label=\{t\('grid\.toolbar\.horizontal'\)\}\s+active=\{layoutMode === 'equal' && equalPreset === 'rows'\}\s+onClick=\{onRowsLayout\}/,
  );
  assert.match(
    toolbarSource,
    /label=\{t\('grid\.toolbar\.equal'\)\}\s+active=\{layoutMode === 'equal' && equalPreset === 'smart'\}/,
  );
});

test('FR-UIDS-017 AC-2: the rows preset stacks one to eight tabs top to bottom, in order, at equal heights', () => {
  for (let count = 1; count <= 8; count += 1) {
    const tabIds = ids(count);
    const tree = buildEqualRowsMosaicTree(tabIds);
    assert.deepEqual(extractLeafIds(tree), tabIds, `count=${count}`);
    assert.ok(directions(tree).every((d) => d === 'column'), `count=${count} must split only top/bottom`);
    for (const share of leafShares(tree)) {
      assert.ok(Math.abs(share - 100 / count) < 1e-9, `count=${count} share=${share}`);
    }
  }
  assert.throws(() => buildEqualRowsMosaicTree([]), /empty ids/);
});

test('FR-UIDS-017 AC-2: the preset builder picks rows or columns and nothing else counts as a fixed preset', () => {
  const tabIds = ids(4);
  assert.deepEqual(buildLinearPresetMosaicTree('rows', tabIds), buildEqualRowsMosaicTree(tabIds));
  assert.deepEqual(buildLinearPresetMosaicTree('columns', tabIds), buildEqualColumnsMosaicTree(tabIds));
  assert.equal(isLinearEqualPreset('rows'), true);
  assert.equal(isLinearEqualPreset('columns'), true);
  assert.equal(isLinearEqualPreset('smart'), false);
});

test('FR-UIDS-017 AC-3: the rows and columns buttons go through one handler', () => {
  assert.match(containerSource, /const handleLinearLayout = useCallback\(\(preset: LinearEqualPreset\) => \{/);
  assert.match(containerSource, /onColumnsLayout=\{\(\) => handleLinearLayout\('columns'\)\}/);
  assert.match(containerSource, /onRowsLayout=\{\(\) => handleLinearLayout\('rows'\)\}/);
});

test('FR-UIDS-017 AC-4: a saved rows preset is read back for the workspace', () => {
  const storage = new MemoryStorage();
  const tree = buildEqualRowsMosaicTree(ids(3));
  assert.equal(saveMosaicLayoutForWorkspace('ws-rows', tree, 'equal', null, storage, 'rows'), true);
  const persisted = readPersistedMosaicLayout('ws-rows', storage);
  assert.ok(persisted && persisted.schemaVersion === 2);
  assert.equal(persisted.equalPreset, 'rows');
  assert.deepEqual(persisted.tree, tree);
});

test('FR-UIDS-017 AC-4: restore, tab changes and drag reorder rebuild a fixed preset, not columns only', () => {
  assert.doesNotMatch(containerSource, /=== 'columns'/);
  assert.doesNotMatch(layoutHookSource, /=== 'columns'/);
  const presetRebuilds = containerSource.match(/isLinearEqualPreset\((?:equalPreset|preset)\)\s*\n?\s*\? buildLinearPresetMosaicTree\(/g) ?? [];
  assert.ok(presetRebuilds.length >= 3, `tab change, mode apply and drag paths: found ${presetRebuilds.length}`);
  assert.match(layoutHookSource, /isLinearEqualPreset\(equalPreset\)\s*\n?\s*\? buildLinearPresetMosaicTree\(equalPreset, /);
});

test('FR-UIDS-017 AC-5: the rows glyph is a frame split into three horizontal bands', () => {
  assert.deepEqual(ICON_GLYPHS.rows.paths, ['M4 3h16v18H4z', 'M4 9h16', 'M4 15h16']);
  assert.notDeepEqual(ICON_GLYPHS.rows.paths, ICON_GLYPHS.menu.paths);
  assert.notDeepEqual(ICON_GLYPHS.rows.paths, ICON_GLYPHS.columns.paths);
});

test('FR-UIDS-017 AC-6: the button name comes from both catalogs', () => {
  assert.equal(en['grid.toolbar.horizontal'], 'Stack horizontally');
  assert.equal(ko['grid.toolbar.horizontal'], '가로 정렬');
});

test('FR-UIDS-017 AC-3: another layout button switches to that layout, the same button returns to free layout', async () => {
  const { resolveToolbarLayoutMode, resolveLinearLayoutToggle } = await import('../../src/components/Grid/gridLayoutToggle.ts');
  const at = (mode: 'equal' | 'focus' | 'auto' | 'none', equalPreset: 'smart' | 'columns' | 'rows', focusTarget: string | null = null) =>
    ({ mode, equalPreset, focusTarget });
  // equal split pressed while a fixed preset is on: becomes equal split, not free layout
  assert.equal(resolveToolbarLayoutMode(at('equal', 'rows'), 'equal', null), 'equal');
  assert.equal(resolveToolbarLayoutMode(at('equal', 'columns'), 'equal', null), 'equal');
  // equal split pressed while equal split is on: free layout
  assert.equal(resolveToolbarLayoutMode(at('equal', 'smart'), 'equal', null), 'none');
  // focus and auto from rows switch; pressing them again turns them off
  assert.equal(resolveToolbarLayoutMode(at('equal', 'rows'), 'focus', 'tab-1'), 'focus');
  assert.equal(resolveToolbarLayoutMode(at('focus', 'smart', 'tab-1'), 'focus', 'tab-1'), 'none');
  assert.equal(resolveToolbarLayoutMode(at('focus', 'smart', 'tab-1'), 'focus', 'tab-2'), 'focus');
  assert.equal(resolveToolbarLayoutMode(at('equal', 'rows'), 'auto', null), 'auto');
  assert.equal(resolveToolbarLayoutMode(at('auto', 'smart'), 'auto', null), 'none');
  // the fixed presets
  assert.deepEqual(resolveLinearLayoutToggle(at('equal', 'rows'), 'rows'), { mode: 'none', equalPreset: 'smart' });
  assert.deepEqual(resolveLinearLayoutToggle(at('equal', 'columns'), 'rows'), { mode: 'equal', equalPreset: 'rows' });
  assert.deepEqual(resolveLinearLayoutToggle(at('equal', 'smart'), 'rows'), { mode: 'equal', equalPreset: 'rows' });
  assert.deepEqual(resolveLinearLayoutToggle(at('focus', 'smart', 'tab-1'), 'rows'), { mode: 'equal', equalPreset: 'rows' });
  assert.deepEqual(resolveLinearLayoutToggle(at('equal', 'rows'), 'columns'), { mode: 'equal', equalPreset: 'columns' });
});

test('FR-UIDS-017 AC-3: the container decides button presses with those two functions', () => {
  assert.match(containerSource, /resolveToolbarLayoutMode\(\s*\{ mode: layoutMode, equalPreset, focusTarget \}/);
  assert.match(containerSource, /resolveLinearLayoutToggle\(\s*\{ mode: layoutMode, equalPreset, focusTarget \},\s*preset,?\s*\)/);
});

test('FR-UIDS-017 AC-4: every rebuild passes the live preset, never a fixed one', () => {
  const calls = containerSource.match(/buildLinearPresetMosaicTree\((\w+|'[^']*')/g) ?? [];
  assert.equal(calls.length, 5, calls.join(' | '));
  assert.ok(calls.every((c) => /\((equalPreset|preset|nextPreset)$/.test(c)), calls.join(' | '));
});

test('FR-UIDS-017 AC-1: toolbar buttons report their state through aria-pressed', () => {
  assert.match(toolbarSource, /aria-pressed=\{active\}/);
});
