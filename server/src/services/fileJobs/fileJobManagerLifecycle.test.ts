// FR-FOP-003 · FR-FOP-004 · FR-FOP-005 · IR-FOP-002 · SEC-FOP-001 — 관리자의 종료 대기·실패 코드·retry 기억·
// 표시 경로·blocked 판정 전달.
//
// 러너는 가짜다. 관리자가 러너 결과를 어떻게 알리고, 종료 때 무엇을 기다리는지만 본다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FileJobManager, type FileJobEvent, type FileJobManagerDeps } from './fileJobManager.js';
import type { FileJobFsOps } from './fileJobFsOps.js';
import { join, sep } from 'node:path';
import type { FileJobResult, FileJobRunnerDeps, FileJobSpec } from './fileJobRunner.js';

interface Sent {
  sessionId: string;
  event: FileJobEvent;
  payload: Record<string, unknown>;
}

function harness(runJob: FileJobManagerDeps['runJob'], extra: Partial<FileJobManagerDeps> = {}): { manager: FileJobManager; sent: Sent[] } {
  const sent: Sent[] = [];
  const manager = new FileJobManager({
    runJob,
    fsOps: {} as FileJobFsOps,
    broadcast: (sessionId, event, payload) => sent.push({ sessionId, event, payload }),
    clock: { now: () => 0 },
    timers: { setTimeout: () => ({}), clearTimeout: () => {} },
    validatePathFor: () => () => {},
    ...extra,
  });
  return { manager, sent };
}

async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (predicate()) return;
    await new Promise((r) => setImmediate(r));
  }
  assert.fail(`timed out: ${label}`);
}

const doneOf = (sent: Sent[]): Record<string, unknown>[] => sent.filter((s) => s.event === 'file-job:done').map((s) => s.payload);

// @req FR-FOP-005
test('dispose() 는 도는 작업의 러너가 취소 정리를 끝낼 때까지 settle 되지 않는 promise 를 돌려준다', async () => {
  let finishCleanup: () => void = () => {};
  const cleanupDone = new Promise<void>((r) => {
    finishCleanup = r;
  });
  const { manager } = harness(
    (_spec, deps) =>
      new Promise<FileJobResult>((resolve) => {
        deps.signal?.addEventListener('abort', () => {
          // 러너는 abort 뒤에도 쓰던 임시 파일을 지우는 동안 돌아오지 않는다.
          void cleanupDone.then(() => resolve({ outcome: 'cancelled', processedEntries: 0 }));
        });
      }),
  );
  manager.start({ sourceSessionId: 's', spec: { operation: 'delete', sources: ['/a'] } });
  const disposing = manager.dispose() as unknown;
  assert.ok(disposing instanceof Promise, 'dispose() 가 기다릴 수 있는 promise 를 돌려주지 않는다');
  let settled = false;
  void (disposing as Promise<void>).then(() => {
    settled = true;
  });
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
  assert.equal(settled, false, '러너가 정리 중인데 dispose 가 끝났다');
  finishCleanup();
  await (disposing as Promise<void>);
  assert.equal(settled, true);
  // 여러 번 불러도 된다.
  await manager.dispose();
});

// @req FR-FEX-007 AC-5
// @req IR-FOP-002
test('실패로 끝난 작업의 done 은 경로 없는 오류 코드를 싣고, 성공한 작업의 done 에는 그 키가 없다', async () => {
  const failing = Object.assign(new Error('EACCES: permission denied, open C:\\Users\\me\\secret'), { code: 'EACCES' });
  let fail = true;
  const { manager, sent } = harness(async () =>
    fail ? { outcome: 'failed', processedEntries: 0, error: failing } : { outcome: 'completed', processedEntries: 1 },
  );
  manager.start({ sourceSessionId: 's', spec: { operation: 'delete', sources: ['/a'] } });
  await until(() => doneOf(sent).length === 1, 'failed done');
  const failedDone = doneOf(sent)[0];
  assert.equal(failedDone.outcome, 'failed');
  assert.equal(failedDone.errorCode, 'EACCES');
  assert.ok(!JSON.stringify(failedDone).includes('secret'), '오류 메시지(경로)가 done 에 실렸다');

  fail = false;
  manager.start({ sourceSessionId: 's', spec: { operation: 'delete', sources: ['/b'] } });
  await until(() => doneOf(sent).length === 2, 'completed done');
  assert.equal(Object.hasOwn(doneOf(sent)[1], 'errorCode'), false);
});

