import type { RecoveryOptionIcon } from './recoveryOption';

export interface Workspace {
  id: string;
  name: string;
  sortOrder: number;
  viewMode: 'tab' | 'grid';
  activeTabId: string | null;
  colorCounter: number;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceTab {
  id: string;
  workspaceId: string;
  sessionId: string;
  name: string;
  nameSource?: WorkspaceTabNameSource;
  terminalTitle?: string;
  colorIndex: number;
  sortOrder: number;
  shellType: string;
  createdAt: string;
  lastCwd?: string;
  lifecycleState?: WorkspaceTabLifecycleState;
  recoverable?: boolean;
  lifecycleReason?: WorkspaceTabLifecycleReason;
  cleanupStatus?: WorkspaceTabCleanupStatus;
  lastExitCode?: number | null;
  lifecycleUpdatedAt?: string;
  generation?: number;
  recoveryOptionId?: string;
  recoveryCommand?: string;
  recoveryArguments?: string[];
  recoveryIcon?: RecoveryOptionIcon | null;
  recoveryUpdatedAt?: string;
}

export type WorkspaceTabNameSource = 'default' | 'terminal-title' | 'user';

export type WorkspaceTabLifecycleState = 'active' | 'stopped';

export type WorkspaceTabLifecycleReason =
  | 'tab-delete'
  | 'workspace-delete'
  | 'tab-restart'
  | 'direct-session-delete'
  | 'process-exit'
  | 'shutdown'
  | 'orphan-recovery';

export type WorkspaceTabCleanupStatus =
  | 'not-started'
  | 'observed'
  | 'completed'
  | 'degraded'
  | 'failed';

export interface WorkspaceTabRuntime extends WorkspaceTab {
  status: 'running' | 'idle' | 'disconnected';
  cwd: string;
}

export interface GridLayout {
  workspaceId: string;
  mosaicTree: MosaicNode<string> | null;
}

// React Mosaic v6 tree types (re-exported for convenience)
export type MosaicNode<T> = MosaicParent<T> | T;

export interface MosaicParent<T> {
  direction: 'row' | 'column';
  first: MosaicNode<T>;
  second: MosaicNode<T>;
  splitPercentage?: number;
}

export interface WorkspaceState {
  workspaces: Workspace[];
  tabs: WorkspaceTab[];
  gridLayouts: GridLayout[];
}

export const TAB_COLORS = [
  '#3b82f6', // Blue
  '#10b981', // Emerald
  '#f59e0b', // Amber
  '#f43f5e', // Rose
  '#8b5cf6', // Violet
  '#06b6d4', // Cyan
  '#f97316', // Orange
  '#ec4899', // Pink
] as const;
