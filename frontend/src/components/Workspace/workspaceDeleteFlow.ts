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
    return { message: '마지막 Workspace는 삭제할 수 없습니다.', retryable: false };
  }
  const reason = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  return {
    message: 'Workspace를 삭제하지 못했습니다. 일부 터미널은 이미 종료되었을 수 있습니다.',
    ...(reason ? { detail: `원인: ${reason}` } : {}),
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
    ? `터미널 ${tabCount}개가 모두 종료됩니다. 이 Workspace를 삭제할까요?`
    : '열린 터미널이 없는 Workspace입니다. 이 Workspace를 삭제할까요?';
}

function progressMessage(state: WorkspaceDeleteState): string {
  if (state.slow) return '예상보다 오래 걸리고 있습니다. 터미널이 모두 종료되면 이 창이 저절로 닫힙니다.';
  return state.tabCount > 0
    ? `터미널 ${state.tabCount}개를 종료하고 있습니다. 보통 몇 초 안에 끝납니다.`
    : 'Workspace를 삭제하고 있습니다.';
}

export function workspaceDeleteDialogProps(state: WorkspaceDeleteState): WorkspaceDeleteDialogProps {
  const failed = state.phase === 'error';
  const { error } = state;
  return {
    title: 'Workspace 삭제',
    message: state.phase === 'deleting' ? progressMessage(state) : askMessage(state.tabCount),
    confirmLabel: failed ? '다시 시도' : '모두 삭제',
    cancelLabel: failed ? '닫기' : '취소',
    busy: state.phase === 'deleting',
    busyLabel: '삭제하는 중…',
    error: failed && error ? { message: error.message, ...(error.detail ? { detail: error.detail } : {}) } : null,
    hideConfirm: failed && !!error && !error.retryable,
  };
}
