// The explorer's in-window question row: the provisional default behind the
// ConfirmPort (delete) and the DecidePort (a conflict or error the server raised
// mid-job), plus the folder-name prompt and a short error line.
//
// It is a row inside the window's content, never a dialog: nothing is portalled
// and nothing joins the dialog stack, so a question in one explorer blocks
// neither the terminal nor any other window (DR-12). FR-FEX-007 and FR-FEX-008
// replace the ports without touching their callers.
// @req FR-FEX-005

import { useCallback, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type {
  ConfirmPort,
  DecideAnswer,
  DecideDetail,
  DecidePort,
  FileJobChoice,
} from './fileExplorerPorts.ts';
import { decidePromptRowKey } from './fileExplorerShortcuts.ts';

export type FileExplorerPrompt = { id: number } & (
  | { kind: 'confirm-delete'; paths: readonly string[]; resolve: (answer: 'confirm' | 'cancel') => void }
  | { kind: 'decide'; jobId: string | null; detail: DecideDetail; resolve: (answer: DecideAnswer | null) => void }
  | { kind: 'name'; label: string; initial: string; resolve: (name: string | null) => void });

export interface FileExplorerConfirmBarState {
  /** The question on screen; later ones wait behind it. */
  prompt: FileExplorerPrompt | null;
  error: string | null;
  confirm: ConfirmPort;
  decide: DecidePort;
  /** Like decide, but withdrawn (resolving null) when dropJob names its job. */
  decideJob: (jobId: string, detail: DecideDetail) => Promise<DecideAnswer | null>;
  /** The job finished: its questions no longer have anyone to answer them. */
  dropJob: (jobId: string) => void;
  askName: (label: string, initial: string) => Promise<string | null>;
  showError: (message: string) => void;
  dismissError: () => void;
}

const CHOICE_LABELS: Record<FileJobChoice, string> = {
  overwrite: '덮어쓰기',
  rename: '새 이름으로',
  skip: '건너뛰기',
  retry: '다시 시도',
};

function lastSegment(path: string): string {
  const parts = path.split(/[\\/]/).filter((part) => part !== '');
  return parts[parts.length - 1] ?? path;
}

/**
 * Questions are queued rather than replaced: two jobs can each stop to ask, and
 * dropping one would leave its job waiting on the server with no way to answer.
 * Kept beside the row it drives, since the two are one contract.
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

  const confirm = useCallback<ConfirmPort>((_kind, detail) => new Promise((resolve) => {
    // A second Delete while one is being asked would only ask again and then
    // submit a job for paths the first one already removed.
    if (queueRef.current.some((candidate) => candidate.kind === 'confirm-delete')) {
      resolve('cancel');
      return;
    }
    const prompt: FileExplorerPrompt = {
      id: nextIdRef.current++,
      kind: 'confirm-delete',
      paths: detail.paths,
      resolve: (answer) => { remove(prompt); resolve(answer); },
    };
    add(prompt);
  }), [add, remove]);

  const decideJob = useCallback((jobId: string | null, detail: DecideDetail) => new Promise<DecideAnswer | null>((resolve) => {
    const prompt: FileExplorerPrompt = {
      id: nextIdRef.current++,
      kind: 'decide',
      jobId,
      detail,
      resolve: (answer) => { remove(prompt); resolve(answer); },
    };
    add(prompt);
  }), [add, remove]);

  const decide = useCallback<DecidePort>(async (detail) => {
    // Without a job there is nothing to withdraw it, so an answer always comes.
    const answer = await decideJob(null, detail);
    return answer ?? { choice: detail.choices[0], applyToAll: false };
  }, [decideJob]);

  const dropJob = useCallback((jobId: string) => {
    for (const prompt of queueRef.current) {
      if (prompt.kind === 'decide' && prompt.jobId === jobId) prompt.resolve(null);
    }
  }, []);

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
    confirm,
    decide,
    decideJob,
    dropJob,
    askName,
    showError: setError,
    dismissError,
  }), [askName, confirm, decide, decideJob, dismissError, dropJob, error, queue]);
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
  const [applyToAll, setApplyToAll] = useState(false);
  const [name, setName] = useState(prompt.kind === 'name' ? prompt.initial : '');

  // The row answers its own keys: the window surface would otherwise read a
  // Delete or Ctrl+V typed here as a file operation on the selection.
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const action = decidePromptRowKey({ promptKind: prompt.kind, key: event.key });
    if (action.stopPropagation) event.stopPropagation();
    if (action.resolve === 'cancel' && prompt.kind === 'confirm-delete') prompt.resolve('cancel');
    else if (action.resolve === 'dismiss' && prompt.kind === 'name') prompt.resolve(null);
  };

  if (prompt.kind === 'confirm-delete') {
    const text = prompt.paths.length === 1
      ? `'${lastSegment(prompt.paths[0])}' 을(를) 삭제할까요?`
      : `${prompt.paths.length}개 항목을 삭제할까요?`;
    return (
      <div className="fx-confirm-row" role="group" aria-label="삭제 확인" onKeyDown={handleKeyDown}>
        <span className="fx-confirm-text">{text}</span>
        <button type="button" className="fx-confirm-button fx-danger" onClick={() => prompt.resolve('confirm')}>삭제</button>
        <button type="button" className="fx-confirm-button" onClick={() => prompt.resolve('cancel')}>취소</button>
      </div>
    );
  }

  if (prompt.kind === 'decide') {
    const { detail } = prompt;
    return (
      <div className="fx-confirm-row" role="group" aria-label="파일 작업 결정" onKeyDown={handleKeyDown}>
        <span className="fx-confirm-text" title={detail.path}>
          {detail.kind === 'conflict' ? '이미 있는 항목' : '처리하지 못한 항목'}: {detail.path}
        </span>
        <label className="fx-confirm-check">
          <input type="checkbox" checked={applyToAll} onChange={(event) => setApplyToAll(event.target.checked)} />
          나머지에도 적용
        </label>
        {detail.choices.map((choice) => (
          <button key={choice} type="button" className="fx-confirm-button" onClick={() => prompt.resolve({ choice, applyToAll })}>
            {CHOICE_LABELS[choice]}
          </button>
        ))}
      </div>
    );
  }

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
