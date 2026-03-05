import { useState } from 'react';
import type { Session } from '../../types';
import { TerminalBadges } from './TerminalBadges';
import { ContextMenu } from '../ContextMenu';
import type { ContextMenuItem } from '../ContextMenu';
import { RenameModal } from '../Modal';
import { useContextMenu } from '../../hooks/useContextMenu';
import { getLastSegment } from '../../utils/pathUtils';
import './SessionItem.css';

interface Props {
  session: Session;
  isActive: boolean;
  isFirst: boolean;
  isLast: boolean;
  cwd?: string;
  terminalCounts?: { running: number; idle: number };
  onSelect: () => void;
  onDelete: () => void;
  onRename: (newName: string) => Promise<void>;
  onReorder: (direction: 'up' | 'down') => Promise<void>;
}

export function SessionItem({
  session,
  isActive,
  isFirst,
  isLast,
  cwd,
  terminalCounts,
  onSelect,
  onDelete,
  onRename,
  onReorder,
}: Props) {
  const contextMenu = useContextMenu();
  const [showRenameModal, setShowRenameModal] = useState(false);

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    contextMenu.open(e.clientX, e.clientY, session.id);
  };

  const handleDoubleClick = () => {
    setShowRenameModal(true);
  };

  const handleDelete = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (confirm(`Delete "${session.name}"?`)) {
      onDelete();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'F2') {
      e.preventDefault();
      setShowRenameModal(true);
    } else if (e.key === 'Delete') {
      handleDelete();
    }
  };

  const handleRename = async (newName: string) => {
    await onRename(newName);
    setShowRenameModal(false);
  };

  const menuItems: ContextMenuItem[] = [
    {
      label: 'Rename',
      icon: '✏️',
      shortcut: 'F2',
      onClick: () => setShowRenameModal(true),
    },
    {
      label: 'Move Up',
      icon: '⬆️',
      onClick: () => onReorder('up'),
      disabled: isFirst,
    },
    {
      label: 'Move Down',
      icon: '⬇️',
      onClick: () => onReorder('down'),
      disabled: isLast,
    },
    {
      label: 'Delete',
      icon: '🗑️',
      shortcut: 'Del',
      destructive: true,
      onClick: () => handleDelete(),
    },
  ];

  return (
    <>
      <div
        className={`session-item ${isActive ? 'active' : ''}`}
        onClick={onSelect}
        onContextMenu={handleContextMenu}
        onDoubleClick={handleDoubleClick}
        onKeyDown={handleKeyDown}
        tabIndex={0}
      >
        <TerminalBadges
          running={terminalCounts?.running ?? 0}
          idle={terminalCounts?.idle ?? (session.status === 'idle' ? 1 : 0)}
        />
        <div className="session-info">
          <span className="session-name">{session.name}</span>
          {cwd && (
            <span className="session-cwd" title={cwd}>{getLastSegment(cwd)}</span>
          )}
        </div>
        <button
          className="delete-btn"
          onClick={(e) => handleDelete(e)}
          title="Delete session"
        >
          ×
        </button>
      </div>

      {contextMenu.isOpen && contextMenu.targetId === session.id && (
        <ContextMenu
          position={contextMenu.position}
          onClose={contextMenu.close}
          items={menuItems}
        />
      )}

      {showRenameModal && (
        <RenameModal
          currentName={session.name}
          onSubmit={handleRename}
          onCancel={() => setShowRenameModal(false)}
        />
      )}
    </>
  );
}
