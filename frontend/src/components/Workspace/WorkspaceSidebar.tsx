import { useCallback, useState } from 'react';
import { WorkspaceItem } from './WorkspaceItem';
import { useDragReorder } from '../../hooks/useDragReorder';
import { ContextMenu } from '../ContextMenu/ContextMenu';
import type { ContextMenuItem } from '../ContextMenu/ContextMenu';
import { Icon } from '../common';
import type { Workspace, WorkspaceTabRuntime } from '../../types/workspace';
import type { ShellInfo } from '../../types';
import './Workspace.css';
import { t } from '../../i18n/i18n.ts';

interface Props {
  workspaces: Workspace[];
  tabs: WorkspaceTabRuntime[];
  activeWorkspaceId: string | null;
  maxTabsPerWorkspace: number;
  availableShells?: ShellInfo[];
  onSelect: (id: string) => void;
  onCreate: () => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onAddTab: (id: string, shell?: string) => void;
  onReorder: (workspaceIds: string[]) => void;
}

export function WorkspaceSidebar({
  workspaces, tabs, activeWorkspaceId, maxTabsPerWorkspace,
  availableShells,
  onSelect, onCreate, onRename, onDelete, onAddTab, onReorder,
}: Props) {
  const sorted = [...workspaces].sort((a, b) => a.sortOrder - b.sortOrder);

  const [shellMenuOpen, setShellMenuOpen] = useState(false);
  const [shellMenuPosition, setShellMenuPosition] = useState({ x: 0, y: 0 });
  const [pendingAddTabWsId, setPendingAddTabWsId] = useState<string | null>(null);

  const handleReorder = useCallback((fromIndex: number, toIndex: number) => {
    const ids = sorted.map(w => w.id);
    const [moved] = ids.splice(fromIndex, 1);
    ids.splice(toIndex, 0, moved);
    onReorder(ids);
  }, [sorted, onReorder]);

  const drag = useDragReorder({
    onReorder: handleReorder,
    isLocked: () => false,
    longPressMs: 300,
    axis: 'y',
  });

  const getRunningCount = (wsId: string) =>
    tabs.filter(t => t.workspaceId === wsId && t.status === 'running').length;

  const handleAddTabWithShell = useCallback((wsId: string, anchorPosition?: { x: number; y: number }) => {
    if (!availableShells || availableShells.length <= 1) {
      onAddTab(wsId, availableShells?.[0]?.id);
      return;
    }
    // Show shell selection context menu at anchor position
    const pos = anchorPosition ?? { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    setShellMenuPosition({ x: pos.x + 16, y: pos.y });
    setPendingAddTabWsId(wsId);
    setShellMenuOpen(true);
  }, [availableShells, onAddTab]);

  const shellMenuItems: ContextMenuItem[] = (availableShells || []).map((shell) => ({
    label: shell.label,
    icon: shell.icon,
    onClick: () => {
      if (pendingAddTabWsId) {
        onAddTab(pendingAddTabWsId, shell.id);
      }
      setShellMenuOpen(false);
      setPendingAddTabWsId(null);
    },
  }));

  return (
    <div className="workspace-sidebar">
      <div className="workspace-sidebar-header">
        <span className="workspace-sidebar-title">Workspaces</span>
        <button
          type="button"
          className="workspace-sidebar-add"
          onClick={onCreate}
          aria-label={t('workspace.sidebar.add')}
          title={t('workspace.sidebar.add')}
        >
          <Icon name="plus" size={16} />
        </button>
      </div>

      <div role="listbox" className="workspace-sidebar-list">
        {sorted.map((ws, index) => (
          <div key={ws.id} ref={(el) => { drag.tabRefs.current[index] = el; }}>
            <WorkspaceItem
              workspace={ws}
              isActive={ws.id === activeWorkspaceId}
              runningCount={getRunningCount(ws.id)}
              isLast={workspaces.length <= 1}
              onClick={() => onSelect(ws.id)}
              onRename={onRename}
              onDelete={onDelete}
              onAddTab={(wsId, anchorPosition) => handleAddTabWithShell(wsId, anchorPosition)}
              tabCount={tabs.filter(t => t.workspaceId === ws.id).length}
              maxTabs={maxTabsPerWorkspace}
              dragHandlers={drag.getTabHandlers(index)}
              isDragTarget={drag.dropTargetIndex === index}
            />
          </div>
        ))}
      </div>

      {drag.dragIndex !== null && drag.ghostStyle && (
        <div className="workspace-item-ghost" style={drag.ghostStyle}>
          {sorted[drag.dragIndex]?.name}
        </div>
      )}

      {shellMenuOpen && shellMenuItems.length > 0 && (
        <ContextMenu
          position={shellMenuPosition}
          onClose={() => { setShellMenuOpen(false); setPendingAddTabWsId(null); }}
          items={shellMenuItems}
        />
      )}
    </div>
  );
}
