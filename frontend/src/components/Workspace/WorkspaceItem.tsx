import { useState, useRef, useEffect } from 'react';
import { useDoubleTap } from '../../hooks/useDoubleTap';
import type { Workspace } from '../../types/workspace';
import { useContextMenu } from '../../hooks/useContextMenu';
import { ContextMenu } from '../ContextMenu/ContextMenu';
import type { ContextMenuItem } from '../ContextMenu/ContextMenu';
import { workspaceActivity } from './workspaceActivity.ts';
import { WorkspaceAwaitingInputBadge } from './AwaitingInputBadge.tsx';
import { useTabDropHoverId } from './tabDragStore.ts';
import { workspaceInitial } from './workspaceInitial.ts';
import './Workspace.css';
import { t } from '../../i18n/i18n.ts';

interface Props {
  workspace: Workspace;
  isActive: boolean;
  runningCount: number;
  /** FR-AITUI-024 AC-5: tabs whose agent waits on a choice prompt. */
  awaitingCount: number;
  isLast: boolean;
  onClick: () => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onAddTab: (id: string, anchorPosition?: { x: number; y: number }) => void;
  tabCount: number;
  maxTabs: number;
  dragHandlers?: { onPointerDown: (e: React.PointerEvent) => void };
  isDragTarget?: boolean;
  /** FR-UIDS-016 AC-2: the folded sidebar draws the row as a circle with the name's first letter. */
  collapsed?: boolean;
  /** FR-UIDS-016 AC-6: unfolds the sidebar, since a rename needs the full row. */
  onRequestExpand?: () => void;
}

export function WorkspaceItem({
  workspace, isActive, runningCount, awaitingCount, isLast,
  onClick, onRename, onDelete, onAddTab, tabCount, maxTabs,
  dragHandlers, isDragTarget, collapsed = false, onRequestExpand,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(workspace.name);
  const inputRef = useRef<HTMLInputElement>(null);
  const ctx = useContextMenu();
  const activity = workspaceActivity(runningCount);
  // FR-ARCH-019 AC-1: lit while a tab dragged from the tab bar would drop here.
  const isTabDropTarget = useTabDropHoverId() === workspace.id;

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

  // @req FR-UIDS-016 AC-6
  const startRename = () => {
    onRequestExpand?.();
    setEditName(workspace.name);
    setEditing(true);
  };

  const menuItems: ContextMenuItem[] = [
    { label: t('common.rename'), onClick: startRename },
    ...(!isLast ? [{ label: t('common.delete'), destructive: true, onClick: () => onDelete(workspace.id) }] : []),
    { separator: true },
    { label: t('common.addTerminal'), onClick: () => onAddTab(workspace.id, ctx.position), disabled: tabCount >= maxTabs },
  ];

  // FR-UIDS-013: a double tap opens the menu instead of starting a rename.
  const itemDoubleTap = useDoubleTap(({ clientX, clientY }) => ctx.open(clientX, clientY, workspace.id));

  return (
    <>
      <div
        role="option"
        aria-selected={isActive}
        className={`workspace-item ${isActive ? 'active' : ''} ${isDragTarget ? 'drag-target' : ''} ${isTabDropTarget ? 'tab-drop-target' : ''} ${collapsed ? 'is-collapsed' : ''}`}
        data-workspace-drop-id={workspace.id}
        onClick={onClick}
        onContextMenu={(e) => { e.preventDefault(); ctx.open(e.clientX, e.clientY, workspace.id); }}
        onTouchStart={itemDoubleTap.onTouchStart}
        onTouchEnd={itemDoubleTap.onTouchEnd}
        onDoubleClick={startRename}
        {...dragHandlers}
      >
        {/* FR-UIDS-005 AC-2: green while any of its sessions runs, grey otherwise. */}
        {!collapsed && (
          <span
            className={`workspace-item-dot${activity.running ? ' is-running' : ''}`}
            role="img"
            aria-label={activity.label}
            title={activity.label}
          />
        )}
        {/* FR-UIDS-016 AC-2: folded, a circle with the first letter, the full name as its title and label. */}
        {collapsed ? (
          <span className="workspace-item-initial" role="img" aria-label={workspace.name} title={workspace.name}>
            {workspaceInitial(workspace.name)}
          </span>
        ) : editing ? (
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
        <WorkspaceAwaitingInputBadge count={awaitingCount} />
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
