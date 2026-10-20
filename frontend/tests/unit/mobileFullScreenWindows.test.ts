import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { EDITOR_WINDOW_BOUNDS_SELECTOR, MOBILE_WINDOW_BOUNDS_SELECTOR, windowFillSelector } from '../../src/components/editor/editorWindowBounds.ts';

// FR-UIDS-014 (#159): on a phone the file explorer and the editor cover the whole app, header
// and tab bar included; on a desktop they keep the stage.

test('FR-UIDS-014 AC-1/AC-3: a phone measures .app, a desktop the stage', () => {
  assert.equal(MOBILE_WINDOW_BOUNDS_SELECTOR, '.app');
  assert.equal(windowFillSelector(true), '.app');
  assert.equal(windowFillSelector(false), EDITOR_WINDOW_BOUNDS_SELECTOR);
});

test('FR-UIDS-014 AC-1/AC-2: both windows measure the element windowFillSelector names, and follow its size', () => {
  const explorer = readFileSync(new URL('../../src/components/fileExplorer/FileExplorerWindow.tsx', import.meta.url), 'utf8');
  assert.match(explorer, /useStageRect\(maximized && !hidden, windowFillSelector\(isMobile\)\)/);
  const editor = readFileSync(new URL('../../src/components/editor/EditorWindowLayer.tsx', import.meta.url), 'utf8');
  assert.match(editor, /windowFillSelector\(true\)/);
  assert.match(editor, /new ResizeObserver\(measureOverlay\)/);
});
