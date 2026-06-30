import type { MosaicNode } from '../types/workspace';
import {
  containsLeaf,
  isValidMosaicTree,
  removeFromMosaicTree,
} from '../utils/mosaic.ts';

export type MosaicLayoutMode = 'equal' | 'focus' | 'auto' | 'none';
export interface PersistedMosaicLayout {
  schemaVersion: 1;
  tree: MosaicNode<string>;
  mode: MosaicLayoutMode;
  focusTarget: string | null;
  savedAt: string;
}

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
    const data: PersistedMosaicLayout = {
      schemaVersion: 1,
      tree,
      mode,
      focusTarget,
      savedAt: new Date().toISOString(),
    };
    storage.setItem(getMosaicLayoutStorageKey(workspaceId), JSON.stringify(data));
    return true;
  } catch (e) {
    console.warn('[useMosaicLayout] localStorage quota exceeded, skipping save:', e);
    return false;
  }
}

export function pruneMosaicLayoutForDeletedTab(
  workspaceId: string,
  tabId: string,
  storage: Storage = localStorage,
): boolean {
  let persisted: PersistedMosaicLayout | null = null;
  try {
    const raw = storage.getItem(getMosaicLayoutStorageKey(workspaceId));
    if (!raw) return false;
    const parsed = JSON.parse(raw) as Partial<PersistedMosaicLayout>;
    if (parsed.schemaVersion !== 1 || !isValidMosaicTree(parsed.tree)) {
      return false;
    }
    persisted = parsed as PersistedMosaicLayout;
  } catch {
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
  return saveMosaicLayoutForWorkspace(workspaceId, nextTree, mode, focusTarget, storage);
}
