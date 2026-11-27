import { useState, useRef, useEffect, useCallback } from 'react';
import { useDoubleTap } from '../../hooks/useDoubleTap';
import { useDragReorder } from '../../hooks/useDragReorder';
import { useContextMenu } from '../../hooks/useContextMenu';
import { useLongPress } from '../../hooks/useLongPress';
import { ContextMenu } from '../ContextMenu/ContextMenu';
import { Icon, IconButton } from '../common';
import { TAB_COLORS } from '../../types/workspace';
import { workspaceTabClassName } from './workspaceTabClass';
import type { WorkspaceTabRuntime } from '../../types/workspace';
import { getRecoveryIconLabel } from '../../types/recoveryOption';
import type { ShellInfo } from '../../types';
import './WorkspaceTabBar.css';
import { t, tn } from '../../i18n/i18n.ts';
import { roomDotLabelInput } from '../Messenger/messengerWindowModel.ts';
import { TabAwaitingInputBadge } from './AwaitingInputBadge.tsx';
import { findWorkspaceDropId, resolveTabBarDropPoint } from './workspaceMoveTargets.ts';
import { tabDragStore } from './tabDragStore.ts';

interface Props {
  tabs: WorkspaceTabRuntime[];
  activeTabId: string | null;
  maxTabs: number;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onRenameTab: (tabId: string, name: string) => void;
  onAddTab: (shell?: string) => void;
  onReorderTabs: (tabIds: string[]) => void;
  availableShells?: ShellInfo[];
  /** FR-MSG-013 AC-3: room names per session key, for the purple dot. */
  sessionRooms?: Record<string, string[]>;
  /** FR-ARCH-019 AC-2: opens the move dialog for a tab, from the tab's own menu. */
  onRequestMoveTab?: (tabId: string) => void;
  /** FR-ARCH-019 AC-1: a tab dragged onto a sidebar workspace moves there. */
  onMoveTabToWorkspace?: (tabId: string, workspaceId: string) => void;
  /** FR-ARCH-019 AC-1: whether a workspace takes the dragged tab (not its own, not full). */
  canDropOnWorkspace?: (workspaceId: string) => boolean;
}

