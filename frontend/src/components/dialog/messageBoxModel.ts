import type { MessageBoxProps, MessageBoxViewModel } from './types';
import { t } from '../../i18n/i18n.ts';

export function createMessageBoxViewModel(
  props: Pick<MessageBoxProps, 'okLabel' | 'cancelLabel' | 'okVariant' | 'busy'>,
): MessageBoxViewModel {
  return {
    // The defaults are the fallback only. A caller whose OK does something
    // specific passes that action as okLabel (FR-UIDS-003 AC-2).
    okLabel: props.okLabel ?? t('common.confirm'),
    cancelLabel: props.cancelLabel ?? t('common.cancel'),
    okVariant: props.okVariant ?? 'primary',
    isBusy: Boolean(props.busy),
    role: 'alertdialog',
    showCloseButton: false,
    resizable: false,
    persistGeometry: false,
  };
}
