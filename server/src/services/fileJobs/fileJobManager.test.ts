// FR-FOP-003 · FR-FOP-005 — 작업 관리자: 세션 결속·목록·결정 재전송·대기 누적 자동 취소·종료 보존.
//
// 계약(T-PH002-02 가 이 형태로 구현한다). 관리자는 fileJobRunner 의 runJob 위에 선다.
//   new FileJobManager(deps)
//     deps = {
//       runJob(spec, runnerDeps) → Promise<FileJobResult>   (운영은 fileJobRunner.runJob)
//       fsOps: FileJobFsOps
//       broadcast(sessionId, event, payload) → void
//         event ∈ 'file-job:progress' | 'file-job:decision-required' | 'file-job:done'
//         작업은 연결이 아니라 세션에 매인다 — 받는 쪽이 없어도 작업은 끝까지 간다.
//       clock: { now(): number }                              (ms)
//       timers: { setTimeout(fn, ms): unknown; clearTimeout(handle): void }
//       validatePathFor(sessionId) → (p) => void | Promise<void>
//     }
//   start({ sourceSessionId, destSessionId?, spec }) → { jobId }
//     동기로 runJob 을 시작한다. 'queued' 를 밖에 드러내지 않는다 — start 가 돌아온 순간
//     list() 의 state 는 'running' 이고, 곧바로 cancel 해도 throw 하지 않고 { outcome: 'cancelled' } 다.
//     (fileJobState 전이표에 queued → cancelled 가 없으므로, 관리자가 queued 를 들고 있다가
//     transition 을 부르면 throw 한다. 그 경로를 아예 만들지 않는 쪽을 택했다.)
//     spec.sources 를 정규화한다 — 중복을 없애고, 다른 source 의 하위 경로인 source 를 없앤다
//     (['/a', '/a/b'] → ['/a']). 경로 구간 단위로 비교한다('/a' 는 '/ab' 의 부모가 아니다).
//     남는 원소는 원래 문자열 그대로 넘긴다(가짜 fs 는 POSIX 모양 경로로 동작한다).
//   list(sessionId?) → Array<{ jobId, sourceSessionId, destSessionId, operation, state }>
//     비종료 작업만. sessionId 가 있으면 출발지·목적지 중 하나가 그 세션인 작업만.
//   decide(jobId, { decisionId, choice, applyToAll? }) → void
//     거부는 FileJobManagerError(name 'FileJobManagerError', code) 를 throw 한다.
//       code 'JOB_NOT_FOUND'    — 그런 작업이 없다(보존 기간이 지난 작업 포함)
//       code 'JOB_NOT_AWAITING' — 작업은 있으나 답을 기다리지 않는다(취소·완료로 끝난 작업 포함)
//     취소의 원인(사용자·자동)은 이 오류에 드러나지 않는다.
//   cancel(jobId) → { outcome: 'cancelled' } | { outcome: 'ignored', atomic?: true } | { outcome: 'not-found' }
//     'ignored' 는 이미 끝난 작업(보존 기간 안). 같은 장치 rename 으로 끝난 move 면 atomic: true 를
//     싣고, 아니면 atomic 키가 없다.
//   resendPendingDecisions(sessionId) → void
//     그 세션에 매인 작업 중 답을 기다리는 것의 decision-required 를 같은 페이로드(같은 decisionId)로
//     다시 보낸다. 취소로 끝난 작업의 대기 결정은 남아 있지 않다.
//   cancelSessionJobs(sessionId) → void   (그 세션에 매인 비종료 작업을 취소, 여러 번 불러도 된다)
//   dispose() → void                       (타이머 정리, 여러 번 불러도 된다)
//   상수: FILE_JOB_AWAIT_BUDGET_MS = 600000, FILE_JOB_RETENTION_MS = 300000
//   페이로드: decision-required 는 jobId·decisionId·kind·path 를, done 은 jobId·outcome·processedEntries
//     를 싣는다. 정확한 키 집합은 fileJobManagerEmit.test.ts(T-PH002-03) 범위다.
//   자동 취소는 awaiting-decision 에 머문 시간의 누적이 10분에 이를 때, cancel(jobId) 과 같은 길로 한다.
//   종료 작업은 끝난 시각부터 5분 보존된다(시작 시각이 아니다).
//
// 시간은 가짜다. FakeTime.advance 가 그 사이의 타이머를 만기 순서로 부른다. 10분을 실제로
// 기다리지 않는다. "running 30분" 은 가짜 fs 의 copyFileStream 을 문(gate)으로 붙잡아 둔 채
// 가짜 시계를 30분 옮기는 것으로 만든다.
//
// 모듈은 테스트마다 동적으로 import 한다 — 부재가 러너 사망이 아니라 이름 붙은 실패로
// 드러나게 하려는 것이다(fileJobRunner.test.ts 와 같은 이유).
import test from 'node:test';
import assert from 'node:assert/strict';
import { runJob } from './fileJobRunner.js';
import type { FileJobFsOps, FileJobFsStat } from './fileJobFsOps.js';
import type { FileJobResult, FileJobRunnerDeps, FileJobSpec } from './fileJobRunner.js';
import type { FileJobState } from './fileJobState.js';

type FileJobEvent = 'file-job:progress' | 'file-job:decision-required' | 'file-job:done';
type Payload = Record<string, unknown>;

interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

