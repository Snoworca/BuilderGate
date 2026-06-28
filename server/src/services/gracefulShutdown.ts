import fs from 'node:fs/promises';
import type { WorkspaceService } from './WorkspaceService.js';
import type { SessionManager } from './SessionManager.js';
import type {
  SessionCleanupTelemetry,
  SessionCleanupTelemetryResult,
} from '../types/ws-protocol.js';
import type { SessionProcessCleanupMode } from '../types/config.types.js';

export const SHUTDOWN_WORKSPACE_FLUSH_MARKER = '[Shutdown] Workspace state + CWDs saved';
const DEFAULT_SESSION_CLEANUP_TIMEOUT_MS = 3_000;

export interface WorkspaceFlushEvidence {
  workspaceDataPath: string;
  workspaceLastUpdated: string;
  workspaceLastCwdCount: number;
  workspaceTabCount: number;
  workspaceFlushMarker: string;
}

export interface ShutdownSessionCleanupEvidence {
  sessionCleanupAttempted: number;
  sessionCleanupCompleted: number;
  sessionCleanupDegraded: number;
  sessionCleanupSkippedUnverified: number;
  remainingVerifiedDescendants: number;
}

export interface GracefulShutdownResult {
  ok: true;
  reason: string;
  cwdWatchersStopped: boolean;
  workspaceSnapshotted: boolean;
  workspaceFlushed: boolean;
  workspaceDataPath?: string;
  workspaceLastUpdated?: string;
  workspaceLastCwdCount?: number;
  workspaceTabCount?: number;
  workspaceFlushMarker?: string;
  sessionCleanupAttempted: number;
  sessionCleanupCompleted: number;
  sessionCleanupDegraded: number;
  sessionCleanupSkippedUnverified: number;
  remainingVerifiedDescendants: number;
  completedAt: string;
  durationMs: number;
}

interface TimerRef {
  timer: ReturnType<typeof setInterval> | ReturnType<typeof setTimeout> | null;
}

interface SessionCleanupTerminator {
  stopAllCwdWatching: () => void;
  terminateAllSessions?: (options: {
    reason: 'shutdown';
    mode?: SessionProcessCleanupMode;
    waitMs?: number;
  }) => Promise<{
    attempted: number;
    terminated: number;
    missing: string[];
    remainingVerifiedDescendants?: number;
    remainingUnverifiedDescendants?: number;
  }>;
  getObservabilitySnapshot?: () => {
    totalSessions?: number;
    cleanup?: SessionCleanupTelemetry;
  };
}

export interface GracefulShutdownOptions {
  sessionManager?: SessionCleanupTerminator | Pick<SessionManager, 'stopAllCwdWatching'>;
  workspaceService?: Pick<WorkspaceService, 'snapshotAllCwds' | 'forceFlush' | 'getDataFilePath'>;
  timers?: TimerRef[];
  clearInterval?: (timer: ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>) => void;
  sessionCleanupTimeoutMs?: number;
  sessionCleanupWaitMs?: number;
  sessionCleanupMode?: SessionProcessCleanupMode;
}

async function readWorkspaceFlushEvidence(dataPath: string, shutdownStartedAt: number): Promise<WorkspaceFlushEvidence> {
  const raw = await fs.readFile(dataPath, 'utf-8');
  const parsed = JSON.parse(raw) as {
    lastUpdated?: unknown;
    state?: { tabs?: Array<{ lastCwd?: unknown }> };
  };

  if (typeof parsed.lastUpdated !== 'string') {
    throw new Error(`Workspace flush evidence is missing lastUpdated: ${dataPath}`);
  }

  const lastUpdatedMs = Date.parse(parsed.lastUpdated);
  if (!Number.isFinite(lastUpdatedMs)) {
    throw new Error(`Workspace flush evidence has invalid lastUpdated: ${parsed.lastUpdated}`);
  }

  if (lastUpdatedMs < shutdownStartedAt) {
    throw new Error(`Workspace flush evidence is stale: ${parsed.lastUpdated}`);
  }

  const tabs = Array.isArray(parsed.state?.tabs) ? parsed.state.tabs : [];
  const lastCwdCount = tabs.filter(tab => typeof tab.lastCwd === 'string' && tab.lastCwd.trim() !== '').length;

  return {
    workspaceDataPath: dataPath,
    workspaceLastUpdated: parsed.lastUpdated,
    workspaceLastCwdCount: lastCwdCount,
    workspaceTabCount: tabs.length,
    workspaceFlushMarker: SHUTDOWN_WORKSPACE_FLUSH_MARKER,
  };
}

