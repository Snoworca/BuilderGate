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
}

export interface GridLayout {
  workspaceId: string;
  columns: number;
  rows: number;
  tabOrder: string[];
  cellSizes: {
    colWidths: number[];
    rowHeights: number[];
  } | null;
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
