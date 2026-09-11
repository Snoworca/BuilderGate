// Which document a Ctrl+S writes.
//
// DOM focus decides. There is one editor window per workspace, so this is not
// choosing between windows any more -- it is keeping the press away from
// everything that is not the editor. A press that lands while the terminal
// holds the keyboard belongs to the terminal.
//
// The input is still a collection. The window puts exactly one entry in it, the
// active tab, so that the selection stays a decision the rule makes rather than
// something that falls out of there being a single candidate.
//
// The editor's CodeMirror keymap registers no `Mod-s`, so nothing is taken away
// from it. Nothing is taken from the terminal either: a press that does not
// resolve to a focused window is left entirely alone, `preventDefault` included.
// @req FR-MDE-006

/** What the handler needs to know about one candidate document. */
export interface EditorWindowSaveShortcutWindow {
  /** The document's identity: the normalized absolute file path. */
  documentId: string;
  /** Whether DOM focus is inside the editor window's surface right now. */
  focused: boolean;
}

/** The parts of a keyboard event the decision reads. `KeyboardEvent` satisfies it. */
export interface EditorWindowSaveShortcutEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  /** Windows raises AltGr as ctrl+alt, and that chord is a character, not a save. */
  altKey?: boolean;
  /** A held key repeats. One press is one save. */
  repeat?: boolean;
}

export type EditorWindowSaveShortcutDecision =
  | { kind: 'ignore' }
  | { kind: 'save'; documentId: string };

export interface EditorWindowSaveShortcutDeps {
  /** The open windows, read at press time so a tray restore is already in it. */
  listWindows: () => readonly EditorWindowSaveShortcutWindow[];
  save: (documentId: string) => void;
}

/**
 * @req FR-MDE-006
 */
export function decideEditorWindowSaveShortcut(
  input: {
    event: EditorWindowSaveShortcutEvent;
    windows: readonly EditorWindowSaveShortcutWindow[];
  },
): EditorWindowSaveShortcutDecision {
  const { event, windows } = input;

  if (event.key.toLowerCase() !== 's') {
    return { kind: 'ignore' };
  }
  if (!event.ctrlKey && !event.metaKey) {
    return { kind: 'ignore' };
  }
  if (event.altKey === true || event.repeat === true) {
    return { kind: 'ignore' };
  }

  const focused = windows.find((editorWindow) => editorWindow.focused);
  if (focused === undefined) {
    return { kind: 'ignore' };
  }

  return { kind: 'save', documentId: focused.documentId };
}

/**
 * `preventDefault` is called only on the press that actually saves, so the
 * browser's own save dialog is suppressed for the editor and left in place
 * everywhere else.
 * @req FR-MDE-006
 */
export function createEditorWindowSaveShortcutHandler(
  deps: EditorWindowSaveShortcutDeps,
): (event: EditorWindowSaveShortcutEvent & { preventDefault: () => void }) => void {
  return (event) => {
    const decision = decideEditorWindowSaveShortcut({
      event,
      windows: deps.listWindows(),
    });
    if (decision.kind === 'ignore') {
      return;
    }

    event.preventDefault();
    deps.save(decision.documentId);
  };
}
