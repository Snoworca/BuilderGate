import type { TerminalShortcutBinding } from '../../types';
import { Button, Chip } from '../ui';
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
    return <div className="terminal-shortcut-empty">등록된 단축키가 없습니다. 캡처 탭에서 키를 감지해 등록하세요.</div>;
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
              {!binding.enabled && <Chip tone="neutral">꺼짐</Chip>}
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
              aria-label={`${bindingKeyLabel(binding)} ${binding.enabled ? '비활성화' : '활성화'}`}
            >
              {binding.enabled ? '끄기' : '켜기'}
            </Button>
            <Button
              variant="secondary"
              size="md"
              className="terminal-shortcut-secondary-button"
              onClick={() => onEdit(binding)}
              disabled={busyId === binding.id}
              aria-label={`${bindingKeyLabel(binding)} 수정`}
            >
              수정
            </Button>
            <Button
              variant="secondary"
              size="md"
              className="terminal-shortcut-secondary-button"
              onClick={() => onTest(binding)}
              disabled={binding.action.type !== 'send'}
              aria-label={`${bindingKeyLabel(binding)} 테스트 전송`}
            >
              테스트 전송
            </Button>
            <Button
              variant="danger-text"
              size="md"
              className="terminal-shortcut-secondary-button"
              onClick={() => onDelete(binding)}
              disabled={busyId === binding.id}
              aria-label={`${bindingKeyLabel(binding)} 삭제`}
            >
              삭제
            </Button>
          </div>
        </article>
      ))}
    </div>
  );
}
