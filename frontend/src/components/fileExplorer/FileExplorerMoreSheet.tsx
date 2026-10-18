// The phone's 더보기 sheet (FR-FEX-026 AC-3, AC-4): the actions the four slots leave out, in the
// context menu's order with 삭제 alone at the bottom. Entries that do not apply are disabled,
// with a line saying why where there is one. It closes on the scrim, on the back gesture or
// button, on a downward drag and on Escape, and keeps focus inside while open. It is drawn in
// the window's body like the window modal, never portalled, so it blocks nothing else (DR-12).
// @req FR-FEX-026

import { t } from '../../i18n/i18n.ts';
import { useEffect, useRef } from 'react';
import type { KeyboardEvent, TouchEvent } from 'react';
import { Icon } from '../common';
import type { MoreSheetItem } from './fileExplorerContextMenu.ts';
import { nextFocusIndex } from './fileExplorerModalModel.ts';

export interface FileExplorerMoreSheetProps {
  title: string;
  entries: readonly (MoreSheetItem | 'sep')[];
  onClose: () => void;
}

// A drag this far down the sheet closes it.
const DRAG_CLOSE_PX = 60;

/** @req FR-FEX-026 */
export function FileExplorerMoreSheet({ title, entries, onClose }: FileExplorerMoreSheetProps) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const dragStartRef = useRef<number | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // The back gesture or button closes the sheet instead of leaving the page: an entry is pushed
  // while it is open and popped when it closes any other way.
  useEffect(() => {
    let closedByBack = false;
    window.history.pushState({ fxSheet: true }, '');
    const onPopState = () => {
      closedByBack = true;
      onCloseRef.current();
    };
    window.addEventListener('popstate', onPopState);
    sheetRef.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus();
    return () => {
      window.removeEventListener('popstate', onPopState);
      if (!closedByBack && (window.history.state as { fxSheet?: boolean } | null)?.fxSheet === true) window.history.back();
    };
  }, []);

  const controls = (): HTMLElement[] => [...(sheetRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled)') ?? [])];

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // The window's shortcuts must not act on the list behind the sheet.
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === 'Tab') {
      event.preventDefault();
      const list = controls();
      list[nextFocusIndex(list.length, list.indexOf(document.activeElement as HTMLElement), event.shiftKey)]?.focus();
    }
  };

  const onTouchStart = (event: TouchEvent<HTMLDivElement>) => {
    dragStartRef.current = event.touches[0]?.clientY ?? null;
  };
  const onTouchEnd = (event: TouchEvent<HTMLDivElement>) => {
    const start = dragStartRef.current;
    dragStartRef.current = null;
    const end = event.changedTouches[0]?.clientY;
    if (start !== null && end !== undefined && end - start > DRAG_CLOSE_PX) onClose();
  };

  return (
    <div className="fx-sheet-scrim" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div
        ref={sheetRef}
        className="fx-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onKeyDown={handleKeyDown}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
      >
        <div className="fx-sheet-grip" aria-hidden="true" />
        <div className="fx-sheet-title">{title}</div>
        {entries.map((entry, index) => (entry === 'sep'
          ? <hr key={`sep-${index}`} className="fx-sheet-sep" />
          : (
            <button
              key={entry.id}
              type="button"
              className={`fx-sheet-item${entry.destructive ? ' fx-danger' : ''}`}
              disabled={entry.disabled}
              aria-disabled={entry.disabled}
              onClick={() => {
                onClose();
                entry.onClick();
              }}
            >
              <Icon name={entry.icon} size={18} />
              <span className="fx-sheet-label">
                {entry.label}
                {entry.reason !== null && <span className="fx-sheet-reason">{entry.reason}</span>}
              </span>
            </button>
          )))}
        <button type="button" className="fx-sheet-close" onClick={onClose}>{t('fileTransfer.sheet.close')}</button>
      </div>
    </div>
  );
}
