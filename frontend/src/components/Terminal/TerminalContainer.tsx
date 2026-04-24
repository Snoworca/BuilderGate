import { memo, useRef, useCallback, useEffect, forwardRef, useImperativeHandle, useEffectEvent } from 'react';
import { useWebSocketActions } from '../../contexts/WebSocketContext';
import { useTerminalRuntimeContext } from './TerminalRuntimeContext';
import { TerminalView } from './TerminalView';
import type { GridRepairReason, TerminalHandle } from './TerminalView';
import type { WorkspaceTabRuntime } from '../../types/workspace';
import {
  buildTerminalInputDebugPayload,
  recordTerminalDebugEvent,
  shouldRecordTerminalInputDebug,
} from '../../utils/terminalDebugCapture';

interface Props {
  sessionId: string;
  isVisible: boolean;
  isGridSurface: boolean;
  onStatusChange: (sessionId: string, status: WorkspaceTabRuntime['status']) => void;
  onCwdChange?: (sessionId: string, cwd: string) => void;
  onAuthError: () => void;
}

function propsAreEqual(prev: Props, next: Props): boolean {
  return prev.sessionId === next.sessionId
    && prev.isVisible === next.isVisible
    && prev.isGridSurface === next.isGridSurface;
}

const FALLBACK_EMPTY_MESSAGE = '[BuilderGate] Fallback snapshot unavailable. Waiting for new output...\r\n';

