import { useState, useRef, useEffect } from 'react';
import type { Workspace } from '../../types/workspace';
import { useContextMenu } from '../../hooks/useContextMenu';
import { ContextMenu } from '../ContextMenu/ContextMenu';
import type { ContextMenuItem } from '../ContextMenu/ContextMenu';
import { workspaceActivity } from './workspaceActivity.ts';
import './Workspace.css';
import { t } from '../../i18n/i18n.ts';

interface Props {
  workspace: Workspace;
  isActive: boolean;
  runningCount: number;
  isLast: boolean;
  onClick: () => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onAddTab: (id: string, anchorPosition?: { x: number; y: number }) => void;
  tabCount: number;
  maxTabs: number;
  dragHandlers?: { onPointerDown: (e: React.PointerEvent) => void };
  isDragTarget?: boolean;
}

export function WorkspaceItem({
  workspace, isActive, runningCount, isLast,
  onClick, onRename, onDelete, onAddTab, tabCount, maxTabs,
  dragHandlers, isDragTarget,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(workspace.name);
  const inputRef = useRef<HTMLInputElement>(null);
  const ctx = useContextMenu();
  const activity = workspaceActivity(runningCount);

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
    { label: t('common.rename'), onClick: () => { setEditName(workspace.name); setEditing(true); } },
    ...(!isLast ? [{ label: t('common.delete'), destructive: true, onClick: () => onDelete(workspace.id) }] : []),
    { separator: true },
    { label: t('common.addTerminal'), onClick: () => onAddTab(workspace.id, ctx.position), disabled: tabCount >= maxTabs },
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
      >
        {/* FR-UIDS-005 AC-2: green while any of its sessions runs, grey otherwise. */}
        <span
          className={`workspace-item-dot${activity.running ? ' is-running' : ''}`}
          role="img"
          aria-label={activity.label}
          title={activity.label}
        />
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
            onPointerDown={(e) => e.stopPropagation()}
            maxLength={32}
            className="workspace-item-rename"
          />
        ) : (
          <span className="workspace-item-name">
            {workspace.name}
          </span>
        )}
        {runningCount > 0 && (
          <span className="ui-badge workspace-item-running">
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
