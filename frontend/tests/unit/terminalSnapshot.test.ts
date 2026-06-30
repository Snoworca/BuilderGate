import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  TERMINAL_SNAPSHOT_MAX_CONTENT_LENGTH,
  TERMINAL_SNAPSHOT_PAYLOAD_KIND,
  TERMINAL_SNAPSHOT_SCHEMA_VERSION,
  cleanupExpiredTerminalSnapshotTombstones,
  evictTerminalSnapshots,
  evictTerminalSnapshotsForAuthTokenWithLimits,
  getTerminalSnapshotKey,
  getTerminalSnapshotRemovalKey,
  isTerminalSnapshotRemovalRequested,
  parseTerminalViewportSnapshot,
  setTerminalSnapshotWithQuotaRecovery,
  type TerminalViewportSnapshotPayload,
} from '../../src/utils/terminalSnapshot.ts';

const now = '2026-05-15T00:00:00.000Z';

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

function snapshot(overrides: Partial<TerminalViewportSnapshotPayload> = {}): TerminalViewportSnapshotPayload {
  return {
    schemaVersion: TERMINAL_SNAPSHOT_SCHEMA_VERSION,
    payloadKind: TERMINAL_SNAPSHOT_PAYLOAD_KIND,
    sessionId: 'session-1',
    content: '\x1b[Hlatest-marker',
    cols: 80,
    rows: 24,
    bufferType: 'normal',
    savedAt: now,
    ...overrides,
  };
}

function parse(payload: unknown, sessionId = 'session-1') {
  return parseTerminalViewportSnapshot(JSON.stringify(payload), sessionId);
}

test('parseTerminalViewportSnapshot accepts valid schema v2 viewport payloads', () => {
  const payload = snapshot({ bufferType: 'alternate', content: '\x1b[?1049hALT-MARKER' });
  const parsed = parse(payload);

  assert.deepEqual(parsed, payload);
});

test('parseTerminalViewportSnapshot rejects legacy and malformed payloads', () => {
  assert.equal(parseTerminalViewportSnapshot(null, 'session-1'), null);
  assert.equal(parseTerminalViewportSnapshot('{bad json', 'session-1'), null);
  assert.equal(parse({ ...snapshot(), schemaVersion: 1, content: 'OLD\nFULL\nSCROLLBACK' }), null);
  assert.equal(parse({ ...snapshot(), payloadKind: undefined }), null);
  assert.equal(parse(snapshot(), 'other-session'), null);
  assert.equal(parse({ ...snapshot(), content: '' }), null);
  assert.equal(parse({ ...snapshot(), cols: 0 }), null);
  assert.equal(parse({ ...snapshot(), rows: 1.5 }), null);
  assert.equal(parse({ ...snapshot(), bufferType: 'unknown' }), null);
  assert.equal(parse({ ...snapshot(), savedAt: 'not-a-date' }), null);
});

test('parseTerminalViewportSnapshot enforces content and viewport line budgets', () => {
  assert.equal(
    parseTerminalViewportSnapshot(JSON.stringify(snapshot({ content: 'x'.repeat(6) })), 'session-1', {
      maxContentLength: 5,
    }),
    null,
  );

  const tooManyRows = Array.from({ length: 10 }, (_, index) => `line-${index}`).join('\n');
  assert.equal(
    parseTerminalViewportSnapshot(JSON.stringify(snapshot({ rows: 2, content: tooManyRows })), 'session-1', {
      maxRowsMultiplier: 2,
    }),
    null,
  );

  const boundaryRows = Array.from({ length: 5 }, (_, index) => `line-${index}`).join('\n');
  assert.notEqual(
    parseTerminalViewportSnapshot(JSON.stringify(snapshot({ rows: 2, content: boundaryRows })), 'session-1', {
      maxRowsMultiplier: 2,
    }),
    null,
  );
});

test('terminal snapshot storage eviction removes corrupt older entries first and preserves current session', () => {
  const storage = new MemoryStorage();
  storage.setItem(getTerminalSnapshotKey('session-1'), JSON.stringify(snapshot()));
  storage.setItem(getTerminalSnapshotKey('session-old'), JSON.stringify(snapshot({
    sessionId: 'session-old',
    savedAt: '2026-05-01T00:00:00.000Z',
    content: 'old'.repeat(100),
  })));
  storage.setItem(getTerminalSnapshotKey('session-corrupt'), '{bad json');

  const result = evictTerminalSnapshots({
    storage,
    preserveSessionId: 'session-1',
    targetMaxChars: 1,
  });

  assert.equal(storage.getItem(getTerminalSnapshotKey('session-1')) !== null, true);
  assert.equal(result.removedKeys[0], getTerminalSnapshotKey('session-corrupt'));
  assert.equal(storage.getItem(getTerminalSnapshotKey('session-corrupt')), null);
});

