// Behavioural coverage for FR-BGSTAB-021's TerminalView half (issue #87).
//
// What this file covers that the source-text assertions do not: it EXECUTES the
// component. The existing TerminalView assertions read the file with readFileSync
// and match regexes against it, so they constrain the TEXT of the Ctrl+C branch and
// not its BEHAVIOUR; the clipboard coordinator tests are real behaviour tests but
// never import TerminalView. The reviewer's F3 defect -- replacing the Ctrl+C branch
// with an unconditional preventDefault() + sendInput('\x03') -- left all 24 unit
// tests green. It fails here.
//
// What this file does NOT cover: anything that needs a real xterm renderer. The
// terminal is stubbed (jsdom has no canvas or WebGL host), so selection geometry,
// rendering, and xterm's own key handling are out of scope and remain E2E concerns.
// The source-text assertions are kept, not replaced -- see the note in
// terminalClipboardAdapterContract.test.ts for what they pin.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  installTerminalViewModuleMocks,
  renderTerminalView,
  type FakeTerminalState,
} from './terminalViewHarness.ts';

function freshState(): FakeTerminalState {
  return { selection: '', keyHandler: null, dataHandler: null, writes: [], clearSelectionCalls: 0, pasted: [] };
}

const sharedState = freshState();
installTerminalViewModuleMocks(sharedState, { sent: [] });

test('AC-2: Ctrl+C without a selection delegates to xterm so the PTY receives SIGINT', async () => {
  const state = freshState();
  Object.assign(sharedState, state);
  const view = await renderTerminalView({ state: sharedState });

  sharedState.selection = '';
  const { handlerResult, defaultPrevented } = view.pressKey({ key: 'c', ctrlKey: true });

  // Returning true hands the event to xterm, which owns the SIGINT path. Returning
  // false, or preventing the default, takes SIGINT away from the terminal.
  assert.equal(handlerResult, true, 'Ctrl+C with no selection must delegate to xterm');
  assert.equal(defaultPrevented, false, 'Ctrl+C with no selection must not preventDefault');

  await view.flush();
  // TerminalView must not synthesise the interrupt itself; xterm sends it.
  const interrupts = view.onInputCalls.filter((c) => c.data === '\x03');
  assert.deepEqual(interrupts, [], 'TerminalView must not send \\x03 itself');
  assert.deepEqual(view.clipboardWrites, [], 'no selection means nothing is copied');

  await view.unmount();
});

test('AC-2: Ctrl+C with a selection is owned by the clipboard coordinator, not xterm', async () => {
  const state = freshState();
  Object.assign(sharedState, state);
  const view = await renderTerminalView({ state: sharedState });

  sharedState.selection = 'selected text';
  const { handlerResult } = view.pressKey({ key: 'c', ctrlKey: true });

  assert.equal(handlerResult, false, 'Ctrl+C with a selection must not reach xterm');
  await view.flush();
  assert.deepEqual(view.clipboardWrites, ['selected text']);
  const interrupts = view.onInputCalls.filter((c) => c.data === '\x03');
  assert.deepEqual(interrupts, [], 'a copy must not also interrupt the foreground process');

  await view.unmount();
});

test('AC-3: a successful copy clears the selection it copied', async () => {
  const state = freshState();
  Object.assign(sharedState, state);
  const view = await renderTerminalView({ state: sharedState });

  sharedState.selection = 'stable selection';
  const before = sharedState.clearSelectionCalls;
  view.pressKey({ key: 'c', ctrlKey: true });
  await view.flush();

  assert.deepEqual(view.clipboardWrites, ['stable selection']);
  assert.ok(
    sharedState.clearSelectionCalls > before,
    'an accepted copy clears the selection',
  );

  await view.unmount();
});

test('AC-3: a copy whose selection changed mid-write leaves the new selection alone', async () => {
  const state = freshState();
  Object.assign(sharedState, state);
  // The selection changes while the clipboard write is in flight, which is exactly
  // the race the generation/selection guard exists for. The guard must refuse to
  // clear, because what is selected now is not what was copied.
  const view = await renderTerminalView({
    state: sharedState,
    onClipboardWrite: () => { sharedState.selection = 'a different selection'; },
  });

  sharedState.selection = 'original selection';
  const before = sharedState.clearSelectionCalls;
  view.pressKey({ key: 'c', ctrlKey: true });
  await view.flush();

  assert.deepEqual(view.clipboardWrites, ['original selection']);
  assert.equal(
    sharedState.clearSelectionCalls,
    before,
    'the selection changed after capture, so the copy must not clear it',
  );

  await view.unmount();
});
