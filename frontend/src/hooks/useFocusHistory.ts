import { useRef, useCallback } from 'react';

export interface UseFocusHistoryReturn {
  recordFocus: (tabId: string) => void;
  getPrevious: (excludeTabId: string) => string | null;
  getHistory: () => string[];
}

export function useFocusHistory(): UseFocusHistoryReturn {
  const historyRef = useRef<string[]>([]);

  const recordFocus = useCallback((tabId: string) => {
    const h = historyRef.current;
    historyRef.current = [...h.filter(id => id !== tabId), tabId];
    if (historyRef.current.length > 20) {
      historyRef.current = historyRef.current.slice(-20);
    }
  }, []);

  const getPrevious = useCallback((excludeTabId: string): string | null => {
    const h = historyRef.current.filter(id => id !== excludeTabId);
    return h.length > 0 ? h[h.length - 1] : null;
  }, []);

  const getHistory = useCallback(() => historyRef.current, []);

  return { recordFocus, getPrevious, getHistory };
}
