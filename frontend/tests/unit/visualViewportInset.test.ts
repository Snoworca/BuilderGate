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
