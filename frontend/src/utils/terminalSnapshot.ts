const SNAPSHOT_KEY_PREFIX = 'terminal_snapshot_';
const SNAPSHOT_REMOVAL_KEY_PREFIX = 'terminal_snapshot_remove_';
const pendingSnapshotRemovals = new Set<string>();

export function getTerminalSnapshotKey(sessionId: string): string {
  return `${SNAPSHOT_KEY_PREFIX}${sessionId}`;
}

function getTerminalSnapshotRemovalKey(sessionId: string): string {
  return `${SNAPSHOT_REMOVAL_KEY_PREFIX}${sessionId}`;
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
    localStorage.setItem(getTerminalSnapshotRemovalKey(sessionId), '1');
  } catch {
    // same-page callers still see the in-memory marker above
  }
}

export function isTerminalSnapshotRemovalRequested(sessionId: string): boolean {
  if (pendingSnapshotRemovals.has(sessionId)) {
    return true;
  }

  try {
    return localStorage.getItem(getTerminalSnapshotRemovalKey(sessionId)) === '1';
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
