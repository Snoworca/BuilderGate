import { useEffect } from 'react';
import './TabContextModal.css';

interface TabContextItem {
  label: string;
  icon?: string;
  onClick: () => void;
  destructive?: boolean;
  disabled?: boolean;
}

interface Props {
  items: TabContextItem[];
  onCancel: () => void;
}

export function TabContextModal({ items, onCancel }: Props) {
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [onCancel]);

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">Tab Options</h2>
        <div className="tab-context-list">
          {items.map((item, index) => (
            <button
              key={index}
              className={`tab-context-item${item.destructive ? ' destructive' : ''}`}
              disabled={item.disabled}
              onClick={() => {
                if (!item.disabled) {
                  item.onClick();
                  onCancel();
                }
              }}
            >
              {item.icon && <span className="tab-context-icon">{item.icon}</span>}
              <span className="tab-context-label">{item.label}</span>
            </button>
          ))}
        </div>
        <button className="shell-select-cancel" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
