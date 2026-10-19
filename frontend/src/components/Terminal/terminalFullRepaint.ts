// The renderer canvas can lag the buffer after a fit or a reveal: output stops
// partway down and older text shows through, while selecting the area (which
// redraws those rows) shows the right content (#145). Repainting every row once
// the fit has landed puts the canvas back in step with the buffer.

export interface RepaintableTerminal {
  rows: number;
  element?: { isConnected: boolean; offsetHeight: number } | null;
  refresh: (start: number, end: number) => void;
}

type FrameRequest = (callback: () => void) => unknown;

// @req REL-BGSTAB-048
export function createFullRepaintScheduler(requestFrame: FrameRequest): (term: RepaintableTerminal) => void {
  const pending = new Set<RepaintableTerminal>();
  return (term) => {
    if (pending.has(term)) return;
    pending.add(term);
    // Two frames: the renderer applies its own resize in the first.
    requestFrame(() => {
      requestFrame(() => {
        pending.delete(term);
        const element = term.element;
        if (!element || !element.isConnected || element.offsetHeight === 0) return;
        try {
          term.refresh(0, term.rows - 1);
        } catch {
          // A terminal disposed in between has nothing left to draw.
        }
      });
    });
  };
}

export const scheduleFullRepaint = createFullRepaintScheduler((callback) => requestAnimationFrame(callback));