// @req IR-FOP-002
test('코드가 없는 오류나 경로가 섞인 코드로 실패하면 done 의 errorCode 는 UNKNOWN 이다', async () => {
  const { manager, sent } = harness(async () => ({ outcome: 'failed', processedEntries: 0, error: { code: '/etc/passwd' } }));
  manager.start({ sourceSessionId: 's', spec: { operation: 'delete', sources: ['/a'] } });
  await until(() => doneOf(sent).length === 1, 'done');
  assert.equal(doneOf(sent)[0].errorCode, 'UNKNOWN');
});

// @req FR-FOP-004
test('fs 오류 질문에 applyToAll=true 로 retry 를 골라도 기억하지 않는다 — 다음 오류는 다시 묻는다', async () => {
  const choices = ['retry', 'skip'] as const;
  const answers: string[] = [];
  const { manager, sent } = harness(async (_spec, deps) => {
    for (let i = 0; i < 2; i += 1) {
      deps.onStateChange?.('awaiting-decision');
      answers.push((await deps.decide({ kind: 'error', path: `/a/${i}`, choices, detail: 'EBUSY' })).choice);
      deps.onStateChange?.('running');
    }
    return { outcome: 'completed', processedEntries: 2 };
  });
  const { jobId } = manager.start({ sourceSessionId: 's', spec: { operation: 'delete', sources: ['/a'] } });
  const asked = (): Record<string, unknown>[] => sent.filter((s) => s.event === 'file-job:decision-required').map((s) => s.payload);
  await until(() => asked().length === 1, 'first question');
  manager.decide(jobId, { decisionId: String(asked()[0].decisionId), choice: 'retry' as never, applyToAll: true });
  // 기억했다면 두 번째 질문은 나가지 않고 retry 가 자동 적용된다 — 계속 실패하는 항목이면 끝없는 재시도다.
  await until(() => asked().length === 2 || answers.length === 2, 'second question');
  assert.equal(asked().length, 2, 'retry 를 applyToAll 로 기억해 묻지 않고 적용했다');
  manager.decide(jobId, { decisionId: String(asked()[1].decisionId), choice: 'skip' });
  await until(() => doneOf(sent).length === 1, 'done');
  assert.deepEqual(answers, ['retry', 'skip']);
});

// @req IR-FOP-002
// @req SEC-FOP-001
test('requestedSpec 이 있으면 러너는 검증된 spec 을 받고, done 의 affectedDirectories 는 클라이언트가 보낸 모양이다', async () => {
  const runs: FileJobSpec[] = [];
  const { manager, sent } = harness(async (spec) => {
    runs.push(spec);
    return { outcome: 'completed', processedEntries: 1 };
  });
  manager.start({
    sourceSessionId: 's',
    spec: { operation: 'move', sources: ['/real/proj/a.txt'], destDir: '/real/proj/out' },
    requestedSpec: { operation: 'move', sources: ['/alias/proj/a.txt'], destDir: '/alias/proj/out' },
  } as Parameters<FileJobManager['start']>[0]);
  await until(() => doneOf(sent).length === 1, 'done');
  assert.deepEqual(runs[0].sources, ['/real/proj/a.txt']);
  assert.equal(runs[0].destDir, '/real/proj/out');
  assert.deepEqual([...(doneOf(sent)[0].affectedDirectories as string[])].sort(), ['/alias/proj', '/alias/proj/out']);
});

// @req SEC-FOP-001
test('관리자는 blocked 판정(isPathBlocked)을 러너에 넘긴다', async () => {
  const seen: FileJobRunnerDeps[] = [];
  const isPathBlocked = (p: string): boolean => p.includes('.ssh');
  const { manager, sent } = harness(
    async (_spec, deps) => {
      seen.push(deps);
      return { outcome: 'completed', processedEntries: 0 };
    },
    { isPathBlocked } as Partial<FileJobManagerDeps>,
  );
  manager.start({ sourceSessionId: 's', spec: { operation: 'delete', sources: ['/a'] } });
  await until(() => doneOf(sent).length === 1, 'done');
  const passed = (seen[0] as { isBlocked?: (p: string) => boolean }).isBlocked;
  assert.equal(typeof passed, 'function', '러너 deps 에 isBlocked 가 없다');
  assert.equal(passed?.('/x/.ssh/id'), true);
  assert.equal(passed?.('/x/ok'), false);
});

