import type { Session } from '../../types';
import { SessionItem } from './SessionItem';
import './SessionList.css';

interface Props {
  sessions: Session[];
  activeSessionId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}

export function SessionList({ sessions, activeSessionId, onSelect, onDelete }: Props) {
  if (sessions.length === 0) {
    return (
      <div className="session-list empty">
        <p>No sessions yet</p>
      </div>
    );
  }

  return (
    <div className="session-list">
      {sessions.map(session => (
        <SessionItem
          key={session.id}
          session={session}
          isActive={session.id === activeSessionId}
          onSelect={() => onSelect(session.id)}
          onDelete={() => onDelete(session.id)}
        />
      ))}
    </div>
  );
}
