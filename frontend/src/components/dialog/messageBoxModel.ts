import type { MessageBoxProps, MessageBoxViewModel } from './types';

export function createMessageBoxViewModel(
  props: Pick<MessageBoxProps, 'okLabel' | 'cancelLabel' | 'okVariant' | 'busy'>,
): MessageBoxViewModel {
  return {
    okLabel: props.okLabel ?? 'OK',
    cancelLabel: props.cancelLabel ?? 'Cancel',
    okVariant: props.okVariant ?? 'primary',
    isBusy: Boolean(props.busy),
    role: 'alertdialog',
    showCloseButton: false,
    resizable: false,
    persistGeometry: false,
  };
}
