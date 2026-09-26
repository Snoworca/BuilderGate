// Issue #88: the saved right-click selection can diverge from term.hasSelection(),
// and while it does, Ctrl+C is intercepted as a copy instead of reaching the PTY
// as SIGINT (REL-BGSTAB-009 AC-2).
//
// EVIDENCE STATUS. This file CHARACTERISES current behaviour; it does not assert
// desired behaviour. #88 says not to change the clear-trigger set without a browser
// observation, and that observation is still blocked (#81, #85). What this file
// establishes is narrower than the issue's question and wider than the code-path
// argument it was filed as:
//
//   established here  -- given the divergence state, Ctrl+C IS intercepted, SIGINT
//                        is NOT delivered, and the STALE text is what gets copied.
//                        Typing does not end the divergence.
//   NOT established   -- that a user can reach the divergence state with focus in
//                        the terminal. That is the focus question #7 got wrong
//                        three times, it needs a real browser, and nothing here
//                        speaks to it. This harness invokes the key handler
//                        directly, so focus is not modelled at all.
//
// CONTROLS. #88's own review note is that a probe whose control is silent cannot
// discriminate the experiment's silence, and that the control must share the arm's
// premises rather than merely the probe. Arms A and D below run in the same render,
// through the same handler, after the same right-click, and both return true. So
// the false results in B and C are a discriminating signal and not an absence.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  installTerminalViewModuleMocks,
  renderTerminalView,
  type FakeTerminalState,
} from './terminalViewHarness.ts';

const state: FakeTerminalState = {
  selection: '', keyHandler: null, dataHandler: null, writes: [], clearSelectionCalls: 0, pasted: [],
};
installTerminalViewModuleMocks(state, { sent: [] });

test('a saved right-click selection outlives the visible selection, and typing does not end it', async () => {
  const view = await renderTerminalView({ state });
  const xterm = document.querySelector('.xterm');
  assert.ok(xterm instanceof globalThis.HTMLElement, 'the terminal element is mounted');

  // The capture-phase mousedown listener lives on the component's own container,
  // so dispatching on the terminal element reaches it exactly as a real click does.
  const mouseDown = (button: number): void => {
    xterm.dispatchEvent(new globalThis.MouseEvent('mousedown', { bubbles: true, cancelable: true, button }));
  };
  const ctrlC = (): boolean => view.pressKey({ key: 'c', ctrlKey: true }).handlerResult;
  // Establishes the divergence: a selection exists, right-click saves it, then the
  // visible selection collapses. #88 notes the argument does not depend on WHAT
  // collapses it -- the saved ref outlives whatever does.
  const enterDivergentState = (): void => {
    state.selection = 'stale selection';
    mouseDown(2);
    state.selection = '';
  };

  // CONTROL A -- no selection anywhere. Ctrl+C must reach xterm, which owns SIGINT.
  state.selection = '';
  assert.equal(ctrlC(), true, 'control A: with no selection at all, Ctrl+C delegates to xterm');

  // ARM B -- the divergence itself.
  enterDivergentState();
  assert.equal(
    ctrlC(), false,
    'arm B: while a saved right-click selection outlives the visible one, Ctrl+C is intercepted',
  );

  // ARM C -- the sequence #88 describes: typing does not clear the saved selection.
  enterDivergentState();
  view.pressKey({ key: 'a' });
  view.pressKey({ key: 'b' });
  assert.equal(
    ctrlC(), false,
    'arm C: typing does not clear the saved selection, so Ctrl+C is still intercepted',
  );

  // CONTROL D -- left-click is one of the documented clear triggers, and it works.
  // Same render, same handler, same preceding right-click as B and C.
  enterDivergentState();
  mouseDown(0);
  assert.equal(ctrlC(), true, 'control D: a left click clears the saved selection and restores SIGINT');

  // The intercepted presses copied the selection the user can no longer see. This is
  // the user-visible consequence, separate from the missing SIGINT.
  await view.flush();
  assert.deepEqual(
    view.clipboardWrites, ['stale selection', 'stale selection'],
    'each intercepted Ctrl+C copied text that was no longer selected',
  );

  await view.unmount();
});
