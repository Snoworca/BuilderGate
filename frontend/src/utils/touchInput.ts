// FR-ARCH-008 AC-4 / FR-MKB-013 AC-5: touch behaviour follows the input device, not the layout.
// An iPad keeps the desktop layout (FR-UIDS-015) but a finger is its primary pointer, so it needs
// the terminal's one-finger scroll and pinch and the mobile key bar as much as a phone does.
// A touch-screen laptop keeps a fine primary pointer and stays a desktop.
// @req FR-ARCH-008
// @req FR-MKB-013
export const TOUCH_INPUT_QUERY = '(pointer: coarse)';

export function usesTouchInput(input: { mobileLayout: boolean; coarsePointer: boolean }): boolean {
  return input.mobileLayout || input.coarsePointer;
}
