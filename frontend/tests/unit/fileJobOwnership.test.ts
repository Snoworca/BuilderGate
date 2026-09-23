import assert from 'node:assert/strict';
import { test } from 'node:test';
import type * as OwnershipModule from '../../src/components/fileExplorer/fileJobOwnership.ts';
import type { DecideDetail } from '../../src/components/fileExplorer/fileExplorerPorts.ts';

// FR-FEX-005 AC-5 / FR-FEX-001 AC-6 — which explorer panel answers a file job's
// question and reports its failure. Every panel on a session receives every
// file-job event, and the events race the POST that started the job, so the
// orderings below are the contract: a question or a finish that arrives before
// submit() returned must still reach the panel that started the job, and only
// that panel.
//
// Loaded inside each test: a static import of a missing module crashes the
// runner before any test is named.
const MODULE_PATH = '../../src/components/fileExplorer/fileJobOwnership.ts';
type M = typeof OwnershipModule;

async function load(): Promise<M> {
  return await import(MODULE_PATH) as M;
}

const SESSION = 'sess-1';
const DETAIL: DecideDetail = { kind: 'conflict', path: 'C:\\work\\a.txt', choices: ['overwrite', 'skip'] };

function decision(jobId: string, decisionId = 'd-1') {
  return { kind: 'decide' as const, sessionId: SESSION, jobId, decisionId, detail: DETAIL };
}

function done(jobId: string, outcome: 'completed' | 'cancelled' | 'failed', errorCode?: string) {
  return { jobId, outcome, errorCode };
}

function harness(m: M, clock = { now: 0 }) {
  const answered: string[] = [];
  const withdrawn: string[] = [];
  const failures: (string | undefined)[] = [];
  const cancelled: string[] = [];
  const ownership = m.createFileJobOwnership({
    answer: (route) => { answered.push(`${route.jobId}/${route.decisionId}`); },
    withdraw: (jobId) => { withdrawn.push(jobId); },
    showFailure: (errorCode) => { failures.push(errorCode); },
    cancel: (jobId) => { cancelled.push(jobId); },
    now: () => clock.now,
  });
  return { ownership, answered, withdrawn, failures, cancelled, clock };
}

test('결정 요청이 submit 응답보다 먼저 오면 claim 할 때 답한다', async () => {
  const h = harness(await load());
  h.ownership.onDecision(decision('job-1'));
  assert.deepEqual(h.answered, [], 'an unclaimed question must wait: it may belong to another panel');
  h.ownership.claim('job-1');
  assert.deepEqual(h.answered, ['job-1/d-1']);
});

test('claim 뒤의 결정 요청은 바로 답한다', async () => {
  const h = harness(await load());
  h.ownership.claim('job-1');
  h.ownership.onDecision(decision('job-1'));
  assert.deepEqual(h.answered, ['job-1/d-1']);
});

test('실패한 done 이 submit 응답보다 먼저 오면 claim 할 때 오류를 보이고 소유 목록에 남기지 않는다', async () => {
  const h = harness(await load());
  h.ownership.onDone(done('job-1', 'failed', 'EACCES'));
  assert.deepEqual(h.failures, [], 'an unclaimed failure may belong to another panel');
  h.ownership.claim('job-1');
  assert.deepEqual(h.failures, ['EACCES'], 'the early failure was lost');
  assert.equal(h.ownership.isOwned('job-1'), false, 'a finished job must not stay owned (leak)');
  // A replayed finish or question for the same job is not answered again.
  h.ownership.onDecision(decision('job-1', 'd-2'));
  h.ownership.onDone(done('job-1', 'failed', 'EACCES'));
  assert.deepEqual(h.answered, []);
  assert.deepEqual(h.failures, ['EACCES']);
});

test('완료된 done 이 submit 응답보다 먼저 오면 아무것도 보이지 않고 소유 목록에 남기지 않는다', async () => {
  const h = harness(await load());
  h.ownership.onDone(done('job-1', 'completed'));
  h.ownership.claim('job-1');
  assert.deepEqual(h.failures, []);
  assert.equal(h.ownership.isOwned('job-1'), false, 'a finished job must not stay owned (leak)');
  assert.equal(h.ownership.size().own, 0);
  assert.equal(h.ownership.size().earlyDone, 0, 'the early finish must be consumed by its claim');
});

