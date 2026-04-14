import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type MutableRefObject,
  type ReactNode,
} from 'react';
import type { TerminalHandle } from '../components/Terminal/TerminalView';

export type TerminalHostSlotKind = 'tab-active' | 'tab-hidden' | 'grid-pane';

export interface TerminalHostSlotRegistration {
  slotId: string;
  sessionId: string;
  tabId: string;
  slotKind: TerminalHostSlotKind;
  visible: boolean;
  attached: boolean;
}

export interface TerminalRuntimeSnapshot {
  sessionId: string;
  runtimeGeneration: number;
  activeConsumerCount: number;
  consumerMountCount: number;
  attachedHandle: boolean;
  tabIds: string[];
  hostSlots: TerminalHostSlotRegistration[];
}

export interface TerminalRuntimeRegistryStatsSnapshot {
  runtimeCreateCount: number;
  runtimeDestroyCount: number;
  hostAttachCount: number;
  maxActiveConsumerCountObserved: number;
  orphanRuntimeCount: number;
  unattachedRuntimeCount: number;
}

export interface TerminalRuntimeRegistrySnapshot {
  tabBindings: Array<{ tabId: string; sessionId: string }>;
  runtimes: TerminalRuntimeSnapshot[];
  stats: TerminalRuntimeRegistryStatsSnapshot;
}

interface TerminalRuntimeEntry {
  sessionId: string;
  runtimeGeneration: number;
  activeConsumerCount: number;
  consumerMountCount: number;
  handleRef: MutableRefObject<TerminalHandle | null> | null;
  tabIds: Set<string>;
  hostSlots: Map<string, TerminalHostSlotRegistration>;
}

interface TerminalRuntimeRegistryDebugStore {
  getSnapshot: () => TerminalRuntimeRegistrySnapshot;
}

interface TerminalRuntimeRegistryActionsValue {
  ensureTabHandleRef: (tabId: string) => MutableRefObject<TerminalHandle | null>;
  getHandleByTabId: (tabId: string) => TerminalHandle | null;
  syncTabBindings: (bindings: Array<{ tabId: string; sessionId: string }>) => void;
  registerRuntimeConsumer: (sessionId: string) => () => void;
  attachRuntimeHandleRef: (
    sessionId: string,
    handleRef: MutableRefObject<TerminalHandle | null>,
  ) => () => void;
  upsertHostSlot: (slot: TerminalHostSlotRegistration) => void;
  removeHostSlot: (slotId: string) => void;
  getSnapshot: () => TerminalRuntimeRegistrySnapshot;
}

declare global {
  interface Window {
    __buildergateTerminalRuntimeRegistry?: TerminalRuntimeRegistryDebugStore;
  }
}

const TerminalRuntimeRegistryContext = createContext<TerminalRuntimeRegistryActionsValue | null>(null);

