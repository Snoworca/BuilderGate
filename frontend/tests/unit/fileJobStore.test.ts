import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type * as StoreModule from '../../src/components/fileExplorer/fileJobStore.ts';
import { routeFileJobMessage } from '../../src/components/fileExplorer/fileJobEvents.ts';
import type { ServerWsMessage } from '../../src/types/ws-protocol.ts';

// FR-FEX-008 / FR-FEX-009 — the app-wide file-job store. A job outlives the
// explorer window that started it, so its progress and its pending question are
// held here, not in the panel: closing or minimizing the window must neither
// lose the job nor drop the question it is waiting on (the old per-panel
// ownership cancelled such a job on unmount; FR-FEX-009 replaces that with
// "ask again when the window is re-opened").
//
// The store also takes over the attribution rules fileJobOwnership.test.ts
// pinned for the panel: every file-job event reaches every client, and it races
// the POST that started the job. So a question or a finish that arrives before
// JOB_STARTED is buffered, only the window that started a job is asked, and a
// finish withdraws the question.
//
// Loaded inside each test: a static import of a missing module crashes the
// runner before any test is named, which would hide how many cases are red.
const MODULE_PATH = '../../src/components/fileExplorer/fileJobStore.ts';
const MODULE_FILE = new URL('../../src/components/fileExplorer/fileJobStore.ts', import.meta.url);
type M = typeof StoreModule;
type State = ReturnType<M['fileJobStoreReducer']>;

async function load(): Promise<M> {
  return await import(MODULE_PATH) as M;
}

const S1 = 'sess-1';
const S2 = 'sess-2';
const WS_A = 'ws-a';
const WS_B = 'ws-b';

// Actions are built from the real WS messages through routeFileJobMessage, so
// the store is pinned against what the socket actually delivers.
function progressMsg(jobId: string, over: Partial<Extract<ServerWsMessage, { type: 'file-job:progress' }>> = {}): ServerWsMessage {
  return {
    type: 'file-job:progress',
    sessionId: S1,
    jobId,
    phase: 'transferring',
    processedBytes: 25,
    totalBytes: 100,
    processedEntries: 128,
    totalEntries: 337,
    currentPath: 'C:\\work\\big.iso',
    ...over,
  };
}

function decisionMsg(jobId: string, decisionId = 'd-1', sessionId = S1): ServerWsMessage {
  return {
    type: 'file-job:decision-required',
    sessionId,
    jobId,
    decisionId,
    kind: 'conflict',
    path: 'C:\\work\\a.txt',
    detail: null,
    choices: ['overwrite', 'rename', 'skip'],
  };
}

function progress(jobId: string, over: Partial<Extract<ServerWsMessage, { type: 'file-job:progress' }>> = {}) {
  const route = routeFileJobMessage(progressMsg(jobId, over));
  assert.ok(route !== null && route.kind === 'progress');
  return { type: 'PROGRESS' as const, route };
}

function decision(jobId: string, decisionId = 'd-1', sessionId = S1) {
  const route = routeFileJobMessage(decisionMsg(jobId, decisionId, sessionId));
  assert.ok(route !== null && route.kind === 'decide');
  return { type: 'DECISION_REQUIRED' as const, route };
}

function started(jobId: string, workspaceId: string, operation: 'copy' | 'move' | 'delete' = 'copy', sessionId = S1) {
  return { type: 'JOB_STARTED' as const, jobId, sessionId, origin: { workspaceId, tabId: `${workspaceId}-tab-1` }, operation };
}

function done(jobId: string, outcome: 'completed' | 'cancelled' | 'failed', errorCode?: string, sessionId = S1) {
  return { type: 'DONE' as const, jobId, sessionId, outcome, errorCode };
}

function answered(jobId: string, decisionId = 'd-1') {
  return { type: 'DECISION_ANSWERED' as const, jobId, decisionId };
}

// One element of GET /api/file-jobs (server/src/routes/fileJobRoutes.ts):
// FileJobSummary plus pendingDecision (the decision-required payload or null).
function listed(jobId: string, over: { sourceSessionId?: string; destSessionId?: string; operation?: 'copy' | 'move' | 'delete'; pending?: string | null } = {}) {
  const pending = over.pending ?? null;
  return {
    jobId,
    sourceSessionId: over.sourceSessionId ?? S1,
    destSessionId: over.destSessionId ?? over.sourceSessionId ?? S1,
    operation: over.operation ?? 'copy',
    state: pending === null ? 'running' as const : 'awaiting-decision' as const,
    pendingDecision: pending === null ? null : {
      jobId,
      decisionId: pending,
      kind: 'conflict' as const,
      path: 'C:\\work\\a.txt',
      detail: null,
      choices: ['overwrite', 'skip'] as Array<'overwrite' | 'rename' | 'skip' | 'retry'>,
    },
  };
}

