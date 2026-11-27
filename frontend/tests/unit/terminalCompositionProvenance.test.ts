// REL-BGSTAB-019: typed input keeps its user provenance when xterm hands it to onData late.
//
// xterm sends a committed IME composition from a setTimeout(0) after compositionend. The view's
// user-input permit used to expire at the next microtask, so a Hangul syllable arrived as
// "parser-generated" and, while a snapshot replacement held its replay lease, was dropped as
// an automatic terminal reply (xterm_replay_auto_reply_suppressed).
//
// The real TerminalView runs here with a fake xterm; the fake keeps write callbacks so the
// replacement's replay lease stays open while the test types.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createFakeAddonClass,
  createFakeTerminalClass,
  renderTerminalView,
  type FakeTerminalState,
} from './terminalViewHarness.ts';

const SESSION_ID = 'session-1';
const DEVICE_ATTRIBUTES_REPLY = '\x1b[?1;2c';

const debugPayloadInputs = new Map<number, string>();
const realDebugCapture = await import('../../src/utils/terminalDebugCapture.ts');

function freshState(): FakeTerminalState {
  return {
    selection: '', keyHandler: null, dataHandler: null, writes: [],
    clearSelectionCalls: 0, pasted: [], bracketedPasteMode: false, oscHandlers: new Map(),
  };
}

const sharedState = freshState();

{
  const BaseTerminal = createFakeTerminalClass(sharedState);
  const FakeAddon = createFakeAddonClass();
  mock.module('../../src/utils/terminalDebugCapture.ts', {
    namedExports: {
      ...realDebugCapture,
      buildTerminalInputDebugPayload: (
        ...args: Parameters<typeof realDebugCapture.buildTerminalInputDebugPayload>
      ) => {
        const [raw, metadata] = args;
        if (typeof metadata?.captureSeq === 'number') debugPayloadInputs.set(metadata.captureSeq, raw);
        return realDebugCapture.buildTerminalInputDebugPayload(...args);
      },
    },
  });
  mock.module('@xterm/xterm', { namedExports: { Terminal: BaseTerminal } });
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

interface DebugEvent { kind: string; details: Record<string, unknown> }
interface DebugStore {
  enable(sessionId: string): void;
  clear(sessionId?: string): void;
  getEvents(sessionId?: string): DebugEvent[];
}

function debugStore(): DebugStore {
  const store = (window as unknown as { __buildergateTerminalDebug?: DebugStore }).__buildergateTerminalDebug;
  if (!store) throw new Error('TerminalView did not create the debug store');
  return store;
}

const SUBMIT_EVENT_KINDS = new Set([
  'xterm_data_emitted', 'terminal_input_queued', 'terminal_input_would_queue',
  'terminal_input_rejected', 'terminal_input_would_reject',
]);

/** The exact strings handed to submitCapturedInput, in order. */
function submittedData(): string[] {
  return debugStore().getEvents(SESSION_ID)
    .filter((event) => SUBMIT_EVENT_KINDS.has(event.kind))
    .map((event) => debugPayloadInputs.get(event.details.captureSeq as number) ?? '<unrecorded>');
}

function suppressedCount(): number {
  return debugStore().getEvents(SESSION_ID).filter((event) => event.kind === 'xterm_replay_auto_reply_suppressed').length;
}

interface Handle { replaceWithSnapshot(data: string): Promise<boolean> }

/** Renders the view and starts a snapshot replacement whose replay write stays open. */
async function renderWithOpenReplay() {
  const ref: { current: unknown } = { current: null };
  const rendered = await renderTerminalView({ state: sharedState, ref });
  debugStore().enable(SESSION_ID);
  debugStore().clear(SESSION_ID);
  const textarea = document.querySelector('textarea.xterm-helper-textarea');
  assert.ok(textarea instanceof HTMLTextAreaElement);
  sharedState.heldWriteCallbacks = [];
  const replacement = (ref.current as Handle).replaceWithSnapshot('restored screen\r\n');
  await rendered.flush();
  await rendered.flush();
  assert.ok(
    sharedState.writes.some((data) => data.includes('restored screen')),
    'the replacement reached its replay write',
  );
  const finishReplay = async () => {
    const held = sharedState.heldWriteCallbacks ?? [];
    sharedState.heldWriteCallbacks = undefined;
    for (const cb of held) cb();
    await rendered.flush();
    await replacement;
  };
  return { ...rendered, textarea, finishReplay };
}

/** One Korean IME syllable, then xterm's delayed send of the committed text. */
function commitSyllable(textarea: HTMLTextAreaElement, steps: string[]): void {
  // jsdom puts its event constructors on the document's window, not on Node's globalThis.
  const { CompositionEvent, InputEvent } = textarea.ownerDocument.defaultView as unknown as typeof globalThis;
  textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
  for (const step of steps) {
    textarea.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: step }));
    textarea.value = step;
    textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', data: step, isComposing: true }));
  }
  const committed = steps[steps.length - 1];
  textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: committed }));
  // xterm's CompositionHelper sends the committed text from a setTimeout(0).
  setTimeout(() => sharedState.dataHandler?.(committed), 0);
}

