import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MosaicNode } from '../../src/types/workspace.ts';
import {
  clearMosaicLayoutForWorkspace,
  getMosaicLayoutStorageKey,
  isMosaicLayoutSaveSuppressed,
  pruneMosaicLayoutForDeletedTab,
  pruneMosaicLayoutForMovedTab,
  releaseMosaicLayoutSaveSuppression,
  saveMosaicLayoutForWorkspace,
} from '../../src/hooks/mosaicLayoutStorage.ts';

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.values.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const tree: MosaicNode<string> = {
  direction: 'row',
  first: 'tab-1',
  second: 'tab-2',
};

test('clearMosaicLayoutForWorkspace removes persisted layout and suppresses later saves', () => {
  const storage = new MemoryStorage();
  const workspaceId = 'workspace-delete';
  const key = getMosaicLayoutStorageKey(workspaceId);

  assert.equal(saveMosaicLayoutForWorkspace(workspaceId, tree, 'equal', null, storage), true);
  assert.equal(storage.getItem(key) !== null, true);

  clearMosaicLayoutForWorkspace(workspaceId, storage);

  assert.equal(storage.getItem(key), null);
  assert.equal(isMosaicLayoutSaveSuppressed(workspaceId), true);
  assert.equal(saveMosaicLayoutForWorkspace(workspaceId, tree, 'equal', null, storage), false);
  assert.equal(storage.getItem(key), null);

  releaseMosaicLayoutSaveSuppression(workspaceId);
});

test('releaseMosaicLayoutSaveSuppression allows a future workspace with the same id to persist', () => {
  const storage = new MemoryStorage();
  const workspaceId = 'workspace-reused';
  const key = getMosaicLayoutStorageKey(workspaceId);

  clearMosaicLayoutForWorkspace(workspaceId, storage);
  releaseMosaicLayoutSaveSuppression(workspaceId);

  assert.equal(saveMosaicLayoutForWorkspace(workspaceId, tree, 'focus', 'tab-1', storage), true);
  assert.equal(storage.getItem(key) !== null, true);
});

test('saveMosaicLayoutForWorkspace removes stale layout when a workspace has no tabs', () => {
  const storage = new MemoryStorage();
  const workspaceId = 'workspace-empty';
  const key = getMosaicLayoutStorageKey(workspaceId);

  assert.equal(saveMosaicLayoutForWorkspace(workspaceId, tree, 'equal', null, storage), true);
  assert.equal(storage.getItem(key) !== null, true);

  assert.equal(saveMosaicLayoutForWorkspace(workspaceId, null, 'equal', null, storage), true);
  assert.equal(storage.getItem(key), null);
});

test('pruneMosaicLayoutForDeletedTab removes a deleted tab from persisted inactive workspace layout', () => {
  const storage = new MemoryStorage();
  const workspaceId = 'workspace-inactive';
  const key = getMosaicLayoutStorageKey(workspaceId);
  assert.equal(saveMosaicLayoutForWorkspace(workspaceId, tree, 'focus', 'tab-2', storage), true);

  const result = pruneMosaicLayoutForDeletedTab(workspaceId, 'tab-2', storage);

  assert.equal(result, true);
  const parsed = JSON.parse(storage.getItem(key) ?? 'null') as { tree: MosaicNode<string>; mode: string; focusTarget: string | null };
  assert.equal(parsed.tree, 'tab-1');
  assert.equal(parsed.mode, 'equal');
  assert.equal(parsed.focusTarget, null);
});

test('pruneMosaicLayoutForDeletedTab removes persisted layout when the deleted tab was the last leaf', () => {
  const storage = new MemoryStorage();
  const workspaceId = 'workspace-last-tab';
  const key = getMosaicLayoutStorageKey(workspaceId);
  assert.equal(saveMosaicLayoutForWorkspace(workspaceId, 'tab-only', 'equal', null, storage), true);

  const result = pruneMosaicLayoutForDeletedTab(workspaceId, 'tab-only', storage);

  assert.equal(result, true);
  assert.equal(storage.getItem(key), null);
});

test('saveMosaicLayoutForWorkspace persists columns equal preset with migrated schema', () => {
  const storage = new MemoryStorage();
  const workspaceId = 'workspace-columns';
  const key = getMosaicLayoutStorageKey(workspaceId);

  assert.equal(saveMosaicLayoutForWorkspace(workspaceId, tree, 'equal', null, storage, 'columns'), true);

  const parsed = JSON.parse(storage.getItem(key) ?? 'null') as {
    schemaVersion: number;
    mode: string;
    equalPreset?: string;
  };
  assert.equal(parsed.schemaVersion, 2);
  assert.equal(parsed.mode, 'equal');
  assert.equal(parsed.equalPreset, 'columns');
});

test('pruneMosaicLayoutForMovedTab removes source leaf without dropping equal preset', () => {
  const storage = new MemoryStorage();
  const workspaceId = 'workspace-source';
  const key = getMosaicLayoutStorageKey(workspaceId);
  assert.equal(saveMosaicLayoutForWorkspace(workspaceId, tree, 'equal', null, storage, 'columns'), true);

  const result = pruneMosaicLayoutForMovedTab(workspaceId, 'tab-2', storage);

  assert.equal(result, true);
  const parsed = JSON.parse(storage.getItem(key) ?? 'null') as {
    tree: MosaicNode<string>;
    mode: string;
    focusTarget: string | null;
    equalPreset?: string;
  };
  assert.equal(parsed.tree, 'tab-1');
  assert.equal(parsed.mode, 'equal');
  assert.equal(parsed.focusTarget, null);
  assert.equal(parsed.equalPreset, 'columns');
});
