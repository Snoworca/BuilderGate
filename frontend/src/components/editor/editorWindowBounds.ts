// The element an editor window is placed inside.
//
// One definition, read by the two places that need it: `App` hands it to the
// dialog as the box a drag is bounded by, and the window hook measures it to
// centre a newly opened window in it. Two copies would let the window be
// centred in one box and confined to another, and the window would then sit
// against an edge rather than in the middle.
//
// Constant, whatever the placement. It used to be swapped for the viewport
// while a window was floating, and `Rnd` read each swap as an interaction it
// had to settle: it emitted a rect, that rect came back in as a hand-placed
// one, and the window returned to floating the moment 최대화 sent it to stage.
// The window layer already confines a floating window to the stage, so the
// constant boundary is also the boundary that was in effect.
// @req FR-MDE-001

export const EDITOR_WINDOW_BOUNDS_SELECTOR = '.terminal-workspace-stage';
