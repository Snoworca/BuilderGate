import { useCallback, useEffect, useRef, useState, useMemo } from 'react';
import { useFileBrowser } from '../../hooks/useFileBrowser';
import { useKeyboardNav } from '../../hooks/useKeyboardNav';
import { MdirHeader } from './MdirHeader';
import { MdirFileList } from './MdirFileList';
import { MdirFooter } from './MdirFooter';
import { FileOperationDialog } from './FileOperationDialog';
import type { DirectoryEntry } from '../../types';
import { joinPath } from '../../utils/pathUtils';
import { isViewableExtension } from '../../utils/viewableExtensions';
import './MdirPanel.css';

import type { PendingOp } from '../../hooks/useTabManager';

type DialogMode = 'delete' | 'mkdir' | null;

interface Props {
  sessionId: string;
  onOpenViewer: (filePath: string) => void;
  onEscToTerminal: () => void;
  onPathChange?: (path: string) => void;
  pendingOp?: PendingOp;
  setPendingOp?: (op: PendingOp) => void;
}

const NARROW_BREAKPOINT = 480;

export function MdirPanel({ sessionId, onOpenViewer, onEscToTerminal, onPathChange, pendingOp: externalPendingOp, setPendingOp: externalSetPendingOp }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);

  const [isNarrow, setIsNarrow] = useState(false);

  // Detect narrow viewport
  useEffect(() => {
    const check = () => setIsNarrow(window.innerWidth < NARROW_BREAKPOINT);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  // ── Shared state ──
  const [dialogMode, setDialogMode] = useState<DialogMode>(null);
  const [dialogTarget, setDialogTarget] = useState<DirectoryEntry | null>(null);

  // pendingOp: use external (shared across tabs) or fallback to local
  const [localPendingOp, setLocalPendingOp] = useState<PendingOp>(null);
  const pendingOp = externalPendingOp !== undefined ? externalPendingOp : localPendingOp;
  const setPendingOp = externalSetPendingOp || setLocalPendingOp;

  // Primary browser: used as narrow single-panel OR left panel in wide mode
  const primaryBrowser = useFileBrowser(sessionId);
  // Right browser: lazy init, only used in wide mode
  const rightBrowser = useFileBrowser(sessionId, null);

  const [activePane, setActivePane] = useState<0 | 1>(0);
  const rightLoaded = rightBrowser.entries.length > 0 || rightBrowser.loading;

  // Notify parent when primary path changes (for tab title)
  useEffect(() => {
    if (onPathChange && primaryBrowser.currentPath) {
      onPathChange(primaryBrowser.currentPath);
    }
  }, [primaryBrowser.currentPath, onPathChange]);

  // Derive which directory name is opened in right pane (for left pane marking)
  const openedDirName = useMemo(() => {
    if (isNarrow || !rightBrowser.currentPath) return null;
    const segments = rightBrowser.currentPath.split(/[/\\]/).filter(Boolean);
    return segments.length > 0 ? segments[segments.length - 1] : null;
  }, [isNarrow, rightBrowser.currentPath]);

  // ── Navigation handlers (wide mode) ──
  const handleEnterLeft = useCallback((entry: DirectoryEntry) => {
    if (entry.name === '..') {
      primaryBrowser.goUp();
      rightBrowser.clear();
      return;
    }
    if (entry.type === 'directory') {
      const dirPath = joinPath(primaryBrowser.currentPath, entry.name);
      rightBrowser.navigate(dirPath);
      setActivePane(1);
    } else {
      const filePath = joinPath(primaryBrowser.currentPath, entry.name);
      if (isViewableExtension(filePath)) onOpenViewer(filePath);
    }
  }, [primaryBrowser, rightBrowser, onOpenViewer]);

  const handleEnterRight = useCallback((entry: DirectoryEntry) => {
    if (entry.name === '..') {
      rightBrowser.clear();
      setActivePane(0);
      return;
    }
    if (entry.type === 'directory') {
      const dirPath = joinPath(rightBrowser.currentPath, entry.name);
      primaryBrowser.navigate(rightBrowser.currentPath);
      rightBrowser.navigate(dirPath);
    } else {
      const filePath = joinPath(rightBrowser.currentPath, entry.name);
      if (isViewableExtension(filePath)) onOpenViewer(filePath);
    }
  }, [primaryBrowser, rightBrowser, onOpenViewer]);

  // ── Narrow mode handler ──
  const handleEnterNarrow = useCallback((entry: DirectoryEntry) => {
    if (entry.name === '..') {
      primaryBrowser.goUp();
    } else if (entry.type === 'directory') {
      primaryBrowser.navigate(joinPath(primaryBrowser.currentPath, entry.name));
    } else {
      const filePath = joinPath(primaryBrowser.currentPath, entry.name);
      if (isViewableExtension(filePath)) onOpenViewer(filePath);
    }
  }, [primaryBrowser, onOpenViewer]);

  const handleEsc = useCallback(() => {
    if (pendingOp) {
      setPendingOp(null);
    } else {
      onEscToTerminal();
    }
  }, [pendingOp, onEscToTerminal]);

  // ── Keyboard nav (narrow) ──
  const narrowNavOptions = useMemo(() => ({
    onEnter: handleEnterNarrow,
    onEsc: handleEsc,
  }), [handleEnterNarrow, handleEsc]);

  const narrowNav = useKeyboardNav(primaryBrowser.entries, 1, narrowNavOptions);

  // ── Keyboard nav (wide - left panel) ──
  const leftNavOptions = useMemo(() => ({
    onEnter: handleEnterLeft,
    onEsc: handleEsc,
    onRight: () => { if (rightLoaded) setActivePane(1); },
  }), [handleEnterLeft, handleEsc, rightLoaded]);

  const leftNav = useKeyboardNav(primaryBrowser.entries, 1, leftNavOptions);

  // ── Keyboard nav (wide - right panel) ──
  const rightNavOptions = useMemo(() => ({
    onEnter: handleEnterRight,
    onEsc: handleEsc,
    onLeft: () => setActivePane(0),
  }), [handleEnterRight, handleEsc]);

  const rightNav = useKeyboardNav(rightBrowser.entries, 1, rightNavOptions);

  // ── Derived active-panel values ──
  const activeEntries = isNarrow
    ? primaryBrowser.entries
    : (activePane === 0 ? primaryBrowser.entries : rightBrowser.entries);
  const activeSelectedIndex = isNarrow
    ? narrowNav.selectedIndex
    : (activePane === 0 ? leftNav.selectedIndex : rightNav.selectedIndex);
  const activeSetSelectedIndex = isNarrow
    ? narrowNav.setSelectedIndex
    : (activePane === 0 ? leftNav.setSelectedIndex : rightNav.setSelectedIndex);
  const activePath = isNarrow
    ? primaryBrowser.currentPath
    : (activePane === 0 ? primaryBrowser.currentPath : rightBrowser.currentPath);
  const activeStats = isNarrow
    ? primaryBrowser.stats
    : (activePane === 0 ? primaryBrowser.stats : rightBrowser.stats);
  const activeCopyFile = isNarrow
    ? primaryBrowser.copyFile
    : (activePane === 0 ? primaryBrowser.copyFile : rightBrowser.copyFile);
  const activeMoveFile = isNarrow
    ? primaryBrowser.moveFile
    : (activePane === 0 ? primaryBrowser.moveFile : rightBrowser.moveFile);
  const activeDeleteFile = isNarrow
    ? primaryBrowser.deleteFile
    : (activePane === 0 ? primaryBrowser.deleteFile : rightBrowser.deleteFile);
  const activeCreateDirectory = isNarrow
    ? primaryBrowser.createDirectory
    : (activePane === 0 ? primaryBrowser.createDirectory : rightBrowser.createDirectory);
  const activeHandleEnter = isNarrow
    ? handleEnterNarrow
    : (activePane === 0 ? handleEnterLeft : handleEnterRight);

  // ── Copy/Move helpers ──
  const handleCopyOrMove = useCallback(async (mode: 'copy' | 'move') => {
    const entry = activeEntries[activeSelectedIndex];
    if (pendingOp && pendingOp.mode === mode) {
      const destination = joinPath(activePath, pendingOp.entryName);
      if (mode === 'copy') {
        await activeCopyFile(pendingOp.sourcePath, destination);
      } else {
        await activeMoveFile(pendingOp.sourcePath, destination);
      }
      setPendingOp(null);
    } else {
      if (entry && entry.name !== '..') {
        const sourcePath = joinPath(activePath, entry.name);
        setPendingOp({ mode, sourcePath, entryName: entry.name });
      }
    }
  }, [activeEntries, activeSelectedIndex, pendingOp, activePath, activeCopyFile, activeMoveFile]);

  const handlePaste = useCallback(async () => {
    if (!pendingOp) return;
    const destination = joinPath(activePath, pendingOp.entryName);
    if (pendingOp.mode === 'copy') {
      await activeCopyFile(pendingOp.sourcePath, destination);
    } else {
      await activeMoveFile(pendingOp.sourcePath, destination);
    }
    setPendingOp(null);
  }, [pendingOp, activePath, activeCopyFile, activeMoveFile]);

  const handleCopyPath = useCallback(() => {
    const entry = activeEntries[activeSelectedIndex];
    if (!entry) return;
    const fullPath = entry.name === '..' ? activePath : joinPath(activePath, entry.name);
    navigator.clipboard.writeText(fullPath);
  }, [activeEntries, activeSelectedIndex, activePath]);

  // ── F-key and auxiliary shortcut handling ──
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const entry = activeEntries[activeSelectedIndex];

      if (e.ctrlKey && e.shiftKey && e.key === 'C') {
        e.preventDefault(); handleCopyPath(); return;
      }
      if (e.ctrlKey && !e.shiftKey) {
        switch (e.key) {
          case 'c': e.preventDefault(); handleCopyOrMove('copy'); return;
          case 'x': e.preventDefault(); handleCopyOrMove('move'); return;
          case 'v': e.preventDefault(); handlePaste(); return;
          case 'n': e.preventDefault(); setDialogTarget(null); setDialogMode('mkdir'); return;
        }
      }
      if (e.key === 'Delete') {
        e.preventDefault();
        if (entry && entry.name !== '..') { setDialogTarget(entry); setDialogMode('delete'); }
        return;
      }

      switch (e.key) {
        case 'F2':
          e.preventDefault();
          handleCopyPath();
          break;
        case 'F3':
          e.preventDefault();
          if (entry && entry.type === 'file') {
            const filePath = joinPath(activePath, entry.name);
            if (isViewableExtension(filePath)) activeHandleEnter(entry);
          }
          break;
        case 'F5':
          e.preventDefault();
          handleCopyOrMove('copy');
          break;
        case 'F6':
          e.preventDefault();
          handleCopyOrMove('move');
          break;
        case 'F7':
          e.preventDefault();
          setDialogTarget(null);
          setDialogMode('mkdir');
          break;
        case 'F8':
          e.preventDefault();
          if (entry && entry.name !== '..') {
            setDialogTarget(entry);
            setDialogMode('delete');
          }
          break;
        default:
          return;
      }
    };

    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [activeEntries, activeSelectedIndex, activeHandleEnter, handleCopyOrMove, handleCopyPath, handlePaste]);

  // Auto-focus panel on mount
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  // Re-focus panel when dialog closes
  const closeDialog = useCallback(() => {
    setDialogMode(null);
    setDialogTarget(null);
    setTimeout(() => panelRef.current?.focus(), 50);
  }, []);

  const handleDialogConfirm = useCallback(async (data: { source?: string; destination?: string; path?: string; name?: string }) => {
    if (dialogMode === 'delete' && data.path) {
      await activeDeleteFile(data.path);
      if (activeSelectedIndex >= activeEntries.length - 1) {
        activeSetSelectedIndex(Math.max(0, activeEntries.length - 2));
      }
    } else if (dialogMode === 'mkdir' && data.name) {
      await activeCreateDirectory(data.name);
    }
    closeDialog();
  }, [dialogMode, activeDeleteFile, activeCreateDirectory, activeSelectedIndex, activeEntries.length, activeSetSelectedIndex, closeDialog]);

  const functionKeys = useMemo(() => [
    { key: 'F2', label: 'Path', onClick: handleCopyPath },
    { key: 'F3', label: 'View', onClick: () => { const e = activeEntries[activeSelectedIndex]; if (e?.type === 'file') { const fp = joinPath(activePath, e.name); if (isViewableExtension(fp)) activeHandleEnter(e); } } },
    { key: 'F5', label: pendingOp?.mode === 'copy' ? 'Paste' : 'Copy', active: pendingOp?.mode === 'copy', onClick: () => handleCopyOrMove('copy') },
    { key: 'F6', label: pendingOp?.mode === 'move' ? 'Paste' : 'Move', active: pendingOp?.mode === 'move', onClick: () => handleCopyOrMove('move') },
    { key: 'F7', label: 'Mkdir', onClick: () => { setDialogTarget(null); setDialogMode('mkdir'); } },
    { key: 'F8', label: 'Delete', onClick: () => { const e = activeEntries[activeSelectedIndex]; if (e && e.name !== '..') { setDialogTarget(e); setDialogMode('delete'); } } },
    { key: 'ESC', label: pendingOp ? 'Cancel' : 'Quit', onClick: handleEsc },
  ], [activeEntries, activeSelectedIndex, activeHandleEnter, handleEsc, handleCopyPath, handleCopyOrMove, pendingOp]);

  // ── Key dispatch ──
  const handlePanelKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (dialogMode) return;

    if (!isNarrow) {
      if (e.key === 'Tab') {
        e.preventDefault();
        if (rightLoaded) setActivePane(p => p === 0 ? 1 : 0);
        return;
      }
      if (activePane === 0) leftNav.handleKeyDown(e);
      else rightNav.handleKeyDown(e);
    } else {
      narrowNav.handleKeyDown(e);
    }
  }, [dialogMode, isNarrow, activePane, rightLoaded, leftNav, rightNav, narrowNav]);

  // ── Render ──
  if (isNarrow) {
    return (
      <div
        className="mdir-panel"
        ref={panelRef}
        tabIndex={0}
        onKeyDown={handlePanelKeyDown}
      >
        <MdirHeader currentPath={primaryBrowser.currentPath} />
        {primaryBrowser.loading ? (
          <div className="mdir-loading">Loading...</div>
        ) : primaryBrowser.error ? (
          <div className="mdir-error">{primaryBrowser.error}</div>
        ) : (
          <MdirFileList
            entries={primaryBrowser.entries}
            columns={1}
            selectedIndex={narrowNav.selectedIndex}
            onSelect={narrowNav.setSelectedIndex}
            onOpen={handleEnterNarrow}
            highlightedName={pendingOp?.entryName ?? null}
          />
        )}
        <MdirFooter
          fileCount={primaryBrowser.stats.fileCount}
          dirCount={primaryBrowser.stats.dirCount}
          totalBytes={primaryBrowser.stats.totalBytes}
          functionKeys={functionKeys}
        />
        <FileOperationDialog
          mode={dialogMode}
          targetEntry={dialogTarget}
          currentPath={primaryBrowser.currentPath}
          onConfirm={handleDialogConfirm}
          onCancel={closeDialog}
        />
      </div>
    );
  }

  // Wide mode: dual panel
  return (
    <div
      className="mdir-panel"
      ref={panelRef}
      tabIndex={0}
      onKeyDown={handlePanelKeyDown}
    >
      <div className="mdir-dual-pane">
        {/* Left pane (parent) */}
        <div className="mdir-pane" onClick={() => setActivePane(0)}>
          <MdirHeader currentPath={primaryBrowser.currentPath} isActive={activePane === 0} />
          {primaryBrowser.loading ? (
            <div className="mdir-loading">Loading...</div>
          ) : primaryBrowser.error ? (
            <div className="mdir-error">{primaryBrowser.error}</div>
          ) : (
            <MdirFileList
              entries={primaryBrowser.entries}
              columns={1}
              selectedIndex={leftNav.selectedIndex}
              onSelect={leftNav.setSelectedIndex}
              onOpen={handleEnterLeft}
              highlightedName={pendingOp?.entryName ?? null}
              markedDirName={openedDirName}
              isActive={activePane === 0}
            />
          )}
        </div>

        <div className="mdir-pane-divider" />

        {/* Right pane (child) */}
        <div className="mdir-pane" onClick={() => { if (rightLoaded) setActivePane(1); }}>
          <MdirHeader
            currentPath={rightBrowser.currentPath || '(empty)'}
            isActive={activePane === 1}
          />
          {rightLoaded ? (
            rightBrowser.loading ? (
              <div className="mdir-loading">Loading...</div>
            ) : rightBrowser.error ? (
              <div className="mdir-error">{rightBrowser.error}</div>
            ) : (
              <MdirFileList
                entries={rightBrowser.entries}
                columns={1}
                selectedIndex={rightNav.selectedIndex}
                onSelect={rightNav.setSelectedIndex}
                onOpen={handleEnterRight}
                highlightedName={pendingOp?.entryName ?? null}
                isActive={activePane === 1}
              />
            )
          ) : (
            <div className="mdir-pane-empty" />
          )}
        </div>
      </div>

      <MdirFooter
        fileCount={activeStats.fileCount}
        dirCount={activeStats.dirCount}
        totalBytes={activeStats.totalBytes}
        functionKeys={functionKeys}
      />
      <FileOperationDialog
        mode={dialogMode}
        targetEntry={dialogTarget}
        currentPath={activePath}
        onConfirm={handleDialogConfirm}
        onCancel={closeDialog}
      />
    </div>
  );
}
