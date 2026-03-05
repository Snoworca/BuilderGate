import { useState, useEffect, useRef } from 'react';
import './RenameModal.css';

const VALID_NAME_REGEX = /^[\p{L}\p{N}\s\-_]+$/u;
const MAX_NAME_LENGTH = 50;

interface Props {
  currentName: string;
  onSubmit: (newName: string) => Promise<void>;
  onCancel: () => void;
}

export function RenameModal({ currentName, onSubmit, onCancel }: Props) {
  const [name, setName] = useState(currentName);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [onCancel]);

  const validate = (value: string): string | null => {
    if (value.length === 0) return 'Name cannot be empty';
    if (value.length > MAX_NAME_LENGTH) return `Name too long (max ${MAX_NAME_LENGTH} characters)`;
    if (!VALID_NAME_REGEX.test(value)) {
      return 'Only letters, numbers, spaces, hyphens, and underscores allowed';
    }
    return null;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    const validationError = validate(trimmed);
    if (validationError) {
      setError(validationError);
      return;
    }

    setIsSubmitting(true);
    setError(null);
    try {
      await onSubmit(trimmed);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to rename session');
      setIsSubmitting(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">Rename Session</h2>
        <form onSubmit={handleSubmit}>
          <input
            ref={inputRef}
            type="text"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
            autoFocus
            maxLength={MAX_NAME_LENGTH}
            className={error ? 'input-error' : ''}
            placeholder="Session name"
          />
          {error && <div className="error-message">{error}</div>}
          <div className="modal-actions">
            <button type="button" className="btn-cancel" onClick={onCancel} disabled={isSubmitting}>
              Cancel
            </button>
            <button type="submit" className="btn-submit" disabled={isSubmitting || name.trim() === currentName}>
              {isSubmitting ? 'Renaming...' : 'Rename'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
