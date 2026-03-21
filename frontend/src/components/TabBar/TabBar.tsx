import { useState, useRef, useCallback } from 'react';
import type { UnifiedTab } from '../../hooks/useTabManager';
import { useDragReorder } from '../../hooks/useDragReorder';
import { ContextMenu } from '../ContextMenu/ContextMenu';
import type { ContextMenuItem } from '../ContextMenu/ContextMenu';
import { AddTabModal } from '../Modal/AddTabModal';
import { TabContextModal } from '../Modal/TabContextModal';
import './TabBar.css';

interface Props {
  tabs: UnifiedTab[];
  activeTabId: string;
  viewerFile: string | null;
  isMobile: boolean;
  onSelectTab: (tabId: string) => void;
  onAddTerminalTab: () => void;
  onAddFilesTab: () => void;
  onCloseTerminalTab: (tabId: string) => void;
  onCloseFilesTab: (tabId: string) => void;
  onSelectViewer: () => void;
  onReorderTabs: (fromIndex: number, toIndex: number) => void;
  onRenameTab: (tabId: string, title: string) => void;
  onCloseOtherTabs: (tabId: string) => void;
  onCloseAllTabs: () => void;
}

export function TabBar({
  tabs,
  activeTabId,
  viewerFile,
  isMobile,
  onSelectTab,
  onAddTerminalTab,
  onAddFilesTab,
  onCloseTerminalTab,
  onCloseFilesTab,
  onSelectViewer,
  onReorderTabs,
  onRenameTab,
  onCloseOtherTabs,
  onCloseAllTabs,
}: Props) {
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [menuPosition, setMenuPosition] = useState({ x: 0, y: 0 });
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [contextMenu, setContextMenu] = useState<{ tabId: string; position: { x: number; y: number } } | null>(null);
  const [mobileContextTabId, setMobileContextTabId] = useState<string | null>(null);
  const addBtnRef = useRef<HTMLButtonElement>(null);

  const isLocked = useCallback((index: number) => index === 0, []);

  const { dragIndex, dropTargetIndex, ghostStyle, getTabHandlers, tabRefs } = useDragReorder({
    onReorder: onReorderTabs,
    isLocked,
  });

  const handleAddClick = () => {
    if (isMobile) {
      setShowAddModal(true);
    } else {
      const btn = addBtnRef.current;
      if (btn) {
        const rect = btn.getBoundingClientRect();
        setMenuPosition({ x: rect.left, y: rect.bottom + 4 });
      }
      setShowAddMenu(true);
    }
  };

  const handleAddSelect = (type: 'terminal' | 'files') => {
    setShowAddMenu(false);
    setShowAddModal(false);
    if (type === 'terminal') {
      onAddTerminalTab();
    } else {
      onAddFilesTab();
    }
  };

  const addMenuItems: ContextMenuItem[] = [
    {
      label: 'Terminal',
      icon: '>_',
      onClick: () => handleAddSelect('terminal'),
    },
    {
      label: 'Files',
      icon: '📁',
      onClick: () => handleAddSelect('files'),
    },
  ];

  const getTabContextMenuItems = useCallback((tabId: string): ContextMenuItem[] => {
    const tab = tabs.find(t => t.id === tabId);
    const isViewer = tabId === 'viewer';
    const isMain = tab?.type === 'terminal' && (tab as any).isMain;
    const closableCount = tabs.filter(t => !(t.type === 'terminal' && (t as any).isMain)).length + (viewerFile ? 1 : 0);

    const items: ContextMenuItem[] = [];

    // Rename — not for viewer tab
    if (!isViewer) {
      items.push({
        label: 'Rename',
        onClick: () => {
          setEditingTabId(tabId);
          setEditValue(tab?.title ?? '');
        },
      });
    }

    // Close — not for main tab
    if (!isMain) {
      items.push({
        label: 'Close',
        onClick: () => {
          if (isViewer) {
            onSelectTab(tabs[0]?.id ?? 'terminal-0');
          } else if (tab?.type === 'terminal') {
            onCloseTerminalTab(tabId);
          } else {
            onCloseFilesTab(tabId);
          }
        },
      });
    }

    // Close Others
    if (closableCount > 1 || (closableCount === 1 && isMain)) {
      items.push({
        label: 'Close Others',
        onClick: () => onCloseOtherTabs(tabId),
      });
    }

    // Close All
    if (closableCount > 0) {
      items.push({
        label: 'Close All',
        onClick: () => onCloseAllTabs(),
      });
    }

    return items;
  }, [tabs, viewerFile, onCloseTerminalTab, onCloseFilesTab, onCloseOtherTabs, onCloseAllTabs, onSelectTab]);

  // The ghost tab: a clone of the dragged tab that follows the pointer
  const draggedTab = dragIndex !== null ? tabs[dragIndex] : null;

  return (
    <div className="tab-bar">
      <div className="tab-bar-scroll">
        {/* Unified tabs in order */}
        {tabs.map((tab, index) => {
          const isBeingDragged = dragIndex === index;

          // Determine if this slot should show the drop indicator (gap)
          const showDropGap = dragIndex !== null
            && dropTargetIndex === index
            && dropTargetIndex !== dragIndex;

          const classNames = [
            'tab-item',
            activeTabId === tab.id ? 'tab-active' : '',
            tab.type === 'terminal' && (tab as any).isMain ? 'tab-main-locked' : '',
            isBeingDragged ? 'tab-dragging' : '',
            showDropGap ? 'tab-drop-gap' : '',
          ].filter(Boolean).join(' ');

          const handlers = getTabHandlers(index);

          return (
            <button
              key={tab.id}
              ref={el => { tabRefs.current[index] = el; }}
              className={classNames}
              onClick={() => {
                if (dragIndex === null) onSelectTab(tab.id);
              }}
              onDoubleClick={(e) => {
                e.preventDefault();
                if (isMobile) {
                  setMobileContextTabId(tab.id);
                } else {
                  setEditingTabId(tab.id);
                  setEditValue(tab.title);
                }
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setContextMenu({ tabId: tab.id, position: { x: e.clientX, y: e.clientY } });
              }}
              {...handlers}
            >
              {editingTabId === tab.id ? (
                <input
                  className="tab-rename-input"
                  value={editValue}
                  onChange={e => setEditValue(e.target.value)}
                  onBlur={() => { onRenameTab(tab.id, editValue.trim() || tab.title); setEditingTabId(null); }}
                  onKeyDown={e => {
                    if (e.key === 'Enter') { onRenameTab(tab.id, editValue.trim() || tab.title); setEditingTabId(null); }
                    if (e.key === 'Escape') setEditingTabId(null);
                  }}
                  autoFocus
                  onClick={e => e.stopPropagation()}
                />
              ) : (
                <span className="tab-label">{tab.title}</span>
              )}
            </button>
          );
        })}

        {/* Add tab button — hidden during drag */}
        {dragIndex === null && (
          <button ref={addBtnRef} className="tab-item tab-add" onClick={handleAddClick}>
            +
          </button>
        )}

        {/* Viewer tab (dynamic, shows filename) — always at right end with gap */}
        {viewerFile && (
          <button
            className={`tab-item tab-viewer${activeTabId === 'viewer' ? ' tab-active' : ''}`}
            onClick={onSelectViewer}
            onContextMenu={(e) => {
              e.preventDefault();
              setContextMenu({ tabId: 'viewer', position: { x: e.clientX, y: e.clientY } });
            }}
            onDoubleClick={(e) => {
              e.preventDefault();
              if (isMobile) {
                setMobileContextTabId('viewer');
              }
              // Desktop: no rename for viewer tab (just ignore double-click)
            }}
          >
            {viewerFile.split(/[/\\]/).pop() || 'Viewer'}
          </button>
        )}
      </div>

      {/* Ghost tab: follows the pointer during drag */}
      {draggedTab && ghostStyle && (
        <div className="tab-ghost" style={ghostStyle}>
          <span className="tab-label">{draggedTab.title}</span>
        </div>
      )}

      {showAddMenu && (
        <ContextMenu
          position={menuPosition}
          onClose={() => setShowAddMenu(false)}
          items={addMenuItems}
        />
      )}

      {showAddModal && (
        <AddTabModal
          onSelect={handleAddSelect}
          onCancel={() => setShowAddModal(false)}
        />
      )}

      {/* Tab context menu (desktop) */}
      {contextMenu && (
        <ContextMenu
          position={contextMenu.position}
          onClose={() => setContextMenu(null)}
          items={getTabContextMenuItems(contextMenu.tabId)}
        />
      )}

      {/* Tab context modal (mobile) */}
      {mobileContextTabId && (
        <TabContextModal
          items={getTabContextMenuItems(mobileContextTabId)}
          onCancel={() => setMobileContextTabId(null)}
        />
      )}
    </div>
  );
}
