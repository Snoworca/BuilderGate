import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  DOUBLE_TAP_SLOP_PX,
  DOUBLE_TAP_WINDOW_MS,
  createDoubleTapDetector,
  tapPointOf,
} from '../../src/hooks/doubleTap.ts';

// FR-UIDS-013 (#157): two touch taps in quick succession open the context menu wherever a long
// press does, because a long press on Android summons the assistant.

const read = (path: string) => readFileSync(new URL(`../../src/${path}`, import.meta.url), 'utf8');

test('FR-UIDS-013 AC-1: two taps within 300 ms and 24 px are a double tap; the pair is consumed', () => {
  assert.equal(DOUBLE_TAP_WINDOW_MS, 300);
  assert.equal(DOUBLE_TAP_SLOP_PX, 24);
  const d = createDoubleTapDetector();
  assert.equal(d.tap({ x: 100, y: 100, at: 0 }), false);
  assert.equal(d.tap({ x: 110, y: 112, at: 250 }), true);
  // A third tap starts a new pair rather than completing another.
  assert.equal(d.tap({ x: 110, y: 112, at: 400 }), false);
});

test('FR-UIDS-013 AC-1: too slow, too far, or after a reset is not a double tap', () => {
  const d = createDoubleTapDetector();
  d.tap({ x: 0, y: 0, at: 0 });
  assert.equal(d.tap({ x: 0, y: 0, at: 301 }), false, 'too slow');
  d.reset();
  d.tap({ x: 0, y: 0, at: 1000 });
  assert.equal(d.tap({ x: 30, y: 0, at: 1100 }), false, 'too far');
  d.reset();
  d.tap({ x: 0, y: 0, at: 2000 });
  d.reset();
  assert.equal(d.tap({ x: 0, y: 0, at: 2100 }), false, 'a scroll or long press in between resets');
});

test('FR-UIDS-013: the tap point comes from the touch that ended', () => {
  assert.deepEqual(tapPointOf({ changedTouches: [{ clientX: 5, clientY: 6 }] }, 9), { x: 5, y: 6, at: 9 });
  assert.equal(tapPointOf({ changedTouches: [] }, 9), null);
  assert.equal(tapPointOf(undefined, 9), null);
});

test('FR-UIDS-013 AC-1/AC-2: useLongPress reports a double tap and cancels the second touchend', () => {
  const hook = read('hooks/useLongPress.ts');
  assert.match(hook, /doubleTapRef\.current\.tap\(point\)/);
  assert.match(hook, /e\?\.preventDefault\?\.\(\);\s*callback\(\{ clientX: point\.x, clientY: point\.y, gesture: 'double-tap' \}\)/);
  assert.match(hook, /gesture: 'long-press'/);
  const alone = read('hooks/useDoubleTap.ts');
  assert.match(alone, /e\.preventDefault\(\);\s*callback\(/);
});

test('FR-UIDS-013 AC-3: every menu site on a touch screen answers a double tap', () => {
  // Hook sites: their touchend reaches useLongPress with the event.
  for (const [path, wiring] of [
    ['components/Terminal/TerminalRuntimeLayer.tsx', /onTouchEnd=\{longPress\.onTouchEnd\}/],
    ['components/Grid/MosaicTile.tsx', /onTouchEnd=\{longPress\.onTouchEnd\}/],
    ['components/fileExplorer/FileExplorerTabBar.tsx', /onTouchEnd=\{longPress\.onTouchEnd\}/],
    ['components/editor/EditorTabBar.tsx', /onTouchEnd=\{longPress\.onTouchEnd\}/],
    ['components/editor/EditorDocumentPanel.tsx', /onTouchEnd=\{editLongPress\.onTouchEnd\}/],
    ['components/editor/EditorWindow.tsx', /addEventListener\('touchend', endWindowMenuLongPress\)/],
  ] as const) {
    assert.match(read(path), wiring, path);
  }
  // Sites whose long press is the browser's own contextmenu take useDoubleTap.
  for (const path of ['components/MetadataBar/MetadataRow.tsx', 'components/Workspace/WorkspaceTabBar.tsx', 'components/Workspace/WorkspaceItem.tsx']) {
    const source = read(path);
    assert.match(source, /useDoubleTap\(/, path);
    assert.match(source, /onTouchEnd=\{(?:[a-zA-Z]+DoubleTap\.onTouchEnd\}|\(event\) => \{[\s\S]{0,120}[a-zA-Z]+DoubleTap\.onTouchEnd\(event\))/, path);
  }
  assert.match(read('components/MetadataBar/MetadataRow.tsx'), /isolate: true/, 'the path does not also open the tile menu');
});

// FR-FEX-032 AC-6 supersedes AC-4 for explorer rows: their double tap opens the row and their
// hold picks it up (fileExplorerPickUpWiring.test.ts); the explorer tabs keep the menu.
test('FR-UIDS-013 AC-5: a terminal double tap drops the keyboard', () => {
  for (const path of ['components/Terminal/TerminalRuntimeLayer.tsx', 'components/Grid/MosaicTile.tsx']) {
    assert.match(read(path), /if \(gesture === 'double-tap'\) dismissSoftKeyboard\(\);/, path);
  }
});
