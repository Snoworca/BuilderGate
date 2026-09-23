// FR-FOP-003 · FR-FOP-005 — 파일 조작 작업 관리자.
//
// 러너(runJob)는 작업 하나를 끝까지 실행할 뿐 누구에게 알릴지, 얼마나 기다릴지, 끝난 뒤
// 무엇을 기억할지는 모른다. 그 셋이 이 층의 몫이다.
//
// 작업은 WebSocket 연결이 아니라 세션에 매인다. 새로고침이나 재연결로 받는 쪽이 사라져도
// 작업은 끝까지 가고, 다시 붙은 쪽은 list() 와 resendPendingDecisions() 로 따라잡는다.
//
// 자동 취소 예산은 벽시계가 아니라 awaiting-decision 에 머문 시간의 누적이다. 큰 복사는
// 몇 시간씩 돌 수 있고, 그동안 사용자가 자리를 비운 적이 없는데도 취소되면 안 된다.
// 반대로 대기마다 예산을 새로 세면 질문이 여러 번인 작업은 영원히 붙잡혀 있다.
//
// 자동 취소는 cancel(jobId) 을 그대로 부른다. 두 길이 갈라지면 "사용자가 취소했을 때와
// 다르게 끝나는 작업" 이 생기고, 그 차이는 드물게만 드러나 잡기 어렵다.
//
// 시계·타이머는 주입받는다. 10분·5분을 테스트가 실제로 기다리지 않게 하고, dispose() 가
// 남은 타이머를 전부 거둘 수 있게 하려는 것이다.
//
// applyToAll 로 고른 답은 작업 객체의 필드로만 기억한다(FR-FOP-004). 세션이나 전역에 두면
// 같은 세션에서 동시에 도는 다른 작업, 혹은 한참 뒤의 작업이 사용자가 모르는 사이에 덮어쓴다.
//
// 진행 보고는 작업마다 progressThrottle 로 줄여 보낸다(IR-FOP-002 AC-5). done 직전에 대기 값을
// 먼저 내보내 마지막 막대가 100% 에 닿게 하고, done 뒤로는 아무것도 보내지 않는다.
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import type { FileJobFsOps } from './fileJobFsOps.js';
import { createProgressThrottle, type ProgressThrottle } from './progressThrottle.js';
import type {
  FileJobConflictChoice,
  FileJobDecisionRequest,
  FileJobProgress,
  FileJobResult,
  FileJobRunnerDeps,
  FileJobSpec,
} from './fileJobRunner.js';
import { isTerminalFileJobState, type FileJobState } from './fileJobState.js';

/** awaiting-decision 에 머문 시간의 누적 상한. 넘으면 사용자 취소와 같은 길로 끝낸다. */
export const FILE_JOB_AWAIT_BUDGET_MS = 600_000;
/** 끝난 작업을 기억하는 시간. 끝난 시각부터 센다 — 늦게 온 cancel·decide 에 정확히 답하기 위해서다. */
export const FILE_JOB_RETENTION_MS = 300_000;

export type FileJobEvent = 'file-job:progress' | 'file-job:decision-required' | 'file-job:done';

export interface FileJobTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

// @req FR-FOP-003
export interface FileJobManagerDeps {
  runJob(spec: FileJobSpec, deps: FileJobRunnerDeps): Promise<FileJobResult>;
  fsOps: FileJobFsOps;
  broadcast(sessionId: string, event: FileJobEvent, payload: Record<string, unknown>): void;
  clock: { now(): number };
  timers: FileJobTimers;
  /** 세션의 작업 루트 기준 경로 검증기를 만든다. 거부는 throw(또는 reject)로 한다. */
  validatePathFor(sessionId: string): (p: string) => void | Promise<void>;
}

export interface FileJobStartInput {
  sourceSessionId: string;
  /** 없으면 출발지 세션. */
  destSessionId?: string;
  spec: FileJobSpec;
}

export interface FileJobSummary {
  jobId: string;
  sourceSessionId: string;
  destSessionId: string;
  operation: FileJobSpec['operation'];
  state: FileJobState;
}

