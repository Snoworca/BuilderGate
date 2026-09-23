// The explorer's window-scoped modal: the ConfirmPort (delete) and DecidePort
// (a conflict or error the server raised mid-job) behind one queue per window.
//
// It is drawn inside the window's fx-window-body and covers only that body. It
// is never portalled and never joins the dialog stack, because a question in
// one explorer must block neither the terminal nor any other window (DR-12);
// for the same reason it carries no aria-modal, which would claim the page.
// What each question offers and what an answer means live in
// fileExplorerModalModel.ts; this file only holds the queue, focus and keys.
// @req FR-FEX-007

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { ConfirmPort, DecideAnswer, DecideDetail, DecidePort } from './fileExplorerPorts.ts';
import {
  buildDecisionModal,
  buildDeleteConfirmModal,
  decideWindowModalKey,
  nextFocusIndex,
  resolveDecisionAnswer,
  type WindowModalChoiceId,
  type WindowModalModel,
} from './fileExplorerModalModel.ts';

type WindowModalEntry = { id: number } & (
  | { kind: 'delete'; paths: readonly string[]; resolve: (answer: 'confirm' | 'cancel') => void }
  | { kind: 'job'; jobId: string | null; detail: DecideDetail; resolve: (answer: DecideAnswer | null) => void });

export interface FileExplorerWindowModalState {
  /** The question on screen; later ones wait behind it. */
  current: WindowModalEntry | null;
  confirm: ConfirmPort;
  decide: DecidePort;
  /** Like decide, but withdrawn (resolving null) when dropJob names its job. */
  decideJob: (jobId: string, detail: DecideDetail) => Promise<DecideAnswer | null>;
  /** The job finished: its questions no longer have anyone to answer them. */
  dropJob: (jobId: string) => void;
}

/**
 * Questions are queued rather than replaced: two jobs can each stop to ask, and
 * dropping one would leave its job waiting on the server with no way to answer.
 * One per window, so every tab of the window shares it.
 * @req FR-FEX-007
 */
// eslint-disable-next-line react-refresh/only-export-components
export function useFileExplorerWindowModal(): FileExplorerWindowModalState {
  const [queue, setQueue] = useState<WindowModalEntry[]>([]);
  // A mirror of the queue for decisions made outside render (is a delete
  // already being asked?), updated in the same place the state is.
  const queueRef = useRef<WindowModalEntry[]>([]);
  const nextIdRef = useRef(0);
  const update = useCallback((next: (current: WindowModalEntry[]) => WindowModalEntry[]) => {
    queueRef.current = next(queueRef.current);
    setQueue(queueRef.current);
  }, []);
  // Settling removes this exact entry, so a double click cannot answer the next one.
  const add = useCallback((entry: WindowModalEntry) => update((current) => [...current, entry]), [update]);
  const remove = useCallback((entry: WindowModalEntry) => {
    update((current) => current.filter((candidate) => candidate !== entry));
  }, [update]);

  const confirm = useCallback<ConfirmPort>((_kind, detail) => new Promise((resolve) => {
    // A second Delete while one is being asked would only ask again and then
    // submit a job for paths the first one already removed.
    if (queueRef.current.some((candidate) => candidate.kind === 'delete')) {
      resolve('cancel');
      return;
    }
    const entry: WindowModalEntry = {
      id: nextIdRef.current++,
      kind: 'delete',
      paths: detail.paths,
      resolve: (answer) => { remove(entry); resolve(answer); },
    };
    add(entry);
  }), [add, remove]);

  const decideJob = useCallback((jobId: string | null, detail: DecideDetail) => new Promise<DecideAnswer | null>((resolve) => {
    const entry: WindowModalEntry = {
      id: nextIdRef.current++,
      kind: 'job',
      jobId,
      detail,
      resolve: (answer) => { remove(entry); resolve(answer); },
    };
    add(entry);
  }), [add, remove]);

  const decide = useCallback<DecidePort>(async (detail) => {
    // Without a job there is nothing to withdraw it, so an answer always comes.
    const answer = await decideJob(null, detail);
    return answer ?? { kind: 'decide', choice: detail.choices[0], applyToAll: false };
  }, [decideJob]);

  const dropJob = useCallback((jobId: string) => {
    for (const entry of queueRef.current) {
      if (entry.kind === 'job' && entry.jobId === jobId) entry.resolve(null);
    }
  }, []);

  return useMemo(() => ({
    current: queue[0] ?? null,
    confirm,
    decide,
    decideJob,
    dropJob,
  }), [confirm, decide, decideJob, dropJob, queue]);
}

function modelOf(entry: WindowModalEntry): WindowModalModel {
  return entry.kind === 'delete' ? buildDeleteConfirmModal(entry.paths) : buildDecisionModal(entry.detail);
}

function settle(entry: WindowModalEntry, choiceId: WindowModalChoiceId, applyToAll: boolean): void {
  if (entry.kind === 'delete') {
    entry.resolve(choiceId === 'confirm' ? 'confirm' : 'cancel');
    return;
  }
  // A decision model never offers 'confirm'; ignoring it keeps the job waiting
  // rather than sending the server an answer it did not ask for.
  if (choiceId === 'confirm') return;
  entry.resolve(resolveDecisionAnswer(choiceId, applyToAll));
}

// @req FR-FEX-007
export function FileExplorerWindowModal({ modal }: { modal: FileExplorerWindowModalState }) {
  if (modal.current === null) return null;
  // Keyed by entry so the next question starts with a fresh checkbox and focus.
  return <WindowModalSurface key={modal.current.id} entry={modal.current} />;
}

function WindowModalSurface({ entry }: { entry: WindowModalEntry }) {
  const model = modelOf(entry);
  const [applyToAll, setApplyToAll] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const controls = (): HTMLElement[] => [...(boxRef.current?.querySelectorAll<HTMLElement>('button, input') ?? [])];

  useEffect(() => {
    controls()[0]?.focus();
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // The window's own shortcuts (Delete, Ctrl+C, arrows) must not act on the
    // list behind an open question.
    event.stopPropagation();
    if (event.key === 'Tab') {
      event.preventDefault();
      const list = controls();
      const index = nextFocusIndex(list.length, list.indexOf(document.activeElement as HTMLElement), event.shiftKey);
      list[index]?.focus();
      return;
    }
    if (decideWindowModalKey(model, event.key) === 'cancel') {
      event.preventDefault();
      settle(entry, 'cancel', false);
    }
  };

  return (
    <div className="fx-window-modal">
      <div className="fx-window-modal-scrim" />
      <div className="fx-window-modal-box" role="alertdialog" aria-label={model.title} ref={boxRef} onKeyDown={handleKeyDown}>
        <div className="fx-window-modal-title">{model.title}</div>
        <div className="fx-window-modal-message" title={model.message}>{model.message}</div>
        {model.showApplyToAll && (
          <label className="fx-window-modal-check">
            <input type="checkbox" checked={applyToAll} onChange={(event) => setApplyToAll(event.target.checked)} />
            {model.applyToAllLabel}
          </label>
        )}
        <div className="fx-window-modal-actions">
          {model.choices.map((choice) => (
            <button
              key={choice.id}
              type="button"
              className={`fx-confirm-button${choice.danger ? ' fx-danger' : ''}`}
              onClick={() => settle(entry, choice.id, applyToAll)}
            >
              {choice.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
