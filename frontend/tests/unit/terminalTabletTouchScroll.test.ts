// FR-ARCH-008 AC-4: the real TerminalView on an iPad. The layout query says desktop (a tablet
// keeps the desktop layout, FR-UIDS-015) while the primary pointer is coarse. A one-finger drag
// over the terminal must scroll its scrollback and consume the touchmove, so iOS does not bounce
// the whole page instead (user report 2026-11-14). The control is a desktop with a fine pointer,
// where TerminalView attaches no touch handling at all.
//
// The observable is the fake xterm's scrollLines calls and the touchmove's defaultPrevented.
// jsdom lays nothing out, so the row height TerminalView measures comes from a patched
// getBoundingClientRect (20 px rows).
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeAddonClass, createFakeTerminalClass, type FakeTerminalState } from './terminalViewHarness.ts';
import { MOBILE_LAYOUT_QUERY } from '../../src/utils/layoutMode.ts';
import { TOUCH_INPUT_QUERY } from '../../src/utils/touchInput.ts';

const state: FakeTerminalState = {
  selection: '', keyHandler: null, dataHandler: null, writes: [],
  clearSelectionCalls: 0, pasted: [], bracketedPasteMode: false, oscHandlers: new Map(),
};
const scrollCalls: number[] = [];

{
  const BaseTerminal = createFakeTerminalClass(state);
  class FakeTerminal extends BaseTerminal {
    override get modes() {
      return { bracketedPasteMode: false, applicationCursorKeysMode: false, mouseTrackingMode: 'none' };
    }
    override buffer = {
      active: { type: 'normal', cursorY: 0, cursorX: 0, viewportY: 500, baseY: 500, length: 524, getLine: () => null },
      normal: { length: 524 },
    };
    // The shared fake declares scrollLines(): void; a rest parameter still overrides it.
    override scrollLines(...args: unknown[]): void {
      const amount = Number(args[0]);
      scrollCalls.push(amount);
      this.buffer.active.viewportY += amount;
    }
  }
  const FakeAddon = createFakeAddonClass();
  mock.module('@xterm/xterm', { namedExports: { Terminal: FakeTerminal } });
  mock.module('@xterm/addon-fit', { namedExports: { FitAddon: FakeAddon } });
  mock.module('@xterm/addon-serialize', { namedExports: { SerializeAddon: FakeAddon } });
  mock.module('@xterm/addon-webgl', { namedExports: { WebglAddon: FakeAddon } });
  mock.module('@xterm/addon-unicode11', { namedExports: { Unicode11Addon: FakeAddon } });
  mock.module('../../src/contexts/WebSocketContext.tsx', {
    namedExports: {
      useWebSocketActions: () => ({
        send: () => ({ ok: true as const }),
        registerTerminalCheckpointDispatcher: () => () => {},
        refreshTerminalCheckpointRegistration: () => {},
        registerTerminalResponderHandoffView: () => () => {},
        registerTerminalResponderHandoffRuntime: () => () => {},
        getTerminalControlSocketReceipt: () => null,
        sendTerminalAuthorityControl: () => ({ ok: true as const }),
      }),
      useWebSocketState: () => ({ connected: true }),
    },
  });
}

const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { TerminalView } = await import('../../src/components/Terminal/TerminalView.tsx');

function setDevice(device: { mobileLayout: boolean; coarsePointer: boolean }): void {
  const matchMedia = (query: string) => ({
    matches: query === MOBILE_LAYOUT_QUERY ? device.mobileLayout : query === TOUCH_INPUT_QUERY ? device.coarsePointer : false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return false; },
  });
  (window as unknown as Record<string, unknown>).matchMedia = matchMedia;
  (globalThis as Record<string, unknown>).matchMedia = matchMedia;
}

function touchEvent(type: string, points: Array<{ x: number; y: number }>): Event {
  const win = document.defaultView as unknown as { Event: typeof Event };
  const event = new win.Event(type, { bubbles: true, cancelable: true });
  const touches = points.map(({ x, y }) => ({ clientX: x, clientY: y }));
  Object.defineProperty(event, 'touches', { value: touches, configurable: true });
  Object.defineProperty(event, 'changedTouches', { value: touches, configurable: true });
  return event;
}

async function dragOverTerminal(device: { mobileLayout: boolean; coarsePointer: boolean }) {
  setDevice(device);
  scrollCalls.length = 0;
  const proto = (globalThis as unknown as { HTMLElement: { prototype: HTMLElement } }).HTMLElement.prototype;
  const realRect = proto.getBoundingClientRect;
  proto.getBoundingClientRect = function rect(this: HTMLElement) {
    return { x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 480, width: 800, height: 480, toJSON() {} } as DOMRect;
  };
  const container = document.createElement('div');
  Object.defineProperty(container, 'offsetWidth', { value: 800, configurable: true });
  Object.defineProperty(container, 'offsetHeight', { value: 600, configurable: true });
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(React.createElement(TerminalView, {
        sessionId: 'session-1',
        workspaceId: 'workspace-1',
        terminalShortcutState: null,
        isVisible: true,
        outputPolicyConnectionId: 'connection-1',
        outputPolicyReconnectGeneration: 0,
        onInput: () => {},
        flushPendingUserInputBeforeQueryReply: () => false,
        onResize: () => {},
      } as never));
    });
    const view = container.querySelector('[data-terminal-view="true"]') as HTMLElement | null;
    assert.ok(view, 'TerminalView rendered');
    const touchAction = view.style.touchAction;

    // A finger moves down 100 px: five 20 px rows of earlier output.
    view.dispatchEvent(touchEvent('touchstart', [{ x: 200, y: 200 }]));
    const moves = [220, 240, 260, 280, 300].map((y) => {
      const move = touchEvent('touchmove', [{ x: 200, y }]);
      view.dispatchEvent(move);
      return move.defaultPrevented;
    });
    view.dispatchEvent(touchEvent('touchend', []));
    return { touchAction, scrolled: scrollCalls.reduce((sum, n) => sum + n, 0), movesConsumed: moves.filter(Boolean).length };
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    proto.getBoundingClientRect = realRect;
  }
}

// @req FR-ARCH-008
test('FR-ARCH-008 AC-4: on an iPad in the desktop layout a one-finger drag scrolls the terminal and is consumed', async () => {
  const tablet = await dragOverTerminal({ mobileLayout: false, coarsePointer: true });
  assert.equal(tablet.touchAction, 'none', 'the browser does not pan the page under the terminal');
  assert.equal(tablet.scrolled, -5, 'finger down 100 px shows five earlier lines, one per 20 px row');
  assert.equal(tablet.movesConsumed, 5, 'every touchmove of the pan is consumed');
});

// @req FR-ARCH-008
test('FR-ARCH-008 AC-4 control: a desktop with a fine pointer attaches no touch handling', async () => {
  const desktop = await dragOverTerminal({ mobileLayout: false, coarsePointer: false });
  assert.equal(desktop.touchAction, '');
  assert.equal(desktop.scrolled, 0);
  assert.equal(desktop.movesConsumed, 0);
});
