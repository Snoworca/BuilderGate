import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  WORKSPACE_DELETE_MIN_BUSY_MS,
  WORKSPACE_DELETE_SLOW_AFTER_MS,
  canDismissWorkspaceDelete,
  describeWorkspaceDeleteError,
  failWorkspaceDelete,
  isWorkspaceAlreadyDeletedError,
  markWorkspaceDeleteSlow,
  openWorkspaceDelete,
  remainingMinBusyMs,
  startWorkspaceDelete,
  workspaceDeleteDialogProps,
} from '../../src/components/Workspace/workspaceDeleteFlow.ts';
import { containsHangul } from '../../src/components/ui/uiClasses.ts';

// FR-UIDS-006 — the delete confirmation stays open in a locked loading state
// until the server answers, then closes as the workspace leaves the list.

test('FR-UIDS-006: timing values are the ones the design fixed', () => {
  assert.equal(WORKSPACE_DELETE_MIN_BUSY_MS, 500);
  assert.equal(WORKSPACE_DELETE_SLOW_AFTER_MS, 10_000);
});

test('FR-UIDS-006: a freshly opened dialog asks before anything happens', () => {
  const state = openWorkspaceDelete('ws-1', 3);
  assert.equal(state.phase, 'confirm');
  assert.equal(canDismissWorkspaceDelete(state), true);
  assert.deepEqual(workspaceDeleteDialogProps(state), {
    title: 'Workspace 삭제',
    message: '터미널 3개가 모두 종료됩니다. 이 Workspace를 삭제할까요?',
    confirmLabel: '모두 삭제',
    cancelLabel: '취소',
    busy: false,
    busyLabel: '삭제하는 중…',
    error: null,
    hideConfirm: false,
  });
});

test('FR-UIDS-006 AC-1: pressing 모두 삭제 locks the dialog and says what is happening', () => {
  const deleting = startWorkspaceDelete(openWorkspaceDelete('ws-1', 3));
  assert.ok(deleting);
  assert.equal(deleting.phase, 'deleting');
  assert.equal(canDismissWorkspaceDelete(deleting), false, 'Esc, the overlay and 취소 do nothing while deleting');
  const props = workspaceDeleteDialogProps(deleting);
  assert.equal(props.busy, true);
  assert.equal(props.busyLabel, '삭제하는 중…');
  assert.equal(props.message, '터미널 3개를 종료하고 있습니다. 보통 몇 초 안에 끝납니다.');
});

test('FR-UIDS-006 AC-4: a second press while deleting starts nothing', () => {
  const deleting = startWorkspaceDelete(openWorkspaceDelete('ws-1', 3));
  assert.ok(deleting);
  assert.equal(startWorkspaceDelete(deleting), null);
});

test('FR-UIDS-006 AC-5: after ten seconds the status line says it is taking longer', () => {
  const deleting = startWorkspaceDelete(openWorkspaceDelete('ws-1', 3));
  assert.ok(deleting);
  const slow = markWorkspaceDeleteSlow(deleting);
  assert.equal(workspaceDeleteDialogProps(slow).message, '예상보다 오래 걸리고 있습니다. 터미널이 모두 종료되면 이 창이 저절로 닫힙니다.');
  const confirm = openWorkspaceDelete('ws-1', 3);
  assert.equal(markWorkspaceDeleteSlow(confirm), confirm, 'only a running delete can become slow');
});

