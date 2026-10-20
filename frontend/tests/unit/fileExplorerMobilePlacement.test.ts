import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { resolveFileExplorerWindowLayout } from '../../src/components/fileExplorer/fileExplorerPlacement.ts';

// FR-FEX-028 (#152): on a phone the explorer fills the terminal stage, like the
// editor, whatever placement the record holds; on a desktop the record decides.

test('FR-FEX-028 AC-1/AC-2: the mobile layout fills the stage and offers no manual geometry', () => {
  for (const placement of ['floating', 'stage'] as const) {
    assert.deepEqual(resolveFileExplorerWindowLayout({ isMobile: true, placement }), {
      fillsStage: true,
      movable: false,
      showMaximizeToggle: false,
    });
  }
});

test('FR-FEX-028 AC-3: the desktop layout keeps the floating window and its maximize toggle', () => {
  assert.deepEqual(resolveFileExplorerWindowLayout({ isMobile: false, placement: 'floating' }), {
    fillsStage: false,
    movable: true,
    showMaximizeToggle: true,
  });
  assert.deepEqual(resolveFileExplorerWindowLayout({ isMobile: false, placement: 'stage' }), {
    fillsStage: true,
    movable: false,
    showMaximizeToggle: true,
  });
});

test('FR-FEX-028: the window reads the layout decision instead of the bare placement', () => {
  const source = readFileSync(new URL('../../src/components/fileExplorer/FileExplorerWindow.tsx', import.meta.url), 'utf8');
  assert.match(source, /resolveFileExplorerWindowLayout\(\{\s*isMobile/);
  assert.doesNotMatch(source, /const maximized = placement === 'stage'/);
});
