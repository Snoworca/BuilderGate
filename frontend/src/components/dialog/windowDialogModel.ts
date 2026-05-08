import type { DialogRole } from './types';

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
}): WindowDialogBehaviorModel {
  const layerZ = 5000 + input.layerIndex * 20;

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