interface ManagerDeps {
  runJob(spec: FileJobSpec, deps: FileJobRunnerDeps): Promise<FileJobResult>;
  fsOps: FileJobFsOps;
  broadcast(sessionId: string, event: FileJobEvent, payload: Payload): void;
  clock: { now(): number };
  timers: Timers;
  validatePathFor(sessionId: string): (p: string) => void | Promise<void>;
}

interface JobSummary {
  jobId: string;
  sourceSessionId: string;
  destSessionId: string;
  operation: string;
  state: FileJobState;
}

type CancelResult = { outcome: 'cancelled' } | { outcome: 'ignored'; atomic?: true } | { outcome: 'not-found' };

interface Manager {
  start(input: { sourceSessionId: string; destSessionId?: string; spec: FileJobSpec }): { jobId: string };
  list(sessionId?: string): JobSummary[];
  decide(jobId: string, answer: { decisionId: string; choice: 'overwrite' | 'rename' | 'skip'; applyToAll?: boolean }): void;
  cancel(jobId: string): CancelResult;
  resendPendingDecisions(sessionId: string): void;
  cancelSessionJobs(sessionId: string): void;
  dispose(): void;
}

async function load(): Promise<{ FileJobManager: new (deps: ManagerDeps) => Manager }> {
  return (await import('./fileJobManager.js')) as unknown as {
    FileJobManager: new (deps: ManagerDeps) => Manager;
  };
}

const MIN = 60_000;
const SEC = 1_000;

// ── 가짜 시계·타이머 ────────────────────────────────────────────────────────

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await tick();
}

class FakeTime {
  nowMs = 0;
  private seq = 0;
  private readonly scheduled = new Map<number, { due: number; fn: () => void }>();

  readonly clock = { now: (): number => this.nowMs };
  readonly timers: Timers = {
    setTimeout: (fn, ms) => {
      this.seq += 1;
      this.scheduled.set(this.seq, { due: this.nowMs + Math.max(0, ms), fn });
      return this.seq;
    },
    clearTimeout: (handle) => {
      this.scheduled.delete(handle as number);
    },
  };

  pending(): number {
    return this.scheduled.size;
  }

  /** ms 만큼 시계를 옮기며 그 사이 만기인 타이머를 만기·등록 순서로 부른다. */
  async advance(ms: number): Promise<void> {
    const target = this.nowMs + ms;
    for (;;) {
      let nextId: number | undefined;
      let nextDue = Infinity;
      for (const [id, t] of this.scheduled) {
        if (t.due <= target && (t.due < nextDue || (t.due === nextDue && id < (nextId ?? Infinity)))) {
          nextId = id;
          nextDue = t.due;
        }
      }
      if (nextId === undefined) break;
      const timer = this.scheduled.get(nextId)!;
      this.scheduled.delete(nextId);
      this.nowMs = timer.due;
      timer.fn();
      await flush();
    }
    this.nowMs = target;
    await flush();
  }
}

// ── 가짜 fs ─────────────────────────────────────────────────────────────────

const norm = (p: string): string => p.replace(/\\/g, '/');
const parentOf = (p: string): string => {
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
};

type Node = { kind: 'file'; data: Buffer } | { kind: 'directory' };
type LogEntry = { op: string; path: string; src?: string };

function fsError(code: string, p: string): Error {
  const err = new Error(`${code}: ${p}`) as Error & { code: string };
  err.code = code;
  return err;
}

function abortError(): Error {
  const err = new Error('The operation was aborted') as Error & { code: string };
  err.name = 'AbortError';
  err.code = 'ABORT_ERR';
  return err;
}

class MemoryFs implements FileJobFsOps {
  readonly nodes = new Map<string, Node>([['/', { kind: 'directory' }]]);
  readonly log: LogEntry[] = [];
  /** src → 풀어 주는 함수. 문이 있는 파일의 복사는 풀릴 때까지 끝나지 않는다. */
  private readonly gates = new Map<string, Promise<void>>();

  dir(p: string): this {
    this.nodes.set(p, { kind: 'directory' });
    return this;
  }

  file(p: string, fill: number): this {
    this.nodes.set(p, { kind: 'file', data: Buffer.alloc(8, fill) });
    return this;
  }

  /** src 복사를 붙잡는다. 돌려준 함수를 부르면 풀린다. */
  gate(src: string): () => void {
    let release!: () => void;
    this.gates.set(src, new Promise<void>((resolve) => (release = resolve)));
    return release;
  }

  bytes(p: string): Buffer | undefined {
    const node = this.nodes.get(p);
    return node && node.kind === 'file' ? node.data : undefined;
  }

  list(p: string): string[] {
    const prefix = p === '/' ? '/' : `${p}/`;
    const names: string[] = [];
    for (const key of this.nodes.keys()) {
      if (key !== p && key.startsWith(prefix) && !key.slice(prefix.length).includes('/')) {
        names.push(key.slice(prefix.length));
      }
    }
    return names.sort();
  }

  copyCalls(src: string): number {
    return this.log.filter((e) => e.op === 'copy-call' && e.src === src).length;
  }

  private requireDir(p: string): void {
    const node = this.nodes.get(p);
    if (!node) throw fsError('ENOENT', p);
    if (node.kind !== 'directory') throw fsError('ENOTDIR', p);
  }

  async lstat(raw: string): Promise<FileJobFsStat | null> {
    const p = norm(raw);
    this.log.push({ op: 'lstat', path: p });
    const node = this.nodes.get(p);
    if (!node) return null;
    return node.kind === 'file' ? { kind: 'file', size: node.data.length } : { kind: 'directory', size: 0 };
  }