export interface FileJobDecisionAnswer {
  decisionId: string;
  choice: FileJobConflictChoice;
  /** true 면 같은 작업의 남은 질문 중 이 답이 선택지에 드는 것에 묻지 않고 적용한다. 작업이 끝나면 버린다. */
  applyToAll?: boolean;
}

export type FileJobCancelResult =
  | { outcome: 'cancelled' }
  | { outcome: 'ignored'; atomic?: true }
  | { outcome: 'not-found' };

export type FileJobManagerErrorCode =
  | 'JOB_NOT_FOUND'
  | 'JOB_NOT_AWAITING'
  | 'DECISION_MISMATCH'
  | 'INVALID_CHOICE'
  | 'MANAGER_DISPOSED';

// @req FR-FOP-003
export class FileJobManagerError extends Error {
  readonly code: FileJobManagerErrorCode;

  constructor(code: FileJobManagerErrorCode, message: string) {
    super(message);
    this.name = 'FileJobManagerError';
    this.code = code;
  }
}

interface PendingDecision {
  decisionId: string;
  payload: Record<string, unknown>;
  /** 이 질문에 받아들일 답. 질문마다 다르다 — 제자리 붙여넣기에는 overwrite 가 없다. */
  choices: readonly FileJobConflictChoice[];
  resolve(answer: { choice: FileJobConflictChoice }): void;
  reject(err: unknown): void;
}

interface Job {
  jobId: string;
  sourceSessionId: string;
  destSessionId: string;
  operation: FileJobSpec['operation'];
  state: FileJobState;
  controller: AbortController;
  pending: PendingDecision | null;
  /** 끝난 awaiting-decision 구간들의 합. 진행 중인 구간은 awaitStartedAt 부터 따로 센다. */
  awaitedMs: number;
  awaitStartedAt: number | null;
  awaitTimer: unknown;
  retentionTimer: unknown;
  /** 끝난 뒤에만 채워진다. */
  result: FileJobResult | null;
  /** applyToAll 로 고른 답. 이 작업에만 속하고 끝날 때 버린다. */
  applyToAllChoice: FileJobConflictChoice | null;
  progress: ProgressThrottle<Record<string, unknown>>;
  /** done 에 싣는다. 러너 결과에 없는 값이라 시작할 때 spec 으로 정한다. */
  affectedDirectories: string[];
}

// 러너와 같은 이유로 접는다 — NTFS·APFS 에서 '/A' 와 '/a' 는 같은 항목이다.
const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';
const pathKey = (p: string): string => {
  const abs = resolve(p);
  return CASE_INSENSITIVE_FS ? abs.toLowerCase() : abs;
};

/**
 * 중복과 다른 source 의 하위 경로를 없앤다. 남기면 러너가 같은 항목을 두 번 세고 두 번
 * 옮기며, 두 번째는 첫 번째가 만든 목적지와 충돌해 있지도 않은 질문을 한다.
 * 비교는 경로 구간 단위다('/a' 는 '/ab' 의 부모가 아니다). 남는 원소는 원래 문자열 그대로다.
 */
// @req FR-FOP-005
export function normalizeSources(sources: readonly string[]): string[] {
  const keys = sources.map(pathKey);
  const present = new Set(keys);
  const kept = new Set<string>();
  const out: string[] = [];
  // 조상을 거슬러 오르며 집합을 본다 — 쌍마다 비교하면 선택이 수천 개일 때 제곱으로 느려진다.
  // 루트('/'·'C:\\')는 dirname 이 자기 자신이라, 멈춤 조건을 먼저 보지 않으면 자기를 조상으로 여겨 빠진다.
  const hasAncestorIn = (key: string): boolean => {
    for (let child = key, cur = dirname(key); cur !== child; child = cur, cur = dirname(cur)) {
      if (present.has(cur)) return true;
    }
    return false;
  };
  sources.forEach((source, i) => {
    const key = keys[i];
    if (kept.has(key) || hasAncestorIn(key)) return;
    kept.add(key);
    out.push(source);
  });
  return out;
}

