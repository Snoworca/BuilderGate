// The file operations of a file tree surface — the context menu, copy/cut,
// paste, delete, inline rename, new folder, refresh and the keyboard shortcuts —
// in one place, so the explorer window's tab panel and the editor window's
// tree pane run the same code path (FR-MDE-012 AC-8). What differs between the
// two is passed in: which menu entries exist (context), where a confirm is
// asked, where a folder name is asked and an error shown, and whether a folder
// can open in a new tab.
//
// Jobs are handed to the app-wide store as soon as the server accepted them,
// tagged with the surface's origin, so the window of that workspace can ask the
// job's questions and show its failure after this surface is gone.
//
// @req FR-MDE-012
// @req FR-FEX-005
// @req FR-FEX-022
// @req FR-FEX-025
// @req FR-FEX-027
// @req FR-FEX-029
// @req FR-FEX-030

import { t } from '../i18n/i18n.ts';
import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  copySelection,
  cutSelection,
  getFileExplorerClipboard,
  subscribeFileExplorerClipboard,
} from '../components/fileExplorer/fileExplorerClipboard.ts';
import {
  buildFileExplorerContextMenuItems,
  type FileExplorerMenuHandlers,
  type FileExplorerMenuInfo,
} from '../components/fileExplorer/fileExplorerContextMenu.ts';
import type { ConfirmPort } from '../components/fileExplorer/fileExplorerPorts.ts';
import type { FileExplorerShortcutDecision } from '../components/fileExplorer/fileExplorerShortcuts.ts';
import { pasteFromClipboard, requestDelete, type FileJobRequest } from '../components/fileExplorer/fileJobClient.ts';
import type { PasteJobRequest } from '../components/fileExplorer/fileExplorerClipboard.ts';
import { dispatchFileJob } from '../components/fileExplorer/fileJobStore.ts';
import { startFileDownload } from '../components/fileExplorer/fileDownload.ts';
import { isOpenableFile } from '../components/fileExplorer/fileRowInteraction.ts';
import { joinChildPath, parentPathOf } from '../components/fileExplorer/fileTreeState.ts';
import type { FileExplorerMenuRequest, FileRowRename } from '../components/fileExplorer/FileTreeView.tsx';
import { fileApi, fileJobApi, fileTransferApi } from '../services/api.ts';
import { extractRefusalMessage, isExtractableArchive, runExtract, type ExtractMode, type ExtractPrecount } from '../components/fileExplorer/fileExtract.ts';
import type { NewFileRequest } from '../components/fileExplorer/NewFileDialog.tsx';
import type { UseFileTreeResult } from './useFileTree.ts';
import { useInlineRename } from './useInlineRename.ts';

export type FileTreeShortcutAction = Exclude<FileExplorerShortcutDecision, { kind: 'ignore' }>;

export interface UseFileTreeOperationsInput {
  sessionId: string;
  tree: UseFileTreeResult;
  /** The open menu, or null. Menu actions target what it was opened on. */
  menu: FileExplorerMenuRequest | null;
  context: FileExplorerMenuInfo['context'];
  /** Asks the delete confirm; the surface decides where it is drawn. */
  confirm: ConfirmPort;
  askName: (label: string, initial: string) => Promise<string | null>;
  showError: (message: string) => void;
  onOpenFile: (filePath: string) => void;
  /** Only a surface with tabs can open a folder in a new one. */
  onNewTab?: (path: string) => void;
  /** FR-FEX-018: open the information modal for a path. */
  onShowInfo?: (path: string) => void;
  /**
   * FR-FEX-029: opens the 새 파일 window; resolves with the created name or null. Only a
   * surface that hosts the window passes it, and only there does the menu show 새 파일.
   */
  askNewFile?: (request: NewFileRequest) => Promise<string | null>;
  /** Where a submitted job belongs, so its window can ask its questions. */
  origin: { workspaceId: string; tabId: string };
  /**
   * FR-FEX-022 / FR-FEX-025: a surface that uploads and downloads ZIPs (the explorer window).
   * Without it the menu has no upload entries and downloads one file at a time.
   */
  transfer?: {
    /** Opens the picker for `dir`; `folder` picks a whole folder. */
    onUpload: (dir: string, folder: boolean) => void;
    onDownloadZip: (paths: string[]) => void;
    folderUploadSupported: boolean;
    /** FR-FEX-027 AC-5: the confirm row before a large archive; true on 풀기. */
    confirmExtract: (summary: ExtractPrecount) => Promise<boolean>;
    /** An extraction is about to start from this surface. */
    onExtractStart?: () => void;
  };
}

