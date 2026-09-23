/**
 * IR-FOP-001 · IR-FOP-002 AC-6 · SEC-FOP-001 AC-1 · FR-FOP-003 AC-3 · FR-FOP-005 AC-5 —
 * 파일 조작 작업의 REST 진입점.
 *
 * 관리자는 가짜가 아니라 실제 FileJobManager 다. 스파이 관리자로는 "보존 기록이 있는 끝난
 * 작업(ignored)" 과 "기록이 없는 작업(404)" 을 구별할 수 없고, 대기 중 결정의 재전송이
 * 원래와 같은 decisionId 를 쓰는지도 볼 수 없다. 대신 러너(runJob)·broadcast·시계·타이머만
 * 가짜로 주입한다 — 러너가 가짜라 파일은 건드리지 않는다.
 *
 * 경로 검증은 두 세션을 서로 다른 임시 디렉터리 cwd 에 두고 양방향으로 시험한다. 한쪽 방향만
 * 보면 "모든 경로를 한 세션 기준으로 검사하는" 구현도 통과한다.
 *
 * 서버는 withLocalHttpServer 의 named pipe / Unix socket 위에서만 뜬다 — TCP 포트를 열지 않으므로
 * 운영 중인 2001/2002 와 검증용 2222 어느 것에도 닿지 않는다.
 *
 * 구현 모듈은 테스트 본문 안에서 동적으로 불러온다. 모듈이 없을 때 파일 전체가 한 번에 죽지 않고
 * 케이스마다 이름을 달고 실패하게 하려는 것이다.
 *
 * server/src/test-runner.ts 는 *.test.ts 를 찾지 않으므로 이 파일은 node:test 로 따로 돌린다.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import express from 'express';
import { withLocalHttpServer, type LocalHttpTestFixture } from '../testing/localHttpTestServer.js';
import {
  FileJobManager,
  type FileJobEvent,
} from '../services/fileJobs/fileJobManager.js';
import type { FileJobFsOps } from '../services/fileJobs/fileJobFsOps.js';
import {
  FILE_JOB_CONFLICT_CHOICES,
  type FileJobResult,
  type FileJobRunnerDeps,
  type FileJobSpec,
} from '../services/fileJobs/fileJobRunner.js';
import { AppError, ErrorCode } from '../utils/errors.js';
import type { FileJobPathPolicy } from '../services/fileJobs/fileJobPaths.js';

const SESSION_A = 'session-a';
const SESSION_B = 'session-b';
const BLOCKED_SEGMENT = 'blocked-dir';

type RunBehavior = (spec: FileJobSpec, deps: FileJobRunnerDeps) => Promise<FileJobResult>;

interface Broadcast {
  sessionId: string;
  event: FileJobEvent;
  payload: Record<string, unknown>;
}

interface JsonResponse {
  status: number;
  body: any;
}

interface Harness {
  cwdA: string;
  cwdB: string;
  manager: FileJobManager;
  runCalls: { spec: FileJobSpec; deps: FileJobRunnerDeps }[];
  broadcasts: Broadcast[];
  /** 다음 러너 호출부터 적용된다. */
  setBehavior(behavior: RunBehavior): void;
  router: any;
  call(method: string, urlPath: string, body?: unknown): Promise<JsonResponse>;
}

async function loadModules(): Promise<{
  createFileJobRoutes: (manager: FileJobManager, pathPolicy: FileJobPathPolicy) => any;
  validateSessionPath: (policy: FileJobPathPolicy, sessionId: string, p: string) => Promise<string>;
}> {
  const routes = await import('./fileJobRoutes.js');
  const paths = await import('../services/fileJobs/fileJobPaths.js');
  return { createFileJobRoutes: routes.createFileJobRoutes, validateSessionPath: paths.validateSessionPath };
}

/** 취소 신호가 올 때까지 끝나지 않는 러너 — 진행 중인 작업을 흉내 낸다. */
const holdUntilAborted: RunBehavior = (_spec, deps) =>
  new Promise((resolve) => {
    const done = () => resolve({ outcome: 'cancelled', processedEntries: 0 });
    if (deps.signal?.aborted) return done();
    deps.signal?.addEventListener('abort', done, { once: true });
  });

