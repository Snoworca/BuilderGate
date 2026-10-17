// FR-MKB-003 / IR-MKB-001: the mobile modifier latch inside the real TerminalView
// term.onData handler, and the application-cursor getter on TerminalHandle.
//
// What is observed and why: in this harness the input gate never opens (restore
// stays pending, the server is never ready), so submitCapturedInput queues the
// data instead of calling onInput. The queue path records a
// `terminal_input_queued` debug event built from the exact string handed to
// submitCapturedInput. With debug capture enabled for the session, that event
// carries the byte length, the control-character count and, for control-only
// data, a safe preview (`\x03`). That is the observable for "what reached
// submitCapturedInput" here; onInput itself is out of reach of this harness, as
// terminalPasteUnifiedPath.test.ts also notes.
//
// Those counts do not identify content ('c' and 'd' look the same), so the
// debug-capture module is wrapped: every string handed to
// buildTerminalInputDebugPayload is recorded with its captureSeq, and a
// submission event is matched back to the exact string by that captureSeq.
//
// The fake xterm is extended locally (not in the shared harness) so that
// term.modes also exposes applicationCursorKeysMode and mouseTrackingMode.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createFakeAddonClass,
  createFakeTerminalClass,
  renderTerminalView,
  type FakeTerminalState,
} from './terminalViewHarness.ts';
import { mobileModifierLatch } from '../../src/utils/mobileModifierLatch.ts';

const SESSION_ID = 'session-1';

// Strings TerminalView handed to buildTerminalInputDebugPayload, keyed by captureSeq.
const debugPayloadInputs = new Map<number, string>();
const realDebugCapture = await import('../../src/utils/terminalDebugCapture.ts');

interface LatchTestState extends FakeTerminalState {
  applicationCursorKeysMode: boolean;
}

function freshState(): LatchTestState {
  return {
    selection: '', keyHandler: null, dataHandler: null, writes: [],
    clearSelectionCalls: 0, pasted: [], bracketedPasteMode: false, oscHandlers: new Map(),
    applicationCursorKeysMode: false,
  };
}

const sharedState = freshState();

{
  const BaseTerminal = createFakeTerminalClass(sharedState);
  class FakeTerminal extends BaseTerminal {
    override get modes() {
      return {
        bracketedPasteMode: sharedState.bracketedPasteMode ?? false,
        applicationCursorKeysMode: sharedState.applicationCursorKeysMode,
        mouseTrackingMode: 'none',
      };
    }
  }
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

interface DebugEvent {
  kind: string;
  preview?: string;
  details: Record<string, unknown>;
}

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
  'xterm_data_emitted',
  'terminal_input_queued',
  'terminal_input_would_queue',
  'terminal_input_rejected',
  'terminal_input_would_reject',
]);

// Every event that records a string handed to submitCapturedInput.
function submittedInputs(): DebugEvent[] {
  return debugStore().getEvents(SESSION_ID).filter((event) => SUBMIT_EVENT_KINDS.has(event.kind));
}

/** The exact string behind a submission event, found through its captureSeq. */
function submittedData(event: DebugEvent): string {
  const seq = event.details.captureSeq;
  assert.equal(typeof seq, 'number', `the submission carries a captureSeq: ${JSON.stringify(event)}`);
  const data = debugPayloadInputs.get(seq as number);
  assert.ok(data !== undefined, `no recorded payload for captureSeq ${String(seq)}`);
  return data;
}

// Views still mounted when a test fails are unmounted in afterEach; a mounted
// TerminalView keeps timers alive and the test process would never exit.
const mounted = new Set<() => Promise<void>>();

async function renderWithCapture() {
  const rendered = await renderTerminalView({ state: sharedState });
  let done = false;
  const unmountOnce = async () => {
    if (done) return;
    done = true;
    mounted.delete(unmountOnce);
    await rendered.unmount();
  };
  mounted.add(unmountOnce);
  const view = { ...rendered, unmount: unmountOnce };
  debugStore().enable(SESSION_ID);
  debugStore().clear(SESSION_ID);
  return view;
}

/** A pasted array that also delivers each paste to onData, as xterm's term.paste() does. */
class ForwardingPasteLog extends Array<string> {
  override push(...items: string[]): number {
    const result = super.push(...items);
    for (const item of items) sharedState.dataHandler?.(item);
    return result;
  }
}

