import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  EDITOR_WINDOW_GEOMETRY_KEY,
  readEditorWindowGeometry,
  writeEditorWindowGeometry,
} from '../../src/components/editor/editorWindowGeometryCache.ts';

// FR-MDE-009 — the one position and size every editor window opens at.
//
// Global rather than per workspace: the user asked for one cached placement,
// and a key named after a workspace cannot be that. It is also separate from
// the dialog geometry store, whose read path clamps through `clampDialogRect`
// -- the function that lowers the minimum-size floor to the viewport, which is
// the rule this cache is required to break.

const MIN_SIZE = { width: 320, height: 240 };
const VIEWPORT = { width: 1280, height: 720 };
const RECT = { x: 120, y: 80, width: 900, height: 500 };

class MemoryStorage implements Storage {
  private readonly map = new Map<string, string>();

  get length(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }

  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

test('FR-MDE-009 the cache runs with no DOM in scope', () => {
  assert.equal(typeof (globalThis as { window?: unknown }).window, 'undefined');

  const storage = new MemoryStorage();
  writeEditorWindowGeometry(RECT, storage);
  readEditorWindowGeometry(VIEWPORT, MIN_SIZE, storage);
});

test('FR-MDE-009 a written rect comes back unchanged while it fits', () => {
  const storage = new MemoryStorage();

  writeEditorWindowGeometry(RECT, storage);
  assert.deepEqual(readEditorWindowGeometry(VIEWPORT, MIN_SIZE, storage), RECT);

  // Under one key, and that key names no workspace. A per-workspace key would
  // give each workspace its own placement, which is the opposite of what was
  // asked for.
  assert.equal(storage.length, 1);
  assert.equal(storage.key(0), EDITOR_WINDOW_GEOMETRY_KEY);
  assert.doesNotMatch(EDITOR_WINDOW_GEOMETRY_KEY, /workspace/i);
});

test('FR-MDE-009 nothing stored reads as nothing, and so does anything malformed', () => {
  const storage = new MemoryStorage();
  assert.equal(readEditorWindowGeometry(VIEWPORT, MIN_SIZE, storage), null);

  // A null answer is what tells the caller to compute an opening placement
  // instead. Each of these is a shape the store can actually hold: a value
  // written by an older build, a half-written one, a hand-edited one.
  ['', '{', 'null', '"a string"', '[]', '{"x":1}', '{"x":1,"y":2,"width":3}',
    '{"x":null,"y":2,"width":3,"height":4}', '{"x":"1","y":2,"width":3,"height":4}',
    '{"x":1,"y":2,"width":3,"height":"4"}'].forEach((raw) => {
    storage.setItem(EDITOR_WINDOW_GEOMETRY_KEY, raw);
    assert.equal(
      readEditorWindowGeometry(VIEWPORT, MIN_SIZE, storage),
      null,
      `malformed value should read as nothing: ${raw}`,
    );
  });

  // A rect carrying a non-finite number is malformed too, and JSON writes those
  // as `null` rather than refusing them.
  storage.setItem(EDITOR_WINDOW_GEOMETRY_KEY, JSON.stringify({
    x: Number.NaN, y: 0, width: 900, height: 500,
  }));
  assert.equal(readEditorWindowGeometry(VIEWPORT, MIN_SIZE, storage), null);
});

test('FR-MDE-009 a rect that has fallen off the viewport is pushed back on', () => {
  const storage = new MemoryStorage();

  // Off the right edge and below the bottom, as happens when the window is
  // reopened on a smaller screen than it was placed on.
  writeEditorWindowGeometry({ x: 2400, y: 1400, width: 900, height: 500 }, storage);

  const restored = readEditorWindowGeometry(VIEWPORT, MIN_SIZE, storage);
  assert.notEqual(restored, null);
  assert.deepEqual(restored, {
    x: VIEWPORT.width - 900,
    y: VIEWPORT.height - 500,
    width: 900,
    height: 500,
  });

  // Negative coordinates are the other direction of the same fault.
  writeEditorWindowGeometry({ x: -500, y: -300, width: 900, height: 500 }, storage);
  assert.deepEqual(readEditorWindowGeometry(VIEWPORT, MIN_SIZE, storage), {
    x: 0, y: 0, width: 900, height: 500,
  });
});

test('FR-MDE-009 the minimum size survives a viewport smaller than it', () => {
  const storage = new MemoryStorage();
  writeEditorWindowGeometry(RECT, storage);

  // This is the rule `clampDialogRect` breaks: it lowers the floor to the
  // viewport, leaving a window too small to show its own title bar -- and a
  // window whose title bar is gone cannot be moved or resized back.
  const tiny = { width: 200, height: 150 };
  const restored = readEditorWindowGeometry(tiny, MIN_SIZE, storage);
  assert.notEqual(restored, null);
  assert.equal(restored!.width, MIN_SIZE.width);
  assert.equal(restored!.height, MIN_SIZE.height);

  // Part of it then sits outside the viewport, and the origin is not pushed
  // negative to hide that: the title bar stays reachable.
  assert.equal(restored!.x, 0);
  assert.equal(restored!.y, 0);
});

test('FR-MDE-009 a rect larger than the viewport is shrunk to it, but not below the floor', () => {
  const storage = new MemoryStorage();
  writeEditorWindowGeometry({ x: 0, y: 0, width: 4000, height: 3000 }, storage);

  assert.deepEqual(readEditorWindowGeometry(VIEWPORT, MIN_SIZE, storage), {
    x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height,
  });
});

test('FR-MDE-009 a later write replaces the earlier one', () => {
  const storage = new MemoryStorage();

  writeEditorWindowGeometry(RECT, storage);
  const moved = { x: 40, y: 50, width: 600, height: 400 };
  writeEditorWindowGeometry(moved, storage);

  assert.equal(storage.length, 1, 'one key, not one per write');
  assert.deepEqual(readEditorWindowGeometry(VIEWPORT, MIN_SIZE, storage), moved);
});

test('FR-MDE-009 a storage that throws is survived rather than propagated', () => {
  // Private browsing modes refuse both reads and writes. A window that could
  // not be placed because the store objected would be worse than one placed at
  // its default.
  const hostile: Storage = {
    length: 0,
    clear() { throw new Error('denied'); },
    getItem() { throw new Error('denied'); },
    key() { throw new Error('denied'); },
    removeItem() { throw new Error('denied'); },
    setItem() { throw new Error('denied'); },
  };

  assert.equal(readEditorWindowGeometry(VIEWPORT, MIN_SIZE, hostile), null);
  writeEditorWindowGeometry(RECT, hostile);
});
