import { useState, useRef, useEffect, useCallback } from 'react';
import { useDragReorder } from '../../hooks/useDragReorder';
import { useContextMenu } from '../../hooks/useContextMenu';
import { useLongPress } from '../../hooks/useLongPress';
import { ContextMenu } from '../ContextMenu/ContextMenu';
import { Icon, IconButton } from '../common';
import { TAB_COLORS } from '../../types/workspace';
import type { WorkspaceTabRuntime } from '../../types/workspace';
import { getRecoveryIconLabel } from '../../types/recoveryOption';
import type { ShellInfo } from '../../types';
import './WorkspaceTabBar.css';

interface Props {
  tabs: WorkspaceTabRuntime[];
  activeTabId: string | null;
  totalSessionCount: number;
  maxTabs: number;
  maxSessions: number;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onRenameTab: (tabId: string, name: string) => void;
  onAddTab: (shell?: string) => void;
  onReorderTabs: (tabIds: string[]) => void;
  availableShells?: ShellInfo[];
}

function getSafeRecoveryIconLabel(recoveryIcon: WorkspaceTabRuntime['recoveryIcon']): string | null {
  if (recoveryIcon?.type === 'builtin') {
    return getRecoveryIconLabel(recoveryIcon);
  }
  if (recoveryIcon?.type === 'text' && typeof recoveryIcon.value === 'string') {
    return getRecoveryIconLabel(recoveryIcon);
  }
  // Unsupported persisted icons are omitted.
  return null;
}

export function WorkspaceTabBar({
  tabs, activeTabId,
  totalSessionCount, maxTabs, maxSessions,
  onSelectTab, onCloseTab, onRenameTab, onAddTab,
  onReorderTabs, availableShells,
}: Props) {
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [shellMenuOpen, setShellMenuOpen] = useState(false);
  const [shellMenuPosition, setShellMenuPosition] = useState({ x: 0, y: 0 });
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
  const addTooltip = tabs.length >= maxTabs
    ? `탭은 최대 ${maxTabs}개까지 열 수 있습니다`
    : totalSessionCount >= maxSessions
      ? `세션은 최대 ${maxSessions}개까지 열 수 있습니다`
      : '';

  const longPress = useLongPress(
    useCallback((e: { clientX: number; clientY: number }) => {
      if (!availableShells || availableShells.length <= 1) return;
      setShellMenuPosition({ x: e.clientX, y: e.clientY });
      setShellMenuOpen(true);
    }, [availableShells]),
    500,
  );

  return (
    <div
      role="tablist"
      className="workspace-tabbar"
    >
      {sorted.map((tab, index) => {
        const color = TAB_COLORS[tab.colorIndex] || TAB_COLORS[0];
        const isActive = tab.id === activeTabId;
        const isEditing = editingTabId === tab.id;
        const recoveryIconLabel = getSafeRecoveryIconLabel(tab.recoveryIcon);

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
            className={[
              'workspace-tab',
              isActive ? 'is-active' : '',
              drag.dragIndex === index ? 'is-dragging' : '',
              drag.dropTargetIndex === index ? 'is-drop-target' : '',
            ].filter(Boolean).join(' ')}
            // The tab's colour is the tab's own data; the stylesheet decides
            // where it shows (the top rule, the drop outline, the rename edge).
            style={{
              '--tab-color': color,
              '--tab-color-dim': `${color}55`,
            } as React.CSSProperties}
          >
            {recoveryIconLabel && (
              <span
                className="workspace-tab-recovery"
                title={tab.recoveryCommand ? `복구 명령: ${tab.recoveryCommand}` : '복구 옵션'}
              >
                {recoveryIconLabel}
              </span>
            )}
            {isEditing ? (
              <input
                ref={inputRef}
                className="workspace-tab-rename"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onBlur={() => handleRenameConfirm(tab.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleRenameConfirm(tab.id);
                  if (e.key === 'Escape') setEditingTabId(null);
                }}
                onClick={(e) => e.stopPropagation()}
                maxLength={32}
              />
            ) : (
              <span className="workspace-tab-name">
                {tab.name}
              </span>
            )}
            <IconButton
              icon="close"
              label="탭 닫기"
              iconSize={14}
              className="workspace-tab-close"
              onClick={(e) => { e.stopPropagation(); onCloseTab(tab.id); }}
            />
          </div>
        );
      })}

      {/* Add Tab Button */}
      <button
        onClick={() => {
          if (isAddDisabled || longPress.wasLongPress()) return;
          onAddTab();
        }}
        onPointerDown={longPress.onPointerDown}
        onPointerUp={longPress.onPointerUp}
        onPointerMove={longPress.onPointerMove}
        disabled={isAddDisabled}
        className="workspace-tabbar-add"
        aria-label="터미널 추가"
        title={addTooltip || '터미널 추가'}
      >
        <Icon name="plus" size={16} />
      </button>

      {/* Drag Ghost */}
      {drag.dragIndex !== null && drag.ghostStyle && (
        <div
          className="workspace-tab-ghost"
          style={{
            ...drag.ghostStyle,
            '--tab-color': TAB_COLORS[sorted[drag.dragIndex]?.colorIndex ?? 0],
          } as React.CSSProperties}
        >
          {sorted[drag.dragIndex]?.name}
        </div>
      )}

      {/* Tab Context Menu */}
      {ctx.isOpen && (
        <ContextMenu
          position={ctx.position}
          onClose={ctx.close}
          items={[
            { label: '이름 바꾸기', onClick: () => {
              const tab = sorted.find(t => t.id === ctx.targetId);
              if (tab) { setEditName(tab.name); setEditingTabId(tab.id); }
            }},
            { label: '닫기', destructive: true, onClick: () => { if (ctx.targetId) onCloseTab(ctx.targetId); }},
          ]}
        />
      )}

      {/* Shell Selection Menu (long-press on + button) */}
      {shellMenuOpen && availableShells && (
        <ContextMenu
          position={shellMenuPosition}
          onClose={() => setShellMenuOpen(false)}
          items={availableShells.map(shell => ({
            label: shell.label,
            icon: shell.icon,
            onClick: () => { onAddTab(shell.id); setShellMenuOpen(false); },
          }))}
        />
      )}
    </div>
  );
}
