import type { MoveTabResult, WorkspaceTab, WorkspaceTabRuntime } from '../types/workspace';

function hasExactIdSet(actualIds: string[], expectedIds: string[]): boolean {
  if (actualIds.length !== expectedIds.length) {
    return false;
  }

  const actual = new Set(actualIds);
  if (actual.size !== actualIds.length) {
    return false;
  }
  if (actual.size !== expectedIds.length) {
    return false;
  }

  return expectedIds.every(id => actual.has(id));
}

export function canApplyMoveTabResult(
  tabs: WorkspaceTabRuntime[],
  result: MoveTabResult,
): boolean {
  if (result.sourceWorkspaceId === result.targetWorkspaceId) {
    return false;
  }

  const existingMovedTab = tabs.find(tab => tab.id === result.tab.id);
  if (!existingMovedTab || existingMovedTab.workspaceId !== result.sourceWorkspaceId) {
    return false;
  }

  const expectedSourceIds = tabs
    .filter(tab => tab.workspaceId === result.sourceWorkspaceId && tab.id !== result.tab.id)
    .map(tab => tab.id);
  const expectedTargetIds = [
    ...tabs
      .filter(tab => tab.workspaceId === result.targetWorkspaceId)
      .map(tab => tab.id),
    result.tab.id,
  ];

  const validSourceActiveTab =
    result.sourceActiveTabId === null || result.sourceTabIds.includes(result.sourceActiveTabId);
  const validTargetActiveTab = result.targetActiveTabId === result.tab.id;

  return hasExactIdSet(result.sourceTabIds, expectedSourceIds)
    && hasExactIdSet(result.targetTabIds, expectedTargetIds)
    && validSourceActiveTab
    && validTargetActiveTab;
}

function replaceWorkspaceTab(tab: WorkspaceTabRuntime, replacement: WorkspaceTab): WorkspaceTabRuntime {
  return {
    ...replacement,
    status: tab.status,
    cwd: tab.cwd,
  };
}

export function applyTabReorderResultToTabs(
  tabs: WorkspaceTabRuntime[],
  workspaceId: string,
  tabIds: string[],
): WorkspaceTabRuntime[] {
  const workspaceTabIds = tabs
    .filter(tab => tab.workspaceId === workspaceId)
    .map(tab => tab.id);
  if (!hasExactIdSet(tabIds, workspaceTabIds)) {
    return tabs;
  }

  return tabs.map(tab => {
    if (tab.workspaceId !== workspaceId) return tab;
    const idx = tabIds.indexOf(tab.id);
    return { ...tab, sortOrder: idx };
  });
}

export function applyMoveTabResultToTabs(
  tabs: WorkspaceTabRuntime[],
  result: MoveTabResult,
): WorkspaceTabRuntime[] {
  if (!canApplyMoveTabResult(tabs, result)) {
    return tabs;
  }

  const existingMovedTab = tabs.find(tab => tab.id === result.tab.id)!;
  const sourceOrder = new Map(result.sourceTabIds.map((id, index) => [id, index]));
  const targetOrder = new Map(result.targetTabIds.map((id, index) => [id, index]));
  const movedRuntime = replaceWorkspaceTab(existingMovedTab, result.tab);
  const withoutMoved = tabs.filter(tab => tab.id !== result.tab.id);

  return [...withoutMoved, movedRuntime].map((tab) => {
    const sourceIndex = sourceOrder.get(tab.id);
    if (sourceIndex !== undefined) {
      return {
        ...tab,
        workspaceId: result.sourceWorkspaceId,
        sortOrder: sourceIndex,
      };
    }

    const targetIndex = targetOrder.get(tab.id);
    if (targetIndex !== undefined) {
      return {
        ...tab,
        workspaceId: result.targetWorkspaceId,
        sortOrder: targetIndex,
      };
    }

    return tab;
  });
}

/**
 * Issue #108: whether a tab that arrived over `tab:added` should become the workspace's active
 * tab.
 *
 * The local creation path sets `activeTabId` itself; the broadcast handler did not, so a tab
 * created out of band -- by another client, by the API, by an agent orchestrating sessions --
 * appeared in the tab bar while the workspace still had no active tab, and no terminal host was
 * mounted for it. Measured: twelve seconds with every `.terminal-view` at 0x0, a tab button
 * drawn, a live session behind it, and nothing on screen. Selecting the tab mounted it at once.
 *
 * Adoption is deliberately narrow. Taking over whenever a tab arrives would move a user who is
 * working in another tab of that workspace, which is worse than the defect. It adopts only when
 * the workspace has nothing active to lose: no active tab at all, or an active tab that is not
 * among the tabs that exist.
 */
export function shouldAdoptRemoteTabAsActive(
  workspace: { activeTabId?: string | null } | undefined,
  tabsInWorkspace: readonly { id: string }[],
): boolean {
  if (!workspace) return false;
  const activeTabId = workspace.activeTabId;
  if (!activeTabId) return true;
  return !tabsInWorkspace.some(tab => tab.id === activeTabId);
}

/**
 * Issue #108: merge a freshly fetched tab list into the runtime tabs the client already holds.
 *
 * The client loads workspace state once on mount and then relies entirely on broadcasts. A
 * broadcast that arrives while the socket is not open -- during the first connect, or across a
 * reconnect -- is not queued anywhere, so the client's view silently diverges from the server
 * until someone reloads the page. Measured: a workspace created over the API never appeared in
 * the sidebar within 30 seconds, and a tab created the same way appeared without a terminal.
 *
 * Resyncing needs the server's list to win on membership while the runtime fields the server
 * does not know about -- live status, the cwd the terminal reported -- survive for tabs that are
 * still there. Dropping those would blank a running terminal's header on every reconnect, which
 * is a worse defect than the one being fixed.
 */
export function mergeFetchedTabsIntoRuntime<
  TStatus extends string,
  TFetched extends { id: string; lastCwd?: string | null },
  TRuntime extends { id: string; status: TStatus; cwd: string },
>(fetched: readonly TFetched[], current: readonly TRuntime[]): Array<TFetched & { status: TStatus; cwd: string }> {
  const byId = new Map(current.map(tab => [tab.id, tab]));
  return fetched.map(tab => {
    const existing = byId.get(tab.id);
    return {
      ...tab,
      status: existing?.status ?? ('idle' as TStatus),
      // The reported cwd outlives a reconnect; `lastCwd` is the server's persisted fallback.
      cwd: existing?.cwd || tab.lastCwd || '',
    };
  });
}
