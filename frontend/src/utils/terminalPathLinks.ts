// The xterm side of opening paths from terminal output. Links for Ctrl/Cmd+click
// (FR-ARCH-012) and the paths around a pressed point for the terminal menu
// (FR-ARCH-013). Only the few xterm members used here are typed, so the rules
// run against a stand-in in unit tests.
// @req FR-ARCH-012
// @req FR-ARCH-013

import type { ILink, ILinkProvider, IDisposable } from '@xterm/xterm';
import {
  cellAtPoint,
  findPathsInRows,
  listScreenPaths,
  pickPathNear,
  readRow,
  type LineLike,
  targetOf,
  type TerminalPathRange,
  type TerminalPathTarget,
  type TerminalRowText,
} from './terminalPathDetection.ts';
import { requestTerminalPathOpen } from './terminalPathOpen.ts';

export interface PathTerminal {
  cols: number;
  rows: number;
  buffer: { active: { viewportY: number; length: number; getLine(y: number): LineLike | undefined } };
  element?: { querySelector(selector: string): { getBoundingClientRect(): { left: number; top: number; width: number; height: number } } | null } | null;
  registerLinkProvider(provider: ILinkProvider): IDisposable;
}

export interface TerminalPathsAtPoint {
  /** The path at or nearest the point, or null. */
  near: TerminalPathTarget | null;
  /** Paths on the visible screen, bottom first. */
  screen: TerminalPathTarget[];
}

// A wrapped line longer than this many rows is not followed further; no path is that long.
const MAX_WRAPPED_ROWS = 32;
// Rows read on each side of a line when looking for its links.
const JOIN_CONTEXT_ROWS = 4;

/** Buffer rows [top, bottom], widened to whole logical lines at both ends. */
function readRows(term: PathTerminal, top: number, bottom: number): { first: number; rows: TerminalRowText[] } {
  const buffer = term.buffer.active;
  let first = Math.max(0, top);
  for (let steps = 0; steps < MAX_WRAPPED_ROWS && first > 0 && buffer.getLine(first)?.isWrapped; steps += 1) first -= 1;
  let last = Math.min(buffer.length - 1, bottom);
  for (let steps = 0; steps < MAX_WRAPPED_ROWS && buffer.getLine(last + 1)?.isWrapped; steps += 1) last += 1;
  const rows: TerminalRowText[] = [];
  for (let y = first; y <= last; y += 1) {
    const line = buffer.getLine(y);
    rows.push(line ? readRow(line, term.cols) : { text: '', colOf: [], isWrapped: false });
  }
  return { first, rows };
}

function hasOpenModifier(event: { ctrlKey: boolean; metaKey: boolean }): boolean {
  return event.ctrlKey || event.metaKey;
}

// The object form: Node's EventTarget reads capture only from it on removal.
const KEY_CAPTURE = { capture: true } as const;

function linkFor(range: TerminalPathRange, first: number, sessionId: string): ILink {
  let hovered = false;
  // xterm copies link.decorations when the pointer enters the link, calls hover,
  // and only then replaces link.decorations with an object whose setters redraw
  // the link (xterm 6, src/browser/Linkifier.ts). So the underline is always set
  // through link.decorations as it is now, and the one set on entering waits
  // until xterm has made that swap.
  const show = (on: boolean) => {
    const decorations = link.decorations;
    if (!decorations) return;
    decorations.underline = on;
    decorations.pointerCursor = on;
  };
  // While the pointer is over the link, pressing or releasing the modifier shows
  // or hides the underline without moving the mouse (AC-7). Capture phase, so a
  // key handler that stops the event on the terminal input cannot hide it.
  const onKey = (event: KeyboardEvent) => show(hasOpenModifier(event));
  const listen = (on: boolean) => {
    if (typeof window === 'undefined') return;
    if (on) {
      window.addEventListener('keydown', onKey, KEY_CAPTURE);
      window.addEventListener('keyup', onKey, KEY_CAPTURE);
    } else {
      window.removeEventListener('keydown', onKey, KEY_CAPTURE);
      window.removeEventListener('keyup', onKey, KEY_CAPTURE);
    }
  };
  const link: ILink = {
    text: range.path,
    range: {
      start: { x: range.startCol + 1, y: first + range.startRow + 1 },
      end: { x: range.endCol + 1, y: first + range.endRow + 1 },
    },
    decorations: { underline: false, pointerCursor: false },
    activate: (event) => {
      if (hasOpenModifier(event)) requestTerminalPathOpen(sessionId, targetOf(range));
    },
    hover: (event) => {
      hovered = true;
      listen(true);
      const on = hasOpenModifier(event);
      queueMicrotask(() => {
        if (hovered) show(on);
      });
    },
    leave: () => {
      hovered = false;
      listen(false);
      show(false);
    },
  };
  return link;
}

/** FR-ARCH-012 AC-5~AC-7: Ctrl/Cmd+click links for the paths in each buffer line. */
export function registerTerminalPathLinks(term: PathTerminal, sessionId: string): IDisposable {
  // Test stand-ins for xterm often stub only what they exercise.
  if (typeof term.registerLinkProvider !== 'function') return { dispose: () => undefined };
  return term.registerLinkProvider({
    provideLinks(bufferLineNumber, callback) {
      const y = bufferLineNumber - 1;
      // A few rows around the line, so a path a TUI cut into indented rows
      // without the terminal's wrap mark is still seen whole.
      const { first, rows } = readRows(term, y - JOIN_CONTEXT_ROWS, y + JOIN_CONTEXT_ROWS);
      const touching = findPathsInRows(rows, term.cols)
        .filter((range) => first + range.startRow <= y && y <= first + range.endRow);
      callback(touching.length > 0 ? touching.map((range) => linkFor(range, first, sessionId)) : undefined);
    },
  });
}

/** FR-ARCH-013 AC-1·AC-3: the path near a client point and the paths on the visible screen. */
export function readTerminalPathsAt(term: PathTerminal, clientX: number, clientY: number): TerminalPathsAtPoint {
  const top = term.buffer.active.viewportY;
  const bottom = top + term.rows - 1;
  const { first, rows } = readRows(term, top, bottom);
  const paths = findPathsInRows(rows, term.cols);
  const onScreen = paths.filter((range) => first + range.endRow >= top && first + range.startRow <= bottom);
  const rect = term.element?.querySelector('.xterm-screen')?.getBoundingClientRect();
  const cell = rect ? cellAtPoint(rect, term.cols, term.rows, clientX, clientY) : null;
  const near = cell ? pickPathNear(paths, top + cell.row - first, cell.col) : null;
  return { near: near ? targetOf(near) : null, screen: listScreenPaths(onScreen) };
}
