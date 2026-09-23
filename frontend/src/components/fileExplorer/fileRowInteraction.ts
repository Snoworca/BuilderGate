// Pure decisions behind one explorer row: what a press, a click and a double
// click do, which files open, how a row is drawn and where a right click lands.
// Kept free of React and the DOM so every rule is testable without rendering;
// the components only translate events into these inputs and dispatch the result.
import { isViewableExtension } from '../../utils/viewableExtensions.ts';
import type { FileTreeMode, RowClickModifiers, VisibleRow } from './fileTreeState.ts';

export type NodeRow = Extract<VisibleRow, { kind: 'node' }>;

export type DoubleClickDecision =
  | { type: 'open-editor'; path: string }
  | { type: 'toggle-expand'; path: string }
  | { type: 'enter'; path: string }
  | { type: 'noop' };

export interface ExplorerClipboard {
  mode: 'copy' | 'cut';
  entries: { sessionId: string; path: string }[];
}

export interface RowPointerInput {
  button: number;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  // Not read: a non-primary press keeps the selection by never touching it, so
  // the answer is the same either way. Kept so callers pass the full press and
  // tests can pin that a selected row is not collapsed.
  isSelected: boolean;
}

export type RowPointerDecision = { type: 'noop' } | { type: 'select'; mods: RowClickModifiers };

export interface RowClickInput {
  targetPart: 'expander' | 'row';
  mode: FileTreeMode;
  isDir: boolean;
  mods: RowClickModifiers;
}

export type RowClickDecision = { type: 'toggle-expand' } | { type: 'select'; mods: RowClickModifiers };

// The subset of Element that resolution needs, so tests can pass a stand-in.
export interface ContextMenuTargetLike {
  closest(selector: string): { getAttribute(name: string): string | null } | null;
}

export type ContextMenuTarget = { kind: 'item'; path: string } | { kind: 'none' } | { kind: 'empty' };

// Delegated, never copied: the editor's own openable set is the single source,
// so a file the explorer offers to open is always one the editor can show.
export function isOpenableFile(name: string): boolean {
  return isViewableExtension(name);
}

export function decideDoubleClick(row: NodeRow, mode: FileTreeMode): DoubleClickDecision {
  if (row.type === 'directory') {
    // List mode has no expansion to show, so descending means changing the root.
    return mode === 'list' ? { type: 'enter', path: row.path } : { type: 'toggle-expand', path: row.path };
  }
  return isOpenableFile(row.name) ? { type: 'open-editor', path: row.path } : { type: 'noop' };
}

export function rowRenderClass(row: NodeRow, clipboard: ExplorerClipboard | null): string {
  const classes: string[] = [];
  // Directories have no extension either, but they always do something on
  // double click, so only files are dimmed.
  if (row.type === 'file' && !isOpenableFile(row.name)) classes.push('unopenable');
  // Matched by path alone: the row carries no session id, and the explorer shows
  // one session's tree at a time.
  if (clipboard?.mode === 'cut' && clipboard.entries.some((entry) => entry.path === row.path)) {
    classes.push('cut');
  }
  return classes.join(' ');
}

// '..' is navigation chrome, not an entry, so it has nothing to act on.
export function isContextMenuEligible(row: VisibleRow): boolean {
  return row.kind === 'node';
}

// A non-primary press must leave selection alone: right-clicking one row of a
// multi-selection would otherwise shrink it before the menu opens, and the menu
// path decides selection itself. Cmd plays Ctrl's role on macOS.
export function decideRowPointer(input: RowPointerInput): RowPointerDecision {
  if (input.button !== 0) return { type: 'noop' };
  return { type: 'select', mods: { ctrl: input.ctrlKey || input.metaKey, shift: input.shiftKey } };
}

// The expander only toggles, whatever modifiers are held; the row body only
// selects, even for a directory — expanding on a single click is reserved for
// the expander so selection never moves the tree.
export function decideRowClick(input: RowClickInput): RowClickDecision {
  if (input.targetPart === 'expander') return { type: 'toggle-expand' };
  return { type: 'select', mods: input.mods };
}

// Resolved through data attributes rather than classes so markup restyling
// cannot change which menu appears. A row wins over '..'; inside '..' there is
// no menu at all ('none'), and blank surface gets the directory menu ('empty').
export function resolveContextMenuTarget(target: ContextMenuTargetLike): ContextMenuTarget {
  const item = target.closest('[data-path]');
  if (item !== null) {
    // An empty data-path names no entry, so it falls through as if absent
    // rather than opening an item menu for path ''.
    const path = item.getAttribute('data-path');
    if (path !== null && path.length > 0) return { kind: 'item', path };
  }
  if (target.closest('[data-up]') !== null) return { kind: 'none' };
  return { kind: 'empty' };
}
