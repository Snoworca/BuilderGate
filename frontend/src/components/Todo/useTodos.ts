// The server's to-do list, read again on every `todos:changed` broadcast (debounced) and on
// reconnect. Writes go to the server; the broadcast brings the result back to every browser.
// @req FR-TODO-001 FR-TODO-005
import { useCallback, useEffect, useRef, useState } from 'react';
import { useWebSocketActions, useWebSocketState } from '../../contexts/WebSocketContext';
import { todoApi } from '../../services/api.ts';
import type { TodoItem } from './todoModel.ts';

export const TODOS_CHANGED_EVENT = 'todos:changed';
const REFETCH_DEBOUNCE_MS = 100;

export interface UseTodosResult {
  items: TodoItem[];
  /** FR-TODO-003 AC-9: the list has arrived at least once. */
  loaded: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useTodos(enabled: boolean): UseTodosResult {
  const { registerAppEventHandler } = useWebSocketActions();
  const { status } = useWebSocketState();
  const [items, setItems] = useState<TodoItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const requestRef = useRef(0);
  const timerRef = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    const request = ++requestRef.current;
    try {
      const next = await todoApi.list();
      if (request !== requestRef.current) return;
      setItems(next);
      setLoaded(true);
      setError(null);
    } catch (reason) {
      if (request === requestRef.current) setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, []);

  useEffect(() => {
    if (enabled && status === 'connected') void refresh();
  }, [enabled, status, refresh]);

  useEffect(() => {
    if (!enabled) return undefined;
    const unregister = registerAppEventHandler(TODOS_CHANGED_EVENT, () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        void refresh();
      }, REFETCH_DEBOUNCE_MS);
    });
    return () => {
      unregister();
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = null;
    };
  }, [enabled, registerAppEventHandler, refresh]);

  return { items, loaded, error, refresh };
}
