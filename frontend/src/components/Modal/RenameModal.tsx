import { useState, useEffect, useRef } from 'react';
import './RenameModal.css';
import { t } from '../../i18n/i18n.ts';

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
    if (value.length === 0) return t('modal.rename.required');
    if (value.length > MAX_NAME_LENGTH) return t('modal.rename.tooLong', { max: MAX_NAME_LENGTH });
    if (!VALID_NAME_REGEX.test(value)) {
      return t('modal.rename.invalidChars');
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
      setError(err instanceof Error ? err.message : t('modal.rename.failed'));
      setIsSubmitting(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">{t('modal.rename.title')}</h2>
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
            placeholder={t('modal.rename.placeholder')}
            aria-invalid={error ? true : undefined}
          />
          {error && <div className="error-message" role="alert">{error}</div>}
          <div className="modal-actions">
            <button type="button" className="btn-cancel" onClick={onCancel} disabled={isSubmitting}>
              {t('common.cancel')}
            </button>
            <button type="submit" className="btn-submit" disabled={isSubmitting || name.trim() === currentName}>
              {isSubmitting ? t('modal.rename.submitting') : t('common.rename')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
