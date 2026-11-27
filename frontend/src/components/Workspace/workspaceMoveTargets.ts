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

/**
 * FR-ARCH-019 AC-2: any tab can move, whatever its session state; a stopped or disconnected tab
 * has no process to carry, so only its workspace changes.
 */
export function isTabMovable(tab: WorkspaceTabRuntime | undefined): boolean {
  return tab !== undefined;
}

/**
 * FR-ARCH-019 AC-1: the workspace a dragged tab would drop on. The same rule as the move dialog:
 * the tab's own workspace, a full one or an unknown id is not a target.
 */
export function resolveWorkspaceDropTarget(input: BuildWorkspaceMoveTargetsInput & { hoveredWorkspaceId: string | null }): string | null {
  if (input.hoveredWorkspaceId === null) return null;
  const target = buildWorkspaceMoveTargets(input).find(item => item.workspace.id === input.hoveredWorkspaceId);
  return target && !target.disabled ? target.workspace.id : null;
}

interface DropIdElement {
  dataset?: { workspaceDropId?: string };
}

/** FR-ARCH-019 AC-1: the sidebar workspace under the pointer, from data-workspace-drop-id. */
export function findWorkspaceDropId(element: { closest?: (selector: string) => unknown } | null): string | null {
  if (!element || typeof element.closest !== 'function') return null;
  const item = element.closest('[data-workspace-drop-id]') as DropIdElement | null;
  return item?.dataset?.workspaceDropId ?? null;
}
