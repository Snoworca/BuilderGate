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
  colorIndex: number;
  sortOrder: number;
  shellType: ShellType;
  createdAt: string;
  lastCwd?: string;
}

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
