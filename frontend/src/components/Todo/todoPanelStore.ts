// The to-do panel's view state: open, width, which completed entries show, the selected entry.
// The header button, the terminal shortcut, the menus and the panel sit in unrelated parts of the
// tree, so they read one module store with useSyncExternalStore. Kept in the browser; every storage
// access may throw (private mode, blocked site data) and the panel keeps working from memory.
// @req FR-TODO-002 FR-TODO-003 FR-TODO-007

import { useSyncExternalStore } from 'react';

export const TODO_PANEL_STORAGE_KEY = 'buildergate.todoPanel';
export const TODO_PANEL_DEFAULT_WIDTH = 320;
export const TODO_PANEL_MIN_WIDTH = 240;
export const TODO_PANEL_MAX_WIDTH = 800;
/** FR-TODO-002 AC-5. */
export const TODO_PANEL_DEFAULT_FONT_SIZE = 13;
export const TODO_PANEL_MIN_FONT_SIZE = 11;
export const TODO_PANEL_MAX_FONT_SIZE = 20;

export interface TodoPanelStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface TodoPanelState {
  readonly open: boolean;
  readonly width: number;
  readonly fontSize: number;
  readonly hideDone: boolean;
  readonly categoryShowDone: Readonly<Record<number, boolean>>;
  /** FR-TODO-007 AC-4: entries whose detail the user hid. */
  readonly hiddenDetails: Readonly<Record<number, true>>;
  /** Not kept: a reload starts with nothing selected. */
  readonly selectedId: number | null;
}

export interface TodoPanelStore {
  subscribe(listener: () => void): () => void;
  getState(): TodoPanelState;
  setOpen(open: boolean): void;
  toggle(): void;
  setWidth(width: number): void;
  /** One step larger (1) or smaller (-1), within the range. */
  changeFontSize(step: 1 | -1 | 2 | -2): void;
  setHideDone(hideDone: boolean): void;
  toggleCategoryDone(categoryId: number): void;
  setDetailHidden(id: number, hidden: boolean): void;
  select(id: number | null): void;
}

const clampFontSize = (size: number) => Math.round(Math.min(TODO_PANEL_MAX_FONT_SIZE, Math.max(TODO_PANEL_MIN_FONT_SIZE, size)));
const clampWidth = (width: number) => Math.round(Math.min(TODO_PANEL_MAX_WIDTH, Math.max(TODO_PANEL_MIN_WIDTH, width)));

function readState(storage: TodoPanelStorage | null): TodoPanelState {
  const initial: TodoPanelState = { open: false, width: TODO_PANEL_DEFAULT_WIDTH, fontSize: TODO_PANEL_DEFAULT_FONT_SIZE, hideDone: false, categoryShowDone: {}, hiddenDetails: {}, selectedId: null };
  let raw: string | null = null;
  try {
    raw = storage?.getItem(TODO_PANEL_STORAGE_KEY) ?? null;
  } catch {
    return initial;
  }
  if (raw === null) return initial;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return initial;
  }
  if (!value || typeof value !== 'object') return initial;
  const record = value as Record<string, unknown>;
  const categoryShowDone: Record<number, boolean> = {};
  if (record.categoryShowDone && typeof record.categoryShowDone === 'object') {
    for (const [key, shown] of Object.entries(record.categoryShowDone as Record<string, unknown>)) {
      if (typeof shown === 'boolean' && Number.isInteger(Number(key))) categoryShowDone[Number(key)] = shown;
    }
  }
  const hiddenDetails: Record<number, true> = {};
  if (record.hiddenDetails && typeof record.hiddenDetails === 'object') {
    for (const [key, hidden] of Object.entries(record.hiddenDetails as Record<string, unknown>)) {
      if (hidden === true && Number.isInteger(Number(key))) hiddenDetails[Number(key)] = true;
    }
  }
  return {
    open: record.open === true,
    width: typeof record.width === 'number' && Number.isFinite(record.width) ? clampWidth(record.width) : TODO_PANEL_DEFAULT_WIDTH,
    fontSize: typeof record.fontSize === 'number' && Number.isFinite(record.fontSize) ? clampFontSize(record.fontSize) : TODO_PANEL_DEFAULT_FONT_SIZE,
    hideDone: record.hideDone === true,
    categoryShowDone,
    hiddenDetails,
    selectedId: null,
  };
}

export function createTodoPanelStore(storage: TodoPanelStorage | null): TodoPanelStore {
  let state = readState(storage);
  const listeners = new Set<() => void>();

  const update = (next: Partial<TodoPanelState>) => {
    state = { ...state, ...next };
    if (!('selectedId' in next) || Object.keys(next).length > 1) {
      const { selectedId: _selected, ...kept } = state;
      try {
        storage?.setItem(TODO_PANEL_STORAGE_KEY, JSON.stringify(kept));
      } catch {
        // Memory only.
      }
    }
    for (const listener of listeners) listener();
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    getState: () => state,
    setOpen: (open) => { if (open !== state.open) update({ open }); },
    toggle: () => update({ open: !state.open }),
    setWidth: (width) => {
      const next = clampWidth(width);
      if (next !== state.width) update({ width: next });
    },
    changeFontSize: (step) => {
      const next = clampFontSize(state.fontSize + step);
      if (next !== state.fontSize) update({ fontSize: next });
    },
    // FR-TODO-003 AC-4: the top toggle decides for every category again.
    setHideDone: (hideDone) => update({ hideDone, categoryShowDone: {} }),
    toggleCategoryDone: (categoryId) => {
      const shown = state.categoryShowDone[categoryId] ?? !state.hideDone;
      update({ categoryShowDone: { ...state.categoryShowDone, [categoryId]: !shown } });
    },
    setDetailHidden: (id, hidden) => {
      if (hidden === (state.hiddenDetails[id] === true)) return;
      const { [id]: _was, ...rest } = state.hiddenDetails;
      update({ hiddenDetails: hidden ? { ...rest, [id]: true } : rest });
    },
    select: (id) => { if (id !== state.selectedId) update({ selectedId: id }); },
  };
}

function browserStorage(): TodoPanelStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export const todoPanelStore: TodoPanelStore = createTodoPanelStore(browserStorage());

export function useTodoPanelState(): TodoPanelState {
  return useSyncExternalStore(todoPanelStore.subscribe, todoPanelStore.getState, todoPanelStore.getState);
}

/** FR-TODO-002 AC-2: the terminal context menu's entry. */
export function todoPanelMenuOption(): { open: boolean; onToggle: () => void } {
  return { open: todoPanelStore.getState().open, onToggle: () => todoPanelStore.toggle() };
}
