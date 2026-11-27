// FR-ARCH-019 AC-1: a tab dragged in the tab bar can be dropped on a workspace in the sidebar.
// The two sit in unrelated parts of the tree, so the sidebar reads the drag from this store to
// highlight the workspace the tab would drop on.
// @req FR-ARCH-019

import { useSyncExternalStore } from 'react';

export interface TabDragState {
  readonly tabId: string | null;
  readonly sourceWorkspaceId: string | null;
  readonly hoverWorkspaceId: string | null;
}

const IDLE: TabDragState = { tabId: null, sourceWorkspaceId: null, hoverWorkspaceId: null };

let state: TabDragState = IDLE;
const listeners = new Set<() => void>();

function set(next: TabDragState): void {
  state = next;
  for (const listener of [...listeners]) listener();
}

export const tabDragStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  getState(): TabDragState {
    return state;
  },
  begin(drag: { tabId: string; sourceWorkspaceId: string }): void {
    set({ tabId: drag.tabId, sourceWorkspaceId: drag.sourceWorkspaceId, hoverWorkspaceId: null });
  },
  hover(workspaceId: string | null): void {
    if (state.tabId === null || state.hoverWorkspaceId === workspaceId) return;
    set({ ...state, hoverWorkspaceId: workspaceId });
  },
  end(): void {
    if (state === IDLE) return;
    set(IDLE);
  },
};

/** The workspace a dragged tab is over, or null. */
export function useTabDropHoverId(): string | null {
  return useSyncExternalStore(tabDragStore.subscribe, () => tabDragStore.getState().hoverWorkspaceId);
}