type Action = Parameters<M['fileJobStoreReducer']>[1];

function run(m: M, actions: readonly unknown[], from?: State): State {
  let state = from ?? m.initialFileJobStoreState;
  for (const action of actions) state = m.fileJobStoreReducer(state, action as Action);
  return state;
}

function ids(jobs: ReadonlyArray<{ jobId: string }>): string[] {
  return jobs.map((job) => job.jobId);
}

function pendingIds(m: M, state: State, workspaceId: string): string[] {
  return m.selectPendingDecisionsForWindow(state, workspaceId).map((route) => `${route.jobId}/${route.decisionId}`);
}

// ---------------------------------------------------------------------------
// FR-FEX-008 — progress in three places
// ---------------------------------------------------------------------------

test('TC-REQ-FR-FEX-008-AC1-01 selectWindowJobs(state, workspaceId) 는 origin.workspaceId 가 같은 작업만 돌려준다', async () => {
  const m = await load();
  const state = run(m, [started('a-1', WS_A), started('b-1', WS_B), started('a-2', WS_A), progress('b-1')]);
  assert.deepEqual(ids(m.selectWindowJobs(state, WS_A)).sort(), ['a-1', 'a-2']);
  assert.deepEqual(ids(m.selectWindowJobs(state, WS_B)), ['b-1']);
  assert.deepEqual(ids(m.selectWindowJobs(state, 'ws-none')), []);
  // A finished job leaves its window's row.
  const after = run(m, [done('a-1', 'completed')], state);
  assert.deepEqual(ids(m.selectWindowJobs(after, WS_A)), ['a-2']);
});

test('TC-REQ-FR-FEX-008-AC2-01 selectProgressRowView: 막대 비율(바이트)·작업 종류 라벨(복사/이동/삭제)·처리 항목 수/전체·취소할 jobId', async () => {
  const m = await load();
  const state = run(m, [started('job-1', WS_A, 'copy'), progress('job-1')]);
  const view = m.selectProgressRowView(m.selectWindowJobs(state, WS_A));
  assert.ok(view !== null, 'a window with a running job must have a progress row');
  assert.equal(view.jobId, 'job-1', 'the cancel button needs the job id');
  assert.equal(view.fraction, 0.25, 'the bar is processedBytes / totalBytes');
  assert.equal(view.indeterminate, false);
  assert.equal(view.label, '복사');
  assert.equal(view.processedEntries, 128);
  assert.equal(view.totalEntries, 337);
  assert.equal(view.moreCount, 0);

  for (const [operation, label] of [['move', '이동'], ['delete', '삭제']] as const) {
    const s = run(m, [started(`op-${operation}`, WS_B, operation), progress(`op-${operation}`)]);
    assert.equal(m.selectProgressRowView(m.selectWindowJobs(s, WS_B))?.label, label, `label for ${operation}`);
  }

  // A delete of empty files reports totalBytes 0: the bar must still be a number in [0, 1]
  // (a NaN width draws nothing, a >1 width overflows the row).
  const zero = run(m, [started('z', WS_A, 'delete'), progress('z', { processedBytes: 0, totalBytes: 0 })]);
  const zeroView = m.selectProgressRowView(m.selectWindowJobs(zero, WS_A));
  assert.ok(zeroView !== null && Number.isFinite(zeroView.fraction) && zeroView.fraction >= 0 && zeroView.fraction <= 1,
    `fraction must stay in [0, 1], got ${zeroView?.fraction}`);
  const over = run(m, [started('o', WS_A), progress('o', { processedBytes: 150, totalBytes: 100 })]);
  assert.equal(m.selectProgressRowView(m.selectWindowJobs(over, WS_A))?.fraction, 1, 'fraction is clamped to 1');
});

