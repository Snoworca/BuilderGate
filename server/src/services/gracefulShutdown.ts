import fs from 'node:fs/promises';
import type { WorkspaceService } from './WorkspaceService.js';
import type { SessionManager } from './SessionManager.js';

export const SHUTDOWN_WORKSPACE_FLUSH_MARKER = '[Shutdown] Workspace state + CWDs saved';

export interface WorkspaceFlushEvidence {
  workspaceDataPath: string;
  workspaceLastUpdated: string;
  workspaceLastCwdCount: number;
  workspaceTabCount: number;
  workspaceFlushMarker: string;
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
  completedAt: string;
  durationMs: number;
}

interface TimerRef {
  timer: ReturnType<typeof setInterval> | ReturnType<typeof setTimeout> | null;
}

export interface GracefulShutdownOptions {
  sessionManager?: Pick<SessionManager, 'stopAllCwdWatching'>;
  workspaceService?: Pick<WorkspaceService, 'snapshotAllCwds' | 'forceFlush' | 'getDataFilePath'>;
  timers?: TimerRef[];
  clearInterval?: (timer: ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>) => void;
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

export async function performGracefulShutdown(
  reason: string,
  options: GracefulShutdownOptions = {},
): Promise<GracefulShutdownResult> {
  const startedAt = Date.now();
  let cwdWatchersStopped = false;
  let workspaceSnapshotted = false;
  let workspaceFlushed = false;
  let workspaceFlushEvidence: WorkspaceFlushEvidence | null = null;

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

  return {
    ok: true,
    reason,
    cwdWatchersStopped,
    workspaceSnapshotted,
    workspaceFlushed,
    ...(workspaceFlushEvidence ?? {}),
    completedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
  };
}