  async readdir(raw: string): Promise<string[]> {
    const p = norm(raw);
    this.log.push({ op: 'readdir', path: p });
    this.requireDir(p);
    return this.list(p);
  }

  async mkdir(raw: string): Promise<void> {
    const p = norm(raw);
    this.log.push({ op: 'mkdir', path: p });
    if (this.nodes.has(p)) throw fsError('EEXIST', p);
    this.requireDir(parentOf(p));
    this.nodes.set(p, { kind: 'directory' });
  }

  async copyFileStream(rawSrc: string, rawDst: string, onBytes: (n: number) => void, signal?: AbortSignal): Promise<void> {
    const src = norm(rawSrc);
    const dst = norm(rawDst);
    this.log.push({ op: 'copy-call', src, path: dst });
    const node = this.nodes.get(src);
    if (!node || node.kind !== 'file') throw fsError('ENOENT', src);
    this.requireDir(parentOf(dst));
    // 배타 생성 — 실제 어댑터 계약과 같다.
    if (this.nodes.has(dst)) throw fsError('EEXIST', dst);
    this.nodes.set(dst, { kind: 'file', data: Buffer.alloc(0) });
    const gate = this.gates.get(src);
    if (gate) {
      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(abortError());
        const onAbort = (): void => reject(abortError());
        signal?.addEventListener('abort', onAbort, { once: true });
        void gate.then(() => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        });
      }).catch((err: unknown) => {
        this.log.push({ op: 'copy-aborted', src, path: dst });
        throw err;
      });
    }
    await tick();
    if (signal?.aborted) {
      this.log.push({ op: 'copy-aborted', src, path: dst });
      throw abortError();
    }
    this.nodes.set(dst, { kind: 'file', data: Buffer.from(node.data) });
    onBytes(node.data.length);
    this.log.push({ op: 'copy-done', src, path: dst });
  }

  async unlink(raw: string): Promise<void> {
    const p = norm(raw);
    this.log.push({ op: 'unlink', path: p });
    const node = this.nodes.get(p);
    if (!node) throw fsError('ENOENT', p);
    if (node.kind === 'directory') throw fsError('EISDIR', p);
    this.nodes.delete(p);
  }

  async rmdir(raw: string): Promise<void> {
    const p = norm(raw);
    this.log.push({ op: 'rmdir', path: p });
    this.requireDir(p);
    if (this.list(p).length > 0) throw fsError('ENOTEMPTY', p);
    this.nodes.delete(p);
  }

  async rename(rawSrc: string, rawDst: string): Promise<void> {
    const src = norm(rawSrc);
    const dst = norm(rawDst);
    // 이 가짜에는 장치 경계가 없다 — rename 은 늘 성공한다(같은 장치 이동).
    if (!this.nodes.has(src)) throw fsError('ENOENT', src);
    this.requireDir(parentOf(dst));
    this.log.push({ op: 'rename', src, path: dst });
    const moved: Array<[string, Node]> = [];
    for (const [key, node] of this.nodes) {
      if (key === src || key.startsWith(`${src}/`)) moved.push([key, node]);
    }
    for (const [key] of moved) this.nodes.delete(key);
    for (const [key, node] of moved) this.nodes.set(dst + key.slice(src.length), node);
  }
}

// ── 관리자 구동 ─────────────────────────────────────────────────────────────

interface Sent {
  sessionId: string;
  event: FileJobEvent;
  payload: Payload;
}

interface Env {
  manager: Manager;
  fs: MemoryFs;
  time: FakeTime;
  sent: Sent[];
}

/** 관리자를 만들어 body 를 돌리고 dispose 한다. body 의 오류가 dispose 의 오류에 덮이지 않게 한다. */
async function withManager(fs: MemoryFs, body: (env: Env) => Promise<void>): Promise<void> {
  const { FileJobManager } = await load();
  const time = new FakeTime();
  const sent: Sent[] = [];
  const manager = new FileJobManager({
    runJob,
    fsOps: fs,
    // 받는 쪽이 없다 — 기록만 하고 아무에게도 전하지 않는다.
    broadcast: (sessionId, event, payload) => {
      sent.push({ sessionId, event, payload });
    },
    clock: time.clock,
    timers: time.timers,
    validatePathFor: () => () => {},
  });
  let bodyError: unknown;
  try {
    await body({ manager, fs, time, sent });
  } catch (err) {
    bodyError = err;
  }
  try {
    manager.dispose();
  } catch (err) {
    if (bodyError === undefined) bodyError = err;
  }
  if (bodyError !== undefined) throw bodyError;
}

/** pred 가 참이 될 때까지 이벤트 루프를 돌린다. 시계는 움직이지 않는다. */
async function until(pred: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 2000; i += 1) {
    if (pred()) return;
    await tick();
  }
  assert.fail(`기다린 상태에 이르지 못했다: ${label}`);
}

const doneOf = (sent: Sent[], jobId: string): Sent[] =>
  sent.filter((s) => s.event === 'file-job:done' && s.payload.jobId === jobId);
const decisionsOf = (sent: Sent[], jobId: string): Sent[] =>
  sent.filter((s) => s.event === 'file-job:decision-required' && s.payload.jobId === jobId);

