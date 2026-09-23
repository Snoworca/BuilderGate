// The explorer's tab strip. Each tab is one root in one session; the label is
// the root's last segment, the full path is its tooltip.
import type { FileExplorerTab } from './fileExplorerTabsState.ts';
import { rootLabel } from './fileExplorerPathBarModel.ts';

export interface FileExplorerTabBarProps {
  tabs: readonly FileExplorerTab[];
  activeTabId: string | null;
  /** The root each tab shows now, which moves as the user navigates. */
  rootOf: (tab: FileExplorerTab) => string;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onAdd: () => void;
}

// @req FR-FEX-003
export function FileExplorerTabBar({ tabs, activeTabId, rootOf, onSelect, onClose, onAdd }: FileExplorerTabBarProps) {
  return (
    <div className="fx-tabs" role="tablist">
      {tabs.map((tab) => {
        const root = rootOf(tab);
        return (
          <div
            key={tab.id}
            className="fx-tab"
            role="tab"
            aria-selected={tab.id === activeTabId}
            title={root}
            onClick={() => onSelect(tab.id)}
          >
            <span className="fx-tab-label">{rootLabel(root)}</span>
            <button
              type="button"
              className="fx-tab-close"
              aria-label="탭 닫기"
              title="탭 닫기"
              onClick={(event) => {
                // Closing must not first select the tab it is closing.
                event.stopPropagation();
                onClose(tab.id);
              }}
            >
              ×
            </button>
          </div>
        );
      })}
      <button type="button" className="fx-tab-add" aria-label="새 탭" title="새 탭" onClick={onAdd}>
        +
      </button>
    </div>
  );
}
