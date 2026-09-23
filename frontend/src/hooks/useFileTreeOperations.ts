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
import { dispatchFileJob } from '../components/fileExplorer/fileJobStore.ts';
import { isOpenableFile } from '../components/fileExplorer/fileRowInteraction.ts';
import { parentPathOf } from '../components/fileExplorer/fileTreeState.ts';
import type { FileExplorerMenuRequest, FileRowRename } from '../components/fileExplorer/FileTreeView.tsx';
import { fileApi, fileJobApi } from '../services/api.ts';
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
  /** Where a submitted job belongs, so its window can ask its questions. */
  origin: { workspaceId: string; tabId: string };
}

export interface FileTreeOperations {
  menuHandlers: FileExplorerMenuHandlers;
  menuItems: ReturnType<typeof buildFileExplorerContextMenuItems>;
  runShortcut: (action: FileTreeShortcutAction) => void;
  rowRename: FileRowRename | null;
  /** Asks a folder name and creates it inside `directory`. */
  createDirectoryIn: (directory: string) => Promise<void>;
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
  origin,
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
      showError('이름에 경로 구분자를 쓸 수 없습니다');
      return;
    }
    const parent = parentPathOf(source);
    try {
      await fileApi.moveFile(sessionId, source, childPath(parent, name));
      await applyJobDone([parent]);
    } catch (error) {
      showError(`이름을 바꾸지 못했습니다: ${messageOf(error)}`);
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
    const name = await askName('새 폴더 이름', '새 폴더');
    if (name === null) return;
    if (/[\\/]/.test(name)) {
      showError('이름에 경로 구분자를 쓸 수 없습니다');
      return;
    }
    try {
      await fileApi.createDirectory(sessionId, directory, name);
      await applyJobDone([directory]);
    } catch (error) {
      showError(`폴더를 만들지 못했습니다: ${messageOf(error)}`);
    }
  };

  // Menu actions act on the selection, which the view settled before opening
  // the menu; handlers are rebuilt every render, so this is the selection on
  // screen. A menu opened on a directory row pastes and creates inside it;
  // everywhere else the folder being shown is the target.
  const selectedPaths = () => [...state.selectedPaths];
  const targetDirectory = menu !== null && menu.target === 'item' && menu.isDir && menu.path !== null ? menu.path : state.root;

  const menuHandlers: FileExplorerMenuHandlers = {
    open: () => {
      if (menu?.path) onOpenFile(menu.path);
    },
    newtab: () => {
      if (menu?.path) onNewTab?.(menu.path);
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
        .catch((error: unknown) => showError(`붙여넣지 못했습니다: ${messageOf(error)}`));
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
        .catch((error: unknown) => showError(`삭제하지 못했습니다: ${messageOf(error)}`));
    },
    newdir: () => {
      void createDirectoryIn(targetDirectory);
    },
    refresh: () => {
      void tree.refresh(targetDirectory);
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

  return { menuHandlers, menuItems, runShortcut, rowRename, createDirectoryIn };
}
