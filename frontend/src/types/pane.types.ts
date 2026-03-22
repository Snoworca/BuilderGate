// ============================================================================
// BuilderGate Pane Split System - Type Definitions
// Zero runtime dependencies. Only TypeScript types and const values.
// ============================================================================

// ---------------------------------------------------------------------------
// Direction & Preset Types
// ---------------------------------------------------------------------------

export type Direction = 'horizontal' | 'vertical';
export type FocusDirection = 'up' | 'down' | 'left' | 'right';
export type PresetType = 'single' | 'vertical-2' | 'horizontal-2' | 'quad' | 'main-side' | 'agent-monitor';

// ---------------------------------------------------------------------------
// Core Node Types
// ---------------------------------------------------------------------------

export interface PaneLeaf {
  type: 'terminal';
  id: string;
  sessionId: string;
}

export interface PaneSplit {
  type: 'split';
  id: string;
  direction: Direction;
  ratio: number; // 0.15..0.85
  children: [PaneNode, PaneNode];
}

export type PaneNode = PaneLeaf | PaneSplit;

// ---------------------------------------------------------------------------
// Layout Wrapper
// ---------------------------------------------------------------------------

export interface PaneLayout {
  root: PaneNode;
  focusedPaneId: string;
  zoomedPaneId: string | null;
}

// ---------------------------------------------------------------------------
// IndexedDB Record Types
// ---------------------------------------------------------------------------

export interface PaneLayoutRecord {
  /** keyPath */
  sessionId: string;
  layout: PaneLayout;
  updatedAt: number;
}

export interface SavedLayoutRecord {
  /** keyPath — UUID or 'preset-{name}' */
  id: string;
  name: string;
  /** Layout with placeholder sessionIds */
  layout: PaneLayout;
  isBuiltIn: boolean;
  paneCount: number;
  createdAt: number;
}

export interface SessionMetaRecord {
  /** keyPath */
  sessionId: string;
  groupId?: string;
  color?: string;
  lastConnected: number;
}

// ---------------------------------------------------------------------------
// Extended Context Menu Item
// ---------------------------------------------------------------------------

export interface PaneContextMenuItem {
  label: string;
  icon?: string;
  onClick?: () => void;
  disabled?: boolean;
  destructive?: boolean;
  shortcut?: string;
  children?: PaneContextMenuItem[];
  separator?: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const PANE_CONSTANTS = {
  MAX_PANES: 8,
  MAX_DEPTH: 4,
  MIN_RATIO: 0.15,
  MAX_RATIO: 0.85,
  MIN_PANE_WIDTH: 120,
  MIN_PANE_HEIGHT: 80,
} as const;

export const PLACEHOLDER_SESSION_ID = '__placeholder__';

export const PANE_DB = {
  NAME: 'buildergate',
  VERSION: 1,
  STORES: {
    PANE_LAYOUTS: 'paneLayouts',
    SAVED_LAYOUTS: 'savedLayouts',
    SESSION_META: 'sessionMeta',
  },
} as const;

// ---------------------------------------------------------------------------
// Built-in Presets Metadata
// ---------------------------------------------------------------------------

export const BUILT_IN_PRESETS: ReadonlyArray<{
  id: string;
  name: string;
  type: PresetType;
  paneCount: number;
}> = [
  { id: 'preset-single', name: '단일', type: 'single', paneCount: 1 },
  { id: 'preset-vertical-2', name: '좌우 분할', type: 'vertical-2', paneCount: 2 },
  { id: 'preset-horizontal-2', name: '상하 분할', type: 'horizontal-2', paneCount: 2 },
  { id: 'preset-quad', name: '4분할', type: 'quad', paneCount: 4 },
  { id: 'preset-main-side', name: '1+2 (메인+보조)', type: 'main-side', paneCount: 3 },
  { id: 'preset-agent-monitor', name: '에이전트 모니터', type: 'agent-monitor', paneCount: 3 },
] as const;
