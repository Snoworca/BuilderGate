import type { TerminalShortcutBinding } from '../../types';
import { Button, Chip } from '../ui';
import { t } from '../../i18n/i18n.ts';
import {
  actionLabel,
  bindingKeyLabel,
  bindingScopeLabel,
  sortBindingsForDisplay,
} from './shortcutBindingViewModel';

interface ShortcutBindingListProps {
  bindings: TerminalShortcutBinding[];
  busyId: string | null;
  onToggle: (binding: TerminalShortcutBinding) => void;
  onEdit: (binding: TerminalShortcutBinding) => void;
  onDelete: (binding: TerminalShortcutBinding) => void;
  onTest: (binding: TerminalShortcutBinding) => void;
}

export function ShortcutBindingList({
  bindings,
  busyId,
  onToggle,
  onEdit,
  onDelete,
  onTest,
}: ShortcutBindingListProps) {
  const sortedBindings = sortBindingsForDisplay(bindings);

  if (sortedBindings.length === 0) {
    return <div className="terminal-shortcut-empty">{t('shortcut.list.empty')}</div>;
  }

  return (
    <div className="terminal-shortcut-binding-list">
      {sortedBindings.map(binding => (
        <article
          key={binding.id}
          className={`terminal-shortcut-binding-item${binding.enabled ? '' : ' is-disabled'}`}
        >
          <div className="terminal-shortcut-binding-main">
            <div className="terminal-shortcut-binding-title">
              <h3>{bindingKeyLabel(binding)}</h3>
              {!binding.enabled && <Chip tone="neutral">{t('shortcut.list.off')}</Chip>}
            </div>
            <div className="terminal-shortcut-binding-sub">
              <span>{bindingScopeLabel(binding)}</span>
              <span>{actionLabel(binding.action)}</span>
              {binding.description && <span>{binding.description}</span>}
            </div>
          </div>
          <div className="terminal-shortcut-binding-actions">
            <Button
              variant="secondary"
              size="md"
              className="terminal-shortcut-secondary-button"
              onClick={() => onToggle(binding)}
              disabled={busyId === binding.id}
              aria-label={binding.enabled ? t('shortcut.list.disableAria', { key: bindingKeyLabel(binding) }) : t('shortcut.list.enableAria', { key: bindingKeyLabel(binding) })}
            >
              {binding.enabled ? t('shortcut.list.turnOff') : t('shortcut.list.turnOn')}
            </Button>
            <Button
              variant="secondary"
              size="md"
              className="terminal-shortcut-secondary-button"
              onClick={() => onEdit(binding)}
              disabled={busyId === binding.id}
              aria-label={t('shortcut.list.editAria', { key: bindingKeyLabel(binding) })}
            >
              {t('shortcut.list.edit')}
            </Button>
            <Button
              variant="secondary"
              size="md"
              className="terminal-shortcut-secondary-button"
              onClick={() => onTest(binding)}
              disabled={binding.action.type !== 'send'}
              aria-label={t('shortcut.list.testSendAria', { key: bindingKeyLabel(binding) })}
            >
              {t('shortcut.list.testSend')}
            </Button>
            <Button
              variant="danger-text"
              size="md"
              className="terminal-shortcut-secondary-button"
              onClick={() => onDelete(binding)}
              disabled={busyId === binding.id}
              aria-label={t('shortcut.list.deleteAria', { key: bindingKeyLabel(binding) })}
            >
              {t('common.delete')}
            </Button>
          </div>
        </article>
      ))}
    </div>
  );
}
