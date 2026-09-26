// FR-UIDS-005 AC-2/AC-3 — what a workspace row's dot says. A value rather than a
// branch in the row, so the rule is readable and testable without a DOM.

export interface WorkspaceActivity {
  /** Any of the workspace's tabs is running (green); otherwise idle (grey). */
  running: boolean;
  /** The state in words, so the dot does not speak by colour alone. */
  label: string;
}

export function workspaceActivity(runningCount: number): WorkspaceActivity {
  return runningCount > 0 ? { running: true, label: '실행 중' } : { running: false, label: '대기' };
}