function stateOf(manager: Manager, jobId: string): FileJobState | 'absent' {
  return manager.list().find((j) => j.jobId === jobId)?.state ?? 'absent';
}

function decisionIdOf(entry: Sent): string {
  const id = entry.payload.decisionId;
  assert.equal(typeof id, 'string', 'decision-required 에 decisionId 가 없다');
  assert.ok((id as string).length > 0, 'decisionId 가 빈 문자열이다');
  return id as string;
}

// ── AC-1 · AC-2 · AC-3 ─────────────────────────────────────────────────────

test('작업은 sessionId 에 매이고 연결 식별자를 받지 않는다 — 구독자가 없어도 completed 에 이른다', async () => {
  const fs = new MemoryFs().dir('/src').file('/src/f0', 0x30).dir('/dst');
  await withManager(fs, async ({ manager, sent }) => {
    // 시작 입력에는 세션과 spec 만 있다 — 연결·소켓 식별자는 없다.
    const { jobId } = manager.start({ sourceSessionId: 's1', spec: { operation: 'copy', sources: ['/src/f0'], destDir: '/dst' } });
    assert.equal(typeof jobId, 'string');
    await until(() => doneOf(sent, jobId).length > 0, 'done');
    const done = doneOf(sent, jobId);
    assert.equal(done.length, 1, `done 이 ${done.length}번 나갔다`);
    assert.equal(done[0].payload.outcome, 'completed');
    assert.equal(done[0].payload.processedEntries, 1);
    // 복사가 실제로 끝났다 — done 만 보내고 일을 하지 않은 관리자를 거른다.
    assert.deepEqual(fs.bytes('/dst/f0'), Buffer.alloc(8, 0x30));
    // 모든 송신은 세션을 수신자로 삼는다.
    assert.deepEqual([...new Set(sent.map((s) => s.sessionId))], ['s1']);
    assert.deepEqual(manager.list(), []);
  });
});

test('list() 는 비종료 작업만 돌려주고 끝난 작업은 빠진다', async () => {
  const fs = new MemoryFs()
    .dir('/src').file('/src/a', 0x61).file('/src/b', 0x62).file('/src/c', 0x63).file('/src/e', 0x65)
    .dir('/dstA').dir('/dstB').dir('/dstC').dir('/dstE');
  const releaseA = fs.gate('/src/a');
  const releaseC = fs.gate('/src/c');
  const releaseE = fs.gate('/src/e');
  await withManager(fs, async ({ manager, sent }) => {
    const a = manager.start({ sourceSessionId: 's1', spec: { operation: 'copy', sources: ['/src/a'], destDir: '/dstA' } }).jobId;
    const b = manager.start({ sourceSessionId: 's1', spec: { operation: 'copy', sources: ['/src/b'], destDir: '/dstB' } }).jobId;
    const c = manager.start({ sourceSessionId: 's2', spec: { operation: 'copy', sources: ['/src/c'], destDir: '/dstC' } }).jobId;
    // 출발지와 목적지 세션이 다른 작업 — 목적지 세션의 목록에도 보여야 한다.
    const e = manager.start({ sourceSessionId: 's2', destSessionId: 's3', spec: { operation: 'copy', sources: ['/src/e'], destDir: '/dstE' } }).jobId;
    await until(
      () => doneOf(sent, b).length > 0 && fs.copyCalls('/src/a') === 1 && fs.copyCalls('/src/c') === 1 && fs.copyCalls('/src/e') === 1,
      'b 완료 · a·c·e 복사 중',
    );

    const ids = (list: JobSummary[]): string[] => list.map((j) => j.jobId).sort();
    assert.deepEqual(ids(manager.list()), [a, c, e].sort(), '끝난 b 가 목록에 남았거나 도는 작업이 빠졌다');
    assert.deepEqual(ids(manager.list('s1')), [a], 's1 목록에 다른 세션 작업이 섞였다');
    assert.deepEqual(ids(manager.list('s2')), [c, e].sort());
    assert.deepEqual(ids(manager.list('s3')), [e], '목적지 세션의 목록에 작업이 없다');
    const entryA = manager.list('s1')[0];
    assert.equal(entryA.state, 'running');
    assert.equal(entryA.sourceSessionId, 's1');
    // destSessionId 를 주지 않으면 출발지 세션이다.
    assert.equal(entryA.destSessionId, 's1');
    assert.equal(entryA.operation, 'copy');
    const entryE = manager.list('s3')[0];
    assert.equal(entryE.sourceSessionId, 's2');
    assert.equal(entryE.destSessionId, 's3');

    releaseA();
    await until(() => doneOf(sent, a).length > 0, 'a 완료');
    assert.deepEqual(manager.list('s1'), []);
    assert.deepEqual(ids(manager.list()), [c, e].sort());

    // 붙잡아 둔 복사를 풀어 끝나지 않는 작업을 남기지 않는다.
    releaseC();
    releaseE();
    await until(() => doneOf(sent, c).length > 0 && doneOf(sent, e).length > 0, 'c·e 완료');
    assert.deepEqual(manager.list(), []);
  });
});

