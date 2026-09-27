import { t, tn } from '../../i18n/i18n.ts';

// FR-UIDS-006: the workspace delete confirmation. It stays open in a locked
// loading state until the server answers, then closes as the workspace leaves
// the list; a failure keeps it open with the reason and a retry.
// Design: docs/research/2026-09-26.workspace-delete-loading.md

/** The loading state is never shown for less than this, so it cannot just flash. */
export const WORKSPACE_DELETE_MIN_BUSY_MS = 500;
/** Nielsen's 10 s limit: past it the status line says it is taking longer. */
export const WORKSPACE_DELETE_SLOW_AFTER_MS = 10_000;

export type WorkspaceDeletePhase = 'confirm' | 'deleting' | 'error';

export interface WorkspaceDeleteError {
  message: string;
  detail?: string;
  retryable: boolean;
}

export interface WorkspaceDeleteState {
  phase: WorkspaceDeletePhase;
  workspaceId: string;
  /** Taken when the dialog opens, so the copy does not shift while tabs close. */
  tabCount: number;
  slow: boolean;
  error: WorkspaceDeleteError | null;
}

export interface WorkspaceDeleteDialogProps {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  busy: boolean;
  busyLabel: string;
  error: { message: string; detail?: string } | null;
  hideConfirm: boolean;
}

const hasErrorCode = (err: unknown, code: string): boolean => {
  const text = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  return new RegExp(`\\b${code}\\b`).test(text);
};

/** Another client removed it first: the goal is already reached. */
export function isWorkspaceAlreadyDeletedError(err: unknown): boolean {
  return hasErrorCode(err, 'WORKSPACE_NOT_FOUND');
}

export function describeWorkspaceDeleteError(err: unknown): WorkspaceDeleteError {
  if (hasErrorCode(err, 'LAST_WORKSPACE')) {
    return { message: t('workspace.delete.lastBlocked'), retryable: false };
  }
  const reason = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  return {
    message: t('workspace.delete.failed'),
    ...(reason ? { detail: t('workspace.delete.cause', { reason }) } : {}),
    retryable: true,
  };
}

export function openWorkspaceDelete(workspaceId: string, tabCount: number): WorkspaceDeleteState {
  return { phase: 'confirm', workspaceId, tabCount, slow: false, error: null };
}

/** Null when a delete is already running or cannot be retried. */
export function startWorkspaceDelete(state: WorkspaceDeleteState): WorkspaceDeleteState | null {
  if (state.phase === 'deleting') return null;
  if (state.phase === 'error' && state.error && !state.error.retryable) return null;
  return { ...state, phase: 'deleting', slow: false, error: null };
}

export function markWorkspaceDeleteSlow(state: WorkspaceDeleteState): WorkspaceDeleteState {
  return state.phase === 'deleting' && !state.slow ? { ...state, slow: true } : state;
}

export function failWorkspaceDelete(state: WorkspaceDeleteState, err: unknown): WorkspaceDeleteState {
  return { ...state, phase: 'error', slow: false, error: describeWorkspaceDeleteError(err) };
}

export function canDismissWorkspaceDelete(state: WorkspaceDeleteState): boolean {
  return state.phase !== 'deleting';
}

export function remainingMinBusyMs(startedAt: number, now: number): number {
  return Math.max(0, WORKSPACE_DELETE_MIN_BUSY_MS - (now - startedAt));
}

function askMessage(tabCount: number): string {
  return tabCount > 0
    ? tn('workspace.delete.confirmTabs', tabCount)
    : t('workspace.delete.confirmEmpty');
}

function progressMessage(state: WorkspaceDeleteState): string {
  if (state.slow) return t('workspace.delete.slow');
  return state.tabCount > 0
    ? tn('workspace.delete.endingTabs', state.tabCount)
    : t('workspace.delete.deleting');
}

export function workspaceDeleteDialogProps(state: WorkspaceDeleteState): WorkspaceDeleteDialogProps {
  const failed = state.phase === 'error';
  const { error } = state;
  return {
    title: t('workspace.delete.title'),
    message: state.phase === 'deleting' ? progressMessage(state) : askMessage(state.tabCount),
    confirmLabel: failed ? t('workspace.delete.retry') : t('workspace.delete.deleteAll'),
    cancelLabel: failed ? t('common.close') : t('common.cancel'),
    busy: state.phase === 'deleting',
    busyLabel: t('workspace.delete.busy'),
    error: failed && error ? { message: error.message, ...(error.detail ? { detail: error.detail } : {}) } : null,
    hideConfirm: failed && !!error && !error.retryable,
  };
}
