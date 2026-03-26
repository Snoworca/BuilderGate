import { useState, useRef, useEffect } from 'react';
import type { Workspace, WorkspaceTabRuntime } from '../../types/workspace';
import { useContextMenu } from '../../hooks/useContextMenu';
import { ContextMenu } from '../ContextMenu/ContextMenu';
import type { ContextMenuItem } from '../ContextMenu/ContextMenu';

interface Props {
  workspace: Workspace;
  isActive: boolean;
  runningCount: number;
  isLast: boolean;
  onClick: () => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onAddTab: (id: string) => void;
  dragHandlers?: { onPointerDown: (e: React.PointerEvent) => void };
  isDragTarget?: boolean;
}

export function WorkspaceItem({
  workspace, isActive, runningCount, isLast,
  onClick, onRename, onDelete, onAddTab,
  dragHandlers, isDragTarget,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(workspace.name);
  const inputRef = useRef<HTMLInputElement>(null);
  const ctx = useContextMenu();

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const handleRenameConfirm = () => {
    const trimmed = editName.trim();
    if (trimmed && trimmed !== workspace.name) {
      onRename(workspace.id, trimmed);
    }
    setEditing(false);
  };

  const menuItems: ContextMenuItem[] = [
    { label: 'Rename', onClick: () => { setEditName(workspace.name); setEditing(true); } },
    ...(!isLast ? [{ label: 'Delete', destructive: true, onClick: () => onDelete(workspace.id) }] : []),
    { separator: true } as ContextMenuItem,
    { label: 'Add Terminal', onClick: () => onAddTab(workspace.id) },
  ];

  return (
    <>
      <div
        role="option"
        aria-selected={isActive}
        className={`workspace-item ${isActive ? 'active' : ''} ${isDragTarget ? 'drag-target' : ''}`}
        onClick={onClick}
        onContextMenu={(e) => { e.preventDefault(); ctx.open(e.clientX, e.clientY, workspace.id); }}
        onDoubleClick={() => { setEditName(workspace.name); setEditing(true); }}
        {...dragHandlers}
        style={{
          padding: '8px 12px',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          backgroundColor: isActive ? '#2a2d3e' : 'transparent',
          borderLeft: isActive ? '3px solid #3b82f6' : '3px solid transparent',
          borderBottom: isDragTarget ? '2px dashed #3b82f6' : 'none',
        }}
      >
        {editing ? (
          <input
            ref={inputRef}
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            onBlur={handleRenameConfirm}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleRenameConfirm();
              if (e.key === 'Escape') setEditing(false);
            }}
            onClick={(e) => e.stopPropagation()}
            maxLength={32}
            style={{
              background: '#1e1e2e',
              color: '#fff',
              border: '1px solid #3b82f6',
              borderRadius: '3px',
              padding: '2px 6px',
              fontSize: '13px',
              width: '100%',
              outline: 'none',
            }}
          />
        ) : (
          <span style={{ fontSize: '13px', color: '#e0e0e0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {workspace.name}
          </span>
        )}
        {runningCount > 0 && (
          <span style={{
            backgroundColor: '#22c55e',
            color: '#fff',
            borderRadius: '10px',
            padding: '1px 6px',
            fontSize: '11px',
            fontWeight: 600,
            minWidth: '18px',
            textAlign: 'center',
            flexShrink: 0,
            marginLeft: '8px',
          }}>
            {runningCount}
          </span>
        )}
      </div>
      {ctx.isOpen && ctx.targetId === workspace.id && (
        <ContextMenu
          position={ctx.position}
          onClose={ctx.close}
          items={menuItems}
        />
      )}
    </>
  );
}
