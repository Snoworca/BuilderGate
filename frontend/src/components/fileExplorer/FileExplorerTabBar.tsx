// The explorer's tab strip. Each tab is one root in one session; the label is
// the root's last segment, the full path is its tooltip.
import type { FileExplorerTab } from './fileExplorerTabsState.ts';
import { explorerTabLabels } from './fileExplorerPathBarModel.ts';

export interface FileExplorerTabBarProps {
  tabs: readonly FileExplorerTab[];
  activeTabId: string | null;
  /** The root each tab shows now, which moves as the user navigates. */
  rootOf: (tab: FileExplorerTab) => string;
  /** The terminal tab's name the explorer tab came from; '' when it is gone (#120). */
  sessionNameOf: (tab: FileExplorerTab) => string;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onAdd: () => void;
}

// @req FR-FEX-003
export function FileExplorerTabBar({ tabs, activeTabId, rootOf, sessionNameOf, onSelect, onClose, onAdd }: FileExplorerTabBarProps) {
  const labels = explorerTabLabels(tabs.map((tab) => ({ sessionTabName: sessionNameOf(tab), root: rootOf(tab) })));
  return (
    <div className="fx-tabs" role="tablist">
      {tabs.map((tab, index) => {
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
            <span className="fx-tab-label">{labels[index]}</span>
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
