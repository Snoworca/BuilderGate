import type { MessageBoxProps, MessageBoxViewModel } from './types';

export function createMessageBoxViewModel(
  props: Pick<MessageBoxProps, 'okLabel' | 'cancelLabel' | 'okVariant' | 'busy'>,
): MessageBoxViewModel {
  return {
    // The defaults are the fallback only. A caller whose OK does something
    // specific passes that action as okLabel (FR-UIDS-003 AC-2).
    okLabel: props.okLabel ?? '확인',
    cancelLabel: props.cancelLabel ?? '취소',
    okVariant: props.okVariant ?? 'primary',
    isBusy: Boolean(props.busy),
    role: 'alertdialog',
    showCloseButton: false,
    resizable: false,
    persistGeometry: false,
  };
}
