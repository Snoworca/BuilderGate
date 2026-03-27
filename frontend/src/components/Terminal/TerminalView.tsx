import { useEffect, useRef, useImperativeHandle, forwardRef, useCallback, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { usePinchZoom } from '../../hooks/usePinchZoom';
import { useResponsive } from '../../hooks/useResponsive';
import { FontSizeToast } from './FontSizeToast';
import '@xterm/xterm/css/xterm.css';
import './TerminalView.css';

const FONT_MIN = 8;
const FONT_MAX = 32;
const FONT_DEFAULT = 14;
const FONT_STORAGE_KEY = 'terminal_font_size';

// Control character sequences for IME bypass
const KEY_SEQUENCES: Record<string, string> = {
  Backspace: '\x7f',
  Escape: '\x1b',
  ArrowUp: '\x1b[A',
  ArrowDown: '\x1b[B',
  ArrowRight: '\x1b[C',
  ArrowLeft: '\x1b[D',
  Home: '\x1b[H',
  End: '\x1b[F',
  PageUp: '\x1b[5~',
  PageDown: '\x1b[6~',
  Delete: '\x1b[3~',
  Insert: '\x1b[2~',
};

export interface TerminalHandle {
  write: (data: string) => void;
  clear: () => void;
  focus: () => void;
}

interface Props {
  sessionId: string;
  onInput: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
}

export const TerminalView = forwardRef<TerminalHandle, Props>(
  ({ sessionId, onInput, onResize }, ref) => {
    const terminalRef = useRef<HTMLDivElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const xtermRef = useRef<Terminal | null>(null);
    const fitAddonRef = useRef<FitAddon | null>(null);
    const [toastFontSize, setToastFontSize] = useState<number | null>(null);
    const userActiveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const outputTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const { isMobile } = useResponsive();

    const handleFontSizeChange = useCallback((size: number) => {
      const term = xtermRef.current;
      const fitAddon = fitAddonRef.current;
      if (term && fitAddon) {
        term.options.fontSize = size;
        fitAddon.fit();
        setToastFontSize(size);
      }
    }, []);

    const { handleTouchStart, handleTouchMove, handleTouchEnd, getInitialFontSize } = usePinchZoom({
      minSize: FONT_MIN,
      maxSize: FONT_MAX,
      defaultSize: FONT_DEFAULT,
      onFontSizeChange: handleFontSizeChange,
    });

    useImperativeHandle(ref, () => ({
      write: (data: string) => {
        xtermRef.current?.write(data);
        // Track output activity — fade out indicator after 2s of silence
        const el = containerRef.current;
        if (el && !el.classList.contains('output-active')) {
          el.classList.add('output-active');
        }
        if (outputTimerRef.current) clearTimeout(outputTimerRef.current);
        outputTimerRef.current = setTimeout(() => {
          containerRef.current?.classList.remove('output-active');
        }, 2000);
      },
      clear: () => {
        xtermRef.current?.clear();
      },
      focus: () => {
        xtermRef.current?.focus();
      },
    }));

    useEffect(() => {
      if (!terminalRef.current) return;

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
        convertEol: true,
      });

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(terminalRef.current);

      term.attachCustomKeyEventHandler((ev: KeyboardEvent) => {
        if (ev.type !== 'keydown') return true;

        // Mark user as actively typing — suppresses breathing animation for 3s
        // Uses direct DOM manipulation to avoid React re-renders on every keystroke
        const el = containerRef.current;
        if (el && !el.classList.contains('user-active')) {
          el.classList.add('user-active');
        }
        if (userActiveTimerRef.current) clearTimeout(userActiveTimerRef.current);
        userActiveTimerRef.current = setTimeout(() => {
          containerRef.current?.classList.remove('user-active');
        }, 3000);

        const key = ev.key;

        if (key in KEY_SEQUENCES) {
          onInput(KEY_SEQUENCES[key]);
          return false;
        }

        if (ev.ctrlKey && !ev.altKey && !ev.metaKey && key.length === 1) {
          const char = key.toLowerCase();

          // Ctrl+C: 텍스트 선택 시 클립보드에 복사, 미선택 시 SIGINT(\x03) 전송
          if (char === 'c' && term.hasSelection()) {
            navigator.clipboard.writeText(term.getSelection());
            term.clearSelection();
            return false;
          }

          // Ctrl+V: xterm 네이티브 paste에 위임 (수동 처리 시 이중 붙여넣기 발생)
          if (char === 'v') {
            return true;
          }

          if (char >= 'a' && char <= 'z') {
            const code = char.charCodeAt(0) - 96;
            onInput(String.fromCharCode(code));
            return false;
          }
        }

        return true;
      });

      // Double rAF ensures layout is fully settled before measuring
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          fitAddon.fit();
          onResize(term.cols, term.rows);
          // term.focus() removed — focus only on user click (handleClick) to prevent
          // focus stealing when multiple terminals are mounted in grid mode (R7)

          // Set terminal background as CSS variable from theme config
          const bg = term.options.theme?.background || '#1e1e1e';
          document.documentElement.style.setProperty('--terminal-bg', bg);
        });
      });

      xtermRef.current = term;
      fitAddonRef.current = fitAddon;

      term.onData((data) => {
        if (data.length === 0) return;
        if (data === '\x1b[I' || data === '\x1b[O') return;
        onInput(data);
      });

      // Track terminal focus via DOM events (xterm v5 has no onFocus/onBlur API)
      const termEl = terminalRef.current!;
      const onFocusIn = () => containerRef.current?.classList.add('terminal-focused');
      const onFocusOut = () => containerRef.current?.classList.remove('terminal-focused');
      termEl.addEventListener('focusin', onFocusIn);
      termEl.addEventListener('focusout', onFocusOut);

      // window.resize listener removed — ResizeObserver covers all size changes

      let rafId: number | null = null;
      let resizeTimer: ReturnType<typeof setTimeout> | null = null;
      const resizeObserver = new ResizeObserver(() => {
        // rAF throttle: visual fit at most once per frame
        if (rafId !== null) cancelAnimationFrame(rafId);
        rafId = requestAnimationFrame(() => {
          fitAddon.fit();
          rafId = null;
          // Debounce server PTY resize to avoid flooding during drag
          if (resizeTimer !== null) clearTimeout(resizeTimer);
          resizeTimer = setTimeout(() => {
            onResize(term.cols, term.rows);
            resizeTimer = null;
          }, 100);
        });
      });
      // Observe both .terminal-view and .terminal-container (FitAddon measures the latter)
      resizeObserver.observe(containerRef.current!);
      resizeObserver.observe(terminalRef.current!);

      return () => {
        if (rafId !== null) cancelAnimationFrame(rafId);
        if (resizeTimer !== null) clearTimeout(resizeTimer);
        if (userActiveTimerRef.current) clearTimeout(userActiveTimerRef.current);
        if (outputTimerRef.current) clearTimeout(outputTimerRef.current);
        termEl.removeEventListener('focusin', onFocusIn);
        termEl.removeEventListener('focusout', onFocusOut);
        resizeObserver.disconnect();
        term.dispose();
      };
    }, [sessionId, onInput, onResize, getInitialFontSize]);

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

      container.addEventListener('wheel', handleWheel, { passive: false });
      return () => container.removeEventListener('wheel', handleWheel);
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

    // Auto-hide toast
    useEffect(() => {
      if (toastFontSize === null) return;
      const timer = setTimeout(() => setToastFontSize(null), 1200);
      return () => clearTimeout(timer);
    }, [toastFontSize]);

    const handleClick = useCallback(() => {
      xtermRef.current?.focus();
    }, []);

    return (
      <div className="terminal-view" ref={containerRef} onClick={handleClick}>
        <div ref={terminalRef} className="terminal-container" />
        <FontSizeToast fontSize={toastFontSize} />
      </div>
    );
  }
);

TerminalView.displayName = 'TerminalView';