test('FR-UIDS-006 AC-3: a failed delete keeps the dialog open with the reason and a retry', () => {
  const deleting = startWorkspaceDelete(openWorkspaceDelete('ws-1', 3));
  assert.ok(deleting);
  const failed = failWorkspaceDelete(deleting, new Error('Failed to save (SAVE_FAILED)'));
  assert.equal(failed.phase, 'error');
  assert.equal(canDismissWorkspaceDelete(failed), true);
  const props = workspaceDeleteDialogProps(failed);
  assert.equal(props.busy, false);
  assert.equal(props.confirmLabel, '다시 시도');
  assert.equal(props.cancelLabel, '닫기');
  assert.equal(props.hideConfirm, false);
  assert.equal(props.message, '터미널 3개가 모두 종료됩니다. 이 Workspace를 삭제할까요?');
  assert.deepEqual(props.error, {
    message: 'Workspace를 삭제하지 못했습니다. 일부 터미널은 이미 종료되었을 수 있습니다.',
    detail: '원인: Failed to save (SAVE_FAILED)',
  });

  const retry = startWorkspaceDelete(failed);
  assert.ok(retry, 'the retry starts a new delete');
  assert.equal(retry.phase, 'deleting');
  assert.equal(retry.error, null);
  assert.equal(retry.slow, false);
});

test('FR-UIDS-006 AC-3: the last workspace cannot be deleted, so only 닫기 is offered', () => {
  const deleting = startWorkspaceDelete(openWorkspaceDelete('ws-1', 2));
  assert.ok(deleting);
  const failed = failWorkspaceDelete(deleting, new Error('Cannot delete the last workspace (LAST_WORKSPACE)'));
  const props = workspaceDeleteDialogProps(failed);
  assert.equal(props.hideConfirm, true);
  assert.equal(props.cancelLabel, '닫기');
  assert.deepEqual(props.error, { message: '마지막 Workspace는 삭제할 수 없습니다.' });
  assert.equal(startWorkspaceDelete(failed), null, 'there is no retry for the last workspace');
});

test('FR-UIDS-006 AC-2: a workspace another client already removed counts as deleted', () => {
  assert.equal(isWorkspaceAlreadyDeletedError(new Error('Workspace not found (WORKSPACE_NOT_FOUND)')), true);
  assert.equal(isWorkspaceAlreadyDeletedError(new Error('Failed to save (SAVE_FAILED)')), false);
  assert.equal(isWorkspaceAlreadyDeletedError('WORKSPACE_NOT_FOUND_ISH'), false);
  assert.equal(describeWorkspaceDeleteError(new Error('boom')).retryable, true);
});

test('FR-UIDS-006 AC-7: an empty workspace that fails to delete opens the dialog in its error state', () => {
  const failed = failWorkspaceDelete(openWorkspaceDelete('ws-1', 0), new Error('boom'));
  const props = workspaceDeleteDialogProps(failed);
  assert.equal(props.message, '열린 터미널이 없는 Workspace입니다. 이 Workspace를 삭제할까요?');
  assert.equal(props.confirmLabel, '다시 시도');
  const retry = startWorkspaceDelete(failed);
  assert.ok(retry);
  assert.equal(workspaceDeleteDialogProps(retry).message, 'Workspace를 삭제하고 있습니다.');
});

test('FR-UIDS-006 AC-2: the loading state stays at least 500 ms from the click', () => {
  assert.equal(remainingMinBusyMs(1000, 1100), 400);
  assert.equal(remainingMinBusyMs(1000, 1500), 0);
  assert.equal(remainingMinBusyMs(1000, 1800), 0);
});

test('FR-UIDS-003: every string the dialog shows is Korean', () => {
  const states = [
    openWorkspaceDelete('ws-1', 3),
    startWorkspaceDelete(openWorkspaceDelete('ws-1', 3))!,
    markWorkspaceDeleteSlow(startWorkspaceDelete(openWorkspaceDelete('ws-1', 3))!),
    failWorkspaceDelete(startWorkspaceDelete(openWorkspaceDelete('ws-1', 3))!, new Error('boom')),
    failWorkspaceDelete(openWorkspaceDelete('ws-1', 0), new Error('x (LAST_WORKSPACE)')),
  ];
  for (const state of states) {
    const props = workspaceDeleteDialogProps(state);
    for (const text of [props.title, props.message, props.confirmLabel, props.cancelLabel, props.busyLabel, props.error?.message]) {
      if (text !== undefined) assert.equal(containsHangul(text), true, `"${text}" is not Korean`);
    }
  }
});