/**
 * 작업이 바꿀 수 있는 디렉터리들. 받는 쪽이 목록을 다시 읽을 대상이다. copy 는 목적지,
 * delete 는 출발지의 부모, move 는 둘 다. destDir 은 받은 문자열 그대로, 부모는 (정규화된)
 * 출발지 문자열의 dirname 이다 — resolve 하면 받는 쪽이 보낸 경로와 모양이 달라져 맞춰 볼 수 없다.
 */
// @req IR-FOP-002
function affectedDirectoriesOf(spec: FileJobSpec): string[] {
  const dirs = new Set<string>();
  if (spec.operation !== 'delete' && spec.destDir !== undefined) dirs.add(spec.destDir);
  if (spec.operation !== 'copy') for (const source of spec.sources) dirs.add(dirname(source));
  return [...dirs];
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function';
}

// 러너가 취소로 판정하는 오류와 같은 모양이다. 풀려난 결정의 대기자가 이것을 받는다.
function abortError(): Error {
  const err = new Error('The operation was aborted') as Error & { code: string };
  err.name = 'AbortError';
  err.code = 'ABORT_ERR';
  return err;
}

// @req FR-FOP-003
// @req FR-FOP-005
export class FileJobManager {
  private readonly jobs = new Map<string, Job>();
  private disposed = false;

  constructor(private readonly deps: FileJobManagerDeps) {}

  /**
   * 작업을 시작한다. 출발지 경로는 여기서 출발지 세션 기준으로 검증한다 — 러너는 만드는
   * 경로만 검증하고 읽는 경로는 보지 않는다. 동기 검증이 거부하면 작업을 만들지 않고 그
   * 오류를 그대로 던진다.
   */
  // @req FR-FOP-003
  // @req FR-FOP-005
  start(input: FileJobStartInput): { jobId: string } {
    if (this.disposed) throw new FileJobManagerError('MANAGER_DISPOSED', 'File job manager is disposed');
    const sourceSessionId = input.sourceSessionId;
    const destSessionId = input.destSessionId ?? sourceSessionId;
    const spec: FileJobSpec = { ...input.spec, sources: normalizeSources(input.spec.sources) };

    const checkSource = this.deps.validatePathFor(sourceSessionId);
    // 만드는 경로는 전부 목적지 세션의 루트 안이어야 한다. 등록 전에 만든다 — 여기서 던지면
    // (목적지 세션이 없다 등) 러너 없는 작업이 목록에 영원히 남는다.
    const checkDest = this.deps.validatePathFor(destSessionId);
    const asyncChecks: Promise<unknown>[] = [];
    try {
      for (const source of spec.sources) {
        const checked = checkSource(source);
        if (isThenable(checked)) asyncChecks.push(Promise.resolve(checked));
      }
    } catch (err) {
      // 앞서 모은 비동기 검증이 뒤늦게 reject 해도 받을 곳이 없다 — 처리되지 않은 거부로 남기지 않는다.
      for (const pending of asyncChecks) pending.catch(() => {});
      throw err;
    }

    // queued 를 밖에 드러내지 않는다. 전이표에 queued → cancelled 가 없어서, 관리자가 queued 를
    // 들고 있다가 곧바로 온 cancel 에 전이를 부르면 throw 한다.
    const jobId = randomUUID();
    const job: Job = {
      jobId,
      sourceSessionId,
      destSessionId,
      operation: spec.operation,
      state: 'running',
      controller: new AbortController(),
      pending: null,
      awaitedMs: 0,
      awaitStartedAt: null,
      awaitTimer: undefined,
      retentionTimer: undefined,
      result: null,
      applyToAllChoice: null,
      progress: createProgressThrottle(
        (payload) => this.emit(job, 'file-job:progress', payload),
        this.deps.clock,
        this.deps.timers,
      ),
      affectedDirectories: affectedDirectoriesOf(spec),
    };
    this.jobs.set(job.jobId, job);

    const runnerDeps: FileJobRunnerDeps = {
      fsOps: this.deps.fsOps,
      validatePath: checkDest,
      decide: (req) => this.askUser(job, req),
      onProgress: (progress) => this.onProgress(job, progress),
      onStateChange: (state) => this.onStateChange(job, state),
      signal: job.controller.signal,
    };

    let running: Promise<FileJobResult>;
    if (asyncChecks.length === 0) {
      running = this.invokeRunJob(spec, runnerDeps);
    } else {
      // 비동기 검증이 끝나기 전에 온 취소는 러너를 부르지 않고 취소로 끝낸다 — 아무것도 건드리지 않았다.
      running = Promise.all(asyncChecks).then(
        () =>
          job.controller.signal.aborted
            ? { outcome: 'cancelled' as const, processedEntries: 0 }
            : this.invokeRunJob(spec, runnerDeps),
        // 취소 뒤의 검증 거부는 사용자가 고른 결과(취소)로 끝낸다 — 러너가 취소 뒤 오류를 다루는 방식과 같다.
        (error: unknown) =>
          job.controller.signal.aborted
            ? { outcome: 'cancelled' as const, processedEntries: 0 }
            : { outcome: 'failed' as const, processedEntries: 0, error },
      );
    }
    void running.then(
      (result) => this.finish(job, result),
      // 러너는 스스로 실패를 결과로 바꾸므로 여기에 오는 것은 러너 밖의 결함이다. 작업을
      // 끝나지 않은 채 두면 목록에 영원히 남으므로 failed 로 닫는다.
      (error: unknown) => this.finish(job, { outcome: 'failed', processedEntries: 0, error }),
    );
    return { jobId: job.jobId };
  }

