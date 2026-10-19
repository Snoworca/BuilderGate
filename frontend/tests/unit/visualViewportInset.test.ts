// FR-MKB-007: keyboard inset from window.visualViewport. computeViewportBox is
// pure and takes a window-like object; the remembered inset is observed through
// the real hook rendered under jsdom, because only a measurement records it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installJsdomEnvironment } from './jsdomEnvironment.ts';
import {
  computeViewportBox,
  getLastKeyboardInset,
  useVisualViewportInset,
  useVisualViewportLock,
  KEYBOARD_SETTLE_MS,
} from '../../src/hooks/useVisualViewportInset.ts';

function fakeWindow(innerHeight: number, vv?: { height: number; offsetTop: number }): Window {
  return { innerHeight, visualViewport: vv } as unknown as Window;
}

test('FR-MKB-007 AC-1 / SDS-AC-9: height 500, offsetTop 120, innerHeight 900 gives top 120, height 500, inset 280', () => {
  assert.deepEqual(
    computeViewportBox(fakeWindow(900, { height: 500, offsetTop: 120 })),
    { top: 120, height: 500, inset: 280 },
  );
});

test('FR-MKB-007 AC-1 / SDS-AC-9: the inset is clamped at 0 when the visual viewport is not smaller', () => {
  assert.deepEqual(
    computeViewportBox(fakeWindow(700, { height: 700, offsetTop: 10 })),
    { top: 10, height: 700, inset: 0 },
  );
});

test('FR-MKB-007 AC-3 / SDS-AC-10: without visualViewport the inset is 0 and nothing throws', () => {
  assert.deepEqual(computeViewportBox(fakeWindow(640)), { top: 0, height: 640, inset: 0 });
});

class FakeVisualViewport extends EventTarget {
  height: number;
  offsetTop = 0;
  constructor(height: number) {
    super();
    this.height = height;
  }
}

