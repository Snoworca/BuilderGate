import { memo, useRef, useCallback, useEffect, forwardRef, useImperativeHandle, useEffectEvent } from 'react';
import { useWebSocketActions } from '../../contexts/WebSocketContext';
import { TerminalView } from './TerminalView';
import type { TerminalHandle } from './TerminalView';
import type { WorkspaceTabRuntime } from '../../types/workspace';
import { recordTerminalDebugEvent } from '../../utils/terminalDebugCapture';

interface Props {
  sessionId: string;
  isVisible: boolean;
  onStatusChange: (sessionId: string, status: WorkspaceTabRuntime['status']) => void;
  onCwdChange?: (sessionId: string, cwd: string) => void;
  onAuthError: () => void;
}

function propsAreEqual(prev: Props, next: Props): boolean {
  return prev.sessionId === next.sessionId && prev.isVisible === next.isVisible;
}

const FALLBACK_EMPTY_MESSAGE = '[BuilderGate] Fallback snapshot unavailable. Waiting for new output...\r\n';

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
    { sessionId, isVisible, onStatusChange, onCwdChange },
    ref
  ) {
    const terminalRef = useRef<TerminalHandle>(null);
    const initialRestorePendingRef = useRef(true);
    const historySeenRef = useRef(false);
    const pendingSnapshotRef = useRef<SnapshotPayload | null>(null);
    const snapshotApplyInProgressRef = useRef(false);
    const lastAppliedSnapshotRef = useRef<{
      seq: number;
      mode: 'authoritative' | 'fallback';
      truncated: boolean;
      data: string;
    } | null>(null);

    useImperativeHandle(ref, () => ({
      write: (data) => terminalRef.current?.write(data),
      clear: () => terminalRef.current?.clear(),
      focus: () => terminalRef.current?.focus(),
      hasSelection: () => terminalRef.current?.hasSelection() ?? false,
      getSelection: () => terminalRef.current?.getSelection() ?? '',
      clearSelection: () => terminalRef.current?.clearSelection(),
      fit: () => terminalRef.current?.fit(),
      sendInput: (data) => terminalRef.current?.sendInput(data),
      restoreSnapshot: () => terminalRef.current?.restoreSnapshot() ?? Promise.resolve(false),
      replaceWithSnapshot: (data) => terminalRef.current?.replaceWithSnapshot(data) ?? Promise.resolve(),
      releasePending: () => terminalRef.current?.releasePending(),
      setWindowsPty: (info) => terminalRef.current?.setWindowsPty(info),
    }), []);

    const { send, subscribeSession } = useWebSocketActions();

    useEffect(() => {
      initialRestorePendingRef.current = true;
      historySeenRef.current = false;
      pendingSnapshotRef.current = null;
      snapshotApplyInProgressRef.current = false;
      lastAppliedSnapshotRef.current = null;
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

    const handleStatus = useEffectEvent((status: string) => {
      onStatusChange(sessionId, status as WorkspaceTabRuntime['status']);
    });

    const handleCwd = useEffectEvent((cwd: string) => {
      onCwdChange?.(sessionId, cwd);
    });

    const handleError = useEffectEvent((message: string) => {
      console.error('Session error:', message);
      onStatusChange(sessionId, 'disconnected');
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
          const isDuplicate = !!lastApplied
            && nextSnapshot.seq === lastApplied.seq
            && nextSnapshot.mode === lastApplied.mode
            && nextSnapshot.truncated === lastApplied.truncated
            && nextSnapshot.data === lastApplied.data;

          if (isStale) {
            recordTerminalDebugEvent(sessionId, 'screen_snapshot_stale_ignored', {
              seq: nextSnapshot.seq,
              appliedSeq: lastApplied.seq,
            });
            send({ type: 'screen-snapshot:ready', sessionId, replayToken: nextSnapshot.replayToken });
            continue;
          }

          if (isDuplicate) {
            recordTerminalDebugEvent(sessionId, 'screen_snapshot_duplicate_ignored', {
              seq: nextSnapshot.seq,
              mode: nextSnapshot.mode,
            });
            send({ type: 'screen-snapshot:ready', sessionId, replayToken: nextSnapshot.replayToken });
            continue;
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
      const unsubscribe = subscribeSession(sessionId, {
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
      send({ type: 'input', sessionId, data });
    }, [sessionId, send]);

    const handleResize = useCallback((cols: number, rows: number) => {
      send({ type: 'resize', sessionId, cols, rows });
    }, [sessionId, send]);

    return (
      <div style={{ display: isVisible ? 'flex' : 'none', flex: 1, minWidth: 0, minHeight: 0 }}>
        <TerminalView
          ref={terminalRef}
          sessionId={sessionId}
          isVisible={isVisible}
          onInput={handleInput}
          onResize={handleResize}
        />
      </div>
    );
  }),
  propsAreEqual,
);
