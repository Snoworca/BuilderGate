// The pure decisions behind the editor window's left file-tree pane: how wide
// it is drawn, where its root sits, which right clicks open the window menu,
// whether it starts folded, and when its file shortcuts may take a key.
//
// Nothing here touches the DOM or React. The component and the hook read these
// answers, so the rules can be pinned by unit tests without a browser.
//
// @req FR-MDE-012
// @req FR-FEX-005

import type { ContextMenuItem } from '../ContextMenu/index.ts';

/** Width of a pane the user never resized, and what a double click restores. */
export const PANE_DEFAULT_WIDTH = 212;
/** Below this the tree rows stop being readable. */
export const PANE_MIN_WIDTH = 160;
/** The pane never takes more than this share of the window (design 9.1, decision 18). */
export const PANE_MAX_RATIO = 0.5;

/**
 * Clamps a width to [PANE_MIN_WIDTH, windowWidth * PANE_MAX_RATIO].
 *
 * When the window is so narrow that half of it is below the minimum, the 50%
 * cap wins: FR-MDE-012 states the cap as the requirement, and a pane wider than
 * half the window would leave the document too little room to edit in.
 * @req FR-MDE-012
 */
export function clampPaneDragWidth(width: number, windowWidth: number): number {
  const wanted = Number.isFinite(width) ? width : PANE_DEFAULT_WIDTH;
  const cap = Number.isFinite(windowWidth) && windowWidth > 0 ? windowWidth * PANE_MAX_RATIO : Infinity;
  return Math.min(Math.max(wanted, PANE_MIN_WIDTH), cap);
}

/**
 * @req FR-MDE-012
 */
export function resetPaneWidth(): number {
  return PANE_DEFAULT_WIDTH;
}

/**
 * The width to draw for a saved width in the current window. It never feeds
 * back into the saved value (AC-11): a window narrowed and widened again brings
 * the chosen width back instead of the clipped one.
 * @req FR-MDE-012
 */
export function renderPaneWidth(savedWidth: number, windowWidth: number): number {
  return clampPaneDragWidth(savedWidth, windowWidth);
}

/**
 * The width after a drag, which is also what gets saved. It stops at the cap,
 * so an overshoot is not remembered and cannot resurface in a wider window.
 * @req FR-MDE-012
 */
export function applyPaneDrag(startWidth: number, delta: number, windowWidth: number): number {
  return clampPaneDragWidth(startWidth + delta, windowWidth);
}

export interface PaneRootInput {
  /** What the pane showed last, or null on its first showing. */
  previous: { sessionId: string; root: string } | null;
  /** The session the active tab is bound to. */
  sessionId: string;
  sessionCwd: string;
}

/**
 * The pane's root (AC-5): the active tab's session directory, except that a
 * root the user moved inside the tree is kept for as long as the active tab
 * stays on the same session. Only a change of session re-roots it.
 * @req FR-MDE-012
 */
export function resolvePaneRoot({ previous, sessionId, sessionCwd }: PaneRootInput): string {
  if (previous !== null && previous.sessionId === sessionId) return previous.root;
  return sessionCwd;
}

export type EditorWindowMenuTarget =
  | 'tabbar-empty'
  | 'titlebar-empty'
  | 'tab'
  | 'document'
  | 'titlebar-button';

/**
 * Where a right click opens the editor window's menu (AC-2): only the empty
 * parts of the tab bar and the titlebar. The document keeps the browser's own
 * copy/paste/spelling menu, which is in real use in an editor.
 * @req FR-MDE-012
 */
export function isEditorWindowMenuTarget(target: EditorWindowMenuTarget): boolean {
  return target === 'tabbar-empty' || target === 'titlebar-empty';
}

/**
 * The editor window's menu. The '파일 트리' item stays while the pane is open
 * and carries a check mark then (AC-4). The mark is the `icon`, because
 * ContextMenu renders `icon` and has no checked field of its own.
 * @req FR-MDE-012
 */
export function buildEditorWindowContextMenu(input: {
  paneOpen: boolean;
  onTogglePane: () => void;
}): ContextMenuItem[] {
  return [
    {
      label: '파일 트리',
      onClick: input.onTogglePane,
      ...(input.paneOpen ? { icon: '✓' } : {}),
    },
  ];
}

/**
 * Whether the pane starts folded (AC-13): always on a phone, where it would
 * cover the document; otherwise what the workspace remembered.
 * @req FR-MDE-012
 */
export function paneInitiallyCollapsed(input: { isMobile: boolean; savedCollapsed: boolean }): boolean {
  return input.isMobile || input.savedCollapsed;
}

/**
 * Whether choosing an item folds the pane again. On a phone the pane floats
 * over the document, so it gets out of the way once it has done its job.
 * @req FR-MDE-012
 */
export function collapseAfterOpen(isMobile: boolean): boolean {
  return isMobile;
}

/** Anything with Node.contains semantics: a node contains itself and its descendants. */
export interface PaneFocusNode {
  contains(other: unknown): boolean;
}

/**
 * `focusedInSurface` for the pane's file shortcuts (FR-FEX-005 AC-7, FR-MDE-012
 * AC-9). The surface is the tree pane, not the window: scoped to the window, a
 * Delete typed in the CodeMirror document would delete the selected file.
 * The document check is kept even though the pane does not contain it, so a
 * future layout that nests them still leaves the document's keys alone.
 * @req FR-FEX-005
 * @req FR-MDE-012
 */
export function decidePaneShortcutFocus(input: {
  pane: PaneFocusNode | null;
  document: PaneFocusNode | null;
  active: unknown;
}): boolean {
  const { pane, document, active } = input;
  if (pane === null || active === null || active === undefined) return false;
  if (document !== null && document.contains(active)) return false;
  return pane.contains(active);
}
