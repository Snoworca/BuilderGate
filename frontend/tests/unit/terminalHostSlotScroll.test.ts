// REL-BGSTAB-052 AC-8: scrolling anywhere in the page measures a terminal slot at most once a
// frame, not synchronously per event (each measure forces a layout: two getBoundingClientRect).
import test from 'node:test';
import assert from 'node:assert/strict';
import { installJsdomEnvironment } from './jsdomEnvironment.ts';

installJsdomEnvironment();
const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { TerminalRuntimeProvider, useTerminalRuntimeContext } = await import('../../src/components/Terminal/TerminalRuntimeContext.tsx');
const { TerminalHostSlot } = await import('../../src/components/Terminal/TerminalHostSlot.tsx');

// As in the app, the runtime root exists before a slot mounts inside it.
function Stage({ withSlot }: { withSlot: boolean }) {
  const { rootRef } = useTerminalRuntimeContext();
  return React.createElement('div', { ref: rootRef }, withSlot ? React.createElement(TerminalHostSlot, { tabId: 't1', isVisible: true }) : null);
}

test('REL-BGSTAB-052 AC-8: a burst of scroll events measures once, on the next frame', async () => {
  const proto = (globalThis as unknown as { HTMLElement: { prototype: HTMLElement } }).HTMLElement.prototype;
  const real = proto.getBoundingClientRect;
  let rects = 0;
  proto.getBoundingClientRect = function patched(this: HTMLElement) { rects += 1; return real.call(this); };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(React.createElement(TerminalRuntimeProvider, null, React.createElement(Stage, { withSlot: false }))); });
    await act(async () => { root.render(React.createElement(TerminalRuntimeProvider, null, React.createElement(Stage, { withSlot: true }))); });
    await act(async () => { await new Promise((r) => setTimeout(r, 1_500)); }); // reveal settle timers
    const before = rects;
    const scroller = document.createElement('div');
    document.body.appendChild(scroller);
    for (let i = 0; i < 20; i += 1) scroller.dispatchEvent(new (window as unknown as { Event: typeof Event }).Event('scroll'));
    assert.equal(rects, before, 'no synchronous layout per scroll event');
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    assert.ok(rects - before <= 2, `one measure for the burst, got ${(rects - before) / 2}`);
    assert.ok(rects - before >= 2, 'the slot is still measured after scrolling');
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    proto.getBoundingClientRect = real;
  }
});
