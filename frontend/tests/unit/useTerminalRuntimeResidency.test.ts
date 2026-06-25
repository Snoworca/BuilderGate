import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  getNextTerminalRuntimeResidencyRefreshDelay,
  resolveTerminalRuntimeResidency,
  type TerminalRuntimeResidencyMetadata,
} from '../../src/hooks/useTerminalRuntimeResidency.ts';
import type { WorkspaceTabRuntime } from '../../src/types/workspace.ts';

function tab(id: string, workspaceId: string, status: WorkspaceTabRuntime['status'] = 'idle'): WorkspaceTabRuntime {
  return {
    id,
    workspaceId,
    sessionId: `session-${id}`,
    name: id,
    colorIndex: 0,
    sortOrder: 0,
    shellType: 'powershell',
    createdAt: '2026-06-17T00:00:00.000Z',
    status,
    cwd: '',
  };
}

function metadata(entries: Array<[string, Partial<TerminalRuntimeResidencyMetadata>]>): Record<string, TerminalRuntimeResidencyMetadata> {
  return Object.fromEntries(entries.map(([tabId, overrides]) => [tabId, {
    tabId,
    workspaceId: overrides.workspaceId ?? 'workspace-1',
    sessionId: overrides.sessionId ?? `session-${tabId}`,
    lastAccessedAt: overrides.lastAccessedAt ?? 0,
    hiddenSince: overrides.hiddenSince ?? 0,
    workspaceLastAccessedAt: overrides.workspaceLastAccessedAt ?? 0,
    ...overrides,
  }]));
}

test('runtime residency always pins visible terminals even when terminal cap is lower', () => {
  const result = resolveTerminalRuntimeResidency({
    tabs: [tab('t1', 'w1'), tab('t2', 'w1'), tab('t3', 'w1')],
    pinnedTabIds: new Set(['t1', 't2']),
    activeWorkspaceId: 'w1',
    now: 10_000,
    limits: { maxLiveWorkspaces: 1, maxLiveTerminals: 1, hiddenRuntimeTtlMs: 0 },
    frontendRuntimeResidencyMode: 'bounded',
    metadataByTabId: metadata([
      ['t1', { workspaceId: 'w1', lastAccessedAt: 10_000, hiddenSince: null }],
      ['t2', { workspaceId: 'w1', lastAccessedAt: 10_000, hiddenSince: null }],
      ['t3', { workspaceId: 'w1', lastAccessedAt: 1, hiddenSince: 1 }],
    ]),
  });

  assert.deepEqual(result.residentTabs.map(item => item.id), ['t1', 't2']);
  assert.deepEqual(result.evictedTabIds, ['t3']);
});

test('runtime residency evicts oldest eligible hidden terminal and excludes disconnected tabs', () => {
  const result = resolveTerminalRuntimeResidency({
    tabs: [
      tab('active', 'w1'),
      tab('newer-hidden', 'w2'),
      tab('older-hidden', 'w3'),
      tab('disconnected', 'w4', 'disconnected'),
    ],
    pinnedTabIds: new Set(['active']),
    activeWorkspaceId: 'w1',
    now: 10_000,
    limits: { maxLiveWorkspaces: 4, maxLiveTerminals: 2, hiddenRuntimeTtlMs: 0 },
    frontendRuntimeResidencyMode: 'bounded',
    metadataByTabId: metadata([
      ['active', { workspaceId: 'w1', lastAccessedAt: 10_000, hiddenSince: null }],
      ['newer-hidden', { workspaceId: 'w2', lastAccessedAt: 9_000, hiddenSince: 1 }],
      ['older-hidden', { workspaceId: 'w3', lastAccessedAt: 8_000, hiddenSince: 1 }],
      ['disconnected', { workspaceId: 'w4', lastAccessedAt: 9_500, hiddenSince: 1 }],
    ]),
  });

  assert.deepEqual(result.residentTabs.map(item => item.id), ['active', 'newer-hidden']);
  assert.deepEqual(result.evictedTabIds, ['older-hidden', 'disconnected']);
});

test('runtime residency keeps recently hidden terminals until hidden TTL expires', () => {
  const result = resolveTerminalRuntimeResidency({
    tabs: [tab('active', 'w1'), tab('recent-hidden', 'w2')],
    pinnedTabIds: new Set(['active']),
    activeWorkspaceId: 'w1',
    now: 10_000,
    limits: { maxLiveWorkspaces: 2, maxLiveTerminals: 1, hiddenRuntimeTtlMs: 5_000 },
    frontendRuntimeResidencyMode: 'bounded',
    metadataByTabId: metadata([
      ['active', { workspaceId: 'w1', lastAccessedAt: 10_000, hiddenSince: null }],
      ['recent-hidden', { workspaceId: 'w2', lastAccessedAt: 9_000, hiddenSince: 8_000 }],
    ]),
  });

  assert.deepEqual(result.residentTabs.map(item => item.id), ['active', 'recent-hidden']);
  assert.deepEqual(result.evictedTabIds, []);
});

