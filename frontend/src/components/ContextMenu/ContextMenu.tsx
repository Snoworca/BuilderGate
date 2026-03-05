import { useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import './ContextMenu.css';

export interface ContextMenuItem {
  label: string;
  icon?: string;
  onClick: () => void;
  disabled?: boolean;
  destructive?: boolean;
  shortcut?: string;
}

interface Props {
  position: { x: number; y: number };
  onClose: () => void;
  items: ContextMenuItem[];
}

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
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
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
    >
      {items.map((item, index) => (
        <button
          key={index}
          className={`context-menu-item${item.disabled ? ' disabled' : ''}${item.destructive ? ' destructive' : ''}`}
          onClick={() => {
            if (!item.disabled) {
              item.onClick();
              onClose();
            }
          }}
          disabled={item.disabled}
        >
          {item.icon && <span className="context-menu-icon">{item.icon}</span>}
          <span className="context-menu-label">{item.label}</span>
          {item.shortcut && <span className="context-menu-shortcut">{item.shortcut}</span>}
        </button>
      ))}
    </div>,
    document.body
  );
}
