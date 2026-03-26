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
  shellType: string;
  createdAt: string;
}

export interface WorkspaceTabRuntime extends WorkspaceTab {
  status: 'running' | 'idle' | 'disconnected';
  cwd: string;
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
