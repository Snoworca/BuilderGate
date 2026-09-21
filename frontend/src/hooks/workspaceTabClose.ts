import type { Workspace, WorkspaceTabRuntime } from '../types/workspace';

/**
 * What a tab close needs to know before anything is removed.
 *
 * PERF-BGSTAB-012: the close is applied locally first and the server call is
 * awaited afterwards, so the rollback data has to be captured up front —
 * once `tabs` has been filtered the removed tab and its position are gone.
 */
export interface TabClosePlan {
  workspaceId: string;
  tabId: string;
  /** The tab being closed, or null when it is not in the list. */
  tab: WorkspaceTabRuntime | null;
  /** Index the tab occupied in the full tab list, for ordered restore. */
  tabIndex: number;
  /** Tab to activate once this one is gone (FR-7205: right adjacent, then left). */
  nextActiveTabId: string | null;
  /** Active tab before the close, restored when the server rejects it. */
  previousActiveTabId: string | null;
}

export function planTabClose(
  tabs: readonly WorkspaceTabRuntime[],
  workspaces: readonly Workspace[],
  workspaceId: string,
  tabId: string,
): TabClosePlan {
  const workspaceTabs = tabs
    .filter(tab => tab.workspaceId === workspaceId)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const workspace = workspaces.find(candidate => candidate.id === workspaceId);
  const previousActiveTabId = workspace?.activeTabId ?? null;

  let nextActiveTabId: string | null = null;
  if (previousActiveTabId === tabId) {
    const currentIndex = workspaceTabs.findIndex(tab => tab.id === tabId);
    if (currentIndex >= 0) {
      // Right adjacent first, then left.
      nextActiveTabId = workspaceTabs[currentIndex + 1]?.id ?? workspaceTabs[currentIndex - 1]?.id ?? null;
    }
  } else {
    nextActiveTabId = previousActiveTabId;
  }

  const tabIndex = tabs.findIndex(tab => tab.id === tabId);
  return {
    workspaceId,
    tabId,
    tab: tabIndex >= 0 ? tabs[tabIndex] : null,
    tabIndex,
    nextActiveTabId,
    previousActiveTabId,
  };
}

export function removeTabFromList(
  tabs: readonly WorkspaceTabRuntime[],
  tabId: string,
): WorkspaceTabRuntime[] {
  return tabs.filter(tab => tab.id !== tabId);
}

/**
 * Put a tab back where it was. Inserting by the captured index rather than
 * re-sorting keeps the other workspaces' tabs where they are — the list holds
 * every workspace's tabs and `sortOrder` is only unique within a workspace.
 */
export function restoreTabToList(
  tabs: readonly WorkspaceTabRuntime[],
  tab: WorkspaceTabRuntime,
  tabIndex: number,
): WorkspaceTabRuntime[] {
  if (tabs.some(candidate => candidate.id === tab.id)) {
    return [...tabs];
  }
  const restored = [...tabs];
  const index = tabIndex < 0 ? restored.length : Math.min(tabIndex, restored.length);
  restored.splice(index, 0, tab);
  return restored;
}

export function applyActiveTabId(
  workspaces: readonly Workspace[],
  workspaceId: string,
  activeTabId: string | null,
): Workspace[] {
  return workspaces.map(workspace =>
    workspace.id === workspaceId ? { ...workspace, activeTabId } : workspace,
  );
}

export interface TabCloseEffects {
  /** Everything that makes the tab disappear from this client. */
  applyLocalClose: (plan: TabClosePlan) => void;
  /** Server call. Its latency must not be on the path to `applyLocalClose`. */
  requestDelete: (workspaceId: string, tabId: string) => Promise<void>;
  /** Undo of `applyLocalClose`, used only when `requestDelete` rejects. */
  revertLocalClose: (plan: TabClosePlan) => void;
  reportError: (error: unknown) => void;
}

/**
 * Close a tab without waiting for the server.
 *
 * PERF-BGSTAB-012 AC-1/AC-2: verified process-tree termination costs seconds on
 * Windows (one `Get-CimInstance Win32_Process` enumeration measured at 3.0-3.6s
 * on a 1289-process host, and `deleteTab` awaits two of them plus a 750ms
 * graceful wait). Holding the tab on screen for that long reads as a hang, so
 * the local removal happens first and a rejected delete puts the tab back.
 */
export async function runTabClose(
  plan: TabClosePlan,
  effects: TabCloseEffects,
): Promise<void> {
  effects.applyLocalClose(plan);
  try {
    await effects.requestDelete(plan.workspaceId, plan.tabId);
  } catch (error) {
    effects.revertLocalClose(plan);
    effects.reportError(error);
  }
}
