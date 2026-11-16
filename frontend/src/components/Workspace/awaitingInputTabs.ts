/**
 * FR-AITUI-024 AC-5: how many of a workspace's tabs have an agent waiting on a
 * choice prompt. Kept in a .ts module so render-free tests can import it.
 */
// @req FR-AITUI-024
export function countAwaitingInputTabs(
  tabs: ReadonlyArray<{ workspaceId: string; awaitingInput?: boolean }>,
  workspaceId: string,
): number {
  return tabs.filter(tab => tab.workspaceId === workspaceId && tab.awaitingInput === true).length;
}
