// What a terminal does after its tab becomes visible (REL-BGSTAB-049).
//
// The reveal used to fit once, in the next frame, and repaint only if that fit was applied.
// A first frame with no size (the layout still moving as the keyboard closes) or a fit the
// write coordinator refused (hidden-output recovery starting at the same moment) then left a
// freshly attached renderer that never painted: a blank terminal until the user switched tabs
// away and back. The checks below repeat a few times and repaint whenever there is a size.
// @req REL-BGSTAB-049

export const REVEAL_SETTLE_DELAYS_MS = Object.freeze([0, 120, 400, 1000] as const);

export function decideRevealCheck(input: { renderable: boolean; fitApplied: boolean }): { fit: boolean; repaint: boolean } {
  if (!input.renderable) return { fit: false, repaint: false };
  return { fit: !input.fitApplied, repaint: true };
}

export interface RevealSettleDeps {
  /** Runs `fn` after `ms`; returns a cancel. */
  schedule: (fn: () => void, ms: number) => () => void;
  isRenderable: () => boolean;
  isFitApplied: () => boolean;
  fit: () => void;
  repaint: () => void;
}

/** Starts the checks; the returned function cancels the ones not yet run. */
export function startRevealSettle(deps: RevealSettleDeps): () => void {
  const cancels = REVEAL_SETTLE_DELAYS_MS.map((ms) => deps.schedule(() => {
    const decision = decideRevealCheck({ renderable: deps.isRenderable(), fitApplied: deps.isFitApplied() });
    if (decision.fit) deps.fit();
    if (decision.repaint) deps.repaint();
  }, ms));
  return () => {
    for (const cancel of cancels) cancel();
  };
}
