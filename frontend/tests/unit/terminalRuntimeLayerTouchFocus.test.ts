// FR-ARCH-010: the wiring in TerminalRuntimeLayer, executed.
//
// terminalTouchTapPolicy.test.ts covers the tap decision as a pure function.
// This file renders the real TerminalRuntimeLayer and dispatches the event
// sequence a phone produces (pointerdown -> touchstart -> touchmove -> click),
// so it shows that the layer actually asks that decision before it focuses.
// Only TerminalContainer (xterm) and the runtime context are stubbed.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { installJsdomEnvironment } from './jsdomEnvironment.ts';

installJsdomEnvironment();

interface Calls {
  focus: string[];
  invalidate: number;
  hostPointerDown: number;
  contextMenu: Array<[number, number]>;
  innerClicks: number;
}

const calls: Calls = { focus: [], invalidate: 0, hostPointerDown: 0, contextMenu: [], innerClicks: 0 };
let hostClassName = '';

function resetCalls(): void {
  calls.focus.length = 0;
  calls.invalidate = 0;
  calls.hostPointerDown = 0;
  calls.contextMenu.length = 0;
  calls.innerClicks = 0;
}

const React = await import('react');

mock.module('../../src/components/Terminal/TerminalContainer.tsx', {
  namedExports: {
    TerminalContainer: React.forwardRef(function FakeTerminalContainer(_props: unknown, ref: React.Ref<unknown>) {
      React.useImperativeHandle(ref, () => ({
        focus: (reason: string) => { calls.focus.push(reason); },
        invalidateClipboardContext: () => { calls.invalidate += 1; },
      }));
      return React.createElement('div', { 'data-fake-terminal': 'true' });
    }),
  },
});

mock.module('../../src/components/Terminal/TerminalRuntimeContext.tsx', {
  namedExports: {
    useTerminalRuntimeContext: () => ({
      rootRef: { current: null },
      hosts: new Map([['tab-1', {
        tabId: 'tab-1',
        rect: { left: 0, top: 0, width: 400, height: 300 },
        isVisible: true,
        className: hostClassName,
      }]]),
      outputPolicySelectionCoordinator: {},
      getHostInteractions: () => ({
        onPointerDown: () => { calls.hostPointerDown += 1; },
        onContextMenu: (x: number, y: number) => { calls.contextMenu.push([x, y]); },
      }),
    }),
  },
});

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { TerminalRuntimeLayer } = await import('../../src/components/Terminal/TerminalRuntimeLayer.tsx');

async function render(className = '') {
  hostClassName = className;
  resetCalls();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const terminalRefsMap = { current: new Map() };
  await act(async () => {
    root.render(React.createElement(TerminalRuntimeLayer, {
      tabs: [{ id: 'tab-1', sessionId: 'session-1', workspaceId: 'ws-1', status: 'running' }] as never,
      terminalRefsMap: terminalRefsMap as never,
      onStatusChange: () => {},
      onCwdChange: () => {},
      onAuthError: () => {},
      terminalShortcutState: null,
    }));
  });
  const inner = container.querySelector('[data-fake-terminal]') as HTMLElement;
  assert.ok(inner, 'the fake terminal rendered inside the runtime entry');
  inner.addEventListener('click', () => { calls.innerClicks += 1; });
  return {
    inner,
    unmount: async () => { await act(async () => { root.unmount(); }); container.remove(); },
  };
}

type Point = { clientX: number; clientY: number };

async function fire(target: HTMLElement, event: Event): Promise<Event> {
  await act(async () => { target.dispatchEvent(event); });
  return event;
}

function pointerDown(pointerType: string): Event {
  return new window.PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType, button: 0 });
}

function touch(type: 'touchstart' | 'touchmove' | 'touchend', touches: Point[]): Event {
  const event = new window.TouchEvent(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'touches', { value: touches });
  Object.defineProperty(event, 'changedTouches', { value: touches });
  return event;
}

const click = () => new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
const mouseDown = () => new window.MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 });

