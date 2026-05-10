import type { ReactNode } from 'react';

export type DialogMode = 'modal' | 'modeless';
export type DialogRole = 'dialog' | 'alertdialog';

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

export interface WindowDialogKeyboardCapture {
  active: boolean;
  onKeyDown: (event: KeyboardEvent) => boolean;
}

export interface WindowDialogProps {
  dialogId: string;
  title: string;
  mode: DialogMode;
  defaultRect: DialogRect;
  minSize: DialogSize;
  onClose: () => void;
  children: ReactNode;
  role?: DialogRole;
  ariaDescribedBy?: string;
  showCloseButton?: boolean;
  resizable?: boolean;
  persistGeometry?: boolean;
  surfaceClassName?: string;
  keyboardCapture?: WindowDialogKeyboardCapture;
}

export type MessageBoxOkVariant = 'primary' | 'danger';

export interface MessageBoxProps {
  dialogId: string;
  title: string;
  message: string;
  okLabel?: string;
  cancelLabel?: string;
  okVariant?: MessageBoxOkVariant;
  busy?: boolean;
  error?: string | null;
  onOk: () => void;
  onCancel: () => void;
}

export interface MessageBoxViewModel {
  okLabel: string;
  cancelLabel: string;
  okVariant: MessageBoxOkVariant;
  isBusy: boolean;
  role: 'alertdialog';
  showCloseButton: false;
  resizable: false;
  persistGeometry: false;
}