test('resendPendingDecisions(sessionId) 가 대기 중인 decision-required 를 같은 decisionId 로 다시 보낸다', async () => {
  const fs = new MemoryFs()
    .dir('/src').file('/src/x', 0x78).file('/src/y', 0x79)
    .dir('/dst1').file('/dst1/x', 0x01)
    .dir('/dst2').file('/dst2/y', 0x02);
  await withManager(fs, async ({ manager, sent }) => {
    const j1 = manager.start({ sourceSessionId: 's1', spec: { operation: 'copy', sources: ['/src/x'], destDir: '/dst1' } }).jobId;
    const j2 = manager.start({ sourceSessionId: 's2', spec: { operation: 'copy', sources: ['/src/y'], destDir: '/dst2' } }).jobId;
    await until(() => decisionsOf(sent, j1).length === 1 && decisionsOf(sent, j2).length === 1, '두 작업 모두 결정 대기');
    const original = decisionsOf(sent, j1)[0];
    assert.equal(original.sessionId, 's1');
    assert.equal(original.payload.kind, 'conflict');
    assert.equal(original.payload.path !== undefined, true, 'decision-required 에 path 가 없다');
    decisionIdOf(original);

    const before = sent.length;
    manager.resendPendingDecisions('s1');
    const resent = sent.slice(before);
    // 정확히 하나 — s2 의 대기 결정이 섞이거나 아무것도 안 보내면 실패한다.
    assert.equal(resent.length, 1, `재전송이 ${resent.length}건이다: ${JSON.stringify(resent)}`);
    assert.equal(resent[0].sessionId, 's1');
    assert.equal(resent[0].event, 'file-job:decision-required');
    // 같은 페이로드 — 새 decisionId 를 만들면 먼저 떠 있던 대화상자의 답이 거부된다.
    assert.deepEqual(resent[0].payload, original.payload);

    manager.decide(j1, { decisionId: decisionIdOf(original), choice: 'skip' });
    await until(() => doneOf(sent, j1).length > 0, 'j1 완료');
    const afterDone = sent.length;
    manager.resendPendingDecisions('s1');
    assert.equal(sent.length, afterDone, '답한 뒤에도 결정을 다시 보냈다');
  });
});

test('취소하면 대기 중이던 결정이 풀려 관리자가 그 작업을 붙잡지 않는다 — 재전송할 결정이 남지 않는다', async () => {
  for (const mode of ['user', 'auto'] as const) {
    const fs = new MemoryFs().dir('/src').file('/src/x', 0x78).dir('/dst').file('/dst/x', 0x01);
    await withManager(fs, async ({ manager, sent, time }) => {
      const jobId = manager.start({ sourceSessionId: 's1', spec: { operation: 'copy', sources: ['/src/x'], destDir: '/dst' } }).jobId;
      await until(() => decisionsOf(sent, jobId).length === 1, `${mode}: 결정 대기`);
      // 대조군: 취소 전에는 재전송이 실제로 나간다. 이것이 없으면 "아무것도 안 보내는 재전송" 도 통과한다.
      const beforeControl = sent.length;
      manager.resendPendingDecisions('s1');
      assert.equal(sent.length - beforeControl, 1, `${mode}: 취소 전 재전송이 나가지 않았다`);

      if (mode === 'user') manager.cancel(jobId);
      else await time.advance(10 * MIN + 1);
      await until(() => doneOf(sent, jobId).length > 0, `${mode}: done`);

      const before = sent.length;
      manager.resendPendingDecisions('s1');
      assert.equal(sent.length, before, `${mode}: 취소로 끝난 작업의 결정을 다시 보냈다`);
      assert.deepEqual(manager.list(), [], `${mode}: 취소된 작업이 목록에 남았다`);
    });
  }
});

// ── AC-4 대기 누적 10분 ────────────────────────────────────────────────────

/**
 * running 30분 → 대기 6분 → running 30분 → 대기 3분 → 세 번째 대기.
 * 벽시계 10분(첫 running 도중)·66분(두 번째 running 끝)·69분(두 번째 대기 끝)에서 관측한다.
 */
async function longScenario(env: Env): Promise<{ jobId: string; observed: Record<string, { done: number; state: string }> }> {
  const { manager, fs, time, sent } = env;
  const releaseF0 = fs.gate('/src/f0');
  const releaseF1 = fs.gate('/src/f1');
  const jobId = manager.start({
    sourceSessionId: 's1',
    spec: { operation: 'copy', sources: ['/src/f0', '/src/a', '/src/f1', '/src/b', '/src/c'], destDir: '/dst' },
  }).jobId;
  const observed: Record<string, { done: number; state: string }> = {};
  const look = (label: string): void => {
    observed[label] = { done: doneOf(sent, jobId).length, state: stateOf(manager, jobId) };
  };
  const answer = (index: number): void => {
    manager.decide(jobId, { decisionId: decisionIdOf(decisionsOf(sent, jobId)[index]), choice: 'skip' });
  };

  await until(() => fs.copyCalls('/src/f0') === 1, 'f0 복사 시작');
  await time.advance(10 * MIN);
  look('wall-10m');
  await time.advance(20 * MIN);
  releaseF0();
  await until(() => decisionsOf(sent, jobId).length === 1, '첫 번째 대기');
  await time.advance(6 * MIN);
  answer(0);
  await until(() => fs.copyCalls('/src/f1') === 1, 'f1 복사 시작');
  await time.advance(30 * MIN);
  look('wall-66m');
  releaseF1();
  await until(() => decisionsOf(sent, jobId).length === 2, '두 번째 대기');
  await time.advance(3 * MIN);
  answer(1);
  await until(() => decisionsOf(sent, jobId).length === 3, '세 번째 대기');
  look('wall-69m');
  return { jobId, observed };
}

