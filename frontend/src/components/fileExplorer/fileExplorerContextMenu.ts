// The explorer's right-click menu and the mobile button row, as pure builders.
//
// One ordered constant (FILE_EXPLORER_MENU_ORDER) is filtered per surface; no
// surface keeps its own copy of the list. Items that do not apply are disabled,
// not hidden, so the menu keeps its shape (design 7). Openability arrives only
// as the `openable` input -- this module never judges file names itself.
// @req FR-FEX-006
// @req FR-FEX-005
// @req FR-FEX-022
// @req FR-FEX-025
// @req FR-FEX-026
// @req FR-FEX-027
// @req FR-FEX-029

import { t, tn } from '../../i18n/i18n.ts';
import type { MessageKey } from '../../i18n/i18n.ts';
import type { ContextMenuItem } from '../ContextMenu/index.ts';
import type { IconName } from '../common/iconGlyphs.ts';
import { downloadButtonLabel } from './fileTransferModel.ts';

export type FileExplorerMenuActionId =
  | 'open'
  | 'newtab'
  | 'download'
  | 'upload'
  | 'uploadFolder'
  | 'extract'
  | 'extractHere'
  | 'copy'
  | 'cut'
  | 'paste'
  | 'rename'
  | 'delete'
  | 'newfile'
  | 'newdir'
  | 'refresh'
  | 'info';

export type FileExplorerMenuEntry = FileExplorerMenuActionId | 'sep';

export const FILE_EXPLORER_MENU_ORDER: readonly FileExplorerMenuEntry[] = Object.freeze([
  // FR-FEX-022 AC-2: the upload entries right after 다운로드, on an item and on empty space alike.
  // FR-FEX-027 AC-1: 압축 풀기 · 여기에 풀기, flat, right after them.
  'open', 'newtab', 'download', 'upload', 'uploadFolder', 'extract', 'extractHere', 'sep',
  'copy', 'cut', 'paste', 'sep',
  'rename', 'delete', 'sep',
  // FR-FEX-029 AC-1: 새 파일 directly above 새 폴더.
  'newfile', 'newdir', 'refresh', 'sep',
  // FR-FEX-018: always the last item of an entry's menu.
  'info',
] as const);

const LABELS: Record<FileExplorerMenuActionId, MessageKey> = {
  open: 'fileExplorer.menu.open',
  newtab: 'fileExplorer.menu.newTab',
  download: 'fileExplorer.menu.download',
  upload: 'fileExplorer.menu.upload',
  uploadFolder: 'fileExplorer.menu.uploadFolder',
  extract: 'fileExplorer.menu.extract',
  extractHere: 'fileExplorer.menu.extractHere',
  copy: 'common.copy',
  cut: 'fileExplorer.menu.cut',
  paste: 'common.paste',
  rename: 'common.rename',
  delete: 'common.delete',
  newfile: 'fileExplorer.menu.newFile',
  newdir: 'fileExplorer.menu.newFolder',
  refresh: 'fileExplorer.menu.reload',
  info: 'fileExplorer.menu.info',
};

const SHORTCUTS: Partial<Record<FileExplorerMenuActionId, string>> = {
  copy: 'Ctrl+C',
  cut: 'Ctrl+X',
  paste: 'Ctrl+V',
  delete: 'Delete',
  rename: 'F2',
};

// On empty space there is nothing selected to act on, only the folder itself.
const EMPTY_SPACE_ACTIONS: ReadonlySet<FileExplorerMenuActionId> = new Set(['paste', 'newfile', 'newdir', 'refresh']);
// FR-FEX-022 AC-2: on a surface that uploads, the transfer entries keep their place on empty space too.
const EMPTY_SPACE_TRANSFER_ACTIONS: ReadonlySet<FileExplorerMenuActionId> = new Set(['download', 'upload', 'uploadFolder', 'extract', 'extractHere']);

type UploadActionId = 'upload' | 'uploadFolder' | 'extract' | 'extractHere' | 'newfile';