// RCK-002: 링크·blocked 거부(선택지 [skip])에 applyToAll 로 고른 skip 이 종류(kind: error)만으로 기억되어, 뒤의 fs 오류
// (ENOSPC·EACCES)까지 묻지 않고 건너뛰었다 — 작업은 completed 로 끝나 파일이 빠진 것이 보이지 않는다.
// @req FR-FOP-004
test('거부 질문(선택지 skip 뿐)에 applyToAll=true 로 고른 skip 은 뒤의 fs 오류 질문(retry·skip)에 적용되지 않는다', async () => {
  const answers: string[] = [];
  const questions = [
    { kind: 'error' as const, path: '/a/link', choices: ['skip'] as const, detail: 'link target is outside the session folder' },
    { kind: 'error' as const, path: '/a/big.bin', choices: ['retry', 'skip'] as const, detail: 'ENOSPC' },
    { kind: 'error' as const, path: '/a/link2', choices: ['skip'] as const, detail: 'link target is blocked' },
  ];
  const { manager, sent } = harness(async (_spec, deps) => {
    for (const q of questions) {
      deps.onStateChange?.('awaiting-decision');
      answers.push((await deps.decide(q)).choice);
      deps.onStateChange?.('running');
    }
    return { outcome: 'completed', processedEntries: 3 };
  });
  const { jobId } = manager.start({ sourceSessionId: 's', spec: { operation: 'copy', sources: ['/a'], destDir: '/b' } });
  const asked = (): Record<string, unknown>[] => sent.filter((s) => s.event === 'file-job:decision-required').map((s) => s.payload);
  await until(() => asked().length === 1, 'first question');
  manager.decide(jobId, { decisionId: String(asked()[0].decisionId), choice: 'skip', applyToAll: true });
  await until(() => asked().length === 2 || answers.length >= 2, 'fs error question');
  assert.equal(asked().length, 2, `거부에 고른 "모두 건너뛰기" 가 fs 오류(ENOSPC)를 묻지 않고 건너뛰었다: ${JSON.stringify(answers)}`);
  assert.equal(asked()[1].detail, 'ENOSPC');
  manager.decide(jobId, { decisionId: String(asked()[1].decisionId), choice: 'skip', applyToAll: true });
  // 같은 부류(거부)의 뒤 질문에는 기억한 skip 이 여전히 적용된다 — 기억 자체를 없앤 것이 아니다.
  await until(() => doneOf(sent).length === 1, 'done');
  assert.equal(asked().length, 2, '거부 질문에 기억한 skip 이 다음 거부 질문에 적용되지 않았다');
  assert.deepEqual(answers, ['skip', 'skip', 'skip']);
});

// @req FR-FOP-004
test('fs 오류 질문에 applyToAll=true 로 고른 skip 도 기억하지 않는다 — 다음 fs 오류는 다시 묻는다', async () => {
  const answers: string[] = [];
  const { manager, sent } = harness(async (_spec, deps) => {
    for (const detail of ['EACCES', 'ENOSPC']) {
      deps.onStateChange?.('awaiting-decision');
      answers.push((await deps.decide({ kind: 'error', path: `/a/${detail}`, choices: ['retry', 'skip'], detail })).choice);
      deps.onStateChange?.('running');
    }
    return { outcome: 'completed', processedEntries: 2 };
  });
  const { jobId } = manager.start({ sourceSessionId: 's', spec: { operation: 'delete', sources: ['/a'] } });
  const asked = (): Record<string, unknown>[] => sent.filter((s) => s.event === 'file-job:decision-required').map((s) => s.payload);
  await until(() => asked().length === 1, 'first question');
  manager.decide(jobId, { decisionId: String(asked()[0].decisionId), choice: 'skip', applyToAll: true });
  await until(() => asked().length === 2 || answers.length === 2, 'second question');
  assert.equal(asked().length, 2, 'fs 오류에 고른 skip 을 기억해 다른 오류를 묻지 않고 건너뛰었다');
  manager.decide(jobId, { decisionId: String(asked()[1].decisionId), choice: 'skip' });
  await until(() => doneOf(sent).length === 1, 'done');
});