test('terminal snapshot eviction enforces max snapshot entries', () => {
  const storage = new MemoryStorage();
  storage.setItem(getTerminalSnapshotKey('session-new'), JSON.stringify(snapshot({
    sessionId: 'session-new',
    savedAt: '2026-05-03T00:00:00.000Z',
    content: 'new',
  })));
  storage.setItem(getTerminalSnapshotKey('session-old'), JSON.stringify(snapshot({
    sessionId: 'session-old',
    savedAt: '2026-05-01T00:00:00.000Z',
    content: 'old',
  })));
  storage.setItem(getTerminalSnapshotKey('session-current'), JSON.stringify(snapshot({
    sessionId: 'session-current',
    savedAt: '2026-05-04T00:00:00.000Z',
    content: 'current',
  })));

  const result = evictTerminalSnapshots({
    storage,
    preserveSessionId: 'session-current',
    maxEntries: 2,
    targetMaxChars: 100_000,
  });

  assert.equal(result.removedCount, 1);
  assert.equal(result.removedKeys[0], getTerminalSnapshotKey('session-old'));
  assert.equal(storage.getItem(getTerminalSnapshotKey('session-current')) !== null, true);
});

test('setTerminalSnapshotWithQuotaRecovery stores v2 payloads without changing current-session data', () => {
  const storage = new MemoryStorage();
  const value = JSON.stringify(snapshot({
    content: 'latest-marker',
  }));

  const result = setTerminalSnapshotWithQuotaRecovery('session-1', value, {
    storage,
    maxTotalChars: TERMINAL_SNAPSHOT_MAX_CONTENT_LENGTH,
  });

  assert.equal(result.saved, true);
  assert.deepEqual(parseTerminalViewportSnapshot(storage.getItem(getTerminalSnapshotKey('session-1')), 'session-1'), {
    ...snapshot(),
    content: 'latest-marker',
  });
});

test('setTerminalSnapshotWithQuotaRecovery rejects snapshots that exceed total projected storage budget', () => {
  const storage = new MemoryStorage();
  const value = JSON.stringify(snapshot({
    content: 'x'.repeat(900),
  }));

  const result = setTerminalSnapshotWithQuotaRecovery('session-1', value, {
    storage,
    maxTotalChars: 1024,
    maxEntries: 16,
  });

  assert.equal(result.saved, false);
  assert.equal(storage.getItem(getTerminalSnapshotKey('session-1')), null);
});

test('evictTerminalSnapshotsForAuthTokenWithLimits applies runtime total budget and entry limits', () => {
  const storage = new MemoryStorage();
  storage.setItem(getTerminalSnapshotKey('session-new'), JSON.stringify(snapshot({
    sessionId: 'session-new',
    savedAt: '2026-05-04T00:00:00.000Z',
    content: 'new',
  })));
  storage.setItem(getTerminalSnapshotKey('session-old'), JSON.stringify(snapshot({
    sessionId: 'session-old',
    savedAt: '2026-05-01T00:00:00.000Z',
    content: 'old',
  })));
  storage.setItem(getTerminalSnapshotKey('session-middle'), JSON.stringify(snapshot({
    sessionId: 'session-middle',
    savedAt: '2026-05-02T00:00:00.000Z',
    content: 'middle',
  })));

  const result = evictTerminalSnapshotsForAuthTokenWithLimits({
    storage,
    maxTotalChars: 100_000,
    maxEntries: 2,
  });

  assert.equal(result.removedCount, 1);
  assert.deepEqual(result.removedKeys, [getTerminalSnapshotKey('session-old')]);
  assert.equal(storage.getItem(getTerminalSnapshotKey('session-old')), null);
});

test('auth-token snapshot eviction preserves fresh removal tombstones when under budget', () => {
  const storage = new MemoryStorage();
  const sessionId = 'session-remove-fresh';
  storage.setItem(getTerminalSnapshotRemovalKey(sessionId), JSON.stringify({
    schemaVersion: 1,
    sessionId,
    savedAt: '2026-05-04T00:00:00.000Z',
  }));

  const result = evictTerminalSnapshotsForAuthTokenWithLimits({
    storage,
    maxTotalChars: 100_000,
    maxEntries: 16,
  });

  assert.equal(result.removedCount, 0);
  assert.equal(storage.getItem(getTerminalSnapshotRemovalKey(sessionId)) !== null, true);
});

test('snapshot removal tombstones expire and are cleaned from storage', () => {
  const storage = new MemoryStorage();
  const sessionId = 'session-expired-remove';
  storage.setItem(getTerminalSnapshotRemovalKey(sessionId), JSON.stringify({
    schemaVersion: 1,
    sessionId,
    savedAt: '2026-05-01T00:00:00.000Z',
  }));

  assert.equal(isTerminalSnapshotRemovalRequested(sessionId, {
    storage,
    tombstoneTtlMs: 1000,
    nowMs: Date.parse('2026-05-01T00:00:00.500Z'),
  }), true);
  assert.equal(isTerminalSnapshotRemovalRequested(sessionId, {
    storage,
    tombstoneTtlMs: 1000,
    nowMs: Date.parse('2026-05-01T00:00:02.000Z'),
  }), false);
  assert.equal(storage.getItem(getTerminalSnapshotRemovalKey(sessionId)), null);
});

test('cleanupExpiredTerminalSnapshotTombstones removes malformed tombstones', () => {
  const storage = new MemoryStorage();
  storage.setItem(getTerminalSnapshotRemovalKey('session-bad'), '{bad json');

  const result = cleanupExpiredTerminalSnapshotTombstones({ storage, nowMs: Date.parse(now) });

  assert.deepEqual(result.removedKeys, [getTerminalSnapshotRemovalKey('session-bad')]);
  assert.equal(storage.getItem(getTerminalSnapshotRemovalKey('session-bad')), null);
});
