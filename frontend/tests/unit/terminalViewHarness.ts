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

export type FakeOscHandler = (data: string) => boolean | Promise<boolean>;

export interface FakeTerminalState {
  selection: string;
  keyHandler: ((ev: KeyboardEvent) => boolean) | null;
  dataHandler: ((data: string) => void) | null;
  writes: string[];
  clearSelectionCalls: number;
  pasted: string[];
  // #18: 아래 둘은 선택 필드다. 기존 두 테스트가 이 객체를 리터럴로 만들고 있어
  // 필수로 올리면 그쪽이 깨진다. renderTerminalView 가 렌더 전에 채운다.
  /** term.modes.bracketedPasteMode 가 읽는 값. 여러 줄 붙여넣기 가드를 구동한다. */
  bracketedPasteMode?: boolean;
  /** parser.registerOscHandler 로 등록된 핸들러. OSC52 정책을 실제로 호출해 본다. */
  oscHandlers?: Map<number, FakeOscHandler>;
}

export function createFakeTerminalClass(state: FakeTerminalState) {
  return class FakeTerminal {
    cols = 80;
    rows = 24;
    options: Record<string, unknown> = {};
    get modes() { return { bracketedPasteMode: state.bracketedPasteMode ?? false }; }
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
      registerOscHandler: (ident: number, handler: FakeOscHandler) => {
        (state.oscHandlers ??= new Map()).set(ident, handler);
        return { dispose() {} };
      },
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
  // #18: 키보드 Ctrl+V 를 실제 paste 이벤트로 재현한다.
  //
  // xterm 은 paste 를 element 와 textarea 에 **버블** 단계로 건다(실측
  // CoreBrowserTerminal.ts:342-344). 둘 다 TerminalView 의 capture 리스너가 붙은
  // 컨테이너의 자손이다. 그 배치를 그대로 흉내 내어 `.xterm` 위에 버블 리스너를
  // 하나 달고, 그것이 호출됐는지를 돌려준다 — 호출됐다면 xterm 의 진짜 핸들러도
  // 함께 돌았을 것이고, 그것이 곧 이중 붙여넣기다.
  pasteFromClipboard: (text: string) => {
    defaultPrevented: boolean;
    reachedXtermListener: boolean;
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
  state.oscHandlers ??= new Map();
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
    pasteFromClipboard: (text: string) => {
      const xtermEl = container.querySelector('.xterm');
      if (!xtermEl) throw new Error('fake terminal did not attach its .xterm element');

      let reachedXtermListener = false;
      const xtermListener = () => { reachedXtermListener = true; };
      // xterm 과 같은 버블 단계, 같은 자손 위치.
      xtermEl.addEventListener('paste', xtermListener);

      // window 의 Event 를 써야 한다. jsdomEnvironment 는 globalThis 에 이미 있는 키를
      // 덮어쓰지 않는데 Node 에는 자체 Event 가 있어서 globalThis.Event 는 jsdom 것이
      // 아니고, 그것으로 만든 객체는 jsdom 의 dispatchEvent 가 거부한다.
      // clipboardData 는 생성자로 받을 수 없으므로 직접 정의한다.
      const win = container.ownerDocument.defaultView as unknown as { Event: typeof globalThis.Event };
      const event = new win.Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', {
        value: { getData: (type: string) => (type === 'text/plain' ? text : '') },
        configurable: true,
      });

      try {
        xtermEl.dispatchEvent(event);
      } finally {
        xtermEl.removeEventListener('paste', xtermListener);
      }
      return { defaultPrevented: event.defaultPrevented, reachedXtermListener };
    },
    flush: async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); },
    unmount: async () => { await act(async () => { root.unmount(); }); container.remove(); },
  };
}
