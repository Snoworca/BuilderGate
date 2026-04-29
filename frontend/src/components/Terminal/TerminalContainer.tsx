import { memo, useRef, useCallback, useEffect, forwardRef, useImperativeHandle, useEffectEvent } from 'react';
import { useWebSocketActions, useWebSocketState } from '../../contexts/WebSocketContext';
import { useTerminalRuntimeContext } from './TerminalRuntimeContext';
import { TerminalView } from './TerminalView';
import type { GridRepairReason, TerminalHandle } from './TerminalView';
import type { WorkspaceTabRuntime } from '../../types/workspace';
import {
  buildClientInputDebugMetadata,
  buildTerminalInputDebugPayload,
  recordTerminalDebugEvent,
} from '../../utils/terminalDebugCapture';
import type {
  InputDebugMetadata,
  TerminalInputBarrierReason,
  TerminalInputClosedReason,
} from '../../types/ws-protocol';

const RECONNECT_INPUT_QUEUE_TTL_MS = 3000;

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
    const visibleRepairTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const gridRepairInFlightRef = useRef<Promise<void> | null>(null);
    const gridVisibleRef = useRef(false);
    const pendingGridRepairReplayRef = useRef<GridRepairReason | null>(null);
    const repairSnapshotPendingRef = useRef(false);
    const lastResizeRef = useRef<{ cols: number; rows: number } | null>(null);
    const lastStatusRef = useRef<WorkspaceTabRuntime['status'] | null>(null);
    const sessionGenerationRef = useRef(1);
    const inputSeqRef = useRef(0);
    const generationSessionIdRef = useRef(sessionId);
    const transportClosedReasonRef = useRef<TerminalInputClosedReason>('none');
    const reconnectStartedAtRef = useRef<number | null>(null);
    const reconnectTtlTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const { send, subscribeSession } = useWebSocketActions();
    const { status: wsStatus } = useWebSocketState();
    const { invalidateHostLayouts } = useTerminalRuntimeContext();
    const wsStatusRef = useRef(wsStatus);
    const lastAppliedSnapshotRef = useRef<{
      seq: number;
      mode: 'authoritative' | 'fallback';
      truncated: boolean;
      data: string;
    } | null>(null);

    isVisibleRef.current = isVisible;
    isGridSurfaceRef.current = isGridSurface;
    wsStatusRef.current = wsStatus;

    const bumpSessionGeneration = useCallback((reason: string) => {
      sessionGenerationRef.current += 1;
      recordTerminalDebugEvent(sessionId, 'input_session_generation_bumped', {
        reason,
        sessionGeneration: sessionGenerationRef.current,
      });
    }, [sessionId]);

    const clearTransportClosedReason = useCallback((reason: string) => {
      const currentReason = transportClosedReasonRef.current;
      if (currentReason === 'none') {
        return;
      }
      if (reason === 'ws-connected' && currentReason !== 'ws-closed-without-reconnect') {
        return;
      }
      transportClosedReasonRef.current = 'none';
      recordTerminalDebugEvent(sessionId, 'input_transport_closed_reason_cleared', { reason });
    }, [sessionId]);

    const markTransportClosed = useCallback((closedReason: TerminalInputClosedReason, reason: string) => {
      const currentReason = transportClosedReasonRef.current;
      if (
        closedReason === 'ws-closed-without-reconnect'
        && currentReason !== 'none'
        && currentReason !== 'ws-closed-without-reconnect'
      ) {
        return;
      }
      if (currentReason !== closedReason) {
        transportClosedReasonRef.current = closedReason;
        bumpSessionGeneration(reason);
      }
    }, [bumpSessionGeneration]);

    const syncInputTransportState = useCallback((reason: string) => {
      const currentWsStatus = wsStatusRef.current;
      let serverReady = sessionReadyRef.current;
      let barrierReason: TerminalInputBarrierReason = 'none';
      let closedReason = transportClosedReasonRef.current;

      if (currentWsStatus === 'connected') {
        reconnectStartedAtRef.current = null;
        if (closedReason === 'ws-closed-without-reconnect') {
          closedReason = 'none';
          transportClosedReasonRef.current = 'none';
        }
      } else if (currentWsStatus === 'reconnecting') {
        serverReady = false;
        if (closedReason === 'none') {
          const startedAt = reconnectStartedAtRef.current ?? Date.now();
          reconnectStartedAtRef.current = startedAt;
          if (Date.now() - startedAt <= RECONNECT_INPUT_QUEUE_TTL_MS) {
            barrierReason = 'ws-reconnecting-short';
          } else {
            closedReason = 'ws-closed-without-reconnect';
            if (transportClosedReasonRef.current !== closedReason) {
              transportClosedReasonRef.current = closedReason;
              bumpSessionGeneration('reconnect-ttl-expired');
            }
          }
        }
      } else {
        serverReady = false;
        if (closedReason === 'none') {
          closedReason = 'ws-closed-without-reconnect';
          if (transportClosedReasonRef.current !== closedReason) {
            transportClosedReasonRef.current = closedReason;
            bumpSessionGeneration('ws-disconnected');
          }
        }
      }

      if (closedReason === 'none' && barrierReason === 'none') {
        if (repairSnapshotPendingRef.current) {
          serverReady = false;
          barrierReason = 'repair-server-not-ready';
        } else if (
          initialRestorePendingRef.current
          || snapshotApplyInProgressRef.current
          || pendingSnapshotRef.current !== null
        ) {
          serverReady = false;
          barrierReason = 'replay-pending';
        } else if (!serverReady && barrierReason === 'none') {
          barrierReason = 'repair-server-not-ready';
        }
      }

      terminalRef.current?.setInputTransportState({
        serverReady,
        barrierReason,
        closedReason,
        reconnectState: currentWsStatus,
        sessionGeneration: sessionGenerationRef.current,
      });
      recordTerminalDebugEvent(sessionId, 'input_transport_state_synced', {
        reason,
        serverReady,
        barrierReason,
        closedReason,
        reconnectState: currentWsStatus,
        sessionGeneration: sessionGenerationRef.current,
      });
    }, [bumpSessionGeneration, sessionId]);

    useEffect(() => {
      if (generationSessionIdRef.current !== sessionId) {
        generationSessionIdRef.current = sessionId;
        bumpSessionGeneration('session-id-changed');
      }
      initialRestorePendingRef.current = true;
      historySeenRef.current = false;
      pendingSnapshotRef.current = null;
      snapshotApplyInProgressRef.current = false;
      sessionReadyRef.current = false;
      if (visibleRepairTimerRef.current) {
        clearTimeout(visibleRepairTimerRef.current);
        visibleRepairTimerRef.current = null;
      }
      gridRepairInFlightRef.current = null;
      gridVisibleRef.current = false;
      pendingGridRepairReplayRef.current = null;
      repairSnapshotPendingRef.current = false;
      transportClosedReasonRef.current = 'none';
      reconnectStartedAtRef.current = null;
      if (reconnectTtlTimerRef.current) {
        clearTimeout(reconnectTtlTimerRef.current);
        reconnectTtlTimerRef.current = null;
      }
      lastResizeRef.current = null;
      lastStatusRef.current = null;
      inputSeqRef.current = 0;
      lastAppliedSnapshotRef.current = null;
      syncInputTransportState('session-attached');
      recordTerminalDebugEvent(sessionId, 'session_attached');
      return () => {
        markTransportClosed('workspace-or-session-changed', 'session-detached');
        syncInputTransportState('session-detached');
        recordTerminalDebugEvent(sessionId, 'session_detached');
      };
    }, [bumpSessionGeneration, markTransportClosed, sessionId, syncInputTransportState]);

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
      syncInputTransportState('repair-replay-requested');
      recordTerminalDebugEvent(
        sessionId,
        reason === 'workspace'
          ? 'workspace_repair_requested'
          : 'manual_repair_requested',
      );
      repairSnapshotPendingRef.current = true;
      syncInputTransportState('repair-replay-pending');
      send({ type: 'repair-replay', sessionId });
    }, [send, sessionId, syncInputTransportState]);

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
      setInputTransportState: (state) => terminalRef.current?.setInputTransportState(state),
      setServerReady: (ready) => terminalRef.current?.setServerReady(ready),
      setWindowsPty: (info) => terminalRef.current?.setWindowsPty(info),
    }), [runGridLayoutRepair]);

    const handleStatus = useEffectEvent((status: string) => {
      const nextStatus = status as WorkspaceTabRuntime['status'];
      const previousStatus = lastStatusRef.current;
      onStatusChange(sessionId, nextStatus);
      lastStatusRef.current = nextStatus;
      recordTerminalDebugEvent(sessionId, 'status_received', {
        status: nextStatus,
        previousStatus,
      });
    });

    const handleCwd = useEffectEvent((cwd: string) => {
      onCwdChange?.(sessionId, cwd);
    });

    const handleError = useEffectEvent((message: string) => {
      console.error('Session error:', message);
      sessionReadyRef.current = false;
      const closedReason = message.includes('Session not found')
        ? 'session-missing'
        : message.startsWith('Shell exited')
          ? 'session-exited'
          : 'server-error';
      markTransportClosed(closedReason, 'session-error');
      syncInputTransportState('session-error');
      onStatusChange(sessionId, 'disconnected');
    });

    const handleSubscribed = useEffectEvent((info: { status: string; cwd?: string; ready: boolean }) => {
      sessionReadyRef.current = info.ready;
      if (info.ready) {
        clearTransportClosedReason('subscribed-ready');
      }
      syncInputTransportState('subscribed');
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
      clearTransportClosedReason('session-ready');
      syncInputTransportState('session-ready');
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
          syncInputTransportState('screen-snapshot-applied');
        }
      } finally {
        snapshotApplyInProgressRef.current = false;
        if (pendingSnapshotRef.current) {
          void handleScreenSnapshot(pendingSnapshotRef.current);
        } else {
          syncInputTransportState('screen-snapshot-apply-settled');
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
        if (visibleRepairTimerRef.current) {
          clearTimeout(visibleRepairTimerRef.current);
          visibleRepairTimerRef.current = null;
        }
        if (reconnectTtlTimerRef.current) {
          clearTimeout(reconnectTtlTimerRef.current);
          reconnectTtlTimerRef.current = null;
        }
      };
    }, []);

    useEffect(() => {
      syncInputTransportState('render-sync');
    });

    useEffect(() => {
      if (reconnectTtlTimerRef.current) {
        clearTimeout(reconnectTtlTimerRef.current);
        reconnectTtlTimerRef.current = null;
      }

      if (wsStatus === 'connected') {
        reconnectStartedAtRef.current = null;
        clearTransportClosedReason('ws-connected');
        syncInputTransportState('ws-connected');
        return;
      }

      if (wsStatus === 'reconnecting') {
        if (reconnectStartedAtRef.current === null) {
          reconnectStartedAtRef.current = Date.now();
        }
        syncInputTransportState('ws-reconnecting');
        reconnectTtlTimerRef.current = setTimeout(() => {
          markTransportClosed('ws-closed-without-reconnect', 'reconnect-ttl-expired');
          syncInputTransportState('reconnect-ttl-expired');
        }, RECONNECT_INPUT_QUEUE_TTL_MS + 25);
        return;
      }

      markTransportClosed('ws-closed-without-reconnect', 'ws-disconnected');
      syncInputTransportState('ws-disconnected');
    }, [
      clearTransportClosedReason,
      markTransportClosed,
      syncInputTransportState,
      wsStatus,
    ]);

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

    const handleInput = useCallback((data: string, metadata?: InputDebugMetadata) => {
      const debugInput = buildTerminalInputDebugPayload(data, {
        captureSeq: metadata?.captureSeq,
        compositionSeq: metadata?.compositionSeq,
      });
      if (!sessionReadyRef.current) {
        recordTerminalDebugEvent(sessionId, 'ws_input_dropped_not_ready', debugInput.details, debugInput.preview);
        return;
      }
      const inputSeqStart = inputSeqRef.current + 1;
      inputSeqRef.current = inputSeqStart;
      const inputSeqEnd = inputSeqStart;
      recordTerminalDebugEvent(sessionId, 'ws_input_sent', debugInput.details, debugInput.preview);
      send({
        type: 'input',
        sessionId,
        data,
        inputSeqStart,
        inputSeqEnd,
        metadata: metadata ?? buildClientInputDebugMetadata(debugInput.details),
      });
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
