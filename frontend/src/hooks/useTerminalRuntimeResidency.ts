import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type {
  GridLayout,
  MosaicNode,
  Workspace,
  WorkspaceTabRuntime,
} from '../types/workspace';
import {
  getFrontendRuntimeResidencyMode,
  getRuntimeConfigVersion,
  getWorkspaceRuntimeResourceLimits,
  subscribeRuntimeConfigChanges,
} from '../utils/inputReliabilityMode.ts';
import type {
  FrontendRuntimeResidencyMode,
  WorkspaceRuntimeResourceLimitsRuntimeConfig,
} from '../utils/inputReliabilityMode';

export interface TerminalRuntimeResidencyMetadata {
  tabId: string;
  workspaceId: string;
  sessionId: string;
  lastAccessedAt: number;
  hiddenSince: number | null;
  workspaceLastAccessedAt: number;
}

export interface TerminalRuntimeResidencyResult {
  residentTabs: WorkspaceTabRuntime[];
  evictedTabIds: string[];
  pinnedTabIds: string[];
}

export interface ResolveTerminalRuntimeResidencyInput {
  tabs: WorkspaceTabRuntime[];
  pinnedTabIds: Set<string>;
  activeWorkspaceId: string | null;
  now: number;
  limits: WorkspaceRuntimeResourceLimitsRuntimeConfig;
  frontendRuntimeResidencyMode?: FrontendRuntimeResidencyMode;
  metadataByTabId: Record<string, TerminalRuntimeResidencyMetadata>;
}

export interface TerminalRuntimeResidencyRefreshDelayInput {
  tabs: WorkspaceTabRuntime[];
  pinnedTabIds: Set<string>;
  now: number;
  limits: WorkspaceRuntimeResourceLimitsRuntimeConfig;
  metadataByTabId: Record<string, TerminalRuntimeResidencyMetadata>;
}

interface UseTerminalRuntimeResidencyInput {
  tabs: WorkspaceTabRuntime[];
  workspaces: Workspace[];
  gridLayouts: GridLayout[];
  activeWorkspaceId: string | null;
  isMobile: boolean;
}

export function collectMosaicLeafIds(node: MosaicNode<string> | null): string[] {
  if (!node) {
    return [];
  }
  if (typeof node === 'string') {
    return [node];
  }
  return [
    ...collectMosaicLeafIds(node.first),
    ...collectMosaicLeafIds(node.second),
  ];
}

export function resolveVisibleTerminalTabIds(input: {
  tabs: WorkspaceTabRuntime[];
  workspaces: Workspace[];
  gridLayouts: GridLayout[];
  activeWorkspaceId: string | null;
  isMobile: boolean;
}): Set<string> {
  const activeWorkspace = input.workspaces.find(workspace => workspace.id === input.activeWorkspaceId);
  if (!activeWorkspace) {
    return new Set();
  }

  if (input.isMobile || activeWorkspace.viewMode === 'tab') {
    return activeWorkspace.activeTabId ? new Set([activeWorkspace.activeTabId]) : new Set();
  }

  const activeWorkspaceTabIds = new Set(
    input.tabs
      .filter(tab => tab.workspaceId === activeWorkspace.id)
      .map(tab => tab.id),
  );
  const layout = input.gridLayouts.find(candidate => candidate.workspaceId === activeWorkspace.id);
  const visibleIds = collectMosaicLeafIds(layout?.mosaicTree ?? null)
    .filter(tabId => activeWorkspaceTabIds.has(tabId));
  if (visibleIds.length > 0 && visibleIds.length === activeWorkspaceTabIds.size) {
    return new Set(visibleIds);
  }
  if (activeWorkspaceTabIds.size > 0) {
    return activeWorkspaceTabIds;
  }
  return activeWorkspace.activeTabId ? new Set([activeWorkspace.activeTabId]) : new Set();
}

