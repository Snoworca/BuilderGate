import type { MosaicNode } from '../types/workspace';
import {
  containsLeaf,
  isValidMosaicTree,
  removeFromMosaicTree,
} from '../utils/mosaic.ts';

export type MosaicLayoutMode = 'equal' | 'focus' | 'auto' | 'none';
export type EqualLayoutPreset = 'smart' | 'columns';

export interface PersistedMosaicLayout {
  schemaVersion: 1;
  tree: MosaicNode<string>;
  mode: MosaicLayoutMode;
  focusTarget: string | null;
  savedAt: string;
}

export interface PersistedMosaicLayoutV2 {
  schemaVersion: 2;
  tree: MosaicNode<string>;
  mode: MosaicLayoutMode;
  focusTarget: string | null;
  equalPreset: EqualLayoutPreset;
  savedAt: string;
}

export type AnyPersistedMosaicLayout = PersistedMosaicLayout | PersistedMosaicLayoutV2;

const STORAGE_KEY_PREFIX = 'mosaic_layout_';
const suppressedMosaicLayoutSaveWorkspaces = new Set<string>();

export function getMosaicLayoutStorageKey(workspaceId: string): string {
  return STORAGE_KEY_PREFIX + workspaceId;
}

export function suppressMosaicLayoutSaveForWorkspace(workspaceId: string): void {
  suppressedMosaicLayoutSaveWorkspaces.add(workspaceId);
}

export function releaseMosaicLayoutSaveSuppression(workspaceId: string): void {
  suppressedMosaicLayoutSaveWorkspaces.delete(workspaceId);
}

export function isMosaicLayoutSaveSuppressed(workspaceId: string): boolean {
  return suppressedMosaicLayoutSaveWorkspaces.has(workspaceId);
}

export function clearMosaicLayoutForWorkspace(workspaceId: string, storage: Storage = localStorage): void {
  suppressMosaicLayoutSaveForWorkspace(workspaceId);
  try {
    storage.removeItem(getMosaicLayoutStorageKey(workspaceId));
  } catch {
    // ignore localStorage failures
  }
}

export function saveMosaicLayoutForWorkspace(
  workspaceId: string,
  tree: MosaicNode<string> | null,
  mode: MosaicLayoutMode,
  focusTarget: string | null,
  storage: Storage = localStorage,
  equalPreset: EqualLayoutPreset = 'smart',
): boolean {
  if (isMosaicLayoutSaveSuppressed(workspaceId)) return false;
  if (!tree) {
    try {
      storage.removeItem(getMosaicLayoutStorageKey(workspaceId));
      return true;
    } catch {
      return false;
    }
  }

  try {
    const data: PersistedMosaicLayoutV2 = {
      schemaVersion: 2,
      tree,
      mode,
      focusTarget,
      equalPreset,
      savedAt: new Date().toISOString(),
    };
    storage.setItem(getMosaicLayoutStorageKey(workspaceId), JSON.stringify(data));
    return true;
  } catch (e) {
    console.warn('[useMosaicLayout] localStorage quota exceeded, skipping save:', e);
    return false;
  }
}

export function readPersistedMosaicLayout(
  workspaceId: string,
  storage: Storage = localStorage,
): AnyPersistedMosaicLayout | null {
  try {
    const raw = storage.getItem(getMosaicLayoutStorageKey(workspaceId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AnyPersistedMosaicLayout>;
    if (parsed.schemaVersion !== 1 && parsed.schemaVersion !== 2) {
      return null;
    }
    if (!isValidMosaicTree(parsed.tree)) {
      return null;
    }
    if (parsed.schemaVersion === 2 && parsed.equalPreset !== 'smart' && parsed.equalPreset !== 'columns') {
      return null;
    }
    return parsed as AnyPersistedMosaicLayout;
  } catch {
    return null;
  }
}

export function pruneMosaicLayoutForDeletedTab(
  workspaceId: string,
  tabId: string,
  storage: Storage = localStorage,
): boolean {
  const persisted = readPersistedMosaicLayout(workspaceId, storage);
  if (!persisted) {
    return false;
  }

  if (!containsLeaf(persisted.tree, tabId)) {
    return false;
  }
  const nextTree = removeFromMosaicTree(persisted.tree, tabId);
  if (!nextTree) {
    try {
      storage.removeItem(getMosaicLayoutStorageKey(workspaceId));
      return true;
    } catch {
      return false;
    }
  }

  const focusTarget = persisted.focusTarget === tabId ? null : persisted.focusTarget;
  const mode = focusTarget === null && persisted.mode === 'focus' ? 'equal' : persisted.mode;
  const equalPreset = persisted.schemaVersion === 2 ? persisted.equalPreset : 'smart';
  return saveMosaicLayoutForWorkspace(workspaceId, nextTree, mode, focusTarget, storage, equalPreset);
}

export function pruneMosaicLayoutForMovedTab(
  workspaceId: string,
  tabId: string,
  storage: Storage = localStorage,
): boolean {
  return pruneMosaicLayoutForDeletedTab(workspaceId, tabId, storage);
}
