import { useState, useRef } from 'react';
import type { Session, ShellInfo, ShellType } from '../../types';
import { SessionList } from './SessionList';
import { ContextMenu } from '../ContextMenu/ContextMenu';
import type { ContextMenuItem } from '../ContextMenu/ContextMenu';
import { ShellSelectModal } from '../Modal/ShellSelectModal';
import './Sidebar.css';

interface Props {
  sessions: Session[];
  activeSessionId: string | null;
  onSelect: (id: string) => void;
  onCreate: (shell?: ShellType) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, newName: string) => Promise<void>;
  onReorder: (id: string, direction: 'up' | 'down') => Promise<void>;
  cwdMap?: Record<string, string>;
  terminalCountsMap?: Record<string, { running: number; idle: number }>;
  isMobile?: boolean;
  isOpen?: boolean;
  onClose?: () => void;
  availableShells?: ShellInfo[];
}

export function Sidebar({
  sessions,
  activeSessionId,
  onSelect,
  onCreate,
  onDelete,
  onRename,
  onReorder,
  cwdMap,
  terminalCountsMap,
  isMobile,
  isOpen,
  onClose,
  availableShells,
}: Props) {
  const [showShellMenu, setShowShellMenu] = useState(false);
  const [showShellModal, setShowShellModal] = useState(false);
  const [menuPosition, setMenuPosition] = useState({ x: 0, y: 0 });
  const newSessionBtnRef = useRef<HTMLButtonElement>(null);

  const handleNewSessionClick = () => {
    if (!availableShells || availableShells.length <= 1) {
      onCreate(availableShells?.[0]?.id);
      return;
    }

    if (isMobile) {
      setShowShellModal(true);
    } else {
      const btn = newSessionBtnRef.current;
      if (btn) {
        const rect = btn.getBoundingClientRect();
        setMenuPosition({ x: rect.left, y: rect.top - 4 });
      }
      setShowShellMenu(true);
    }
  };

  const handleShellSelect = (shellId: ShellType) => {
    setShowShellMenu(false);
    setShowShellModal(false);
    onCreate(shellId);
  };

  const shellMenuItems: ContextMenuItem[] = (availableShells || []).map((shell) => ({
    label: shell.label,
    icon: shell.icon,
    onClick: () => handleShellSelect(shell.id),
  }));

  const className = [
    'sidebar',
    isMobile ? 'sidebar-mobile' : '',
    isMobile && isOpen ? 'sidebar-open' : '',
  ].filter(Boolean).join(' ');

  return (
    <aside className={className}>
      <div className="sidebar-header">
        <h2>Sessions</h2>
        {isMobile && (
          <button
            className="sidebar-close-btn"
            onClick={onClose}
            aria-label="Close sidebar"
          >
            ✕
          </button>
        )}
      </div>
      <SessionList
        sessions={sessions}
        activeSessionId={activeSessionId}
        onSelect={onSelect}
        onDelete={onDelete}
        onRename={onRename}
        onReorder={onReorder}
        cwdMap={cwdMap}
        terminalCountsMap={terminalCountsMap}
      />
      <div className="sidebar-footer">
        <button
          ref={newSessionBtnRef}
          className="new-session-btn"
          onClick={handleNewSessionClick}
        >
          + New Session
        </button>
      </div>

      {showShellMenu && (
        <ContextMenu
          position={menuPosition}
          onClose={() => setShowShellMenu(false)}
          items={shellMenuItems}
        />
      )}

      {showShellModal && availableShells && (
        <ShellSelectModal
          shells={availableShells}
          onSelect={handleShellSelect}
          onCancel={() => setShowShellModal(false)}
        />
      )}
    </aside>
  );
}