export function TerminalRuntimeRegistryProvider({ children }: { children: ReactNode }) {
  const runtimesRef = useRef<Map<string, TerminalRuntimeEntry>>(new Map());
  const tabBindingsRef = useRef<Map<string, string>>(new Map());
  const tabHandleRefsRef = useRef<Map<string, MutableRefObject<TerminalHandle | null>>>(new Map());
  const hostSlotIndexRef = useRef<Map<string, string>>(new Map());
  const runtimeGenerationCounterRef = useRef(0);
  const runtimeDestroyCountRef = useRef(0);
  const hostAttachCountRef = useRef(0);
  const maxActiveConsumerCountObservedRef = useRef(0);

  const cleanupRuntimeIfEmpty = useCallback((sessionId: string) => {
    const runtime = runtimesRef.current.get(sessionId);
    if (!runtime) return;
    if (runtime.activeConsumerCount > 0) return;
    if (runtime.tabIds.size > 0) return;
    if (runtime.hostSlots.size > 0) return;
    if (runtime.handleRef?.current) return;
    runtimesRef.current.delete(sessionId);
    runtimeDestroyCountRef.current += 1;
  }, []);

  const ensureRuntimeEntry = useCallback((sessionId: string): TerminalRuntimeEntry => {
    let runtime = runtimesRef.current.get(sessionId);
    if (!runtime) {
      runtime = {
        sessionId,
        runtimeGeneration: ++runtimeGenerationCounterRef.current,
        activeConsumerCount: 0,
        consumerMountCount: 0,
        handleRef: null,
        tabIds: new Set<string>(),
        hostSlots: new Map<string, TerminalHostSlotRegistration>(),
      };
      runtimesRef.current.set(sessionId, runtime);
    }
    return runtime;
  }, []);

  const removeTabBinding = useCallback((tabId: string) => {
    const sessionId = tabBindingsRef.current.get(tabId);
    if (!sessionId) return;

    const runtime = runtimesRef.current.get(sessionId);
    runtime?.tabIds.delete(tabId);
    tabBindingsRef.current.delete(tabId);
    tabHandleRefsRef.current.delete(tabId);
    cleanupRuntimeIfEmpty(sessionId);
  }, [cleanupRuntimeIfEmpty]);

  const ensureTabHandleRef = useCallback((tabId: string) => {
    let handleRef = tabHandleRefsRef.current.get(tabId);
    if (!handleRef) {
      handleRef = { current: null };
      tabHandleRefsRef.current.set(tabId, handleRef);
    }
    return handleRef;
  }, []);

  const getHandleByTabId = useCallback((tabId: string) => {
    return tabHandleRefsRef.current.get(tabId)?.current ?? null;
  }, []);

  const syncTabBindings = useCallback((bindings: Array<{ tabId: string; sessionId: string }>) => {
    const nextBindings = new Map<string, string>();
    for (const binding of bindings) {
      nextBindings.set(binding.tabId, binding.sessionId);
      ensureTabHandleRef(binding.tabId);
    }

    for (const [tabId] of tabBindingsRef.current) {
      if (!nextBindings.has(tabId)) {
        removeTabBinding(tabId);
      }
    }

    for (const [tabId, sessionId] of nextBindings) {
      const previousSessionId = tabBindingsRef.current.get(tabId);
      if (previousSessionId && previousSessionId !== sessionId) {
        const previousRuntime = runtimesRef.current.get(previousSessionId);
        previousRuntime?.tabIds.delete(tabId);
        cleanupRuntimeIfEmpty(previousSessionId);
      }

      tabBindingsRef.current.set(tabId, sessionId);
      ensureRuntimeEntry(sessionId).tabIds.add(tabId);
    }
  }, [cleanupRuntimeIfEmpty, ensureRuntimeEntry, ensureTabHandleRef, removeTabBinding]);

  const registerRuntimeConsumer = useCallback((sessionId: string) => {
    const runtime = ensureRuntimeEntry(sessionId);
    runtime.activeConsumerCount += 1;
    runtime.consumerMountCount += 1;
    maxActiveConsumerCountObservedRef.current = Math.max(
      maxActiveConsumerCountObservedRef.current,
      runtime.activeConsumerCount,
    );

    return () => {
      const current = runtimesRef.current.get(sessionId);
      if (!current) return;
      current.activeConsumerCount = Math.max(0, current.activeConsumerCount - 1);
      cleanupRuntimeIfEmpty(sessionId);
    };
  }, [cleanupRuntimeIfEmpty, ensureRuntimeEntry]);

  const attachRuntimeHandleRef = useCallback((
    sessionId: string,
    handleRef: MutableRefObject<TerminalHandle | null>,
  ) => {
    const runtime = ensureRuntimeEntry(sessionId);
    runtime.handleRef = handleRef;

    return () => {
      const current = runtimesRef.current.get(sessionId);
      if (!current) return;
      if (current.handleRef === handleRef) {
        current.handleRef = null;
      }
      cleanupRuntimeIfEmpty(sessionId);
    };
  }, [cleanupRuntimeIfEmpty, ensureRuntimeEntry]);

  const upsertHostSlot = useCallback((slot: TerminalHostSlotRegistration) => {
    const previousSessionId = hostSlotIndexRef.current.get(slot.slotId);
    const previousRuntime = previousSessionId ? runtimesRef.current.get(previousSessionId) : null;
    const previousSlot = previousRuntime?.hostSlots.get(slot.slotId);
    if (previousSessionId && previousSessionId !== slot.sessionId) {
      previousRuntime?.hostSlots.delete(slot.slotId);
      cleanupRuntimeIfEmpty(previousSessionId);
    }

    const runtime = ensureRuntimeEntry(slot.sessionId);
    if (!previousSlot || previousSessionId !== slot.sessionId) {
      hostAttachCountRef.current += 1;
    }
    runtime.hostSlots.set(slot.slotId, slot);
    hostSlotIndexRef.current.set(slot.slotId, slot.sessionId);
  }, [cleanupRuntimeIfEmpty, ensureRuntimeEntry]);

  const removeHostSlot = useCallback((slotId: string) => {
    const sessionId = hostSlotIndexRef.current.get(slotId);
    if (!sessionId) return;
    const runtime = runtimesRef.current.get(sessionId);
    runtime?.hostSlots.delete(slotId);
    hostSlotIndexRef.current.delete(slotId);
    cleanupRuntimeIfEmpty(sessionId);
  }, [cleanupRuntimeIfEmpty]);

  const getSnapshot = useCallback((): TerminalRuntimeRegistrySnapshot => {
    const runtimes = Array.from(runtimesRef.current.values()).map((runtime) => ({
      sessionId: runtime.sessionId,
      runtimeGeneration: runtime.runtimeGeneration,
      activeConsumerCount: runtime.activeConsumerCount,
      consumerMountCount: runtime.consumerMountCount,
      attachedHandle: Boolean(runtime.handleRef?.current),
      tabIds: Array.from(runtime.tabIds.values()),
      hostSlots: Array.from(runtime.hostSlots.values()),
    }));

    const orphanRuntimeCount = runtimes.filter((runtime) => runtime.tabIds.length === 0).length;
    const unattachedRuntimeCount = runtimes.filter((runtime) =>
      !runtime.hostSlots.some((slot) => slot.attached),
    ).length;

    return {
      tabBindings: Array.from(tabBindingsRef.current.entries()).map(([tabId, sessionId]) => ({
        tabId,
        sessionId,
      })),
      runtimes,
      stats: {
        runtimeCreateCount: runtimeGenerationCounterRef.current,
        runtimeDestroyCount: runtimeDestroyCountRef.current,
        hostAttachCount: hostAttachCountRef.current,
        maxActiveConsumerCountObserved: maxActiveConsumerCountObservedRef.current,
        orphanRuntimeCount,
        unattachedRuntimeCount,
      },
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.__buildergateTerminalRuntimeRegistry = { getSnapshot };
    return () => {
      delete window.__buildergateTerminalRuntimeRegistry;
    };
  }, [getSnapshot]);

  const value = useMemo<TerminalRuntimeRegistryActionsValue>(() => ({
    ensureTabHandleRef,
    getHandleByTabId,
    syncTabBindings,
    registerRuntimeConsumer,
    attachRuntimeHandleRef,
    upsertHostSlot,
    removeHostSlot,
    getSnapshot,
  }), [
    ensureTabHandleRef,
    getHandleByTabId,
    syncTabBindings,
    registerRuntimeConsumer,
    attachRuntimeHandleRef,
    upsertHostSlot,
    removeHostSlot,
    getSnapshot,
  ]);

  return (
    <TerminalRuntimeRegistryContext.Provider value={value}>
      {children}
    </TerminalRuntimeRegistryContext.Provider>
  );
}

export function useTerminalRuntimeRegistryActions(): TerminalRuntimeRegistryActionsValue {
  const ctx = useContext(TerminalRuntimeRegistryContext);
  if (!ctx) {
    throw new Error('useTerminalRuntimeRegistryActions must be used within TerminalRuntimeRegistryProvider');
  }
  return ctx;
}
