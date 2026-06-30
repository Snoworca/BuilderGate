export interface WorkspaceIdLike {
  id: string;
}

export function resolveActiveWorkspaceAfterRemoval(
  currentActiveWorkspaceId: string | null,
  removedWorkspaceId: string,
  remainingWorkspaces: WorkspaceIdLike[],
): string | null | undefined {
  if (currentActiveWorkspaceId !== removedWorkspaceId) {
    return undefined;
  }

  return remainingWorkspaces[0]?.id ?? null;
}