  /** 비종료 작업만. sessionId 가 있으면 출발지·목적지 중 하나가 그 세션인 작업만. */
  // @req FR-FOP-003
  list(sessionId?: string): FileJobSummary[] {
    const out: FileJobSummary[] = [];
    for (const job of this.jobs.values()) {
      if (isTerminalFileJobState(job.state)) continue;
      if (sessionId !== undefined && !this.isBoundTo(job, sessionId)) continue;
      out.push({
        jobId: job.jobId,
        sourceSessionId: job.sourceSessionId,
        destSessionId: job.destSessionId,
        operation: job.operation,
        state: job.state,
      });
    }
    return out;
  }

  /**
   * 대기 중인 결정에 답한다. 취소의 원인(사용자·자동)은 오류에 드러나지 않는다 — 두 길이
   * 같은 결과를 낸다는 계약을 늦게 온 답에도 지킨다.
   */
  // @req FR-FOP-003
  decide(jobId: string, answer: FileJobDecisionAnswer): void {
    const job = this.jobs.get(jobId);
    if (!job) throw new FileJobManagerError('JOB_NOT_FOUND', `File job not found: ${jobId}`);
    const pending = job.pending;
    if (!pending || job.state !== 'awaiting-decision') {
      throw new FileJobManagerError('JOB_NOT_AWAITING', `File job is not awaiting a decision: ${jobId}`);
    }
    // 지난 질문에 대한 답(예: 재연결 전 대화상자)을 지금 질문에 적용하면 사용자가 보지 않은
    // 경로에 덮어쓰기가 일어난다.
    if (answer.decisionId !== pending.decisionId) {
      throw new FileJobManagerError('DECISION_MISMATCH', `Decision does not match the pending one: ${jobId}`);
    }
    // 모르는 답, 또는 이 질문의 선택지에 없는 답(제자리 붙여넣기의 overwrite)을 러너에 넘기면
    // 작업이 실패로 끝난다. 거부하고 질문을 살려 둔다.
    if (!pending.choices.includes(answer.choice)) {
      throw new FileJobManagerError('INVALID_CHOICE', `Unknown decision choice: ${String(answer.choice)}`);
    }
    if (answer.applyToAll === true) job.applyToAllChoice = answer.choice;
    job.pending = null;
    pending.resolve({ choice: answer.choice });
  }

