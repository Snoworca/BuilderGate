import type { GridLayout, Workspace, WorkspaceTabRuntime } from '../types/workspace';

// PERF-BGSTAB-015 AC-2/AC-3: a confirmed workspace leaves the screen before the
// server has closed its terminals (seconds on Windows). What it took off the
// screen is kept here so a refused delete can put it back as it was.

export interface WorkspaceRemovalSnapshot {
  workspaceId: string;
  workspace: Workspace | undefined;
  tabs: WorkspaceTabRuntime[];
  gridLayouts: GridLayout[];
  wasActive: boolean;
}

export function snapshotWorkspaceRemoval(
  workspaces: Workspace[],
  tabs: WorkspaceTabRuntime[],
  gridLayouts: GridLayout[],
  workspaceId: string,
  activeWorkspaceId: string | null,
): WorkspaceRemovalSnapshot {
  return {
    workspaceId,
    workspace: workspaces.find(w => w.id === workspaceId),
    tabs: tabs.filter(t => t.workspaceId === workspaceId),
    gridLayouts: gridLayouts.filter(g => g.workspaceId === workspaceId),
    wasActive: activeWorkspaceId === workspaceId,
  };
}

export function restoreRemovedWorkspace(current: Workspace[], removal: WorkspaceRemovalSnapshot): Workspace[] {
  const { workspace } = removal;
  if (!workspace || current.some(w => w.id === workspace.id)) return current;
  return [...current, workspace].sort((a, b) => a.sortOrder - b.sortOrder);
}

export function restoreRemovedTabs(
  current: WorkspaceTabRuntime[],
  removal: WorkspaceRemovalSnapshot,
): WorkspaceTabRuntime[] {
  const missing = removal.tabs.filter(t => !current.some(c => c.id === t.id));
  return missing.length > 0 ? [...current, ...missing] : current;
}

export function restoreRemovedGridLayouts(current: GridLayout[], removal: WorkspaceRemovalSnapshot): GridLayout[] {
  if (current.some(g => g.workspaceId === removal.workspaceId)) return current;
  return removal.gridLayouts.length > 0 ? [...current, ...removal.gridLayouts] : current;
}