test('FR-ARCH-010 AC-1: a touch pointerdown does not focus the terminal', async () => {
  const view = await render();
  await fire(view.inner, pointerDown('touch'));
  await fire(view.inner, touch('touchstart', [{ clientX: 50, clientY: 50 }]));
  assert.deepEqual(calls.focus, []);
  assert.equal(calls.hostPointerDown, 0);
  await view.unmount();
});

test('FR-ARCH-010 AC-3: a short tap focuses the terminal once, on the click', async () => {
  const view = await render();
  await fire(view.inner, pointerDown('touch'));
  await fire(view.inner, touch('touchstart', [{ clientX: 50, clientY: 50 }]));
  await fire(view.inner, touch('touchmove', [{ clientX: 54, clientY: 53 }]));
  await fire(view.inner, touch('touchend', []));
  const compat = await fire(view.inner, mouseDown());
  assert.equal(compat.defaultPrevented, false, 'the compatibility mousedown of a tap reaches xterm');
  await fire(view.inner, click());
  assert.deepEqual(calls.focus, ['runtime-layer']);
  assert.equal(calls.hostPointerDown, 1);
  assert.equal(calls.innerClicks, 1);
  await view.unmount();
});

test('FR-ARCH-010 AC-2: a pan does not focus, and its click and mousedown never reach xterm', async () => {
  const view = await render();
  await fire(view.inner, pointerDown('touch'));
  await fire(view.inner, touch('touchstart', [{ clientX: 50, clientY: 50 }]));
  await fire(view.inner, touch('touchmove', [{ clientX: 50, clientY: 120 }]));
  await fire(view.inner, touch('touchend', []));
  const compat = await fire(view.inner, mouseDown());
  await fire(view.inner, click());
  assert.equal(compat.defaultPrevented, true);
  assert.deepEqual(calls.focus, []);
  assert.equal(calls.hostPointerDown, 0);
  assert.equal(calls.innerClicks, 0, 'the click was stopped before it reached the terminal');
  await view.unmount();
});

test('FR-ARCH-010 AC-4: a two-finger pinch does not focus', async () => {
  const view = await render();
  await fire(view.inner, pointerDown('touch'));
  await fire(view.inner, touch('touchstart', [{ clientX: 50, clientY: 50 }]));
  await fire(view.inner, touch('touchstart', [{ clientX: 50, clientY: 50 }, { clientX: 120, clientY: 140 }]));
  await fire(view.inner, touch('touchend', []));
  await fire(view.inner, click());
  assert.deepEqual(calls.focus, []);
  await view.unmount();
});

test('FR-ARCH-010 AC-5: a long press opens the menu and does not focus', async () => {
  const view = await render();
  await fire(view.inner, pointerDown('touch'));
  await fire(view.inner, touch('touchstart', [{ clientX: 50, clientY: 50 }]));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 560)); });
  await fire(view.inner, touch('touchend', []));
  await fire(view.inner, click());
  assert.deepEqual(calls.contextMenu, [[50, 50]]);
  assert.deepEqual(calls.focus, []);
  await view.unmount();
});

test('FR-ARCH-010 AC-6: mouse and pen still focus on pointerdown', async () => {
  for (const pointerType of ['mouse', 'pen']) {
    const view = await render();
    await fire(view.inner, pointerDown(pointerType));
    assert.deepEqual(calls.focus, ['runtime-layer'], pointerType);
    assert.equal(calls.hostPointerDown, 1, pointerType);
    await view.unmount();
  }
});

test('FR-ARCH-010 AC-7: a tap on a grid tile selects the tile and focuses it', async () => {
  const view = await render('grid-cell terminal-running');
  await fire(view.inner, pointerDown('touch'));
  await fire(view.inner, touch('touchstart', [{ clientX: 50, clientY: 50 }]));
  assert.equal(calls.hostPointerDown, 0, 'nothing happens on touch down');
  assert.equal(calls.invalidate, 0);
  await fire(view.inner, touch('touchend', []));
  await fire(view.inner, click());
  assert.equal(calls.hostPointerDown, 1, 'the tile focus handler ran on the tap');
  assert.equal(calls.invalidate, 1, 'grid clipboard context was invalidated on the tap');
  assert.deepEqual(calls.focus, ['runtime-layer']);
  await view.unmount();
});