async function realTempDir(prefix: string): Promise<string> {
  // realpath 로 정규화한다 — resolveAndValidate 가 기존 경로를 realpath 로 바꿔 비교하므로,
  // 8.3 이름·심볼릭 링크가 섞인 tmpdir 이면 정상 경로도 cwd 밖으로 판정될 수 있다.
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}

async function withHarness(
  options: { blockedPaths?: string[] },
  run: (h: Harness) => Promise<void>,
): Promise<void> {
  const { createFileJobRoutes, validateSessionPath } = await loadModules();
  const cwdA = await realTempDir('fjr-a-');
  const cwdB = await realTempDir('fjr-b-');
  try {
    await fs.writeFile(path.join(cwdA, 'f.txt'), 'a');
    await fs.writeFile(path.join(cwdB, 'f.txt'), 'b');
    await fs.mkdir(path.join(cwdA, 'sub'));
    await fs.mkdir(path.join(cwdB, 'sub'));
    await fs.mkdir(path.join(cwdA, BLOCKED_SEGMENT));
    await fs.writeFile(path.join(cwdA, BLOCKED_SEGMENT, 'f.txt'), 'x');
    await fs.mkdir(path.join(cwdB, BLOCKED_SEGMENT));

    const cwds = new Map([[SESSION_A, cwdA], [SESSION_B, cwdB]]);
    const pathPolicy = {
      async getCwd(sessionId: string): Promise<string> {
        const cwd = cwds.get(sessionId);
        if (!cwd) throw new AppError(ErrorCode.SESSION_NOT_FOUND);
        return cwd;
      },
      blockedPaths: options.blockedPaths ?? [],
    };

    const runCalls: Harness['runCalls'] = [];
    const broadcasts: Broadcast[] = [];
    let behavior: RunBehavior = holdUntilAborted;
    const manager = new FileJobManager({
      runJob: (spec, deps) => {
        runCalls.push({ spec, deps });
        return behavior(spec, deps);
      },
      // 러너가 가짜라 파일 연산은 불리지 않는다.
      fsOps: {} as FileJobFsOps,
      broadcast: (sessionId, event, payload) => broadcasts.push({ sessionId, event, payload }),
      clock: { now: () => 0 },
      // 불리지 않는 타이머 — 끝난 작업의 보존 기록이 테스트 도중 지워지지 않게 한다.
      timers: { setTimeout: () => ({}), clearTimeout: () => {} },
      validatePathFor: (sessionId) => async (p) => {
        await validateSessionPath(pathPolicy, sessionId, p);
      },
    });

    const router = createFileJobRoutes(manager, pathPolicy);
    const app = express();
    app.use(express.json());
    app.use('/api/file-jobs', router);

    try {
      await withLocalHttpServer(app, async (fixture: LocalHttpTestFixture) => {
        await run({
          cwdA,
          cwdB,
          manager,
          runCalls,
          broadcasts,
          setBehavior: (b) => { behavior = b; },
          router,
          async call(method, urlPath, body) {
            const response = await fixture.request({
              method,
              path: urlPath,
              headers: body === undefined ? {} : { 'content-type': 'application/json' },
              body: body === undefined ? undefined : JSON.stringify(body),
            });
            let parsed: any = null;
            try { parsed = response.body ? JSON.parse(response.body) : null; } catch { parsed = response.body; }
            return { status: response.statusCode, body: parsed };
          },
        });
      });
    } finally {
      manager.dispose();
    }
  } finally {
    await fs.rm(cwdA, { recursive: true, force: true });
    await fs.rm(cwdB, { recursive: true, force: true });
  }
}

