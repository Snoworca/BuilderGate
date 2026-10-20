// What a terminal does after its tab becomes visible (REL-BGSTAB-049).
//
// The reveal used to fit once, in the next frame, and repaint only if that fit was applied.
// A first frame with no size (the layout still moving as the keyboard closes) or a fit the
// write coordinator refused (hidden-output recovery starting at the same moment) then left a
// freshly attached renderer that never painted: a blank terminal until the user switched tabs
// away and back. The checks below repeat a few times and repaint whenever there is a size. The fit
// is submitted once, at the first check with a size: a refused fit is held by the coordinator and
// applied later. A grid tile fits only at the first check, as before: when that frame has no size
// its grid repair (REL-BGSTAB-047) sets the size, and a late fit here raced its one-row nudge.
// @req REL-BGSTAB-049

export const REVEAL_SETTLE_DELAYS_MS = Object.freeze([0, 120, 400, 1000] as const);

export function decideRevealCheck(input: {
  renderable: boolean;
  fitSubmitted: boolean;
  /** The first check (the next frame after the reveal). */
  first: boolean;
  /** Later checks may fit too (false for a grid tile). */
  lateFit: boolean;
}): { fit: boolean; repaint: boolean } {
  if (!input.renderable) return { fit: false, repaint: false };
  return { fit: !input.fitSubmitted && (input.first || input.lateFit), repaint: true };
}

export interface RevealSettleDeps {
  /** Runs `fn` after `ms`; returns a cancel. */
  schedule: (fn: () => void, ms: number) => () => void;
  isRenderable: () => boolean;
  /** Whether a check after the first may submit the fit (false for a grid tile). */
  lateFit: boolean;
  fit: () => void;
  repaint: () => void;
}

/** Starts the checks; the returned function cancels the ones not yet run. */
export function startRevealSettle(deps: RevealSettleDeps): () => void {
  let fitSubmitted = false;
  const cancels = REVEAL_SETTLE_DELAYS_MS.map((ms, index) => deps.schedule(() => {
    const decision = decideRevealCheck({ renderable: deps.isRenderable(), fitSubmitted, first: index === 0, lateFit: deps.lateFit });
    if (decision.fit) {
      fitSubmitted = true;
      deps.fit();
    }
    if (decision.repaint) deps.repaint();
  }, ms));
  return () => {
    for (const cancel of cancels) cancel();
  };
}
