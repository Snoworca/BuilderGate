// The explorer's right-click menu and the mobile button row, as pure builders.
//
// One ordered constant (FILE_EXPLORER_MENU_ORDER) is filtered per surface; no
// surface keeps its own copy of the list. Items that do not apply are disabled,
// not hidden, so the menu keeps its shape (design 7). Openability arrives only
// as the `openable` input -- this module never judges file names itself.
// @req FR-FEX-006
// @req FR-FEX-005

import type { ContextMenuItem } from '../ContextMenu/index.ts';

export type FileExplorerMenuActionId =
  | 'open'
  | 'newtab'
  | 'copy'
  | 'cut'
  | 'paste'
  | 'rename'
  | 'delete'
  | 'newdir'
  | 'refresh';

export type FileExplorerMenuEntry = FileExplorerMenuActionId | 'sep';

export const FILE_EXPLORER_MENU_ORDER: readonly FileExplorerMenuEntry[] = Object.freeze([
  'open', 'newtab', 'sep',
  'copy', 'cut', 'paste', 'sep',
  'rename', 'delete', 'sep',
  'newdir', 'refresh',
] as const);

const LABELS: Record<FileExplorerMenuActionId, string> = {
  open: '편집기로 열기',
  newtab: '새 탭에서 열기',
  copy: '복사',
  cut: '잘라내기',
  paste: '붙여넣기',
  rename: '이름 바꾸기',
  delete: '삭제',
  newdir: '새 폴더',
  refresh: '새로 읽기',
};

const SHORTCUTS: Partial<Record<FileExplorerMenuActionId, string>> = {
  copy: 'Ctrl+C',
  cut: 'Ctrl+X',
  paste: 'Ctrl+V',
  delete: 'Delete',
  rename: 'F2',
};

// On empty space there is nothing selected to act on, only the folder itself.
const EMPTY_SPACE_ACTIONS: ReadonlySet<FileExplorerMenuActionId> = new Set(['paste', 'newdir', 'refresh']);

export type FileExplorerMenuHandlers = Record<FileExplorerMenuActionId, () => void>;

export interface FileExplorerMenuInfo {
  /** Right click on a row, or on empty space in the view. */
  target: 'item' | 'empty';
  /** The clicked row is a directory (for 'empty': the folder being shown). */
  isDir: boolean;
  /** The clicked file can be opened in the editor; decided by the caller. */
  openable: boolean;
  /** Number of items the action would apply to. */
  count: number;
  clipboardEmpty: boolean;
  mode: 'tree' | 'list';
  context: 'explorer-window' | 'editor-panel';
}

export interface ContextMenuSelectionDecision {
  selectedPaths: Set<string>;
  targets: readonly string[];
}

/**
 * What a right click does to the selection (FR-FEX-006 AC-1~AC-3): a click on a
 * selected item keeps the whole selection as the target, a click on an
 * unselected item replaces it, a click on empty space clears it. The input set
 * is never mutated.
 */
export function decideContextMenuSelection(
  selected: ReadonlySet<string>,
  clickedPath: string | null,
): ContextMenuSelectionDecision {
  if (clickedPath === null) {
    return { selectedPaths: new Set(), targets: [] };
  }
  if (selected.has(clickedPath)) {
    return { selectedPaths: new Set(selected), targets: [...selected] };
  }
  return { selectedPaths: new Set([clickedPath]), targets: [clickedPath] };
}

function isActionEnabled(id: FileExplorerMenuActionId, info: FileExplorerMenuInfo): boolean {
  switch (id) {
    case 'open':
      return info.target === 'item' && !info.isDir && info.openable;
    case 'newtab':
      return info.target === 'item' && info.isDir && info.context === 'explorer-window';
    case 'paste':
      return !info.clipboardEmpty;
    case 'rename':
      return info.count === 1;
    case 'copy':
    case 'cut':
    case 'delete':
      return info.count > 0;
    case 'newdir':
    case 'refresh':
      return info.target === 'empty' || info.isDir;
  }
}

function isActionShown(id: FileExplorerMenuActionId, info: FileExplorerMenuInfo): boolean {
  if (info.target === 'empty') return EMPTY_SPACE_ACTIONS.has(id);
  if (id === 'newtab' && info.mode === 'list') return false;
  return true;
}

/** Drops leading, trailing and doubled separators left behind by filtering. */
function tidySeparators(entries: readonly FileExplorerMenuEntry[]): FileExplorerMenuEntry[] {
  const out: FileExplorerMenuEntry[] = [];
  for (const entry of entries) {
    if (entry === 'sep' && (out.length === 0 || out[out.length - 1] === 'sep')) continue;
    out.push(entry);
  }
  while (out.length > 0 && out[out.length - 1] === 'sep') out.pop();
  return out;
}

export function buildFileExplorerContextMenuItems(
  info: FileExplorerMenuInfo,
  handlers: FileExplorerMenuHandlers,
): ContextMenuItem[] {
  const entries = tidySeparators(
    FILE_EXPLORER_MENU_ORDER.filter(entry => entry === 'sep' || isActionShown(entry, info)),
  );
  return entries.map((entry): ContextMenuItem => {
    if (entry === 'sep') return { separator: true };
    const shortcut = SHORTCUTS[entry];
    return {
      label: LABELS[entry],
      onClick: handlers[entry],
      disabled: !isActionEnabled(entry, info),
      ...(shortcut !== undefined ? { shortcut } : {}),
      ...(entry === 'delete' ? { destructive: true } : {}),
    };
  });
}

export type MobileActionId = 'copy' | 'cut' | 'paste' | 'delete' | 'rename' | 'newdir';

export interface MobileActionButton {
  /** One of MobileActionId; typed as string so callers can key maps by plain ids. */
  id: string;
  label: string;
  disabled: boolean;
  onClick: () => void;
}

const MOBILE_ACTION_ORDER: readonly MobileActionId[] = ['copy', 'cut', 'paste', 'delete', 'rename', 'newdir'];

/**
 * The mobile button row (FR-FEX-005 AC-8). It shares the menu's predicates: the
 * row always stands for the folder being shown, so `newdir` is always enabled.
 */
export function buildMobileActionButtons(
  info: { count: number; clipboardEmpty: boolean },
  handlers: Pick<FileExplorerMenuHandlers, MobileActionId>,
): MobileActionButton[] {
  const menuInfo: FileExplorerMenuInfo = {
    target: 'item',
    isDir: true,
    openable: false,
    count: info.count,
    clipboardEmpty: info.clipboardEmpty,
    mode: 'list',
    context: 'explorer-window',
  };
  return MOBILE_ACTION_ORDER.map(id => ({
    id,
    label: LABELS[id],
    disabled: !isActionEnabled(id, menuInfo),
    onClick: handlers[id],
  }));
}
