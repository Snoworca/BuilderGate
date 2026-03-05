import type { Session } from '../../types';
import { SessionItem } from './SessionItem';
import './SessionList.css';

interface Props {
  sessions: Session[];
  activeSessionId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, newName: string) => Promise<void>;
  onReorder: (id: string, direction: 'up' | 'down') => Promise<void>;
  cwdMap?: Record<string, string>;
  terminalCountsMap?: Record<string, { running: number; idle: number }>;
}

export function SessionList({ sessions, activeSessionId, onSelect, onDelete, onRename, onReorder, cwdMap, terminalCountsMap }: Props) {
  if (sessions.length === 0) {
    return (
      <div className="session-list empty">
        <p>No sessions yet</p>
      </div>
    );
  }

  return (
    <div className="session-list">
      {sessions.map((session, index) => (
        <SessionItem
          key={session.id}
          session={session}
          isActive={session.id === activeSessionId}
          isFirst={index === 0}
          isLast={index === sessions.length - 1}
          cwd={cwdMap?.[session.id]}
          terminalCounts={terminalCountsMap?.[session.id]}
          onSelect={() => onSelect(session.id)}
          onDelete={() => onDelete(session.id)}
          onRename={(newName) => onRename(session.id, newName)}
          onReorder={(direction) => onReorder(session.id, direction)}
        />
      ))}
    </div>
  );
}
