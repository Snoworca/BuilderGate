import { useEffect, useRef, useImperativeHandle, forwardRef, useCallback, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SerializeAddon } from '@xterm/addon-serialize';
import { usePinchZoom } from '../../hooks/usePinchZoom';
import { useResponsive } from '../../hooks/useResponsive';
import { FontSizeToast } from './FontSizeToast';
import {
  clearTerminalSnapshotRemovalRequest,
  getTerminalSnapshotKey,
  isTerminalSnapshotRemovalRequested,
  setTerminalSnapshotWithQuotaRecovery,
} from '../../utils/terminalSnapshot';
import {
  buildClientInputDebugMetadata,
  buildTerminalEventTapeDetails,
  buildTerminalInputDebugPayload,
  isTerminalDebugCaptureEnabled,
  recordTerminalDebugEvent,
} from '../../utils/terminalDebugCapture';
import type { InputDebugMetadata, WindowsPtyInfo } from '../../types/ws-protocol';
import '@xterm/xterm/css/xterm.css';
import './TerminalView.css';

const FONT_MIN = 8;
const FONT_MAX = 32;
const FONT_DEFAULT = 14;
const FONT_STORAGE_KEY = 'terminal_font_size';
const SNAPSHOT_SCHEMA_VERSION = 1;
const SNAPSHOT_SAVE_DEBOUNCE_MS = 2000;
const SNAPSHOT_MAX_CONTENT_LENGTH = 2_000_000;
const LARGE_WRITE_THRESHOLD = 10_000;
const MOBILE_TOUCH_PAN_THRESHOLD_PX = 12;

function warnIfSnapshotStorageRecovered(
  result: ReturnType<typeof setTerminalSnapshotWithQuotaRecovery>,
  source: string,
): void {
  const retryRemovedCount = result.retryEviction?.removedCount ?? 0;
  if (result.eviction.removedCount === 0 && retryRemovedCount === 0 && !result.retried) {
    return;
  }

  console.warn(`[TerminalView] ${source} recovered terminal snapshot storage`, {
    retried: result.retried,
    removedCount: result.eviction.removedCount + retryRemovedCount,
    beforeChars: result.eviction.beforeChars,
    afterChars: result.retryEviction?.afterChars ?? result.eviction.afterChars,
  });
}

// xterm.js v5는 방향키, Backspace 등 모든 제어 키를 네이티브로 처리.
// 커스텀 KEY_SEQUENCES 핸들러는 xterm 내부 IME/유니코드 파이프라인을 우회하여
// 한국어 등 CJK 입력 시 커서 위치 불일치 문제를 유발하므로 제거됨.

export interface TerminalHandle {
  write: (data: string) => void;
  clear: () => void;
  focus: (reason?: string) => void;
  hasSelection: () => boolean;
  getSelection: () => string;
  clearSelection: () => void;
  fit: () => void;
  repairLayout: (reason?: string) => Promise<void>;
  requestGridRepair?: (reason?: GridRepairReason) => void;
  sendInput: (data: string) => void;
  restoreSnapshot: () => Promise<boolean>;
  replaceWithSnapshot: (data: string) => Promise<void>;
  releasePending: () => void;
  setServerReady: (ready: boolean) => void;
  setWindowsPty: (info?: WindowsPtyInfo) => void;
}

export type GridRepairReason = 'manual' | 'workspace';

interface Props {
  sessionId: string;
  isVisible: boolean;
  onInput: (data: string, metadata?: InputDebugMetadata) => void;
  onResize: (cols: number, rows: number) => void;
  onManualRepair?: () => void;
}

interface TerminalSnapshot {
  schemaVersion: number;
  sessionId: string;
  content: string;
  savedAt: string;
}

