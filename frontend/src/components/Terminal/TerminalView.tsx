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
} from '../../utils/terminalSnapshot';
import { recordTerminalDebugEvent } from '../../utils/terminalDebugCapture';
import type { WindowsPtyInfo } from '../../types/ws-protocol';
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

// xterm.js v5는 방향키, Backspace 등 모든 제어 키를 네이티브로 처리.
// 커스텀 KEY_SEQUENCES 핸들러는 xterm 내부 IME/유니코드 파이프라인을 우회하여
// 한국어 등 CJK 입력 시 커서 위치 불일치 문제를 유발하므로 제거됨.

export interface TerminalHandle {
  write: (data: string) => void;
  clear: () => void;
  focus: () => void;
  hasSelection: () => boolean;
  getSelection: () => string;
  getRenderedText: () => string;
  clearSelection: () => void;
  fit: () => void;
  sendInput: (data: string) => void;
  restoreSnapshot: () => Promise<boolean>;
  replaceWithSnapshot: (data: string) => Promise<void>;
  releasePending: () => void;
  setWindowsPty: (info?: WindowsPtyInfo) => void;
}

interface Props {
  sessionId: string;
  isVisible: boolean;
  onInput: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
}

interface TerminalSnapshot {
  schemaVersion: number;
  sessionId: string;
  content: string;
  savedAt: string;
}

