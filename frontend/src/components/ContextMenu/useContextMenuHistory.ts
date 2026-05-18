import { useCallback, useEffect, useRef } from 'react';

const CONTEXT_MENU_HISTORY_KEY = '__buildergateContextMenuToken';

interface UseContextMenuHistoryOptions {
  enabled: boolean;
  canGoBack: () => boolean;
  onBack: () => void;
  onClose: () => void;
}

export function useContextMenuHistory({
  enabled,
  canGoBack,
  onBack,
  onClose,
}: UseContextMenuHistoryOptions): {
  backWithHistory: () => void;
  closeWithHistory: () => void;
  pushChildPage: () => void;
} {
  const tokenRef = useRef<string | null>(null);
  const pushedEntriesRef = useRef(0);
  const suppressPopRef = useRef(false);
  const canGoBackRef = useRef(canGoBack);
  const onBackRef = useRef(onBack);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    canGoBackRef.current = canGoBack;
    onBackRef.current = onBack;
    onCloseRef.current = onClose;
  }, [canGoBack, onBack, onClose]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    tokenRef.current = token;
    pushedEntriesRef.current = 1;
    window.history.pushState({ [CONTEXT_MENU_HISTORY_KEY]: token, depth: 0 }, '');

    const handlePopState = () => {
      if (suppressPopRef.current) {
        return;
      }
      pushedEntriesRef.current = Math.max(0, pushedEntriesRef.current - 1);
      if (canGoBackRef.current()) {
        onBackRef.current();
        return;
      }
      onCloseRef.current();
    };

    window.addEventListener('popstate', handlePopState);
    return () => {
      window.removeEventListener('popstate', handlePopState);
      tokenRef.current = null;
      pushedEntriesRef.current = 0;
    };
  }, [enabled]);

  const closeWithHistory = useCallback(() => {
    const token = tokenRef.current;
    const entries = pushedEntriesRef.current;
    const state = window.history.state as Record<string, unknown> | null;
    if (token && entries > 0 && state?.[CONTEXT_MENU_HISTORY_KEY] === token) {
      suppressPopRef.current = true;
      window.history.go(-entries);
      window.setTimeout(() => {
        suppressPopRef.current = false;
      }, 0);
    }
    onCloseRef.current();
  }, []);

  const backWithHistory = useCallback(() => {
    const token = tokenRef.current;
    const entries = pushedEntriesRef.current;
    const state = window.history.state as Record<string, unknown> | null;
    if (token && entries > 1 && state?.[CONTEXT_MENU_HISTORY_KEY] === token) {
      window.history.back();
      return;
    }
    onBackRef.current();
  }, []);

  const pushChildPage = useCallback(() => {
    const token = tokenRef.current;
    if (!token) {
      return;
    }
    pushedEntriesRef.current += 1;
    window.history.pushState(
      { [CONTEXT_MENU_HISTORY_KEY]: token, depth: pushedEntriesRef.current - 1 },
      '',
    );
  }, []);

  return { backWithHistory, closeWithHistory, pushChildPage };
}
