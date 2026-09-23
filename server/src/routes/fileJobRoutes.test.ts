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

import test, { mock } from 'node:test';
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
  /** 세션 A 의 cwd 로 쓰인 문자열. 기본은 cwdA 이고, cwdAVia 를 주면 그것이 돌려준 경로(예: cwdA 를 가리키는 링크)다. */
  sessionCwdA: string;
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
  options: { blockedPaths?: string[]; cwdAVia?: (cwdA: string) => Promise<string> },
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

    const sessionCwdA = options.cwdAVia ? await options.cwdAVia(cwdA) : cwdA;
    const cwds = new Map([[SESSION_A, sessionCwdA], [SESSION_B, cwdB]]);
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
          sessionCwdA,
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

// ── 상대 경로 거부와 검증된 경로 전달 ─────────────────────────────────────────
//
// 검증은 세션 cwd 기준으로 경로를 풀어서 보는데, 러너가 받은 원래 문자열을 그대로 쓰면 그 문자열은
// 서버 프로세스의 cwd 기준으로 풀린다. 둘이 다른 곳을 가리키면 검증한 곳이 아닌 곳을 지운다.

// @req IR-FOP-001
// @req SEC-FOP-001
test('상대 경로(드라이브 상대·루트 상대 포함)의 출발지·목적지는 400 으로 거부되고 작업이 만들어지지 않는다', async () => {
  await withHarness({}, async (h) => {
    const absSource = path.join(h.cwdA, 'f.txt');
    const cases: Record<string, unknown>[] = [
      { operation: 'delete', sourceSessionId: SESSION_A, sources: ['f.txt'] },
      { operation: 'delete', sourceSessionId: SESSION_A, sources: [absSource, './sub'] },
      { operation: 'delete', sourceSessionId: SESSION_A, sources: ['C:f.txt'] },
      { operation: 'delete', sourceSessionId: SESSION_A, sources: ['\\f.txt'] },
      { operation: 'copy', sourceSessionId: SESSION_A, sources: [absSource], destPath: 'sub' },
      { operation: 'move', sourceSessionId: SESSION_A, sources: [absSource], destPath: 'C:sub' },
    ];
    for (const body of cases) {
      const res = await h.call('POST', '/api/file-jobs', body);
      assertError(res, 400, 'INVALID_INPUT', /absolute/);
    }
    assert.equal(h.runCalls.length, 0, '상대 경로 요청이 작업을 시작했다');
    assert.deepEqual(h.manager.list(), []);
    assert.equal(await fs.readFile(absSource, 'utf8'), 'a');
  });
});

// @req IR-FOP-001
test('isAcceptedAbsolutePath 는 win32 에서 드라이브 문자와 구분자로 시작하는 경로만, POSIX 에서 / 로 시작하는 경로만 받는다', async () => {
  const { isAcceptedAbsolutePath } = (await import('./fileJobRoutes.js')) as unknown as {
    isAcceptedAbsolutePath?: (p: string, platform: NodeJS.Platform) => boolean;
  };
  assert.equal(typeof isAcceptedAbsolutePath, 'function', 'isAcceptedAbsolutePath 가 export 되지 않았다');
  const accept = isAcceptedAbsolutePath!;
  assert.equal(accept('C:\\work\\a.txt', 'win32'), true);
  assert.equal(accept('c:/work/a.txt', 'win32'), true);
  for (const bad of ['C:a.txt', '\\a.txt', '/a.txt', 'a.txt', '.\\a.txt', '..\\a.txt', 'C:']) {
    assert.equal(accept(bad, 'win32'), false, `win32 에서 ${bad} 를 받았다`);
  }
  assert.equal(accept('/home/me/a.txt', 'linux'), true);
  for (const bad of ['a.txt', './a.txt', 'C:\\a.txt', '~/a.txt']) {
    assert.equal(accept(bad, 'linux'), false, `linux 에서 ${bad} 를 받았다`);
  }
});

