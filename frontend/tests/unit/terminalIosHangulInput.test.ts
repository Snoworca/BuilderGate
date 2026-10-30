// FR-MKB-015: the iOS Hangul input module inside the real TerminalView.
//
// The real key handler and the real helper-textarea listeners run; the fake xterm
// delivers term.input() to onData as xterm does. As in terminalMobileLatchOnData,
// the input gate never opens here, so a submission is observed through the debug
// event that submitCapturedInput records, matched back to the exact string by its
// captureSeq.
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
const DEL = '\x7f';

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
  class FakeTerminal extends BaseTerminal {
    // xterm's Terminal.input fires onData with the data, as typed input.
    input(data: string): void { sharedState.dataHandler?.(data); }
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

/** The exact strings handed to submitCapturedInput, in order. */
function submittedData(): string[] {
  return debugStore().getEvents(SESSION_ID)
    .filter((event) => SUBMIT_EVENT_KINDS.has(event.kind))
    .map((event) => {
      const data = debugPayloadInputs.get(event.details.captureSeq as number);
      assert.ok(data !== undefined, `no recorded payload for ${JSON.stringify(event)}`);
      return data;
    });
}

const mounted = new Set<() => Promise<void>>();

async function render() {
  const rendered = await renderTerminalView({ state: sharedState });
  let done = false;
  const unmount = async () => {
    if (done) return;
    done = true;
    mounted.delete(unmount);
    await rendered.unmount();
  };
  mounted.add(unmount);
  debugStore().enable(SESSION_ID);
  debugStore().clear(SESSION_ID);
  const textarea = document.querySelector('textarea.xterm-helper-textarea');
  assert.ok(textarea instanceof HTMLTextAreaElement, 'the fake xterm attached its helper textarea');
  const handler = sharedState.keyHandler!;
  const key = (type: string, init: KeyboardEventInit) => handler(new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init }));
  // One iOS jamo keystroke as measured on iOS 18.7: keydown keyCode 0, keypress with the
  // jamo's code point, the textarea edits, keyup. A keypress the view lets through is sent
  // by xterm.
  const typeJamo = (jamo: string, edits: Array<['del'] | ['ins', string]>) => {
    const down = key('keydown', { key: jamo, keyCode: 0 });
    const press = key('keypress', { key: jamo, keyCode: jamo.codePointAt(0)!, charCode: jamo.codePointAt(0)! });
    if (press) sharedState.dataHandler?.(jamo);
    for (const edit of edits) {
      if (edit[0] === 'del') {
        textarea.value = Array.from(textarea.value).slice(0, -1).join('');
        textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
      } else {
        textarea.value += edit[1];
        textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: edit[1] }));
      }
    }
    key('keyup', { key: jamo, keyCode: 0 });
    return { down, press };
  };
  return { ...rendered, unmount, textarea, key, typeJamo };
}

test.afterEach(async () => {
  for (const unmount of [...mounted]) await unmount();
});

test.beforeEach(() => {
  Object.assign(sharedState, freshState());
  debugPayloadInputs.clear();
});

test('FR-MKB-015 AC-1: the view sends the iOS textarea edits, not the keypress jamo', async () => {
  const view = await render();
  const strokes = [
    view.typeJamo('ㅇ', [['ins', 'ㅇ']]),
    view.typeJamo('ㅏ', [['del'], ['ins', '아']]),
    view.typeJamo('ㄴ', [['del'], ['ins', '안']]),
  ];
  await view.flush();
  for (const stroke of strokes) {
    assert.equal(stroke.down, false, 'xterm does not handle the jamo keydown');
    assert.equal(stroke.press, false, 'xterm does not send the keypress jamo');
  }
  assert.deepEqual(submittedData(), ['ㅇ', DEL, '아', DEL, '안']);
  assert.equal(view.textarea.value, '안', 'the view leaves the keyboard\'s own edits alone');
  await view.unmount();
});

test('FR-MKB-015 AC-3: a Backspace while the textarea holds Hangul is left to the keyboard', async () => {
  const view = await render();
  view.typeJamo('ㄱ', [['ins', 'ㄱ']]);
  view.typeJamo('ㅏ', [['del'], ['ins', '가']]);
  view.typeJamo('ㄱ', [['del'], ['ins', '각']]);
  await view.flush();
  const before = submittedData().length;
  assert.equal(view.key('keydown', { key: 'Backspace', keyCode: 8 }), false, 'xterm does not handle the Backspace');
  // The keyboard takes the last jamo off the syllable it is composing.
  view.textarea.value = '';
  view.textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
  view.textarea.value = '가';
  view.textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '가' }));
  view.key('keyup', { key: 'Backspace', keyCode: 8 });
  await view.flush();
  assert.deepEqual(submittedData().slice(before), [DEL, '가']);
  await view.unmount();
});

