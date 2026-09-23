// Which explorer action a key press means, following editorWindowSaveShortcut.ts:
// a pure decision over {event, focus} and a handler that calls preventDefault
// only when the decision is not 'ignore'.
//
// Focus is checked first and outranks every key. A press that lands outside the
// explorer surface is left entirely alone, preventDefault included -- above all
// Ctrl+C in a terminal, which must reach the shell as an interrupt (design 6.2,
// DR-16).
// @req FR-FEX-005

/** The parts of a keyboard event the decision reads. `KeyboardEvent` satisfies it. */
export interface FileExplorerShortcutEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  /** Windows raises AltGr as ctrl+alt, and that chord types a character. */
  altKey?: boolean;
  /** A held key repeats; one press is one paste or one delete prompt. */
  repeat?: boolean;
}

export type FileExplorerShortcutDecision =
  | { kind: 'ignore' }
  | { kind: 'copy' }
  | { kind: 'cut' }
  | { kind: 'paste' }
  | { kind: 'confirm-delete' }
  | { kind: 'rename' };

export interface FileExplorerShortcutContext {
  /** Whether DOM focus is inside this explorer window's surface right now. */
  focusedInSurface: boolean;
  selectionCount: number;
}

export interface FileExplorerShortcutInput extends FileExplorerShortcutContext {
  event: FileExplorerShortcutEvent;
}

export interface FileExplorerShortcutDeps {
  /** Read at press time so focus and selection are current. */
  getContext: () => FileExplorerShortcutContext;
  run: (decision: Exclude<FileExplorerShortcutDecision, { kind: 'ignore' }>) => void;
}

const IGNORE: FileExplorerShortcutDecision = { kind: 'ignore' };

/** @req FR-FEX-005 */
export function decideFileExplorerShortcut(input: FileExplorerShortcutInput): FileExplorerShortcutDecision {
  const { event, focusedInSurface, selectionCount } = input;
  if (!focusedInSurface || event.altKey === true || event.repeat === true) {
    return IGNORE;
  }

  if (event.ctrlKey || event.metaKey) {
    switch (event.key.toLowerCase()) {
      case 'c':
        return selectionCount > 0 ? { kind: 'copy' } : IGNORE;
      case 'x':
        return selectionCount > 0 ? { kind: 'cut' } : IGNORE;
      // Paste needs no selection: it targets the tab's directory.
      case 'v':
        return { kind: 'paste' };
      default:
        return IGNORE;
    }
  }

  // Delete confirms over the whole selection; F2 renames exactly one item.
  if (event.key === 'Delete') {
    return selectionCount > 0 ? { kind: 'confirm-delete' } : IGNORE;
  }
  if (event.key === 'F2') {
    return selectionCount === 1 ? { kind: 'rename' } : IGNORE;
  }
  return IGNORE;
}

/**
 * preventDefault only on a press the explorer takes, so everything else --
 * the terminal's Ctrl+C, a text field's Delete -- keeps its default.
 * @req FR-FEX-005
 */
export function createFileExplorerShortcutHandler(
  deps: FileExplorerShortcutDeps,
): (event: FileExplorerShortcutEvent & { preventDefault: () => void }) => void {
  return (event) => {
    const decision = decideFileExplorerShortcut({ event, ...deps.getContext() });
    if (decision.kind === 'ignore') {
      return;
    }
    event.preventDefault();
    deps.run(decision);
  };
}
