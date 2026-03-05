/**
 * SSE Hook
 * Phase 7: Frontend Security - Token authentication added
 */

import { useEffect, useRef } from 'react';
import { sessionApi } from '../services/api';
import { tokenStorage } from '../services/tokenStorage';
import type { SessionStatus } from '../types';

interface SSEHandlers {
  onOutput?: (data: string) => void;
  onStatus?: (status: SessionStatus) => void;
  onError?: (message: string) => void;
  onAuthError?: () => void;
}

export function useSSE(sessionId: string | null, handlers: SSEHandlers) {
  // IMPORTANT: Use ref to avoid reconnecting on handler changes
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });

  useEffect(() => {
    if (!sessionId) {
      return;
    }

    const token = tokenStorage.getToken();
    if (!token) {
      handlersRef.current.onAuthError?.();
      return;
    }

    // Create SSE URL with token as query param
    // Note: EventSource doesn't support custom headers,
    // so we pass token via query string (backend must support this)
    const baseUrl = sessionApi.getStreamUrl(sessionId);
    const url = `${baseUrl}?token=${encodeURIComponent(token)}`;

    const eventSource = new EventSource(url);

    eventSource.addEventListener('output', (event) => {
      try {
        const { data } = JSON.parse(event.data);
        handlersRef.current.onOutput?.(data);
      } catch (e) {
        console.error('Failed to parse output event:', e);
      }
    });

    eventSource.addEventListener('status', (event) => {
      try {
        const { status } = JSON.parse(event.data);
        handlersRef.current.onStatus?.(status);
      } catch (e) {
        console.error('Failed to parse status event:', e);
      }
    });

    eventSource.addEventListener('error', (event) => {
      if (event instanceof MessageEvent) {
        try {
          const { message } = JSON.parse(event.data);
          handlersRef.current.onError?.(message);
        } catch (e) {
          console.error('Failed to parse error event:', e);
        }
      }
    });

    eventSource.onerror = () => {
      console.error('SSE connection error');
      handlersRef.current.onError?.('Connection lost');
    };

    return () => {
      eventSource.close();
    };
  }, [sessionId]); // Only sessionId triggers reconnect, not handlers
}