  /** 사용자 취소와 자동 취소의 유일한 입구. */
  // @req FR-FOP-003
  // @req FR-FOP-005
  cancel(jobId: string): FileJobCancelResult {
    const job = this.jobs.get(jobId);
    if (!job) return { outcome: 'not-found' };
    if (job.result) {
      return job.result.atomic === true ? { outcome: 'ignored', atomic: true } : { outcome: 'ignored' };
    }
    job.controller.abort();
    // 러너는 abort 로 대기에서 빠져나오지만, 풀리지 않은 resolver 가 남으면 그것이 이 작업을
    // 붙잡고 재전송 대상으로도 남는다.
    this.releasePending(job);
    return { outcome: 'cancelled' };
  }

  /** 그 세션에 매인 작업 중 답을 기다리는 것의 질문을, 같은 페이로드로 그 세션에만 다시 보낸다. */
  // @req FR-FOP-003
  resendPendingDecisions(sessionId: string): void {
    for (const job of this.jobs.values()) {
      if (!job.pending || !this.isBoundTo(job, sessionId)) continue;
      this.send(sessionId, 'file-job:decision-required', job.pending.payload);
    }
  }

  /** 세션이 사라질 때 그 세션에 매인 비종료 작업을 모두 취소한다. */
  // @req FR-FOP-003
  cancelSessionJobs(sessionId: string): void {
    for (const job of [...this.jobs.values()]) {
      if (!job.result && this.isBoundTo(job, sessionId)) this.cancel(job.jobId);
    }
  }

