// The button row a phone gets in place of the keyboard shortcuts (design 6.3).
// Every button comes from buildMobileActionButtons, so which ones are enabled is
// decided by the same predicates as the context menu, never re-judged here.
// @req FR-FEX-005

import { buildMobileActionButtons, type FileExplorerMenuHandlers, type MobileActionId } from './fileExplorerContextMenu.ts';

export interface FileExplorerMobileBarProps {
  selectionCount: number;
  clipboardEmpty: boolean;
  handlers: Pick<FileExplorerMenuHandlers, MobileActionId>;
}

// @req FR-FEX-005
export function FileExplorerMobileBar({ selectionCount, clipboardEmpty, handlers }: FileExplorerMobileBarProps) {
  return (
    <div className="fx-mobile-bar" role="toolbar" aria-label="파일 작업">
      {buildMobileActionButtons({ count: selectionCount, clipboardEmpty }, handlers).map((action) => (
        <button
          key={action.id}
          type="button"
          className="fx-mobile-button"
          disabled={action.disabled}
          onClick={action.onClick}
        >
          {action.label}
        </button>
      ))}
    </div>
  );
}
