import type { Session } from '../../types';
import { StatusIndicator } from './StatusIndicator';
import './SessionItem.css';

interface Props {
  session: Session;
  isActive: boolean;
  onSelect: () => void;
  onDelete: () => void;
}

export function SessionItem({ session, isActive, onSelect, onDelete }: Props) {
  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirm(`Delete "${session.name}"?`)) {
      onDelete();
    }
  };

  return (
    <div
      className={`session-item ${isActive ? 'active' : ''}`}
      onClick={onSelect}
    >
      <StatusIndicator status={session.status} />
      <span className="session-name">{session.name}</span>
      <button
        className="delete-btn"
        onClick={handleDelete}
        title="Delete session"
      >
        ×
      </button>
    </div>
  );
}
