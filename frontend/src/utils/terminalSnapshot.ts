const SNAPSHOT_KEY_PREFIX = 'terminal_snapshot_';
const SNAPSHOT_REMOVAL_KEY_PREFIX = 'terminal_snapshot_remove_';
export const TERMINAL_SNAPSHOT_STORAGE_BUDGET_CHARS = 3_000_000;
const pendingSnapshotRemovals = new Set<string>();

type TerminalSnapshotEntryKind = 'snapshot' | 'removal';

export interface TerminalSnapshotStorageEntry {
  key: string;
  sessionId: string;
  kind: TerminalSnapshotEntryKind;
  valueLength: number;
  estimatedChars: number;
  savedAtMs: number;
  corrupt: boolean;
}

export interface TerminalSnapshotEvictionResult {
  removedCount: number;
  removedKeys: string[];
  beforeChars: number;
  afterChars: number;
}

export interface TerminalSnapshotSaveResult {
  saved: boolean;
  retried: boolean;
  eviction: TerminalSnapshotEvictionResult;
  retryEviction?: TerminalSnapshotEvictionResult;
  error?: unknown;
}

export function getTerminalSnapshotKey(sessionId: string): string {
  return `${SNAPSHOT_KEY_PREFIX}${sessionId}`;
}

function getTerminalSnapshotRemovalKey(sessionId: string): string {
  return `${SNAPSHOT_REMOVAL_KEY_PREFIX}${sessionId}`;
}

function isTerminalSnapshotDataKey(key: string): boolean {
  return key.startsWith(SNAPSHOT_KEY_PREFIX) && !key.startsWith(SNAPSHOT_REMOVAL_KEY_PREFIX);
}

function isTerminalSnapshotRemovalKey(key: string): boolean {
  return key.startsWith(SNAPSHOT_REMOVAL_KEY_PREFIX);
}

function getSessionIdFromKey(key: string, kind: TerminalSnapshotEntryKind): string {
  const prefix = kind === 'snapshot' ? SNAPSHOT_KEY_PREFIX : SNAPSHOT_REMOVAL_KEY_PREFIX;
  return key.slice(prefix.length);
}

function parseSavedAtMs(value: string | null): { savedAtMs: number; corrupt: boolean } {
  if (!value) {
    return { savedAtMs: 0, corrupt: false };
  }

  try {
    const parsed = JSON.parse(value) as { savedAt?: unknown };
    if (typeof parsed.savedAt !== 'string') {
      return { savedAtMs: 0, corrupt: false };
    }

    const savedAtMs = Date.parse(parsed.savedAt);
    return {
      savedAtMs: Number.isFinite(savedAtMs) ? savedAtMs : 0,
      corrupt: false,
    };
  } catch {
    return { savedAtMs: 0, corrupt: true };
  }
}

function estimateEntryChars(key: string, value: string | null): number {
  return key.length + (value?.length ?? 0);
}

function sortEvictionCandidates(entries: TerminalSnapshotStorageEntry[]): TerminalSnapshotStorageEntry[] {
  return [...entries].sort((a, b) => {
    if (a.corrupt !== b.corrupt) return a.corrupt ? -1 : 1;
    if (a.kind !== b.kind) return a.kind === 'snapshot' ? -1 : 1;
    if (a.savedAtMs !== b.savedAtMs) return a.savedAtMs - b.savedAtMs;
    if (a.estimatedChars !== b.estimatedChars) return b.estimatedChars - a.estimatedChars;
    return a.key.localeCompare(b.key);
  });
}

export function isQuotaExceededError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const candidate = error as { code?: unknown; name?: unknown; message?: unknown };
  const code = typeof candidate.code === 'number' ? candidate.code : null;
  const name = typeof candidate.name === 'string' ? candidate.name : '';
  const message = typeof candidate.message === 'string' ? candidate.message : '';

  return (
    code === 22 ||
    code === 1014 ||
    name === 'QuotaExceededError' ||
    name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    /quota/i.test(message)
  );
}

export function listTerminalSnapshotStorageEntries(storage: Storage = localStorage): TerminalSnapshotStorageEntry[] {
  const entries: TerminalSnapshotStorageEntry[] = [];

  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key) continue;

    const kind: TerminalSnapshotEntryKind | null = isTerminalSnapshotRemovalKey(key)
      ? 'removal'
      : isTerminalSnapshotDataKey(key)
        ? 'snapshot'
        : null;
    if (!kind) continue;

    const value = storage.getItem(key);
    const parsed = kind === 'snapshot'
      ? parseSavedAtMs(value)
      : value === '1'
        ? { savedAtMs: 0, corrupt: false }
        : parseSavedAtMs(value);

    entries.push({
      key,
      sessionId: getSessionIdFromKey(key, kind),
      kind,
      valueLength: value?.length ?? 0,
      estimatedChars: estimateEntryChars(key, value),
      savedAtMs: parsed.savedAtMs,
      corrupt: parsed.corrupt,
    });
  }

  return entries;
}