export const TerminalView = forwardRef<TerminalHandle, Props>(
  ({ sessionId, isVisible, onInput, onResize }, ref) => {
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
    const lastSentGeometryRef = useRef<string | null>(null);
    const restorePendingRef = useRef(true);
    const inputReadyRef = useRef(false);
    const bufferedOutputRef = useRef<string[]>([]);
    const inFlightOutputRef = useRef<string[]>([]);
    const isVisibleRef = useRef(isVisible);
    const { isMobile } = useResponsive();

    useEffect(() => {
      isVisibleRef.current = isVisible;
    }, [isVisible]);

    const hasRenderableViewport = useCallback(() => {
      const container = containerRef.current;
      return Boolean(container && container.offsetWidth > 0 && container.offsetHeight > 0);
    }, []);

    const enableInputIfReady = useCallback((term: Terminal) => {
      if (!isVisibleRef.current) return;
      if (restorePendingRef.current) return;
      if (inputReadyRef.current) return;
      inputReadyRef.current = true;
      term.options.disableStdin = false;
    }, []);

    const disableInputForRestore = useCallback((term: Terminal) => {
      inputReadyRef.current = false;
      term.options.disableStdin = true;
    }, []);

    const emitResizeIfChanged = useCallback((term: Terminal) => {
      if (!isVisibleRef.current) {
        recordTerminalDebugEvent(sessionId, 'resize_skipped_hidden', {
          cols: term.cols,
          rows: term.rows,
        });
        return false;
      }
      if (term.cols <= 0 || term.rows <= 0) {
        recordTerminalDebugEvent(sessionId, 'resize_skipped_invalid_geometry', {
          cols: term.cols,
          rows: term.rows,
        });
        return false;
      }

      const nextGeometry = `${term.cols}x${term.rows}`;
      if (lastSentGeometryRef.current === nextGeometry) {
        recordTerminalDebugEvent(sessionId, 'resize_skipped_unchanged', {
          cols: term.cols,
          rows: term.rows,
        });
        return false;
      }

      lastSentGeometryRef.current = nextGeometry;
      recordTerminalDebugEvent(sessionId, 'resize_emitted', {
        cols: term.cols,
        rows: term.rows,
      });
      onResize(term.cols, term.rows);
      return true;
    }, [onResize, sessionId]);

    const fitTerminal = useCallback((term: Terminal) => {
      if (!isVisibleRef.current) {
        recordTerminalDebugEvent(sessionId, 'fit_skipped_hidden');
        return false;
      }
      const container = containerRef.current;
      if (!hasRenderableViewport()) {
        recordTerminalDebugEvent(sessionId, 'fit_skipped_non_renderable', {
          offsetWidth: container?.offsetWidth ?? null,
          offsetHeight: container?.offsetHeight ?? null,
        });
        return false;
      }

      fitAddonRef.current?.fit();
      recordTerminalDebugEvent(sessionId, 'fit_completed', {
        cols: term.cols,
        rows: term.rows,
        offsetWidth: container?.offsetWidth ?? null,
        offsetHeight: container?.offsetHeight ?? null,
      });
      enableInputIfReady(term);
      return true;
    }, [enableInputIfReady, hasRenderableViewport, sessionId]);

    const requestViewportSync = useCallback((term: Terminal, fitFirst = false) => {
      recordTerminalDebugEvent(sessionId, 'viewport_sync_requested', {
        fitFirst,
        cols: term.cols,
        rows: term.rows,
      });
      let attempts = 0;

      const syncViewport = () => {
        if (xtermRef.current !== term) return;
        if (!isVisibleRef.current) {
          recordTerminalDebugEvent(sessionId, 'viewport_sync_skipped_hidden', {
            fitFirst,
            cols: term.cols,
            rows: term.rows,
          });
          return;
        }

        try {
          if (fitFirst) {
            fitAddonRef.current?.fit();
          }
          term.scrollToBottom();
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
        localStorage.setItem(getTerminalSnapshotKey(sessionId), JSON.stringify(snapshot));
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

    const releaseRestorePending = useCallback(function releaseRestorePending() {
      flushBufferedOutput(() => {
        if (bufferedOutputRef.current.length > 0) {
          releaseRestorePending();
          return;
        }
        restorePendingRef.current = false;
        const term = xtermRef.current;
        if (term) {
          enableInputIfReady(term);
        }
        saveSnapshot();
      });
    }, [enableInputIfReady, flushBufferedOutput, saveSnapshot]);

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
        localStorage.setItem(getTerminalSnapshotKey(sessionId), JSON.stringify(nextSnapshot));
        lastSnapshotRef.current = content;
      } catch {
        // ignore localStorage failures
      }
    }, [sessionId, loadStoredSnapshot]);

    const restoreStoredSnapshot = useCallback((term: Terminal): Promise<boolean> => {
      const snapshot = loadStoredSnapshot();
      if (!snapshot) {
        return Promise.resolve(false);
      }

      return new Promise((resolve) => {
        try {
          recordTerminalDebugEvent(sessionId, 'local_snapshot_restore_started', {
            byteLength: snapshot.content.length,
          }, snapshot.content);
          term.write(snapshot.content, () => {
            lastSnapshotRef.current = snapshot.content;
            releaseRestorePending();
            requestViewportSync(term, true);
            recordTerminalDebugEvent(sessionId, 'local_snapshot_restore_completed', {
              byteLength: snapshot.content.length,
            }, snapshot.content);
            resolve(true);
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

      restorePendingRef.current = true;
      disableInputForRestore(term);
      bufferedOutputRef.current = [];
      inFlightOutputRef.current = [];
      recordTerminalDebugEvent(sessionId, 'replace_snapshot_started', {
        byteLength: data.length,
      }, data);
      term.reset();

      if (!data) {
        releaseRestorePending();
        return Promise.resolve();
      }

      return new Promise((resolve) => {
        term.write(data, () => {
          lastSnapshotRef.current = data;
          releaseRestorePending();
          requestViewportSync(term, true);
          recordTerminalDebugEvent(sessionId, 'replace_snapshot_completed', {
            byteLength: data.length,
          }, data);
          resolve();
        });
      });
    }, [disableInputForRestore, releaseRestorePending, requestViewportSync, sessionId]);

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
      focus: () => {
        xtermRef.current?.focus();
      },
      hasSelection: () => !!(xtermRef.current?.hasSelection() || savedRightClickSelRef.current),
      getSelection: () => xtermRef.current?.getSelection() || savedRightClickSelRef.current || '',
      getRenderedText: () => {
        return containerRef.current?.querySelector('.xterm-rows')?.textContent ?? '';
      },
      clearSelection: () => {
        xtermRef.current?.clearSelection();
        savedRightClickSelRef.current = '';
      },
      fit: () => {
        requestAnimationFrame(() => {
          const term = xtermRef.current;
          if (!term) return;
          if (!fitTerminal(term)) return;
          emitResizeIfChanged(term);
        });
      },
      sendInput: (data: string) => {
        onInput(data);
      },
      restoreSnapshot: async () => {
        const term = xtermRef.current;
        if (!term) {
          return false;
        }
        restorePendingRef.current = true;
        disableInputForRestore(term);
        return restoreStoredSnapshot(term);
      },
      replaceWithSnapshot: (data: string) => replaceWithSnapshot(data),
      releasePending: () => {
        if (restorePendingRef.current) {
          releaseRestorePending();
        }
      },
      setWindowsPty: (info?: WindowsPtyInfo) => {
        const term = xtermRef.current;
        if (!term) return;
        term.options.windowsPty = info;
      },
    }), [disableInputForRestore, emitResizeIfChanged, fitTerminal, onInput, writeOutput, restoreStoredSnapshot, replaceWithSnapshot, releaseRestorePending]);

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
      restorePendingRef.current = true;
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

        // 그 외 모든 키는 xterm 네이티브 처리에 위임
        return true;
      });

      // Double rAF ensures layout is fully settled before measuring
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
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
        if (!inputReadyRef.current) return;
        onInput(data);
      });

      // Track terminal focus via DOM events (xterm v5 has no onFocus/onBlur API)
      const termEl = terminalRef.current!;
      const onFocusIn = () => {
        containerRef.current?.classList.add('terminal-focused');
        enableInputIfReady(term);
      };
      const onFocusOut = () => containerRef.current?.classList.remove('terminal-focused');
      termEl.addEventListener('focusin', onFocusIn);
      termEl.addEventListener('focusout', onFocusOut);

      // xterm v6은 paste 이벤트에서 clipboardData를 읽어 처리한 뒤 preventDefault를 호출하지 않아
      // 브라우저가 textarea에 텍스트를 추가로 삽입하고 input 이벤트를 발생시킨다.
      // 일부 Chrome/Windows 환경에서 해당 input 이벤트가 insertText 타입으로 올 경우
      // xterm의 _inputEvent 핸들러가 두 번째 triggerDataEvent를 호출해 이중 붙여넣기가 발생한다.
      // capture 단계에서 preventDefault를 호출하면 브라우저 삽입 동작만 막고
      // xterm 내부 paste 핸들러(clipboardData 읽기)는 그대로 실행된다.
      const onPasteCapture = (e: Event) => { e.preventDefault(); };
      termEl.addEventListener('paste', onPasteCapture, { capture: true });

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
        if (!hasRenderableViewport()) return;

        // rAF throttle: visual fit at most once per frame
        if (rafId !== null) cancelAnimationFrame(rafId);
        rafId = requestAnimationFrame(() => {
          if (!fitTerminal(term)) {
            rafId = null;
            return;
          }
          rafId = null;
          // Debounce server PTY resize to avoid flooding during drag
          if (resizeTimer !== null) clearTimeout(resizeTimer);
          resizeTimer = setTimeout(() => {
            emitResizeIfChanged(term);
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
        lastSentGeometryRef.current = null;
        restorePendingRef.current = false;
        inputReadyRef.current = false;
        inFlightOutputRef.current = [];
        bufferedOutputRef.current = [];
        term.dispose();
      };
    }, [sessionId, emitResizeIfChanged, enableInputIfReady, fitTerminal, getInitialFontSize, hasRenderableViewport, onInput, persistBufferedOutput, saveSnapshot]);

    useEffect(() => {
      const term = xtermRef.current;
      if (!term) return;

      if (!isVisible) {
        disableInputForRestore(term);
        recordTerminalDebugEvent(sessionId, 'visibility_hidden_input_disabled');
        return;
      }

      requestAnimationFrame(() => {
        const activeTerm = xtermRef.current;
        if (!activeTerm) return;
        if (fitTerminal(activeTerm)) {
          emitResizeIfChanged(activeTerm);
        }
      });
    }, [disableInputForRestore, emitResizeIfChanged, fitTerminal, isVisible, sessionId]);

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

    // Mobile: Pinch-to-zoom touch events
    useEffect(() => {
      if (!isMobile) return;
      const container = containerRef.current;
      if (!container) return;

      container.addEventListener('touchstart', handleTouchStart, { passive: false });
      container.addEventListener('touchmove', handleTouchMove, { passive: false });
      container.addEventListener('touchend', handleTouchEnd);

      return () => {
        container.removeEventListener('touchstart', handleTouchStart);
        container.removeEventListener('touchmove', handleTouchMove);
        container.removeEventListener('touchend', handleTouchEnd);
      };
    }, [isMobile, handleTouchStart, handleTouchMove, handleTouchEnd]);



    const handleClick = useCallback(() => {
      const term = xtermRef.current;
      if (!term) return;
      enableInputIfReady(term);
      term.focus();
    }, [enableInputIfReady]);

    return (
      <div className="terminal-view" ref={containerRef} onClick={handleClick}>
        <div ref={terminalRef} className="terminal-container" />
        <FontSizeToast fontSize={toastFontSize} />
      </div>
    );
  }
);

TerminalView.displayName = 'TerminalView';