test('결정 요청 뒤에 done 이 먼저 오고 그 다음 claim 되면 답하지 않는다 — 끝난 작업에는 물을 것이 없다', async () => {
  const h = harness(await load());
  h.ownership.onDecision(decision('job-1'));
  h.ownership.onDone(done('job-1', 'cancelled'));
  h.ownership.claim('job-1');
  assert.deepEqual(h.answered, []);
  assert.equal(h.ownership.size().waitingDecisions, 0);
});

test('질문이 열려 있는 동안 done 이 오면 질문을 거둔다', async () => {
  const h = harness(await load());
  h.ownership.claim('job-1');
  h.ownership.onDecision(decision('job-1'));
  h.ownership.onDone(done('job-1', 'completed'));
  assert.deepEqual(h.withdrawn, ['job-1'], 'the open prompt was not withdrawn');
  assert.equal(h.ownership.isOwned('job-1'), false);
  assert.deepEqual(h.failures, []);
});

test('소유한 작업의 실패 done 은 한 번 오류를 보이고 소유를 푼다', async () => {
  const h = harness(await load());
  h.ownership.claim('job-1');
  h.ownership.onDone(done('job-1', 'failed'));
  assert.deepEqual(h.failures, [undefined]);
  assert.equal(h.ownership.isOwned('job-1'), false);
});

test('같은 사건이 두 패널에 닿으면 소유한 패널만 답하고 오류를 보인다', async () => {
  const m = await load();
  const owner = harness(m);
  const other = harness(m);
  owner.ownership.claim('job-1');
  for (const panel of [owner, other]) panel.ownership.onDecision(decision('job-1'));
  for (const panel of [owner, other]) panel.ownership.onDone(done('job-1', 'failed', 'ENOSPC'));
  assert.deepEqual(owner.answered, ['job-1/d-1']);
  assert.deepEqual(other.answered, [], 'the other panel asked the same question a second time');
  assert.deepEqual(owner.failures, ['ENOSPC']);
  assert.deepEqual(other.failures, [], 'the other panel reported a job it did not start');
  assert.equal(other.ownership.size().waitingDecisions, 0, "a finished job's question must not wait forever");
});

test('다른 패널의 작업 done 은 유한하게만 보관된다 — 나이와 개수로 잘린다', async () => {
  const m = await load();
  const h = harness(m);
  for (let i = 0; i < m.EARLY_DONE_LIMIT + 20; i += 1) h.ownership.onDone(done(`other-${i}`, 'completed'));
  assert.ok(h.ownership.size().earlyDone <= m.EARLY_DONE_LIMIT, `early finishes grew past the limit: ${h.ownership.size().earlyDone}`);

  h.clock.now += m.EARLY_EVENT_TTL_MS + 1;
  h.ownership.onDone(done('fresh', 'completed'));
  assert.equal(h.ownership.size().earlyDone, 1, 'entries older than the TTL were not pruned');

  // An unclaimed question of another panel's job is pruned the same way.
  h.ownership.onDecision(decision('other-q'));
  h.clock.now += m.EARLY_EVENT_TTL_MS + 1;
  h.ownership.onDecision(decision('other-q2'));
  assert.equal(h.ownership.size().waitingDecisions, 1);
});

test('언마운트: 결정을 기다리는 소유 작업만 취소하고 실행 중인 작업은 둔다', async () => {
  const h = harness(await load());
  h.ownership.claim('waiting');
  h.ownership.onDecision(decision('waiting'));
  h.ownership.claim('running');
  h.ownership.claim('answered');
  h.ownership.onDecision(decision('answered'));
  h.ownership.decisionSettled('answered');
  // Another panel's question is not this panel's to cancel.
  h.ownership.onDecision(decision('foreign'));

  h.ownership.dispose();
  assert.deepEqual(h.cancelled, ['waiting'], 'only a job left waiting on a question nobody can answer is cancelled');
});

test('언마운트 뒤에 claim 된 작업이 이미 질문을 기다리고 있었다면 취소한다', async () => {
  const h = harness(await load());
  h.ownership.onDecision(decision('job-1'));
  h.ownership.dispose();
  h.ownership.claim('job-1');
  assert.deepEqual(h.answered, [], 'no UI is left to answer');
  assert.deepEqual(h.cancelled, ['job-1']);

  h.ownership.claim('job-2');
  assert.deepEqual(h.cancelled, ['job-1'], 'a job with no question keeps running');
});