test('runtime residency applies workspace cap to hidden workspaces while excluding the active workspace', () => {
  const result = resolveTerminalRuntimeResidency({
    tabs: [tab('active', 'w1'), tab('workspace-newer', 'w2'), tab('workspace-older', 'w3')],
    pinnedTabIds: new Set(['active']),
    activeWorkspaceId: 'w1',
    now: 10_000,
    limits: { maxLiveWorkspaces: 1, maxLiveTerminals: 10, hiddenRuntimeTtlMs: 0 },
    frontendRuntimeResidencyMode: 'bounded',
    metadataByTabId: metadata([
      ['active', { workspaceId: 'w1', lastAccessedAt: 10_000, hiddenSince: null, workspaceLastAccessedAt: 10_000 }],
      ['workspace-newer', { workspaceId: 'w2', lastAccessedAt: 9_000, hiddenSince: 1, workspaceLastAccessedAt: 9_000 }],
      ['workspace-older', { workspaceId: 'w3', lastAccessedAt: 8_000, hiddenSince: 1, workspaceLastAccessedAt: 8_000 }],
    ]),
  });

  assert.deepEqual(result.residentTabs.map(item => item.id), ['active', 'workspace-newer']);
  assert.deepEqual(result.evictedTabIds, ['workspace-older']);
});

test('runtime residency legacy mode keeps all runnable terminals resident', () => {
  const result = resolveTerminalRuntimeResidency({
    tabs: [
      tab('active', 'w1'),
      tab('hidden-a', 'w2'),
      tab('hidden-b', 'w3'),
      tab('disconnected', 'w4', 'disconnected'),
    ],
    pinnedTabIds: new Set(['active']),
    activeWorkspaceId: 'w1',
    now: 10_000,
    limits: { maxLiveWorkspaces: 1, maxLiveTerminals: 1, hiddenRuntimeTtlMs: 0 },
    frontendRuntimeResidencyMode: 'legacy',
    metadataByTabId: metadata([
      ['active', { workspaceId: 'w1', hiddenSince: null }],
      ['hidden-a', { workspaceId: 'w2', hiddenSince: 1 }],
      ['hidden-b', { workspaceId: 'w3', hiddenSince: 1 }],
      ['disconnected', { workspaceId: 'w4', hiddenSince: 1 }],
    ]),
  });

  assert.deepEqual(result.residentTabs.map(item => item.id), ['active', 'hidden-a', 'hidden-b']);
  assert.deepEqual(result.evictedTabIds, ['disconnected']);
  assert.deepEqual(result.pinnedTabIds, ['active']);
});

test('runtime residency defaults omitted mode to legacy no-op behavior', () => {
  const result = resolveTerminalRuntimeResidency({
    tabs: [tab('active', 'w1'), tab('hidden', 'w2')],
    pinnedTabIds: new Set(['active']),
    activeWorkspaceId: 'w1',
    now: 10_000,
    limits: { maxLiveWorkspaces: 1, maxLiveTerminals: 1, hiddenRuntimeTtlMs: 0 },
    metadataByTabId: metadata([
      ['active', { workspaceId: 'w1', hiddenSince: null }],
      ['hidden', { workspaceId: 'w2', hiddenSince: 1 }],
    ]),
  });

  assert.deepEqual(result.residentTabs.map(item => item.id), ['active', 'hidden']);
  assert.deepEqual(result.evictedTabIds, []);
});

test('runtime residency off mode keeps all runnable terminals resident', () => {
  const result = resolveTerminalRuntimeResidency({
    tabs: [tab('active', 'w1'), tab('hidden', 'w2')],
    pinnedTabIds: new Set(['active']),
    activeWorkspaceId: 'w1',
    now: 10_000,
    limits: { maxLiveWorkspaces: 1, maxLiveTerminals: 1, hiddenRuntimeTtlMs: 0 },
    frontendRuntimeResidencyMode: 'off',
    metadataByTabId: metadata([
      ['active', { workspaceId: 'w1', hiddenSince: null }],
      ['hidden', { workspaceId: 'w2', hiddenSince: 1 }],
    ]),
  });

  assert.deepEqual(result.residentTabs.map(item => item.id), ['active', 'hidden']);
  assert.deepEqual(result.evictedTabIds, []);
});

test('runtime residency schedules a refresh when hidden TTL will expire without other renders', () => {
  const delay = getNextTerminalRuntimeResidencyRefreshDelay({
    tabs: [tab('active', 'w1'), tab('recent-hidden', 'w2')],
    pinnedTabIds: new Set(['active']),
    now: 10_000,
    limits: { maxLiveWorkspaces: 2, maxLiveTerminals: 1, hiddenRuntimeTtlMs: 5_000 },
    metadataByTabId: metadata([
      ['active', { workspaceId: 'w1', lastAccessedAt: 10_000, hiddenSince: null }],
      ['recent-hidden', { workspaceId: 'w2', lastAccessedAt: 9_000, hiddenSince: 8_000 }],
    ]),
  });

  assert.equal(delay, 3_000);
});

test('runtime residency does not reschedule immediately for already expired hidden TTL', () => {
  const delay = getNextTerminalRuntimeResidencyRefreshDelay({
    tabs: [tab('active', 'w1'), tab('expired-hidden', 'w2')],
    pinnedTabIds: new Set(['active']),
    now: 10_000,
    limits: { maxLiveWorkspaces: 2, maxLiveTerminals: 10, hiddenRuntimeTtlMs: 5_000 },
    metadataByTabId: metadata([
      ['active', { workspaceId: 'w1', lastAccessedAt: 10_000, hiddenSince: null }],
      ['expired-hidden', { workspaceId: 'w2', lastAccessedAt: 9_000, hiddenSince: 4_000 }],
    ]),
  });

  assert.equal(delay, null);
});