test.beforeEach(() => {
  Object.assign(sharedState, freshState());
  sharedState.heldWriteCallbacks = undefined;
  debugPayloadInputs.clear();
});

test('REL-BGSTAB-019 AC-3: a parser reply during the replay write is still suppressed', async () => {
  const view = await renderWithOpenReplay();
  try {
    sharedState.dataHandler?.(DEVICE_ATTRIBUTES_REPLY);
    await view.flush();
    assert.equal(suppressedCount(), 1, 'the open replay lease suppresses the parser reply');
    assert.deepEqual(submittedData(), []);
  } finally {
    await view.finishReplay();
    await view.unmount();
  }
});

test('REL-BGSTAB-019 AC-1, AC-2: a Hangul syllable committed during the replay write is sent', async () => {
  const view = await renderWithOpenReplay();
  try {
    commitSyllable(view.textarea, ['ㅎ', '하', '한']);
    await view.flush();
    await view.flush();
    assert.equal(suppressedCount(), 0, 'the committed syllable is not taken for a terminal reply');
    assert.deepEqual(submittedData(), ['한']);
  } finally {
    await view.finishReplay();
    await view.unmount();
  }
});

test('REL-BGSTAB-019 AC-3: a parser reply while a committed syllable is pending is still suppressed', async () => {
  const view = await renderWithOpenReplay();
  try {
    // The reply arrives after compositionend and before xterm's timer sends the syllable, so
    // the composition permit is open when it is classified.
    commitSyllable(view.textarea, ['ㄱ', '가']);
    // A parser reply comes from a later task (a write callback), after the input events'
    // same-task permits are gone.
    await Promise.resolve();
    sharedState.dataHandler?.(DEVICE_ATTRIBUTES_REPLY);
    await view.flush();
    await view.flush();
    assert.deepEqual(submittedData(), ['가']);
    assert.equal(suppressedCount(), 1, 'a reply with ESC never uses the composition permit');
  } finally {
    await view.finishReplay();
    await view.unmount();
  }
});

test('REL-BGSTAB-019 AC-1, AC-2: a digit the IME inserts without composing is sent during the replay write', async () => {
  const view = await renderWithOpenReplay();
  try {
    // Hangul mode: the digit key is keyCode 229, the IME inserts the digit, and xterm sends the
    // textarea change from a setTimeout(0).
    const { KeyboardEvent, InputEvent } = view.textarea.ownerDocument.defaultView as unknown as typeof globalThis;
    const keydown = new KeyboardEvent('keydown', { key: '1', bubbles: true, cancelable: true });
    Object.defineProperty(keydown, 'keyCode', { get: () => 229 });
    view.textarea.dispatchEvent(keydown);
    view.textarea.value += '1';
    view.textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '1' }));
    setTimeout(() => sharedState.dataHandler?.('1'), 0);
    await view.flush();
    await view.flush();
    assert.equal(suppressedCount(), 0);
    assert.deepEqual(submittedData(), ['1']);
  } finally {
    await view.finishReplay();
    await view.unmount();
  }
});

test('REL-BGSTAB-019 AC-4: the composition permit does not depend on listener order', () => {
  const source = readFileSync(new URL('../../src/components/Terminal/TerminalView.tsx', import.meta.url), 'utf8');
  const onEnd = source.slice(source.indexOf('const onCompositionEnd = (event: CompositionEvent) => {'));
  assert.ok(
    onEnd.slice(0, onEnd.indexOf('};')).includes('markDeferredInput()'),
    'compositionend grants the permit; xterm sends the text from a later timer, so it runs after any listener',
  );
});
