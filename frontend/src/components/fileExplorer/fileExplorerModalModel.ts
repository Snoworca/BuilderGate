// The pure model behind the explorer's window-scoped modal: which buttons a
// question offers, what an answer turns into, what Escape means and where Tab
// moves focus. The component only renders what this returns, so the choice set
// and its order are decided in one place a unit test can reach.
// @req FR-FEX-007
// @req FR-FOP-006

import { t, tn } from '../../i18n/i18n.ts';
import type { MessageKey } from '../../i18n/i18n.ts';
import type { DecideAnswer, DecideDetail, FileJobChoice } from './fileExplorerPorts.ts';
import { formatTransferBytes, transferReasonText } from './fileTransferModel.ts';
import { formatEntryModified } from './fileListView.ts';

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
  /** n/m beside the title while one job asks several questions. */
  counter?: string;
  message: string;
  choices: readonly WindowModalChoice[];
  showApplyToAll: boolean;
  /** Present only when showApplyToAll is true: a delete confirm has nothing to remember. */
  applyToAllLabel?: string;
  /** FR-FEX-024: what is there against what arrives, one line each. */
  details?: readonly { label: string; value: string; emphasis?: boolean }[];
  /** FR-FEX-024 AC-8: the items a notice lists, each with its reason. */
  items?: readonly { name: string; reason: string }[];
}

/** A notice only acknowledges; its one button settles it. */
export type NoticeChoiceId = 'confirm';

// Screen order is the AC's, not the wire's: the server may send the same set
// in any order, and a button that moves between questions gets misclicked.
const ERROR_ORDER: readonly FileJobChoice[] = ['skip', 'retry'];
const CONFLICT_ORDER: readonly FileJobChoice[] = ['overwrite', 'rename', 'skip'];

const ERROR_LABELS: Partial<Record<FileJobChoice, MessageKey>> = { skip: 'fileExplorer.modal.ignore', retry: 'fileExplorer.modal.retry' };
// FR-FOP-006 AC-1: one wording for upload, copy and move.
const CONFLICT_LABELS: Partial<Record<FileJobChoice, MessageKey>> = {
  overwrite: 'fileExplorer.modal.overwrite',
  rename: 'fileExplorer.modal.keepBoth',
  skip: 'fileExplorer.modal.skip',
};

// A conflict name longer than this is shortened in the middle (FR-FOP-006 AC-4).
const NAME_MAX = 32;

function labelFor(key: MessageKey | undefined, fallback: string): string {
  return key === undefined ? fallback : t(key);
}

// Display only: the name shown in a question, never a path decision.
function lastSegment(path: string): string {
  const parts = path.split(/[\\/]/).filter((part) => part !== '');
  return parts[parts.length - 1] ?? path;
}

function parentSegment(path: string): string {
  const parts = path.split(/[\\/]/).filter((part) => part !== '');
  return parts[parts.length - 2] ?? '';
}

/**
 * Keeps both ends of a long name, which carry the most: the start says what it is, the end
 * its extension (FR-FOP-006 AC-4). `max` counts the ellipsis.
 * @req FR-FOP-006
 */
export function shortenMiddle(name: string, max = NAME_MAX): string {
  if (name.length <= max) return name;
  const keep = max - 1;
  const tail = Math.floor(keep / 2);
  return `${name.slice(0, keep - tail)}…${name.slice(name.length - tail)}`;
}

function describeSide(side: { size: number | null; isDirectory: boolean }, when: string): string {
  const what = side.isDirectory ? t('fileExplorer.modal.folder') : side.size === null ? '' : formatTransferBytes(side.size);
  return [what, when].filter((part) => part !== '').join(' · ');
}

function applyToAllOf(detail: DecideDetail): Pick<WindowModalModel, 'showApplyToAll' | 'applyToAllLabel'> {
  // FR-FOP-006 AC-2: the count of questions still to come; none left, no checkbox.
  if (detail.remaining === undefined) return { showApplyToAll: true, applyToAllLabel: t('fileExplorer.modal.applyToRemainingUnknown') };
  if (detail.remaining <= 0) return { showApplyToAll: false };
  return { showApplyToAll: true, applyToAllLabel: tn('fileExplorer.modal.applyToRemaining', detail.remaining) };
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
    .map((choice) => ({ id: choice, label: labelFor(labels[choice], choice) }));
  if (isError) choices.push({ id: 'cancel', label: t('common.cancel') });
  const counter = detail.position !== undefined && detail.position.total > 1
    ? t('fileExplorer.modal.counter', { index: detail.position.index, total: detail.position.total })
    : undefined;
  const details = detail.existing !== undefined && detail.incoming !== undefined
    ? [
      { label: t('fileExplorer.modal.existing'), value: describeSide(detail.existing, detail.existing.modified === null ? '' : formatEntryModified(detail.existing.modified)) },
      { label: t('fileExplorer.modal.incoming'), value: describeSide(detail.incoming, t('fileExplorer.modal.now')), emphasis: true },
    ]
    : undefined;
  return {
    title: isError ? t('fileExplorer.modal.errorTitle') : t('fileExplorer.modal.conflictTitle'),
    ...(counter === undefined ? {} : { counter }),
    // FR-FOP-006 AC-3: no particle right after a placeholder.
    message: isError
      ? detail.path
      : t('fileExplorer.modal.conflictMessage', { folder: detail.folder ?? parentSegment(detail.path), name: shortenMiddle(lastSegment(detail.path)) }),
    choices,
    ...applyToAllOf(detail),
    ...(details === undefined ? {} : { details }),
  };
}

/**
 * FR-FEX-024 AC-8: the files the server refused, listed together with a reason each. It only
 * acknowledges, so its one button is 확인 and it remembers nothing.
 * @req FR-FEX-024
 */
export function buildRejectedItemsModal(items: readonly { path: string; code: string }[]): WindowModalModel {
  return {
    title: t('fileExplorer.modal.errorTitle'),
    message: t('fileTransfer.rejected.message'),
    choices: [{ id: 'confirm', label: t('fileExplorer.modal.ok') }],
    showApplyToAll: false,
    items: items.map((item) => ({ name: item.path, reason: transferReasonText(item.code) })),
  };
}

/**
 * One path is named, several are counted: a list of names would not fit a
 * modal and the count is what the person is agreeing to.
 * @req FR-FEX-005
 */
export function buildDeleteConfirmModal(paths: readonly string[]): WindowModalModel {
  const message = paths.length === 1
    ? t('fileExplorer.modal.deleteOne', { name: lastSegment(paths[0]) })
    : tn('fileExplorer.modal.deleteMany', paths.length);
  return {
    title: t('common.deleteConfirm'),
    message,
    choices: [
      { id: 'confirm', label: t('common.delete'), danger: true },
      { id: 'cancel', label: t('common.cancel') },
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
export function shouldFocusWindowModalOnMount(kind: 'delete' | 'job' | 'notice', focusInHost: boolean): boolean {
  return kind === 'delete' || focusInHost;
}
