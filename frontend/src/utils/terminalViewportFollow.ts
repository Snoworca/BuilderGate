// FR-ARCH-009: whether the viewport is pulled to the bottom after an output write.
//
// A large write is followed by a viewport sync, which scrolls to the bottom. Done unconditionally
// it undid every scroll the user made while a program kept redrawing (Claude Code's redraws are
// over the threshold), so it now runs only when the viewport was already at the bottom; a
// scrolled-up viewport stays where the user put it, as xterm itself keeps it for small writes.

/** True when nothing is scrolled up: the viewport shows the bottom of the buffer. */
export function isViewportAtBottom(buffer: { viewportY: number; baseY: number }): boolean {
  return buffer.viewportY >= buffer.baseY;
}
