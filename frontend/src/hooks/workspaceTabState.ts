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
