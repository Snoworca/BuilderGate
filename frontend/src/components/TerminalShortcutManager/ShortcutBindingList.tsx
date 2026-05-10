import type { TerminalShortcutBinding } from '../../types';
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
    return <div className="terminal-shortcut-empty">등록된 단축키가 없습니다.</div>;
  }

  return (
    <div className="terminal-shortcut-binding-list">
      {sortedBindings.map(binding => (
        <article
          key={binding.id}
          className={`terminal-shortcut-binding-item${binding.enabled ? '' : ' is-disabled'}`}
        >
          <div className="terminal-shortcut-binding-main">
            <h3>{bindingKeyLabel(binding)}</h3>
            <div className="terminal-shortcut-binding-sub">
              <span>{bindingScopeLabel(binding)}</span>
              <span>{actionLabel(binding.action)}</span>
              {binding.description && <span>{binding.description}</span>}
            </div>
          </div>
          <div className="terminal-shortcut-binding-actions">
            <button
              type="button"
              className="terminal-shortcut-secondary-button"
              onClick={() => onToggle(binding)}
              disabled={busyId === binding.id}
              aria-label={`${bindingKeyLabel(binding)} ${binding.enabled ? '비활성화' : '활성화'}`}
            >
              {binding.enabled ? '끔' : '켬'}
            </button>
            <button
              type="button"
              className="terminal-shortcut-secondary-button"
              onClick={() => onEdit(binding)}
              disabled={busyId === binding.id}
              aria-label={`${bindingKeyLabel(binding)} 수정`}
            >
              수정
            </button>
            <button
              type="button"
              className="terminal-shortcut-secondary-button"
              onClick={() => onTest(binding)}
              disabled={binding.action.type !== 'send'}
              aria-label={`${bindingKeyLabel(binding)} 테스트 전송`}
            >
              테스트
            </button>
            <button
              type="button"
              className="terminal-shortcut-secondary-button"
              onClick={() => onDelete(binding)}
              disabled={busyId === binding.id}
              aria-label={`${bindingKeyLabel(binding)} 삭제`}
            >
              삭제
            </button>
          </div>
        </article>
      ))}
    </div>
  );
}