test.afterEach(async () => {
  for (const unmount of [...mounted]) await unmount();
});

test.beforeEach(() => {
  Object.assign(sharedState, freshState());
  mobileModifierLatch.resetForTests();
  debugPayloadInputs.clear();
});

test('FR-MKB-003 AC-1 / SDS-AC-10: ctrl once + user-typed C submits 0x03 and turns ctrl off', async () => {
  const view = await renderWithCapture();
  mobileModifierLatch.tap('ctrl');

  view.pressKey({ key: 'C' });
  sharedState.dataHandler?.('C');
  await view.flush();

  const submitted = submittedInputs();
  assert.equal(submitted.length, 1, `exactly one submission, got ${JSON.stringify(submitted)}`);
  assert.equal(submitted[0].preview, '\\x03', 'the submitted data is 0x03, not C');
  assert.equal(submittedData(submitted[0]), '\x03');
  assert.equal(submitted[0].details.byteLength, 1);
  assert.equal(submitted[0].details.controlCount, 1);
  assert.equal(submitted[0].details.source, 'xterm');
  assert.equal(mobileModifierLatch.getSnapshot().ctrl, 'off', 'once is consumed');

  await view.unmount();
});

test('FR-MKB-003 AC-1: a typed Hangul syllable passes unchanged and leaves ctrl once', async () => {
  const view = await renderWithCapture();
  mobileModifierLatch.tap('ctrl');

  view.pressKey({ key: 'Process', keyCode: 229 });
  sharedState.dataHandler?.('한');
  await view.flush();

  const submitted = submittedInputs();
  assert.equal(submitted.length, 1);
  assert.equal(submittedData(submitted[0]), '한', 'the syllable, untouched');
  assert.equal(submitted[0].details.byteLength, 3, 'the UTF-8 syllable, untouched');
  assert.equal(submitted[0].details.controlCount, 0);
  assert.equal(mobileModifierLatch.getSnapshot().ctrl, 'once');

  await view.unmount();
});

// The amended SDS (SDS-AC-11) supersedes the earlier "no provenance → unchanged"
// contract: an Android IME commit reaches onData after the keydown/input
// microtask permit has expired, so the latch must not depend on that permit.
// Parser replies never match (they start with ESC, not one printable char).
test('FR-MKB-003 AC-4 / SDS-AC-11: ctrl once + c with no keydown/input first still submits 0x03', async () => {
  const view = await renderWithCapture();
  mobileModifierLatch.tap('ctrl');

  // No keydown or input event before it: no user-input provenance permit.
  sharedState.dataHandler?.('c');
  await view.flush();

  const submitted = submittedInputs();
  assert.equal(submitted.length, 1, `exactly one submission, got ${JSON.stringify(submitted)}`);
  assert.equal(submittedData(submitted[0]), '\x03', 'c becomes 0x03 without a provenance permit');
  assert.equal(submitted[0].details.byteLength, 1);
  assert.equal(submitted[0].details.controlCount, 1);
  assert.equal(mobileModifierLatch.getSnapshot().ctrl, 'off', 'once is consumed');

  await view.unmount();
});

test('FR-MKB-003 AC-4 / SDS-AC-11: ctrl once + c after the provenance microtask expired still submits 0x03', async () => {
  const view = await renderWithCapture();
  mobileModifierLatch.tap('ctrl');

  // keydown grants a microtask permit; flushing lets it expire before the commit.
  view.pressKey({ key: 'Unidentified', keyCode: 229 });
  await view.flush();
  sharedState.dataHandler?.('c');
  await view.flush();

  const submitted = submittedInputs();
  assert.equal(submitted.length, 1, `exactly one submission, got ${JSON.stringify(submitted)}`);
  assert.equal(submittedData(submitted[0]), '\x03', 'the late IME commit c becomes 0x03');
  assert.equal(mobileModifierLatch.getSnapshot().ctrl, 'off', 'once is consumed');

  await view.unmount();
});

