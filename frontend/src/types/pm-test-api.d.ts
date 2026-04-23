import type { WorkspaceTabRuntime } from './workspace';

declare global {
  interface Window {
    __PM_TEST_API__?: {
      grid?: {
        injectAutoStatusChange?: (payload: {
          statusByTabId: Record<string, WorkspaceTabRuntime['status']>;
        }) => void;
        clearAutoStatusChange?: () => void;
        setLayoutMode?: (payload: {
          mode: 'equal' | 'focus' | 'auto' | 'none';
          focusTarget?: string | null;
        }) => void;
      };
    };
  }
}

export {};