function longScenarioFs(): MemoryFs {
  return new MemoryFs()
    .dir('/src').file('/src/f0', 0x30).file('/src/a', 0x61).file('/src/f1', 0x31).file('/src/b', 0x62).file('/src/c', 0x63)
    .dir('/dst').file('/dst/a', 0x01).file('/dst/b', 0x02).file('/dst/c', 0x03);
}

test('running 30분 → 대기 6분 → running 30분 → 대기 3분: 벽시계 10분·66분 시점 모두 취소가 없다 (벽시계 타이머가 아니라 대기 누적 예산이다)', async () => {
  await withManager(longScenarioFs(), async (env) => {
    const { observed } = await longScenario(env);
    // 시작 시각 기준 10분 타이머는 wall-10m 에서, 첫 대기 기준 벽시계 10분 타이머는 wall-66m 전에 쏜다.
    assert.deepEqual(observed, {
      'wall-10m': { done: 0, state: 'running' },
      'wall-66m': { done: 0, state: 'running' },
      'wall-69m': { done: 0, state: 'awaiting-decision' },
    });
  });
});

test('위 시나리오에서 세 번째 대기가 누적 10분을 넘는 순간에만 자동 취소된다', async () => {
  await withManager(longScenarioFs(), async (env) => {
    const { jobId } = await longScenario(env);
    const { time, sent, manager } = env;
    // 누적 9분에서 세 번째 대기가 시작됐다. 1분에서 1ms 모자란 때는 아직이다.
    await time.advance(MIN - 1);
    assert.equal(doneOf(sent, jobId).length, 0, '누적 10분이 되기 전에 취소되었다 — 대기마다 예산을 새로 세지 않는다');
    assert.equal(stateOf(manager, jobId), 'awaiting-decision');
    await time.advance(2);
    await until(() => doneOf(sent, jobId).length > 0, '자동 취소 done');
    assert.equal(doneOf(sent, jobId)[0].payload.outcome, 'cancelled');
    // 끝난 파일(f0·f1)은 남고, 자동 취소가 새 복사를 시작하지 않았다.
    assert.deepEqual(env.fs.list('/dst'), ['a', 'b', 'c', 'f0', 'f1']);
    assert.equal(env.fs.copyCalls('/src/c'), 0);
  });
});

test('대기 누적 9분 59초에서는 취소되지 않는다', async () => {
  const fs = new MemoryFs()
    .dir('/src').file('/src/a', 0x61).file('/src/b', 0x62)
    .dir('/dst').file('/dst/a', 0x01).file('/dst/b', 0x02);
  await withManager(fs, async ({ manager, sent, time }) => {
    const jobId = manager.start({ sourceSessionId: 's1', spec: { operation: 'copy', sources: ['/src/a', '/src/b'], destDir: '/dst' } }).jobId;
    await until(() => decisionsOf(sent, jobId).length === 1, '첫 번째 대기');
    await time.advance(5 * MIN);
    manager.decide(jobId, { decisionId: decisionIdOf(decisionsOf(sent, jobId)[0]), choice: 'skip' });
    await until(() => decisionsOf(sent, jobId).length === 2, '두 번째 대기');
    await time.advance(4 * MIN + 59 * SEC);
    assert.equal(doneOf(sent, jobId).length, 0, '누적 9분 59초에 취소되었다');
    assert.equal(stateOf(manager, jobId), 'awaiting-decision');
    manager.decide(jobId, { decisionId: decisionIdOf(decisionsOf(sent, jobId)[1]), choice: 'skip' });
    await until(() => doneOf(sent, jobId).length > 0, 'done');
    assert.equal(doneOf(sent, jobId)[0].payload.outcome, 'completed');
  });
});

// ── AC-5 자동 취소 = 사용자 취소 ────────────────────────────────────────────

interface CancelRun {
  log: LogEntry[];
  done: Payload;
  dst: string[];
  dstA: Buffer | undefined;
  lateError: { name: string; code: unknown; message: string };
}

/** f0 를 마치고 a 의 충돌에서 기다리는 작업을 사용자 또는 자동으로 취소한다. */
async function cancelWhileAwaiting(mode: 'user' | 'auto'): Promise<CancelRun> {
  const fs = new MemoryFs()
    .dir('/src').file('/src/f0', 0x30).file('/src/a', 0x61).file('/src/f1', 0x31)
    .dir('/dst').file('/dst/a', 0x01);
  let run: CancelRun | undefined;
  await withManager(fs, async ({ manager, sent, time }) => {
    const jobId = manager.start({
      sourceSessionId: 's1',
      spec: { operation: 'copy', sources: ['/src/f0', '/src/a', '/src/f1'], destDir: '/dst' },
    }).jobId;
    await until(() => decisionsOf(sent, jobId).length === 1, `${mode}: 결정 대기`);
    const decisionId = decisionIdOf(decisionsOf(sent, jobId)[0]);
    if (mode === 'user') {
      assert.deepEqual(manager.cancel(jobId), { outcome: 'cancelled' });
    } else {
      await time.advance(10 * MIN + 1);
    }
    await until(() => doneOf(sent, jobId).length > 0, `${mode}: done`);
    const done = doneOf(sent, jobId);
    assert.equal(done.length, 1, `${mode}: done 이 ${done.length}번 나갔다`);

    let caught: unknown;
    try {
      manager.decide(jobId, { decisionId, choice: 'skip' });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof Error, `${mode}: 취소 뒤 늦게 온 결정이 거부되지 않았다`);
    const e = caught as Error & { code?: unknown };
    const { jobId: _omit, ...donePayload } = done[0].payload;
    run = {
      log: fs.log,
      done: donePayload,
      dst: fs.list('/dst'),
      dstA: fs.bytes('/dst/a'),
      lateError: { name: e.name, code: e.code, message: e.message.split(jobId).join('<job>').split(decisionId).join('<decision>') },
    };
  });
  return run!;
}

