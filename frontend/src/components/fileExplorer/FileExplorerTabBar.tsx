// The explorer's tab strip. Each tab is one root in one session; the label is
// the root's last segment, the full path is its tooltip.
import { t } from '../../i18n/i18n.ts';
import { useEffect, useRef } from 'react';
import type { DragEvent, MouseEvent, ReactNode } from 'react';
import { hasDraggedFiles, springDelay } from './fileTransferModel.ts';
import { isInternalDrag } from './fileExplorerDragModel.ts';
import { IconButton } from '../common';
import type { FileExplorerTab } from './fileExplorerTabsState.ts';
import { useLongPress } from '../../hooks/useLongPress.ts';
import { explorerTabLabels } from './fileExplorerPathBarModel.ts';

export interface FileExplorerTabBarProps {
  tabs: readonly FileExplorerTab[];
  activeTabId: string | null;
  /** The root each tab shows now, which moves as the user navigates. */
  rootOf: (tab: FileExplorerTab) => string;
  /** The terminal tab's name the explorer tab came from; '' when it is gone (issue 120). */
  sessionNameOf: (tab: FileExplorerTab) => string;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onAdd: () => void;
  /** Right click or a long press on a tab: the tab menu (FR-FEX-012). */
  onContextMenu?: (tabId: string, point: { x: number; y: number }) => void;
}

// @req FR-FEX-003
export function FileExplorerTabBar({ tabs, activeTabId, rootOf, sessionNameOf, onSelect, onClose, onAdd, onContextMenu }: FileExplorerTabBarProps) {
  const labels = explorerTabLabels(tabs.map((tab) => ({ sessionTabName: sessionNameOf(tab), root: rootOf(tab) })));
  return (
    <div className="fx-tabs" role="tablist">
      {tabs.map((tab, index) => {
        const root = rootOf(tab);
        return (
          <ExplorerTabFrame
            key={tab.id}
            tabId={tab.id}
            selected={tab.id === activeTabId}
            title={root}
            onSelect={onSelect}
            onContextMenu={onContextMenu}
          >
            <span className="fx-tab-label">{labels[index]}</span>
            <IconButton
              icon="close"
              className="fx-tab-close"
              label={t('fileExplorer.tabs.close')}
              onClick={(event) => {
                // Closing must not first select the tab it is closing.
                event.stopPropagation();
                onClose(tab.id);
              }}
            />
          </ExplorerTabFrame>
        );
      })}
      <IconButton icon="plus" className="fx-tab-add" label={t('fileExplorer.tabs.add')} onClick={onAdd} />
    </div>
  );
}

/**
 * One tab's frame, with its own long-press timer: a phone raises no
 * contextmenu for a held finger, so holding the tab opens the same menu.
 * @req FR-FEX-012
 */
function ExplorerTabFrame({
  tabId,
  selected,
  title,
  onSelect,
  onContextMenu,
  children,
}: {
  tabId: string;
  selected: boolean;
  title: string;
  onSelect: (tabId: string) => void;
  onContextMenu?: (tabId: string, point: { x: number; y: number }) => void;
  children: ReactNode;
}) {
  const longPress = useLongPress((point) => onContextMenu?.(tabId, { x: point.clientX, y: point.clientY }));
  // FR-FEX-022 AC-5: a file held over an inactive tab for a moment switches to it, so a drop
  // can reach a folder another tab shows.
  const springRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearSpring = () => {
    if (springRef.current !== null) clearTimeout(springRef.current);
    springRef.current = null;
  };
  useEffect(() => clearSpring, []);
  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    // FR-FEX-030 AC-4: an explorer drag switches tabs the same way.
    const types = event.dataTransfer.types;
    if (!(hasDraggedFiles(types) || isInternalDrag(types)) || springRef.current !== null) return;
    const delay = springDelay({ kind: 'tab', active: selected });
    if (delay === null) return;
    springRef.current = setTimeout(() => {
      springRef.current = null;
      onSelect(tabId);
    }, delay);
  };
  const openMenu = (event: MouseEvent<HTMLDivElement>) => {
    if (onContextMenu === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    onContextMenu(tabId, { x: event.clientX, y: event.clientY });
  };
  return (
    <div
      className="fx-tab"
      role="tab"
      aria-selected={selected}
      title={title}
      onClick={() => { if (!longPress.wasLongPress()) onSelect(tabId); }}
      onContextMenu={openMenu}
      onTouchStart={longPress.onTouchStart}
      onTouchMove={longPress.onTouchMove}
      onTouchEnd={longPress.onTouchEnd}
      onDragOver={onDragOver}
      onDragLeave={clearSpring}
      onDrop={clearSpring}
    >
      {children}
    </div>
  );
}
