import { useState, useRef, useCallback } from 'react';
import type { DirectoryEntry } from '../../types';
import { joinPath, getPathSeparator } from '../../utils/pathUtils';
import './FileOperationDialog.css';

type DialogMode = 'copy' | 'move' | 'delete' | 'mkdir' | null;

interface Props {
  mode: DialogMode;
  targetEntry: DirectoryEntry | null;
  currentPath: string;
  onConfirm: (data: { source?: string; destination?: string; path?: string; name?: string }) => Promise<void>;
  onCancel: () => void;
}

const TITLES: Record<string, string> = {
  copy: 'Copy',
  move: 'Move',
  delete: 'Delete',
  mkdir: 'Mkdir',
};

/**
 * Inner dialog component that resets state on mount via key prop.
 */
function DialogInner({ mode, targetEntry, currentPath, onConfirm, onCancel }: Omit<Props, 'mode'> & { mode: NonNullable<DialogMode> }) {
  const getInitialInput = () => {
    if (mode === 'copy' || mode === 'move') return currentPath;
    return '';
  };

  const [inputValue, setInputValue] = useState(getInitialInput);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-focus on mount
  const setRef = useCallback((el: HTMLInputElement | null) => {
    (inputRef as React.MutableRefObject<HTMLInputElement | null>).current = el;
    if (el) el.focus();
  }, []);

  const title = TITLES[mode];
  const fileName = targetEntry?.name || '';

  const handleSubmit = async () => {
    setLoading(true);
    setError(null);
    try {
      if (mode === 'copy' || mode === 'move') {
        const source = joinPath(currentPath, fileName);
        const sep = getPathSeparator(inputValue);
        const dest = inputValue.endsWith(sep) || inputValue.endsWith('/')
          ? `${inputValue}${fileName}`
          : inputValue;
        await onConfirm({ source, destination: dest });
      } else if (mode === 'delete') {
        await onConfirm({ path: joinPath(currentPath, fileName) });
      } else if (mode === 'mkdir') {
        if (!inputValue.trim()) {
          setError('Directory name cannot be empty');
          setLoading(false);
          return;
        }
        await onConfirm({ name: inputValue.trim() });
      }
    } catch (err) {
      setError((err as Error).message);
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !loading) {
      e.preventDefault();
      handleSubmit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  };

  const isDeleteMode = mode === 'delete';

  return (
    <div className="mdir-dialog-overlay" onClick={onCancel}>
      <div
        className="mdir-dialog"
        onClick={e => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="mdir-dialog-title">{title}</div>
        <div className="mdir-dialog-body">
          {isDeleteMode ? (
            <p>Delete &quot;{fileName}&quot;?</p>
          ) : mode === 'mkdir' ? (
            <>
              <p>Create directory:</p>
              <input
                ref={setRef}
                className="mdir-dialog-input"
                value={inputValue}
                onChange={e => setInputValue(e.target.value)}
                disabled={loading}
              />
            </>
          ) : (
            <>
              <p>{title} &quot;{fileName}&quot; to:</p>
              <input
                ref={setRef}
                className="mdir-dialog-input"
                value={inputValue}
                onChange={e => setInputValue(e.target.value)}
                disabled={loading}
              />
            </>
          )}
          {error && <div className="mdir-dialog-error">{error}</div>}
        </div>
        <div className="mdir-dialog-buttons">
          {isDeleteMode ? (
            <>
              <button className="mdir-dialog-btn" onClick={handleSubmit} disabled={loading}>
                [Yes]
              </button>
              <button className="mdir-dialog-btn" onClick={onCancel} disabled={loading}>
                [No]
              </button>
            </>
          ) : (
            <>
              <button className="mdir-dialog-btn" onClick={handleSubmit} disabled={loading}>
                [OK]
              </button>
              <button className="mdir-dialog-btn" onClick={onCancel} disabled={loading}>
                [Cancel]
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Exported wrapper that uses key-based remounting to reset DialogInner state.
 */
export function FileOperationDialog({ mode, targetEntry, currentPath, onConfirm, onCancel }: Props) {
  if (!mode) return null;
  return (
    <DialogInner
      key={mode}
      mode={mode}
      targetEntry={targetEntry}
      currentPath={currentPath}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}
