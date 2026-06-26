import type { ShellType } from './index.js';

// ============================================================================
// Workspace Types (Step 7: CMUX-Style Workspace Pivot)
// ============================================================================

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
  shellType: ShellType;
  createdAt: string;
  lastCwd?: string;
  lifecycleState?: WorkspaceTabLifecycleState;
  recoverable?: boolean;
  lifecycleReason?: WorkspaceTabLifecycleReason;
  cleanupStatus?: WorkspaceTabCleanupStatus;
  lastExitCode?: number | null;
  lifecycleUpdatedAt?: string;
  generation?: number;
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

export interface GridLayout {
  workspaceId: string;
  mosaicTree: any | null; // MosaicNode<string> — 서버는 타입을 직접 의존하지 않음
}

export interface WorkspaceState {
  workspaces: Workspace[];
  tabs: WorkspaceTab[];
  gridLayouts: GridLayout[];
}

export interface WorkspaceFile {
  version: 1;
  lastUpdated: string;
  state: WorkspaceState;
}
