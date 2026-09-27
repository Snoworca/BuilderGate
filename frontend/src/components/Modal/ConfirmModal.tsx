import { useEffect, useId, useRef } from 'react';
import { Icon } from '../common/Icon';
import { BusyLabel } from '../ui';
import './ConfirmModal.css';
import { t } from '../../i18n/i18n.ts';

interface Props {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  /**
   * FR-UIDS-006: the confirmed action is running. The confirm button shows a
   * spinner and stays focusable (aria-disabled, not disabled, which would drop
   * focus); cancel, Esc and the overlay do nothing. Callers that never pass it
   * get the plain label, with no hidden progress text in the button.
   */
  busy?: boolean;
  busyLabel?: string;
  /** Shown under the message as an alert. */
  error?: { message: string; detail?: string } | null;
  /** For a failure a retry cannot fix: only the cancel button is drawn. */
  hideConfirm?: boolean;
  /** Start on the least destructive action and keep Tab inside the dialog. */
  initialFocus?: 'cancel';
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmModal({
  title,
  message,
  confirmLabel = t('common.confirm'),
  cancelLabel = t('common.cancel'),
  destructive = false,
  busy: busyProp,
  busyLabel = t('modal.confirm.busy'),
  error = null,
  hideConfirm = false,
  initialFocus,
  onConfirm,
  onCancel,
}: Props) {
  const busy = busyProp === true;
  const titleId = useId();
  const messageId = useId();
  const contentRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (!busy) onCancel();
        return;
      }
      if (e.key !== 'Tab' || !initialFocus || !contentRef.current) return;
      const focusable = Array.from(contentRef.current.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const inside = contentRef.current.contains(document.activeElement);
      if (e.shiftKey && (!inside || document.activeElement === first)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (!inside || document.activeElement === last)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [busy, initialFocus, onCancel]);

  useEffect(() => {
    if (initialFocus === 'cancel') cancelRef.current?.focus();
  }, [initialFocus]);

  // The confirm button just went away: keep focus inside the dialog.
  useEffect(() => {
    if (hideConfirm) cancelRef.current?.focus();
  }, [hideConfirm]);

  return (
    <div className="modal-overlay" onClick={() => { if (!busy) onCancel(); }}>
      <div
        ref={contentRef}
        className="modal-content"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="modal-title" id={titleId}>{title}</h2>
        <p className="confirm-message" id={messageId} aria-live="polite">{message}</p>
        {error && (
          <div className="ui-inline-alert" role="alert">
            <span className="ui-inline-alert-icon"><Icon name="alert" /></span>
            <span className="ui-inline-alert-text">
              <span>{error.message}</span>
              {error.detail && <span className="ui-inline-alert-detail">{error.detail}</span>}
            </span>
          </div>
        )}
        <div className="modal-actions">
          <button ref={cancelRef} type="button" className="btn-cancel" disabled={busy} onClick={onCancel}>
            {cancelLabel}
          </button>
          {!hideConfirm && (
            <button
              type="button"
              className={`btn-submit${destructive ? ' btn-destructive' : ''}`}
              aria-disabled={busy || undefined}
              onClick={() => { if (!busy) onConfirm(); }}
            >
              {busyProp === undefined
                ? confirmLabel
                : <BusyLabel busy={busy} label={confirmLabel} busyLabel={busyLabel} spinnerTone="on-fill" />}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