export function estimateTerminalSnapshotStorageChars(options: {
  storage?: Storage;
  nextKey?: string;
  nextValue?: string;
} = {}): number {
  const storage = options.storage ?? localStorage;
  const nextKey = options.nextKey;
  let total = 0;

  for (const entry of listTerminalSnapshotStorageEntries(storage)) {
    if (nextKey && entry.key === nextKey) continue;
    total += entry.estimatedChars;
  }

  if (nextKey && options.nextValue !== undefined) {
    total += estimateEntryChars(nextKey, options.nextValue);
  }

  return total;
}

export function evictTerminalSnapshots(options: {
  storage?: Storage;
  preserveSessionId?: string;
  targetMaxChars?: number;
  nextKey?: string;
  nextValue?: string;
  minEntriesToRemove?: number;
} = {}): TerminalSnapshotEvictionResult {
  const storage = options.storage ?? localStorage;
  const targetMaxChars = options.targetMaxChars ?? TERMINAL_SNAPSHOT_STORAGE_BUDGET_CHARS;
  const beforeChars = estimateTerminalSnapshotStorageChars({
    storage,
    nextKey: options.nextKey,
    nextValue: options.nextValue,
  });
  let afterChars = beforeChars;
  const removedKeys: string[] = [];
  const entries = listTerminalSnapshotStorageEntries(storage);
  const candidates = sortEvictionCandidates(entries.filter((entry) => {
    if (options.nextKey && entry.key === options.nextKey) return false;
    if (options.preserveSessionId && entry.sessionId === options.preserveSessionId) return false;
    return true;
  }));
  const minEntriesToRemove = options.minEntriesToRemove ?? 0;

  for (const entry of candidates) {
    if (afterChars <= targetMaxChars && removedKeys.length >= minEntriesToRemove) {
      break;
    }

    try {
      storage.removeItem(entry.key);
      removedKeys.push(entry.key);
      afterChars = Math.max(0, afterChars - entry.estimatedChars);
    } catch {
      // Ignore cleanup failures and continue with the next recoverable cache entry.
    }
  }

  return {
    removedCount: removedKeys.length,
    removedKeys,
    beforeChars,
    afterChars,
  };
}

export function evictTerminalSnapshotsForAuthToken(storage: Storage = localStorage): TerminalSnapshotEvictionResult {
  return evictTerminalSnapshots({
    storage,
    targetMaxChars: Math.floor(TERMINAL_SNAPSHOT_STORAGE_BUDGET_CHARS * 0.75),
    minEntriesToRemove: 1,
  });
}

export function setTerminalSnapshotWithQuotaRecovery(
  sessionId: string,
  value: string,
  options: {
    storage?: Storage;
    maxTotalChars?: number;
  } = {},
): TerminalSnapshotSaveResult {
  const storage = options.storage ?? localStorage;
  const key = getTerminalSnapshotKey(sessionId);
  const eviction = evictTerminalSnapshots({
    storage,
    preserveSessionId: sessionId,
    targetMaxChars: options.maxTotalChars ?? TERMINAL_SNAPSHOT_STORAGE_BUDGET_CHARS,
    nextKey: key,
    nextValue: value,
  });

  try {
    storage.setItem(key, value);
    return { saved: true, retried: false, eviction };
  } catch (error) {
    if (!isQuotaExceededError(error)) {
      throw error;
    }

    const retryEviction = evictTerminalSnapshots({
      storage,
      preserveSessionId: sessionId,
      targetMaxChars: Math.floor((options.maxTotalChars ?? TERMINAL_SNAPSHOT_STORAGE_BUDGET_CHARS) * 0.85),
      nextKey: key,
      nextValue: value,
      minEntriesToRemove: 1,
    });

    try {
      storage.setItem(key, value);
      return { saved: true, retried: true, eviction, retryEviction };
    } catch (retryError) {
      return {
        saved: false,
        retried: true,
        eviction,
        retryEviction,
        error: retryError,
      };
    }
  }
}

export function markTerminalSnapshotForRemoval(sessionId?: string | null): void {
  if (!sessionId) return;

  pendingSnapshotRemovals.add(sessionId);

  try {
    localStorage.removeItem(getTerminalSnapshotKey(sessionId));
  } catch {
    // ignore localStorage failures
  }

  try {
    localStorage.setItem(getTerminalSnapshotRemovalKey(sessionId), JSON.stringify({
      schemaVersion: 1,
      sessionId,
      savedAt: new Date().toISOString(),
    }));
  } catch {
    // same-page callers still see the in-memory marker above
  }
}

export function isTerminalSnapshotRemovalRequested(sessionId: string): boolean {
  if (pendingSnapshotRemovals.has(sessionId)) {
    return true;
  }

  try {
    return localStorage.getItem(getTerminalSnapshotRemovalKey(sessionId)) !== null;
  } catch {
    return false;
  }
}

export function clearTerminalSnapshotRemovalRequest(sessionId: string): void {
  pendingSnapshotRemovals.delete(sessionId);

  try {
    localStorage.removeItem(getTerminalSnapshotRemovalKey(sessionId));
  } catch {
    // ignore localStorage failures
  }
}
