import type { JSX } from 'react';
import { Icon } from '../common/Icon';
import { Button, DialogFooter } from '../ui';
import { WindowDialog } from './WindowDialog';
import { createMessageBoxViewModel } from './messageBoxModel';
import type { MessageBoxProps } from './types';
import './MessageBox.css';

export function MessageBox({
  dialogId,
  title,
  message,
  okLabel,
  cancelLabel,
  okVariant,
  busy,
  error,
  onOk,
  onCancel,
}: MessageBoxProps): JSX.Element {
  const viewModel = createMessageBoxViewModel({
    okLabel,
    cancelLabel,
    okVariant,
    busy,
  });
  const messageId = `${dialogId}-message`;
  const isDanger = viewModel.okVariant === 'danger';

  return (
    <WindowDialog
      dialogId={dialogId}
      title={title}
      mode="modal"
      defaultRect={{ x: 180, y: 120, width: 440, height: 240 }}
      minSize={{ width: 360, height: 200 }}
      onClose={onCancel}
      role={viewModel.role}
      ariaDescribedBy={messageId}
      showCloseButton={viewModel.showCloseButton}
      resizable={viewModel.resizable}
      persistGeometry={viewModel.persistGeometry}
      surfaceClassName="message-box-dialog"
    >
      <div className="message-box-content">
        <div className="message-box-main">
          <span className={`message-box-icon message-box-icon-${viewModel.okVariant}`}>
            <Icon name={isDanger ? 'alert' : 'info'} size={20} />
          </span>
          <p id={messageId} className="message-box-message">
            {message}
          </p>
        </div>
        {error && (
          <div className="message-box-error" role="alert">
            <Icon name="alert" size={14} />
            <span>{error}</span>
          </div>
        )}
      </div>
      <DialogFooter className="message-box-actions">
        <Button
          variant="secondary"
          className="message-box-button message-box-cancel-button"
          onClick={onCancel}
          disabled={viewModel.isBusy}
          autoFocus
        >
          {viewModel.cancelLabel}
        </Button>
        <Button
          variant={isDanger ? 'danger' : 'primary'}
          className={`message-box-button message-box-ok-button message-box-ok-button-${viewModel.okVariant}`}
          onClick={onOk}
          disabled={viewModel.isBusy}
        >
          {viewModel.okLabel}
        </Button>
      </DialogFooter>
    </WindowDialog>
  );
}
