import { useState, useEffect, useRef, useCallback } from 'react';

interface UseInlineRenameOptions {
  onRename: (name: string) => void;
}

export interface UseInlineRenameReturn {
  isEditing: boolean;
  editName: string;
  inputRef: React.RefObject<HTMLInputElement | null>;
  startEdit: (currentName: string) => void;
  handleChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  handleKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  handleBlur: () => void;
}

export function useInlineRename({ onRename }: UseInlineRenameOptions): UseInlineRenameReturn {
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing) inputRef.current?.focus();
  }, [isEditing]);

  const startEdit = useCallback((currentName: string) => {
    setEditName(currentName);
    setIsEditing(true);
  }, []);

  const confirm = useCallback(() => {
    const trimmed = editName.trim();
    if (trimmed) onRename(trimmed);
    setIsEditing(false);
  }, [editName, onRename]);

  const cancel = useCallback(() => {
    setIsEditing(false);
  }, []);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setEditName(e.target.value);
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      e.stopPropagation(); // 터미널 포커스 방지
      if (e.key === 'Enter') confirm();
      if (e.key === 'Escape') cancel();
    },
    [confirm, cancel],
  );

  const handleBlur = useCallback(() => {
    confirm();
  }, [confirm]);

  return { isEditing, editName, inputRef, startEdit, handleChange, handleKeyDown, handleBlur };
}