/**
 * 관리자의 비동기 경로(러너 결과 반영 등)가 끝날 때까지 이벤트 루프를 돌린다.
 *
 * 실시간 기한으로 기다린다 — 경로 검증이 실제 fs.realpath 호출을 거치므로 필요한
 * 이벤트 루프 턴 수가 고정돼 있지 않다. 고정 틱 횟수는 그 호출들이 몇 턴을 쓰느냐에
 * 따라 흔들린다.
 */
async function waitFor(predicate: () => boolean, label: string, deadlineMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail(`timed out waiting for: ${label} (${Date.now() - start}ms)`);
}

function assertError(res: JsonResponse, status: number, code: string, message: RegExp): void {
  assert.equal(res.status, status, `status for ${code}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body?.error?.code, code, JSON.stringify(res.body));
  assert.match(String(res.body?.error?.message), message);
}

/** 대기 중 결정을 하나 만들고 그 질문에 받은 답을 answers 에 쌓는 러너. */
function askingRunner(answers: string[], questions = 1): RunBehavior {
  return async (spec, deps) => {
    for (let i = 0; i < questions; i++) {
      deps.onStateChange?.('awaiting-decision');
      const answer = await deps.decide({
        kind: 'conflict',
        path: path.join(spec.destDir ?? path.dirname(spec.sources[0]), `q${i}.txt`),
        choices: FILE_JOB_CONFLICT_CHOICES,
      });
      answers.push(answer.choice);
      deps.onStateChange?.('running');
    }
    return holdUntilAborted(spec, deps);
  };
}

test('POST /api/file-jobs 가 operation·sourceSessionId·sources 를 받아 jobId 를 돌려준다', async () => {
  await withHarness({}, async (h) => {
    const source = path.join(h.cwdA, 'f.txt');
    const res = await h.call('POST', '/api/file-jobs', {
      operation: 'delete',
      sourceSessionId: SESSION_A,
      sources: [source],
    });
    assert.equal(res.status, 202, JSON.stringify(res.body));
    assert.equal(typeof res.body.jobId, 'string');
    assert.ok(res.body.jobId.length > 0);

    await waitFor(() => h.runCalls.length === 1, 'runner invoked');
    assert.deepEqual(h.runCalls[0].spec.operation, 'delete');
    assert.deepEqual(h.runCalls[0].spec.sources, [source]);
    const listed = h.manager.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].jobId, res.body.jobId);
    assert.equal(listed[0].sourceSessionId, SESSION_A);
    // 목적지 세션을 주지 않으면 출발지 세션이다.
    assert.equal(listed[0].destSessionId, SESSION_A);

    // 필수 필드 누락·모르는 operation 은 작업을 만들지 않고 400.
    assertError(await h.call('POST', '/api/file-jobs', { operation: 'delete', sources: [source] }),
      400, 'INVALID_INPUT', /sourceSessionId/);
    assertError(await h.call('POST', '/api/file-jobs', { operation: 'delete', sourceSessionId: SESSION_A }),
      400, 'INVALID_INPUT', /sources/);
    assertError(await h.call('POST', '/api/file-jobs', { operation: 'delete', sourceSessionId: SESSION_A, sources: [] }),
      400, 'INVALID_INPUT', /sources/);
    assertError(await h.call('POST', '/api/file-jobs', { operation: 'rename', sourceSessionId: SESSION_A, sources: [source] }),
      400, 'INVALID_INPUT', /operation/);
    assertError(await h.call('POST', '/api/file-jobs', { operation: 'copy', sourceSessionId: SESSION_A, sources: [source] }),
      400, 'INVALID_INPUT', /destPath/);
    assert.equal(h.runCalls.length, 1, 'rejected requests must not start jobs');

    // 폐기된 관리자는 새 작업을 받지 않는다 — 서버 종료 중이라 다시 시도할 수 있는 상태다.
    h.manager.dispose();
    assertError(await h.call('POST', '/api/file-jobs', { operation: 'delete', sourceSessionId: SESSION_A, sources: [source] }),
      503, 'MANAGER_DISPOSED', /disposed/);
  });
});

test('destSessionId·destPath 를 sourceSessionId 와 별개로 받아 매니저에 그대로 넘긴다', async () => {
  await withHarness({}, async (h) => {
    const source = path.join(h.cwdA, 'f.txt');
    const destPath = path.join(h.cwdB, 'sub');
    const res = await h.call('POST', '/api/file-jobs', {
      operation: 'copy',
      sourceSessionId: SESSION_A,
      sources: [source],
      destSessionId: SESSION_B,
      destPath,
    });
    assert.equal(res.status, 202, JSON.stringify(res.body));
    await waitFor(() => h.runCalls.length === 1, 'runner invoked');
    // 받은 문자열 그대로 — done 의 affectedDirectories 가 클라이언트가 보낸 모양과 맞아야 한다.
    assert.equal(h.runCalls[0].spec.destDir, destPath);
    assert.deepEqual(h.runCalls[0].spec.sources, [source]);
    const [job] = h.manager.list();
    assert.equal(job.jobId, res.body.jobId);
    assert.equal(job.sourceSessionId, SESSION_A);
    assert.equal(job.destSessionId, SESSION_B);
    assert.equal(job.operation, 'copy');
  });
});

test('목적지 세션 cwd 안에서만 유효한 출발지 경로는 거부된다', async () => {
  await withHarness({}, async (h) => {
    const res = await h.call('POST', '/api/file-jobs', {
      operation: 'copy',
      sourceSessionId: SESSION_A,
      sources: [path.join(h.cwdB, 'f.txt')],
      destSessionId: SESSION_B,
      destPath: path.join(h.cwdB, 'sub'),
    });
    assertError(res, 403, 'PATH_TRAVERSAL', /Path traversal detected/);
    assert.equal(h.runCalls.length, 0);
    assert.deepEqual(h.manager.list(), []);
  });
});

test('출발지 세션 cwd 안에서만 유효한 목적지 경로는 거부된다', async () => {
  await withHarness({}, async (h) => {
    const res = await h.call('POST', '/api/file-jobs', {
      operation: 'move',
      sourceSessionId: SESSION_A,
      sources: [path.join(h.cwdA, 'f.txt')],
      destSessionId: SESSION_B,
      destPath: path.join(h.cwdA, 'sub'),
    });
    assertError(res, 403, 'PATH_TRAVERSAL', /Path traversal detected/);
    assert.equal(h.runCalls.length, 0);
    assert.deepEqual(h.manager.list(), []);
  });
});

test('출발지 세션 cwd 안의 출발지와 목적지 세션 cwd 안에서만 유효한 목적지는 받아들여 jobId 를 돌려준다', async () => {
  await withHarness({}, async (h) => {
    const res = await h.call('POST', '/api/file-jobs', {
      operation: 'move',
      sourceSessionId: SESSION_A,
      sources: [path.join(h.cwdA, 'f.txt')],
      destSessionId: SESSION_B,
      destPath: path.join(h.cwdB, 'sub'),
    });
    assert.equal(res.status, 202, JSON.stringify(res.body));
    assert.equal(typeof res.body.jobId, 'string');
    await waitFor(() => h.runCalls.length === 1, 'runner invoked');
    assert.deepEqual(h.manager.list().map((j) => j.jobId), [res.body.jobId]);
  });
});

test('blocked path 에 걸린 출발지는 PATH_BLOCKED 로 거부되고 작업이 만들어지지 않는다', async () => {
  await withHarness({ blockedPaths: [BLOCKED_SEGMENT] }, async (h) => {
    const res = await h.call('POST', '/api/file-jobs', {
      operation: 'delete',
      sourceSessionId: SESSION_A,
      sources: [path.join(h.cwdA, 'f.txt'), path.join(h.cwdA, BLOCKED_SEGMENT, 'f.txt')],
    });
    assertError(res, 403, 'PATH_BLOCKED', /Access to this path is blocked/);
    assert.equal(h.runCalls.length, 0);
    assert.deepEqual(h.manager.list(), []);
    const listed = await h.call('GET', '/api/file-jobs');
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.jobs, []);
  });
});

test('blocked path 에 걸린 목적지도 PATH_BLOCKED 로 거부된다', async () => {
  await withHarness({ blockedPaths: [BLOCKED_SEGMENT] }, async (h) => {
    const res = await h.call('POST', '/api/file-jobs', {
      operation: 'copy',
      sourceSessionId: SESSION_A,
      sources: [path.join(h.cwdA, 'f.txt')],
      destSessionId: SESSION_B,
      destPath: path.join(h.cwdB, BLOCKED_SEGMENT),
    });
    assertError(res, 403, 'PATH_BLOCKED', /Access to this path is blocked/);
    assert.equal(h.runCalls.length, 0);
    assert.deepEqual(h.manager.list(), []);
  });
});

test('POST /api/file-jobs/:jobId/decision 이 decisionId·choice·applyToAll 을 받아 매니저에 전달하고 누락 시 400 이다', async () => {
  await withHarness({}, async (h) => {
    const answers: string[] = [];
    h.setBehavior(askingRunner(answers, 3));
    const started = await h.call('POST', '/api/file-jobs', {
      operation: 'copy',
      sourceSessionId: SESSION_A,
      sources: [path.join(h.cwdA, 'f.txt')],
      destPath: path.join(h.cwdA, 'sub'),
    });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const jobId: string = started.body.jobId;
    await waitFor(() => h.broadcasts.some((b) => b.event === 'file-job:decision-required'), 'decision-required');
    const decisionId = h.broadcasts.find((b) => b.event === 'file-job:decision-required')!.payload.decisionId as string;
    const url = `/api/file-jobs/${encodeURIComponent(jobId)}/decision`;

    // 누락은 관리자에 닿기 전에 400 이고, 질문은 살아 있다.
    assertError(await h.call('POST', url, { choice: 'rename' }), 400, 'INVALID_INPUT', /decisionId/);
    assertError(await h.call('POST', url, { decisionId }), 400, 'INVALID_INPUT', /choice/);
    assertError(await h.call('POST', url, { decisionId, choice: 'rename', applyToAll: 'yes' }),
      400, 'INVALID_INPUT', /applyToAll/);

    // 관리자 오류 코드 → 상태 코드.
    assertError(await h.call('POST', '/api/file-jobs/no-such-job/decision', { decisionId, choice: 'rename' }),
      404, 'JOB_NOT_FOUND', /File job not found: no-such-job/);
    assertError(await h.call('POST', url, { decisionId: 'stale-decision', choice: 'rename' }),
      409, 'DECISION_MISMATCH', /Decision does not match the pending one/);
    assertError(await h.call('POST', url, { decisionId, choice: 'bogus' }),
      400, 'INVALID_CHOICE', /Unknown decision choice: bogus/);
    assert.deepEqual(answers, [], 'rejected answers must not reach the runner');

    // applyToAll 을 주지 않은 답은 그 질문에만 적용된다 — 다음 질문은 다시 물어야 한다.
    // 이 단계가 없으면 applyToAll 을 늘 true 로 넘기는 라우트도 통과한다.
    const first = await h.call('POST', url, { decisionId, choice: 'skip' });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    await waitFor(() => h.broadcasts.filter((b) => b.event === 'file-job:decision-required').length === 2,
      'second question asked');
    assert.deepEqual(answers, ['skip']);
    const decisionId2 = h.broadcasts.filter((b) => b.event === 'file-job:decision-required')[1].payload.decisionId as string;
    assert.notEqual(decisionId2, decisionId);

    const ok = await h.call('POST', url, { decisionId: decisionId2, choice: 'rename', applyToAll: true });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    // applyToAll 이 관리자에 닿았다면 세 번째 질문은 묻지 않고 같은 답으로 풀린다.
    await waitFor(() => answers.length === 3, 'third question auto-answered');
    assert.deepEqual(answers, ['skip', 'rename', 'rename']);
    assert.equal(h.broadcasts.filter((b) => b.event === 'file-job:decision-required').length, 2,
      'applyToAll must suppress the third question');

    // 대기 중이 아닌 작업에 온 답.
    assertError(await h.call('POST', url, { decisionId: decisionId2, choice: 'rename' }),
      409, 'JOB_NOT_AWAITING', /File job is not awaiting a decision/);
  });
});

test('DELETE /api/file-jobs/:jobId 가 진행 중인 작업을 취소한다', async () => {
  await withHarness({}, async (h) => {
    const started = await h.call('POST', '/api/file-jobs', {
      operation: 'delete',
      sourceSessionId: SESSION_A,
      sources: [path.join(h.cwdA, 'f.txt')],
    });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    await waitFor(() => h.runCalls.length === 1, 'runner invoked');
    const signal = h.runCalls[0].deps.signal!;
    assert.equal(signal.aborted, false);

    const res = await h.call('DELETE', `/api/file-jobs/${encodeURIComponent(started.body.jobId)}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body, { outcome: 'cancelled' });
    assert.equal(signal.aborted, true, 'the runner must see the abort');
    await waitFor(() => h.manager.list().length === 0, 'cancelled job leaves the live list');

    assertError(await h.call('DELETE', '/api/file-jobs/no-such-job'),
      404, 'JOB_NOT_FOUND', /File job not found: no-such-job/);
  });
});