test('FR-MKB-007 AC-1 AC-5 / SDS-AC-11: an inset of 280 is remembered after a later measure of 0', async () => {
  installJsdomEnvironment();
  const React = await import('react');
  const { act } = React;
  const { createRoot } = await import('react-dom/client');

  const vv = new FakeVisualViewport(900);
  Object.defineProperty(window, 'innerHeight', { value: 900, configurable: true });
  Object.defineProperty(window, 'visualViewport', { value: vv, configurable: true });

  const seen: Array<{ top: number; height: number; inset: number }> = [];
  function Probe(): null {
    seen.push(useVisualViewportInset(true));
    return null;
  }

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(React.createElement(Probe)); });
    assert.equal(seen.at(-1)?.inset, 0);

    // The system keyboard opens: the visual viewport shrinks and a resize fires.
    vv.height = 500;
    vv.offsetTop = 120;
    await act(async () => { vv.dispatchEvent(new Event('resize')); });
    assert.deepEqual(seen.at(-1), { top: 120, height: 500, inset: 280 });
    assert.equal(getLastKeyboardInset(), 280);

    // It closes again: the next measure is 0, the remembered inset stays.
    vv.height = 900;
    vv.offsetTop = 0;
    await act(async () => { vv.dispatchEvent(new Event('scroll')); });
    assert.equal(seen.at(-1)?.inset, 0, 'scroll re-measures too');
    assert.equal(getLastKeyboardInset(), 280);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test('FR-MKB-007 AC-2 AC-4 / SDS-AC-11: the lock writes the viewport box onto the element without re-rendering, and removes it when inactive', async () => {
  installJsdomEnvironment();
  const React = await import('react');
  const { act } = React;
  const { createRoot } = await import('react-dom/client');

  const vv = new FakeVisualViewport(900);
  Object.defineProperty(window, 'innerHeight', { value: 900, configurable: true });
  Object.defineProperty(window, 'visualViewport', { value: vv, configurable: true });

  // Frames are flushed by hand so coalescing is observable.
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 1;
  const originalRaf = window.requestAnimationFrame;
  const originalCaf = window.cancelAnimationFrame;
  window.requestAnimationFrame = (cb: FrameRequestCallback): number => { frames.set(nextFrame, cb); return nextFrame++; };
  window.cancelAnimationFrame = (id: number): void => { frames.delete(id); };
  const flushFrames = (): void => {
    const pending = [...frames.values()];
    frames.clear();
    for (const cb of pending) cb(0);
  };

  let renders = 0;
  function Probe({ active }: { active: boolean }) {
    renders += 1;
    const ref = React.useRef<HTMLDivElement>(null);
    useVisualViewportLock(active, ref);
    return React.createElement('div', { ref, id: 'lock-probe' });
  }

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const el = (): HTMLElement => container.querySelector('#lock-probe') as HTMLElement;
  try {
    // Desktop, or the bar is hidden: nothing is written.
    await act(async () => { root.render(React.createElement(Probe, { active: false })); });
    assert.equal(el().style.getPropertyValue('--app-viewport-top'), '');
    assert.equal(el().style.getPropertyValue('--app-viewport-height'), '');

    await act(async () => { root.render(React.createElement(Probe, { active: true })); });
    assert.equal(el().style.getPropertyValue('--app-viewport-top'), '0px');
    assert.equal(el().style.getPropertyValue('--app-viewport-height'), '900px');
    const rendersWhenActive = renders;

    // A burst of viewport events is applied once, on the next frame, with no render.
    vv.height = 500;
    vv.offsetTop = 100;
    await act(async () => {
      vv.dispatchEvent(new Event('resize'));
      vv.dispatchEvent(new Event('scroll'));
      vv.dispatchEvent(new Event('scroll'));
    });
    assert.equal(frames.size, 1, 'events in one frame are coalesced');
    await act(async () => { flushFrames(); });
    assert.equal(el().style.getPropertyValue('--app-viewport-top'), '100px');
    assert.equal(el().style.getPropertyValue('--app-viewport-height'), '500px');
    assert.equal(getLastKeyboardInset(), 300, 'the lock records the inset too');
    assert.equal(renders, rendersWhenActive, 'viewport events do not re-render the owner');

    // A frame left pending when the bar hides is cancelled, and both variables go.
    vv.height = 480;
    await act(async () => { vv.dispatchEvent(new Event('resize')); });
    await act(async () => { root.render(React.createElement(Probe, { active: false })); });
    assert.equal(el().style.getPropertyValue('--app-viewport-top'), '');
    assert.equal(el().style.getPropertyValue('--app-viewport-height'), '');
    assert.equal(frames.size, 0, 'the pending frame is cancelled');
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    window.requestAnimationFrame = originalRaf;
    window.cancelAnimationFrame = originalCaf;
  }
});

// FR-MKB-012 (#143): after the system keyboard goes down the app must fill the
// screen again. The browser scrolls the document to show the focused input while
// the keyboard is up; the fixed lock hides that, but once the lock is gone the
// app sits shifted up by that scroll and the keyboard's place stays blank.
async function renderLockProbe() {
  installJsdomEnvironment();
  const React = await import('react');
  const { act } = React;
  const { createRoot } = await import('react-dom/client');

  const vv = new FakeVisualViewport(900);
  Object.defineProperty(window, 'innerHeight', { value: 900, configurable: true });
  Object.defineProperty(window, 'visualViewport', { value: vv, configurable: true });

  const scroll = { x: 0, y: 0 };
  const scrollCalls: Array<[number, number]> = [];
  Object.defineProperty(window, 'scrollX', { get: () => scroll.x, configurable: true });
  Object.defineProperty(window, 'scrollY', { get: () => scroll.y, configurable: true });
  const originalScrollTo = window.scrollTo;
  window.scrollTo = ((x: number, y: number) => {
    scrollCalls.push([x, y]);
    scroll.x = x;
    scroll.y = y;
  }) as typeof window.scrollTo;

  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 1;
  const originalRaf = window.requestAnimationFrame;
  const originalCaf = window.cancelAnimationFrame;
  window.requestAnimationFrame = (cb: FrameRequestCallback): number => { frames.set(nextFrame, cb); return nextFrame++; };
  window.cancelAnimationFrame = (id: number): void => { frames.delete(id); };
  const flushFrames = (): void => {
    const pending = [...frames.values()];
    frames.clear();
    for (const cb of pending) cb(0);
  };

  function Probe({ active }: { active: boolean }) {
    const ref = React.useRef<HTMLDivElement>(null);
    useVisualViewportLock(active, ref);
    return React.createElement('div', { ref, id: 'lock-probe' });
  }

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = (active: boolean) => act(async () => { root.render(React.createElement(Probe, { active })); });
  const el = (): HTMLElement => container.querySelector('#lock-probe') as HTMLElement;
  const cleanup = async (): Promise<void> => {
    await act(async () => { root.unmount(); });
    container.remove();
    window.requestAnimationFrame = originalRaf;
    window.cancelAnimationFrame = originalCaf;
    window.scrollTo = originalScrollTo;
  };
  return { act, vv, scroll, scrollCalls, flushFrames, render, el, cleanup };
}