/** Upload handlers exist only where the surface can upload (the explorer window). */
export type FileExplorerMenuHandlers = Record<Exclude<FileExplorerMenuActionId, UploadActionId>, () => void>
  & Partial<Record<UploadActionId, () => void>>;

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
  /** FR-FEX-022: the surface can upload; without it the upload entries are not shown. */
  uploadable?: boolean;
  /** FR-FEX-022 AC-3: feature detection, decided by the caller. */
  folderUploadSupported?: boolean;
  /** FR-FEX-022 AC-2: opened on a directory row, the upload goes into it and names it. */
  uploadTargetName?: string | null;
  /** FR-FEX-025 AC-1: several items or a directory download as one ZIP. */
  zipDownload?: boolean;
  /** FR-FEX-027 AC-1: the one selected item is a .zip, .tar, .tar.gz or .tgz file. */
  archiveSelected?: boolean;
  /** FR-FEX-029: the surface hosts the 새 파일 window; without it the entry is not shown. */
  newFile?: boolean;
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
    // FR-UIDS-013 AC-4: a folder opens from its menu too (enter in the list, expand in the
    // tree), since on a phone a double tap now opens this menu instead.
    case 'open':
      return info.target === 'item' && (info.isDir || info.openable);
    case 'newtab':
      return info.target === 'item' && info.isDir && info.context === 'explorer-window';
    // FR-FEX-021 AC-1: one file at a time; FR-FEX-025 AC-1: anything selected where ZIP exists.
    case 'download':
      if (info.zipDownload === true) return info.target === 'item' && info.count > 0;
      return info.target === 'item' && !info.isDir && info.count === 1;
    case 'upload':
      return true;
    case 'uploadFolder':
      return info.folderUploadSupported === true;
    case 'extract':
    case 'extractHere':
      return info.target === 'item' && !info.isDir && info.count === 1 && info.archiveSelected === true;
    case 'paste':
      return !info.clipboardEmpty;
    case 'rename':
      return info.count === 1;
    case 'copy':
    case 'cut':
    case 'delete':
      return info.count > 0;
    case 'newfile':
    case 'newdir':
    case 'refresh':
      return info.target === 'empty' || info.isDir;
    case 'info':
      return info.target === 'item';
  }
}

function isActionShown(id: FileExplorerMenuActionId, info: FileExplorerMenuInfo): boolean {
  if ((id === 'upload' || id === 'uploadFolder' || id === 'extract' || id === 'extractHere') && info.uploadable !== true) return false;
  if (id === 'newfile' && info.newFile !== true) return false;
  if (info.target === 'empty') return EMPTY_SPACE_ACTIONS.has(id) || (info.uploadable === true && EMPTY_SPACE_TRANSFER_ACTIONS.has(id));
  if (id === 'newtab' && info.mode === 'list') return false;
  // The editor window's side panel has no tabs to open into (FR-MDE-012 AC-8):
  // removed rather than disabled, since it could never become usable there.
  if (id === 'newtab' && info.context === 'editor-panel') return false;
  // FR-FEX-018: the modal lives in the explorer window; the editor side panel has no host for it.
  if (id === 'info' && info.context === 'editor-panel') return false;
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
    const disabled = !isActionEnabled(entry, info);
    const reason = entry === 'uploadFolder' && disabled ? t('fileExplorer.menu.folderUploadUnsupported') : null;
    return {
      label: labelOf(entry, info),
      onClick: handlers[entry] ?? (() => {}),
      disabled,
      ...(shortcut !== undefined ? { shortcut } : {}),
      ...(entry === 'delete' ? { destructive: true } : {}),
      ...(reason !== null ? { title: reason } : {}),
    };
  });
}

function labelOf(entry: FileExplorerMenuActionId, info: FileExplorerMenuInfo): string {
  if (entry === 'open' && info.target === 'item' && info.isDir) return t('fileExplorer.menu.openFolder');
  if (entry === 'upload' && info.target === 'item' && info.isDir && info.uploadTargetName) {
    return t('fileExplorer.menu.uploadInto', { name: info.uploadTargetName });
  }
  if (entry === 'download' && info.zipDownload === true && info.target === 'item') {
    return downloadButtonLabel({ count: info.count, singleFile: info.count === 1 && !info.isDir });
  }
  return t(LABELS[entry]);
}

// ---------------------------------------------------------------------------
// FR-FEX-026: the phone's four fixed slots and the 더보기 sheet. Both are judged by the menu's
// predicates through a menu info standing for the selection, so a phone never enables what the
// right-click menu would disable.

export type MobileSlotId = 'upload' | 'download' | 'paste' | 'more';

export interface MobileBarSlot {
  id: MobileSlotId;
  label: string;
  icon: IconName;
  disabled: boolean;
  onClick: () => void;
}

