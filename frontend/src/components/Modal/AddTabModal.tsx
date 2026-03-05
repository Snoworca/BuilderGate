import { useEffect } from 'react';
import './AddTabModal.css';

interface Props {
  onSelect: (type: 'terminal' | 'files') => void;
  onCancel: () => void;
}

export function AddTabModal({ onSelect, onCancel }: Props) {
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
        <h2 className="modal-title">Add Tab</h2>
        <div className="add-tab-list">
          <button className="add-tab-btn" onClick={() => onSelect('terminal')}>
            <span className="add-tab-icon">&gt;_</span>
            <span className="add-tab-label">Terminal</span>
          </button>
          <button className="add-tab-btn" onClick={() => onSelect('files')}>
            <span className="add-tab-icon">&#128193;</span>
            <span className="add-tab-label">Files</span>
          </button>
        </div>
        <button className="shell-select-cancel" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
