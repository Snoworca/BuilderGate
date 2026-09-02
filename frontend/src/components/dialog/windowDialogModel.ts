import type { DialogMode, DialogRole } from './types';

// Editor windows sit in the 3000 band, below every modal surface, and the
// modal band is left where it is: raising it instead would push a dialog above
// .command-preset-toast, which renders as a sibling of WindowDialog with no
// portal and would then be hidden behind the dialog.
// The table is keyed by DialogMode, so a mode added to that union has to be
// given a band here before this compiles. The modal band is uncapped on
// purpose: capping it would move existing dialog values.
// @req CON-MDE-001
const LAYER_BANDS: Record<DialogMode, { base: number; cap: number }> = {
  modal: { base: 5000, cap: Number.POSITIVE_INFINITY },
  modeless: { base: 3000, cap: 3980 },
};
const LAYER_STEP = 20;

/**
 * The title as it is drawn, with the leading `*` that marks unsaved content.
 *
 * The marker is composed here rather than by the caller so that one place turns
 * the `dirty` fact into its representation. A caller that starred its own title
 * string would leave the same fact travelling by two routes, and only one of
 * them would be corrected when the marker changed.
 *
 * It is a standalone function rather than a field of the behavior model because
 * a title belongs to the surface rather than to the behavior flags, and because
 * that model's whole shape is pinned by deep equality in its tests.
 * @req FR-MDE-006
 */
export function windowDialogTitleText(title: string, dirty?: boolean): string {
  return dirty === true ? `*${title}` : title;
}

export interface WindowDialogBehaviorModel {
  role: DialogRole;
  showCloseButton: boolean;
  resizable: boolean;
  persistGeometry: boolean;
  layerZ: number;
  backdropZ: number;
  dialogZ: number;
}

export function createWindowDialogBehaviorModel(input: {
  role?: DialogRole;
  showCloseButton?: boolean;
  resizable?: boolean;
  persistGeometry?: boolean;
  layerIndex: number;
  mode?: DialogMode;
}): WindowDialogBehaviorModel {
  const band = LAYER_BANDS[input.mode ?? 'modal'];
  const layerZ = Math.min(band.base + input.layerIndex * LAYER_STEP, band.cap);

  return {
    role: input.role ?? 'dialog',
    showCloseButton: input.showCloseButton ?? true,
    resizable: input.resizable ?? true,
    persistGeometry: input.persistGeometry ?? true,
    layerZ,
    backdropZ: layerZ,
    dialogZ: layerZ + 1,
  };
}
