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
  /**
   * Text is selected on the page (a path in the confirm row, an error line).
   * Copy and cut then mean the text, as everywhere else in the browser.
   */
  hasTextSelection?: boolean;
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
  const { event, focusedInSurface, selectionCount, hasTextSelection = false } = input;
  if (!focusedInSurface || event.altKey === true || event.repeat === true) {
    return IGNORE;
  }

  if (event.ctrlKey || event.metaKey) {
    switch (event.key.toLowerCase()) {
      case 'c':
        return selectionCount > 0 && !hasTextSelection ? { kind: 'copy' } : IGNORE;
      case 'x':
        return selectionCount > 0 && !hasTextSelection ? { kind: 'cut' } : IGNORE;
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

// Where selected text is something the user means to copy: the path bar (the
// path, its error line) and the confirm row (a path in a question, an error).
// Text over the rows is a drag that happened to select names; counting it
// would silently turn Ctrl+C on selected files into a text copy.
const EXPLORER_TEXT_REGION_SELECTOR = '.fx-pathbar-wrap, .fx-confirm-bar';

/** The parts of a DOM node the text-selection check reads; `Node` satisfies it. */
export interface TextSelectionNode {
  nodeType: number;
  parentElement: TextSelectionElement | null;
}

export interface TextSelectionElement extends TextSelectionNode {
  closest(selector: string): unknown;
}

/**
 * Whether the page's text selection is one Ctrl+C/X should copy as text
 * instead of acting on the selected files: not collapsed, its focus inside this
 * window's body, and inside the path bar or the confirm row.
 * @req FR-FEX-005
 */
export function isExplorerTextSelection(
  selection: { isCollapsed: boolean; focusNode: TextSelectionNode | null } | null,
  windowBody: { contains(node: TextSelectionNode | null): boolean } | null,
): boolean {
  if (selection === null || selection.isCollapsed || windowBody === null) return false;
  const node = selection.focusNode;
  if (node === null || !windowBody.contains(node)) return false;
  // A text node has no closest(); its parent element answers for it.
  const element = node.nodeType === 1 ? node as TextSelectionElement : node.parentElement;
  return element !== null && element.closest(EXPLORER_TEXT_REGION_SELECTOR) !== null;
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

export type PromptRowKind = 'confirm-delete' | 'decide' | 'name';

export interface PromptRowKeyAction {
  /** Always true: the row answers its own keys. */
  stopPropagation: true;
  /** What Escape settles the prompt with; null leaves it open. */
  resolve: 'cancel' | 'dismiss' | null;
}

/**
 * The in-window confirm row answers its own keys. Without the stop, a Delete or
 * Ctrl+V typed into the folder-name input bubbles to the window surface and
 * runs as a file operation on the selection. Escape backs out of a delete or a
 * name prompt; a job's question is only ever answered by a choice.
 * @req FR-FEX-005
 */
export function decidePromptRowKey(input: { promptKind: PromptRowKind; key: string }): PromptRowKeyAction {
  if (input.key !== 'Escape') return { stopPropagation: true, resolve: null };
  switch (input.promptKind) {
    case 'confirm-delete': return { stopPropagation: true, resolve: 'cancel' };
    case 'name': return { stopPropagation: true, resolve: 'dismiss' };
    case 'decide': return { stopPropagation: true, resolve: null };
  }
}
