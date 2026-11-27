// FR-UIDS-017 AC-3: what a grid toolbar layout button turns the layout into.
// Pressing the button of the layout that is on returns to free layout; any other
// button switches to its own layout. Equal split, columns and rows share the mode
// 'equal' and differ only in the preset, so the preset decides which one is on.
// @req FR-UIDS-017 AC-3
import type { EqualLayoutPreset, MosaicLayoutMode } from '../../hooks/mosaicLayoutStorage.ts';
import type { LinearEqualPreset } from '../../utils/mosaic.ts';

export interface GridLayoutState {
  mode: MosaicLayoutMode;
  equalPreset: EqualLayoutPreset;
  focusTarget: string | null;
}

export function resolveToolbarLayoutMode(
  current: GridLayoutState,
  requested: Exclude<MosaicLayoutMode, 'none'>,
  focusTabId: string | null,
): MosaicLayoutMode {
  if (requested === 'focus') {
    return current.mode === 'focus' && current.focusTarget === focusTabId ? 'none' : 'focus';
  }
  const isOn = current.mode === requested && (requested !== 'equal' || current.equalPreset === 'smart');
  return isOn ? 'none' : requested;
}

export function resolveLinearLayoutToggle(
  current: GridLayoutState,
  preset: LinearEqualPreset,
): { mode: MosaicLayoutMode; equalPreset: EqualLayoutPreset } {
  return current.mode === 'equal' && current.equalPreset === preset
    ? { mode: 'none', equalPreset: 'smart' }
    : { mode: 'equal', equalPreset: preset };
}