// @req SEC-FOP-001
// @req IR-FOP-002
test('러너는 검증된 경로(출발지는 entry, 목적지는 실제 경로)를 받고, done 의 affectedDirectories 는 받은 문자열 모양이다', async () => {
  await withHarness({}, async (h) => {
    h.setBehavior(async () => ({ outcome: 'completed', processedEntries: 1 }));
    // 정규화되지 않은 절대 경로: 러너는 검증한 모양(정규화된 경로)을 받는다.
    const res = await h.call('POST', '/api/file-jobs', {
      operation: 'copy',
      sourceSessionId: SESSION_A,
      sources: [path.join(h.cwdA, 'sub') + path.sep + '..' + path.sep + 'f.txt'],
      destSessionId: SESSION_B,
      destPath: path.join(h.cwdB, '.', 'sub') + path.sep,
    });
    assert.equal(res.status, 202, JSON.stringify(res.body));
    await waitFor(() => h.runCalls.length === 1, 'runner invoked');
    assert.deepEqual(h.runCalls[0].spec.sources, [path.join(h.cwdA, 'f.txt')]);
    assert.equal(h.runCalls[0].spec.destDir, path.join(h.cwdB, 'sub'));

    // 부모 사슬의 링크는 풀린 위치로, 링크 자신인 출발지는 링크 그대로 넘어간다 — 삭제가 대상이 아니라 링크를 지우게.
    const target = path.join(h.cwdA, 'sub');
    await fs.writeFile(path.join(target, 'x.txt'), 'x');
    const link = path.join(h.cwdA, 'j');
    await fs.symlink(target, link, 'junction');
    const viaLink = await h.call('POST', '/api/file-jobs', {
      operation: 'delete',
      sourceSessionId: SESSION_A,
      sources: [path.join(link, 'x.txt')],
    });
    assert.equal(viaLink.status, 202, JSON.stringify(viaLink.body));
    await waitFor(() => h.runCalls.length === 2, 'runner invoked (via link)');
    assert.deepEqual(h.runCalls[1].spec.sources, [path.join(target, 'x.txt')]);
    await waitFor(
      () => h.broadcasts.some((b) => b.event === 'file-job:done' && b.payload.jobId === viaLink.body.jobId),
      'done via link',
    );
    const done = h.broadcasts.find((b) => b.event === 'file-job:done' && b.payload.jobId === viaLink.body.jobId);
    assert.deepEqual(done?.payload.affectedDirectories, [link]);

    const linkItself = await h.call('POST', '/api/file-jobs', {
      operation: 'delete',
      sourceSessionId: SESSION_A,
      sources: [link],
    });
    assert.equal(linkItself.status, 202, JSON.stringify(linkItself.body));
    await waitFor(() => h.runCalls.length === 3, 'runner invoked (link itself)');
    assert.deepEqual(h.runCalls[2].spec.sources, [link], '링크 자신 대신 링크 대상을 넘겼다');
  });
});

// RCK-001: 세션 루트 자신을 지우거나 옮기는 요청은 뜻한 것일 수 없다(세션이 선 폴더가 사라진다). 게다가 cwd 가
// 링크면 검증기가 돌려준 경로가 링크 대상이라 대상 트리가 통째로 지워졌다. 라우트에서 받지 않는다.
// @req SEC-FOP-001
// @req IR-FOP-001
test('delete·move 의 출발지가 세션 루트 자신이면 400 으로 거부되고 작업이 만들어지지 않는다 — copy 는 받는다', async () => {
  await withHarness({}, async (h) => {
    for (const source of [h.cwdA, h.cwdA + path.sep, path.join(h.cwdA, 'sub', '..')]) {
      const del = await h.call('POST', '/api/file-jobs', { operation: 'delete', sourceSessionId: SESSION_A, sources: [source] });
      assertError(del, 400, 'INVALID_INPUT', /session/);
      const mv = await h.call('POST', '/api/file-jobs', {
        operation: 'move', sourceSessionId: SESSION_A, sources: [source], destSessionId: SESSION_B, destPath: h.cwdB,
      });
      assertError(mv, 400, 'INVALID_INPUT', /session/);
    }
    assert.equal(h.runCalls.length, 0, '세션 루트를 지우거나 옮기는 작업이 시작됐다');
    assert.deepEqual(h.manager.list(), []);
    // 대조군: 세션 루트를 다른 세션으로 복사하는 것은 막지 않는다. 루트 아래의 항목 삭제도 받는다.
    const copy = await h.call('POST', '/api/file-jobs', {
      operation: 'copy', sourceSessionId: SESSION_A, sources: [h.cwdA], destSessionId: SESSION_B, destPath: h.cwdB,
    });
    assert.equal(copy.status, 202, JSON.stringify(copy.body));
    const child = await h.call('POST', '/api/file-jobs', { operation: 'delete', sourceSessionId: SESSION_A, sources: [path.join(h.cwdA, 'f.txt')] });
    assert.equal(child.status, 202, JSON.stringify(child.body));
  });
});

