import { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useResponsive } from '../../hooks/useResponsive';
import {
  createContextMenuChildPage,
  createContextMenuRootPage,
  formatContextMenuPath,
  type ContextMenuNavigationPage,
} from './contextMenuNavigation';
import { placeRootContextMenu, placeSubContextMenu } from './contextMenuGeometry';
import { normalizeContextMenuItems } from './contextMenuModel';
import { useContextMenuHistory } from './useContextMenuHistory';
import './ContextMenu.css';

export interface ContextMenuActionItem {
  label: string;
  icon?: string;
  onClick?: () => void;
  disabled?: boolean;
  destructive?: boolean;
  shortcut?: string;
  children?: ContextMenuItem[];
  separator?: false;
}

export interface ContextMenuSeparatorItem {
  separator: true;
}

export type ContextMenuItem = ContextMenuActionItem | ContextMenuSeparatorItem;

interface Props {
  position: { x: number; y: number };
  onClose: () => void;
  items: ContextMenuItem[];
  restoreFocusElement?: Element | null;
}

function getEnabledMenuItems(menu: HTMLElement): HTMLElement[] {
  return Array.from(menu.children).filter((child): child is HTMLElement => {
    return child instanceof HTMLElement
      && child.classList.contains('context-menu-item')
      && !child.classList.contains('disabled')
      && child.getAttribute('aria-disabled') !== 'true';
  });
}

function focusFirstMenuItem(menu: HTMLElement): void {
  getEnabledMenuItems(menu)[0]?.focus({ preventScroll: true });
}

function focusMenuItemByOffset(current: HTMLElement, offset: number): void {
  const menu = current.closest<HTMLElement>('.context-menu');
  if (!menu) {
    return;
  }
  const items = getEnabledMenuItems(menu);
  if (items.length === 0) {
    return;
  }
  const currentIndex = Math.max(0, items.indexOf(current));
  const nextIndex = (currentIndex + offset + items.length) % items.length;
  items[nextIndex]?.focus({ preventScroll: true });
}

function focusBoundaryMenuItem(current: HTMLElement, boundary: 'first' | 'last'): void {
  const menu = current.closest<HTMLElement>('.context-menu');
  if (!menu) {
    return;
  }
  const items = getEnabledMenuItems(menu);
  const target = boundary === 'first' ? items[0] : items[items.length - 1];
  target?.focus({ preventScroll: true });
}

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  const selector = [
    'button:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    'a[href]',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',');

  return Array.from(container.querySelectorAll<HTMLElement>(selector)).filter(element => {
    return element.offsetWidth > 0 || element.offsetHeight > 0 || element === document.activeElement;
  });
}

let lastFocusedElement: Element | null = null;

if (typeof document !== 'undefined') {
  document.addEventListener('focusin', (event) => {
    if (!(event.target instanceof Element)) {
      return;
    }
    if (event.target.closest('.context-menu') || event.target.closest('.context-menu-dialog')) {
      return;
    }
    lastFocusedElement = event.target;
  }, true);
}

function getPreviousActiveElement(): Element | null {
  if (typeof document === 'undefined') {
    return null;
  }
  const activeElement = document.activeElement;
  if (
    activeElement instanceof Element
    && (activeElement.closest('.context-menu') || activeElement.closest('.context-menu-dialog'))
  ) {
    return lastFocusedElement;
  }
  if (activeElement && activeElement !== document.body && activeElement !== document.documentElement) {
    return activeElement;
  }
  return lastFocusedElement;
}

// ---------------------------------------------------------------------------
// Submenu component (rendered recursively)
// ---------------------------------------------------------------------------

interface SubmenuProps {
  items: ContextMenuItem[];
  parentRect: DOMRect;
  onClose: () => void;
  onNavigateBack: () => void;
  autoFocusFirst?: boolean;
}

