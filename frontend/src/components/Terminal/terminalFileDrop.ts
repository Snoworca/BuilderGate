// Files dragged from the operating system onto a terminal session go into that
// session's current folder, through the explorer's upload job (FR-FEX-031). Only a
// desktop shows the drop: a touch screen has no such drag, and a narrow window is
// the phone layout. Explorer rows carry no 'Files' type, so they never upload here.
// @req FR-FEX-031

import type { DecideAnswer, DecideDetail } from '../fileExplorer/fileExplorerPorts.ts';
import { hasDraggedFiles } from '../fileExplorer/fileTransferModel.ts';

/** The phone layout starts below this width (useResponsive). */
const DESKTOP_MIN_WIDTH = 768;

export function isDesktopDropSurface(input: { width: number; coarsePointer: boolean }): boolean {
  return input.width >= DESKTOP_MIN_WIDTH && !input.coarsePointer;
}

export function readDesktopDropSurface(): boolean {
  if (typeof window === 'undefined') return false;
  const coarsePointer = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
  return isDesktopDropSurface({ width: window.innerWidth, coarsePointer });
}

export function decideTerminalFileDrag(input: {
  types: ArrayLike<string> | null | undefined;
  desktop: boolean;
}): 'upload' | 'ignore' {
  return input.desktop && hasDraggedFiles(input.types) ? 'upload' : 'ignore';
}

export interface TerminalDropDepth {
  /** Returns whether the overlay shows. */
  enter(): boolean;
  leave(): boolean;
  active(): boolean;
  reset(): void;
}

/** dragenter/dragleave fire for every child the pointer crosses; the overlay follows the count. */
export function createTerminalDropDepth(): TerminalDropDepth {
  let depth = 0;
  return {
    enter() {
      depth += 1;
      return true;
    },
    leave() {
      depth = Math.max(0, depth - 1);
      return depth > 0;
    },
    active() {
      return depth > 0;
    },
    reset() {
      depth = 0;
    },
  };
}

/** AC-4: there is no window here to ask in, so a clash keeps both; nothing is overwritten. */
export function answerTerminalDropConflict(detail: DecideDetail): DecideAnswer {
  return {
    kind: 'decide',
    choice: detail.choices.includes('rename') ? 'rename' : 'skip',
    applyToAll: true,
  };
}

export function terminalDropDirLabel(cwd: string): string {
  const parts = cwd.split(/[\\/]+/).filter((part) => part !== '');
  return parts.length === 0 ? '.' : parts[parts.length - 1];
}
