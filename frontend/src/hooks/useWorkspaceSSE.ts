import { useEffect, useRef } from 'react';
import { tokenStorage } from '../services/tokenStorage';
import { workspaceApi } from '../services/api';
import type { Workspace, WorkspaceTab, GridLayout } from '../types/workspace';

export interface WorkspaceSSEHandlers {
  onWorkspaceCreated?: (workspace: Workspace) => void;
  onWorkspaceUpdated?: (data: { id: string; changes: Partial<Workspace> }) => void;
  onWorkspaceDeleted?: (data: { id: string }) => void;
  onWorkspaceDeleting?: (data: { id: string }) => void;
  onWorkspaceReordered?: (data: { workspaceIds: string[] }) => void;
  onTabAdded?: (tab: WorkspaceTab) => void;
  onTabUpdated?: (data: { id: string; workspaceId: string; changes: Partial<WorkspaceTab> }) => void;
  onTabRemoved?: (data: { id: string; workspaceId: string }) => void;
  onTabReordered?: (data: { workspaceId: string; tabIds: string[] }) => void;
  onTabDisconnected?: (data: { id: string; workspaceId: string }) => void;
  onGridUpdated?: (layout: GridLayout) => void;
  onConnected?: (data: { clientId: string }) => void;
}

export function useWorkspaceSSE(handlers: WorkspaceSSEHandlers): void {
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });

  useEffect(() => {
    const token = tokenStorage.getToken();
    if (!token) return;

    const url = `${workspaceApi.getStreamUrl()}?token=${encodeURIComponent(token)}`;
    let es: EventSource | null = new EventSource(url);
    let connected = false;

    es.addEventListener('connected', (e) => {
      connected = true;
      handlersRef.current.onConnected?.(JSON.parse((e as MessageEvent).data));
    });

    es.addEventListener('workspace:created', (e) => {
      handlersRef.current.onWorkspaceCreated?.(JSON.parse((e as MessageEvent).data));
    });

    es.addEventListener('workspace:updated', (e) => {
      handlersRef.current.onWorkspaceUpdated?.(JSON.parse((e as MessageEvent).data));
    });

    es.addEventListener('workspace:deleted', (e) => {
      handlersRef.current.onWorkspaceDeleted?.(JSON.parse((e as MessageEvent).data));
    });

    es.addEventListener('workspace:deleting', (e) => {
      handlersRef.current.onWorkspaceDeleting?.(JSON.parse((e as MessageEvent).data));
    });

    es.addEventListener('workspace:reordered', (e) => {
      handlersRef.current.onWorkspaceReordered?.(JSON.parse((e as MessageEvent).data));
    });

    es.addEventListener('tab:added', (e) => {
      handlersRef.current.onTabAdded?.(JSON.parse((e as MessageEvent).data));
    });

    es.addEventListener('tab:updated', (e) => {
      handlersRef.current.onTabUpdated?.(JSON.parse((e as MessageEvent).data));
    });

    es.addEventListener('tab:removed', (e) => {
      handlersRef.current.onTabRemoved?.(JSON.parse((e as MessageEvent).data));
    });

    es.addEventListener('tab:reordered', (e) => {
      handlersRef.current.onTabReordered?.(JSON.parse((e as MessageEvent).data));
    });

    es.addEventListener('tab:disconnected', (e) => {
      handlersRef.current.onTabDisconnected?.(JSON.parse((e as MessageEvent).data));
    });

    es.addEventListener('grid:updated', (e) => {
      handlersRef.current.onGridUpdated?.(JSON.parse((e as MessageEvent).data));
    });

    // Close on error to prevent native auto-reconnect infinite loop
    // (same pattern as existing useSSE.ts)
    es.onerror = () => {
      if (es) {
        es.close();
        es = null;
      }
    };

    return () => {
      if (es) {
        es.close();
        es = null;
      }
    };
  }, []);
}