test("실제 매니저에서 원자적 같은 장치 이동이 끝난 뒤 DELETE 가 404 가 아니라 200 {outcome:'ignored', atomic:true} 를 돌려준다", async () => {
  await withHarness({}, async (h) => {
    h.setBehavior(async () => ({ outcome: 'completed', processedEntries: 1, atomic: true }));
    const moved = await h.call('POST', '/api/file-jobs', {
      operation: 'move',
      sourceSessionId: SESSION_A,
      sources: [path.join(h.cwdA, 'f.txt')],
      destPath: path.join(h.cwdA, 'sub'),
    });
    assert.equal(moved.status, 202, JSON.stringify(moved.body));
    await waitFor(() => h.broadcasts.some((b) => b.event === 'file-job:done' && b.payload.jobId === moved.body.jobId),
      'atomic move done');

    const res = await h.call('DELETE', `/api/file-jobs/${encodeURIComponent(moved.body.jobId)}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body, { outcome: 'ignored', atomic: true });

    // 원자적이지 않게 끝난 작업에는 atomic 을 싣지 않는다 — 클라이언트가 "원자적이었다" 를 잘못 보고하지 않게.
    h.setBehavior(async () => ({ outcome: 'completed', processedEntries: 1 }));
    const copied = await h.call('POST', '/api/file-jobs', {
      operation: 'copy',
      sourceSessionId: SESSION_A,
      sources: [path.join(h.cwdA, 'f.txt')],
      destPath: path.join(h.cwdA, 'sub'),
    });
    assert.equal(copied.status, 202, JSON.stringify(copied.body));
    await waitFor(() => h.broadcasts.some((b) => b.event === 'file-job:done' && b.payload.jobId === copied.body.jobId),
      'copy done');
    const res2 = await h.call('DELETE', `/api/file-jobs/${encodeURIComponent(copied.body.jobId)}`);
    assert.equal(res2.status, 200, JSON.stringify(res2.body));
    assert.deepEqual(res2.body, { outcome: 'ignored' });
  });
});

test('GET /api/file-jobs 는 비종료 작업만 돌려준다', async () => {
  await withHarness({}, async (h) => {
    h.setBehavior(async () => ({ outcome: 'completed', processedEntries: 1 }));
    const finished = await h.call('POST', '/api/file-jobs', {
      operation: 'delete',
      sourceSessionId: SESSION_A,
      sources: [path.join(h.cwdA, 'f.txt')],
    });
    assert.equal(finished.status, 202, JSON.stringify(finished.body));
    await waitFor(() => h.broadcasts.some((b) => b.event === 'file-job:done'), 'first job done');

    h.setBehavior(holdUntilAborted);
    const live = await h.call('POST', '/api/file-jobs', {
      operation: 'copy',
      sourceSessionId: SESSION_A,
      sources: [path.join(h.cwdA, 'f.txt')],
      destSessionId: SESSION_B,
      destPath: path.join(h.cwdB, 'sub'),
    });
    assert.equal(live.status, 202, JSON.stringify(live.body));

    const res = await h.call('GET', '/api/file-jobs');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(Array.isArray(res.body.jobs), JSON.stringify(res.body));
    assert.deepEqual(res.body.jobs.map((j: any) => j.jobId), [live.body.jobId]);
    const [job] = res.body.jobs;
    assert.equal(job.sourceSessionId, SESSION_A);
    assert.equal(job.destSessionId, SESSION_B);
    assert.equal(job.operation, 'copy');
    assert.equal(job.state, 'running');
    assert.equal(job.pendingDecision, null);

    // sessionId 로 거르면 그 세션에 매인(출발지 또는 목적지) 작업만.
    const forB = await h.call('GET', `/api/file-jobs?sessionId=${SESSION_B}`);
    assert.deepEqual(forB.body.jobs.map((j: any) => j.jobId), [live.body.jobId]);
    const forOther = await h.call('GET', '/api/file-jobs?sessionId=session-c');
    assert.deepEqual(forOther.body.jobs, []);
  });
});

test('실제 매니저에서 결정 대기 중 GET /api/file-jobs 를 부르면 같은 decisionId 의 file-job:decision-required 가 다시 broadcast 되고 응답의 그 작업에 pendingDecision 이 인라인으로 실린다', async () => {
  await withHarness({}, async (h) => {
    h.setBehavior(askingRunner([], 1));
    const started = await h.call('POST', '/api/file-jobs', {
      operation: 'copy',
      sourceSessionId: SESSION_A,
      sources: [path.join(h.cwdA, 'f.txt')],
      destPath: path.join(h.cwdA, 'sub'),
    });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    await waitFor(() => h.broadcasts.some((b) => b.event === 'file-job:decision-required'), 'decision-required');
    const original = h.broadcasts.find((b) => b.event === 'file-job:decision-required')!;
    const before = h.broadcasts.length;

    const res = await h.call('GET', `/api/file-jobs?sessionId=${SESSION_A}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const resent = h.broadcasts.slice(before);
    assert.equal(resent.length, 1, `exactly one resend expected: ${JSON.stringify(resent)}`);
    assert.equal(resent[0].sessionId, SESSION_A);
    assert.equal(resent[0].event, 'file-job:decision-required');
    assert.equal(resent[0].payload.decisionId, original.payload.decisionId);
    assert.deepEqual(resent[0].payload, original.payload);

    const [job] = res.body.jobs;
    assert.equal(job.jobId, started.body.jobId);
    assert.equal(job.state, 'awaiting-decision');
    assert.deepEqual(job.pendingDecision, original.payload);
  });
});

test('라우터에 등록된 경로가 네 개뿐이고 작업별 진행 조회 경로(GET /:jobId 등)가 없다', async () => {
  await withHarness({}, async (h) => {
    const routes: string[] = [];
    for (const layer of h.router.stack as any[]) {
      if (!layer.route) continue;
      for (const method of Object.keys(layer.route.methods)) {
        if (layer.route.methods[method]) routes.push(`${method.toUpperCase()} ${layer.route.path}`);
      }
    }
    assert.deepEqual(routes.sort(), ['DELETE /:jobId', 'GET /', 'POST /', 'POST /:jobId/decision'].sort());

    // 폴링 경로를 두지 않는다 — 진행은 WebSocket 으로만 간다.
    const started = await h.call('POST', '/api/file-jobs', {
      operation: 'delete',
      sourceSessionId: SESSION_A,
      sources: [path.join(h.cwdA, 'f.txt')],
    });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const polled = await h.call('GET', `/api/file-jobs/${encodeURIComponent(started.body.jobId)}`);
    assert.equal(polled.status, 404);
    const progress = await h.call('GET', `/api/file-jobs/${encodeURIComponent(started.body.jobId)}/progress`);
    assert.equal(progress.status, 404);
  });
});