export interface FileTreeOperations {
  menuHandlers: FileExplorerMenuHandlers;
  menuItems: ReturnType<typeof buildFileExplorerContextMenuItems>;
  runShortcut: (action: FileTreeShortcutAction) => void;
  rowRename: FileRowRename | null;
  /** Asks a folder name and creates it inside `directory`. */
  createDirectoryIn: (directory: string) => Promise<void>;
  /** FR-FEX-030: submits the move or copy a drop built, as paste submits its job. */
  /** FR-FEX-033: the job's id once the server took it, or null when it was refused. */
  submitDrop: (request: PasteJobRequest) => Promise<string | null>;
}

function lastSegment(path: string): string {
  const parts = path.split(/[\\/]/).filter((part) => part !== '');
  return parts[parts.length - 1] ?? path;
}

// Joined with the parent's own separator and never doubled, as the tree joins
// its children, so the new path is spelled like the rows around it.
function childPath(parent: string, name: string): string {
  if (parent.endsWith('/') || parent.endsWith('\\')) return parent + name;
  return parent + (parent.includes('\\') ? '\\' : '/') + name;
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message !== '' ? error.message : String(error);
}

export function useFileTreeOperations({
  sessionId,
  tree,
  menu,
  context,
  confirm,
  askName,
  showError,
  onOpenFile,
  onNewTab,
  onShowInfo,
  askNewFile,
  origin,
  transfer,
}: UseFileTreeOperationsInput): FileTreeOperations {
  const { state } = tree;
  // The controller's functions are stable for a session, so callbacks depend on
  // them rather than on the tree result, which changes with every state update.
  const { applyJobDone, deselect } = tree;
  const clipboard = useSyncExternalStore(subscribeFileExplorerClipboard, getFileExplorerClipboard);
  const { workspaceId, tabId } = origin;

  // The job is handed to the store as soon as the server accepted it. A done or
  // a question that beat the POST's reply is held by the store until then.
  const jobClient = useMemo(() => ({
    submit: async (request: FileJobRequest) => {
      const result = await fileJobApi.submit(request);
      dispatchFileJob({
        type: 'JOB_STARTED',
        jobId: result.jobId,
        sessionId: request.sourceSessionId,
        origin: { workspaceId, tabId },
        operation: request.operation,
        ...(request.operation === 'extract' ? { destPath: request.destPath } : {}),
      });
      return result;
    },
  }), [tabId, workspaceId]);

  const renamingPathRef = useRef<string | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);

  // The inline editor commits on Enter and again on blur; the ref makes the
  // second commit a no-op.
  const commitRename = useCallback(async (name: string) => {
    const source = renamingPathRef.current;
    renamingPathRef.current = null;
    setRenamingPath(null);
    if (source === null || name === lastSegment(source)) return;
    if (/[\\/]/.test(name)) {
      showError(t('fileOps.error.separator'));
      return;
    }
    const parent = parentPathOf(source);
    try {
      await fileApi.moveFile(sessionId, source, childPath(parent, name));
      await applyJobDone([parent]);
    } catch (error) {
      showError(t('fileOps.error.rename', { message: messageOf(error) }));
    }
  }, [applyJobDone, showError, sessionId]);

  const rename = useInlineRename({
    onRename: (name) => {
      void commitRename(name);
    },
  });

  const { startEdit } = rename;
  const beginRename = useCallback((path: string) => {
    renamingPathRef.current = path;
    setRenamingPath(path);
    startEdit(lastSegment(path));
  }, [startEdit]);

  const rowRename: FileRowRename | null = rename.isEditing && renamingPath !== null
    ? {
        path: renamingPath,
        editName: rename.editName,
        inputRef: rename.inputRef,
        handleChange: rename.handleChange,
        // Escape unmounts the focused input, and Chromium then fires blur, which
        // the hook commits; dropping the target first makes that commit a no-op.
        handleKeyDown: (event) => {
          if (event.key === 'Escape') renamingPathRef.current = null;
          rename.handleKeyDown(event);
        },
        handleBlur: rename.handleBlur,
      }
    : null;

  const createDirectoryIn = async (directory: string) => {
    const name = await askName(t('fileOps.newFolder.prompt'), t('fileOps.newFolder.default'));
    if (name === null) return;
    if (/[\\/]/.test(name)) {
      showError(t('fileOps.error.separator'));
      return;
    }
    try {
      await fileApi.createDirectory(sessionId, directory, name);
      await applyJobDone([directory]);
    } catch (error) {
      showError(t('fileOps.error.mkdir', { message: messageOf(error) }));
    }
  };

  // Menu actions act on the selection, which the view settled before opening
  // the menu; handlers are rebuilt every render, so this is the selection on
  // screen. A menu opened on a directory row pastes and creates inside it;
  // everywhere else the folder being shown is the target.
  const selectedPaths = () => [...state.selectedPaths];
  // What a selected path is, read from its parent's listing; null when that is not loaded.
  const entryTypeOf = (path: string) => {
    const parent = state.childrenByPath.get(parentPathOf(path));
    if (parent?.status !== 'loaded') return null;
    return parent.entries.find((entry) => joinChildPath(parentPathOf(path), entry.name) === path)?.type ?? null;
  };
  const targetDirectory = menu !== null && menu.target === 'item' && menu.isDir && menu.path !== null ? menu.path : state.root;

  // FR-FEX-027 AC-1: the one selected file, when its name is an archive's.
  const selectedArchive = (): string | null => {
    const paths = selectedPaths();
    const path = menu?.target === 'item' && menu.path && !menu.isDir && paths.length <= 1 ? menu.path : paths.length === 1 ? paths[0] : null;
    if (path === null || !isExtractableArchive(lastSegment(path))) return null;
    return menu?.path === path || entryTypeOf(path) === 'file' ? path : null;
  };
  const startExtract = (mode: ExtractMode) => {
    const archive = selectedArchive();
    if (archive === null || transfer === undefined) return;
    transfer.onExtractStart?.();
    runExtract({ sessionId, archive, mode }, {
      precount: fileTransferApi.extractPrecount,
      confirm: transfer.confirmExtract,
      submit: (request) => jobClient.submit(request),
    }).then((result) => {
      // FR-FOP-007: an archive the server will not extract says why; no job was sent.
      if (result !== null && 'refused' in result) showError(extractRefusalMessage(result.refused));
    }).catch((error: unknown) => showError(t('fileTransfer.extract.failed', { message: messageOf(error) })));
  };

  const menuHandlers: FileExplorerMenuHandlers = {
    open: () => {
      if (!menu?.path) return;
      // FR-UIDS-013 AC-4: a folder enters (list) or toggles open (tree), as its double click does.
      if (menu.isDir) {
        if (state.mode === 'list') void tree.setRoot(menu.path);
        else if (state.expandedPaths.has(menu.path)) tree.collapse(menu.path);
        else void tree.expand(menu.path);
        return;
      }
      onOpenFile(menu.path);
    },
    newtab: () => {
      if (menu?.path) onNewTab?.(menu.path);
    },
    // FR-FEX-021: the one file the menu was opened on, or the one selected (mobile bar).
    // FR-FEX-025 AC-1: several items or a directory go as one ZIP where the surface has it.
    download: () => {
      const paths = selectedPaths();
      const onMenuFile = menu?.target === 'item' && menu.path && !menu.isDir && paths.length <= 1 ? menu.path : null;
      const single = onMenuFile ?? (paths.length === 1 && entryTypeOf(paths[0]) === 'file' ? paths[0] : null);
      if (single === null) {
        if (transfer !== undefined && paths.length > 0) transfer.onDownloadZip(paths);
        else if (paths.length === 1) {
          startFileDownload(sessionId, paths[0])
            .catch((error: unknown) => showError(t('fileOps.error.download', { message: messageOf(error) })));
        }
        return;
      }
      startFileDownload(sessionId, single)
        .catch((error: unknown) => showError(t('fileOps.error.download', { message: messageOf(error) })));
    },
    // FR-FEX-027 AC-2/AC-3: next to the one archive selected.
    extract: () => startExtract('smart'),
    extractHere: () => startExtract('here'),
    // FR-FEX-022 AC-2: into the directory the menu was opened on, else the folder on screen.
    upload: () => {
      transfer?.onUpload(targetDirectory, false);
    },
    uploadFolder: () => {
      transfer?.onUpload(targetDirectory, true);
    },
    copy: () => {
      copySelection({ sessionId, paths: selectedPaths() });
    },
    cut: () => {
      cutSelection({ sessionId, paths: selectedPaths() });
    },
    paste: () => {
      // A second paste of the same clipboard while this one is in flight -- from
      // this surface or any other -- is refused inside pasteFromClipboard.
      pasteFromClipboard({ client: jobClient, target: { destSessionId: sessionId, destPath: targetDirectory } })
        .catch((error: unknown) => showError(t('fileOps.error.paste', { message: messageOf(error) })));
    },
    rename: () => {
      const paths = selectedPaths();
      if (paths.length === 1) beginRename(paths[0]);
    },
    delete: () => {
      // The selection leaves once the server has accepted the job, so a second
      // Delete or a copy cannot act on the same paths again, while a refused
      // POST leaves the files selected for a retry.
      requestDelete({ client: jobClient, confirm, selection: { sessionId, paths: selectedPaths() }, onAccepted: deselect })
        .catch((error: unknown) => showError(t('fileOps.error.delete', { message: messageOf(error) })));
    },
    // FR-FEX-029: the window makes the file itself, so a refusal keeps it open with the reason.
    newfile: () => {
      if (askNewFile === undefined) return;
      const directory = targetDirectory;
      const listing = state.childrenByPath.get(directory);
      const entries = listing?.status === 'loaded'
        ? listing.entries.map((entry) => ({ name: entry.name, type: entry.type === 'directory' ? 'directory' as const : 'file' as const }))
        : [];
      void askNewFile({
        directory,
        entries,
        create: async (name) => { await fileApi.createFile(sessionId, directory, name); },
      }).then(async (name) => {
        if (name !== null) await applyJobDone([directory]);
      });
    },
    newdir: () => {
      void createDirectoryIn(targetDirectory);
    },
    refresh: () => {
      void tree.refresh(targetDirectory);
    },
    info: () => {
      if (menu?.path) onShowInfo?.(menu.path);
    },
  };

  const menuItems = menu === null ? [] : buildFileExplorerContextMenuItems({
    target: menu.target,
    isDir: menu.isDir,
    openable: menu.target === 'item' && !menu.isDir && menu.path !== null && isOpenableFile(lastSegment(menu.path)),
    count: state.selectedPaths.size,
    clipboardEmpty: clipboard === null,
    mode: state.mode,
    context,
    uploadable: transfer !== undefined,
    folderUploadSupported: transfer?.folderUploadSupported ?? false,
    zipDownload: transfer !== undefined,
    uploadTargetName: menu.target === 'item' && menu.isDir && menu.path !== null ? lastSegment(menu.path) : null,
    archiveSelected: selectedArchive() !== null,
    newFile: askNewFile !== undefined,
  }, menuHandlers);

  const runShortcut = (action: FileTreeShortcutAction) => {
    switch (action.kind) {
      case 'copy': menuHandlers.copy(); break;
      case 'cut': menuHandlers.cut(); break;
      case 'paste': menuHandlers.paste(); break;
      case 'confirm-delete': menuHandlers.delete(); break;
      case 'rename': menuHandlers.rename(); break;
    }
  };

  const submitDrop = (request: PasteJobRequest): Promise<string | null> =>
    jobClient.submit(request).then(
      (result) => result.jobId,
      (error: unknown) => {
        showError(t('fileExplorer.drag.failed', { message: messageOf(error) }));
        return null;
      },
    );

  return { menuHandlers, menuItems, runShortcut, rowRename, createDirectoryIn, submitDrop };
}
