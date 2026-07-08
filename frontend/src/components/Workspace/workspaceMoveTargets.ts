import type { Workspace, WorkspaceTabRuntime } from '../../types/workspace';

export type WorkspaceMoveTargetReason = 'current' | 'full' | null;

export interface WorkspaceMoveTarget {
  workspace: Workspace;
  tabCount: number;
  disabled: boolean;
  reason: WorkspaceMoveTargetReason;
}

export interface BuildWorkspaceMoveTargetsInput {
  workspaces: Workspace[];
  tabs: WorkspaceTabRuntime[];
  sourceWorkspaceId: string;
  maxTabsPerWorkspace: number;
}

export function buildWorkspaceMoveTargets({
  workspaces,
  tabs,
  sourceWorkspaceId,
  maxTabsPerWorkspace,
}: BuildWorkspaceMoveTargetsInput): WorkspaceMoveTarget[] {
  const tabCounts = new Map<string, number>();
  for (const tab of tabs) {
    tabCounts.set(tab.workspaceId, (tabCounts.get(tab.workspaceId) ?? 0) + 1);
  }

  return [...workspaces]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((workspace) => {
      const tabCount = tabCounts.get(workspace.id) ?? 0;
      const reason: WorkspaceMoveTargetReason =
        workspace.id === sourceWorkspaceId
          ? 'current'
          : tabCount >= maxTabsPerWorkspace
          ? 'full'
          : null;
      return {
        workspace,
        tabCount,
        disabled: reason !== null,
        reason,
      };
    });
}