function createEmptySessionCleanupEvidence(): ShutdownSessionCleanupEvidence {
  return {
    sessionCleanupAttempted: 0,
    sessionCleanupCompleted: 0,
    sessionCleanupDegraded: 0,
    sessionCleanupSkippedUnverified: 0,
    remainingVerifiedDescendants: 0,
  };
}

function nonNegativeDelta(after?: number, before?: number): number {
  const next = Number.isInteger(after) ? Number(after) : 0;
  const previous = Number.isInteger(before) ? Number(before) : 0;
  return Math.max(0, next - previous);
}

function cleanupResultKey(result: SessionCleanupTelemetryResult): string {
  return `${result.sessionId}\u0000${result.reason}\u0000${result.recordedAt}`;
}

function sumNewShutdownVerifiedRemainingDescendants(args: {
  before?: SessionCleanupTelemetry;
  after?: SessionCleanupTelemetry;
}): number {
  const beforeKeys = new Set((args.before?.recentResults ?? []).map(cleanupResultKey));
  let total = 0;
  for (const result of args.after?.recentResults ?? []) {
    if (result.reason !== 'shutdown' || beforeKeys.has(cleanupResultKey(result))) {
      continue;
    }
    const verifiedRemainingDescendants = result.verifiedRemainingDescendants;
    if (
      typeof verifiedRemainingDescendants === 'number'
      && Number.isInteger(verifiedRemainingDescendants)
      && verifiedRemainingDescendants > 0
    ) {
      total += verifiedRemainingDescendants;
    }
  }
  return total;
}

