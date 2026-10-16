// FR-ARCH-011: the mobile layout follows the visible viewport while the keyboard is open.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  APP_HEIGHT_PROPERTY,
  installVisualViewportHeightSync,
} from '../../src/utils/visualViewportHeightSync.ts';

class FakeVisualViewport {
  height: number;
  offsetTop = 0;
  scale = 1;
  private listeners = new Map<string, Set<() => void>>();

  constructor(height: number) {
    this.height = height;
  }

  addEventListener(type: string, listener: () => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }

  listenerCount(): number {
    let count = 0;
    for (const set of this.listeners.values()) count += set.size;
    return count;
  }
}

function makeWindow(innerHeight: number, viewport: FakeVisualViewport | null) {
  const scrolls: Array<[number, number]> = [];
  return {
    innerHeight,
    scrollY: 0,
    visualViewport: viewport,
    scrollTo(x: number, y: number) {
      scrolls.push([x, y]);
      this.scrollY = y;
    },
    scrolls,
  };
}

function makeRoot() {
  const props = new Map<string, string>();
  return {
    style: {
      setProperty: (name: string, value: string) => { props.set(name, value); },
      removeProperty: (name: string) => { props.delete(name); return ''; },
    },
    props,
  };
}

test('FR-ARCH-011 AC-1: a keyboard-shortened viewport sets the app height to the visible height', () => {
  const viewport = new FakeVisualViewport(844);
  const win = makeWindow(844, viewport);
  const root = makeRoot();
  installVisualViewportHeightSync(win, root);
  assert.equal(root.props.has(APP_HEIGHT_PROPERTY), false, 'full height needs no override');

  viewport.height = 508.5;
  viewport.emit('resize');
  assert.equal(root.props.get(APP_HEIGHT_PROPERTY), '508px');
});

test('FR-ARCH-011 AC-2: a panned page is scrolled back to the top on resize and scroll', () => {
  const viewport = new FakeVisualViewport(500);
  const win = makeWindow(844, viewport);
  installVisualViewportHeightSync(win, makeRoot());
  win.scrolls.length = 0;

  viewport.offsetTop = 336;
  viewport.emit('resize');
  assert.deepEqual(win.scrolls, [[0, 0]]);

  win.scrollY = 120;
  viewport.offsetTop = 0;
  viewport.emit('scroll');
  assert.deepEqual(win.scrolls, [[0, 0], [0, 0]]);
});

test('FR-ARCH-011 AC-2: an unpanned page is not scrolled', () => {
  const viewport = new FakeVisualViewport(500);
  const win = makeWindow(844, viewport);
  installVisualViewportHeightSync(win, makeRoot());
  viewport.emit('resize');
  viewport.emit('scroll');
  assert.deepEqual(win.scrolls, []);
});

test('FR-ARCH-011: a user pinch-zoom is left alone (no height override, no scroll reset)', () => {
  const viewport = new FakeVisualViewport(422);
  viewport.scale = 2;
  viewport.offsetTop = 200;
  const win = makeWindow(844, viewport);
  const root = makeRoot();
  installVisualViewportHeightSync(win, root);
  viewport.emit('scroll');
  assert.equal(root.props.has(APP_HEIGHT_PROPERTY), false);
  assert.deepEqual(win.scrolls, []);
});

test('FR-ARCH-011 AC-3: closing the keyboard returns the app to full height', () => {
  const viewport = new FakeVisualViewport(500);
  const win = makeWindow(844, viewport);
  const root = makeRoot();
  installVisualViewportHeightSync(win, root);
  assert.equal(root.props.get(APP_HEIGHT_PROPERTY), '500px');

  viewport.height = 844;
  viewport.emit('resize');
  assert.equal(root.props.has(APP_HEIGHT_PROPERTY), false);
});

test('FR-ARCH-011 AC-4: without a visual viewport API nothing is installed', () => {
  const win = makeWindow(844, null);
  const root = makeRoot();
  const dispose = installVisualViewportHeightSync(win, root);
  assert.equal(root.props.size, 0);
  assert.deepEqual(win.scrolls, []);
  dispose();
});

test('FR-ARCH-011: dispose removes the listeners and the override', () => {
  const viewport = new FakeVisualViewport(500);
  const win = makeWindow(844, viewport);
  const root = makeRoot();
  const dispose = installVisualViewportHeightSync(win, root);
  assert.equal(viewport.listenerCount(), 2);
  dispose();
  assert.equal(viewport.listenerCount(), 0);
  assert.equal(root.props.has(APP_HEIGHT_PROPERTY), false);
});
