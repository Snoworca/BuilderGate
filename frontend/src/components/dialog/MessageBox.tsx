import type { JSX } from 'react';
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

  return (
    <WindowDialog
      dialogId={dialogId}
      title={title}
      mode="modal"
      defaultRect={{ x: 180, y: 120, width: 420, height: 220 }}
      minSize={{ width: 360, height: 180 }}
      onClose={onCancel}
      role={viewModel.role}
      ariaDescribedBy={messageId}
      showCloseButton={viewModel.showCloseButton}
      resizable={viewModel.resizable}
      persistGeometry={viewModel.persistGeometry}
      surfaceClassName="message-box-dialog"
    >
      <div className="message-box-content">
        <p id={messageId} className="message-box-message">
          {message}
        </p>
        {error && (
          <div className="message-box-error" role="alert">
            {error}
          </div>
        )}
        <div className="message-box-actions">
          <button
            type="button"
            className="message-box-button message-box-cancel-button"
            onClick={onCancel}
            disabled={viewModel.isBusy}
            autoFocus
          >
            {viewModel.cancelLabel}
          </button>
          <button
            type="button"
            className={`message-box-button message-box-ok-button message-box-ok-button-${viewModel.okVariant}`}
            onClick={onOk}
            disabled={viewModel.isBusy}
          >
            {viewModel.okLabel}
          </button>
        </div>
      </div>
    </WindowDialog>
  );
}