test('TC-REQ-FR-FEX-008-AC3-01 창의 작업이 3개면 가장 최근(startedSeq) 것 하나와 moreCount=2', async () => {
  const m = await load();
  // Ids deliberately out of lexical order: recency is the order JOB_STARTED arrived.
  const state = run(m, [started('job-c', WS_A), started('job-a', WS_A), started('job-b', WS_A)]);
  const view = m.selectProgressRowView(m.selectWindowJobs(state, WS_A));
  assert.equal(view?.jobId, 'job-b', 'the most recently started job is shown');
  assert.equal(view?.moreCount, 2);
  // Progress on an older job does not make it the most recent one.
  const later = run(m, [progress('job-c'), progress('job-a')], state);
  assert.equal(m.selectProgressRowView(m.selectWindowJobs(later, WS_A))?.jobId, 'job-b', 'recency is by start, not by last update');
});

test("TC-REQ-FR-FEX-008-AC4-01 selectStatusBarView: 1개는 {kind:'single', fraction, currentFile(마지막 세그먼트)}, 2개 이상은 {kind:'multiple', count, spinner:true}", async () => {
  const m = await load();
  const one = run(m, [started('job-1', WS_A), progress('job-1')]);
  const single = m.selectStatusBarView(one);
  assert.equal(single.kind, 'single');
  assert.ok(single.kind === 'single');
  assert.equal(single.fraction, 0.25);
  assert.equal(single.indeterminate, false);
  assert.equal(single.currentFile, 'big.iso', 'a Windows path shows its last segment');
  assert.equal(single.jobId, 'job-1');

  const posix = run(m, [started('p', WS_A), progress('p', { currentPath: '/home/u/docs/report.pdf' })]);
  const posixView = m.selectStatusBarView(posix);
  assert.ok(posixView.kind === 'single');
  assert.equal(posixView.currentFile, 'report.pdf', 'a POSIX path shows its last segment');

  const nullPath = run(m, [started('n', WS_A), progress('n', { currentPath: null })]);
  const nullView = m.selectStatusBarView(nullPath);
  assert.ok(nullView.kind === 'single');
  assert.equal(nullView.currentFile, null);

  // Counted across windows: the status bar is app-wide.
  const two = run(m, [started('job-2', WS_B)], one);
  const multiple = m.selectStatusBarView(two);
  assert.equal(multiple.kind, 'multiple');
  assert.ok(multiple.kind === 'multiple');
  assert.equal(multiple.count, 2);
  assert.equal(multiple.spinner, true);
});

test("TC-REQ-FR-FEX-008-AC5-01 phase='scanning' 이면 세 뷰 모두 막대 대신 indeterminate(회전)", async () => {
  const m = await load();
  const state = run(m, [started('job-1', WS_A), progress('job-1', { phase: 'scanning', processedBytes: 0, totalBytes: 0 })]);
  assert.equal(m.selectProgressRowView(m.selectWindowJobs(state, WS_A))?.indeterminate, true, 'progress row');
  const bar = m.selectStatusBarView(state);
  assert.ok(bar.kind === 'single');
  assert.equal(bar.indeterminate, true, 'status bar');
  assert.deepEqual(m.selectPopoverRows(state).map((row) => row.indeterminate), [true], 'popover');

  // Before any progress has arrived the phase is unknown: spin, do not draw an empty bar.
  const fresh = run(m, [started('job-2', WS_B)]);
  assert.equal(m.selectProgressRowView(m.selectWindowJobs(fresh, WS_B))?.indeterminate, true, 'a job with no progress yet spins');

  // Once it is transferring, the bar returns.
  const moving = run(m, [progress('job-1', { phase: 'transferring' })], state);
  assert.equal(m.selectProgressRowView(m.selectWindowJobs(moving, WS_A))?.indeterminate, false);
});

test('TC-REQ-FR-FEX-008-AC6-01 selectPopoverRows: 작업마다 한 줄, 각 줄에 fraction 과 jobId', async () => {
  const m = await load();
  const state = run(m, [
    started('job-1', WS_A), progress('job-1'),
    started('job-2', WS_B, 'move'), progress('job-2', { processedBytes: 50, totalBytes: 100 }),
  ]);
  const rows = m.selectPopoverRows(state);
  assert.equal(rows.length, 2, 'one row per job');
  const byId = new Map(rows.map((row) => [row.jobId, row]));
  assert.equal(byId.get('job-1')?.fraction, 0.25);
  assert.equal(byId.get('job-2')?.fraction, 0.5);
  assert.equal(byId.get('job-2')?.label, '이동');
  assert.deepEqual(ids(rows), ['job-2', 'job-1'], 'most recent first');
});