// @req SEC-FOP-001
test('세션 cwd 가 링크(junction)일 때 그 cwd 를 지우는 요청은 거부되고 대상 트리의 파일은 남는다', async () => {
  let linkPath = '';
  await withHarness(
    {
      cwdAVia: async (cwdA) => {
        linkPath = `${cwdA}-link`;
        await fs.symlink(cwdA, linkPath, 'junction');
        return linkPath;
      },
    },
    async (h) => {
      try {
        const res = await h.call('POST', '/api/file-jobs', { operation: 'delete', sourceSessionId: SESSION_A, sources: [h.sessionCwdA] });
        assertError(res, 400, 'INVALID_INPUT', /session/);
        // 실제 경로 철자는 문자열로 링크 cwd 밖이라 경로 검증이 먼저 거부한다 — 어느 철자로도 작업이 생기지 않는다.
        const real = await h.call('POST', '/api/file-jobs', { operation: 'delete', sourceSessionId: SESSION_A, sources: [h.cwdA] });
        assertError(real, 403, 'PATH_TRAVERSAL', /traversal/i);
        assert.equal(h.runCalls.length, 0);
        assert.equal(await fs.readFile(path.join(h.cwdA, 'f.txt'), 'utf8'), 'a');
      } finally {
        await fs.rm(linkPath, { force: true, recursive: false }).catch(() => fs.rmdir(linkPath).catch(() => {}));
      }
    },
  );
});

// RC2-001: 라우트가 세션 루트의 출발지로 링크 자신(<실제 부모>/<이름>)을 넘기자, 운영 배선의 출발지 검증(captureSessionRoot
// 로 realpath 에 고정한 루트 기준)이 그 문자열을 "루트 밖" 으로 거부했다. 위 하네스는 루트를 고정하지 않고 러너도 가짜라
// 202 만 보고 초록이었다 — 여기서는 index.ts 와 같은 모양의 validatePathFor 와 실제 러너로 작업이 끝나는지까지 본다.
// @req FR-FOP-001
// @req SEC-FOP-001
test('세션 cwd 가 링크(junction)여도 세션 루트를 복사하는 작업은 운영 배선(고정한 실제 루트) 아래에서 완료된다', async () => {
  const { createFileJobRoutes } = await loadModules();
  const paths = await import('../services/fileJobs/fileJobPaths.js');
  const { runJob } = await import('../services/fileJobs/fileJobRunner.js');
  const { nodeFileJobFsOps } = await import('../services/fileJobs/fileJobFsOps.js');
  const target = await realTempDir('fjr-rootcopy-a-');
  const cwdB = await realTempDir('fjr-rootcopy-b-');
  const link = `${target}-link`;
  try {
    await fs.writeFile(path.join(target, 'f.txt'), 'a');
    await fs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    const cwds = new Map([[SESSION_A, link], [SESSION_B, cwdB]]);
    const policy: FileJobPathPolicy = {
      async getCwd(sessionId: string): Promise<string> {
        const cwd = cwds.get(sessionId);
        if (!cwd) throw new AppError(ErrorCode.SESSION_NOT_FOUND);
        return cwd;
      },
      blockedPaths: [],
    };
    const broadcasts: Broadcast[] = [];
    const manager = new FileJobManager({
      runJob,
      fsOps: nodeFileJobFsOps,
      broadcast: (sessionId, event, payload) => broadcasts.push({ sessionId, event, payload }),
      clock: { now: () => Date.now() },
      timers: { setTimeout: () => ({}), clearTimeout: () => {} },
      // index.ts 의 validatePathFor 와 같은 모양 — 작업을 받을 때 루트를 실제 경로로 한 번 고정한다.
      validatePathFor: (sessionId) => {
        const root = paths.captureSessionRoot(policy, sessionId);
        return async (p) => {
          await paths.validateCreatePath(policy, sessionId, p, { root });
        };
      },
    });
    const app = express();
    app.use(express.json());
    app.use('/api/file-jobs', createFileJobRoutes(manager, policy));
    try {
      await withLocalHttpServer(app, async (fixture: LocalHttpTestFixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: '/api/file-jobs',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ operation: 'copy', sourceSessionId: SESSION_A, sources: [link], destSessionId: SESSION_B, destPath: cwdB }),
        });
        assert.equal(response.statusCode, 202, response.body);
        await waitFor(() => broadcasts.some((b) => b.event === 'file-job:done'), 'copy done');
        const done = broadcasts.find((b) => b.event === 'file-job:done')!;
        assert.equal(done.payload.outcome, 'completed', `세션 루트 복사가 끝나지 못했다: ${JSON.stringify(done.payload)}`);
        const copied = await fs.readdir(cwdB);
        assert.equal(copied.length, 1, `목적지에 복사본이 하나여야 한다: ${copied.join(', ')}`);
        assert.equal(await fs.readFile(path.join(cwdB, copied[0], 'f.txt'), 'utf8'), 'a');
      });
    } finally {
      manager.dispose();
    }
  } finally {
    await fs.rm(link, { force: true, recursive: false }).catch(() => fs.rmdir(link).catch(() => {}));
    await fs.rm(target, { recursive: true, force: true });
    await fs.rm(cwdB, { recursive: true, force: true });
  }
});