const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, KEYBOARD_SETTLE_MS + 80));

test('FR-MKB-012 AC-1 AC-4: the document scroll is left alone while the keyboard is up and reset once the inset is 0', async () => {
  const p = await renderLockProbe();
  try {
    await p.render(true);
    // The keyboard opens and the browser scrolls the document to the input.
    p.vv.height = 500;
    p.scroll.y = 240;
    await p.act(async () => { p.vv.dispatchEvent(new Event('resize')); });
    await p.act(async () => { p.flushFrames(); });
    assert.deepEqual(p.scrollCalls, [], 'no reset while the inset is above 0');

    // The keyboard goes down while the terminal keeps focus.
    p.vv.height = 900;
    await p.act(async () => { p.vv.dispatchEvent(new Event('resize')); });
    await p.act(async () => { p.flushFrames(); });
    assert.deepEqual(p.scrollCalls.at(-1), [0, 0]);
    assert.equal(p.scroll.y, 0);
  } finally {
    await p.cleanup();
  }
});

test('FR-MKB-012 AC-2: releasing the lock resets the document scroll now and again after the keyboard settles', async () => {
  const p = await renderLockProbe();
  try {
    await p.render(true);
    p.vv.height = 500;
    p.scroll.y = 180;
    await p.act(async () => { p.vv.dispatchEvent(new Event('resize')); });
    await p.act(async () => { p.flushFrames(); });

    // Focus leaves the terminal: the bar hides and the lock goes.
    await p.render(false);
    assert.deepEqual(p.scrollCalls.at(-1), [0, 0], 'reset on release');
    assert.equal(p.el().style.getPropertyValue('--app-viewport-height'), '');

    // The closing keyboard scrolls the document once more after the release.
    p.vv.height = 900;
    p.scroll.y = 120;
    const before = p.scrollCalls.length;
    await p.act(async () => { await settle(); });
    assert.equal(p.scrollCalls.length, before + 1, 'checked again after the keyboard settles');
    assert.equal(p.scroll.y, 0);
  } finally {
    await p.cleanup();
  }
});

test('FR-MKB-012 AC-3: the lock re-measures once after the last event, so a mid-animation last value is not kept', async () => {
  const p = await renderLockProbe();
  try {
    await p.render(true);
    p.vv.height = 500;
    await p.act(async () => { p.vv.dispatchEvent(new Event('resize')); });
    await p.act(async () => { p.flushFrames(); });
    assert.equal(p.el().style.getPropertyValue('--app-viewport-height'), '500px');

    // The last event carried a value from the middle of the closing animation;
    // the viewport then reaches full height with no further event.
    p.vv.height = 700;
    await p.act(async () => { p.vv.dispatchEvent(new Event('resize')); });
    await p.act(async () => { p.flushFrames(); });
    p.vv.height = 900;
    await p.act(async () => { await settle(); });
    await p.act(async () => { p.flushFrames(); });
    assert.equal(p.el().style.getPropertyValue('--app-viewport-height'), '900px');

    // window resize is listened to as well.
    p.vv.height = 640;
    await p.act(async () => { window.dispatchEvent(new window.Event('resize')); });
    await p.act(async () => { p.flushFrames(); });
    assert.equal(p.el().style.getPropertyValue('--app-viewport-height'), '640px');
  } finally {
    await p.cleanup();
  }
});
