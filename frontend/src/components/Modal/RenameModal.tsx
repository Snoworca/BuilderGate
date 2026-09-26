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
    if (value.length === 0) return '이름을 입력하세요';
    if (value.length > MAX_NAME_LENGTH) return `이름은 ${MAX_NAME_LENGTH}자 이하로 입력하세요`;
    if (!VALID_NAME_REGEX.test(value)) {
      return '이름에는 글자, 숫자, 공백, 하이픈(-), 밑줄(_)만 쓸 수 있습니다';
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
      setError(err instanceof Error ? err.message : '세션 이름을 바꾸지 못했습니다');
      setIsSubmitting(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">세션 이름 바꾸기</h2>
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
            placeholder="세션 이름"
            aria-invalid={error ? true : undefined}
          />
          {error && <div className="error-message" role="alert">{error}</div>}
          <div className="modal-actions">
            <button type="button" className="btn-cancel" onClick={onCancel} disabled={isSubmitting}>
              취소
            </button>
            <button type="submit" className="btn-submit" disabled={isSubmitting || name.trim() === currentName}>
              {isSubmitting ? '바꾸는 중…' : '이름 바꾸기'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
