import assert from 'node:assert/strict';
import { test } from 'node:test';
import type * as ModalModelModule from '../../src/components/fileExplorer/fileExplorerModalModel.ts';
import type { DecideDetail } from '../../src/components/fileExplorer/fileExplorerPorts.ts';

// FR-FEX-007 AC-2·AC-3·AC-5·AC-6·AC-7·AC-8 / FR-FEX-005 AC-5 — the pure model
// behind the explorer's window-scoped modal: which buttons a question offers,
// what an answer turns into, what Escape means and where Tab moves focus.
//
// The choices follow what the server offered (server/src/routes/fileJobRoutes.ts,
// fileJobRunner.ts): a plain conflict offers overwrite/rename/skip, an in-place
// or kind-mismatch conflict only rename/skip, an error retry/skip. The model
// never invents a server choice the job would reject. '취소' is not a server
// choice at all: it cancels the whole job (fileJobClient.cancel -> DELETE), so
// it surfaces as {kind:'cancel-job'} rather than as a decision.
//
// The module is loaded inside each test: a static import of a missing module
// kills the runner before any test is named, so a red run would show one crash
// instead of which contracts are unmet. The `import type` line is erased at
// runtime and makes tsc check every call once the module lands.
const MODULE_PATH = '../../src/components/fileExplorer/fileExplorerModalModel.ts';
type M = typeof ModalModelModule;

async function load(): Promise<M> {
  return await import(MODULE_PATH) as M;
}

const ERROR_DETAIL: DecideDetail = { kind: 'error', path: '/home/u/src/a.txt', choices: ['retry', 'skip'] };
const CONFLICT_DETAIL: DecideDetail = {
  kind: 'conflict',
  path: '/home/u/dst/a.txt',
  choices: ['overwrite', 'rename', 'skip'],
};

function choiceIds(model: { choices: readonly { id: string }[] }): string[] {
  return model.choices.map((choice) => choice.id);
}

function choiceLabels(model: { choices: readonly { label: string }[] }): string[] {
  return model.choices.map((choice) => choice.label);
}

test('TC-REQ-FR-FEX-007-AC5-01 buildDecisionModal(kind=\'error\') 선택지가 무시(skip)·재시도(retry)·취소(cancel) 순서다', async () => {
  const { buildDecisionModal } = await load();
  // The server sends [retry, skip]; the modal's order is the AC's, not the wire's.
  const model = buildDecisionModal(ERROR_DETAIL);
  assert.deepEqual(choiceIds(model), ['skip', 'retry', 'cancel']);
  assert.deepEqual(choiceLabels(model), ['무시', '재시도', '취소']);
});

test('TC-REQ-FR-FEX-007-AC5-02 resolveDecisionAnswer: \'cancel\' 은 {kind:\'cancel-job\'}, 그 밖은 {kind:\'decide\', choice, applyToAll} — 서버 choices 에 없는 선택지는 만들지 않는다', async () => {
  const { buildDecisionModal, resolveDecisionAnswer } = await load();

  // Cancel ends the job; applyToAll has no meaning there, so it is not carried.
  assert.deepEqual(resolveDecisionAnswer('cancel', true), { kind: 'cancel-job' });
  assert.deepEqual(resolveDecisionAnswer('cancel', false), { kind: 'cancel-job' });
  assert.deepEqual(resolveDecisionAnswer('skip', true), { kind: 'decide', choice: 'skip', applyToAll: true });
  assert.deepEqual(resolveDecisionAnswer('retry', false), { kind: 'decide', choice: 'retry', applyToAll: false });
  assert.deepEqual(resolveDecisionAnswer('overwrite', true), { kind: 'decide', choice: 'overwrite', applyToAll: true });

  // An in-place or kind-mismatch conflict offers only rename/skip: an overwrite
  // button would send a choice the server rejects.
  const inPlace = buildDecisionModal({ kind: 'conflict', path: '/home/u/a.txt', choices: ['rename', 'skip'] });
  assert.deepEqual(choiceIds(inPlace), ['rename', 'skip']);
  assert.deepEqual(choiceLabels(inPlace), ['이름 바꾸기', '복사하지 않기']);

  // An error that cannot be retried keeps only skip, plus the job-level cancel.
  const noRetry = buildDecisionModal({ kind: 'error', path: '/home/u/a.txt', choices: ['skip'] });
  assert.deepEqual(choiceIds(noRetry), ['skip', 'cancel']);
});

test('TC-REQ-FR-FEX-007-AC6-01 buildDecisionModal(kind=\'conflict\') 선택지가 덮어쓰기(overwrite)·이름 바꾸기(rename)·복사하지 않기(skip) 순서다', async () => {
  const { buildDecisionModal } = await load();
  const model = buildDecisionModal(CONFLICT_DETAIL);
  assert.deepEqual(choiceIds(model), ['overwrite', 'rename', 'skip']);
  assert.deepEqual(choiceLabels(model), ['덮어쓰기', '이름 바꾸기', '복사하지 않기']);

  // Same set in another wire order: the order on screen stays the AC's.
  const shuffled = buildDecisionModal({ ...CONFLICT_DETAIL, choices: ['skip', 'overwrite', 'rename'] });
  assert.deepEqual(choiceIds(shuffled), ['overwrite', 'rename', 'skip']);
});