  /** 도는 작업을 멈추고 타이머를 모두 거둔다. 여러 번 불러도 된다. */
  // @req FR-FOP-003
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const job of this.jobs.values()) {
      if (!job.result) {
        job.controller.abort();
        this.releasePending(job);
      }
      job.progress.dispose();
      this.clearTimer(job, 'awaitTimer');
      this.clearTimer(job, 'retentionTimer');
    }
    this.jobs.clear();
  }

  // ── 내부 ──────────────────────────────────────────────────────────────────

  private invokeRunJob(spec: FileJobSpec, runnerDeps: FileJobRunnerDeps): Promise<FileJobResult> {
    try {
      return this.deps.runJob(spec, runnerDeps);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  private isBoundTo(job: Job, sessionId: string): boolean {
    return job.sourceSessionId === sessionId || job.destSessionId === sessionId;
  }

  private sessionsOf(job: Job): string[] {
    return job.sourceSessionId === job.destSessionId ? [job.sourceSessionId] : [job.sourceSessionId, job.destSessionId];
  }

  private send(sessionId: string, event: FileJobEvent, payload: Record<string, unknown>): void {
    try {
      this.deps.broadcast(sessionId, event, payload);
    } catch {
      // 작업은 연결이 아니라 세션에 매인다. 받는 쪽의 송신 실패가 파일 작업을 멈추면 안 되고,
      // 다시 붙은 쪽은 list()·resendPendingDecisions() 로 따라잡는다.
    }
  }

  private emit(job: Job, event: FileJobEvent, payload: Record<string, unknown>): void {
    if (this.disposed) return;
    for (const sessionId of this.sessionsOf(job)) this.send(sessionId, event, payload);
  }

  // @req IR-FOP-002
  private onProgress(job: Job, progress: FileJobProgress): void {
    // done 뒤의 진행 보고는 받는 쪽에서 끝난 막대를 되살린다.
    if (this.disposed || job.result) return;
    job.progress.push({ jobId: job.jobId, ...progress });
  }

  // @req FR-FOP-003
  private onStateChange(job: Job, state: FileJobState): void {
    const prev = job.state;
    job.state = state;
    if (state === 'awaiting-decision' && prev !== 'awaiting-decision') this.enterAwait(job);
    else if (prev === 'awaiting-decision' && state !== 'awaiting-decision') this.leaveAwait(job);
  }

  private enterAwait(job: Job): void {
    if (this.disposed) return;
    job.awaitStartedAt = this.deps.clock.now();
    const remaining = Math.max(0, FILE_JOB_AWAIT_BUDGET_MS - job.awaitedMs);
    job.awaitTimer = this.deps.timers.setTimeout(() => {
      job.awaitTimer = undefined;
      this.cancel(job.jobId);
    }, remaining);
  }

  private leaveAwait(job: Job): void {
    if (job.awaitStartedAt !== null) {
      job.awaitedMs += this.deps.clock.now() - job.awaitStartedAt;
      job.awaitStartedAt = null;
    }
    this.clearTimer(job, 'awaitTimer');
  }

  // @req FR-FOP-003
  // @req FR-FOP-004
  private askUser(job: Job, req: FileJobDecisionRequest): Promise<{ choice: FileJobConflictChoice }> {
    if (job.controller.signal.aborted) {
      // 러너는 이미 취소된 신호를 보면 이 promise 에 핸들러를 달지 않고 떠난다. 그냥 reject 하면
      // 처리되지 않은 거부가 되므로, 돌려주는 promise 자체를 처리됨으로 표시한다.
      const rejected = Promise.reject(abortError());
      rejected.catch(() => {});
      return rejected;
    }
    // 기억한 답이 이 질문의 선택지에 없으면(overwrite 를 기억했는데 제자리 붙여넣기거나 파일 ↔
    // 디렉터리 충돌이다) 묻는다 —
    // 선택지 밖의 답을 적용하는 길을 만들지 않는다.
    const remembered = job.applyToAllChoice;
    if (remembered !== null && req.choices.includes(remembered)) {
      return Promise.resolve({ choice: remembered });
    }
    const choices = [...req.choices];
    return new Promise((resolve, reject) => {
      const decisionId = randomUUID();
      const payload: Record<string, unknown> = {
        jobId: job.jobId,
        decisionId,
        kind: req.kind,
        path: req.path,
        // 충돌에는 덧붙일 설명이 없다. 키는 늘 싣는다 — 받는 쪽이 kind 마다 모양을 가리지 않게.
        detail: null,
        choices,
      };
      job.pending = { decisionId, payload, choices, resolve, reject };
      this.emit(job, 'file-job:decision-required', payload);
    });
  }

  private releasePending(job: Job): void {
    const pending = job.pending;
    if (!pending) return;
    job.pending = null;
    pending.reject(abortError());
  }

  // @req FR-FOP-005
  private finish(job: Job, result: FileJobResult): void {
    // dispose 뒤에 끝난 작업은 이미 레지스트리에서 빠졌다 — 보존 타이머를 새로 걸면 누수다.
    if (this.disposed || this.jobs.get(job.jobId) !== job) return;
    // 러너가 스스로 전이를 알렸더라도, 결과만 있고 전이가 없는 경로(비동기 검증 실패·취소)가 있다.
    if (!isTerminalFileJobState(job.state)) {
      if (job.state === 'awaiting-decision') this.leaveAwait(job);
      job.state = result.outcome;
    }
    job.result = result;
    job.pending = null;
    job.applyToAllChoice = null;
    this.clearTimer(job, 'awaitTimer');
    // 창에 막힌 마지막 진행(processed = total)이 done 뒤에 나가거나 버려지지 않게 먼저 내보낸다.
    job.progress.flush();
    job.progress.dispose();
    // atomic 은 싣지 않는다 — 그것은 cancel 응답에만 있다(IR-FOP-002 AC-4).
    this.emit(job, 'file-job:done', {
      jobId: job.jobId,
      outcome: result.outcome,
      processedEntries: result.processedEntries,
      affectedDirectories: [...job.affectedDirectories],
    });
    job.retentionTimer = this.deps.timers.setTimeout(() => {
      job.retentionTimer = undefined;
      if (this.jobs.get(job.jobId) === job) this.jobs.delete(job.jobId);
    }, FILE_JOB_RETENTION_MS);
  }

  private clearTimer(job: Job, key: 'awaitTimer' | 'retentionTimer'): void {
    if (job[key] === undefined) return;
    this.deps.timers.clearTimeout(job[key]);
    job[key] = undefined;
  }
}
