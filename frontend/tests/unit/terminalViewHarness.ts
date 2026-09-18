// Render harness for TerminalView (issue #87).
//
// FR-BGSTAB-021's verification was split in two halves whose blind spots overlapped:
// the clipboard coordinator tests are real behaviour tests but explicitly exclude
// TerminalView.tsx, and the TerminalView tests only read the file as text. Neither
// half ever loaded the module, so a behavioural defect in the Ctrl+C branch was
// invisible to both while 24 unit tests stayed green.
//
// This harness renders the real component so its real key handler can be invoked.
// It stubs only what cannot run under jsdom -- xterm (which needs a canvas/WebGL
// host) and the WebSocket context -- and leaves TerminalView itself untouched.
import { mock } from 'node:test';
import { installJsdomEnvironment } from './jsdomEnvironment.ts';

installJsdomEnvironment();

export interface FakeTerminalState {
  selection: string;
  keyHandler: ((ev: KeyboardEvent) => boolean) | null;
  dataHandler: ((data: string) => void) | null;
  writes: string[];
  clearSelectionCalls: number;
  pasted: string[];
}

export function createFakeTerminalClass(state: FakeTerminalState) {
  return class FakeTerminal {
    cols = 80;
    rows = 24;
    options: Record<string, unknown> = {};
    modes = { bracketedPasteMode: false };
    buffer = {
      active: { cursorY: 0, cursorX: 0, viewportY: 0, baseY: 0, length: 24, getLine: () => null },
      normal: { length: 24 },
    };
    element: HTMLElement | undefined;
    textarea: HTMLTextAreaElement | undefined;

    attachCustomKeyEventHandler(handler: (ev: KeyboardEvent) => boolean): void {
      state.keyHandler = handler;
    }
    onData(handler: (data: string) => void) {
      state.dataHandler = handler;
      return { dispose() {} };
    }
    onResize() { return { dispose() {} }; }
    onScroll() { return { dispose() {} }; }
    onSelectionChange() { return { dispose() {} }; }
    onRender() { return { dispose() {} }; }
    onTitleChange() { return { dispose() {} }; }
    onBell() { return { dispose() {} }; }
    onLineFeed() { return { dispose() {} }; }
    onCursorMove() { return { dispose() {} }; }
    onBinary() { return { dispose() {} }; }
    onWriteParsed() { return { dispose() {} }; }
    parser = {
      registerCsiHandler: () => ({ dispose() {} }),
      registerOscHandler: () => ({ dispose() {} }),
      registerDcsHandler: () => ({ dispose() {} }),
      registerEscHandler: () => ({ dispose() {} }),
    };
    open(container: HTMLElement): void {
      const el = document.createElement('div');
      el.className = 'xterm';
      const textarea = document.createElement('textarea');
      textarea.className = 'xterm-helper-textarea';
      el.appendChild(textarea);
      container.appendChild(el);
      this.element = el;
      this.textarea = textarea;
    }
    loadAddon(): void {}
    focus(): void {}
    blur(): void {}
    write(data: string, cb?: () => void): void { state.writes.push(data); cb?.(); }
    writeln(data: string): void { state.writes.push(`${data}\n`); }
    paste(data: string): void { state.pasted.push(data); }
    clear(): void {}
    reset(): void {}
    resize(): void {}
    refresh(): void {}
    scrollLines(): void {}
    scrollToBottom(): void {}
    scrollToTop(): void {}
    selectAll(): void {}
    hasSelection(): boolean { return state.selection.length > 0; }
    getSelection(): string { return state.selection; }
    getSelectionPosition(): undefined { return undefined; }
    clearSelection(): void { state.clearSelectionCalls += 1; state.selection = ''; }
    registerMarker() { return undefined; }
    dispose(): void {}
  };
}

export function createFakeAddonClass() {
  return class FakeAddon {
    activate(): void {}
    dispose(): void {}
    fit(): void {}
    serialize(): string { return ''; }
    proposeDimensions() { return { cols: 80, rows: 24 }; }
    onContextLoss() { return { dispose() {} }; }
  };
}

export interface WebSocketActionsStub {
  sent: unknown[];
}

export function installTerminalViewModuleMocks(state: FakeTerminalState, wsStub: WebSocketActionsStub): void {
  const FakeTerminal = createFakeTerminalClass(state);
  const FakeAddon = createFakeAddonClass();

  mock.module('@xterm/xterm', { namedExports: { Terminal: FakeTerminal } });
  mock.module('@xterm/addon-fit', { namedExports: { FitAddon: FakeAddon } });
  mock.module('@xterm/addon-serialize', { namedExports: { SerializeAddon: FakeAddon } });
  mock.module('@xterm/addon-webgl', { namedExports: { WebglAddon: FakeAddon } });

  mock.module('../../src/contexts/WebSocketContext.tsx', {
    namedExports: {
      useWebSocketActions: () => ({
        send: (msg: unknown) => { wsStub.sent.push(msg); return { ok: true as const }; },
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

export interface RenderedTerminalView {
  state: FakeTerminalState;
  onInputCalls: Array<{ data: string; metadata?: unknown }>;
  clipboardWrites: string[];
  pressKey: (init: Partial<KeyboardEvent> & { key: string }) => {
    handlerResult: boolean;
    defaultPrevented: boolean;
  };
  flush: () => Promise<void>;
  unmount: () => Promise<void>;
}

// Renders the real TerminalView and hands back its real custom key handler.
// `clipboardHooks` lets a test observe the async copy path without reaching xterm.
export async function renderTerminalView(options: {
  state: FakeTerminalState;
  onClipboardWrite?: (text: string) => void | Promise<void>;
} ): Promise<RenderedTerminalView> {
  const { state } = options;
  const onInputCalls: Array<{ data: string; metadata?: unknown }> = [];
  const clipboardWrites: string[] = [];

  const clipboard = {
    writeText: async (text: string) => {
      clipboardWrites.push(text);
      await options.onClipboardWrite?.(text);
    },
    readText: async () => '',
  };
  Object.defineProperty(globalThis.navigator, 'clipboard', { value: clipboard, configurable: true });

  const React = await import('react');
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { TerminalView } = await import('../../src/components/Terminal/TerminalView.tsx');

  const container = document.createElement('div');
  Object.defineProperty(container, 'offsetWidth', { value: 800, configurable: true });
  Object.defineProperty(container, 'offsetHeight', { value: 600, configurable: true });
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(React.createElement(TerminalView, {
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      terminalShortcutState: null,
      isVisible: true,
      outputPolicyConnectionId: 'connection-1',
      outputPolicyReconnectGeneration: 0,
      onInput: (data: string, metadata?: unknown) => { onInputCalls.push({ data, metadata }); },
      flushPendingUserInputBeforeQueryReply: () => false,
      onResize: () => {},
    } as never));
  });

  const handler = state.keyHandler;
  if (!handler) throw new Error('TerminalView did not register a custom key event handler');

  return {
    state,
    onInputCalls,
    clipboardWrites,
    pressKey: (init) => {
      const event = new globalThis.KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        ...(init as KeyboardEventInit),
      });
      const handlerResult = handler(event);
      return { handlerResult, defaultPrevented: event.defaultPrevented };
    },
    flush: async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); },
    unmount: async () => { await act(async () => { root.unmount(); }); container.remove(); },
  };
}