test('TC-REQ-FR-FEX-007-AC7-01 두 결정 모달 모두 showApplyToAll=true 이고 라벨이 \'더 이상 묻지 않기\' 다', async () => {
  const { buildDecisionModal } = await load();
  for (const detail of [ERROR_DETAIL, CONFLICT_DETAIL]) {
    const model = buildDecisionModal(detail);
    assert.equal(model.showApplyToAll, true, `${detail.kind} modal must offer the checkbox`);
    assert.equal(model.applyToAllLabel, '더 이상 묻지 않기', `${detail.kind} modal checkbox label`);
  }
});

test('TC-REQ-FR-FEX-007-AC8-01 buildDeleteConfirmModal 은 showApplyToAll=false — 묻지 않기 필드 자체가 없다', async () => {
  const { buildDeleteConfirmModal } = await load();
  for (const paths of [['/home/u/a.txt'], ['/home/u/a.txt', '/home/u/b.txt']]) {
    const model = buildDeleteConfirmModal(paths);
    assert.equal(model.showApplyToAll, false);
    // Not merely an empty label: a delete confirm has nothing to remember.
    assert.equal(Object.hasOwn(model, 'applyToAllLabel'), false);
  }
});

test('TC-REQ-FR-FEX-007-AC3-01 decideWindowModalKey: Escape 는 결정 모달에서 cancel-job, 삭제 확인에서 \'cancel\'; 다른 키는 none', async () => {
  const { buildDecisionModal, buildDeleteConfirmModal, decideWindowModalKey, resolveDecisionAnswer } = await load();
  const error = buildDecisionModal(ERROR_DETAIL);
  const conflict = buildDecisionModal(CONFLICT_DETAIL);
  const del = buildDeleteConfirmModal(['/home/u/a.txt']);

  // Escape yields the 'cancel' id everywhere; on a decision modal that id
  // resolves to cancelling the job — including the conflict modal, which shows
  // no cancel button but must still let Escape withdraw the question.
  for (const model of [error, conflict]) {
    const key = decideWindowModalKey(model, 'Escape');
    assert.equal(key, 'cancel');
    assert.deepEqual(resolveDecisionAnswer(key, false), { kind: 'cancel-job' });
  }
  // On the delete confirm 'cancel' is exactly ConfirmPort's own answer.
  assert.equal(decideWindowModalKey(del, 'Escape'), 'cancel');

  for (const model of [error, conflict, del]) {
    for (const other of ['Enter', 'Tab', ' ', 'a', 'Delete']) {
      assert.equal(decideWindowModalKey(model, other), 'none', `key ${JSON.stringify(other)}`);
    }
  }
});

test('TC-REQ-FR-FEX-007-AC2-01 nextFocusIndex: 마지막에서 Tab 은 0, 0 에서 Shift+Tab 은 마지막, 표면 밖 포커스는 0 — 포커스가 모달 컨트롤 밖으로 나가지 않는다', async () => {
  const { nextFocusIndex } = await load();
  assert.equal(nextFocusIndex(3, 2, false), 0);
  assert.equal(nextFocusIndex(3, 0, true), 2);
  assert.equal(nextFocusIndex(3, 0, false), 1);
  assert.equal(nextFocusIndex(3, 2, true), 1);
  // current = -1: focus has escaped the surface; either direction pulls it back to the first control.
  assert.equal(nextFocusIndex(3, -1, false), 0);
  assert.equal(nextFocusIndex(3, -1, true), 0);
  assert.equal(nextFocusIndex(1, 0, false), 0);
  assert.equal(nextFocusIndex(1, 0, true), 0);
});

test('TC-REQ-FR-FEX-005-AC5-01 buildDeleteConfirmModal: 항목 1개는 이름을, 여럿은 개수를 묻고 버튼은 삭제·취소 둘이다', async () => {
  const { buildDeleteConfirmModal } = await load();

  const one = buildDeleteConfirmModal(['/home/u/docs/report.txt']);
  assert.match(one.message, /report\.txt/);
  assert.deepEqual(choiceIds(one), ['confirm', 'cancel']);
  assert.deepEqual(choiceLabels(one), ['삭제', '취소']);
  assert.equal(one.choices[0]?.danger, true, 'delete is the destructive choice');

  const many = buildDeleteConfirmModal(['/home/u/a.txt', '/home/u/b.txt', '/home/u/c.txt']);
  assert.match(many.message, /3/);
  assert.doesNotMatch(many.message, /a\.txt|b\.txt|c\.txt/);
  assert.deepEqual(choiceIds(many), ['confirm', 'cancel']);
});
