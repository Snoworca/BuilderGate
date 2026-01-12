import { useEffect, useRef, useImperativeHandle, forwardRef, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import './TerminalView.css';

// Control character sequences for IME bypass
// These keys are handled directly to prevent IME from intercepting them
// Note: Enter and Tab are NOT included - they work correctly with IME
// and need xterm.js default handling for proper shell integration
const KEY_SEQUENCES: Record<string, string> = {
  // Essential control characters (IME-problematic keys only)
  Backspace: '\x7f',
  Escape: '\x1b',

  // Arrow keys (Normal mode)
  ArrowUp: '\x1b[A',
  ArrowDown: '\x1b[B',
  ArrowRight: '\x1b[C',
  ArrowLeft: '\x1b[D',

  // Navigation keys
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
    const xtermRef = useRef<Terminal | null>(null);
    const fitAddonRef = useRef<FitAddon | null>(null);

    useImperativeHandle(ref, () => ({
      write: (data: string) => {
        xtermRef.current?.write(data);
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

      const term = new Terminal({
        cursorBlink: true,
        fontSize: 14,
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

      // Handle control characters directly to bypass IME
      // This ensures Backspace, Enter, Arrow keys, etc. work correctly
      // even when Korean IME (or other CJK IME) is active
      term.attachCustomKeyEventHandler((ev: KeyboardEvent) => {
        // Only handle keydown events
        if (ev.type !== 'keydown') {
          return true;
        }

        const key = ev.key;

        // 1. Handle basic control characters (Backspace, Enter, Tab, Escape, Arrows, etc.)
        if (key in KEY_SEQUENCES) {
          onInput(KEY_SEQUENCES[key]);
          return false; // Prevent xterm.js default handling
        }

        // 2. Handle Ctrl+key combinations (Ctrl+C, Ctrl+D, Ctrl+Z, etc.)
        if (ev.ctrlKey && !ev.altKey && !ev.metaKey && key.length === 1) {
          const char = key.toLowerCase();
          if (char >= 'a' && char <= 'z') {
            // Ctrl+A = \x01, Ctrl+B = \x02, ..., Ctrl+Z = \x1a
            const code = char.charCodeAt(0) - 96; // 'a' = 97, so 97-96 = 1
            onInput(String.fromCharCode(code));
            return false;
          }
        }

        // 3. Let xterm.js handle everything else (regular characters, IME input)
        return true;
      });

      // Fit after a small delay to ensure container is rendered
      setTimeout(() => {
        fitAddon.fit();
        onResize(term.cols, term.rows);
        // Auto-focus the terminal for immediate input
        term.focus();
      }, 0);

      xtermRef.current = term;
      fitAddonRef.current = fitAddon;

      // Handle user input
      term.onData((data) => {
        // Filter out empty strings (can happen with IME)
        if (data.length === 0) {
          return;
        }

        // Filter out Focus In/Out sequences (ESC[I and ESC[O)
        // These are sent when Focus Reporting is enabled by the application
        if (data === '\x1b[I' || data === '\x1b[O') {
          return;
        }

        onInput(data);
      });

      // Handle window resize
      const handleResize = () => {
        fitAddon.fit();
        onResize(term.cols, term.rows);
      };

      window.addEventListener('resize', handleResize);

      // Use ResizeObserver for container size changes
      const resizeObserver = new ResizeObserver(() => {
        fitAddon.fit();
        onResize(term.cols, term.rows);
      });
      resizeObserver.observe(terminalRef.current);

      return () => {
        window.removeEventListener('resize', handleResize);
        resizeObserver.disconnect();
        term.dispose();
      };
    }, [sessionId, onInput, onResize]);

    // Click handler to ensure focus
    const handleClick = useCallback(() => {
      xtermRef.current?.focus();
    }, []);

    return (
      <div className="terminal-view" onClick={handleClick}>
        <div ref={terminalRef} className="terminal-container" />
      </div>
    );
  }
);

TerminalView.displayName = 'TerminalView';
