import { memo, useRef, useCallback, useEffect, forwardRef, useImperativeHandle, useEffectEvent } from 'react';
import { useWebSocketActions } from '../../contexts/WebSocketContext';
import { useTerminalRuntimeRegistryActions } from '../../contexts/TerminalRuntimeRegistryContext';
import { TerminalView } from './TerminalView';
import type { TerminalHandle } from './TerminalView';
import type { WorkspaceTabRuntime } from '../../types/workspace';
import {
  clearTerminalDebugEvents,
  disableTerminalDebugCapture,
  recordTerminalDebugEvent,
} from '../../utils/terminalDebugCapture';

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

export const TerminalContainer = memo(
  forwardRef<TerminalHandle, Props>(function TerminalContainer(
    { sessionId, isVisible, onStatusChange, onCwdChange },
    ref
  ) {
    const terminalRef = useRef<TerminalHandle>(null);
    const initialRestorePendingRef = useRef(true);
    const historySeenRef = useRef(false);
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
      getRenderedText: () => terminalRef.current?.getRenderedText() ?? '',
      clearSelection: () => terminalRef.current?.clearSelection(),
      fit: () => terminalRef.current?.fit(),
      sendInput: (data) => terminalRef.current?.sendInput(data),
      restoreSnapshot: () => terminalRef.current?.restoreSnapshot() ?? Promise.resolve(false),
      replaceWithSnapshot: (data) => terminalRef.current?.replaceWithSnapshot(data) ?? Promise.resolve(),
      releasePending: () => terminalRef.current?.releasePending(),
      setWindowsPty: (info) => terminalRef.current?.setWindowsPty(info),
    }), []);

    const { send, subscribeSession } = useWebSocketActions();
    const { attachRuntimeHandleRef, registerRuntimeConsumer } = useTerminalRuntimeRegistryActions();

    useEffect(() => {
      initialRestorePendingRef.current = true;
      historySeenRef.current = false;
      lastAppliedSnapshotRef.current = null;
      clearTerminalDebugEvents(sessionId);
      recordTerminalDebugEvent(sessionId, 'session_attached');
      return () => {
        disableTerminalDebugCapture(sessionId);
        clearTerminalDebugEvents(sessionId);
      };
    }, [sessionId]);

    useEffect(() => {
      return registerRuntimeConsumer(sessionId);
    }, [registerRuntimeConsumer, sessionId]);

    useEffect(() => {
      return attachRuntimeHandleRef(sessionId, terminalRef);
    }, [attachRuntimeHandleRef, sessionId]);

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

    const handleScreenSnapshot = useEffectEvent(async (snapshot: {
      seq: number;
      data: string;
      mode: 'authoritative' | 'fallback';
      truncated: boolean;
      replayToken: string;
      windowsPty?: { backend: 'conpty' | 'winpty'; buildNumber?: number };
    }) => {
      recordTerminalDebugEvent(sessionId, 'screen_snapshot_received', {
        seq: snapshot.seq,
        mode: snapshot.mode,
        truncated: snapshot.truncated,
        byteLength: snapshot.data.length,
      }, snapshot.data);

      const previousSnapshot = lastAppliedSnapshotRef.current;
      if (
        previousSnapshot &&
        previousSnapshot.seq === snapshot.seq &&
        previousSnapshot.mode === snapshot.mode &&
        previousSnapshot.truncated === snapshot.truncated &&
        previousSnapshot.data === snapshot.data
      ) {
        recordTerminalDebugEvent(sessionId, 'screen_snapshot_duplicate_ignored', {
          seq: snapshot.seq,
          mode: snapshot.mode,
        });
        send({ type: 'screen-snapshot:ready', sessionId, replayToken: snapshot.replayToken });
        return;
      }

      historySeenRef.current = true;
      terminalRef.current?.setWindowsPty(snapshot.windowsPty);

      if (snapshot.mode === 'fallback') {
        if (snapshot.data.length > 0) {
          await terminalRef.current?.replaceWithSnapshot(snapshot.data);
          recordTerminalDebugEvent(sessionId, 'screen_snapshot_fallback_applied', {
            seq: snapshot.seq,
            byteLength: snapshot.data.length,
          }, snapshot.data);
        } else {
          const restored = await terminalRef.current?.restoreSnapshot();
          if (!restored) {
            await terminalRef.current?.replaceWithSnapshot(FALLBACK_EMPTY_MESSAGE);
            recordTerminalDebugEvent(sessionId, 'screen_snapshot_fallback_placeholder_applied', {
              seq: snapshot.seq,
            }, FALLBACK_EMPTY_MESSAGE);
          } else {
            recordTerminalDebugEvent(sessionId, 'screen_snapshot_fallback_local_restore', {
              seq: snapshot.seq,
            });
          }
        }
      } else {
        await terminalRef.current?.replaceWithSnapshot(snapshot.data);
        recordTerminalDebugEvent(sessionId, 'screen_snapshot_authoritative_applied', {
          seq: snapshot.seq,
          byteLength: snapshot.data.length,
        }, snapshot.data);
      }

      lastAppliedSnapshotRef.current = {
        seq: snapshot.seq,
        mode: snapshot.mode,
        truncated: snapshot.truncated,
        data: snapshot.data,
      };
      recordTerminalDebugEvent(sessionId, 'screen_snapshot_ack_sent', {
        seq: snapshot.seq,
        mode: snapshot.mode,
      });
      send({ type: 'screen-snapshot:ready', sessionId, replayToken: snapshot.replayToken });
      initialRestorePendingRef.current = false;
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
      <div
        aria-hidden={!isVisible}
        style={{ display: 'flex', flex: 1, minWidth: 0, minHeight: 0 }}
      >
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