test('FR-MKB-003 AC-3 / SDS-AC-11: a programmatic paste is submitted unchanged with ctrl once', async () => {
  const view = await renderWithCapture();
  sharedState.pasted = new ForwardingPasteLog();
  mobileModifierLatch.tap('ctrl');

  view.pasteFromClipboard('c');
  await view.flush();

  assert.deepEqual([...sharedState.pasted], ['c'], 'the paste reached term.paste()');
  const submitted = submittedInputs();
  assert.equal(submitted.length, 1, `exactly one submission, got ${JSON.stringify(submitted)}`);
  assert.equal(submitted[0].details.byteLength, 1);
  assert.equal(submittedData(submitted[0]), 'c', 'pasted c must not become 0x03');
  assert.equal(submitted[0].details.controlCount, 0, 'pasted c must not become 0x03');
  assert.notEqual(submitted[0].details.source, 'xterm', 'it went through the paste source');
  assert.equal(mobileModifierLatch.getSnapshot().ctrl, 'once');

  await view.unmount();
});

test('FR-MKB-003 AC-5: with every modifier off, typed data reaches submitCapturedInput unchanged', async () => {
  const view = await renderWithCapture();

  view.pressKey({ key: 'c' });
  sharedState.dataHandler?.('c');
  await view.flush();

  const submitted = submittedInputs();
  assert.equal(submitted.length, 1);
  assert.equal(submittedData(submitted[0]), 'c', 'the exact typed string reaches submitCapturedInput');
  assert.equal(submitted[0].details.byteLength, 1);
  assert.equal(submitted[0].details.controlCount, 0);
  assert.equal(submitted[0].details.source, 'xterm');

  await view.unmount();
});

test('FR-MKB-003 AC-1 AC-2: alt once + user-typed x submits ESC x and turns alt off', async () => {
  const view = await renderWithCapture();
  mobileModifierLatch.tap('alt');

  view.pressKey({ key: 'x' });
  sharedState.dataHandler?.('x');
  await view.flush();

  const submitted = submittedInputs();
  assert.equal(submitted.length, 1);
  assert.equal(submittedData(submitted[0]), '\u001bx', 'alt+x is ESC followed by exactly x');
  assert.equal(submitted[0].details.byteLength, 2, 'alt+x is ESC x');
  assert.equal(submitted[0].details.escapeCount, 1);
  assert.equal(mobileModifierLatch.getSnapshot().alt, 'off');

  await view.unmount();
});

// --- IR-MKB-001: application cursor getter -------------------------------------

test('IR-MKB-001 AC-1 / SDS-AC-12: the TerminalView handle mirrors term.modes.applicationCursorKeysMode', async () => {
  const React = await import('react');
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { TerminalView } = await import('../../src/components/Terminal/TerminalView.tsx');

  const container = document.createElement('div');
  Object.defineProperty(container, 'offsetWidth', { value: 800, configurable: true });
  Object.defineProperty(container, 'offsetHeight', { value: 600, configurable: true });
  document.body.appendChild(container);
  const root = createRoot(container);
  const ref = React.createRef<{ getApplicationCursorKeysMode: () => boolean }>();

  await act(async () => {
    root.render(React.createElement(TerminalView, {
      ref,
      sessionId: SESSION_ID,
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

  let unmounted = false;
  const unmountHandleView = async () => {
    if (unmounted) return;
    unmounted = true;
    mounted.delete(unmountHandleView);
    await act(async () => { root.unmount(); });
    container.remove();
  };
  mounted.add(unmountHandleView);

  const handle = ref.current;
  assert.ok(handle, 'TerminalView exposes its handle');
  sharedState.applicationCursorKeysMode = false;
  assert.equal(handle.getApplicationCursorKeysMode(), false);
  sharedState.applicationCursorKeysMode = true;
  assert.equal(handle.getApplicationCursorKeysMode(), true, 'the getter reads the live mode');

  await unmountHandleView();
});

test('IR-MKB-001 AC-2 / SDS-AC-12: TerminalContainer forwards the getter the way it forwards getMouseTrackingActive', () => {
  // The container needs the whole workspace runtime to render, so its forward is
  // pinned here by text; the TerminalHandle type additionally forces the field.
  const source = readFileSync(
    new URL('../../src/components/Terminal/TerminalContainer.tsx', import.meta.url),
    'utf8',
  );
  assert.match(
    source,
    /getApplicationCursorKeysMode:\s*\(\)\s*=>\s*terminalRef\.current\?\.getApplicationCursorKeysMode\(\)\s*\?\?\s*false/,
  );
});
