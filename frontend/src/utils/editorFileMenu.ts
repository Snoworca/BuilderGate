// The three agent instruction files the session path bar offers, and the key
// that decides whether choosing one opens a window or revives the one that is
// already there.
//
// This lives beside contextMenuBuilder.ts rather than inside it. That module is
// covered by the FR-ARCH-004 through FR-ARCH-006 contracts, which are
// Stability=stable, and putting these items in it would put this work inside
// those contracts for no gain -- the items share no shape with the terminal menu
// and read none of its inputs.
// @req FR-MDE-007

import type { ContextMenuItem } from '../components/ContextMenu/ContextMenu';

/**
 * Uppercase exactly as written: these are the names the tools read off disk, so
 * a lowercased spelling would open a different file, or none.
 * @req FR-MDE-007
 */
export const EDITOR_INSTRUCTION_FILES = [
  'CLAUDE.md',
  'CLAUDE.local.md',
  'AGENTS.md',
] as const;

export type EditorInstructionFile = typeof EDITOR_INSTRUCTION_FILES[number];

/** A window that is already open, as the duplicate check reads it. */
export interface OpenEditorWindow {
  tabId: string;
  /** The resolved absolute path, as `resolveEditorFilePath` produced it. */
  filePath: string;
}

/**
 * What choosing an item means. `revive` carries the tab of the window that is
 * already open, not the tab that was right-clicked, so the window stays bound to
 * whichever tab first opened it.
 * @req FR-MDE-007
 */
export type EditorFileMenuSelection =
  | { kind: 'revive'; filePath: string; tabId: string }
  | { kind: 'open'; filePath: string; tabId: string };

export interface EditorFileMenuSelectionInput {
  /** The path the row displays, which is `tab.cwd` and is absolute. */
  cwd: string;
  fileName: string;
  /** The tab whose path bar was right-clicked. */
  tabId: string;
  openWindows: readonly OpenEditorWindow[];
}

export interface EditorFileMenuOptions {
  cwd: string;
  tabId: string;
  openWindows: readonly OpenEditorWindow[];
  onSelect: (selection: EditorFileMenuSelection) => void;
  /**
   * Opens the file explorer for the right-clicked tab. Optional so a caller
   * that has not been wired for the explorer still gets the three files alone.
   * @req FR-FEX-010
   */
  onOpenFileExplorer?: (tabId: string) => void;
}

/**
 * The duplicate key: the file name resolved against the displayed cwd, with the
 * separators unified and any trailing one dropped.
 *
 * `pathUtils.joinPath` is not used here because it infers the separator from
 * whatever the string happens to contain -- `C:/Work` and `C:\Work` would join
 * differently and produce two keys for one directory, which is exactly what this
 * normalization exists to prevent. Symbolic links are resolved only on the
 * server (`pathValidator.ts:61-67`), so the key stops at normalization and two
 * linked directories still yield two windows.
 * @req FR-MDE-007
 */
export function resolveEditorFilePath(cwd: string, fileName: string): string {
  const separator = /^[A-Za-z]:/.test(cwd) || cwd.includes('\\') ? '\\' : '/';
  const base = cwd.replace(/[\\/]+/g, separator).replace(/[\\/]+$/, '');

  return `${base}${separator}${fileName}`;
}

/**
 * Whether choosing this file opens a window or revives one.
 *
 * The key is the resolved absolute path alone. Keyed by the pair of tab and
 * path, two tabs sharing a `cwd` -- ordinary in this product -- would each get
 * their own window onto one file on disk, and since save conflicts are
 * deliberately not detected the second save would erase the first window's work
 * without saying so.
 * @req FR-MDE-007
 */
export function decideEditorFileMenuSelection(
  input: EditorFileMenuSelectionInput,
): EditorFileMenuSelection {
  const filePath = resolveEditorFilePath(input.cwd, input.fileName);
  const existing = input.openWindows.find(editorWindow => editorWindow.filePath === filePath);

  return existing === undefined
    ? { kind: 'open', filePath, tabId: input.tabId }
    : { kind: 'revive', filePath, tabId: existing.tabId };
}

/**
 * Whether a failed read means the file is simply not there.
 *
 * The read goes out through `fileApi`, whose `parseError` throws a
 * message-only `Error` -- the HTTP status does not survive it. What does
 * survive is the server's error code, because `parseApiErrorPayload` appends it
 * to the message whenever it differs from the message text. `PATH_NOT_FOUND` is
 * the code `FileService` raises for a path that does not exist, and it is the
 * only channel this side has for telling "create it?" apart from "something
 * went wrong".
 *
 * Reading a code out of a message is the wrong shape for this, and the right
 * fix is for `api.ts` to carry the status on the thrown error. That file is not
 * this task's to change, so the rule is named and tested here rather than
 * spelled inline at the call site.
 * @req FR-MDE-007
 */
export function isMissingFileError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');

  return /\bPATH_NOT_FOUND\b/.test(message);
}

/**
 * The tab whose path bar was right-clicked, and only if it has a path to
 * resolve against.
 *
 * The anchor is the right-clicked tab rather than the active one because grid
 * mode puts every tab on screen at once, so the tile under the pointer is
 * routinely not the active tile. A tab with no reported cwd yields nothing at
 * all: the menu resolves file names against that value, and an empty one would
 * resolve them against the filesystem root.
 * @req FR-MDE-007
 */
export function selectEditorPathMenuTab<TTab extends { id: string; cwd: string }>(
  tabs: readonly TTab[],
  tabId: string,
): TTab | null {
  const target = tabs.find(tab => tab.id === tabId);

  return target && target.cwd ? target : null;
}

/**
 * The three items, flat. No submenu is built, so FR-ARCH-001's depth limit of 5
 * is not approached, and `ContextMenu` needs no change to render them.
 *
 * The decision is taken when the item is chosen rather than when the menu is
 * built, so a window that opened or closed while the menu was up is still
 * accounted for.
 * @req FR-MDE-007
 */
export function buildEditorFileMenuItems(options: EditorFileMenuOptions): ContextMenuItem[] {
  const fileItems: ContextMenuItem[] = EDITOR_INSTRUCTION_FILES.map(fileName => ({
    label: fileName,
    onClick: () => options.onSelect(decideEditorFileMenuSelection({
      cwd: options.cwd,
      fileName,
      tabId: options.tabId,
      openWindows: options.openWindows,
    })),
  }));

  const { onOpenFileExplorer } = options;
  if (!onOpenFileExplorer) {
    return fileItems;
  }

  // The explorer goes first because EDITOR_INSTRUCTION_FILES can grow, and an
  // entry placed under it would drift down each time; the top stays put. It
  // opens for the right-clicked tab, which in grid mode is often not the active one.
  return [
    { label: '파일 탐색기', onClick: () => onOpenFileExplorer(options.tabId) },
    { separator: true },
    ...fileItems,
  ];
}
