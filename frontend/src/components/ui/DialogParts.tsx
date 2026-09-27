// Dialog parts (FR-UIDS-002 AC-3): a head of icon tile, title and a line or
// two that says the outcome first, a body, and a foot of note plus actions.
// They sit inside WindowDialog, which keeps dragging, sizing and focus.
import type { ReactNode } from 'react';
import { Icon } from '../common/Icon.tsx';
import { IconButton } from '../common/IconButton.tsx';
import type { IconName } from '../common/iconGlyphs.ts';
import { joinClassNames } from './uiClasses.ts';
import { t } from '../../i18n/i18n.ts';

export interface DialogHeaderProps {
  icon?: IconName;
  tone?: 'accent' | 'ok' | 'warn' | 'danger';
  title: ReactNode;
  titleId?: string;
  description?: ReactNode;
  onClose?: () => void;
  closeLabel?: string;
}

export function DialogHeader({
  icon,
  tone = 'accent',
  title,
  titleId,
  description,
  onClose,
  closeLabel = t('common.close'),
}: DialogHeaderProps) {
  return (
    <div className="ui-dialog-header">
      {icon !== undefined && (
        <div className={`ui-dialog-icon ui-dialog-icon-${tone}`}>
          <Icon name={icon} size={20} />
        </div>
      )}
      <div className="ui-dialog-heading">
        <h2 className="ui-dialog-title" id={titleId}>{title}</h2>
        {description !== undefined && <p className="ui-dialog-description">{description}</p>}
      </div>
      {onClose !== undefined && <IconButton icon="close" label={closeLabel} onClick={onClose} />}
    </div>
  );
}

export function DialogBody({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={joinClassNames('ui-dialog-body', className)}>{children}</div>;
}

export interface DialogFooterProps {
  note?: ReactNode;
  noteTone?: 'muted' | 'warn';
  className?: string;
  children?: ReactNode;
}

export function DialogFooter({ note, noteTone = 'muted', className, children }: DialogFooterProps) {
  return (
    <div className={joinClassNames('ui-dialog-footer', className)}>
      <span className={joinClassNames('ui-dialog-note', noteTone === 'warn' && 'ui-dialog-note-warn')}>{note}</span>
      {children}
    </div>
  );
}
