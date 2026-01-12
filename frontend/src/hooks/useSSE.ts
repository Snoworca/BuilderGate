import { useEffect, useRef } from 'react';
import { sessionApi } from '../services/api';
import type { SessionStatus } from '../types';

interface SSEHandlers {
  onOutput?: (data: string) => void;
  onStatus?: (status: SessionStatus) => void;
  onError?: (message: string) => void;
}

export function useSSE(sessionId: string | null, handlers: SSEHandlers) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (!sessionId) return;

    const url = sessionApi.getStreamUrl(sessionId);
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
    };

    return () => {
      eventSource.close();
    };
  }, [sessionId]);
}