// RC2-003: 세션 루트 판정이 cwd 를 항목으로 검증하느라 cwd 의 부모까지 realpath 했다. 부모가 통과만 허용된 디렉터리
// (Windows 에서 EPERM)면 루트 아래 모든 항목의 삭제가 403 이 됐다. 루트 판정에는 부모의 실제 위치가 필요 없다.
// @req SEC-FOP-001
// @req FR-FOP-002
test('세션 루트 판정은 cwd 의 부모를 realpath 하지 않는다 — 부모가 EPERM 이어도 루트 아래 항목 삭제는 받는다', async () => {
  await withHarness({}, async (h) => {
    const parentKey = path.dirname(h.cwdA).toLowerCase();
    const realpathCalls: string[] = [];
    const original = fs.realpath;
    const spy = mock.method(fs, 'realpath', async (p: unknown, ...rest: unknown[]) => {
      const key = path.resolve(String(p)).toLowerCase();
      realpathCalls.push(key);
      if (key === parentKey) {
        throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
      }
      return (original as (...a: unknown[]) => Promise<string>)(p, ...rest);
    });
    try {
      const res = await h.call('POST', '/api/file-jobs', { operation: 'delete', sourceSessionId: SESSION_A, sources: [path.join(h.cwdA, 'f.txt')] });
      assert.equal(res.status, 202, JSON.stringify(res.body));
      assert.equal(realpathCalls.includes(parentKey), false, 'cwd 의 부모를 realpath 했다');
    } finally {
      spy.mock.restore();
    }
  });
});

// RCK-008: 매핑된 드라이브가 UNC 로 풀리는 호스트에서 세션 cwd 가 '\\server\share\...' 이면 모든 요청이 400 이었다.
// @req IR-FOP-001
test('isAcceptedAbsolutePath 는 win32 에서 서버·공유 이름이 있는 UNC 경로를 받고, 장치 경로·불완전한 UNC 는 거부한다', async () => {
  const { isAcceptedAbsolutePath } = await import('./fileJobRoutes.js');
  for (const good of ['\\\\srv\\share\\a.txt', '\\\\srv\\share\\', '\\\\srv\\share', '//srv/share/a.txt']) {
    assert.equal(isAcceptedAbsolutePath(good, 'win32'), true, `win32 에서 UNC ${good} 를 거부했다`);
  }
  for (const bad of ['\\\\srv', '\\\\srv\\', '\\\\?\\C:\\a.txt', '\\\\.\\pipe\\x', 'C:foo', '\\foo', '\\\\\\share\\a']) {
    assert.equal(isAcceptedAbsolutePath(bad, 'win32'), false, `win32 에서 ${bad} 를 받았다`);
  }
  // POSIX 에는 UNC 가 없다.
  assert.equal(isAcceptedAbsolutePath('\\\\srv\\share\\a.txt', 'linux'), false);
});