test('TC-REQ-FR-FEX-008-AC7-01 decidePopoverOutsideClose(inPopover, inStatusBar): 둘 다 밖일 때만 닫는다', async () => {
  const m = await load();
  assert.equal(m.decidePopoverOutsideClose(false, false), true, 'a press outside both closes');
  assert.equal(m.decidePopoverOutsideClose(true, false), false, 'a press inside the popover keeps it');
  // The status bar toggles the popover itself; closing on its pointerdown would reopen it on click.
  assert.equal(m.decidePopoverOutsideClose(false, true), false, 'a press on the status bar is not an outside press');
  assert.equal(m.decidePopoverOutsideClose(true, true), false);
});

test("TC-REQ-FR-FEX-008-AC8-01 빈 저장소: 상태바 {kind:'hidden'}, 진행 줄 null, 알림창 줄 []", async () => {
  const m = await load();
  const empty = m.initialFileJobStoreState;
  assert.deepEqual(m.selectStatusBarView(empty), { kind: 'hidden' });
  assert.equal(m.selectProgressRowView(m.selectWindowJobs(empty, WS_A)), null);
  assert.deepEqual(m.selectPopoverRows(empty), []);

  // Back to nothing once the last job finishes, whatever the outcome.
  const drained = run(m, [
    started('j1', WS_A), started('j2', WS_A), started('j3', WS_B),
    done('j1', 'completed'), done('j2', 'cancelled'), done('j3', 'failed', 'EACCES'),
  ]);
  assert.deepEqual(m.selectStatusBarView(drained), { kind: 'hidden' });
  assert.equal(m.selectProgressRowView(m.selectWindowJobs(drained, WS_A)), null);
  assert.deepEqual(m.selectPopoverRows(drained), []);
});

