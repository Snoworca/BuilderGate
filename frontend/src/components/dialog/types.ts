import type { ReactNode } from 'react';

export type DialogMode = 'modal' | 'modeless';

export interface DialogRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DialogSize {
  width: number;
  height: number;
}

export interface WindowDialogProps {
  dialogId: string;
  title: string;
  mode: DialogMode;
  defaultRect: DialogRect;
  minSize: DialogSize;
  onClose: () => void;
  children: ReactNode;
}