function waitForRuntimeLayoutSettle(): Promise<void> {
  return new Promise(resolve => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
}

interface SnapshotPayload {
  seq: number;
  data: string;
  mode: 'authoritative' | 'fallback';
  truncated: boolean;
  replayToken: string;
  windowsPty?: { backend: 'conpty' | 'winpty'; buildNumber?: number };
}

export const TerminalContainer = memo(
  forwardRef<TerminalHandle, Props>(function TerminalContainer(
    { sessionId, isVisible, isGridSurface, onStatusChange, onCwdChange },
    ref
  ) {
    const terminalRef = useRef<TerminalHandle>(null);
    const isVisibleRef = useRef(isVisible);
    const isGridSurfaceRef = useRef(isGridSurface);
    const initialRestorePendingRef = useRef(true);
    const historySeenRef = useRef(false);
    const pendingSnapshotRef = useRef<SnapshotPayload | null>(null);
    const snapshotApplyInProgressRef = useRef(false);
    const sessionReadyRef = useRef(false);
    const idleRepairTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const visibleRepairTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const gridRepairInFlightRef = useRef<Promise<void> | null>(null);
    const gridVisibleRef = useRef(false);
    const pendingGridRepairReplayRef = useRef<GridRepairReason | null>(null);
    const repairSnapshotPendingRef = useRef(false);
    const lastResizeRef = useRef<{ cols: number; rows: number } | null>(null);
    const lastStatusRef = useRef<WorkspaceTabRuntime['status'] | null>(null);
    const idleRepairTriggeredRef = useRef(false);
    const lastAppliedSnapshotRef = useRef<{
      seq: number;
      mode: 'authoritative' | 'fallback';
      truncated: boolean;
      data: string;
    } | null>(null);

    const IDLE_REPAIR_QUIET_WINDOW_MS = 600;

    isVisibleRef.current = isVisible;
    isGridSurfaceRef.current = isGridSurface;

    const { send, subscribeSession } = useWebSocketActions();
    const { invalidateHostLayouts } = useTerminalRuntimeContext();

    useEffect(() => {
      initialRestorePendingRef.current = true;
      historySeenRef.current = false;
      pendingSnapshotRef.current = null;
      snapshotApplyInProgressRef.current = false;
      sessionReadyRef.current = false;
      if (idleRepairTimerRef.current) {
        clearTimeout(idleRepairTimerRef.current);
        idleRepairTimerRef.current = null;
      }
      if (visibleRepairTimerRef.current) {
        clearTimeout(visibleRepairTimerRef.current);
        visibleRepairTimerRef.current = null;
      }
      gridRepairInFlightRef.current = null;
      gridVisibleRef.current = false;
      pendingGridRepairReplayRef.current = null;
      repairSnapshotPendingRef.current = false;
      lastResizeRef.current = null;
      lastStatusRef.current = null;
      idleRepairTriggeredRef.current = false;
      lastAppliedSnapshotRef.current = null;
      terminalRef.current?.setServerReady(false);
      recordTerminalDebugEvent(sessionId, 'session_attached');
      return () => {
        recordTerminalDebugEvent(sessionId, 'session_detached');
      };
    }, [sessionId]);

    useEffect(() => {
      recordTerminalDebugEvent(sessionId, 'visibility_changed', {
        visible: isVisible,
      });
    }, [isVisible, sessionId]);

    const requestRepairReplay = useCallback((reason: GridRepairReason) => {
      if (!isVisibleRef.current) {
        return;
      }
      if (!isGridSurfaceRef.current) {
        return;
      }

      if (!sessionReadyRef.current) {
        pendingGridRepairReplayRef.current = reason;
        recordTerminalDebugEvent(sessionId, 'grid_repair_replay_deferred', { reason });
        return;
      }

      if (reason === 'idle') {
        idleRepairTriggeredRef.current = true;
      }

      const lastResize = lastResizeRef.current;
      if (lastResize) {
        recordTerminalDebugEvent(sessionId, 'grid_repair_resize_sent', {
          reason,
          cols: lastResize.cols,
          rows: lastResize.rows,
        });
        send({ type: 'resize', sessionId, cols: lastResize.cols, rows: lastResize.rows });
      }

      sessionReadyRef.current = false;
      terminalRef.current?.setServerReady(false);
      recordTerminalDebugEvent(
        sessionId,
        reason === 'idle'
          ? 'idle_repair_requested'
          : reason === 'workspace'
          ? 'workspace_repair_requested'
          : 'manual_repair_requested',
      );
      repairSnapshotPendingRef.current = true;
      send({ type: 'repair-replay', sessionId });
    }, [send, sessionId]);

    const flushPendingGridRepairReplay = useCallback(() => {
      const pendingReason = pendingGridRepairReplayRef.current;
      if (!pendingReason || !isVisibleRef.current || !isGridSurfaceRef.current || !sessionReadyRef.current) {
        return;
      }

      pendingGridRepairReplayRef.current = null;
      requestRepairReplay(pendingReason);
    }, [requestRepairReplay]);

    const runGridLayoutRepair = useCallback((reason: GridRepairReason) => {
      if (!isVisibleRef.current || !isGridSurfaceRef.current) {
        return;
      }

      if (gridRepairInFlightRef.current) {
        return;
      }

      const repair = (async () => {
        recordTerminalDebugEvent(sessionId, 'grid_layout_repair_started', { reason });
        invalidateHostLayouts();
        await waitForRuntimeLayoutSettle();
        await (terminalRef.current?.repairLayout(`grid-${reason}-repair`) ?? Promise.resolve());
        requestRepairReplay(reason);
      })();

      gridRepairInFlightRef.current = repair;
      void repair.finally(() => {
        if (gridRepairInFlightRef.current === repair) {
          gridRepairInFlightRef.current = null;
        }
      });
    }, [invalidateHostLayouts, requestRepairReplay, sessionId]);

    useImperativeHandle(ref, () => ({
      write: (data) => terminalRef.current?.write(data),
      clear: () => terminalRef.current?.clear(),
      focus: (reason) => terminalRef.current?.focus(reason),
      hasSelection: () => terminalRef.current?.hasSelection() ?? false,
      getSelection: () => terminalRef.current?.getSelection() ?? '',
      clearSelection: () => terminalRef.current?.clearSelection(),
      fit: () => terminalRef.current?.fit(),
      repairLayout: (reason) => terminalRef.current?.repairLayout(reason) ?? Promise.resolve(),
      requestGridRepair: (reason = 'manual') => runGridLayoutRepair(reason),
      sendInput: (data) => terminalRef.current?.sendInput(data),
      restoreSnapshot: () => terminalRef.current?.restoreSnapshot() ?? Promise.resolve(false),
      replaceWithSnapshot: (data) => terminalRef.current?.replaceWithSnapshot(data) ?? Promise.resolve(),
      releasePending: () => terminalRef.current?.releasePending(),
      setServerReady: (ready) => terminalRef.current?.setServerReady(ready),
      setWindowsPty: (info) => terminalRef.current?.setWindowsPty(info),
    }), [runGridLayoutRepair]);

    const handleStatus = useEffectEvent((status: string) => {
      onStatusChange(sessionId, status as WorkspaceTabRuntime['status']);
      const nextStatus = status as WorkspaceTabRuntime['status'];
      const previousStatus = lastStatusRef.current;
      lastStatusRef.current = nextStatus;
      recordTerminalDebugEvent(sessionId, 'status_received', {
        status: nextStatus,
        previousStatus,
      });

      if (nextStatus !== 'idle') {
        if (idleRepairTimerRef.current) {
          clearTimeout(idleRepairTimerRef.current);
          idleRepairTimerRef.current = null;
        }
        if (nextStatus === 'running' || nextStatus === 'disconnected') {
          idleRepairTriggeredRef.current = false;
        }
        return;
      }

      if (!isGridSurfaceRef.current || !isVisibleRef.current || previousStatus !== 'running' || idleRepairTriggeredRef.current) {
        return;
      }

      if (!historySeenRef.current && !lastAppliedSnapshotRef.current) {
        return;
      }

      if (idleRepairTimerRef.current) {
        clearTimeout(idleRepairTimerRef.current);
      }

      recordTerminalDebugEvent(sessionId, 'idle_repair_scheduled', {
        quietWindowMs: IDLE_REPAIR_QUIET_WINDOW_MS,
      });
      idleRepairTimerRef.current = setTimeout(() => {
        if (!isGridSurfaceRef.current || !isVisibleRef.current || lastStatusRef.current !== 'idle' || !sessionReadyRef.current) {
          return;
        }
        runGridLayoutRepair('idle');
      }, IDLE_REPAIR_QUIET_WINDOW_MS);
    });

    const handleCwd = useEffectEvent((cwd: string) => {
      onCwdChange?.(sessionId, cwd);
    });

    const handleError = useEffectEvent((message: string) => {
      console.error('Session error:', message);
      sessionReadyRef.current = false;
      terminalRef.current?.setServerReady(false);
      onStatusChange(sessionId, 'disconnected');
    });

    const handleSubscribed = useEffectEvent((info: { status: string; cwd?: string; ready: boolean }) => {
      sessionReadyRef.current = info.ready;
      terminalRef.current?.setServerReady(info.ready);
      recordTerminalDebugEvent(sessionId, 'session_subscribed', {
        status: info.status,
        ready: info.ready,
        cwdPresent: Boolean(info.cwd),
      });
      if (info.ready) {
        flushPendingGridRepairReplay();
      }
    });

    const handleSessionReady = useEffectEvent(() => {
      sessionReadyRef.current = true;
      terminalRef.current?.setServerReady(true);
      recordTerminalDebugEvent(sessionId, 'session_ready_received');
      flushPendingGridRepairReplay();
    });

    const handleScreenSnapshot = useEffectEvent(async (snapshot: SnapshotPayload) => {
      recordTerminalDebugEvent(sessionId, 'screen_snapshot_received', {
        seq: snapshot.seq,
        mode: snapshot.mode,
        truncated: snapshot.truncated,
        byteLength: snapshot.data.length,
      }, snapshot.data);
      pendingSnapshotRef.current = snapshot;
      if (!terminalRef.current) {
        recordTerminalDebugEvent(sessionId, 'screen_snapshot_deferred_until_visible', {
          seq: snapshot.seq,
          visible: isVisible,
          hasTerminal: Boolean(terminalRef.current),
        });
        requestAnimationFrame(() => {
          if (pendingSnapshotRef.current && !snapshotApplyInProgressRef.current && terminalRef.current) {
            void handleScreenSnapshot(pendingSnapshotRef.current);
          }
        });
        return;
      }
      if (snapshotApplyInProgressRef.current) {
        return;
      }

      snapshotApplyInProgressRef.current = true;
      try {
        while (pendingSnapshotRef.current) {
          const nextSnapshot = pendingSnapshotRef.current;
          pendingSnapshotRef.current = null;

          const lastApplied = lastAppliedSnapshotRef.current;
          const isStale = !!lastApplied && nextSnapshot.seq < lastApplied.seq;
          const hasSameSnapshotContent = !!lastApplied
            && nextSnapshot.mode === lastApplied.mode
            && nextSnapshot.truncated === lastApplied.truncated
            && nextSnapshot.data === lastApplied.data;
          const isDuplicate = hasSameSnapshotContent && nextSnapshot.seq === lastApplied.seq;
          const shouldReapplyDuplicateForRepair = hasSameSnapshotContent && repairSnapshotPendingRef.current;

          if (isStale) {
            recordTerminalDebugEvent(sessionId, 'screen_snapshot_stale_ignored', {
              seq: nextSnapshot.seq,
              appliedSeq: lastApplied.seq,
            });
            send({ type: 'screen-snapshot:ready', sessionId, replayToken: nextSnapshot.replayToken });
            continue;
          }

          if (isDuplicate && !shouldReapplyDuplicateForRepair) {
            recordTerminalDebugEvent(sessionId, 'screen_snapshot_duplicate_ignored', {
              seq: nextSnapshot.seq,
              mode: nextSnapshot.mode,
            });
            send({ type: 'screen-snapshot:ready', sessionId, replayToken: nextSnapshot.replayToken });
            continue;
          }
          if (shouldReapplyDuplicateForRepair) {
            recordTerminalDebugEvent(sessionId, 'screen_snapshot_duplicate_reapplied_for_repair', {
              seq: nextSnapshot.seq,
              previousSeq: lastApplied?.seq ?? null,
              mode: nextSnapshot.mode,
            });
          }

          historySeenRef.current = true;
          terminalRef.current?.setWindowsPty(nextSnapshot.windowsPty);

          if (nextSnapshot.mode === 'fallback') {
            if (nextSnapshot.data.length > 0) {
              await terminalRef.current?.replaceWithSnapshot(nextSnapshot.data);
              recordTerminalDebugEvent(sessionId, 'screen_snapshot_fallback_applied', {
                seq: nextSnapshot.seq,
                byteLength: nextSnapshot.data.length,
              }, nextSnapshot.data);
            } else {
              const restored = await terminalRef.current?.restoreSnapshot();
              if (!restored) {
                await terminalRef.current?.replaceWithSnapshot(FALLBACK_EMPTY_MESSAGE);
                recordTerminalDebugEvent(sessionId, 'screen_snapshot_fallback_placeholder_applied', {
                  seq: nextSnapshot.seq,
                }, FALLBACK_EMPTY_MESSAGE);
              } else {
                recordTerminalDebugEvent(sessionId, 'screen_snapshot_fallback_local_restore', {
                  seq: nextSnapshot.seq,
                });
              }
            }
          } else {
            await terminalRef.current?.replaceWithSnapshot(nextSnapshot.data);
            recordTerminalDebugEvent(sessionId, 'screen_snapshot_authoritative_applied', {
              seq: nextSnapshot.seq,
              byteLength: nextSnapshot.data.length,
            }, nextSnapshot.data);
          }

          lastAppliedSnapshotRef.current = {
            seq: nextSnapshot.seq,
            mode: nextSnapshot.mode,
            truncated: nextSnapshot.truncated,
            data: nextSnapshot.data,
          };
          recordTerminalDebugEvent(sessionId, 'screen_snapshot_ack_sent', {
            seq: nextSnapshot.seq,
            mode: nextSnapshot.mode,
          });
          send({ type: 'screen-snapshot:ready', sessionId, replayToken: nextSnapshot.replayToken });
          initialRestorePendingRef.current = false;
          repairSnapshotPendingRef.current = false;
        }
      } finally {
        snapshotApplyInProgressRef.current = false;
        if (pendingSnapshotRef.current) {
          void handleScreenSnapshot(pendingSnapshotRef.current);
        }
      }
    });

    useEffect(() => {
      if (pendingSnapshotRef.current && !snapshotApplyInProgressRef.current && terminalRef.current) {
        void handleScreenSnapshot(pendingSnapshotRef.current);
      }
    });

    useEffect(() => {
      return () => {
        if (idleRepairTimerRef.current) {
          clearTimeout(idleRepairTimerRef.current);
          idleRepairTimerRef.current = null;
        }
        if (visibleRepairTimerRef.current) {
          clearTimeout(visibleRepairTimerRef.current);
          visibleRepairTimerRef.current = null;
        }
      };
    }, []);

    useEffect(() => {
      terminalRef.current?.setServerReady(sessionReadyRef.current);
    });

    useEffect(() => {
      if (isVisible) {
        return;
      }
      if (idleRepairTimerRef.current) {
        clearTimeout(idleRepairTimerRef.current);
        idleRepairTimerRef.current = null;
      }
    }, [isVisible]);

    useEffect(() => {
      const unsubscribe = subscribeSession(sessionId, {
        onSubscribed: handleSubscribed,
        onSessionReady: handleSessionReady,
        onScreenSnapshot: (snapshot) => {
          void handleScreenSnapshot(snapshot);
        },
        onOutput: (data) => {
          recordTerminalDebugEvent(sessionId, 'live_output_received', {
            byteLength: data.length,
          }, data);
          terminalRef.current?.write(data);
        },
        onStatus: handleStatus,
        onError: handleError,
        onCwd: handleCwd,
      });
      return unsubscribe;
    }, [sessionId, subscribeSession]);

    const handleInput = useCallback((data: string) => {
      const debugInput = buildTerminalInputDebugPayload(data);
      if (!sessionReadyRef.current) {
        recordTerminalDebugEvent(sessionId, 'ws_input_dropped_not_ready', debugInput.details, debugInput.preview);
        return;
      }
      if (shouldRecordTerminalInputDebug(debugInput)) {
        recordTerminalDebugEvent(sessionId, 'ws_input_sent', debugInput.details, debugInput.preview);
      }
      send({ type: 'input', sessionId, data });
    }, [sessionId, send]);

    const handleResize = useCallback((cols: number, rows: number) => {
      lastResizeRef.current = { cols, rows };
      send({ type: 'resize', sessionId, cols, rows });
    }, [sessionId, send]);

    useEffect(() => {
      const nextVisible = isVisible && isGridSurface;
      const wasVisible = gridVisibleRef.current;
      gridVisibleRef.current = nextVisible;

      if (!nextVisible || wasVisible) {
        return;
      }

      if (visibleRepairTimerRef.current) {
        clearTimeout(visibleRepairTimerRef.current);
      }
      visibleRepairTimerRef.current = setTimeout(() => {
        visibleRepairTimerRef.current = null;
        runGridLayoutRepair('workspace');
      }, 250);
    }, [isGridSurface, isVisible, runGridLayoutRepair]);

    const handleMouseDownCapture = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
      if (event.button !== 1 || !isGridSurfaceRef.current) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      runGridLayoutRepair('manual');
    }, [runGridLayoutRepair]);

    const handlePointerDownCapture = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 1 || !isGridSurfaceRef.current) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      runGridLayoutRepair('manual');
    }, [runGridLayoutRepair]);

    const handleManualRepair = useCallback(() => {
      runGridLayoutRepair('manual');
    }, [runGridLayoutRepair]);

    return (
      <div
        style={{ display: isVisible ? 'flex' : 'none', flex: 1, minWidth: 0, minHeight: 0 }}
        onPointerDownCapture={handlePointerDownCapture}
        onMouseDownCapture={handleMouseDownCapture}
        onAuxClickCapture={handleMouseDownCapture}
      >
        <TerminalView
          ref={terminalRef}
          sessionId={sessionId}
          isVisible={isVisible}
          onInput={handleInput}
          onResize={handleResize}
          onManualRepair={isGridSurface ? handleManualRepair : undefined}
        />
      </div>
    );
  }),
  propsAreEqual,
);