test('같은 시나리오를 사용자 취소와 자동 취소로 돌리면 결과가 같다 — 끝난 파일 유지, 롤백 연산 0, done 페이로드(processedEntries 포함) 동일', async () => {
  const user = await cancelWhileAwaiting('user');
  const auto = await cancelWhileAwaiting('auto');
  // 절대값 — 둘이 같은 방식으로 틀리는 것(예: 둘 다 failed)을 거른다.
  assert.equal(user.done.outcome, 'cancelled');
  assert.equal(user.done.processedEntries, 1);
  assert.deepEqual(user.dst, ['a', 'f0']);
  assert.deepEqual(user.dstA, Buffer.alloc(8, 0x01), '기존 목적지 파일이 바뀌었다');
  assert.equal(user.log.filter((e) => e.op === 'unlink' || e.op === 'rmdir').length, 0, '사용자 취소가 롤백 연산을 했다');
  // 상대값 — 자동 취소가 같은 규칙을 따른다.
  assert.deepEqual(auto.done, user.done, 'done 페이로드가 다르다');
  assert.deepEqual(auto.log, user.log, 'fs 연산 목록이 다르다');
  assert.deepEqual(auto.dst, user.dst);
  assert.deepEqual(auto.dstA, user.dstA);
});

test('자동 취소 뒤 늦게 온 decision 은 사용자 취소 뒤와 같은 오류로 거부된다', async () => {
  const user = await cancelWhileAwaiting('user');
  const auto = await cancelWhileAwaiting('auto');
  assert.equal(user.lateError.name, 'FileJobManagerError');
  assert.equal(user.lateError.code, 'JOB_NOT_AWAITING');
  assert.deepEqual(auto.lateError, user.lateError);
});

// ── 정규화·시작 직후 취소 ───────────────────────────────────────────────────

test('관리자는 sources 를 정규화한다 — 중복과 다른 source 의 하위 경로를 없애 두 번 세지 않는다', async () => {
  const fs = new MemoryFs()
    .dir('/src').dir('/src/d').file('/src/d/x', 0x78).file('/src/dd', 0x64)
    .dir('/dst');
  await withManager(fs, async ({ manager, sent }) => {
    // 하위 경로가 부모보다 앞에 오고, 부모는 두 번 온다. '/src/dd' 는 '/src/d' 의 하위가 아니다.
    const jobId = manager.start({
      sourceSessionId: 's1',
      spec: { operation: 'copy', sources: ['/src/d/x', '/src/d', '/src/dd', '/src/d'], destDir: '/dst' },
    }).jobId;
    await until(() => doneOf(sent, jobId).length > 0, 'done');
    const done = doneOf(sent, jobId)[0].payload;
    assert.equal(done.outcome, 'completed');
    // d, d/x, dd — 셋. 중복을 남기면 d 를 두 번 세고, 하위를 남기면 x 를 /dst 에 한 벌 더 만든다.
    assert.equal(done.processedEntries, 3);
    assert.deepEqual(fs.list('/dst'), ['d', 'dd'], "'/src/dd' 가 빠졌거나 하위 경로가 따로 복사되었다");
    assert.deepEqual(fs.list('/dst/d'), ['x']);
    assert.equal(fs.copyCalls('/src/d/x'), 1);
    assert.equal(decisionsOf(sent, jobId).length, 0, '중복 source 가 자기 자신과 충돌했다');
  });
});

test('start 직후 곧바로 cancel 해도 throw 하지 않는다 — queued 를 드러내지 않고 아무것도 복사하지 않은 채 끝난다', async () => {
  const fs = new MemoryFs().dir('/src').file('/src/f0', 0x30).dir('/dst');
  await withManager(fs, async ({ manager, sent }) => {
    const { jobId } = manager.start({ sourceSessionId: 's1', spec: { operation: 'copy', sources: ['/src/f0'], destDir: '/dst' } });
    const stateAtStart = stateOf(manager, jobId);
    let result: CancelResult | undefined;
    assert.doesNotThrow(() => {
      result = manager.cancel(jobId);
    }, '시작 직후 취소가 throw 했다 — queued → cancelled 전이는 없다');
    assert.equal(stateAtStart, 'running', `start 가 돌아온 순간의 상태가 ${stateAtStart} 이다`);
    assert.deepEqual(result, { outcome: 'cancelled' });
    await until(() => doneOf(sent, jobId).length > 0, 'done');
    const done = doneOf(sent, jobId)[0].payload;
    assert.equal(done.outcome, 'cancelled');
    assert.equal(done.processedEntries, 0);
    assert.equal(fs.copyCalls('/src/f0'), 0, '취소한 작업이 복사를 시작했다');
    assert.deepEqual(fs.list('/dst'), []);
  });
});