// RCK-007: 러너는 검증된(실제) 경로로 돈다. 질문과 진행의 경로가 junction 대상·'/private/tmp'·UNC 모양으로 나가면
// 받는 쪽이 affectedDirectories(요청한 모양)와 맞춰 행을 찾지 못한다. 요청한 접두사로 되돌려 보낸다.
// @req IR-FOP-002
// @req FR-FOP-003
test('decision-required.path 와 progress.currentPath 는 검증된 접두사를 요청한 접두사로 바꿔 보낸다', async () => {
  const validatedSrc = join('/', 'real', 'proj', 'a');
  const requestedSrc = join('/', 'alias', 'proj', 'a');
  const validatedDest = join('/', 'real', 'proj', 'out');
  const requestedDest = join('/', 'alias', 'proj', 'out');
  const { manager, sent } = harness(async (_spec, deps) => {
    deps.onProgress({ phase: 'scanning', processedBytes: 0, totalBytes: 0, processedEntries: 0, totalEntries: 1, currentPath: join(validatedSrc, 'x.txt') });
    deps.onProgress({ phase: 'transferring', processedBytes: 0, totalBytes: 0, processedEntries: 0, totalEntries: 1, currentPath: validatedSrc });
    deps.onStateChange?.('awaiting-decision');
    await deps.decide({ kind: 'conflict', path: join(validatedDest, 'a', 'x.txt'), choices: ['overwrite', 'rename', 'skip'] });
    deps.onStateChange?.('running');
    deps.onStateChange?.('awaiting-decision');
    await deps.decide({ kind: 'error', path: join(validatedSrc, 'y.txt'), choices: ['retry', 'skip'], detail: 'EBUSY' });
    deps.onStateChange?.('running');
    // 어느 접두사에도 들지 않는 경로는 그대로 보낸다. 이름이 접두사로 시작할 뿐인 형제도 바꾸지 않는다.
    deps.onProgress({ phase: 'transferring', processedBytes: 0, totalBytes: 0, processedEntries: 1, totalEntries: 1, currentPath: join('/', 'real', 'proj', 'ab') });
    return { outcome: 'completed', processedEntries: 1 };
    // 진행 보고가 간격 제한에 묶여 버려지지 않게 시계를 부를 때마다 1초씩 앞으로 보낸다.
  }, { clock: { now: (() => { let t = 0; return () => (t += 1000); })() } });
  const { jobId } = manager.start({
    sourceSessionId: 's',
    spec: { operation: 'copy', sources: [validatedSrc], destDir: validatedDest },
    requestedSpec: { operation: 'copy', sources: [requestedSrc], destDir: requestedDest },
  });
  const asked = (): Record<string, unknown>[] => sent.filter((s) => s.event === 'file-job:decision-required').map((s) => s.payload);
  await until(() => asked().length === 1, 'conflict');
  assert.equal(asked()[0].path, join(requestedDest, 'a', 'x.txt'));
  manager.decide(jobId, { decisionId: String(asked()[0].decisionId), choice: 'skip' });
  await until(() => asked().length === 2, 'error');
  assert.equal(asked()[1].path, join(requestedSrc, 'y.txt'));
  manager.decide(jobId, { decisionId: String(asked()[1].decisionId), choice: 'skip' });
  await until(() => doneOf(sent).length === 1, 'done');
  const paths = sent.filter((s) => s.event === 'file-job:progress').map((s) => s.payload.currentPath);
  assert.ok(paths.includes(join(requestedSrc, 'x.txt')), `진행 경로가 요청한 모양이 아니다: ${JSON.stringify(paths)}`);
  assert.ok(paths.includes(requestedSrc), `진행 경로가 요청한 모양이 아니다: ${JSON.stringify(paths)}`);
  assert.ok(
    !paths.some((p) => typeof p === 'string' && (p === validatedSrc || p.startsWith(validatedSrc + sep))),
    `검증된 경로가 그대로 나갔다: ${JSON.stringify(paths)}`,
  );
  assert.equal(paths[paths.length - 1], join('/', 'real', 'proj', 'ab'));
});