const MOBILE_SLOTS: readonly { id: MobileSlotId; label: MessageKey; icon: IconName }[] = [
  { id: 'upload', label: 'fileExplorer.mobileBar.upload', icon: 'upload' },
  { id: 'download', label: 'fileExplorer.menu.download', icon: 'archive' },
  { id: 'paste', label: 'common.paste', icon: 'clipboard' },
  { id: 'more', label: 'fileExplorer.mobileBar.more', icon: 'more' },
];

function selectionInfo(count: number, isDir: boolean, clipboardEmpty: boolean, folderUploadSupported: boolean, archiveSelected = false): FileExplorerMenuInfo {
  return {
    target: count > 0 ? 'item' : 'empty',
    isDir: count === 0 || isDir,
    openable: false,
    count,
    clipboardEmpty,
    mode: 'list',
    context: 'explorer-window',
    uploadable: true,
    folderUploadSupported,
    zipDownload: true,
    archiveSelected,
  };
}

/**
 * FR-FEX-026 AC-1: 업로드 · 다운로드 · 붙여넣기 · 더보기, never moving; disabled rather than hidden.
 * @req FR-FEX-026
 */
export function buildMobileBarSlots(
  input: { count: number; clipboardEmpty: boolean },
  handlers: Record<MobileSlotId, () => void>,
): MobileBarSlot[] {
  const info = selectionInfo(input.count, false, input.clipboardEmpty, false);
  const enabled: Record<MobileSlotId, boolean> = {
    upload: isActionEnabled('upload', info),
    download: isActionEnabled('download', info),
    paste: isActionEnabled('paste', info),
    more: true,
  };
  return MOBILE_SLOTS.map((slot) => ({
    id: slot.id,
    label: t(slot.label),
    icon: slot.icon,
    disabled: !enabled[slot.id],
    onClick: handlers[slot.id],
  }));
}

export type MoreSheetActionId = 'download' | 'upload' | 'uploadFolder' | 'extract' | 'extractHere' | 'copy' | 'cut' | 'paste' | 'rename' | 'newfile' | 'newdir' | 'info' | 'delete';

export interface MoreSheetItem {
  id: MoreSheetActionId;
  label: string;
  icon: IconName;
  disabled: boolean;
  /** One line under a disabled entry saying why (FR-FEX-022 AC-3). */
  reason: string | null;
  destructive: boolean;
  onClick: () => void;
}

// FR-FEX-026 AC-3: the menu order, with 삭제 alone at the bottom, away from the thumb.
const MORE_SHEET_ORDER: readonly (MoreSheetActionId | 'sep')[] = [
  'download', 'upload', 'uploadFolder', 'extract', 'extractHere', 'sep',
  'copy', 'cut', 'paste', 'sep',
  'rename', 'newfile', 'newdir', 'info', 'sep',
  'delete',
];

const SHEET_ICONS: Record<MoreSheetActionId, IconName> = {
  download: 'download',
  upload: 'upload',
  uploadFolder: 'folder-upload',
  extract: 'archive',
  extractHere: 'folder',
  copy: 'copy',
  cut: 'cut',
  paste: 'clipboard',
  rename: 'edit',
  newfile: 'document',
  newdir: 'folder',
  info: 'info',
  delete: 'trash',
};

/** @req FR-FEX-026 */
export function buildMobileMoreSheet(
  input: { count: number; isDir: boolean; clipboardEmpty: boolean; folderUploadSupported: boolean; archiveSelected?: boolean },
  handlers: Record<MoreSheetActionId, () => void>,
): (MoreSheetItem | 'sep')[] {
  const info = selectionInfo(input.count, input.isDir, input.clipboardEmpty, input.folderUploadSupported, input.archiveSelected === true);
  return MORE_SHEET_ORDER.map((id) => {
    if (id === 'sep') return 'sep';
    // The sheet always stands for the folder on screen, so a new folder or file always has a place.
    const disabled = id === 'newdir' || id === 'newfile' ? false : id === 'info' ? input.count !== 1 : !isActionEnabled(id, info);
    return {
      id,
      label: labelOf(id, info),
      icon: SHEET_ICONS[id],
      disabled,
      reason: id === 'uploadFolder' && disabled ? t('fileExplorer.menu.folderUploadUnsupported') : null,
      destructive: id === 'delete',
      onClick: handlers[id],
    };
  });
}

/** FR-FEX-026 AC-3: the sheet names its target — the item, the count, or the folder. */
export function mobileSheetTitle(input: { count: number; name: string | null; folder: string }): string {
  if (input.count === 1 && input.name !== null) return input.name;
  if (input.count > 1) return tn('fileTransfer.sheet.items', input.count);
  return input.folder;
}
