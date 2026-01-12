import type { Session } from '../../types';
import { SessionList } from './SessionList';
import './Sidebar.css';

interface Props {
  sessions: Session[];
  activeSessionId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
}

export function Sidebar({ sessions, activeSessionId, onSelect, onCreate, onDelete }: Props) {
  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <h2>Sessions</h2>
      </div>
      <SessionList
        sessions={sessions}
        activeSessionId={activeSessionId}
        onSelect={onSelect}
        onDelete={onDelete}
      />
      <div className="sidebar-footer">
        <button className="new-session-btn" onClick={onCreate}>
          + New Session
        </button>
      </div>
    </aside>
  );
}