/** How far above and below the tab bar releasing still reorders, so a drag need not be exact. */
const TAB_BAR_REORDER_SLACK_PX = 40;

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
  maxTabs,
  onSelectTab, onCloseTab, onRenameTab, onAddTab,
  onReorderTabs, availableShells, sessionRooms,
  onRequestMoveTab, onMoveTabToWorkspace, canDropOnWorkspace,
}: Props) {
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [shellMenuOpen, setShellMenuOpen] = useState(false);
  const [shellMenuPosition, setShellMenuPosition] = useState({ x: 0, y: 0 });
  const inputRef = useRef<HTMLInputElement>(null);
  const tabBarRef = useRef<HTMLDivElement>(null);
  const ctx = useContextMenu();

  useEffect(() => {
    if (editingTabId) inputRef.current?.focus();
  }, [editingTabId]);

  const sorted = [...tabs].sort((a, b) => a.sortOrder - b.sortOrder);

  const handleReorder = useCallback((fromIndex: number, toIndex: number) => {
    const ids = sorted.map(t => t.id);
    // Tabs closed during the drag can leave fromIndex past the end.
    if (fromIndex < 0 || fromIndex >= ids.length) return;
    const [moved] = ids.splice(fromIndex, 1);
    ids.splice(toIndex, 0, moved);
    onReorderTabs(ids);
  }, [sorted, onReorderTabs]);

  // FR-ARCH-019 AC-1: over a sidebar workspace that takes the tab, releasing moves it there;
  // over the tab bar it reorders; anywhere else it does nothing.
  const externalDrop = onMoveTabToWorkspace ? {
    resolve: (clientX: number, clientY: number) => resolveTabBarDropPoint({
      hoveredWorkspaceId: findWorkspaceDropId(document.elementFromPoint(clientX, clientY)),
      canDrop: workspaceId => canDropOnWorkspace?.(workspaceId) ?? true,
      tabBarRect: tabBarRef.current?.getBoundingClientRect(),
      x: clientX,
      y: clientY,
      slackPx: TAB_BAR_REORDER_SLACK_PX,
    }),
    onStart: (fromIndex: number) => {
      const tab = sorted[fromIndex];
      if (tab) tabDragStore.begin({ tabId: tab.id, sourceWorkspaceId: tab.workspaceId });
    },
    onHover: (workspaceId: string | null) => tabDragStore.hover(workspaceId),
    // The tab picked up, by id: tabs closed during the drag shift the indexes.
    onDrop: (_fromIndex: number, workspaceId: string) => {
      const tabId = tabDragStore.getState().tabId;
      if (tabId !== null) onMoveTabToWorkspace(tabId, workspaceId);
    },
    onEnd: () => tabDragStore.end(),
  } : undefined;

  const drag = useDragReorder({
    onReorder: handleReorder,
    isLocked: () => false,
    longPressMs: 300,
    externalDrop,
  });

  const handleRenameConfirm = (tabId: string) => {
    const trimmed = editName.trim();
    if (trimmed) onRenameTab(tabId, trimmed);
    setEditingTabId(null);
  };

  // FR-BGSTAB-031: only the per-Workspace tab limit applies; there is no total-session cap.
  const isAddDisabled = tabs.length >= maxTabs;
  const addTooltip = isAddDisabled ? tn('workspace.tabBar.tabLimit', maxTabs) : '';

  // FR-UIDS-013: a double tap on a tab opens its menu (the long press is the browser's own,
  // Android only). The second tap raises no dblclick, so it does not start a rename.
  const tabDoubleTap = useDoubleTap(({ clientX, clientY }, target) => {
    const tabId = target instanceof Element ? target.closest<HTMLElement>('[data-tab-id]')?.dataset.tabId : undefined;
    if (tabId !== undefined) ctx.open(clientX, clientY, tabId);
  });
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
      ref={tabBarRef}
      role="tablist"
      className="workspace-tabbar"
    >
      {sorted.map((tab, index) => {
        const color = TAB_COLORS[tab.colorIndex] || TAB_COLORS[0];
        const isActive = tab.id === activeTabId;
        const isEditing = editingTabId === tab.id;
        const recoveryIconLabel = getSafeRecoveryIconLabel(tab.recoveryIcon);
        const roomDot = roomDotLabelInput(sessionRooms, tab.sessionKey);

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
            data-tab-id={tab.id}
            onTouchStart={tabDoubleTap.onTouchStart}
            onTouchEnd={tabDoubleTap.onTouchEnd}
            {...drag.getTabHandlers(index)}
            className={workspaceTabClassName({
              isActive,
              isDragging: drag.dragIndex === index,
              isDropTarget: drag.dropTargetIndex === index,
              status: tab.status,
            })}
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
                title={tab.recoveryCommand ? t('workspace.tabBar.recoveryCommand', { command: tab.recoveryCommand }) : t('workspace.tabBar.recoveryOptions')}
              >
                {recoveryIconLabel}
              </span>
            )}
            {roomDot !== null && (
              <span
                className="workspace-tab-room-dot"
                role="img"
                aria-label={tn('messenger.tabDot', roomDot.count, { rooms: roomDot.rooms })}
                title={tn('messenger.tabDot', roomDot.count, { rooms: roomDot.rooms })}
              />
            )}
            {tab.awaitingInput && <TabAwaitingInputBadge />}
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
              label={t('workspace.tabBar.closeTab')}
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
        aria-label={t('common.addTerminal')}
        title={addTooltip || t('common.addTerminal')}
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
            { label: t('common.rename'), onClick: () => {
              const tab = sorted.find(t => t.id === ctx.targetId);
              if (tab) { setEditName(tab.name); setEditingTabId(tab.id); }
            }},
            // FR-ARCH-019 AC-2: a stopped tab shows no terminal menu, so the tab menu offers the move.
            ...(onRequestMoveTab ? [{ label: t('contextMenu.moveWorkspace'), icon: 'swap' as const, onClick: () => {
              if (ctx.targetId) onRequestMoveTab(ctx.targetId);
            }}] : []),
            { label: t('common.close'), destructive: true, onClick: () => { if (ctx.targetId) onCloseTab(ctx.targetId); }},
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
