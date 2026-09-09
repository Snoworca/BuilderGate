// Which window a Ctrl+S writes.
//
// DOM focus decides, and being topmost in the modeless stack deliberately does
// not. The two disagree exactly in the case the tray creates: a window restored
// from the tray is frontmost while the keyboard still belongs elsewhere, so
// gating on stack order would write a file the user was not looking at, and the
// bug only appears after a tray restore, which is late and hard to attribute.
//
// The editor's CodeMirror keymap registers no `Mod-s`, so nothing is taken away
// from it. Nothing is taken from the terminal either: a press that does not
// resolve to a focused window is left entirely alone, `preventDefault` included.
// @req FR-MDE-006

/** What the handler needs to know about one open window. */
export interface EditorWindowSaveShortcutWindow {
  /** The window's identity: the normalized absolute file path. */
  documentId: string;
  /** Whether DOM focus is inside this window's surface right now. */
  focused: boolean;
  /** Paint order in the modeless stack. Carried so it can be seen not to matter. */
  stackOrder: number;
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
