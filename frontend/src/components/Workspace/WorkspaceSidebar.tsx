import { useCallback } from 'react';
import { WorkspaceItem } from './WorkspaceItem';
import { useDragReorder } from '../../hooks/useDragReorder';
import type { Workspace, WorkspaceTabRuntime } from '../../types/workspace';

interface Props {
  workspaces: Workspace[];
  tabs: WorkspaceTabRuntime[];
  activeWorkspaceId: string | null;
  maxWorkspaces: number;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onAddTab: (id: string) => void;
  onReorder: (workspaceIds: string[]) => void;
}

export function WorkspaceSidebar({
  workspaces, tabs, activeWorkspaceId, maxWorkspaces,
  onSelect, onCreate, onRename, onDelete, onAddTab, onReorder,
}: Props) {
  const sorted = [...workspaces].sort((a, b) => a.sortOrder - b.sortOrder);

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
  });

  const getRunningCount = (wsId: string) =>
    tabs.filter(t => t.workspaceId === wsId && t.status === 'running').length;

  const isLimitReached = workspaces.length >= maxWorkspaces;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: '#1e1e2e' }}>
      <div style={{
        padding: '12px',
        borderBottom: '1px solid #333',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
      }}>
        <span style={{ fontSize: '14px', fontWeight: 600, color: '#ccc' }}>Workspaces</span>
        <button
          onClick={onCreate}
          disabled={isLimitReached}
          title={isLimitReached ? `Maximum ${maxWorkspaces} workspaces` : 'New Workspace'}
          style={{
            background: 'none',
            border: '1px solid #555',
            color: isLimitReached ? '#555' : '#ccc',
            borderRadius: '4px',
            padding: '2px 8px',
            cursor: isLimitReached ? 'not-allowed' : 'pointer',
            fontSize: '13px',
          }}
        >
          +
        </button>
      </div>

      <div role="listbox" style={{ flex: 1, overflowY: 'auto' }}>
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
              onAddTab={onAddTab}
              dragHandlers={drag.getTabHandlers(index)}
              isDragTarget={drag.dropTargetIndex === index}
            />
          </div>
        ))}
      </div>

      {drag.dragIndex !== null && drag.ghostStyle && (
        <div style={{
          ...drag.ghostStyle,
          opacity: 0.6,
          backgroundColor: '#2a2d3e',
          padding: '8px 12px',
          borderRadius: '4px',
          fontSize: '13px',
          color: '#e0e0e0',
          pointerEvents: 'none',
          zIndex: 9999,
        }}>
          {sorted[drag.dragIndex]?.name}
        </div>
      )}
    </div>
  );
}
