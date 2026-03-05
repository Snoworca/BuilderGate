/**
 * useFileContent Hook
 * Phase 5: File Viewer
 *
 * Fetches file content from the backend and manages loading/error state.
 */

import { useState, useEffect } from 'react';
import { fileApi } from '../services/api';
import type { FileContent } from '../types';

interface UseFileContentReturn {
  content: string;
  fileInfo: FileContent | null;
  isLoading: boolean;
  error: string | null;
}

export function useFileContent(
  sessionId: string,
  filePath: string | null
): UseFileContentReturn {
  const [content, setContent] = useState('');
  const [fileInfo, setFileInfo] = useState<FileContent | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!filePath) {
      setContent('');
      setFileInfo(null);
      setError(null);
      return;
    }

    let cancelled = false;

    const fetchContent = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const data = await fileApi.readFile(sessionId, filePath);
        if (!cancelled) {
          setContent(data.content);
          setFileInfo(data);
        }
      } catch (err) {
        if (!cancelled) {
          setError((err as Error).message);
          setContent('');
          setFileInfo(null);
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };

    fetchContent();
    return () => { cancelled = true; };
  }, [sessionId, filePath]);

  return { content, fileInfo, isLoading, error };
}
