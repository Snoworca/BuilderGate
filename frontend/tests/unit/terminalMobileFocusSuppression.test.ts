// FR-MKB-008 AC-1 AC-4: TerminalHandle.blurInput and setFocusSuppressed in the
// real TerminalView. While the special keyboard panel is open every focus entry
// into the terminal must stay shut, because any of them would raise the system
// keyboard over the panel. Every entry ends in focusTerminalInput, so the
// observable is the helper textarea never becoming document.activeElement.
//
// The pending focus-restore path itself cannot be driven to completion in this
// harness (the input gate never opens, as terminalMobileLatchOnData.test.ts
// notes). What is observable is the pending flag's effect on focusout: while a
// restore is queued, a blur keeps the `terminal-focused` class; once blurInput
// has cleared the queue, the class goes with the blur. The suppression test
// does bring the server back while suppressed, but in this harness that does
// not prove the restore ran; the restore gate is covered by its sharing the
// focusTerminalInput gate, which the other entries do exercise. The clipboard
// coordinator's focus goes through the same focusTerminalInput and is not
// driven separately.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installTerminalViewModuleMocks, type FakeTerminalState } from './terminalViewHarness.ts';

const state: FakeTerminalState = {
  selection: '', keyHandler: null, dataHandler: null, writes: [],
  clearSelectionCalls: 0, pasted: [], bracketedPasteMode: false, oscHandlers: new Map(),
};
installTerminalViewModuleMocks(state, { sent: [] });

const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { TerminalView } = await import('../../src/components/Terminal/TerminalView.tsx');
type TerminalHandle = import('../../src/components/Terminal/TerminalView.tsx').TerminalHandle;

async function renderWithHandle() {
  const container = document.createElement('div');
  Object.defineProperty(container, 'offsetWidth', { value: 800, configurable: true });
  Object.defineProperty(container, 'offsetHeight', { value: 600, configurable: true });
  document.body.appendChild(container);
  const root = createRoot(container);
  const ref = React.createRef<TerminalHandle>();
  await act(async () => {
    root.render(React.createElement(TerminalView, {
      ref,
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
  const handle = ref.current;
  assert.ok(handle, 'TerminalView exposes its handle');
  const textarea = container.querySelector('textarea.xterm-helper-textarea') as HTMLTextAreaElement | null;
  assert.ok(textarea, 'the fake xterm attached its helper textarea');
  const view = container.querySelector('.terminal-view') as HTMLElement;
  return {
    handle,
    textarea,
    view,
    unmount: async () => { await act(async () => { root.unmount(); }); container.remove(); },
  };
}

function win(): Window & typeof globalThis {
  return document.defaultView as Window & typeof globalThis;
}

test('FR-MKB-008 AC-1 / SDS-AC-1: blurInput takes focus off the helper textarea and drops a queued focus restore', async () => {
  const r = await renderWithHandle();
  try {
    await act(async () => { r.handle.focus('test'); });
    assert.equal(document.activeElement, r.textarea, 'precondition: the terminal has focus');
    // Queues a focus restore: the terminal is focused and the server went away.
    await act(async () => { r.handle.setServerReady(false); });
    await act(async () => { r.handle.blurInput(); });
    assert.notEqual(document.activeElement, r.textarea, 'the helper textarea lost focus');
    assert.equal(r.view.classList.contains('terminal-focused'), false, 'no restore was left queued to keep the focus marker');
  } finally {
    await r.unmount();
  }
});

test('FR-MKB-008 AC-4 / SDS-AC-4: while suppressed, handle.focus(), a click and a direct textarea focus all leave the terminal blurred', async () => {
  const r = await renderWithHandle();
  try {
    await act(async () => { r.handle.focus('test'); });
    await act(async () => { r.handle.blurInput(); r.handle.setFocusSuppressed(true); });
    assert.notEqual(document.activeElement, r.textarea);

    // A focus-then-blur would still flash the keyboard on iOS, so the gated
    // entries must not reach the textarea at all: no focusin is allowed.
    let focusins = 0;
    const countFocusIn = (): void => { focusins += 1; };
    r.textarea.addEventListener('focusin', countFocusIn);

    await act(async () => { r.handle.focus('runtime-layer'); });
    assert.notEqual(document.activeElement, r.textarea, 'the public focus() is ignored (runtime layer, tab wrapper, key send, bar)');

    await act(async () => { r.view.dispatchEvent(new (win().MouseEvent)('click', { bubbles: true, cancelable: true })); });
    assert.notEqual(document.activeElement, r.textarea, 'handleClick is ignored');

    // A queued restore that comes due while suppressed (server back) does not focus either.
    await act(async () => { r.handle.setServerReady(false); r.handle.setServerReady(true); });
    assert.notEqual(document.activeElement, r.textarea, 'pending restore is ignored');
    assert.equal(r.view.classList.contains('terminal-focused'), false, 'and does not mark the terminal focused');
    assert.equal(focusins, 0, 'no gated entry ever focused the textarea, not even briefly');
    r.textarea.removeEventListener('focusin', countFocusIn);

    // xterm focusing its own textarea (or the runtime layer's fallback) is undone at once.
    await act(async () => { r.textarea.focus(); });
    assert.notEqual(document.activeElement, r.textarea, 'a self-focus is blurred');
    assert.equal(r.view.classList.contains('terminal-focused'), false);

    // A second true, or anything but false, does not release it.
    await act(async () => { r.handle.setFocusSuppressed(true); r.handle.focus('again'); });
    assert.notEqual(document.activeElement, r.textarea);
  } finally {
    await r.unmount();
  }
});

test('FR-MKB-008 AC-4 / SDS-AC-4: once released with setFocusSuppressed(false), focus behaves as before', async () => {
  const r = await renderWithHandle();
  try {
    await act(async () => { r.handle.setFocusSuppressed(true); });
    await act(async () => { r.handle.setFocusSuppressed(false); r.handle.focus('switch'); });
    assert.equal(document.activeElement, r.textarea, 'focus() works again');

    await act(async () => { r.handle.blurInput(); });
    await act(async () => { r.view.dispatchEvent(new (win().MouseEvent)('click', { bubbles: true, cancelable: true })); });
    assert.equal(document.activeElement, r.textarea, 'a click focuses again');
    assert.equal(r.view.classList.contains('terminal-focused'), true);
  } finally {
    await r.unmount();
  }
});