function getCleanupTelemetrySnapshot(
  sessionManager?: GracefulShutdownOptions['sessionManager'],
): { totalSessions: number; cleanup?: SessionCleanupTelemetry } {
  if (!sessionManager || typeof (sessionManager as SessionCleanupTerminator).getObservabilitySnapshot !== 'function') {
    return { totalSessions: 0 };
  }
  const snapshot = (sessionManager as SessionCleanupTerminator).getObservabilitySnapshot?.();
  return {
    totalSessions: Number.isInteger(snapshot?.totalSessions) ? Number(snapshot?.totalSessions) : 0,
    cleanup: snapshot?.cleanup,
  };
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<{ timedOut: false; value: T } | { timedOut: true; value?: never }> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise.then(value => ({ timedOut: false as const, value })),
      new Promise<{ timedOut: true }>((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    promise.catch(() => undefined);
  }
}

function collectSessionCleanupEvidence(args: {
  before: { totalSessions: number; cleanup?: SessionCleanupTelemetry };
  after: { totalSessions: number; cleanup?: SessionCleanupTelemetry };
  result?: {
    attempted: number;
    terminated: number;
    missing: string[];
    remainingVerifiedDescendants?: number;
    remainingUnverifiedDescendants?: number;
  };
  timedOut: boolean;
}): ShutdownSessionCleanupEvidence {
  const attemptedFromResult = Number.isInteger(args.result?.attempted) ? Math.max(0, Number(args.result?.attempted)) : 0;
  const attemptedFromTelemetry = nonNegativeDelta(args.after.cleanup?.attempted, args.before.cleanup?.attempted);
  const attemptedFromTimeout = args.timedOut ? Math.max(args.before.totalSessions, args.after.totalSessions) : 0;
  const attempted = Math.max(attemptedFromResult, attemptedFromTelemetry, attemptedFromTimeout);
  const completed = Math.min(attempted, nonNegativeDelta(args.after.cleanup?.completed, args.before.cleanup?.completed));
  const skipped = Math.min(attempted, nonNegativeDelta(args.after.cleanup?.unverifiedSkipped, args.before.cleanup?.unverifiedSkipped));
  const observedDegraded = nonNegativeDelta(args.after.cleanup?.degraded, args.before.cleanup?.degraded);
  const accountedBeforeDegraded = completed + skipped + observedDegraded;
  const unaccounted = Math.max(0, attempted - accountedBeforeDegraded);
  const degraded = Math.min(attempted, observedDegraded + (args.timedOut ? unaccounted : 0));
  const remainingVerifiedDescendants = Math.max(
    0,
    Number.isInteger(args.result?.remainingVerifiedDescendants)
      ? Number(args.result?.remainingVerifiedDescendants)
      : sumNewShutdownVerifiedRemainingDescendants({
        before: args.before.cleanup,
        after: args.after.cleanup,
      }),
  );

  return {
    sessionCleanupAttempted: attempted,
    sessionCleanupCompleted: completed,
    sessionCleanupDegraded: degraded,
    sessionCleanupSkippedUnverified: skipped,
    // Public cleanup telemetry may aggregate verified and unverified descendants.
    // Only trust shutdown-scoped batch details that explicitly separate verified ownership.
    remainingVerifiedDescendants,
  };
}

export async function performGracefulShutdown(
  reason: string,
  options: GracefulShutdownOptions = {},
): Promise<GracefulShutdownResult> {
  const startedAt = Date.now();
  let cwdWatchersStopped = false;
  let workspaceSnapshotted = false;
  let workspaceFlushed = false;
  let workspaceFlushEvidence: WorkspaceFlushEvidence | null = null;
  let sessionCleanupEvidence = createEmptySessionCleanupEvidence();

  if (options.sessionManager) {
    options.sessionManager.stopAllCwdWatching();
    cwdWatchersStopped = true;
  }

  if (options.workspaceService) {
    options.workspaceService.snapshotAllCwds();
    workspaceSnapshotted = true;
    await options.workspaceService.forceFlush();
    workspaceFlushed = true;
    workspaceFlushEvidence = await readWorkspaceFlushEvidence(
      options.workspaceService.getDataFilePath(),
      startedAt,
    );
  }

  const clear = options.clearInterval ?? clearInterval;
  for (const timerRef of options.timers ?? []) {
    if (timerRef.timer) {
      clear(timerRef.timer);
      timerRef.timer = null;
    }
  }

  const sessionManager = options.sessionManager as SessionCleanupTerminator | undefined;
  if (sessionManager && typeof sessionManager.terminateAllSessions === 'function') {
    const beforeCleanup = getCleanupTelemetrySnapshot(sessionManager);
    const timeoutMs = Math.max(0, options.sessionCleanupTimeoutMs ?? DEFAULT_SESSION_CLEANUP_TIMEOUT_MS);
    const cleanupPromise = sessionManager.terminateAllSessions({
      reason: 'shutdown',
      mode: options.sessionCleanupMode,
      waitMs: options.sessionCleanupWaitMs,
    });
    const cleanupResult = await withTimeout(cleanupPromise, timeoutMs);
    const afterCleanup = getCleanupTelemetrySnapshot(sessionManager);
    sessionCleanupEvidence = collectSessionCleanupEvidence({
      before: beforeCleanup,
      after: afterCleanup,
      result: cleanupResult.timedOut ? undefined : cleanupResult.value,
      timedOut: cleanupResult.timedOut,
    });

    if (options.workspaceService) {
      await options.workspaceService.forceFlush();
      workspaceFlushed = true;
      workspaceFlushEvidence = await readWorkspaceFlushEvidence(
        options.workspaceService.getDataFilePath(),
        startedAt,
      );
    }
  }

  return {
    ok: true,
    reason,
    cwdWatchersStopped,
    workspaceSnapshotted,
    workspaceFlushed,
    ...(workspaceFlushEvidence ?? {}),
    ...sessionCleanupEvidence,
    completedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
  };
}
