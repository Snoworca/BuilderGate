import { useState, useRef, useEffect, useCallback } from 'react';
import { useDragReorder } from '../../hooks/useDragReorder';
import { useContextMenu } from '../../hooks/useContextMenu';
import { ContextMenu } from '../ContextMenu/ContextMenu';
import { TAB_COLORS } from '../../types/workspace';
import type { WorkspaceTabRuntime } from '../../types/workspace';
import type { ContextMenuItem } from '../ContextMenu/ContextMenu';

interface Props {
  tabs: WorkspaceTabRuntime[];
  activeTabId: string | null;
  isMobile: boolean;
  totalSessionCount: number;
  maxTabs: number;
  maxSessions: number;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onRenameTab: (tabId: string, name: string) => void;
  onAddTab: () => void;
  onReorderTabs: (tabIds: string[]) => void;
}

export function WorkspaceTabBar({
  tabs, activeTabId, isMobile,
  totalSessionCount, maxTabs, maxSessions,
  onSelectTab, onCloseTab, onRenameTab, onAddTab,
  onReorderTabs,
}: Props) {
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const ctx = useContextMenu();

  useEffect(() => {
    if (editingTabId) inputRef.current?.focus();
  }, [editingTabId]);

  const sorted = [...tabs].sort((a, b) => a.sortOrder - b.sortOrder);

  const handleReorder = useCallback((fromIndex: number, toIndex: number) => {
    const ids = sorted.map(t => t.id);
    const [moved] = ids.splice(fromIndex, 1);
    ids.splice(toIndex, 0, moved);
    onReorderTabs(ids);
  }, [sorted, onReorderTabs]);

  const drag = useDragReorder({
    onReorder: handleReorder,
    isLocked: () => false,
    longPressMs: 300,
  });

  const handleRenameConfirm = (tabId: string) => {
    const trimmed = editName.trim();
    if (trimmed) onRenameTab(tabId, trimmed);
    setEditingTabId(null);
  };

  const isAddDisabled = tabs.length >= maxTabs || totalSessionCount >= maxSessions;
  const addTooltip = tabs.length >= maxTabs ? `Maximum ${maxTabs} tabs` : totalSessionCount >= maxSessions ? `Maximum ${maxSessions} sessions` : '';

  return (
    <div
      role="tablist"
      style={{
        display: 'flex',
        alignItems: 'center',
        backgroundColor: '#1e1e2e',
        borderBottom: '1px solid #333',
        padding: '0 4px',
        height: '36px',
        gap: '2px',
        overflowX: 'auto',
      }}
    >
      {sorted.map((tab, index) => {
        const color = TAB_COLORS[tab.colorIndex] || TAB_COLORS[0];
        const isActive = tab.id === activeTabId;
        const isEditing = editingTabId === tab.id;

        return (
          <div
            key={tab.id}
            ref={(el) => { drag.tabRefs.current[index] = el; }}
            role="tab"
            aria-selected={isActive}
            aria-controls={`terminal-${tab.sessionId}`}
            onClick={() => onSelectTab(tab.id)}
            onDoubleClick={() => { setEditName(tab.name); setEditingTabId(tab.id); }}
            onContextMenu={(e) => { e.preventDefault(); ctx.open(e.clientX, e.clientY, tab.id); }}
            {...drag.getTabHandlers(index)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              padding: '4px 8px',
              borderTop: `2px solid ${color}`,
              backgroundColor: isActive ? '#2a2d3e' : '#252535',
              borderRadius: '4px 4px 0 0',
              cursor: 'pointer',
              minWidth: '60px',
              maxWidth: '150px',
              opacity: drag.dragIndex === index ? 0.4 : 1,
              outline: drag.dropTargetIndex === index ? `2px dashed ${color}` : 'none',
            }}
          >
            {isEditing ? (
              <input
                ref={inputRef}
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onBlur={() => handleRenameConfirm(tab.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleRenameConfirm(tab.id);
                  if (e.key === 'Escape') setEditingTabId(null);
                }}
                onClick={(e) => e.stopPropagation()}
                maxLength={32}
                style={{
                  background: '#1e1e2e',
                  color: '#fff',
                  border: `1px solid ${color}`,
                  borderRadius: '2px',
                  padding: '1px 4px',
                  fontSize: '12px',
                  width: '80px',
                  outline: 'none',
                }}
              />
            ) : (
              <span style={{
                fontSize: '12px',
                color: isActive ? '#fff' : '#aaa',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}>
                {tab.name}
              </span>
            )}
            <button
              onClick={(e) => { e.stopPropagation(); onCloseTab(tab.id); }}
              style={{
                background: 'none',
                border: 'none',
                color: '#888',
                cursor: 'pointer',
                fontSize: '14px',
                lineHeight: 1,
                padding: '0 2px',
                flexShrink: 0,
              }}
            >
              ×
            </button>
          </div>
        );
      })}

      {/* Add Tab Button */}
      <button
        onClick={onAddTab}
        disabled={isAddDisabled}
        title={addTooltip || 'Add Terminal'}
        style={{
          background: 'none',
          border: '1px solid #555',
          color: isAddDisabled ? '#444' : '#aaa',
          borderRadius: '4px',
          padding: '2px 8px',
          cursor: isAddDisabled ? 'not-allowed' : 'pointer',
          fontSize: '14px',
          flexShrink: 0,
          marginLeft: '4px',
        }}
      >
        +
      </button>

      {/* Drag Ghost */}
      {drag.dragIndex !== null && drag.ghostStyle && (
        <div style={{
          ...drag.ghostStyle,
          opacity: 0.6,
          backgroundColor: '#2a2d3e',
          padding: '4px 8px',
          borderRadius: '4px',
          fontSize: '12px',
          color: '#fff',
          pointerEvents: 'none',
          zIndex: 9999,
          borderTop: `2px solid ${TAB_COLORS[sorted[drag.dragIndex]?.colorIndex ?? 0]}`,
        }}>
          {sorted[drag.dragIndex]?.name}
        </div>
      )}

      {/* Tab Context Menu */}
      {ctx.isOpen && (
        <ContextMenu
          position={ctx.position}
          onClose={ctx.close}
          items={[
            { label: 'Rename', onClick: () => {
              const tab = sorted.find(t => t.id === ctx.targetId);
              if (tab) { setEditName(tab.name); setEditingTabId(tab.id); }
            }},
            { label: 'Close', destructive: true, onClick: () => { if (ctx.targetId) onCloseTab(ctx.targetId); }},
          ]}
        />
      )}
    </div>
  );
}