export const TerminalView = forwardRef<TerminalHandle, Props>(
  ({ sessionId, isVisible, onInput, onResize, onManualRepair }, ref) => {
    const terminalRef = useRef<HTMLDivElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const xtermRef = useRef<Terminal | null>(null);
    // 우클릭 mousedown 캡처 시점에 저장 — DOM selectionchange가 xterm 선택을 지우기 전에 저장
    const savedRightClickSelRef = useRef<string>('');
    const fitAddonRef = useRef<FitAddon | null>(null);
    const serializeAddonRef = useRef<SerializeAddon | null>(null);
    const [toastFontSize, setToastFontSize] = useState<number | null>(null);
    const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const userActiveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const outputTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const idleSnapshotTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const lastSnapshotRef = useRef<string | null>(null);
    const restorePendingRef = useRef(true);
    const inputReadyRef = useRef(false);
    const geometryReadyRef = useRef(false);
    const serverReadyRef = useRef(false);
    const pendingFocusRestoreRef = useRef(false);
    const isVisibleRef = useRef(isVisible);
    const previousVisibilityRef = useRef(isVisible);
    const bufferedOutputRef = useRef<string[]>([]);
    const inFlightOutputRef = useRef<string[]>([]);
    const mobilePanStartRef = useRef<{ x: number; y: number } | null>(null);
    const mobilePanLastYRef = useRef<number | null>(null);
    const mobilePanResidualYRef = useRef(0);
    const mobilePanActiveRef = useRef(false);
    const mobilePinchActiveRef = useRef(false);
    const suppressNextClickRef = useRef(false);
    // IME 조합 상태 추적: compositionend/keydown(Space) race condition 보조 신호
    const isComposingRef = useRef<boolean>(false);
    const captureSeqRef = useRef(0);
    const compositionSeqRef = useRef(0);
    const activeCompositionSeqRef = useRef<number | null>(null);
    const { isMobile } = useResponsive();

    const getHelperTextarea = useCallback((): HTMLTextAreaElement | null => {
      const element = terminalRef.current?.querySelector('textarea.xterm-helper-textarea');
      return element instanceof HTMLTextAreaElement ? element : null;
    }, []);

    const focusTerminalInput = useCallback((reason: string) => {
      const term = xtermRef.current;
      const helperTextarea = getHelperTextarea();

      term?.focus();
      helperTextarea?.focus({ preventScroll: true });

      const activeElement = document.activeElement;
      const focusApplied = activeElement === helperTextarea && helperTextarea !== null;
      recordTerminalDebugEvent(sessionId, focusApplied ? 'focus_applied' : 'focus_fallback_applied', {
        reason,
        helperPresent: helperTextarea !== null,
        inputReady: inputReadyRef.current,
        restorePending: restorePendingRef.current,
      });
    }, [getHelperTextarea, sessionId]);

    const hasTerminalFocus = useCallback(() => {
      const terminalElement = terminalRef.current;
      const helperTextarea = getHelperTextarea();
      const activeElement = document.activeElement;
      return Boolean(
        (helperTextarea && activeElement === helperTextarea)
        || (terminalElement && activeElement instanceof Node && terminalElement.contains(activeElement))
        || containerRef.current?.classList.contains('terminal-focused')
      );
    }, [getHelperTextarea]);

    const queueFocusRestoreIfFocused = useCallback((reason: string) => {
      if (!isVisibleRef.current || !hasTerminalFocus()) {
        return;
      }

      pendingFocusRestoreRef.current = true;
      containerRef.current?.classList.add('terminal-focused');
      recordTerminalDebugEvent(sessionId, 'focus_restore_queued', { reason });
    }, [hasTerminalFocus, sessionId]);

    const restoreQueuedFocus = useCallback((reason: string) => {
      if (!pendingFocusRestoreRef.current || !inputReadyRef.current || !isVisibleRef.current) {
        return;
      }

      const helperTextarea = getHelperTextarea();
      if (!helperTextarea || helperTextarea.disabled) {
        return;
      }

      const activeElement = document.activeElement;
      const terminalElement = terminalRef.current;
      const activeIsThisTerminal = Boolean(
        activeElement
        && terminalElement
        && activeElement instanceof Node
        && terminalElement.contains(activeElement)
      );
      const activeIsNeutral = !activeElement
        || activeElement === document.body
        || activeElement === document.documentElement;

      if (!activeIsThisTerminal && !activeIsNeutral) {
        pendingFocusRestoreRef.current = false;
        containerRef.current?.classList.remove('terminal-focused');
        recordTerminalDebugEvent(sessionId, 'focus_restore_cancelled', { reason, activeTag: activeElement?.tagName ?? null });
        return;
      }

      pendingFocusRestoreRef.current = false;
      focusTerminalInput(`restore-${reason}`);
      containerRef.current?.classList.add('terminal-focused');
      recordTerminalDebugEvent(sessionId, 'focus_restored_after_gate', { reason });
    }, [focusTerminalInput, getHelperTextarea, sessionId]);

    const syncInputReadiness = useCallback((reason: string) => {
      const term = xtermRef.current;
      const helperTextarea = getHelperTextarea();
      const nextReady = Boolean(
        term
        && serverReadyRef.current
        && geometryReadyRef.current
        && !restorePendingRef.current
        && isVisibleRef.current
      );

      inputReadyRef.current = nextReady;
      if (term) {
        term.options.disableStdin = !nextReady;
      }
      if (helperTextarea) {
        helperTextarea.disabled = !nextReady;
      }

      recordTerminalDebugEvent(sessionId, 'input_gate_synced', {
        reason,
        inputReady: nextReady,
        serverReady: serverReadyRef.current,
        geometryReady: geometryReadyRef.current,
        restorePending: restorePendingRef.current,
        visible: isVisibleRef.current,
      });
      if (nextReady) {
        restoreQueuedFocus(reason);
      }
    }, [getHelperTextarea, restoreQueuedFocus, sessionId]);

    const emitResize = useCallback((cols: number, rows: number, reason: string) => {
      recordTerminalDebugEvent(sessionId, 'resize_emitted', { cols, rows, reason });
      onResize(cols, rows);
    }, [onResize, sessionId]);

    const requestViewportSync = useCallback((term: Terminal, fitFirst = false) => {
      let attempts = 0;

      const syncViewport = () => {
        if (xtermRef.current !== term) return;

        try {
          const container = containerRef.current;
          const isRenderable = Boolean(
            isVisibleRef.current &&
            container &&
            container.offsetWidth > 0 &&
            container.offsetHeight > 0
          );
          if (fitFirst && isRenderable) {
            fitAddonRef.current?.fit();
          }
          if (isRenderable) {
            term.scrollToBottom();
          }
        } catch (error) {
          attempts += 1;
          if (attempts < 2) {
            requestAnimationFrame(syncViewport);
            return;
          }
          console.warn('[TerminalView] viewport sync failed:', error);
        }
      };

      requestAnimationFrame(syncViewport);
    }, []);

    const handleFontSizeChange = useCallback((size: number) => {
      const term = xtermRef.current;
      const fitAddon = fitAddonRef.current;
      if (term && fitAddon) {
        term.options.fontSize = size;
        requestViewportSync(term, true);
        // Show toast — always reset timer even for same size value
        if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
        setToastFontSize(size);
        toastTimerRef.current = setTimeout(() => {
          setToastFontSize(null);
          toastTimerRef.current = null;
        }, 1200);
      }
    }, [requestViewportSync]);

    const { handleTouchStart, handleTouchMove, handleTouchEnd, getInitialFontSize } = usePinchZoom({
      minSize: FONT_MIN,
      maxSize: FONT_MAX,
      defaultSize: FONT_DEFAULT,
      onFontSizeChange: handleFontSizeChange,
    });

    const resetMobileTouchGesture = useCallback(() => {
      mobilePanStartRef.current = null;
      mobilePanLastYRef.current = null;
      mobilePanResidualYRef.current = 0;
      mobilePanActiveRef.current = false;
      mobilePinchActiveRef.current = false;
    }, []);

    const getTerminalCellHeight = useCallback((): number => {
      const row = terminalRef.current?.querySelector('.xterm-rows > div');
      if (row instanceof HTMLElement) {
        const height = row.getBoundingClientRect().height;
        if (height > 0) {
          return height;
        }
      }

      const term = xtermRef.current;
      const host = terminalRef.current;
      if (!term || !host || term.rows <= 0) {
        return 0;
      }

      const hostHeight = host.getBoundingClientRect().height;
      return hostHeight > 0 ? hostHeight / term.rows : 0;
    }, []);

    const handleMobileTouchStart = useCallback((event: TouchEvent) => {
      handleTouchStart(event);

      if (event.touches.length === 2) {
        mobilePinchActiveRef.current = true;
        suppressNextClickRef.current = true;
        mobilePanStartRef.current = null;
        mobilePanLastYRef.current = null;
        mobilePanResidualYRef.current = 0;
        mobilePanActiveRef.current = false;
        return;
      }

      if (event.touches.length !== 1) {
        resetMobileTouchGesture();
        return;
      }

      const touch = event.touches[0];
      mobilePinchActiveRef.current = false;
      mobilePanActiveRef.current = false;
      mobilePanResidualYRef.current = 0;
      mobilePanStartRef.current = { x: touch.clientX, y: touch.clientY };
      mobilePanLastYRef.current = touch.clientY;
    }, [handleTouchStart, resetMobileTouchGesture]);

    const handleMobileTouchMove = useCallback((event: TouchEvent) => {
      handleTouchMove(event);

      const term = xtermRef.current;
      if (!term) {
        return;
      }

      if (event.touches.length === 2) {
        mobilePinchActiveRef.current = true;
        suppressNextClickRef.current = true;
        mobilePanStartRef.current = null;
        mobilePanLastYRef.current = null;
        mobilePanResidualYRef.current = 0;
        mobilePanActiveRef.current = false;
        return;
      }

      if (event.touches.length !== 1 || mobilePinchActiveRef.current) {
        return;
      }

      const touch = event.touches[0];
      const panStart = mobilePanStartRef.current;
      if (!panStart) {
        return;
      }

      const totalDeltaX = touch.clientX - panStart.x;
      const totalDeltaY = touch.clientY - panStart.y;

      if (!mobilePanActiveRef.current) {
        if (Math.abs(totalDeltaY) < MOBILE_TOUCH_PAN_THRESHOLD_PX) {
          return;
        }

        if (Math.abs(totalDeltaY) <= Math.abs(totalDeltaX)) {
          return;
        }

        mobilePanActiveRef.current = true;
        suppressNextClickRef.current = true;
        recordTerminalDebugEvent(sessionId, 'mobile_touch_pan_started', {
          startX: Math.round(panStart.x),
          startY: Math.round(panStart.y),
          deltaY: Math.round(totalDeltaY),
          viewportY: term.buffer.active.viewportY,
          baseY: term.buffer.active.baseY,
        });
      }

      if (event.cancelable) {
        event.preventDefault();
      }

      const previousY = mobilePanLastYRef.current ?? touch.clientY;
      const deltaY = touch.clientY - previousY;
      mobilePanLastYRef.current = touch.clientY;
      mobilePanResidualYRef.current += deltaY;

      const cellHeight = getTerminalCellHeight();
      if (cellHeight <= 0) {
        return;
      }

      const rowDelta = Math.trunc(mobilePanResidualYRef.current / cellHeight);
      if (rowDelta === 0) {
        return;
      }

      mobilePanResidualYRef.current -= rowDelta * cellHeight;

      const viewportBefore = term.buffer.active.viewportY;
      const baseY = term.buffer.active.baseY;
      term.scrollLines(-rowDelta);
      const viewportAfter = term.buffer.active.viewportY;

      if (viewportAfter !== viewportBefore) {
        recordTerminalDebugEvent(sessionId, 'mobile_touch_scroll_applied', {
          gestureRows: rowDelta,
          scrollLines: -rowDelta,
          viewportBefore,
          viewportAfter,
          baseY,
          cellHeight: Math.round(cellHeight),
        });
      }
    }, [getTerminalCellHeight, handleTouchMove, sessionId]);

    const finishMobileTouchGesture = useCallback((reason: string) => {
      const term = xtermRef.current;
      if (mobilePanActiveRef.current && term) {
        recordTerminalDebugEvent(sessionId, 'mobile_touch_pan_ended', {
          reason,
          viewportY: term.buffer.active.viewportY,
          baseY: term.buffer.active.baseY,
        });
      }

      handleTouchEnd();
      resetMobileTouchGesture();
    }, [handleTouchEnd, resetMobileTouchGesture, sessionId]);

    const clearStoredSnapshot = useCallback(() => {
      try {
        localStorage.removeItem(getTerminalSnapshotKey(sessionId));
      } catch {
        // ignore localStorage failures
      }
      lastSnapshotRef.current = null;
    }, [sessionId]);

    const loadStoredSnapshot = useCallback((): TerminalSnapshot | null => {
      try {
        const raw = localStorage.getItem(getTerminalSnapshotKey(sessionId));
        if (!raw) return null;

        const snapshot = JSON.parse(raw) as Partial<TerminalSnapshot>;
        if (
          snapshot.schemaVersion !== SNAPSHOT_SCHEMA_VERSION ||
          snapshot.sessionId !== sessionId ||
          typeof snapshot.content !== 'string' ||
          snapshot.content.length === 0
        ) {
          clearStoredSnapshot();
          return null;
        }

        if (snapshot.content.length > SNAPSHOT_MAX_CONTENT_LENGTH) {
          clearStoredSnapshot();
          return null;
        }

        return {
          schemaVersion: SNAPSHOT_SCHEMA_VERSION,
          sessionId,
          content: snapshot.content,
          savedAt: typeof snapshot.savedAt === 'string' ? snapshot.savedAt : new Date().toISOString(),
        };
      } catch {
        clearStoredSnapshot();
        return null;
      }
    }, [sessionId, clearStoredSnapshot]);

    const saveSnapshot = useCallback(() => {
      const term = xtermRef.current;
      const serializeAddon = serializeAddonRef.current;
      if (!term || !serializeAddon) return;
      if (restorePendingRef.current) return;
      if (isTerminalSnapshotRemovalRequested(sessionId)) return;

      try {
        const content = `${serializeAddon.serialize()}${inFlightOutputRef.current.join('')}`;
        if (!content || content === lastSnapshotRef.current) return;
        if (content.length > SNAPSHOT_MAX_CONTENT_LENGTH) {
          console.warn('[TerminalView] snapshot too large, keeping previous snapshot');
          return;
        }

        const snapshot: TerminalSnapshot = {
          schemaVersion: SNAPSHOT_SCHEMA_VERSION,
          sessionId,
          content,
          savedAt: new Date().toISOString(),
        };
        const result = setTerminalSnapshotWithQuotaRecovery(sessionId, JSON.stringify(snapshot));
        if (!result.saved) {
          console.warn('[TerminalView] snapshot save failed after quota recovery:', result.error);
          return;
        }
        warnIfSnapshotStorageRecovered(result, 'snapshot save');
        lastSnapshotRef.current = content;
      } catch (error) {
        console.warn('[TerminalView] snapshot save failed:', error);
      }
    }, [sessionId]);

    const scheduleSnapshotSave = useCallback(() => {
      if (idleSnapshotTimerRef.current) clearTimeout(idleSnapshotTimerRef.current);
      idleSnapshotTimerRef.current = setTimeout(() => {
        saveSnapshot();
        idleSnapshotTimerRef.current = null;
      }, SNAPSHOT_SAVE_DEBOUNCE_MS);
    }, [saveSnapshot]);

    const writeOutput = useCallback((term: Terminal, data: string, onWritten?: () => void) => {
      inFlightOutputRef.current.push(data);
      term.write(data, () => {
        inFlightOutputRef.current.shift();
        if (data.length > LARGE_WRITE_THRESHOLD) {
          requestViewportSync(term);
        }
        scheduleSnapshotSave();
        onWritten?.();
      });

      const el = containerRef.current;
      if (el && !el.classList.contains('output-active')) {
        el.classList.add('output-active');
      }
      if (outputTimerRef.current) clearTimeout(outputTimerRef.current);
      outputTimerRef.current = setTimeout(() => {
        containerRef.current?.classList.remove('output-active');
      }, 2000);
    }, [scheduleSnapshotSave, requestViewportSync]);

    const flushBufferedOutput = useCallback((onWritten?: () => void) => {
      const term = xtermRef.current;
      if (!term || bufferedOutputRef.current.length === 0) {
        onWritten?.();
        return;
      }

      const pending = bufferedOutputRef.current.join('');
      bufferedOutputRef.current = [];
      writeOutput(term, pending, () => {
        onWritten?.();
      });
    }, [writeOutput]);

    const releaseRestorePending = useCallback(() => new Promise<void>((resolve) => {
      const settle = () => {
        if (bufferedOutputRef.current.length > 0) {
          flushBufferedOutput(settle);
          return;
        }
        restorePendingRef.current = false;
        syncInputReadiness('restore-complete');
        saveSnapshot();
        resolve();
      };

      flushBufferedOutput(settle);
    }), [flushBufferedOutput, saveSnapshot, syncInputReadiness]);

    const persistBufferedOutput = useCallback(() => {
      if (isTerminalSnapshotRemovalRequested(sessionId)) {
        return;
      }

      const pending = `${inFlightOutputRef.current.join('')}${bufferedOutputRef.current.join('')}`;
      if (!pending) return;

      const snapshot = loadStoredSnapshot();
      const content = `${snapshot?.content ?? ''}${pending}`;
      inFlightOutputRef.current = [];
      bufferedOutputRef.current = [];

      if (!content) return;
      if (content.length > SNAPSHOT_MAX_CONTENT_LENGTH) {
        console.warn('[TerminalView] buffered snapshot too large, keeping previous snapshot');
        lastSnapshotRef.current = snapshot?.content ?? lastSnapshotRef.current;
        return;
      }

      try {
        const nextSnapshot: TerminalSnapshot = {
          schemaVersion: SNAPSHOT_SCHEMA_VERSION,
          sessionId,
          content,
          savedAt: new Date().toISOString(),
        };
        const result = setTerminalSnapshotWithQuotaRecovery(sessionId, JSON.stringify(nextSnapshot));
        if (!result.saved) {
          console.warn('[TerminalView] buffered snapshot save failed after quota recovery:', result.error);
          return;
        }
        warnIfSnapshotStorageRecovered(result, 'buffered snapshot save');
        lastSnapshotRef.current = content;
      } catch (error) {
        console.warn('[TerminalView] buffered snapshot save failed:', error);
      }
    }, [sessionId, loadStoredSnapshot]);

    const restoreStoredSnapshot = useCallback((term: Terminal): Promise<boolean> => {
      const snapshot = loadStoredSnapshot();
      if (!snapshot) {
        return Promise.resolve(false);
      }

      return new Promise((resolve) => {
        try {
          term.write(snapshot.content, () => {
            lastSnapshotRef.current = snapshot.content;
            void releaseRestorePending().then(() => {
              requestViewportSync(term, true);
              resolve(true);
            });
          });
        } catch (error) {
          console.warn('[TerminalView] snapshot restore failed:', error);
          clearStoredSnapshot();
          resolve(false);
        }
      });
    }, [loadStoredSnapshot, releaseRestorePending, clearStoredSnapshot, requestViewportSync]);

    const replaceWithSnapshot = useCallback((data: string): Promise<void> => {
      const term = xtermRef.current;
      if (!term) {
        return Promise.resolve();
      }

      queueFocusRestoreIfFocused('replace-start');
      restorePendingRef.current = true;
      syncInputReadiness('replace-start');
      bufferedOutputRef.current = [];
      inFlightOutputRef.current = [];
      term.reset();

      if (!data) {
        return releaseRestorePending();
      }

      return new Promise((resolve) => {
        term.write(data, () => {
          lastSnapshotRef.current = data;
          void releaseRestorePending().then(() => {
            requestViewportSync(term, true);
            resolve();
          });
        });
      });
    }, [queueFocusRestoreIfFocused, releaseRestorePending, requestViewportSync, syncInputReadiness]);

    useImperativeHandle(ref, () => ({
      write: (data: string) => {
        const term = xtermRef.current;
        if (!term || restorePendingRef.current) {
          bufferedOutputRef.current.push(data);
          return;
        }

        writeOutput(term, data);
      },
      clear: () => {
        xtermRef.current?.clear();
        lastSnapshotRef.current = null;
        bufferedOutputRef.current = [];
      },
      focus: (reason = 'handle') => {
        focusTerminalInput(reason);
      },
      hasSelection: () => !!(xtermRef.current?.hasSelection() || savedRightClickSelRef.current),
      getSelection: () => xtermRef.current?.getSelection() || savedRightClickSelRef.current || '',
      clearSelection: () => {
        xtermRef.current?.clearSelection();
        savedRightClickSelRef.current = '';
      },
      fit: () => {
        if (!isVisibleRef.current) return;
        requestAnimationFrame(() => {
          fitAddonRef.current?.fit();
        });
      },
      repairLayout: (reason = 'repair-layout') => new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            const term = xtermRef.current;
            const container = containerRef.current;
            const fitAddon = fitAddonRef.current;
            if (!term || !fitAddon || !isVisibleRef.current || !container || container.offsetWidth === 0 || container.offsetHeight === 0) {
              recordTerminalDebugEvent(sessionId, 'fit_skipped_non_renderable', {
                width: container?.offsetWidth ?? 0,
                height: container?.offsetHeight ?? 0,
                reason,
              });
              resolve();
              return;
            }

            fitAddon.fit();
            recordTerminalDebugEvent(sessionId, 'fit_completed', {
              cols: term.cols,
              rows: term.rows,
              reason,
            });
            geometryReadyRef.current = true;
            syncInputReadiness(reason);
            emitResize(term.cols, term.rows, reason);
            resolve();
          });
        });
      }),
      sendInput: (data: string) => {
        const debugInput = buildTerminalInputDebugPayload(data);
        if (!inputReadyRef.current) {
          recordTerminalDebugEvent(sessionId, 'imperative_input_dropped_not_ready', {
            ...debugInput.details,
            restorePending: restorePendingRef.current,
          }, debugInput.preview);
          return;
        }
        onInput(data, buildClientInputDebugMetadata(debugInput.details));
      },
      restoreSnapshot: async () => {
        const term = xtermRef.current;
        if (!term) {
          return false;
        }
        queueFocusRestoreIfFocused('restore-start');
        restorePendingRef.current = true;
        syncInputReadiness('restore-start');
        return restoreStoredSnapshot(term);
      },
      replaceWithSnapshot: (data: string) => replaceWithSnapshot(data),
      releasePending: () => {
        if (restorePendingRef.current) {
          void releaseRestorePending();
        }
      },
      setServerReady: (ready: boolean) => {
        if (!ready) {
          queueFocusRestoreIfFocused('server-not-ready');
        }
        serverReadyRef.current = ready;
        syncInputReadiness('server-ready');
      },
      setWindowsPty: (info?: WindowsPtyInfo) => {
        const term = xtermRef.current;
        if (!term) return;
        term.options.windowsPty = info;
      },
    }), [onInput, writeOutput, restoreStoredSnapshot, replaceWithSnapshot, releaseRestorePending, focusTerminalInput, queueFocusRestoreIfFocused, syncInputReadiness, emitResize, sessionId]);

    useEffect(() => {
      if (!terminalRef.current) return;

      // Guard: clear any leftover DOM from previous instance (React StrictMode
      // double-mount can leave orphan elements if dispose() is async)
      const container = terminalRef.current;
      while (container.firstChild) {
        container.removeChild(container.firstChild);
      }

      const initialFontSize = getInitialFontSize();

      const term = new Terminal({
        cursorBlink: true,
        fontSize: initialFontSize,
        fontFamily: '"Cascadia Code", "Fira Code", Consolas, monospace',
        theme: {
          background: '#1e1e1e',
          foreground: '#d4d4d4',
          cursor: '#d4d4d4',
          cursorAccent: '#1e1e1e',
          selectionBackground: '#264f78',
          black: '#000000',
          red: '#cd3131',
          green: '#0dbc79',
          yellow: '#e5e510',
          blue: '#2472c8',
          magenta: '#bc3fbc',
          cyan: '#11a8cd',
          white: '#e5e5e5',
          brightBlack: '#666666',
          brightRed: '#f14c4c',
          brightGreen: '#23d18b',
          brightYellow: '#f5f543',
          brightBlue: '#3b8eea',
          brightMagenta: '#d670d6',
          brightCyan: '#29b8db',
          brightWhite: '#ffffff',
        },
        scrollback: 10000,
        convertEol: false,
        disableStdin: true,
      });

      const fitAddon = new FitAddon();
      const serializeAddon = new SerializeAddon();
      term.loadAddon(fitAddon);
      term.loadAddon(serializeAddon);
      term.open(terminalRef.current);
      const helperTextarea = getHelperTextarea();
      if (helperTextarea) {
        helperTextarea.setAttribute('aria-label', 'Terminal input');
        helperTextarea.disabled = true;
      }
      const nextCaptureSeq = () => {
        captureSeqRef.current += 1;
        return captureSeqRef.current;
      };
      const nextCompositionSeq = () => {
        compositionSeqRef.current += 1;
        activeCompositionSeqRef.current = compositionSeqRef.current;
        return compositionSeqRef.current;
      };
      const buildInputCaptureState = () => {
        const activeElement = document.activeElement;
        return {
          inputReady: inputReadyRef.current,
          serverReady: serverReadyRef.current,
          geometryReady: geometryReadyRef.current,
          restorePending: restorePendingRef.current,
          visible: isVisibleRef.current,
          helperDisabled: helperTextarea?.disabled ?? false,
          helperReadOnly: helperTextarea?.readOnly ?? false,
          isComposing: isComposingRef.current,
          activeElementIsHelper: activeElement === helperTextarea,
        };
      };
      const recordHelperTape = (
        kind: string,
        event: KeyboardEvent | InputEvent | CompositionEvent,
        sequence: { captureSeq?: number; compositionSeq?: number },
      ) => {
        if (!isTerminalDebugCaptureEnabled(sessionId)) {
          return;
        }
        recordTerminalDebugEvent(
          sessionId,
          kind,
          buildTerminalEventTapeDetails(event, sequence, buildInputCaptureState()),
        );
      };
      recordTerminalDebugEvent(sessionId, 'terminal_mounted');
      restorePendingRef.current = true;
      geometryReadyRef.current = false;
      serverReadyRef.current = false;
      inputReadyRef.current = false;
      bufferedOutputRef.current = [];
      xtermRef.current = term;
      fitAddonRef.current = fitAddon;
      serializeAddonRef.current = serializeAddon;

      term.attachCustomKeyEventHandler((ev: KeyboardEvent) => {
        if (ev.type !== 'keydown') return true;

        // Mark user as actively typing — suppresses breathing animation for 3s
        const el = containerRef.current;
        if (el && !el.classList.contains('user-active')) {
          el.classList.add('user-active');
        }
        if (userActiveTimerRef.current) clearTimeout(userActiveTimerRef.current);
        userActiveTimerRef.current = setTimeout(() => {
          containerRef.current?.classList.remove('user-active');
        }, 3000);

        // Ctrl+C: 텍스트 선택 시 클립보드에 복사, 미선택 시 xterm 기본 처리(SIGINT)
        if (ev.ctrlKey && !ev.altKey && !ev.metaKey && ev.key.toLowerCase() === 'c' && term.hasSelection()) {
          navigator.clipboard.writeText(term.getSelection());
          term.clearSelection();
          return false;
        }

        // Ctrl+V: xterm 내부 textarea paste 이벤트가 클립보드를 처리하므로
        // 여기서는 xterm이 \x16(Ctrl+V 문자)을 전송하지 않도록 차단만 한다.
        // 이 핸들러에서 직접 onInput을 호출하면 paste 이벤트와 이중 붙여넣기 발생.
        if (ev.ctrlKey && !ev.altKey && !ev.metaKey && ev.key.toLowerCase() === 'v') {
          return false;
        }

        // IME 가드: ev.isComposing, keyCode 229, helper textarea composition 상태를 OR 판정한다.
        // compositionend 직후 Space keydown이 같은 이벤트 루프에 도착해도 네이티브 xterm IME 처리에 위임한다.
        const imeActive = ev.isComposing || ev.keyCode === 229 || isComposingRef.current;
        if (imeActive) {
          const isSafeSpaceKey = ev.key === ' ' || ev.key === 'Spacebar' || ev.code === 'Space';
          const safeKeyName = isSafeSpaceKey
            ? null
            : ['Enter', 'Backspace', 'Tab', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown', 'Delete', 'Insert'].includes(ev.key)
              ? ev.key
              : null;
          recordTerminalDebugEvent(sessionId, 'ime_guard_delegated', {
            safeKeyName,
            keyCategory: isSafeSpaceKey ? 'space' : safeKeyName ? 'control-navigation' : 'other',
            keyCode: ev.keyCode === 229 ? 229 : null,
            isComposing: ev.isComposing,
            refActive: isComposingRef.current,
          });
          return true;
        }

        const isPlainKey = !ev.ctrlKey && !ev.altKey && !ev.metaKey;
        const isSpaceKey = ev.code === 'Space' || ev.key === ' ' || ev.key === 'Spacebar';
        const isEnterKey = ev.key === 'Enter';
        if (isPlainKey && (isSpaceKey || ev.key === 'Backspace' || isEnterKey)) {
          recordTerminalDebugEvent(sessionId, 'key_event_observed', {
            safeKeyName: isSpaceKey ? null : ev.key,
            keyCategory: isSpaceKey ? 'space' : 'control-navigation',
            repeat: ev.repeat,
            inputReady: inputReadyRef.current,
            restorePending: restorePendingRef.current,
          });
        }
        // 2차 수정: plain Space/Backspace도 xterm 네이티브 경로에 맡긴다.
        // 다만 기존 회귀 테스트와 디버그 추적을 위해 관측 이벤트는 유지한다.
        if (isPlainKey && inputReadyRef.current && (isSpaceKey || ev.key === 'Backspace')) {
          const debugInput = buildTerminalInputDebugPayload(isSpaceKey ? ' ' : '\x7f');
          recordTerminalDebugEvent(sessionId, 'manual_input_forwarded', {
            safeKeyName: isSpaceKey ? null : 'Backspace',
            keyCategory: isSpaceKey ? 'space' : 'control-navigation',
            repeat: ev.repeat,
            delegatedToXterm: true,
            ...debugInput.details,
          }, debugInput.preview);
          return true;
        }
        if (isPlainKey && inputReadyRef.current && isSpaceKey) {
          const debugInput = buildTerminalInputDebugPayload(' ');
          onInput(' ');
          recordTerminalDebugEvent(sessionId, 'manual_input_forwarded', {
            keyCategory: 'space',
            repeat: ev.repeat,
            ...debugInput.details,
          }, debugInput.preview);
          return false;
        }

        if (isPlainKey && inputReadyRef.current && ev.key === 'Backspace') {
          const debugInput = buildTerminalInputDebugPayload('\x7f');
          onInput('\x7f');
          recordTerminalDebugEvent(sessionId, 'manual_input_forwarded', {
            safeKeyName: 'Backspace',
            keyCategory: 'control-navigation',
            repeat: ev.repeat,
            ...debugInput.details,
          }, debugInput.preview);
          return false;
        }

        // 그 외 모든 키는 xterm 네이티브 처리에 위임
        return true;
      });

      // Double rAF ensures layout is fully settled before measuring
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const container = containerRef.current;
          if (!isVisibleRef.current || !container || container.offsetWidth === 0 || container.offsetHeight === 0) {
            recordTerminalDebugEvent(sessionId, 'fit_skipped_non_renderable', {
              width: container?.offsetWidth ?? 0,
              height: container?.offsetHeight ?? 0,
              reason: 'initial',
            });
            return;
          }
          fitAddon.fit();
          recordTerminalDebugEvent(sessionId, 'fit_completed', {
            cols: term.cols,
            rows: term.rows,
            reason: 'initial',
          });
          geometryReadyRef.current = true;
          emitResize(term.cols, term.rows, 'initial');
          syncInputReadiness('initial-fit');
          // term.focus() removed — focus only on user click (handleClick) to prevent
          // focus stealing when multiple terminals are mounted in grid mode (R7)

          // Set terminal background as CSS variable from theme config
          const bg = term.options.theme?.background || '#1e1e1e';
          document.documentElement.style.setProperty('--terminal-bg', bg);
        });
      });

      term.onData((data) => {
        if (data.length === 0) return;
        if (data === '\x1b[I' || data === '\x1b[O') return;
        const debugInput = buildTerminalInputDebugPayload(data, { captureSeq: nextCaptureSeq() });
        if (!inputReadyRef.current) {
          recordTerminalDebugEvent(sessionId, 'xterm_data_dropped_not_ready', {
            ...debugInput.details,
            restorePending: restorePendingRef.current,
          }, debugInput.preview);
          return;
        }
        recordTerminalDebugEvent(sessionId, 'xterm_data_emitted', debugInput.details, debugInput.preview);
        onInput(data, buildClientInputDebugMetadata(debugInput.details));
      });

      // Track terminal focus via DOM events (xterm v5 has no onFocus/onBlur API)
      const termEl = terminalRef.current!;
      const onFocusIn = () => {
        pendingFocusRestoreRef.current = false;
        containerRef.current?.classList.add('terminal-focused');
      };
      const onFocusOut = (event: FocusEvent) => {
        const nextTarget = event.relatedTarget;
        if (nextTarget instanceof Node && termEl.contains(nextTarget)) {
          return;
        }

        if (
          pendingFocusRestoreRef.current
          && (!nextTarget || nextTarget === document.body || nextTarget === document.documentElement)
        ) {
          containerRef.current?.classList.add('terminal-focused');
          return;
        }

        pendingFocusRestoreRef.current = false;
        containerRef.current?.classList.remove('terminal-focused');
      };
      const onDocumentPointerDownCapture = (event: PointerEvent) => {
        if (!pendingFocusRestoreRef.current) {
          return;
        }

        const target = event.target;
        if (target instanceof Node && termEl.contains(target)) {
          return;
        }

        pendingFocusRestoreRef.current = false;
        containerRef.current?.classList.remove('terminal-focused');
        recordTerminalDebugEvent(sessionId, 'focus_restore_cancelled', { reason: 'external-pointer' });
      };
      termEl.addEventListener('focusin', onFocusIn);
      termEl.addEventListener('focusout', onFocusOut);
      document.addEventListener('pointerdown', onDocumentPointerDownCapture, true);

      // xterm v6은 paste 이벤트에서 clipboardData를 읽어 처리한 뒤 preventDefault를 호출하지 않아
      // 브라우저가 textarea에 텍스트를 추가로 삽입하고 input 이벤트를 발생시킨다.
      // 일부 Chrome/Windows 환경에서 해당 input 이벤트가 insertText 타입으로 올 경우
      // xterm의 _inputEvent 핸들러가 두 번째 triggerDataEvent를 호출해 이중 붙여넣기가 발생한다.
      // capture 단계에서 preventDefault를 호출하면 브라우저 삽입 동작만 막고
      // xterm 내부 paste 핸들러(clipboardData 읽기)는 그대로 실행된다.
      const onPasteCapture = (e: Event) => { e.preventDefault(); };
      termEl.addEventListener('paste', onPasteCapture, { capture: true });

      // Helper textarea에 조합 상태를 별도로 기록한다.
      // compositionend는 한 tick 지연 해제하여 같은 turn의 Space keydown이 아직 조합 중으로 보이게 한다.
      const onHelperKeyDown = (event: KeyboardEvent) => {
        recordHelperTape('helper_keydown', event, { captureSeq: nextCaptureSeq() });
      };
      const onHelperBeforeInput = (event: Event) => {
        if (event instanceof InputEvent) {
          recordHelperTape('helper_beforeinput', event, { captureSeq: nextCaptureSeq() });
        }
      };
      const onHelperInput = (event: Event) => {
        if (event instanceof InputEvent) {
          recordHelperTape('helper_input', event, { captureSeq: nextCaptureSeq() });
        }
      };
      const onCompositionStart = (event: CompositionEvent) => {
        isComposingRef.current = true;
        recordHelperTape('helper_compositionstart', event, { compositionSeq: nextCompositionSeq() });
      };
      const onCompositionUpdate = (event: CompositionEvent) => {
        const compositionSeq = activeCompositionSeqRef.current ?? nextCompositionSeq();
        recordHelperTape('helper_compositionupdate', event, { compositionSeq });
      };
      const onCompositionEnd = (event: CompositionEvent) => {
        const compositionSeq = activeCompositionSeqRef.current ?? nextCompositionSeq();
        recordHelperTape('helper_compositionend', event, { compositionSeq });
        setTimeout(() => {
          isComposingRef.current = false;
          if (activeCompositionSeqRef.current === compositionSeq) {
            activeCompositionSeqRef.current = null;
          }
        }, 0);
      };
      if (helperTextarea) {
        helperTextarea.addEventListener('keydown', onHelperKeyDown);
        helperTextarea.addEventListener('beforeinput', onHelperBeforeInput);
        helperTextarea.addEventListener('input', onHelperInput);
        helperTextarea.addEventListener('compositionstart', onCompositionStart);
        helperTextarea.addEventListener('compositionupdate', onCompositionUpdate);
        helperTextarea.addEventListener('compositionend', onCompositionEnd);
      }

      // 우클릭 캡처: DOM selectionchange가 xterm 선택을 지우기 전에 선택 텍스트 저장
      // (DOM 렌더러 모드에서 right-click mousedown이 DOM selection을 collapse시켜
      //  xterm이 자신의 selection을 clearSelection() 하는 타이밍 문제 해결)
      const onMouseDownCapture = (e: MouseEvent) => {
        if (e.button === 2) {
          savedRightClickSelRef.current = term.getSelection();
        } else if (e.button === 0) {
          savedRightClickSelRef.current = '';
        }
      };
      containerRef.current!.addEventListener('mousedown', onMouseDownCapture, true);

      // window.resize listener removed — ResizeObserver covers all size changes

      let rafId: number | null = null;
      let resizeTimer: ReturnType<typeof setTimeout> | null = null;
      const resizeObserver = new ResizeObserver(() => {
        // 0-size 가드: display:none 상태(워크스페이스 비활성)에서는 fit 및 PTY resize 스킵
        const container = containerRef.current;
        if (!isVisibleRef.current || !container || container.offsetWidth === 0 || container.offsetHeight === 0) {
          recordTerminalDebugEvent(sessionId, 'fit_skipped_non_renderable', {
            width: container?.offsetWidth ?? 0,
            height: container?.offsetHeight ?? 0,
          });
          return;
        }

        // rAF throttle: visual fit at most once per frame
        if (rafId !== null) cancelAnimationFrame(rafId);
        rafId = requestAnimationFrame(() => {
          fitAddon.fit();
          recordTerminalDebugEvent(sessionId, 'fit_completed', {
            cols: term.cols,
            rows: term.rows,
            reason: 'resize-observer',
          });
          geometryReadyRef.current = true;
          syncInputReadiness('resize-observer');
          rafId = null;
          // Debounce server PTY resize to avoid flooding during drag
          if (resizeTimer !== null) clearTimeout(resizeTimer);
          resizeTimer = setTimeout(() => {
            emitResize(term.cols, term.rows, 'resize-observer');
            resizeTimer = null;
          }, 100);
        });
      });
      // Observe both .terminal-view and .terminal-container (FitAddon measures the latter)
      resizeObserver.observe(containerRef.current!);
      resizeObserver.observe(terminalRef.current!);

      return () => {
        containerRef.current?.removeEventListener('mousedown', onMouseDownCapture, true);
        termEl.removeEventListener('paste', onPasteCapture, { capture: true });
        if (helperTextarea) {
          helperTextarea.removeEventListener('keydown', onHelperKeyDown);
          helperTextarea.removeEventListener('beforeinput', onHelperBeforeInput);
          helperTextarea.removeEventListener('input', onHelperInput);
          helperTextarea.removeEventListener('compositionstart', onCompositionStart);
          helperTextarea.removeEventListener('compositionupdate', onCompositionUpdate);
          helperTextarea.removeEventListener('compositionend', onCompositionEnd);
        }
        if (rafId !== null) cancelAnimationFrame(rafId);
        if (resizeTimer !== null) clearTimeout(resizeTimer);
        if (idleSnapshotTimerRef.current) {
          clearTimeout(idleSnapshotTimerRef.current);
          idleSnapshotTimerRef.current = null;
        }
        if (userActiveTimerRef.current) clearTimeout(userActiveTimerRef.current);
        if (outputTimerRef.current) clearTimeout(outputTimerRef.current);
        if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
        termEl.removeEventListener('focusin', onFocusIn);
        termEl.removeEventListener('focusout', onFocusOut);
        document.removeEventListener('pointerdown', onDocumentPointerDownCapture, true);
        resizeObserver.disconnect();
        if (isTerminalSnapshotRemovalRequested(sessionId)) {
          clearTerminalSnapshotRemovalRequest(sessionId);
        } else if (restorePendingRef.current) {
          persistBufferedOutput();
        } else {
          saveSnapshot();
        }
        serializeAddonRef.current = null;
        fitAddonRef.current = null;
        xtermRef.current = null;
        geometryReadyRef.current = false;
        serverReadyRef.current = false;
        restorePendingRef.current = false;
        inputReadyRef.current = false;
        inFlightOutputRef.current = [];
        bufferedOutputRef.current = [];
        recordTerminalDebugEvent(sessionId, 'terminal_disposed');
        term.dispose();
      };
    }, [sessionId, onInput, emitResize, getInitialFontSize, persistBufferedOutput, saveSnapshot, getHelperTextarea, syncInputReadiness]);

    useEffect(() => {
      const wasVisible = previousVisibilityRef.current;
      previousVisibilityRef.current = isVisible;
      isVisibleRef.current = isVisible;

      const term = xtermRef.current;
      if (!term) {
        return;
      }

      if (wasVisible === isVisible) {
        return;
      }

      if (!isVisible) {
        syncInputReadiness('hidden');
        return;
      }

      requestAnimationFrame(() => {
        const container = containerRef.current;
        if (!container || container.offsetWidth === 0 || container.offsetHeight === 0) {
          recordTerminalDebugEvent(sessionId, 'fit_skipped_non_renderable', {
            width: container?.offsetWidth ?? 0,
            height: container?.offsetHeight ?? 0,
            reason: 'visible',
          });
          return;
        }

        fitAddonRef.current?.fit();
        recordTerminalDebugEvent(sessionId, 'fit_completed', {
          cols: term.cols,
          rows: term.rows,
          reason: 'visible',
        });
        geometryReadyRef.current = true;
        emitResize(term.cols, term.rows, 'visible');
        syncInputReadiness('visible-fit');
      });
    }, [emitResize, isVisible, sessionId, syncInputReadiness]);

    useEffect(() => {
      const persistSnapshot = () => {
        if (idleSnapshotTimerRef.current) {
          clearTimeout(idleSnapshotTimerRef.current);
          idleSnapshotTimerRef.current = null;
        }
        if (restorePendingRef.current) {
          persistBufferedOutput();
        } else {
          saveSnapshot();
        }
      };

      window.addEventListener('beforeunload', persistSnapshot);
      window.addEventListener('pagehide', persistSnapshot);
      return () => {
        window.removeEventListener('beforeunload', persistSnapshot);
        window.removeEventListener('pagehide', persistSnapshot);
      };
    }, [persistBufferedOutput, saveSnapshot]);

    // Desktop: Ctrl+Wheel font zoom
    useEffect(() => {
      if (isMobile) return;
      const container = containerRef.current;
      if (!container) return;

      const handleWheel = (e: WheelEvent) => {
        if (e.ctrlKey) {
          e.preventDefault();
          const currentSize = xtermRef.current?.options.fontSize || FONT_DEFAULT;
          const delta = e.deltaY < 0 ? 1 : -1;
          const newSize = Math.max(FONT_MIN, Math.min(FONT_MAX, currentSize + delta));
          handleFontSizeChange(newSize);
          localStorage.setItem(FONT_STORAGE_KEY, newSize.toString());
        }
      };

      // Use capture phase to intercept Ctrl+Wheel before xterm's viewport scrolls
      container.addEventListener('wheel', handleWheel, { passive: false, capture: true });
      return () => container.removeEventListener('wheel', handleWheel, { capture: true });
    }, [isMobile, handleFontSizeChange]);

    // Mobile: single-touch pan scroll + two-touch pinch zoom
    useEffect(() => {
      if (!isMobile) return;
      const container = containerRef.current;
      if (!container) return;
      const onTouchEnd = () => finishMobileTouchGesture('touchend');
      const onTouchCancel = () => finishMobileTouchGesture('touchcancel');

      container.addEventListener('touchstart', handleMobileTouchStart, { passive: false });
      container.addEventListener('touchmove', handleMobileTouchMove, { passive: false });
      container.addEventListener('touchend', onTouchEnd);
      container.addEventListener('touchcancel', onTouchCancel);

      return () => {
        container.removeEventListener('touchstart', handleMobileTouchStart);
        container.removeEventListener('touchmove', handleMobileTouchMove);
        container.removeEventListener('touchend', onTouchEnd);
        container.removeEventListener('touchcancel', onTouchCancel);
      };
    }, [isMobile, handleMobileTouchStart, handleMobileTouchMove, finishMobileTouchGesture]);



    const handleClick = useCallback(() => {
      if (suppressNextClickRef.current) {
        suppressNextClickRef.current = false;
        recordTerminalDebugEvent(sessionId, 'mobile_touch_click_suppressed');
        return;
      }
      focusTerminalInput('terminal-view-click');
    }, [focusTerminalInput, sessionId]);

    const handleManualRepairMouseEvent = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
      if (event.button !== 1 || !onManualRepair) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      onManualRepair?.();
    }, [onManualRepair]);

    const handleManualRepairPointerEvent = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 1 || !onManualRepair) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      onManualRepair?.();
    }, [onManualRepair]);

    return (
      <div
        className="terminal-view"
        ref={containerRef}
        data-terminal-view="true"
        style={isMobile ? { touchAction: 'none' } : undefined}
        onClick={handleClick}
        onPointerDownCapture={handleManualRepairPointerEvent}
        onMouseDownCapture={handleManualRepairMouseEvent}
        onAuxClickCapture={handleManualRepairMouseEvent}
      >
        <div ref={terminalRef} className="terminal-container" data-terminal-container="true" />
        <FontSizeToast fontSize={toastFontSize} />
      </div>
    );
  }
);

TerminalView.displayName = 'TerminalView';
