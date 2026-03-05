import { useState, useEffect, useCallback, useMemo } from 'react';
import { fileApi } from '../services/api';
import type { DirectoryEntry } from '../types';

interface UseFileBrowserReturn {
  entries: DirectoryEntry[];
  currentPath: string;
  loading: boolean;
  error: string | null;
  navigate: (path: string) => void;
  goUp: () => void;
  refresh: () => void;
  clear: () => void;
  copyFile: (source: string, destination: string) => Promise<void>;
  moveFile: (source: string, destination: string) => Promise<void>;
  deleteFile: (path: string) => Promise<void>;
  createDirectory: (name: string) => Promise<void>;
  stats: { fileCount: number; dirCount: number; totalBytes: number };
}

export function useFileBrowser(sessionId: string, initialPath?: string | null): UseFileBrowserReturn {
  const [entries, setEntries] = useState<DirectoryEntry[]>([]);
  const [currentPath, setCurrentPath] = useState('');
  const [loading, setLoading] = useState(initialPath === null ? false : true);
  const [error, setError] = useState<string | null>(null);

  const loadDirectory = useCallback(async (path?: string) => {
    setLoading(true);
    setError(null);
    try {
      const listing = await fileApi.listDirectory(sessionId, path);
      setEntries(listing.entries);
      setCurrentPath(listing.path);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  // Initial load: get CWD then list (skip if initialPath === null for lazy init)
  useEffect(() => {
    if (initialPath === null) return;

    let cancelled = false;

    async function init() {
      setLoading(true);
      setError(null);
      try {
        if (initialPath) {
          // Use provided initial path directly
          const listing = await fileApi.listDirectory(sessionId, initialPath);
          if (cancelled) return;
          setEntries(listing.entries);
          setCurrentPath(listing.path);
        } else {
          // Default: fetch CWD then list
          const { cwd } = await fileApi.getCwd(sessionId);
          if (cancelled) return;
          const listing = await fileApi.listDirectory(sessionId, cwd);
          if (cancelled) return;
          setEntries(listing.entries);
          setCurrentPath(listing.path);
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    init();
    return () => { cancelled = true; };
  }, [sessionId, initialPath]);

  const navigate = useCallback((path: string) => {
    loadDirectory(path);
  }, [loadDirectory]);

  const goUp = useCallback(() => {
    // Navigate to parent by using ".." relative to currentPath
    const parent = currentPath.replace(/[\\/][^\\/]+[\\/]?$/, '') || '/';
    loadDirectory(parent);
  }, [currentPath, loadDirectory]);

  const refresh = useCallback(() => {
    loadDirectory(currentPath);
  }, [currentPath, loadDirectory]);

  const clear = useCallback(() => {
    setEntries([]);
    setCurrentPath('');
    setLoading(false);
    setError(null);
  }, []);

  const copyFile = useCallback(async (source: string, destination: string) => {
    await fileApi.copyFile(sessionId, source, destination);
    refresh();
  }, [sessionId, refresh]);

  const moveFile = useCallback(async (source: string, destination: string) => {
    await fileApi.moveFile(sessionId, source, destination);
    refresh();
  }, [sessionId, refresh]);

  const deleteFile = useCallback(async (path: string) => {
    await fileApi.deleteFile(sessionId, path);
    refresh();
  }, [sessionId, refresh]);

  const createDirectory = useCallback(async (name: string) => {
    await fileApi.createDirectory(sessionId, currentPath, name);
    refresh();
  }, [sessionId, currentPath, refresh]);

  const stats = useMemo(() => {
    let fileCount = 0;
    let dirCount = 0;
    let totalBytes = 0;
    for (const entry of entries) {
      if (entry.name === '..') continue;
      if (entry.type === 'file') {
        fileCount++;
        totalBytes += entry.size;
      } else {
        dirCount++;
      }
    }
    return { fileCount, dirCount, totalBytes };
  }, [entries]);

  return {
    entries,
    currentPath,
    loading,
    error,
    navigate,
    goUp,
    refresh,
    clear,
    copyFile,
    moveFile,
    deleteFile,
    createDirectory,
    stats,
  };
}
