// FR-AITUI-018 AC-6: a busy or closed tab is restored into a new tab in its saved workspace and folder.
// FR-AITUI-022: that tab is broadcast as tab:added, as the REST route, the loop runtime and the MCP
// control do, so open browsers show it without a reload.

export interface RestoreTabOpenerDeps {
  listWorkspaces(): ReadonlyArray<{ id: string; sortOrder: number }>;
  addTab(workspaceId: string, name: string, cwd: string | undefined): Promise<{ id: string }>;
  broadcast(event: string, data: object): void;
}

export type RestoreTabOpener = (
  workspaceId: string,
  name: string,
  cwd: string | null | undefined,
  fallbackWorkspaceId?: string | null,
) => Promise<string | null>;

export function createRestoreTabOpener(deps: RestoreTabOpenerDeps): RestoreTabOpener {
  return async (workspaceId, name, cwd, fallbackWorkspaceId) => {
    const workspaces = deps.listWorkspaces();
    const target = [workspaceId, fallbackWorkspaceId]
      .find((id) => id && workspaces.some((workspace) => workspace.id === id))
      ?? [...workspaces].sort((a, b) => a.sortOrder - b.sortOrder)[0]?.id;
    if (!target) return null;
    const tab = await deps.addTab(target, name, cwd ?? undefined);
    deps.broadcast('tab:added', tab);
    return tab.id;
  };
}