test('FR-MKB-015 AC-6: a Backspace with no Hangul in the textarea stays xterm\'s', async () => {
  const view = await render();
  assert.equal(view.key('keydown', { key: 'Backspace', keyCode: 8 }), true);
  await view.unmount();
});

test('FR-MKB-015 AC-4: Enter or a Latin letter that xterm sends empties the textarea', async () => {
  for (const other of ['\r', 'a']) {
    const view = await render();
    view.typeJamo('ㄱ', [['ins', 'ㄱ']]);
    view.key('keydown', { key: other === '\r' ? 'Enter' : other, keyCode: other === '\r' ? 13 : 65 });
    sharedState.dataHandler?.(other);
    await view.flush();
    assert.equal(view.textarea.value, '', `after ${JSON.stringify(other)}`);
    await view.unmount();
    Object.assign(sharedState, freshState());
  }
});

test('FR-MKB-015 AC-4: a terminal query reply leaves the textarea alone', async () => {
  const view = await render();
  view.typeJamo('ㄱ', [['ins', 'ㄱ']]);
  await view.flush();
  // No keydown or input before it: a parser-generated device attributes reply.
  sharedState.dataHandler?.('\x1b[?1;2c');
  await view.flush();
  assert.equal(view.textarea.value, 'ㄱ');
  await view.unmount();
});

test('FR-MKB-015 AC-4: the mobile key bar, shortcuts and mouse reports keep the textarea in step', () => {
  const source = readFileSync(new URL('../../src/components/Terminal/TerminalView.tsx', import.meta.url), 'utf8');
  const sendInput = source.slice(source.indexOf('sendInput: (data: string) => {'));
  assert.ok(sendInput.slice(0, sendInput.indexOf("'imperative')")).includes('iosHangulInputRef.current?.noteSentInput(data)'), 'sendInput (the mobile key bar) reports what it sends');
  const shortcut = source.slice(source.indexOf("if (shortcutResolution.action.type === 'send') {"));
  assert.ok(shortcut.slice(0, shortcut.indexOf("'shortcut-binding')")).includes('iosHangulInputRef.current?.noteSentInput('), 'a shortcut binding reports what it sends');
  const binary = source.slice(source.indexOf('term.onBinary((data) => {'));
  assert.ok(binary.slice(0, binary.indexOf("'xterm-mouse')")).includes('iosHangulInputRef.current?.noteSentInput('), 'a mouse report reports what it sends');
});

test('FR-MKB-015 AC-6: a composing key (keyCode 229) is not taken by the iOS path', async () => {
  const view = await render();
  assert.equal(view.key('keydown', { key: 'ㅇ', keyCode: 229 }), true);
  assert.equal(view.key('keypress', { key: 'ㅇ', keyCode: 229 }), true);
  view.textarea.value = 'ㅇ';
  view.textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'ㅇ' }));
  view.key('keyup', { key: 'ㅇ', keyCode: 229 });
  await view.flush();
  assert.deepEqual(submittedData(), [], 'nothing is sent by the iOS path');
  await view.unmount();
});

test('FR-BGSTAB-037 AC-1, AC-4: a dictation rewrite is sent as its change and kept from xterm\'s listener', async () => {
  const view = await render();
  // xterm listens on the textarea itself, in the capture phase.
  const reachedXterm: string[] = [];
  view.textarea.addEventListener('input', (event) => { reachedXterm.push((event as InputEvent).data ?? ''); }, true);
  const dictate = (text: string) => {
    view.textarea.setSelectionRange(0, view.textarea.value.length);
    view.textarea.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }));
    view.textarea.value = text;
    view.textarea.setSelectionRange(text.length, text.length);
    view.textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  };
  dictate('안');
  dictate('안녕하');
  dictate('안녕하세요');
  await view.flush();
  assert.deepEqual(reachedXterm, ['안'], 'only the first insertText, with nothing selected, reaches xterm');
  assert.deepEqual(submittedData(), ['녕하', '세요']);
  await view.unmount();
});

test('FR-BGSTAB-036 AC-1: the view sends a macOS Safari replacement of the textarea', async () => {
  const view = await render();
  const change = (inputType: string, value: string, data: string) => {
    view.textarea.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType, data }));
    view.textarea.value = value;
    view.textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType, data }));
  };
  // The first jamo, with no key held, is xterm's insertText (the fake xterm sends nothing).
  change('insertText', 'ㅇ', 'ㅇ');
  view.key('keydown', { key: 'ㅇ', keyCode: 229 });
  view.key('keyup', { key: 'ㅇ', keyCode: 68 });
  await view.flush();
  change('insertReplacementText', '아', '아');
  await view.flush();
  assert.deepEqual(submittedData(), [`${DEL}아`]);
  await view.unmount();
});
