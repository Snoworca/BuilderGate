// What happens when an editor window's close button is pressed.
//
// The two prompts are different questions rather than one question with a
// button greyed out: the ordinary one asks whether to save, and the other
// states that saving is impossible and asks whether to discard. Keeping them
// as separate branches is what stops the second from being built by disabling
// a choice in the first.
//
// The tab-closed behaviour this branches on -- the drop to `floating`, the
// clamped inherited rect, the disabled save path and this separate prompt --
// is stated definitively by CON-MDE-002; this module judges on top of it.
// @req FR-MDE-006
// @req CON-MDE-002

import { t } from '../../i18n/i18n.ts';
import type { MessageKey } from '../../i18n/i18n.ts';
import type { EditorWindowSaveOutcome } from './editorWindowSave.ts';

export type EditorWindowCloseChoice = 'save' | 'discard' | 'cancel';

/**
 * `none` is not a prompt that renders nothing -- it is the branch where no
 * prompt is drawn at all, so a clean window closes without one.
 * @req FR-MDE-006
 */
export type EditorWindowClosePrompt =
  | { kind: 'none' }
  | {
    kind: 'unsaved-changes' | 'cannot-save';
    title: string;
    message: string;
    choices: EditorWindowCloseChoice[];
    labels: Record<EditorWindowCloseChoice, string>;
  };

/** What the host does once the branch is resolved. */
export type EditorWindowCloseAction =
  | { kind: 'close' }
  | { kind: 'stay' }
  | { kind: 'save-then-close' };

const CHOICE_LABELS = {
  save: 'common.save',
  discard: 'editor.close.dontSave',
  cancel: 'common.cancel',
} as const satisfies Record<EditorWindowCloseChoice, MessageKey>;

const DISCARD_LABELS = {
  save: 'common.save',
  discard: 'common.close',
  cancel: 'common.cancel',
} as const satisfies Record<EditorWindowCloseChoice, MessageKey>;

function translateLabels(keys: Record<EditorWindowCloseChoice, MessageKey>): Record<EditorWindowCloseChoice, string> {
  return { save: t(keys.save), discard: t(keys.discard), cancel: t(keys.cancel) };
}

/**
 * Reads the branch off the two facts that decide it. Whether the bound tab is
 * still open is the caller's to determine -- it is the same question as whether
 * the tab resolves to a session, and asking it here would need the lookup.
 * @req FR-MDE-006
 */
export function decideEditorWindowClosePrompt(
  input: { dirty: boolean; tabClosed: boolean },
): EditorWindowClosePrompt {
  if (!input.dirty) {
    return { kind: 'none' };
  }

  if (input.tabClosed) {
    return {
      kind: 'cannot-save',
      title: t('editor.close.cannotSaveTitle'),
      message: t('editor.close.cannotSaveMessage'),
      choices: ['discard', 'cancel'],
      labels: translateLabels(DISCARD_LABELS),
    };
  }

  return {
    kind: 'unsaved-changes',
    title: t('editor.close.unsavedTitle'),
    message: t('editor.close.saveQuestion'),
    choices: ['save', 'discard', 'cancel'],
    labels: translateLabels(CHOICE_LABELS),
  };
}

/**
 * A choice the prompt does not offer resolves to staying open. Pressing Escape
 * on `ConfirmModal` produces a cancel, and a cancel is the safe answer for any
 * choice that reaches a branch that does not offer it.
 * @req FR-MDE-006
 */
export function resolveEditorWindowCloseChoice(
  prompt: EditorWindowClosePrompt,
  choice: EditorWindowCloseChoice,
): EditorWindowCloseAction {
  if (prompt.kind === 'none') {
    return { kind: 'close' };
  }

  if (!prompt.choices.includes(choice)) {
    return { kind: 'stay' };
  }

  if (choice === 'save') {
    return { kind: 'save-then-close' };
  }

  return choice === 'discard' ? { kind: 'close' } : { kind: 'stay' };
}

/**
 * The second half of the save branch. A write that failed leaves the window
 * open with its banner, so the user can retry rather than lose the body.
 * @req FR-MDE-006
 */
export function resolveEditorWindowSaveOnClose(
  outcome: EditorWindowSaveOutcome,
): EditorWindowCloseAction {
  return outcome.status === 'saved' ? { kind: 'close' } : { kind: 'stay' };
}