export function resolveTerminalRuntimeResidency(input: ResolveTerminalRuntimeResidencyInput): TerminalRuntimeResidencyResult {
  const runnableTabs = input.tabs.filter(tab => tab.status !== 'disconnected');
  const runnableTabIds = new Set(runnableTabs.map(tab => tab.id));
  const pinnedTabIds = new Set(
    [...input.pinnedTabIds].filter(tabId => runnableTabIds.has(tabId)),
  );
  if (input.frontendRuntimeResidencyMode !== 'bounded') {
    return {
      residentTabs: runnableTabs,
      evictedTabIds: input.tabs
        .filter(tab => tab.status === 'disconnected')
        .map(tab => tab.id),
      pinnedTabIds: [...pinnedTabIds],
    };
  }

  const residentIds = new Set<string>(pinnedTabIds);
  const hiddenTabs = runnableTabs.filter(tab => !pinnedTabIds.has(tab.id));
  const protectedHiddenTabs: WorkspaceTabRuntime[] = [];
  const eligibleHiddenTabs: WorkspaceTabRuntime[] = [];

  for (const tab of hiddenTabs) {
    const metadata = input.metadataByTabId[tab.id];
    const hiddenSince = metadata?.hiddenSince;
    const eligible = input.limits.hiddenRuntimeTtlMs <= 0
      || (hiddenSince !== null && hiddenSince !== undefined && input.now - hiddenSince >= input.limits.hiddenRuntimeTtlMs);
    if (eligible) {
      eligibleHiddenTabs.push(tab);
    } else {
      protectedHiddenTabs.push(tab);
    }
  }

  for (const tab of protectedHiddenTabs) {
    residentIds.add(tab.id);
  }

  const hiddenBudget = Math.max(0, input.limits.maxLiveTerminals - residentIds.size);
  const hiddenToKeep = [...eligibleHiddenTabs]
    .sort((a, b) => {
      const aAccessed = input.metadataByTabId[a.id]?.lastAccessedAt ?? 0;
      const bAccessed = input.metadataByTabId[b.id]?.lastAccessedAt ?? 0;
      if (aAccessed !== bAccessed) return bAccessed - aAccessed;
      return a.id.localeCompare(b.id);
    })
    .slice(0, hiddenBudget);

  for (const tab of hiddenToKeep) {
    residentIds.add(tab.id);
  }

  applyWorkspaceCap({
    residentIds,
    tabs: runnableTabs,
    pinnedTabIds,
    activeWorkspaceId: input.activeWorkspaceId,
    maxLiveWorkspaces: input.limits.maxLiveWorkspaces,
    metadataByTabId: input.metadataByTabId,
  });

  const residentTabs = input.tabs.filter(tab => tab.status !== 'disconnected' && residentIds.has(tab.id));
  const evictedTabIds = input.tabs
    .filter(tab => tab.status === 'disconnected' || !residentIds.has(tab.id))
    .map(tab => tab.id);

  return {
    residentTabs,
    evictedTabIds,
    pinnedTabIds: [...pinnedTabIds],
  };
}

export function getNextTerminalRuntimeResidencyRefreshDelay(input: TerminalRuntimeResidencyRefreshDelayInput): number | null {
  if (input.limits.hiddenRuntimeTtlMs <= 0) {
    return null;
  }

  let nextDelay: number | null = null;
  for (const tab of input.tabs) {
    if (tab.status === 'disconnected' || input.pinnedTabIds.has(tab.id)) {
      continue;
    }
    const hiddenSince = input.metadataByTabId[tab.id]?.hiddenSince;
    if (hiddenSince === null || hiddenSince === undefined) {
      continue;
    }
    const remainingMs = input.limits.hiddenRuntimeTtlMs - Math.max(0, input.now - hiddenSince);
    if (remainingMs <= 0) {
      continue;
    }
    nextDelay = nextDelay === null ? remainingMs : Math.min(nextDelay, remainingMs);
  }

  return nextDelay;
}

function applyWorkspaceCap(input: {
  residentIds: Set<string>;
  tabs: WorkspaceTabRuntime[];
  pinnedTabIds: Set<string>;
  activeWorkspaceId: string | null;
  maxLiveWorkspaces: number;
  metadataByTabId: Record<string, TerminalRuntimeResidencyMetadata>;
}): void {
  const hiddenWorkspaceIds = new Set<string>();
  for (const tab of input.tabs) {
    if (
      input.residentIds.has(tab.id)
      && !input.pinnedTabIds.has(tab.id)
      && tab.workspaceId !== input.activeWorkspaceId
    ) {
      hiddenWorkspaceIds.add(tab.workspaceId);
    }
  }

  if (hiddenWorkspaceIds.size <= input.maxLiveWorkspaces) {
    return;
  }

  const workspacesToKeep = new Set(
    [...hiddenWorkspaceIds]
      .sort((a, b) => {
        const aAccessed = getWorkspaceLastAccessedAt(a, input.metadataByTabId);
        const bAccessed = getWorkspaceLastAccessedAt(b, input.metadataByTabId);
        if (aAccessed !== bAccessed) return bAccessed - aAccessed;
        return a.localeCompare(b);
      })
      .slice(0, input.maxLiveWorkspaces),
  );

  for (const tab of input.tabs) {
    if (
      input.residentIds.has(tab.id)
      && !input.pinnedTabIds.has(tab.id)
      && tab.workspaceId !== input.activeWorkspaceId
      && !workspacesToKeep.has(tab.workspaceId)
    ) {
      input.residentIds.delete(tab.id);
    }
  }
}