// index.ts 는 DELETE 라우트와 세션 finalizer 두 곳에서 같은 세션을 거두므로, 한 세션에 두 번 불려도
// 무해해야 하고 다른 세션의 작업은 건드리지 않아야 한다.
// @req FR-FOP-003
test('cancelSessionJobs 를 같은 세션에 두 번 불러도 throw 하지 않고 done 은 한 번이며, 다른 세션 작업은 끝까지 돈다', async () => {
  const fs = new MemoryFs().dir('/src').file('/src/f0', 0x30).file('/src/f1', 0x31).dir('/dst').dir('/dst2');
  await withManager(fs, async ({ manager, sent }) => {
    const a = manager.start({ sourceSessionId: 's1', spec: { operation: 'copy', sources: ['/src/f0'], destDir: '/dst' } });
    const b = manager.start({ sourceSessionId: 's2', spec: { operation: 'copy', sources: ['/src/f1'], destDir: '/dst2' } });
    assert.doesNotThrow(() => manager.cancelSessionJobs('s1'), '첫 cancelSessionJobs 가 throw 했다');
    assert.doesNotThrow(() => manager.cancelSessionJobs('s1'), '두 번째 cancelSessionJobs 가 throw 했다');
    await until(() => doneOf(sent, a.jobId).length > 0 && doneOf(sent, b.jobId).length > 0, 'done');
    assert.doesNotThrow(() => manager.cancelSessionJobs('s1'), '끝난 뒤 cancelSessionJobs 가 throw 했다');
    const doneA = doneOf(sent, a.jobId);
    assert.equal(doneA.length, 1, `s1 작업의 done 이 ${doneA.length}번 나갔다`);
    assert.equal(doneA[0].payload.outcome, 'cancelled');
    assert.deepEqual(fs.list('/dst'), []);
    const doneB = doneOf(sent, b.jobId);
    assert.equal(doneB.length, 1);
    assert.equal(doneB[0].payload.outcome, 'completed', '다른 세션의 작업이 함께 취소되었다');
    assert.deepEqual(fs.bytes('/dst2/f1'), Buffer.alloc(8, 0x31));
  });
});

// ── FR-FOP-005 AC-5 종료 작업 보존 ─────────────────────────────────────────

test("같은 장치 이동이 끝난 작업은 5분 보존되고 그동안 cancel 이 {outcome:'ignored', atomic:true} 를 돌려주며 list() 에는 없다", async () => {
  const fs = new MemoryFs().dir('/src').file('/src/m', 0x6d).file('/src/f0', 0x30).dir('/dst').dir('/dst2');
  await withManager(fs, async ({ manager, sent, time }) => {
    const moveJob = manager.start({ sourceSessionId: 's1', spec: { operation: 'move', sources: ['/src/m'], destDir: '/dst' } }).jobId;
    const copyJob = manager.start({ sourceSessionId: 's1', spec: { operation: 'copy', sources: ['/src/f0'], destDir: '/dst2' } }).jobId;
    await until(() => doneOf(sent, moveJob).length > 0 && doneOf(sent, copyJob).length > 0, '두 작업 완료');
    assert.equal(doneOf(sent, moveJob)[0].payload.outcome, 'completed');
    assert.deepEqual(fs.list('/dst'), ['m'], 'move 가 실제로 일어나지 않았다');
    assert.deepEqual(manager.list(), []);

    assert.deepEqual(manager.cancel(moveJob), { outcome: 'ignored', atomic: true });
    // 원자적이지 않은 종료에는 atomic 을 싣지 않는다 — 늘 atomic:true 를 붙이는 관리자를 거른다.
    assert.deepEqual(manager.cancel(copyJob), { outcome: 'ignored' });
    await time.advance(4 * MIN + 59 * SEC);
    assert.deepEqual(manager.cancel(moveJob), { outcome: 'ignored', atomic: true }, '5분이 되기 전에 기록이 사라졌다');
    assert.deepEqual(manager.list(), []);

    manager.dispose();
    assert.equal(time.pending(), 0, 'dispose 뒤에 타이머가 남았다');
  });
});

test('보존 5분이 지나면 기록이 사라지고 cancel 은 not-found 다', async () => {
  const fs = new MemoryFs().dir('/src').file('/src/f0', 0x30).dir('/dst');
  const release = fs.gate('/src/f0');
  await withManager(fs, async ({ manager, sent, time }) => {
    const jobId = manager.start({ sourceSessionId: 's1', spec: { operation: 'copy', sources: ['/src/f0'], destDir: '/dst' } }).jobId;
    await until(() => fs.copyCalls('/src/f0') === 1, '복사 시작');
    // 30분 돌고 끝난다 — 보존을 시작 시각부터 세는 관리자는 끝나자마자 기록을 잃는다.
    await time.advance(30 * MIN);
    release();
    await until(() => doneOf(sent, jobId).length > 0, 'done');
    await time.advance(4 * MIN + 59 * SEC);
    assert.deepEqual(manager.cancel(jobId), { outcome: 'ignored' }, '끝난 뒤 5분이 되기 전에 기록이 사라졌다');
    await time.advance(1 * SEC + 1);
    assert.deepEqual(manager.cancel(jobId), { outcome: 'not-found' });
    assert.deepEqual(manager.list(), []);
    let caught: unknown;
    try {
      manager.decide(jobId, { decisionId: 'd-any', choice: 'skip' });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof Error, '사라진 작업에 대한 결정이 거부되지 않았다');
    assert.equal((caught as Error).name, 'FileJobManagerError');
    assert.equal((caught as Error & { code?: unknown }).code, 'JOB_NOT_FOUND');
  });
});
