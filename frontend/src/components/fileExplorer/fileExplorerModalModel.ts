// The pure model behind the explorer's window-scoped modal: which buttons a
// question offers, what an answer turns into, what Escape means and where Tab
// moves focus. The component only renders what this returns, so the choice set
// and its order are decided in one place a unit test can reach.
// @req FR-FEX-007

import type { DecideAnswer, DecideDetail, FileJobChoice } from './fileExplorerPorts.ts';

/** The one choice that is not a server choice: it ends the whole job. */
export type CancelChoiceId = 'cancel';
export type DeleteChoiceId = 'confirm' | 'cancel';
export type WindowModalChoiceId = FileJobChoice | CancelChoiceId | DeleteChoiceId;

export interface WindowModalChoice {
  id: WindowModalChoiceId;
  label: string;
  danger?: boolean;
}

export interface WindowModalModel {
  title: string;
  message: string;
  choices: readonly WindowModalChoice[];
  showApplyToAll: boolean;
  /** Present only when showApplyToAll is true: a delete confirm has nothing to remember. */
  applyToAllLabel?: string;
}

const APPLY_TO_ALL_LABEL = '더 이상 묻지 않기';

// Screen order is the AC's, not the wire's: the server may send the same set
// in any order, and a button that moves between questions gets misclicked.
const ERROR_ORDER: readonly FileJobChoice[] = ['skip', 'retry'];
const CONFLICT_ORDER: readonly FileJobChoice[] = ['overwrite', 'rename', 'skip'];

const ERROR_LABELS: Partial<Record<FileJobChoice, string>> = { skip: '무시', retry: '재시도' };
const CONFLICT_LABELS: Partial<Record<FileJobChoice, string>> = {
  overwrite: '덮어쓰기',
  rename: '이름 바꾸기',
  skip: '복사하지 않기',
};

// Display only: the name shown in a question, never a path decision.
function lastSegment(path: string): string {
  const parts = path.split(/[\\/]/).filter((part) => part !== '');
  return parts[parts.length - 1] ?? path;
}

/**
 * Buttons come only from what the server offered — an in-place conflict has no
 * overwrite, an unretryable error no retry — so no button sends a choice the job
 * would reject. An error question also offers '취소', which cancels the job; a
 * conflict question does not show it, but Escape still withdraws it.
 * @req FR-FEX-007
 */
export function buildDecisionModal(detail: DecideDetail): WindowModalModel {
  const offered = new Set(detail.choices);
  const isError = detail.kind === 'error';
  const order = isError ? ERROR_ORDER : CONFLICT_ORDER;
  const labels = isError ? ERROR_LABELS : CONFLICT_LABELS;
  const choices: WindowModalChoice[] = order
    .filter((choice) => offered.has(choice))
    .map((choice) => ({ id: choice, label: labels[choice] ?? choice }));
  if (isError) choices.push({ id: 'cancel', label: '취소' });
  return {
    title: isError ? '처리하지 못한 항목' : '이미 있는 항목',
    message: detail.path,
    choices,
    showApplyToAll: true,
    applyToAllLabel: APPLY_TO_ALL_LABEL,
  };
}

/**
 * One path is named, several are counted: a list of names would not fit a
 * modal and the count is what the person is agreeing to.
 * @req FR-FEX-005
 */
export function buildDeleteConfirmModal(paths: readonly string[]): WindowModalModel {
  const message = paths.length === 1
    ? `'${lastSegment(paths[0])}' 을(를) 삭제할까요?`
    : `${paths.length}개 항목을 삭제할까요?`;
  return {
    title: '삭제 확인',
    message,
    choices: [
      { id: 'confirm', label: '삭제', danger: true },
      { id: 'cancel', label: '취소' },
    ],
    showApplyToAll: false,
  };
}

/**
 * 'cancel' ends the job (fileJobClient.cancel), so applyToAll means nothing
 * there and is dropped; every other id is a server choice.
 * @req FR-FEX-007
 */
export function resolveDecisionAnswer(choiceId: FileJobChoice | CancelChoiceId, applyToAll: boolean): DecideAnswer {
  if (choiceId === 'cancel') return { kind: 'cancel-job' };
  return { kind: 'decide', choice: choiceId, applyToAll };
}

/**
 * Only Escape is the modal's own key; Enter and Space belong to the focused
 * button, Tab to the focus trap.
 * @req FR-FEX-007
 */
export function decideWindowModalKey(_model: WindowModalModel, key: string): 'cancel' | 'none' {
  return key === 'Escape' ? 'cancel' : 'none';
}

/**
 * Tab wraps inside the modal's controls. current = -1 means focus has left the
 * surface, and either direction brings it back to the first control.
 * @req FR-FEX-007
 */
export function nextFocusIndex(count: number, current: number, shift: boolean): number {
  if (count <= 0) return -1;
  if (current < 0 || current >= count) return 0;
  return shift ? (current - 1 + count) % count : (current + 1) % count;
}

/**
 * Whether a question takes focus when it appears. A delete confirm answers a
 * key the user just pressed in this window, so it always does. A server
 * question arrives on its own, and taking focus then would pull typing out of a
 * terminal into the modal (DR-12, DR-16): it takes focus only when focus is
 * already inside the window. The Tab trap still holds once focus is inside.
 * @req FR-FEX-007
 */
export function shouldFocusWindowModalOnMount(kind: 'delete' | 'job', focusInHost: boolean): boolean {
  return kind === 'delete' || focusInHost;
}