function getWorkspaceLastAccessedAt(
  workspaceId: string,
  metadataByTabId: Record<string, TerminalRuntimeResidencyMetadata>,
): number {
  let lastAccessedAt = 0;
  for (const metadata of Object.values(metadataByTabId)) {
    if (metadata.workspaceId === workspaceId) {
      lastAccessedAt = Math.max(lastAccessedAt, metadata.workspaceLastAccessedAt);
    }
  }
  return lastAccessedAt;
}

export function useTerminalRuntimeResidency(input: UseTerminalRuntimeResidencyInput): TerminalRuntimeResidencyResult {
  const metadataRef = useRef<Record<string, TerminalRuntimeResidencyMetadata>>({});
  const [ttlTick, setTtlTick] = useState(0);
  const runtimeConfigVersion = useSyncExternalStore(
    subscribeRuntimeConfigChanges,
    getRuntimeConfigVersion,
    getRuntimeConfigVersion,
  );
  const pinnedTabIds = useMemo(() => resolveVisibleTerminalTabIds(input), [
    input.activeWorkspaceId,
    input.gridLayouts,
    input.isMobile,
    input.tabs,
    input.workspaces,
  ]);
  const pinnedTabKey = [...pinnedTabIds].sort().join('\0');

  const limits = getWorkspaceRuntimeResourceLimits();
  const frontendRuntimeResidencyMode = getFrontendRuntimeResidencyMode();
  const result = useMemo(() => {
    const now = Date.now();
    const currentTabIds = new Set(input.tabs.map(tab => tab.id));
    const nextMetadata: Record<string, TerminalRuntimeResidencyMetadata> = {};

    for (const tab of input.tabs) {
      const previous = metadataRef.current[tab.id];
      const isPinned = pinnedTabIds.has(tab.id);
      const workspaceLastAccessedAt = isPinned
        ? now
        : previous?.workspaceLastAccessedAt ?? now;
      nextMetadata[tab.id] = {
        tabId: tab.id,
        workspaceId: tab.workspaceId,
        sessionId: tab.sessionId,
        lastAccessedAt: isPinned ? now : previous?.lastAccessedAt ?? now,
        hiddenSince: isPinned ? null : previous?.hiddenSince ?? now,
        workspaceLastAccessedAt,
      };
    }

    for (const tabId of Object.keys(metadataRef.current)) {
      if (!currentTabIds.has(tabId)) {
        delete metadataRef.current[tabId];
      }
    }
    metadataRef.current = nextMetadata;

    return resolveTerminalRuntimeResidency({
      tabs: input.tabs,
      pinnedTabIds,
      activeWorkspaceId: input.activeWorkspaceId,
      now,
      limits,
      frontendRuntimeResidencyMode,
      metadataByTabId: nextMetadata,
    });
  }, [
    input.activeWorkspaceId,
    input.tabs,
    limits,
    frontendRuntimeResidencyMode,
    pinnedTabIds,
    pinnedTabKey,
    runtimeConfigVersion,
    ttlTick,
  ]);

  useEffect(() => {
    if (frontendRuntimeResidencyMode !== 'bounded') {
      return undefined;
    }

    const delay = getNextTerminalRuntimeResidencyRefreshDelay({
      tabs: input.tabs,
      pinnedTabIds,
      now: Date.now(),
      limits,
      metadataByTabId: metadataRef.current,
    });
    if (delay === null) {
      return undefined;
    }

    const timer = setTimeout(() => {
      setTtlTick(value => value + 1);
    }, Math.max(1, delay));
    return () => clearTimeout(timer);
  }, [frontendRuntimeResidencyMode, input.tabs, limits, pinnedTabIds, pinnedTabKey, result, runtimeConfigVersion]);

  return result;
}
