import type { DialogRect, DialogSize } from '../dialog/types';
import type { EditorWindowPlacement } from './editorWindowPlacement.ts';

/**
 * How far each cascade step moves the window, and how much it takes off the
 * size to pay for the move. Offsetting without shrinking pushes the window past
 * the edge of the terminal it is docked to, and pulling an out-of-bounds window
 * back sets the offset to zero again, which makes every window coincide.
 *
 * @req FR-MDE-004
 */
const CASCADE_STEP = 28;

/**
 * How many steps the cascade has before it starts over. A fifth window docked
 * on one terminal lands exactly on the first and is reachable only through the
 * tray; stacking five windows over one terminal is judged rare enough to accept
 * that rather than to keep shrinking.
 *
 * @req FR-MDE-004
 */
const CASCADE_STEP_COUNT = 4;

/**
 * A window as the cascade sees it. `minimized` is carried but never consulted:
 * a minimized window still stands over that terminal, so it holds its step, and
 * the field is here so that dropping it from the count is a change this module
 * can be caught making rather than one a caller makes silently.
 *
 * `rect` is what the window currently occupies, or null for one that is docked
 * but has not been placed yet — a restored window whose terminal has not been
 * measured. An unplaced window holds no step.
 *
 * @req FR-MDE-004
 */
export interface CascadeWindow {
  tabId: string;
  placement: EditorWindowPlacement;
  minimized: boolean;
  rect: DialogRect | null;
}

export interface CascadeInput {
  /** The tab whose terminal the entering window is docking to. */
  tabId: string;
  /** That terminal's rect, in the coordinates the window is positioned in. */
  target: DialogRect;
  /** Every window there is; this filters to the ones holding a step. */
  alreadyDocked: readonly CascadeWindow[];
  /** The floor `EditorWindow` asks for. A step below it is not taken. */
  minSize: DialogSize;
}

/**
 * Where a window entering `docked` on `target` is placed.
 *
 * The step is the lowest one that no window already standing over that terminal
 * occupies, and it starts over at zero once all of them are taken. Taking the
 * number of those windows instead would be the same answer while they occupy
 * the steps in order, and the wrong one as soon as one in the middle closes:
 * three windows at steps 0, 1 and 2 leave two behind when the middle one goes,
 * and a count would hand step 2 to the next window, dropping it exactly onto
 * the window that is already there. Reading the steps that are actually taken
 * gives the freed one away instead, which is what AC-7 asks for, while every
 * other criterion is unaffected because their windows occupy steps in order.
 *
 * Nothing is remembered between calls. The step is worked out again on every
 * entry into `docked`, so a window that leaves for `floating` and comes back
 * finds whatever arrangement is there now rather than the step it used to hold.
 *
 * @req FR-MDE-004
 */
export function computeCascadeRect(input: CascadeInput): DialogRect {
  const { target, minSize } = input;
  const occupied = input.alreadyDocked
    .filter(editorWindow => editorWindow.tabId === input.tabId
      && editorWindow.placement === 'docked')
    .map(editorWindow => editorWindow.rect)
    .filter((rect): rect is DialogRect => rect !== null);

  for (let step = 0; step < CASCADE_STEP_COUNT; step += 1) {
    const candidate = offsetBy(target, step);

    if (isBelow(candidate, minSize)) {
      break;
    }

    if (!occupied.some(rect => isSameRect(rect, candidate))) {
      return candidate;
    }
  }

  // Every step is taken, or the next one would leave the window under the size
  // the editor asks for. Either way the window goes back to the target itself.
  // It is not widened to `minSize` when the terminal is smaller than that: a
  // window inflated past its own tile covers the terminal of the tile beside
  // it, and a window that is too small is an inconvenience while a window over
  // someone else's terminal is a defect.
  return offsetBy(target, 0);
}

function offsetBy(target: DialogRect, step: number): DialogRect {
  const shift = CASCADE_STEP * step;

  return {
    x: target.x + shift,
    y: target.y + shift,
    width: target.width - shift,
    height: target.height - shift,
  };
}

// A terminal that is itself under the floor fails this at step 0, which ends
// the search immediately and answers with the target rect — the same place a
// shrunk step that falls under the floor lands. The floor decides which steps
// exist, never how large the answer is.
function isBelow(rect: DialogRect, minSize: DialogSize): boolean {
  return rect.width < minSize.width || rect.height < minSize.height;
}

function isSameRect(left: DialogRect, right: DialogRect): boolean {
  return left.x === right.x
    && left.y === right.y
    && left.width === right.width
    && left.height === right.height;
}
