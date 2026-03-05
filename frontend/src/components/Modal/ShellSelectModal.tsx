import { useEffect } from 'react';
import type { ShellInfo, ShellType } from '../../types';
import './ShellSelectModal.css';

interface Props {
  shells: ShellInfo[];
  onSelect: (id: ShellType) => void;
  onCancel: () => void;
}

export function ShellSelectModal({ shells, onSelect, onCancel }: Props) {
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
        <h2 className="modal-title">Select Shell</h2>
        <div className="shell-select-list">
          {shells.map((shell) => (
            <button
              key={shell.id}
              className="shell-select-btn"
              onClick={() => onSelect(shell.id)}
            >
              <span className="shell-select-icon">{shell.icon}</span>
              <span className="shell-select-label">{shell.label}</span>
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
