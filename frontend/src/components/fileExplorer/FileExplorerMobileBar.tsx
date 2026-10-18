// The bar a phone gets in place of the keyboard shortcuts: four fixed slots — 업로드, 다운로드,
// 붙여넣기, 더보기 (FR-FEX-026 AC-1). Every slot comes from buildMobileBarSlots, so which ones
// are enabled is decided by the context menu's predicates, never re-judged here, and a slot
// that does not apply stays in place, disabled.
// @req FR-FEX-005
// @req FR-FEX-026

import { t } from '../../i18n/i18n.ts';
import { Icon } from '../common';
import { buildMobileBarSlots, type MobileSlotId } from './fileExplorerContextMenu.ts';

export interface FileExplorerMobileBarProps {
  selectionCount: number;
  clipboardEmpty: boolean;
  handlers: Record<MobileSlotId, () => void>;
  /** Whether the 더보기 sheet is open, for aria-expanded. */
  moreOpen: boolean;
}

// @req FR-FEX-026
export function FileExplorerMobileBar({ selectionCount, clipboardEmpty, handlers, moreOpen }: FileExplorerMobileBarProps) {
  // Named for what it holds, not after the job list beside it.
  return (
    <div className="fx-mobile-bar" role="toolbar" aria-label={t('fileExplorer.mobileBar.label')}>
      {buildMobileBarSlots({ count: selectionCount, clipboardEmpty }, handlers).map((slot) => (
        <button
          key={slot.id}
          type="button"
          className="fx-mobile-button"
          disabled={slot.disabled}
          aria-disabled={slot.disabled}
          aria-haspopup={slot.id === 'more' ? 'dialog' : undefined}
          aria-expanded={slot.id === 'more' ? moreOpen : undefined}
          onClick={slot.onClick}
        >
          <Icon name={slot.icon} size={20} />
          <span className="fx-mobile-slot-label">{slot.label}</span>
        </button>
      ))}
    </div>
  );
}