function Submenu({ items, parentRect, onClose, onNavigateBack, autoFocusFirst }: SubmenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;

    const rect = menu.getBoundingClientRect();
    const placement = placeSubContextMenu(
      {
        left: parentRect.left,
        top: parentRect.top,
        width: parentRect.width,
        height: parentRect.height,
      },
      { width: rect.width, height: rect.height },
      { width: window.innerWidth, height: window.innerHeight },
    );

    menu.style.left = `${placement.left}px`;
    menu.style.top = `${placement.top}px`;
    menu.style.maxWidth = `${placement.maxWidth}px`;
    menu.style.maxHeight = `${placement.maxHeight}px`;
  }, [parentRect]);

  useEffect(() => {
    if (!autoFocusFirst) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      if (menuRef.current) {
        focusFirstMenuItem(menuRef.current);
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [autoFocusFirst]);

  return (
    <div ref={menuRef} className="context-menu context-submenu" style={{ left: 0, top: 0 }}>
      <MenuItemList items={items} onClose={onClose} onNavigateBack={onNavigateBack} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Single menu item with optional submenu hover logic
// ---------------------------------------------------------------------------

interface MenuItemRowProps {
  item: ContextMenuActionItem;
  onClose: () => void;
  onNavigateBack?: () => void;
}

function MenuItemRow({ item, onClose, onNavigateBack }: MenuItemRowProps) {
  const [submenuOpen, setSubmenuOpen] = useState(false);
  const [submenuAnchorRect, setSubmenuAnchorRect] = useState<DOMRect | null>(null);
  const [submenuAutoFocusFirst, setSubmenuAutoFocusFirst] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasChildren = item.children && item.children.length > 0;

  const clearTimers = useCallback(() => {
    if (openTimerRef.current) {
      clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  // Cleanup timers on unmount
  useEffect(() => {
    return () => clearTimers();
  }, [clearTimers]);

  const openSubmenu = useCallback((options: { focusFirst?: boolean } = {}) => {
    const rect = rowRef.current?.getBoundingClientRect() ?? null;
    if (!rect) {
      return;
    }
    clearTimers();
    setSubmenuAnchorRect(rect);
    setSubmenuAutoFocusFirst(options.focusFirst === true);
    setSubmenuOpen(true);
  }, [clearTimers]);

  const closeSubmenuAndFocusParent = useCallback(() => {
    setSubmenuOpen(false);
    rowRef.current?.focus({ preventScroll: true });
  }, []);

  const handleMouseEnter = useCallback(() => {
    if (!hasChildren) return;
    // Cancel any pending close
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    // Open submenu after 300ms delay
    openTimerRef.current = setTimeout(() => {
      openTimerRef.current = null;
      openSubmenu();
    }, 300);
  }, [hasChildren, openSubmenu]);

  const handleMouseLeave = useCallback(() => {
    if (!hasChildren) return;
    // Cancel any pending open
    if (openTimerRef.current) {
      clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
    // Close submenu after 300ms delay
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null;
      setSubmenuOpen(false);
    }, 300);
  }, [hasChildren]);

  const handleClick = useCallback(() => {
    if (item.disabled) return;
    // Items with children don't fire onClick — they open submenus
    if (hasChildren) {
      openSubmenu({ focusFirst: true });
      return;
    }
    if (item.onClick) {
      item.onClick();
    }
    onClose();
  }, [item, hasChildren, onClose, openSubmenu]);

  const handleKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (['Escape', 'ArrowDown', 'ArrowUp', 'Home', 'End', 'ArrowLeft', 'ArrowRight', 'Enter', ' '].includes(event.key)) {
      event.stopPropagation();
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusMenuItemByOffset(event.currentTarget, 1);
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusMenuItemByOffset(event.currentTarget, -1);
      return;
    }

    if (event.key === 'Home') {
      event.preventDefault();
      focusBoundaryMenuItem(event.currentTarget, 'first');
      return;
    }

    if (event.key === 'End') {
      event.preventDefault();
      focusBoundaryMenuItem(event.currentTarget, 'last');
      return;
    }

    if (event.key === 'ArrowLeft' && onNavigateBack) {
      event.preventDefault();
      onNavigateBack();
      return;
    }

    if (item.disabled) return;
    if (hasChildren && (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowRight')) {
      event.preventDefault();
      openSubmenu({ focusFirst: true });
      return;
    }
    if (!hasChildren && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      item.onClick?.();
      onClose();
    }
  }, [hasChildren, item, onClose, onNavigateBack, openSubmenu]);

  const classNames = [
    'context-menu-item',
    item.disabled ? 'disabled' : '',
    item.destructive ? 'destructive' : '',
    hasChildren ? 'has-children' : '',
  ].filter(Boolean).join(' ');

  return (
    <div
      ref={rowRef}
      className={classNames}
      onClick={handleClick}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onKeyDown={handleKeyDown}
      role="menuitem"
      aria-disabled={item.disabled}
      aria-haspopup={hasChildren ? 'menu' : undefined}
      aria-expanded={hasChildren ? submenuOpen : undefined}
      tabIndex={item.disabled ? -1 : 0}
    >
      {item.icon && <span className="context-menu-icon">{item.icon}</span>}
      <span className="context-menu-label">{item.label}</span>
      {item.shortcut && <span className="context-menu-shortcut">{item.shortcut}</span>}
      {hasChildren && <span className="context-menu-arrow">▶</span>}

      {/* Submenu portal */}
      {hasChildren && submenuOpen && submenuAnchorRect && (
        <Submenu
          items={item.children!}
          parentRect={submenuAnchorRect}
          onClose={onClose}
          onNavigateBack={closeSubmenuAndFocusParent}
          autoFocusFirst={submenuAutoFocusFirst}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Menu item list (handles separators)
// ---------------------------------------------------------------------------

interface MenuItemListProps {
  items: ContextMenuItem[];
  onClose: () => void;
  onNavigateBack?: () => void;
}

function MenuItemList({ items, onClose, onNavigateBack }: MenuItemListProps) {
  return (
    <>
      {items.map((item, index) => {
        if (item.separator) {
          return <div key={index} className="context-menu-separator" role="separator" />;
        }
        return <MenuItemRow key={index} item={item} onClose={onClose} onNavigateBack={onNavigateBack} />;
      })}
    </>
  );
}

// ---------------------------------------------------------------------------
// Main ContextMenu (portal to document.body)
// ---------------------------------------------------------------------------

export function ContextMenu({ position, onClose, items, restoreFocusElement }: Props) {
  const menuRef = useRef<HTMLDivElement>(null);
  const { isMobile } = useResponsive();
  const normalizedItems = useMemo(() => {
    return normalizeContextMenuItems(items, {
      onDepthExceeded: (diagnostic) => {
        console.debug('[ContextMenu] Stripped unsupported child menu depth', diagnostic);
      },
    });
  }, [items]);

  useLayoutEffect(() => {
    // Adjust position to stay within viewport by directly mutating DOM style
    const menu = menuRef.current;
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    const placement = placeRootContextMenu(
      position,
      { width: rect.width, height: rect.height },
      { width: window.innerWidth, height: window.innerHeight },
    );
    menu.style.left = `${placement.left}px`;
    menu.style.top = `${placement.top}px`;
    menu.style.maxWidth = `${placement.maxWidth}px`;
    menu.style.maxHeight = `${placement.maxHeight}px`;
  }, [position]);

  useEffect(() => {
    if (isMobile) {
      return;
    }

    const handleClickOutside = (e: MouseEvent) => {
      // Don't close if clicking inside any context-menu (including submenus)
      const target = e.target as HTMLElement;
      if (target.closest('.context-menu') || target.closest('.context-menu-dialog')) return;
      onClose();
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isMobile, onClose]);

  useEffect(() => {
    if (isMobile) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      if (menuRef.current) {
        focusFirstMenuItem(menuRef.current);
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [isMobile, normalizedItems]);

  if (normalizedItems.length === 0) {
    return null;
  }

  if (isMobile) {
    return <MobileContextMenuDialog items={normalizedItems} onClose={onClose} restoreFocusElement={restoreFocusElement} />;
  }

  return createPortal(
    <div
      ref={menuRef}
      className="context-menu"
      style={{ left: position.x, top: position.y }}
      role="menu"
    >
      <MenuItemList items={normalizedItems} onClose={onClose} />
    </div>,
    document.body
  );
}

function MobileContextMenuDialog({
  items,
  onClose,
  restoreFocusElement,
}: {
  items: ContextMenuItem[];
  onClose: () => void;
  restoreFocusElement?: Element | null;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousActiveElementRef = useRef<Element | null>(restoreFocusElement ?? getPreviousActiveElement());
  const skipNextFocusRestoreRef = useRef(false);
  const [pageStack, setPageStack] = useState<ContextMenuNavigationPage[]>(() => [
    createContextMenuRootPage(items),
  ]);

  const restorePreviousFocus = useCallback(() => {
    if (skipNextFocusRestoreRef.current) {
      skipNextFocusRestoreRef.current = false;
      return;
    }
    const previous = previousActiveElementRef.current;
    if (previous instanceof HTMLElement && document.contains(previous)) {
      previous.focus({ preventScroll: true });
    }
  }, []);

  const closeAndRestoreFocus = useCallback(() => {
    onClose();
    window.setTimeout(() => {
      restorePreviousFocus();
    }, 50);
  }, [onClose, restorePreviousFocus]);

  const canGoBack = useCallback(() => pageStack.length > 1, [pageStack.length]);
  const goBack = useCallback(() => {
    setPageStack(current => current.length > 1 ? current.slice(0, -1) : current);
  }, []);
  const { backWithHistory, closeWithHistory, pushChildPage } = useContextMenuHistory({
    enabled: true,
    canGoBack,
    onBack: goBack,
    onClose: closeAndRestoreFocus,
  });
  const currentPage = pageStack[pageStack.length - 1];

  useEffect(() => {
    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeWithHistory();
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [closeWithHistory]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const dialog = dialogRef.current;
      if (!dialog) {
        return;
      }
      const firstItem = dialog.querySelector<HTMLElement>('.context-menu-dialog-item:not(:disabled)');
      (firstItem ?? dialog).focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [currentPage]);

  const handleDialogKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') {
      return;
    }

    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }
    const focusableElements = getFocusableElements(dialog);
    if (focusableElements.length === 0) {
      event.preventDefault();
      dialog.focus({ preventScroll: true });
      return;
    }

    const first = focusableElements[0];
    const last = focusableElements[focusableElements.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus({ preventScroll: true });
      return;
    }
    if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus({ preventScroll: true });
    }
  }, []);

  const openChildPage = useCallback((item: ContextMenuActionItem) => {
    const childPage = createContextMenuChildPage(currentPage, item);
    if (!childPage) {
      return;
    }
    setPageStack(current => [...current, childPage]);
    pushChildPage();
  }, [currentPage, pushChildPage]);

  const handleAction = useCallback((item: ContextMenuActionItem) => {
    if (item.disabled) {
      return;
    }
    if (item.children && item.children.length > 0) {
      openChildPage(item);
      return;
    }
    skipNextFocusRestoreRef.current = true;
    item.onClick?.();
    closeWithHistory();
  }, [closeWithHistory, openChildPage]);

  return createPortal(
    <div
      className="context-menu-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          closeWithHistory();
        }
      }}
    >
      <div
        ref={dialogRef}
        className="context-menu-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={formatContextMenuPath(currentPage.path)}
        tabIndex={-1}
        onKeyDown={handleDialogKeyDown}
      >
        <div className="context-menu-dialog-header">
          <button
            type="button"
            className="context-menu-dialog-back"
            onClick={backWithHistory}
            disabled={pageStack.length <= 1}
          >
            뒤로가기
          </button>
          <div className="context-menu-dialog-title">
            {formatContextMenuPath(currentPage.path)}
          </div>
          <button
            type="button"
            className="context-menu-dialog-close"
            onClick={closeWithHistory}
            aria-label="닫기"
          >
            ×
          </button>
        </div>
        <div className="context-menu-dialog-list">
          {currentPage.items.map((item, index) => {
            if (item.separator) {
              return <div key={index} className="context-menu-separator" role="separator" />;
            }

            const hasChildren = item.children && item.children.length > 0;
            return (
              <button
                key={index}
                type="button"
                className={[
                  'context-menu-dialog-item',
                  item.disabled ? 'disabled' : '',
                  item.destructive ? 'destructive' : '',
                  hasChildren ? 'has-children' : '',
                ].filter(Boolean).join(' ')}
                onClick={() => handleAction(item)}
                disabled={item.disabled}
                aria-haspopup={hasChildren ? 'menu' : undefined}
              >
                {item.icon && <span className="context-menu-icon">{item.icon}</span>}
                <span className="context-menu-label">{item.label}</span>
                {item.shortcut && <span className="context-menu-shortcut">{item.shortcut}</span>}
                {hasChildren && <span className="context-menu-arrow">▶</span>}
              </button>
            );
          })}
        </div>
      </div>
    </div>,
    document.body,
  );
}
