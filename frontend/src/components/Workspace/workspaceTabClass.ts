import type { WorkspaceTabRuntime } from '../../types/workspace';

// FR-UIDS-009 — the classes of one tab button. A value rather than a branch in the tab bar, so
// the rule is testable without a DOM. `is-running` draws the moving band on the colour bar.

export interface WorkspaceTabClassInput {
  isActive: boolean;
  isDragging: boolean;
  isDropTarget: boolean;
  status: WorkspaceTabRuntime['status'];
}

export function workspaceTabClassName(input: WorkspaceTabClassInput): string {
  return [
    'workspace-tab',
    input.isActive ? 'is-active' : '',
    input.isDragging ? 'is-dragging' : '',
    input.isDropTarget ? 'is-drop-target' : '',
    input.status === 'running' ? 'is-running' : '',
  ].filter(Boolean).join(' ');
}
