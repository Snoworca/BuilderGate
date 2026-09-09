import { useCallback, useId, useLayoutEffect, useState } from 'react';
import type { DialogMode } from './types';

export interface DialogStackEntry {
  token: string;
  dialogId: string;
  active: boolean;
}

export interface DialogStackState {
  layerIndex: number;
  isTopmost: boolean;
}

/**
 * What `useDialogStack` hands back: the state, plus the one action a dialog may
 * take on the stack.
 *
 * `raise` is bound to the caller's own token and the token itself never leaves
 * the hook. A caller given the raw token could bring some other dialog forward,
 * and nothing in the stack could tell that press apart from the dialog's own.
 *
 * The action rides on the hook's return rather than on `DialogStackState`
 * because that type is also what `createDialogStackState` computes, and that
 * function answers a question about order alone.
 * @req FR-MDE-003
 */
export interface DialogStackHandle extends DialogStackState {
  raise: () => void;
}

export interface DialogStackRegistration {
  token: string;
  dialogId: string;
  mode: DialogMode;
}

// One stack per mode. A modal's isTopmost is decided among modals only, so a
// modeless window that comes forward cannot switch off the modal's focus trap.
// @req FR-MDE-003
const stacks: Record<DialogMode, DialogStackEntry[]> = {
  modal: [],
  modeless: [],
};
const subscribers = new Set<() => void>();

export function createDialogStackState(
  stackEntries: DialogStackEntry[],
  token: string,
): DialogStackState {
  const activeEntries = stackEntries.filter(entry => entry.active);
  const layerIndex = activeEntries.findIndex(entry => entry.token === token);

  return {
    layerIndex: layerIndex < 0 ? 0 : layerIndex,
    isTopmost: layerIndex >= 0 && layerIndex === activeEntries.length - 1,
  };
}

// A snapshot, never the live array: callers compare before and after a raise.
// @req FR-MDE-003
export function getDialogStackEntries(mode: DialogMode): DialogStackEntry[] {
  return stacks[mode].slice();
}

// @req FR-MDE-003
export function registerDialogStackEntry({
  token,
  dialogId,
  mode,
}: DialogStackRegistration): () => void {
  const stack = stacks[mode];
  const entry: DialogStackEntry = { token, dialogId, active: true };

  stack.push(entry);
  notifySubscribers();

  // Removal is by identity, not by token: a disposer that searched by token
  // would drop whichever entry happens to carry that token first.
  return () => {
    const entryIndex = stack.indexOf(entry);
    if (entryIndex < 0) {
      return;
    }

    stack.splice(entryIndex, 1);
    notifySubscribers();
  };
}

// Moves the named entry to the end of its own stack. Front-to-back order is
// carried by this array alone; mount order stays at creation order so that a
// text selection drag started by the same press is not cut off.
// @req FR-MDE-003
export function raise(token: string): void {
  const found = findStackEntry(token);
  if (!found || found.index === found.stack.length - 1) {
    return;
  }

  const [entry] = found.stack.splice(found.index, 1);
  found.stack.push(entry);
  notifySubscribers();
}

/**
 * Brings the dialog registered under `dialogId` to the front of its own stack,
 * answering whether one was there to bring.
 *
 * Named by the id its host already knows, because the token never leaves
 * `useDialogStack`: a caller outside the dialog has no way to learn a token,
 * and handing tokens out would let any caller reorder any dialog. Answers
 * whether a dialog with that id was registered -- a window that has not mounted
 * yet is not in the stack.
 *
 * Modeless only, and by the parameter type rather than by a check: a modal's
 * order is the order its dialogs opened in and the topmost of them owns the
 * focus trap, so reordering that band would hand Escape and Tab containment to
 * a dialog the user only clicked past. `useDialogStack` refuses the same thing
 * at run time, where the mode is not known until then; here it is known while
 * the code is being written, so the wrong call does not compile.
 *
 * The search runs from the front, so where two dialogs share an id the one
 * already nearest the user is the one brought forward.
 * @req FR-MDE-003
 */
export function raiseDialogById(dialogId: string, mode: 'modeless'): boolean {
  const stack = stacks[mode];

  for (let index = stack.length - 1; index >= 0; index -= 1) {
    if (stack[index].dialogId === dialogId) {
      raise(stack[index].token);
      return true;
    }
  }

  return false;
}

// @req FR-MDE-003
export function subscribeDialogStack(subscriber: () => void): () => void {
  subscribers.add(subscriber);

  return () => {
    subscribers.delete(subscriber);
  };
}

export function useDialogStack(dialogId: string, mode: DialogMode): DialogStackHandle {
  const token = useId();
  const [state, setState] = useState<DialogStackState>(() => ({
    layerIndex: 0,
    isTopmost: false,
  }));

  useLayoutEffect(() => {
    const update = () => {
      setState(createDialogStackState(getDialogStackEntries(mode), token));
    };

    const unregister = registerDialogStackEntry({ token, dialogId, mode });
    const unsubscribe = subscribeDialogStack(update);
    update();

    return () => {
      unsubscribe();
      unregister();
    };
  }, [dialogId, mode, token]);

  // Stable across renders, so a listener that depends on it is installed once
  // rather than torn down and rebuilt every time the stack reorders.
  //
  // A modal never comes forward on a press. Its band is ordered by the order the
  // dialogs opened in and the topmost of them owns the focus trap, so a press
  // that reordered it would hand Escape and Tab containment to a dialog the user
  // only clicked past. The rule is enforced here rather than left to each caller
  // because `raise` reaches whichever stack holds the token, and a caller that
  // forgot to check would move the trap with nothing failing to say so.
  const raiseSelf = useCallback(() => {
    if (mode === 'modal') {
      return;
    }

    raise(token);
  }, [mode, token]);

  return {
    layerIndex: state.layerIndex,
    isTopmost: state.isTopmost,
    raise: raiseSelf,
  };
}

// The modes come from the stacks themselves, so a mode added to DialogMode is
// searched here without a second list having to be kept in step.
// @req FR-MDE-003
function findStackEntry(
  token: string,
): { stack: DialogStackEntry[]; index: number } | null {
  for (const mode of Object.keys(stacks) as DialogMode[]) {
    const stack = stacks[mode];
    const index = stack.findIndex(entry => entry.token === token);
    if (index >= 0) {
      return { stack, index };
    }
  }

  return null;
}

function notifySubscribers(): void {
  // Iterate a copy: a subscriber may register or dispose a dialog, which
  // changes the set while it is being walked.
  Array.from(subscribers).forEach(subscriber => subscriber());
}
