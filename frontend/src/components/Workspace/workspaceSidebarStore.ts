// FR-UIDS-016: whether the desktop workspace sidebar is folded to its column of circles.
// App sizes the column from it and hands it to WorkspaceSidebar, so it is one module store
// read with useSyncExternalStore. Kept in the browser; every storage access may throw
// (private mode, blocked site data), and the sidebar then starts expanded and keeps
// working from memory.
// @req FR-UIDS-016 AC-2 AC-5

import { useSyncExternalStore } from 'react';

export const WORKSPACE_SIDEBAR_STORAGE_KEY = 'buildergate.workspaceSidebar.collapsed';
/** The desktop column in pixels: the width it always had, and folded to one circle per row. */
export const WORKSPACE_SIDEBAR_WIDTH = 220;
export const WORKSPACE_SIDEBAR_COLLAPSED_WIDTH = 56;

export interface WorkspaceSidebarStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface WorkspaceSidebarStore {
  subscribe(listener: () => void): () => void;
  /** True while folded. */
  getState(): boolean;
  setCollapsed(collapsed: boolean): void;
}

/** AC-5: only a stored 'true' folds; nothing stored, any other value or a throwing storage is expanded. */
function readCollapsed(storage: WorkspaceSidebarStorage | null): boolean {
  try {
    return storage?.getItem(WORKSPACE_SIDEBAR_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function createWorkspaceSidebarStore(storage: WorkspaceSidebarStorage | null): WorkspaceSidebarStore {
  let collapsed = readCollapsed(storage);
  const listeners = new Set<() => void>();

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    getState: () => collapsed,
    setCollapsed: (next) => {
      if (next === collapsed) return;
      collapsed = next;
      try {
        storage?.setItem(WORKSPACE_SIDEBAR_STORAGE_KEY, String(next));
      } catch {
        // Memory only.
      }
      for (const listener of listeners) listener();
    },
  };
}

function browserStorage(): WorkspaceSidebarStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export const workspaceSidebarStore: WorkspaceSidebarStore = createWorkspaceSidebarStore(browserStorage());

export function useWorkspaceSidebarCollapsed(): boolean {
  return useSyncExternalStore(workspaceSidebarStore.subscribe, workspaceSidebarStore.getState, workspaceSidebarStore.getState);
}