test('TC-REQ-FR-FEX-008-AC9-01 저장소는 창 레코드를 모른다 — 창이 닫혀도 작업이 남고 상태바 뷰가 그것을 센다', async () => {
  const m = await load();
  const src = readFileSync(MODULE_FILE, 'utf8');
  // Knowing the window records would tempt a close handler to drop jobs with the window.
  const windowDep = /from\s+['"][^'"]*(useFileExplorerWindows|FileExplorerWindow|windowStateStorage|useWorkspaceManager)[^'"]*['"]/.exec(src);
  assert.equal(windowDep, null, windowDep ? `fileJobStore.ts imports ${windowDep[1]}: the store must not know windows` : '');

  // Nothing the window does on close reaches the store; the job is still counted.
  const state = run(m, [started('job-1', WS_A), progress('job-1')]);
  const unknown = m.fileJobStoreReducer(state, { type: 'WINDOW_CLOSED', workspaceId: WS_A } as unknown as Action);
  assert.equal(unknown, state, 'an action the store does not know must return the same state');
  assert.equal(m.selectStatusBarView(unknown).kind, 'single', 'the status bar takes over the job of a closed window');
  // Re-opening the window finds its job again.
  assert.deepEqual(ids(m.selectWindowJobs(unknown, WS_A)), ['job-1']);
});

// ---------------------------------------------------------------------------
// FR-FEX-009 — a question waits for the window
// ---------------------------------------------------------------------------

test("TC-REQ-FR-FEX-009-AC1-01 결정 대기 작업이 있으면 상태바 뷰에 awaiting={workspaceId, jobId} 와 라벨 '응답 대기 중'", async () => {
  const m = await load();
  const running = run(m, [started('job-1', WS_A), progress('job-1')]);
  const before = m.selectStatusBarView(running);
  assert.ok(before.kind === 'single');
  assert.equal(before.awaiting, null, 'no question, no awaiting button');

  const waiting = run(m, [decision('job-1')], running);
  const view = m.selectStatusBarView(waiting);
  assert.ok(view.kind === 'single');
  assert.deepEqual(view.awaiting, { workspaceId: WS_A, jobId: 'job-1', label: '응답 대기 중' });

  // With several jobs the awaiting button is still there.
  const many = run(m, [started('job-2', WS_B)], waiting);
  const multi = m.selectStatusBarView(many);
  assert.ok(multi.kind === 'multiple');
  assert.deepEqual(multi.awaiting, { workspaceId: WS_A, jobId: 'job-1', label: '응답 대기 중' });

  // Answering removes it.
  const settled = m.selectStatusBarView(run(m, [answered('job-1')], many));
  assert.ok(settled.kind === 'multiple');
  assert.equal(settled.awaiting, null);
});

test('TC-REQ-FR-FEX-009-AC1-02 origin 을 모르는 작업(GET 목록·새로고침으로 받은 것)의 결정은 sessionId→workspaceId 조회로 귀속한다', async () => {
  const m = await load();
  // After a reload no JOB_STARTED exists: the list is all there is.
  const state = run(m, [{
    type: 'SYNC_LIST',
    jobs: [listed('r-1', { pending: 'd-9' }), listed('r-2', { sourceSessionId: S2 })],
    workspaceOfSession: { [S1]: WS_A, [S2]: WS_B },
  }]);
  const view = m.selectStatusBarView(state);
  assert.ok(view.kind === 'multiple', 'adopted jobs are counted by the status bar');
  assert.deepEqual(view.awaiting, { workspaceId: WS_A, jobId: 'r-1', label: '응답 대기 중' });
  assert.deepEqual(pendingIds(m, state, WS_A), ['r-1/d-9'], 'the re-opened window is asked the adopted question');
  assert.deepEqual(pendingIds(m, state, WS_B), []);
  assert.deepEqual(ids(m.selectWindowJobs(state, WS_B)), ['r-2'], 'an adopted job belongs to its source session\'s workspace');
  const detail = m.selectPendingDecisionsForWindow(state, WS_A)[0]?.detail;
  assert.deepEqual(detail, { kind: 'conflict', path: 'C:\\work\\a.txt', choices: ['overwrite', 'skip'] });

  // A job whose origin is known keeps it: the lookup only fills a gap.
  const known = run(m, [
    started('k-1', WS_B),
    { type: 'SYNC_LIST', jobs: [listed('k-1', { pending: 'd-1' })], workspaceOfSession: { [S1]: WS_A } },
  ]);
  assert.deepEqual(pendingIds(m, known, WS_B), ['k-1/d-1'], 'the window that started the job is still the one asked');
  assert.deepEqual(pendingIds(m, known, WS_A), []);
});

test('TC-REQ-FR-FEX-009-AC3-01 selectPendingDecisionsForWindow(workspaceId) 가 대기 결정을 돌려주고 decisionAnswered·done 이후에는 비운다', async () => {
  const m = await load();
  const asked = run(m, [started('job-1', WS_A), started('job-2', WS_A), decision('job-1', 'd-1'), decision('job-2', 'd-2')]);
  assert.deepEqual(pendingIds(m, asked, WS_A).sort(), ['job-1/d-1', 'job-2/d-2']);
  const route = m.selectPendingDecisionsForWindow(asked, WS_A).find((r) => r.jobId === 'job-1');
  // The window answers with the same route shape the per-panel code used.
  assert.equal(route?.kind, 'decide');
  assert.equal(route?.sessionId, S1);

  const afterAnswer = run(m, [answered('job-1', 'd-1')], asked);
  assert.deepEqual(pendingIds(m, afterAnswer, WS_A), ['job-2/d-2'], 'an answered question is not asked again');

  // A finish withdraws the question still on screen.
  const afterDone = run(m, [done('job-2', 'cancelled')], afterAnswer);
  assert.deepEqual(pendingIds(m, afterDone, WS_A), []);

  // The job's next question is asked; an answer to the previous one does not remove it.
  const next = run(m, [decision('job-1', 'd-3'), answered('job-1', 'd-1')], afterDone);
  assert.deepEqual(pendingIds(m, next, WS_A), ['job-1/d-3'], 'a late answer to an old decision removed the new one');
});

// ---------------------------------------------------------------------------
// Attribution rules taken over from fileJobOwnership (FR-FEX-005 AC-5)
// ---------------------------------------------------------------------------

test('[FR-FEX-009 AC-3] JOB_STARTED 보다 먼저 온 결정은 어느 창에도 묻지 않다가 시작한 창이 알려지면 그 창에 묻는다', async () => {
  const m = await load();
  const early = run(m, [decision('job-1')]);
  assert.deepEqual(pendingIds(m, early, WS_A), [], 'an unclaimed question may belong to another client: nobody is asked yet');
  assert.deepEqual(pendingIds(m, early, WS_B), []);
  const claimed = run(m, [started('job-1', WS_A)], early);
  assert.deepEqual(pendingIds(m, claimed, WS_A), ['job-1/d-1'], 'the early question was lost');
  assert.deepEqual(pendingIds(m, claimed, WS_B), []);
});

test('[FR-FEX-008 AC-8] JOB_STARTED 보다 먼저 끝난 작업은 시작돼도 진행 자리에 남지 않고, 실패면 시작한 창에만 오류가 간다', async () => {
  const m = await load();
  const completed = run(m, [progress('fast'), done('fast', 'completed'), started('fast', WS_A)]);
  assert.deepEqual(ids(m.selectWindowJobs(completed, WS_A)), [], 'a finished job must not come back as running (leak)');
  assert.deepEqual(m.selectStatusBarView(completed), { kind: 'hidden' });
  assert.deepEqual(m.selectWindowFailures(completed, WS_A), []);

  const failed = run(m, [decision('bad'), done('bad', 'failed', 'EACCES'), started('bad', WS_A)]);
  assert.deepEqual(pendingIds(m, failed, WS_A), [], 'a finished job has nothing left to ask');
  assert.deepEqual(m.selectWindowFailures(failed, WS_A).map((f) => [f.jobId, f.errorCode]), [['bad', 'EACCES']], 'the early failure was lost');
  assert.deepEqual(m.selectWindowFailures(failed, WS_B), [], 'another window reported a job it did not start');
  const shown = run(m, [{ type: 'FAILURE_SHOWN', jobId: 'bad' }], failed);
  assert.deepEqual(m.selectWindowFailures(shown, WS_A), [], 'a shown failure is shown once');

  // Finishes of jobs nobody here started (another client) are kept only boundedly.
  let flood = m.initialFileJobStoreState;
  for (let i = 0; i < m.EARLY_DONE_LIMIT + 20; i += 1) flood = m.fileJobStoreReducer(flood, done(`other-${i}`, 'completed'));
  const size = m.selectStoreSize(flood);
  assert.ok(size.earlyDone <= m.EARLY_DONE_LIMIT, `early finishes grew past the limit: ${size.earlyDone}`);
  assert.equal(size.jobs, 0, 'a finish alone must not create a running job');
});

test('[FR-FEX-009 AC-1] 한 작업의 사건이 출발·도착 두 세션 봉투로 두 번 와도 결정은 한 번, 실패도 한 번이다', async () => {
  const m = await load();
  // A cross-session job is broadcast to both of its sessions.
  const state = run(m, [
    started('x', WS_A, 'copy', S1),
    decision('x', 'd-1', S1), decision('x', 'd-1', S2),
  ]);
  assert.deepEqual(pendingIds(m, state, WS_A), ['x/d-1'], 'the same question was queued twice');
  // A re-sent question (second envelope, or GET's resend on reconnect) changes nothing, so no
  // subscriber re-renders and the window does not put the same modal up again.
  assert.equal(m.fileJobStoreReducer(state, decision('x', 'd-1', S2)), state, 'a repeated decision must be a no-op');
  const view = m.selectStatusBarView(state);
  assert.ok(view.kind === 'single', 'one job, not two');
  const finished = run(m, [done('x', 'failed', 'ENOSPC', S1), done('x', 'failed', 'ENOSPC', S2)], state);
  assert.deepEqual(m.selectWindowFailures(finished, WS_A).map((f) => f.jobId), ['x'], 'the failure was reported twice');
  assert.deepEqual(pendingIds(m, finished, WS_A), []);
});

test('[FR-FEX-009 AC-3] 같은 결정이 두 창에 닿아도 시작한 창만 묻는다 — 다른 창은 그 결정도 실패도 모른다', async () => {
  const m = await load();
  const state = run(m, [started('mine', WS_A), started('theirs', WS_B), decision('mine'), decision('theirs', 'd-2')]);
  assert.deepEqual(pendingIds(m, state, WS_A), ['mine/d-1']);
  assert.deepEqual(pendingIds(m, state, WS_B), ['theirs/d-2']);
  const failed = run(m, [done('mine', 'failed', 'EPERM')], state);
  assert.deepEqual(m.selectWindowFailures(failed, WS_B), []);
  assert.deepEqual(m.selectWindowFailures(failed, WS_A).map((f) => f.errorCode), ['EPERM']);
});

test('[FR-FEX-009 AC-2] SYNC_LIST 는 목록에 없는 작업을 거둔다 — sessionId 범위가 있으면 그 세션의 작업만', async () => {
  const m = await load();
  const before = run(m, [started('s1-live', WS_A, 'copy', S1), started('s1-lost', WS_A, 'copy', S1), started('s2-job', WS_B, 'copy', S2)]);
  // A DONE lost while the socket was down must not leave a job on the status bar forever.
  const scoped = run(m, [{ type: 'SYNC_LIST', sessionId: S1, jobs: [listed('s1-live')], workspaceOfSession: { [S1]: WS_A, [S2]: WS_B } }], before);
  assert.deepEqual(ids(m.selectWindowJobs(scoped, WS_A)), ['s1-live'], 'a job the server no longer lists was kept');
  assert.deepEqual(ids(m.selectWindowJobs(scoped, WS_B)), ['s2-job'], 'a list for one session dropped another session\'s job');

  const global = run(m, [{ type: 'SYNC_LIST', jobs: [listed('s1-live')], workspaceOfSession: {} }], scoped);
  assert.deepEqual(ids(m.selectPopoverRows(global)), ['s1-live']);
  assert.deepEqual(ids(m.selectWindowJobs(global, WS_A)), ['s1-live'], 'an unscoped list keeps the origin of a job it still lists');
});

test('[FR-FEX-009 AC-3] 모듈 저장소: 구독을 끊어도(창 언마운트) 작업과 대기 결정이 남고 다시 구독하면 보인다', async () => {
  const m = await load();
  const ws = 'ws-module-store';
  let calls = 0;
  const unsubscribe = m.subscribeFileJobs(() => { calls += 1; });
  m.dispatchFileJob(started('mod-1', ws));
  m.dispatchFileJob(decision('mod-1', 'd-7'));
  assert.ok(calls >= 2, 'subscribers are notified of changes');
  const snap = m.getFileJobSnapshot();
  assert.equal(m.getFileJobSnapshot(), snap, 'useSyncExternalStore needs the same snapshot until something changes');

  unsubscribe();
  const quiet = calls;
  m.dispatchFileJob(progress('mod-1'));
  assert.equal(calls, quiet, 'an unsubscribed listener must not be called');

  // The window re-mounts: the question it was waiting on is still there, and nothing cancelled the job.
  let again = 0;
  const unsubscribe2 = m.subscribeFileJobs(() => { again += 1; });
  assert.deepEqual(pendingIds(m, m.getFileJobSnapshot(), ws), ['mod-1/d-7']);
  assert.deepEqual(ids(m.selectWindowJobs(m.getFileJobSnapshot(), ws)), ['mod-1']);
  const stable = m.getFileJobSnapshot();
  m.dispatchFileJob({ type: 'NOT_A_FILE_JOB_ACTION' } as unknown as Action);
  assert.equal(m.getFileJobSnapshot(), stable, 'a no-op dispatch must keep the snapshot');
  assert.equal(again, 0, 'a no-op dispatch must not notify');
  m.dispatchFileJob(done('mod-1', 'completed'));
  assert.equal(again, 1);
  unsubscribe2();
});

test('[FR-FEX-008 AC-1] 리듀서는 순수하다 — 입력 상태를 바꾸지 않고 시계를 읽지 않는다', async () => {
  const m = await load();
  const state = run(m, [started('p-1', WS_A), progress('p-1'), decision('p-1')]);
  const copy = structuredClone(state);
  // Each action is applied to the same input, so a mutation of any object it holds is seen.
  for (const action of [progress('p-1', { processedBytes: 90 }), answered('p-1'), done('p-1', 'failed', 'EIO'), started('p-2', WS_B),
    { type: 'SYNC_LIST', jobs: [], workspaceOfSession: {} }]) {
    m.fileJobStoreReducer(state, action as Action);
    assert.deepEqual(state, copy, `the reducer mutated its input on ${(action as { type: string }).type}`);
  }
  // Recency is a monotonic sequence number; a wall clock makes the order untestable.
  const src = readFileSync(MODULE_FILE, 'utf8');
  const clock = /\b(Date\.now|new Date|performance\.now)\b/.exec(src);
  assert.equal(clock, null, clock ? `fileJobStore.ts reads the clock (${clock[1]})` : '');
});
