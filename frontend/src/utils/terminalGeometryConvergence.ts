// REL-BGSTAB-038 — a visible terminal's cols/rows converge to what its container holds.
//
// A fit can be dropped: the container was still 0×0 in the frame it ran, the
// terminal was not visible yet, or the write coordinator refused it while a
// restore was in flight. Nothing retried it, so after a grid↔tab switch a
// terminal could stay at the grid cell's size until some unrelated layout
// event happened to fire the ResizeObserver again. This check does not wait
// for such an event: while the terminal is visible it compares the size the
// container would fit with the size the terminal has, and asks for a fit when
// they differ.

export type GeometryConvergenceDecision = 'not-renderable' | 'unmeasurable' | 'in-sync' | 'fit';

export interface GeometryConvergenceInput {
  visible: boolean;
  width: number;
  height: number;
  /** FitAddon.proposeDimensions(); undefined until the renderer knows its cell size. */
  proposed: { cols?: number; rows?: number } | null | undefined;
  current: { cols: number; rows: number };
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

export function decideGeometryConvergence(input: GeometryConvergenceInput): GeometryConvergenceDecision {
  if (!input.visible || input.width <= 0 || input.height <= 0) return 'not-renderable';
  const cols = input.proposed?.cols;
  const rows = input.proposed?.rows;
  if (!isPositiveInteger(cols) || !isPositiveInteger(rows)) return 'unmeasurable';
  return cols === input.current.cols && rows === input.current.rows ? 'in-sync' : 'fit';
}

export interface GeometryConvergenceLoopOptions {
  /** How often a visible terminal is checked. */
  intervalMs: number;
  /** Extra checks soon after a layout change, before the next periodic one. */
  kickDelaysMs: readonly number[];
  check: () => void;
  setTimeout?: (run: () => void, ms: number) => unknown;
  setInterval?: (run: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
}

export interface GeometryConvergenceLoop {
  start(): void;
  stop(): void;
  kick(): void;
}

export function createGeometryConvergenceLoop(options: GeometryConvergenceLoopOptions): GeometryConvergenceLoop {
  const setTimer = options.setTimeout ?? ((run, ms) => globalThis.setTimeout(run, ms));
  const setRepeat = options.setInterval ?? ((run, ms) => globalThis.setInterval(run, ms));
  const clearTimer = options.clearTimer ?? ((id) => {
    globalThis.clearTimeout(id as ReturnType<typeof setTimeout>);
    globalThis.clearInterval(id as ReturnType<typeof setInterval>);
  });
  let interval: unknown = null;
  const kicks = new Set<unknown>();

  return {
    start() {
      if (interval !== null) return;
      interval = setRepeat(() => options.check(), options.intervalMs);
    },
    stop() {
      if (interval !== null) clearTimer(interval);
      interval = null;
      for (const id of kicks) clearTimer(id);
      kicks.clear();
    },
    kick() {
      if (interval === null) return;
      for (const delay of options.kickDelaysMs) {
        const id = setTimer(() => {
          kicks.delete(id);
          options.check();
        }, delay);
        kicks.add(id);
      }
    },
  };
}
