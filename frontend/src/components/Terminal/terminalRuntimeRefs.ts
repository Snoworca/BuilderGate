import type { TerminalHandle } from './TerminalView';

export type TerminalRuntimeRef = { current: TerminalHandle | null };
export type TerminalRuntimeRefsMap = Map<string, TerminalRuntimeRef>;

export function ensureTerminalRef(refs: TerminalRuntimeRefsMap, tabId: string): TerminalRuntimeRef {
  const existing = refs.get(tabId);
  if (existing) {
    return existing;
  }

  const next: TerminalRuntimeRef = { current: null };
  refs.set(tabId, next);
  return next;
}

export function pruneTerminalRefsMap(refs: TerminalRuntimeRefsMap, residentTabIds: ReadonlySet<string>): string[] {
  const removed: string[] = [];
  for (const tabId of refs.keys()) {
    if (residentTabIds.has(tabId)) {
      continue;
    }
    refs.delete(tabId);
    removed.push(tabId);
  }
  return removed;
}
