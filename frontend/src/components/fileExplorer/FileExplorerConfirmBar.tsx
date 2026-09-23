// The explorer's in-window row for the folder-name prompt and a short error
// line. Delete confirmations and mid-job decisions moved to the window-scoped
// modal (FileExplorerWindowModal.tsx, FR-FEX-007): they must hold focus until
// answered, which a row beside the list cannot do.
//
// It is a row inside the window's content, never a dialog: nothing is portalled
// and nothing joins the dialog stack, so a prompt in one explorer blocks
// neither the terminal nor any other window (DR-12).
// @req FR-FEX-005

import { useCallback, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { decidePromptRowKey } from './fileExplorerShortcuts.ts';

export type FileExplorerPrompt = { id: number; kind: 'name'; label: string; initial: string; resolve: (name: string | null) => void };

export interface FileExplorerConfirmBarState {
  prompt: FileExplorerPrompt | null;
  error: string | null;
  askName: (label: string, initial: string) => Promise<string | null>;
  showError: (message: string) => void;
  dismissError: () => void;
}
/**
 * Prompts are queued rather than replaced, so a second prompt cannot swallow
 * the first one's answer. Kept beside the row it drives, since the two are one
 * contract.
 * @req FR-FEX-005
 */
// eslint-disable-next-line react-refresh/only-export-components
export function useFileExplorerConfirmBar(): FileExplorerConfirmBarState {
  const [queue, setQueue] = useState<FileExplorerPrompt[]>([]);
  const [error, setError] = useState<string | null>(null);

  // A mirror of the queue for decisions made outside render (is a delete
  // already being asked?), updated in the same place the state is.
  const queueRef = useRef<FileExplorerPrompt[]>([]);
  const nextIdRef = useRef(0);
  const update = useCallback((next: (current: FileExplorerPrompt[]) => FileExplorerPrompt[]) => {
    queueRef.current = next(queueRef.current);
    setQueue(queueRef.current);
  }, []);
  // Settling removes this exact prompt, so a double click cannot answer the next one.
  const add = useCallback((prompt: FileExplorerPrompt) => update((current) => [...current, prompt]), [update]);
  const remove = useCallback((prompt: FileExplorerPrompt) => {
    update((current) => current.filter((candidate) => candidate !== prompt));
  }, [update]);

  const askName = useCallback((label: string, initial: string) => new Promise<string | null>((resolve) => {
    const prompt: FileExplorerPrompt = {
      id: nextIdRef.current++,
      kind: 'name',
      label,
      initial,
      resolve: (name) => { remove(prompt); resolve(name); },
    };
    add(prompt);
  }), [add, remove]);

  const dismissError = useCallback(() => setError(null), []);

  return useMemo(() => ({
    prompt: queue[0] ?? null,
    error,
    askName,
    showError: setError,
    dismissError,
  }), [askName, dismissError, error, queue]);
}

export interface FileExplorerConfirmBarProps {
  prompt: FileExplorerPrompt | null;
  error: string | null;
  onDismissError: () => void;
}

// @req FR-FEX-005
export function FileExplorerConfirmBar({ prompt, error, onDismissError }: FileExplorerConfirmBarProps) {
  if (prompt === null && error === null) return null;
  return (
    <div className="fx-confirm-bar">
      {prompt !== null && <PromptRow key={prompt.id} prompt={prompt} />}
      {error !== null && (
        <div className="fx-confirm-row fx-confirm-error" role="alert">
          <span className="fx-confirm-text">{error}</span>
          <button type="button" className="fx-confirm-button" onClick={onDismissError}>닫기</button>
        </div>
      )}
    </div>
  );
}

// Keyed by prompt id: a new question gets a fresh row, so its input and
// checkbox never inherit the previous question's state.
function PromptRow({ prompt }: { prompt: FileExplorerPrompt }) {
  const [name, setName] = useState(prompt.initial);

  // The row answers its own keys: the window surface would otherwise read a
  // Delete or Ctrl+V typed here as a file operation on the selection.
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const action = decidePromptRowKey({ promptKind: prompt.kind, key: event.key });
    if (action.stopPropagation) event.stopPropagation();
    if (action.resolve === 'dismiss') prompt.resolve(null);
  };

  const submit = () => {
    const trimmed = name.trim();
    if (trimmed !== '') prompt.resolve(trimmed);
  };
  return (
    <div className="fx-confirm-row" role="group" aria-label={prompt.label} onKeyDown={handleKeyDown}>
      <span className="fx-confirm-text">{prompt.label}</span>
      <input
        className="fx-confirm-input"
        value={name}
        autoFocus
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') submit();
        }}
      />
      <button type="button" className="fx-confirm-button" disabled={name.trim() === ''} onClick={submit}>만들기</button>
      <button type="button" className="fx-confirm-button" onClick={() => prompt.resolve(null)}>취소</button>
    </div>
  );
}
