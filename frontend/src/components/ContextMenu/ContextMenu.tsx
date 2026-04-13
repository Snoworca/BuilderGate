import { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
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
}

// ---------------------------------------------------------------------------
// Submenu component (rendered recursively)
// ---------------------------------------------------------------------------

interface SubmenuProps {
  items: ContextMenuItem[];
  parentRect: DOMRect;
  onClose: () => void;
}

function Submenu({ items, parentRect, onClose }: SubmenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;

    const rect = menu.getBoundingClientRect();

    // Default: open to the right of the parent
    let left = parentRect.right + 2;
    let top = parentRect.top;

    // Boundary: if overflows right edge, open to the left
    if (left + rect.width > window.innerWidth) {
      left = parentRect.left - rect.width - 2;
    }

    // Boundary: if overflows bottom edge, shift up
    if (top + rect.height > window.innerHeight) {
      top = window.innerHeight - rect.height - 8;
    }

    // Clamp top to 0
    if (top < 0) top = 0;

    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }, [parentRect]);

  return (
    <div ref={menuRef} className="context-menu context-submenu" style={{ left: 0, top: 0 }}>
      <MenuItemList items={items} onClose={onClose} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Single menu item with optional submenu hover logic
// ---------------------------------------------------------------------------

interface MenuItemRowProps {
  item: ContextMenuActionItem;
  onClose: () => void;
}

function MenuItemRow({ item, onClose }: MenuItemRowProps) {
  const [submenuOpen, setSubmenuOpen] = useState(false);
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
      setSubmenuOpen(true);
    }, 300);
  }, [hasChildren]);

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
      setSubmenuOpen(true);
      return;
    }
    if (item.onClick) {
      item.onClick();
    }
    onClose();
  }, [item, hasChildren, onClose]);

  const classNames = [
    'context-menu-item',
    item.disabled ? 'disabled' : '',
    item.destructive ? 'destructive' : '',
    hasChildren ? 'has-children' : '',
  ].filter(Boolean).join(' ');

  const rowRect = rowRef.current?.getBoundingClientRect();

  return (
    <div
      ref={rowRef}
      className={classNames}
      onClick={handleClick}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      role="menuitem"
      aria-disabled={item.disabled}
    >
      {item.icon && <span className="context-menu-icon">{item.icon}</span>}
      <span className="context-menu-label">{item.label}</span>
      {item.shortcut && <span className="context-menu-shortcut">{item.shortcut}</span>}
      {hasChildren && <span className="context-menu-arrow">▶</span>}

      {/* Submenu portal */}
      {hasChildren && submenuOpen && rowRect && (
        <Submenu
          items={item.children!}
          parentRect={rowRect}
          onClose={onClose}
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
}

function MenuItemList({ items, onClose }: MenuItemListProps) {
  return (
    <>
      {items.map((item, index) => {
        if (item.separator) {
          return <div key={index} className="context-menu-separator" />;
        }
        return <MenuItemRow key={index} item={item} onClose={onClose} />;
      })}
    </>
  );
}

// ---------------------------------------------------------------------------
// Main ContextMenu (portal to document.body)
// ---------------------------------------------------------------------------

export function ContextMenu({ position, onClose, items }: Props) {
  const menuRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    // Adjust position to stay within viewport by directly mutating DOM style
    const menu = menuRef.current;
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    let { x, y } = position;
    if (x + rect.width > window.innerWidth) {
      x = window.innerWidth - rect.width - 8;
    }
    if (y + rect.height > window.innerHeight) {
      y = window.innerHeight - rect.height - 8;
    }
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
  }, [position]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      // Don't close if clicking inside any context-menu (including submenus)
      const target = e.target as HTMLElement;
      if (target.closest('.context-menu')) return;
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
  }, [onClose]);

  return createPortal(
    <div
      ref={menuRef}
      className="context-menu"
      style={{ left: position.x, top: position.y }}
      role="menu"
    >
      <MenuItemList items={items} onClose={onClose} />
    </div>,
    document.body
  );
}
