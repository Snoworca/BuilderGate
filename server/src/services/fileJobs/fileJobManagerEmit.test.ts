// FR-FOP-004 · FR-FOP-005 · IR-FOP-002 — 관리자가 밖으로 보내는 것.
//
// fileJobManager.test.ts 가 작업의 수명(세션 결속·대기 예산·보존)을 본다면, 이 파일은 관리자가
// broadcast 로 내보내는 것과 결정의 범위를 본다. 가짜 broadcast 가 받은 (sessionId, event, payload)
// 만 관측한다 — 수신자가 실제로 무엇을 그리는지는 프런트엔드 몫이다.
//
// 계약(T-PH002-04 가 이 형태로 구현한다):
//   applyToAll=true 로 답한 선택은 그 작업 객체에만 남고 작업이 끝나면 버린다. 같은 세션의 다른
//     작업, 끝난 뒤의 새 작업은 다시 묻는다. 작업을 넘어 기억하면 한참 뒤의 다른 작업이 사용자가
//     모르는 사이에 덮어쓴다(설계 §3.6).
//   진행 보고는 작업마다 1초 창에서 10회 이하 — 주입한 clock·timers 로 leading + trailing 제한한다.
//     창이 끝나면 대기 중이던 마지막 값이 반드시 나가고, done 직전에는 그것을 먼저 내보낸다.
//     done 뒤에는 진행 보고가 나가지 않는다.
//   file-job:progress   = { jobId, phase, processedBytes, totalBytes, processedEntries, totalEntries, currentPath }
//   file-job:decision-required = { jobId, decisionId, kind, path, detail, choices }
//     충돌의 choices 는 ['overwrite', 'rename', 'skip']. 출발지 파일을 그 파일이 있는 폴더에
//     붙여넣으면(출발지 === 목적지) 실패가 아니라 충돌이고 choices 는 ['rename', 'skip'] 이다 —
//     자기 자신을 덮어쓰면 쓰기 스트림이 여는 순간 원본이 잘려 빈 파일이 남는다. 그 질문에 온
//     'overwrite' 는 INVALID_CHOICE 로 거부하고 질문은 열어 둔다. detail 은 키가 있어야 한다(null 허용).
//   file-job:done = 정확히 { jobId, outcome, processedEntries, affectedDirectories } — atomic 은 싣지 않는다
//     (atomic 은 cancel 응답에만 있다). affectedDirectories 는 중복 없는 문자열 배열이다:
//       copy   → [destDir]
//       move   → destDir + 각 출발지의 부모
//       delete → 각 출발지의 부모
//     부모는 (정규화된) 출발지 문자열에 path.dirname 을 적용한 값, destDir 은 받은 문자열 그대로다.
//     러너 결과에는 이 값이 없으므로 관리자가 spec 으로 계산한다.
//   출발지·목적지 세션이 다르면 모든 file-job:* 를 두 세션에 같은 페이로드로 보낸다.
//   decide 오류 코드는 T-PH002-02 가 더한 것을 유지한다:
//     DECISION_MISMATCH — 지금 대기 중인 decisionId 가 아니다
//     INVALID_CHOICE    — 모르는(또는 그 질문의 choices 에 없는) 선택이다. 질문은 열린 채로 남는다
//     MANAGER_DISPOSED  — dispose 뒤의 start
//
// 시간은 가짜다. 1초 창을 실제로 기다리지 않는다. 모듈은 테스트마다 동적으로 import 한다 —
// 부재가 러너 사망이 아니라 이름 붙은 실패로 드러나게 하려는 것이다(fileJobManager.test.ts 와 같다).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runJob } from './fileJobRunner.js';
import { nodeFileJobFsOps } from './fileJobFsOps.js';
import type { FileJobFsOps, FileJobFsStat } from './fileJobFsOps.js';
import type { FileJobResult, FileJobRunnerDeps, FileJobSpec } from './fileJobRunner.js';

type FileJobEvent = 'file-job:progress' | 'file-job:decision-required' | 'file-job:done';
type Payload = Record<string, unknown>;
type Choice = 'overwrite' | 'rename' | 'skip';

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

interface Manager {
  start(input: { sourceSessionId: string; destSessionId?: string; spec: FileJobSpec }): { jobId: string };
  decide(jobId: string, answer: { decisionId: string; choice: Choice; applyToAll?: boolean }): void;
  cancel(jobId: string): unknown;
  resendPendingDecisions(sessionId: string): void;
  dispose(): void;
}

async function load(): Promise<{ FileJobManager: new (deps: ManagerDeps) => Manager }> {
  return (await import('./fileJobManager.js')) as unknown as {
    FileJobManager: new (deps: ManagerDeps) => Manager;
  };
}

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
  /** src → 1바이트씩 나눠 보고할 횟수와 보고마다 기다릴 것. 진행 보고를 대량으로 만들어 낸다. */
  private readonly chunked = new Map<string, { count: number; step: () => Promise<void> }>();

  dir(p: string): this {
    this.nodes.set(p, { kind: 'directory' });
    return this;
  }

  file(p: string, fill: number): this {
    this.nodes.set(p, { kind: 'file', data: Buffer.alloc(8, fill) });
    return this;
  }

  /** count 바이트 파일을 만들고, 그 복사가 1바이트마다 onBytes 를 부른 뒤 step 을 기다리게 한다. */
  chunkedFile(p: string, count: number, step: () => Promise<void>): this {
    this.nodes.set(p, { kind: 'file', data: Buffer.alloc(count, 0x62) });
    this.chunked.set(p, { count, step });
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
    const plan = this.chunked.get(src);
    if (plan) {
      for (let i = 0; i < plan.count; i += 1) {
        onBytes(1);
        await plan.step();
      }
    } else {
      onBytes(node.data.length);
    }
    this.nodes.set(dst, { kind: 'file', data: Buffer.from(node.data) });
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
  /** 가짜 시계로 잰 송신 시각. */
  at: number;
}

interface Env {
  manager: Manager;
  time: FakeTime;
  sent: Sent[];
}

/** 관리자를 만들어 body 를 돌리고 dispose 한다. body 의 오류가 dispose 의 오류에 덮이지 않게 한다. */
async function withManager(fsOps: FileJobFsOps, body: (env: Env) => Promise<void>, time = new FakeTime()): Promise<void> {
  const { FileJobManager } = await load();
  const sent: Sent[] = [];
  const manager = new FileJobManager({
    runJob,
    fsOps,
    broadcast: (sessionId, event, payload) => {
      sent.push({ sessionId, event, payload, at: time.nowMs });
    },
    clock: time.clock,
    timers: time.timers,
    validatePathFor: () => () => {},
  });
  let bodyError: unknown;
  try {
    await body({ manager, time, sent });
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
async function until(pred: () => boolean, label: string, maxTicks = 2000): Promise<void> {
  for (let i = 0; i < maxTicks; i += 1) {
    if (pred()) return;
    await tick();
  }
  assert.fail(`기다린 상태에 이르지 못했다: ${label}`);
}

/** 실제 디스크 I/O 는 setImmediate 몇 번으로 끝난다는 보장이 없다 — 실시간 기한으로 기다린다. */
async function untilReal(pred: () => boolean, label: string, deadlineMs = 10_000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`기다린 상태에 이르지 못했다: ${label}`);
}

const ofJob = (sent: Sent[], event: FileJobEvent, jobId: string): Sent[] =>
  sent.filter((s) => s.event === event && s.payload.jobId === jobId);
const doneOf = (sent: Sent[], jobId: string): Sent[] => ofJob(sent, 'file-job:done', jobId);
const decisionsOf = (sent: Sent[], jobId: string): Sent[] => ofJob(sent, 'file-job:decision-required', jobId);
const progressOf = (sent: Sent[], jobId: string): Sent[] => ofJob(sent, 'file-job:progress', jobId);

function decisionIdOf(entry: Sent): string {
  const id = entry.payload.decisionId;
  assert.equal(typeof id, 'string', 'decision-required 에 decisionId 가 없다');
  return id as string;
}

function answer(manager: Manager, jobId: string, entry: Sent, choice: Choice, applyToAll = false): void {
  manager.decide(jobId, { decisionId: decisionIdOf(entry), choice, applyToAll });
}

const keysOf = (payload: Payload): string[] => Object.keys(payload).sort();

/** 관리자 오류를 종류·코드·문장으로 함께 확인한다. */
function assertManagerError(fn: () => void, code: string, message: RegExp): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof Error, `Error 가 아닌 것이 던져졌다: ${String(err)}`);
    assert.equal(err.name, 'FileJobManagerError');
    assert.equal((err as Error & { code?: string }).code, code);
    assert.match(err.message, message);
    return true;
  });
}

/** 어느 1초 창 [t, t+1000) 에서든 보고 수가 limit 이하인지. 넘은 첫 창을 돌려준다. */
function firstOverfullWindow(times: number[], limit: number): { start: number; count: number } | null {
  const sorted = [...times].sort((a, b) => a - b);
  let j = 0;
  for (let i = 0; i < sorted.length; i += 1) {
    if (j < i) j = i;
    while (j < sorted.length && sorted[j] < sorted[i] + SEC) j += 1;
    if (j - i > limit) return { start: sorted[i], count: j - i };
  }
  return null;
}

// ── FR-FOP-004 AC-3 · AC-4 : applyToAll 은 그 작업이 끝날 때까지만 ─────────────

test('applyToAll=true 로 답한 선택이 같은 작업의 남은 충돌에 적용되어 다시 묻지 않는다', async () => {
  const fs = new MemoryFs()
    .dir('/src').file('/src/a', 0x61).file('/src/b', 0x62).file('/src/c', 0x63)
    .dir('/dst').file('/dst/a', 0x11).file('/dst/b', 0x12).file('/dst/c', 0x13);
  await withManager(fs, async ({ manager, sent }) => {
    // 대조군: applyToAll 없이 답하면 같은 작업의 다음 충돌을 다시 묻는다. 이것이 없으면 플래그를 보지 않고
    // 첫 답을 늘 기억하는 관리자(사용자가 승인하지 않은 덮어쓰기)가 이 파일 전체를 통과한다.
    const control = manager.start({ sourceSessionId: 's1', spec: { operation: 'copy', sources: ['/src/a', '/src/b'], destDir: '/dst' } }).jobId;
    await until(() => decisionsOf(sent, control).length === 1, '대조군 첫 번째 충돌');
    answer(manager, control, decisionsOf(sent, control)[0], 'skip');
    await until(() => decisionsOf(sent, control).length > 1 || doneOf(sent, control).length > 0, '대조군 두 번째 질문 또는 done');
    assert.equal(decisionsOf(sent, control).length, 2, 'applyToAll 없이 답했는데 같은 작업의 다음 충돌을 묻지 않았다');
    answer(manager, control, decisionsOf(sent, control)[1], 'skip');
    await until(() => doneOf(sent, control).length > 0, '대조군 done');
    assert.deepEqual(fs.bytes('/dst/a'), Buffer.alloc(8, 0x11), '대조군이 목적지를 바꿨다');

    const { jobId } = manager.start({ sourceSessionId: 's1', spec: { operation: 'copy', sources: ['/src/a', '/src/b', '/src/c'], destDir: '/dst' } });
    await until(() => decisionsOf(sent, jobId).length === 1, '첫 번째 충돌');
    answer(manager, jobId, decisionsOf(sent, jobId)[0], 'overwrite', true);
    await until(() => doneOf(sent, jobId).length > 0 || decisionsOf(sent, jobId).length > 1, 'done 또는 두 번째 질문');
    const asked = decisionsOf(sent, jobId).map((d) => d.payload.path);
    assert.equal(asked.length, 1, `applyToAll=true 로 답했는데 같은 작업이 다시 물었다: ${JSON.stringify(asked)}`);
    assert.equal(doneOf(sent, jobId)[0].payload.outcome, 'completed');
    // 묻지 않았다는 것만으로는 부족하다 — 건너뛰어도 묻지 않는다. 기억한 선택(overwrite)이 실제로 적용됐다.
    assert.deepEqual(fs.bytes('/dst/b'), Buffer.alloc(8, 0x62));
    assert.deepEqual(fs.bytes('/dst/c'), Buffer.alloc(8, 0x63));
  });
});

test('같은 세션에서 동시에 도는 작업 A 가 applyToAll=true 로 답해도 작업 B 의 충돌은 decision-required 를 낸다', async () => {
  const fs = new MemoryFs()
    .dir('/a').file('/a/1', 0x31).file('/a/2', 0x32)
    .dir('/dA').file('/dA/1', 0x01).file('/dA/2', 0x02)
    .dir('/b').file('/b/0', 0x40).file('/b/1', 0x41)
    .dir('/dB').file('/dB/1', 0x03);
  const releaseB0 = fs.gate('/b/0');
  await withManager(fs, async ({ manager, sent }) => {
    // B 가 먼저 시작해 충돌 없는 /b/0 에 붙잡혀 있는 동안 A 가 applyToAll 로 답한다 — B 의 충돌은 그 뒤에 온다.
    const b = manager.start({ sourceSessionId: 's1', spec: { operation: 'copy', sources: ['/b/0', '/b/1'], destDir: '/dB' } }).jobId;
    await until(() => fs.copyCalls('/b/0') === 1, 'B 가 /b/0 복사 중');
    const a = manager.start({ sourceSessionId: 's1', spec: { operation: 'copy', sources: ['/a/1', '/a/2'], destDir: '/dA' } }).jobId;
    await until(() => decisionsOf(sent, a).length === 1, 'A 의 첫 번째 충돌');
    answer(manager, a, decisionsOf(sent, a)[0], 'overwrite', true);
    await until(() => doneOf(sent, a).length > 0 || decisionsOf(sent, a).length > 1, 'A 의 done 또는 두 번째 질문');
    // 대조군: A 안에서는 기억이 작동해야 한다. 아무것도 기억하지 않는 관리자는 B 가 묻는다는 단언을 공짜로 통과한다.
    assert.equal(decisionsOf(sent, a).length, 1, 'A 의 applyToAll 이 A 의 남은 충돌에 적용되지 않았다 — 아래 B 단언이 공허해진다');

    releaseB0();
    await until(() => decisionsOf(sent, b).length > 0 || doneOf(sent, b).length > 0, 'B 의 질문 또는 done');
    assert.equal(decisionsOf(sent, b).length, 1, 'A 의 applyToAll 이 같은 세션의 작업 B 로 번졌다 — B 가 묻지 않았다');
    assert.equal(doneOf(sent, b).length, 0, 'B 가 묻지 않고 끝났다');
    assert.deepEqual(fs.bytes('/dB/1'), Buffer.alloc(8, 0x03), 'B 가 묻기 전에 목적지를 건드렸다');
    answer(manager, b, decisionsOf(sent, b)[0], 'skip');
    await until(() => doneOf(sent, b).length > 0, 'B done');
  });
});

test('작업이 끝난 뒤 새 작업은 같은 충돌을 다시 묻는다', async () => {
  const fs = new MemoryFs()
    .dir('/s').file('/s/a', 0x61).file('/s/b', 0x62)
    .dir('/d').file('/d/a', 0x01).file('/d/b', 0x02);
  await withManager(fs, async ({ manager, sent }) => {
    const first = manager.start({ sourceSessionId: 's1', spec: { operation: 'copy', sources: ['/s/a', '/s/b'], destDir: '/d' } }).jobId;
    await until(() => decisionsOf(sent, first).length === 1, '첫 작업의 충돌');
    answer(manager, first, decisionsOf(sent, first)[0], 'overwrite', true);
    await until(() => doneOf(sent, first).length > 0 || decisionsOf(sent, first).length > 1, '첫 작업의 done 또는 두 번째 질문');
    // 대조군: 첫 작업 안에서 기억이 작동했다. 기억하지 않는 관리자는 아래 "다시 묻는다" 를 공짜로 통과한다.
    assert.equal(decisionsOf(sent, first).length, 1, '첫 작업의 applyToAll 이 적용되지 않았다 — 아래 단언이 공허해진다');
    assert.equal(doneOf(sent, first)[0].payload.outcome, 'completed');

    const second = manager.start({ sourceSessionId: 's1', spec: { operation: 'copy', sources: ['/s/a'], destDir: '/d' } }).jobId;
    await until(() => decisionsOf(sent, second).length > 0 || doneOf(sent, second).length > 0, '새 작업의 질문 또는 done');
    assert.equal(decisionsOf(sent, second).length, 1, '끝난 작업의 applyToAll 을 새 작업이 기억했다 — 묻지 않았다');
    answer(manager, second, decisionsOf(sent, second)[0], 'skip');
    await until(() => doneOf(sent, second).length > 0, '새 작업 done');
  });
});

// ── FR-FOP-004 AC-1 : 제자리 붙여넣기는 실패가 아니라 이름 바꾸기 충돌이다 ─────────

test('파일을 그 파일이 있던 폴더에 붙여넣으면 choices 가 rename·skip 뿐인 충돌이 되고 rename 은 이름 (2) 사본을 만든다', async () => {
  const fs = new MemoryFs().dir('/d').file('/d/a.txt', 0x61);
  await withManager(fs, async ({ manager, sent }) => {
    const { jobId } = manager.start({ sourceSessionId: 's1', spec: { operation: 'copy', sources: ['/d/a.txt'], destDir: '/d' } });
    await until(() => decisionsOf(sent, jobId).length > 0 || doneOf(sent, jobId).length > 0, '질문 또는 done');
    const done = doneOf(sent, jobId);
    assert.equal(
      decisionsOf(sent, jobId).length,
      1,
      `제자리 붙여넣기가 충돌로 묻지 않고 끝났다: ${JSON.stringify(done.map((d) => d.payload))}`,
    );
    const decision = decisionsOf(sent, jobId)[0];
    assert.equal(decision.payload.kind, 'conflict');
    assert.deepEqual(decision.payload.choices, ['rename', 'skip']);
    // 자기 자신 위로의 덮어쓰기는 원본을 비운다 — 질문에 없는 선택은 거부하고 질문은 열어 둔다.
    assertManagerError(() => answer(manager, jobId, decision, 'overwrite'), 'INVALID_CHOICE', /Unknown decision choice/);
    answer(manager, jobId, decision, 'rename');
    await until(() => doneOf(sent, jobId).length > 0, 'done');
    assert.equal(doneOf(sent, jobId)[0].payload.outcome, 'completed');
    assert.deepEqual(fs.bytes('/d/a (2).txt'), Buffer.alloc(8, 0x61), "'a (2).txt' 사본이 없거나 내용이 다르다");
    assert.deepEqual(fs.bytes('/d/a.txt'), Buffer.alloc(8, 0x61), '원본이 바뀌었다');
    assert.deepEqual(fs.list('/d'), ['a (2).txt', 'a.txt']);
  });
});

test('실제 디스크에서도 제자리 붙여넣기를 rename 으로 답하면 원본은 그대로이고 a (2).txt 가 생긴다', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bg-filejob-emit-'));
  try {
    const original = join(root, 'a.txt');
    await writeFile(original, 'hello');
    await withManager(nodeFileJobFsOps, async ({ manager, sent }) => {
      const { jobId } = manager.start({ sourceSessionId: 's1', spec: { operation: 'copy', sources: [original], destDir: root } });
      await untilReal(() => decisionsOf(sent, jobId).length > 0 || doneOf(sent, jobId).length > 0, '질문 또는 done');
      assert.equal(
        decisionsOf(sent, jobId).length,
        1,
        `제자리 붙여넣기가 충돌로 묻지 않고 끝났다: ${JSON.stringify(doneOf(sent, jobId).map((d) => d.payload))}`,
      );
      const decision = decisionsOf(sent, jobId)[0];
      assert.deepEqual(decision.payload.choices, ['rename', 'skip']);
      answer(manager, jobId, decision, 'rename');
      await untilReal(() => doneOf(sent, jobId).length > 0, 'done');
      assert.equal(doneOf(sent, jobId)[0].payload.outcome, 'completed');
    });
    assert.equal(await readFile(original, 'utf8'), 'hello', '원본이 바뀌었다');
    assert.equal(await readFile(join(root, 'a (2).txt'), 'utf8'), 'hello');
    assert.deepEqual((await readdir(root)).sort(), ['a (2).txt', 'a.txt']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── IR-FOP-002 AC-5 : 진행 보고 제한 ────────────────────────────────────────

test('진행 보고는 작업마다 1초 창에서 10회를 넘지 않고 마지막 값은 버려지지 않는다', async () => {
  const time = new FakeTime();
  const fs = new MemoryFs().dir('/src').dir('/dst').file('/src/held', 0x68);
  // big 은 1바이트씩 1000번 보고하며 보고마다 가짜 시계를 3ms 옮긴다 — 3초 동안 1000번 넘게 보고한다.
  fs.chunkedFile('/src/big', 1000, () => time.advance(3));
  const releaseHeld = fs.gate('/src/held');
  await withManager(
    fs,
    async ({ manager, sent }) => {
      const { jobId } = manager.start({ sourceSessionId: 's1', spec: { operation: 'copy', sources: ['/src/big', '/src/held'], destDir: '/dst' } });
      // big 의 복사는 보고마다 가짜 시계를 옮기느라 이벤트 루프를 오래 돈다 — 보고 1000번 × advance 한 번의
      // flush 20틱 ≈ 2만 틱이다. 제한 구현의 부기가 늘어도 넘치지 않게 열 배를 준다.
      await until(() => fs.copyCalls('/src/held') === 1, 'big 을 마치고 held 에 붙잡힘', 200_000);
      const duringBig = progressOf(sent, jobId).map((s) => s.at);
      // 하한: 3초 동안 막대가 멈춰 있으면 안 된다. 항목이 끝날 때만 보고하는 구현은 상한을 공짜로 통과한다.
      let widestGap = 0;
      for (let i = 1; i < duringBig.length; i += 1) widestGap = Math.max(widestGap, duringBig[i] - duringBig[i - 1]);
      // leading: 첫 보고는 창을 기다리지 않고 바로 나간다. trailing 만 쓰는 구현은 첫 100ms 동안 아무것도 보내지 않는다.
      assert.equal(duringBig[0], 0, `첫 진행 보고가 ${duringBig[0]}ms 에야 나갔다`);
      assert.ok(duringBig.length >= 10, `3초 전송 동안 진행 보고가 ${duringBig.length}회뿐이다`);
      assert.ok(widestGap <= 500, `전송 중 진행 보고 사이가 ${widestGap}ms 비었다 — 막대가 멈춰 보인다`);
      const overfull = firstOverfullWindow(duringBig, 10);
      assert.equal(
        overfull,
        null,
        `1초 창 하나에 진행 보고가 10회를 넘었다: ${JSON.stringify(overfull)} (총 ${progressOf(sent, jobId).length}회)`,
      );

      // big 을 마친 마지막 보고는 직전 보고와 100ms 안에 나서 창에 막혔을 수 있다. 창이 끝나면 반드시 나간다.
      await time.advance(SEC);
      const last = progressOf(sent, jobId).at(-1);
      assert.ok(last, '진행 보고가 하나도 없다');
      assert.equal(last.payload.processedEntries, 1, `창이 끝난 뒤에도 big 완료 보고가 나가지 않았다: ${JSON.stringify(last.payload)}`);
      assert.equal(last.payload.processedBytes, 1000);

      releaseHeld();
      await until(() => doneOf(sent, jobId).length > 0, 'done');
      // done 직전의 최종 진행(processed = total)은 창에 막혀 있더라도 done 보다 먼저 나가야 한다.
      const doneIndex = sent.indexOf(doneOf(sent, jobId)[0]);
      const before = sent.slice(0, doneIndex).filter((s) => s.event === 'file-job:progress' && s.payload.jobId === jobId);
      assert.ok(before.length > 0, '완료 직전 진행 보고가 없다');
      const final = before.at(-1)!.payload;
      assert.equal(final.processedEntries, final.totalEntries, `done 전에 최종 진행이 버려졌다: ${JSON.stringify(final)}`);
      assert.equal(final.processedBytes, final.totalBytes);
      assert.equal(final.totalBytes, 1008);

      // done 뒤에는 남은 trailing 보고가 나가지 않는다.
      const afterDone = sent.length;
      await time.advance(2 * SEC);
      assert.deepEqual(sent.slice(afterDone), [], 'done 뒤에 진행 보고가 나갔다');
      const whole = firstOverfullWindow(progressOf(sent, jobId).map((s) => s.at), 10);
      assert.equal(whole, null, `작업 전체에서 1초 창 하나에 10회를 넘었다: ${JSON.stringify(whole)}`);
    },
    time,
  );
});

test('dispose 는 창에 막혀 대기 중인 진행 보고의 타이머까지 거두고 그 뒤로 아무것도 보내지 않는다', async () => {
  const time = new FakeTime();
  const fs = new MemoryFs().dir('/src').dir('/dst').file('/src/held', 0x68);
  // 시계를 옮기지 않고 50번 보고한다 — 첫 보고만 나가고 나머지는 창에 막혀 trailing 으로 대기한다.
  fs.chunkedFile('/src/burst', 50, () => tick());
  fs.gate('/src/held');
  let afterDispose = -1;
  await withManager(
    fs,
    async ({ manager, sent }) => {
      manager.start({ sourceSessionId: 's1', spec: { operation: 'copy', sources: ['/src/burst', '/src/held'], destDir: '/dst' } });
      await until(() => fs.copyCalls('/src/held') === 1, 'burst 를 마치고 held 에 붙잡힘');
      manager.dispose();
      afterDispose = sent.length;
      await time.advance(2 * SEC);
      assert.equal(sent.length, afterDispose, 'dispose 뒤에 무언가 나갔다');
    },
    time,
  );
  assert.ok(afterDispose >= 0, '본문이 dispose 에 이르지 못했다');
  assert.equal(time.pending(), 0, `dispose 뒤에 타이머 ${time.pending()}개가 남았다`);
});

// ── IR-FOP-002 AC-2 · AC-3 · AC-4 : 페이로드 ────────────────────────────────

test('file-job:progress 페이로드 키가 jobId·phase·processedBytes·totalBytes·processedEntries·totalEntries·currentPath 다', async () => {
  const fs = new MemoryFs().dir('/src').file('/src/a', 0x61).dir('/dst');
  await withManager(fs, async ({ manager, sent, time }) => {
    const { jobId } = manager.start({ sourceSessionId: 's1', spec: { operation: 'copy', sources: ['/src/a'], destDir: '/dst' } });
    await until(() => doneOf(sent, jobId).length > 0, 'done');
    await time.advance(SEC);
    const progress = progressOf(sent, jobId);
    assert.ok(progress.length > 0, '진행 보고가 하나도 없다');
    const expected = ['currentPath', 'jobId', 'phase', 'processedBytes', 'processedEntries', 'totalBytes', 'totalEntries'];
    for (const p of progress) assert.deepEqual(keysOf(p.payload), expected, `progress 키 집합이 다르다: ${JSON.stringify(p.payload)}`);
  });
});

test('file-job:decision-required 페이로드가 jobId·decisionId·kind·path·detail·choices 를 싣는다', async () => {
  const fs = new MemoryFs().dir('/src').file('/src/x', 0x78).dir('/dst').file('/dst/x', 0x01);
  await withManager(fs, async ({ manager, sent }) => {
    const { jobId } = manager.start({ sourceSessionId: 's1', spec: { operation: 'copy', sources: ['/src/x'], destDir: '/dst' } });
    await until(() => decisionsOf(sent, jobId).length === 1, '충돌');
    const payload = decisionsOf(sent, jobId)[0].payload;
    assert.deepEqual(keysOf(payload), ['choices', 'decisionId', 'detail', 'jobId', 'kind', 'path'], `키 집합이 다르다: ${JSON.stringify(payload)}`);
    assert.equal(payload.kind, 'conflict');
    // 러너는 path.join 으로 경로를 만든다 — Windows 에서는 구분자가 역슬래시다.
    assert.equal(norm(String(payload.path)), '/dst/x');
    assert.notEqual(payload.detail, undefined, 'detail 이 undefined 다');
    assert.deepEqual(payload.choices, ['overwrite', 'rename', 'skip']);
    answer(manager, jobId, decisionsOf(sent, jobId)[0], 'skip');
    await until(() => doneOf(sent, jobId).length > 0, 'done');
  });
});

test('file-job:done 페이로드 키가 정확히 jobId·outcome·processedEntries·affectedDirectories 다 — atomic 은 싣지 않는다', async () => {
  // 같은 장치 이동 — 결과에 atomic: true 가 있는 경우라 그것을 흘려 싣고 싶어지는 자리다.
  const fs = new MemoryFs().dir('/src').file('/src/m', 0x6d).dir('/dst');
  await withManager(fs, async ({ manager, sent }) => {
    const { jobId } = manager.start({ sourceSessionId: 's1', spec: { operation: 'move', sources: ['/src/m'], destDir: '/dst' } });
    await until(() => doneOf(sent, jobId).length > 0, 'done');
    const payload = doneOf(sent, jobId)[0].payload;
    assert.deepEqual(keysOf(payload), ['affectedDirectories', 'jobId', 'outcome', 'processedEntries'], `done 키 집합이 다르다: ${JSON.stringify(payload)}`);
    assert.equal(payload.outcome, 'completed');
    assert.equal(payload.processedEntries, 1);
    assert.ok(Array.isArray(payload.affectedDirectories), 'affectedDirectories 가 배열이 아니다');
  });
});

/** done 의 affectedDirectories 를 꺼낸다. 순서는 계약이 아니다 — 중복 없음은 계약이다. */
function affectedOf(payload: Payload): string[] {
  const dirs = payload.affectedDirectories;
  assert.ok(Array.isArray(dirs), `affectedDirectories 가 배열이 아니다: ${JSON.stringify(payload)}`);
  assert.equal(new Set(dirs).size, dirs.length, `affectedDirectories 에 중복이 있다: ${JSON.stringify(dirs)}`);
  // 부모는 path.dirname 이 만든다 — Windows 에서 구분자가 역슬래시일 수 있어 비교 전에 맞춘다.
  return (dirs as string[]).map(norm).sort();
}

test('copy 의 done.affectedDirectories 는 목적지 디렉터리 하나다', async () => {
  const fs = new MemoryFs().dir('/s1').file('/s1/a', 0x61).file('/s1/b', 0x62).dir('/s2').file('/s2/c', 0x63).dir('/d');
  await withManager(fs, async ({ manager, sent }) => {
    const { jobId } = manager.start({ sourceSessionId: 's1', spec: { operation: 'copy', sources: ['/s1/a', '/s1/b', '/s2/c'], destDir: '/d' } });
    await until(() => doneOf(sent, jobId).length > 0, 'done');
    assert.deepEqual(affectedOf(doneOf(sent, jobId)[0].payload), ['/d']);
  });
});

test('move 의 done.affectedDirectories 는 목적지와 출발지들의 부모다 — 중복 없이', async () => {
  const fs = new MemoryFs().dir('/s1').file('/s1/a', 0x61).file('/s1/b', 0x62).dir('/s2').dir('/s2/sub').file('/s2/sub/c', 0x63).dir('/d');
  await withManager(fs, async ({ manager, sent }) => {
    const { jobId } = manager.start({ sourceSessionId: 's1', spec: { operation: 'move', sources: ['/s1/a', '/s1/b', '/s2/sub'], destDir: '/d' } });
    await until(() => doneOf(sent, jobId).length > 0, 'done');
    assert.equal(doneOf(sent, jobId)[0].payload.outcome, 'completed');
    assert.deepEqual(affectedOf(doneOf(sent, jobId)[0].payload), ['/d', '/s1', '/s2']);
  });
});

test('delete 의 done.affectedDirectories 는 출발지들의 부모다 — 중복 없이', async () => {
  const fs = new MemoryFs().dir('/s1').file('/s1/a', 0x61).file('/s1/b', 0x62).dir('/s2').dir('/s2/sub').file('/s2/sub/c', 0x63);
  await withManager(fs, async ({ manager, sent }) => {
    const { jobId } = manager.start({ sourceSessionId: 's1', spec: { operation: 'delete', sources: ['/s1/a', '/s1/b', '/s2/sub'] } });
    await until(() => doneOf(sent, jobId).length > 0, 'done');
    assert.equal(doneOf(sent, jobId)[0].payload.outcome, 'completed');
    assert.deepEqual(affectedOf(doneOf(sent, jobId)[0].payload), ['/s1', '/s2']);
  });
});

// ── IR-FOP-002 AC-1 : 두 세션 ────────────────────────────────────────────────

test('출발지·목적지 세션이 다르면 file-job:* 이벤트를 두 세션 모두에 보낸다', async () => {
  const fs = new MemoryFs().dir('/src').file('/src/x', 0x78).file('/src/y', 0x79).dir('/dst').file('/dst/x', 0x01);
  await withManager(fs, async ({ manager, sent, time }) => {
    const { jobId } = manager.start({ sourceSessionId: 's1', destSessionId: 's2', spec: { operation: 'copy', sources: ['/src/x', '/src/y'], destDir: '/dst' } });
    await until(() => decisionsOf(sent, jobId).length > 0, '충돌');
    answer(manager, jobId, decisionsOf(sent, jobId)[0], 'overwrite');
    await until(() => doneOf(sent, jobId).length > 0, 'done');
    await time.advance(SEC);
    assert.deepEqual([...new Set(sent.map((s) => s.sessionId))].sort(), ['s1', 's2'], '두 세션 밖으로 보냈거나 한쪽이 빠졌다');
    for (const event of ['file-job:progress', 'file-job:decision-required', 'file-job:done'] as const) {
      const toS1 = ofJob(sent, event, jobId).filter((s) => s.sessionId === 's1').map((s) => s.payload);
      const toS2 = ofJob(sent, event, jobId).filter((s) => s.sessionId === 's2').map((s) => s.payload);
      assert.ok(toS1.length > 0, `${event} 를 출발지 세션에 보내지 않았다`);
      assert.deepEqual(toS2, toS1, `${event} 가 두 세션에 같은 페이로드로 나가지 않았다`);
    }
  });
});

// ── FR-FOP-005 AC-4 : 취소 시 끝난 항목 수 ───────────────────────────────────

test('N개 파일을 마친 뒤 취소하면 file-job:done 의 processedEntries 가 정확히 N 이다', async () => {
  const fs = new MemoryFs()
    .dir('/src').file('/src/a', 0x61).file('/src/b', 0x62).file('/src/c', 0x63).file('/src/d', 0x64).file('/src/e', 0x65)
    .dir('/dst');
  fs.gate('/src/d');
  await withManager(fs, async ({ manager, sent }) => {
    const { jobId } = manager.start({
      sourceSessionId: 's1',
      spec: { operation: 'copy', sources: ['/src/a', '/src/b', '/src/c', '/src/d', '/src/e'], destDir: '/dst' },
    });
    await until(() => fs.copyCalls('/src/d') === 1, 'a·b·c 를 마치고 d 복사 중');
    manager.cancel(jobId);
    await until(() => doneOf(sent, jobId).length > 0, 'done');
    const payload = doneOf(sent, jobId)[0].payload;
    assert.equal(payload.outcome, 'cancelled');
    assert.equal(payload.processedEntries, 3, `끝난 항목 수가 아니다: ${JSON.stringify(payload)}`);
    // 숫자만 맞고 실제로는 다른 상태인 경우를 거른다 — 끝난 세 파일은 남고 쓰던 d 는 지워졌다.
    assert.deepEqual(fs.list('/dst'), ['a', 'b', 'c']);
  });
});

// ── decide·start 거부 코드 (T-PH002-02 가 더한 것을 유지) ─────────────────────────

test('지금 대기 중인 것이 아닌 decisionId 로 답하면 DECISION_MISMATCH 로 거부하고 질문은 열려 있다', async () => {
  const fs = new MemoryFs().dir('/src').file('/src/x', 0x78).dir('/dst').file('/dst/x', 0x01);
  await withManager(fs, async ({ manager, sent }) => {
    const { jobId } = manager.start({ sourceSessionId: 's1', spec: { operation: 'copy', sources: ['/src/x'], destDir: '/dst' } });
    await until(() => decisionsOf(sent, jobId).length === 1, '충돌');
    assertManagerError(
      () => manager.decide(jobId, { decisionId: 'not-the-pending-one', choice: 'overwrite' }),
      'DECISION_MISMATCH',
      /Decision does not match the pending one/,
    );
    assert.deepEqual(fs.bytes('/dst/x'), Buffer.alloc(8, 0x01), '거부된 답이 적용됐다');
    answer(manager, jobId, decisionsOf(sent, jobId)[0], 'skip');
    await until(() => doneOf(sent, jobId).length > 0, 'done');
    assert.equal(doneOf(sent, jobId)[0].payload.outcome, 'completed');
  });
});

test('모르는 choice 로 답하면 INVALID_CHOICE 로 거부하고 같은 질문에 다시 답할 수 있다', async () => {
  const fs = new MemoryFs().dir('/src').file('/src/x', 0x78).dir('/dst').file('/dst/x', 0x01);
  await withManager(fs, async ({ manager, sent }) => {
    const { jobId } = manager.start({ sourceSessionId: 's1', spec: { operation: 'copy', sources: ['/src/x'], destDir: '/dst' } });
    await until(() => decisionsOf(sent, jobId).length === 1, '충돌');
    const decision = decisionsOf(sent, jobId)[0];
    assertManagerError(
      () => manager.decide(jobId, { decisionId: decisionIdOf(decision), choice: 'explode' as Choice }),
      'INVALID_CHOICE',
      /Unknown decision choice: explode/,
    );
    // 질문이 열려 있다 — 재전송이 같은 decisionId 로 나가고, 그 id 로 답이 받아들여진다.
    const before = sent.length;
    manager.resendPendingDecisions('s1');
    assert.equal(sent.length - before, 1, '거부 뒤 질문이 닫혔다 — 재전송이 없다');
    assert.equal(sent[before].payload.decisionId, decision.payload.decisionId);
    answer(manager, jobId, decision, 'overwrite');
    await until(() => doneOf(sent, jobId).length > 0, 'done');
    assert.equal(doneOf(sent, jobId)[0].payload.outcome, 'completed');
    assert.deepEqual(fs.bytes('/dst/x'), Buffer.alloc(8, 0x78));
  });
});

test('dispose 뒤의 start 는 MANAGER_DISPOSED 로 거부하고 아무것도 보내지 않는다', async () => {
  const fs = new MemoryFs().dir('/src').file('/src/x', 0x78).dir('/dst');
  await withManager(fs, async ({ manager, sent }) => {
    manager.dispose();
    assertManagerError(
      () => manager.start({ sourceSessionId: 's1', spec: { operation: 'copy', sources: ['/src/x'], destDir: '/dst' } }),
      'MANAGER_DISPOSED',
      /File job manager is disposed/,
    );
    await flush();
    assert.deepEqual(sent, []);
    assert.equal(fs.copyCalls('/src/x'), 0);
  });
});

// ── FR-FOP-004 : 제자리 이동은 아무 일도 하지 않고, 종류가 다른 충돌에는 덮어쓰기가 없다 ─────
//
// 제자리 이동(출발지 === 목적지)은 이미 사용자가 원한 곳에 있다. 묻거나 이름을 바꾸면 사용자가
// 고른 적 없는 사본·이름이 생기므로 처리한 항목으로만 세고 끝낸다. 제자리 복사는 사본을 만드는
// 것이 뜻이므로 그대로 rename·skip 충돌이다.
//
// 파일 ↔ 디렉터리 충돌에서 overwrite 는 늘 ENOTDIR/EISDIR 로 실패한다. 선택지에 없어야 하고,
// applyToAll 로 기억한 overwrite 가 그 충돌에 적용되어 작업 전체를 실패시키면 안 된다.

test('파일을 그 파일이 있는 폴더로 이동하면 묻지 않고 원본을 그대로 둔 채 완료하고 처리 항목으로 센다', async () => {
  const fs = new MemoryFs().dir('/d').file('/d/a.txt', 0x61);
  await withManager(fs, async ({ manager, sent }) => {
    const { jobId } = manager.start({ sourceSessionId: 's1', spec: { operation: 'move', sources: ['/d/a.txt'], destDir: '/d' } });
    await until(() => decisionsOf(sent, jobId).length > 0 || doneOf(sent, jobId).length > 0, '질문 또는 done');
    assert.deepEqual(
      decisionsOf(sent, jobId).map((d) => d.payload.choices),
      [],
      '제자리 이동이 충돌로 물었다',
    );
    const done = doneOf(sent, jobId);
    assert.equal(done.length, 1);
    assert.equal(done[0].payload.outcome, 'completed');
    assert.equal(done[0].payload.processedEntries, 1, '제자리 이동이 처리 항목으로 세어지지 않았다');
    assert.deepEqual(fs.bytes('/d/a.txt'), Buffer.alloc(8, 0x61), '원본이 바뀌었다');
    assert.deepEqual(fs.list('/d'), ['a.txt'], '제자리 이동이 무언가를 만들거나 지웠다');
  });
});

test('디렉터리를 그 디렉터리가 있는 폴더로 이동해도 묻지 않고 트리를 그대로 둔 채 모든 항목을 처리로 센다', async () => {
  const fs = new MemoryFs().dir('/d').dir('/d/sub').file('/d/sub/k', 0x6b);
  await withManager(fs, async ({ manager, sent }) => {
    const { jobId } = manager.start({ sourceSessionId: 's1', spec: { operation: 'move', sources: ['/d/sub'], destDir: '/d' } });
    await until(() => decisionsOf(sent, jobId).length > 0 || doneOf(sent, jobId).length > 0, '질문 또는 done');
    assert.equal(decisionsOf(sent, jobId).length, 0, '제자리 디렉터리 이동이 충돌로 물었다');
    const done = doneOf(sent, jobId);
    assert.equal(done[0].payload.outcome, 'completed');
    assert.equal(done[0].payload.processedEntries, 2);
    assert.deepEqual(fs.list('/d'), ['sub']);
    assert.deepEqual(fs.bytes('/d/sub/k'), Buffer.alloc(8, 0x6b));
  });
});

test('실제 디스크에서도 제자리 이동은 묻지 않고 원본을 그대로 둔 채 완료한다', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bg-filejob-inplace-move-'));
  try {
    const original = join(root, 'a.txt');
    await writeFile(original, 'hello');
    await withManager(nodeFileJobFsOps, async ({ manager, sent }) => {
      const { jobId } = manager.start({ sourceSessionId: 's1', spec: { operation: 'move', sources: [original], destDir: root } });
      await untilReal(() => decisionsOf(sent, jobId).length > 0 || doneOf(sent, jobId).length > 0, '질문 또는 done');
      assert.equal(decisionsOf(sent, jobId).length, 0, '제자리 이동이 충돌로 물었다');
      const done = doneOf(sent, jobId);
      assert.equal(done[0].payload.outcome, 'completed');
      assert.equal(done[0].payload.processedEntries, 1);
    });
    assert.equal(await readFile(original, 'utf8'), 'hello', '원본이 바뀌었다');
    assert.deepEqual(await readdir(root), ['a.txt']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('제자리 디렉터리 복사는 여전히 rename·skip 충돌로 묻는다', async () => {
  const fs = new MemoryFs().dir('/d').dir('/d/sub').file('/d/sub/k', 0x6b);
  await withManager(fs, async ({ manager, sent }) => {
    const { jobId } = manager.start({ sourceSessionId: 's1', spec: { operation: 'copy', sources: ['/d/sub'], destDir: '/d' } });
    await until(() => decisionsOf(sent, jobId).length > 0 || doneOf(sent, jobId).length > 0, '질문 또는 done');
    assert.equal(decisionsOf(sent, jobId).length, 1, '제자리 복사가 묻지 않고 끝났다');
    assert.deepEqual(decisionsOf(sent, jobId)[0].payload.choices, ['rename', 'skip']);
    answer(manager, jobId, decisionsOf(sent, jobId)[0], 'skip');
    await until(() => doneOf(sent, jobId).length > 0, 'done');
    assert.deepEqual(fs.list('/d'), ['sub']);
  });
});

test('파일을 같은 이름의 디렉터리가 있는 곳에 복사하면 choices 가 rename·skip 이고 overwrite 는 INVALID_CHOICE, rename 은 x (2) 를 만든다', async () => {
  const fs = new MemoryFs().dir('/s').file('/s/x', 0x78).dir('/d').dir('/d/x').file('/d/x/keep', 0x01);
  await withManager(fs, async ({ manager, sent }) => {
    const { jobId } = manager.start({ sourceSessionId: 's1', spec: { operation: 'copy', sources: ['/s/x'], destDir: '/d' } });
    await until(() => decisionsOf(sent, jobId).length > 0 || doneOf(sent, jobId).length > 0, '질문 또는 done');
    assert.equal(decisionsOf(sent, jobId).length, 1);
    const decision = decisionsOf(sent, jobId)[0];
    assert.deepEqual(decision.payload.choices, ['rename', 'skip'], '파일→디렉터리 충돌이 늘 실패하는 overwrite 를 내놓았다');
    assertManagerError(() => answer(manager, jobId, decision, 'overwrite'), 'INVALID_CHOICE', /Unknown decision choice/);
    // 거부 뒤에도 같은 질문에 답할 수 있다.
    answer(manager, jobId, decision, 'rename');
    await until(() => doneOf(sent, jobId).length > 0, 'done');
    assert.equal(doneOf(sent, jobId)[0].payload.outcome, 'completed');
    assert.deepEqual(fs.bytes('/d/x (2)'), Buffer.alloc(8, 0x78));
    assert.deepEqual(fs.bytes('/d/x/keep'), Buffer.alloc(8, 0x01), '기존 디렉터리가 바뀌었다');
  });
});

test('디렉터리를 같은 이름의 파일이 있는 곳으로 이동하면 choices 가 rename·skip 이고 overwrite 는 INVALID_CHOICE, rename 은 x (2) 로 옮긴다', async () => {
  const fs = new MemoryFs().dir('/s').dir('/s/x').file('/s/x/k', 0x6b).dir('/d').file('/d/x', 0x01);
  await withManager(fs, async ({ manager, sent }) => {
    const { jobId } = manager.start({ sourceSessionId: 's1', spec: { operation: 'move', sources: ['/s/x'], destDir: '/d' } });
    await until(() => decisionsOf(sent, jobId).length > 0 || doneOf(sent, jobId).length > 0, '질문 또는 done');
    assert.equal(decisionsOf(sent, jobId).length, 1);
    const decision = decisionsOf(sent, jobId)[0];
    assert.deepEqual(decision.payload.choices, ['rename', 'skip'], '디렉터리→파일 충돌이 늘 실패하는 overwrite 를 내놓았다');
    assertManagerError(() => answer(manager, jobId, decision, 'overwrite'), 'INVALID_CHOICE', /Unknown decision choice/);
    answer(manager, jobId, decision, 'rename');
    await until(() => doneOf(sent, jobId).length > 0, 'done');
    assert.equal(doneOf(sent, jobId)[0].payload.outcome, 'completed');
    assert.deepEqual(fs.bytes('/d/x (2)/k'), Buffer.alloc(8, 0x6b));
    assert.deepEqual(fs.bytes('/d/x'), Buffer.alloc(8, 0x01), '기존 파일이 바뀌었다');
    assert.deepEqual(fs.list('/s'), [], '이동한 출발지가 남았다');
  });
});

test('일반 충돌에서 applyToAll 로 기억한 overwrite 는 같은 작업의 종류가 다른 충돌에 적용되지 않고 다시 묻는다', async () => {
  const fs = new MemoryFs()
    .dir('/s').file('/s/a', 0x61).file('/s/x', 0x78)
    .dir('/d').file('/d/a', 0x01).dir('/d/x');
  await withManager(fs, async ({ manager, sent }) => {
    const { jobId } = manager.start({ sourceSessionId: 's1', spec: { operation: 'copy', sources: ['/s/a', '/s/x'], destDir: '/d' } });
    await until(() => decisionsOf(sent, jobId).length === 1, '첫 번째(일반) 충돌');
    assert.deepEqual(decisionsOf(sent, jobId)[0].payload.choices, ['overwrite', 'rename', 'skip']);
    answer(manager, jobId, decisionsOf(sent, jobId)[0], 'overwrite', true);
    await until(() => decisionsOf(sent, jobId).length > 1 || doneOf(sent, jobId).length > 0, '두 번째 질문 또는 done');
    const done = doneOf(sent, jobId);
    assert.equal(
      decisionsOf(sent, jobId).length,
      2,
      `기억한 overwrite 가 종류가 다른 충돌에 적용되었다: ${JSON.stringify(done.map((d) => d.payload))}`,
    );
    // 대조군: 기억한 overwrite 가 일반 충돌에는 실제로 적용되었다.
    assert.deepEqual(fs.bytes('/d/a'), Buffer.alloc(8, 0x61));
    const second = decisionsOf(sent, jobId)[1];
    assert.equal(norm(String(second.payload.path)), '/d/x');
    assert.deepEqual(second.payload.choices, ['rename', 'skip']);
    answer(manager, jobId, second, 'skip');
    await until(() => doneOf(sent, jobId).length > 0, 'done');
    assert.equal(doneOf(sent, jobId)[0].payload.outcome, 'completed');
  });
});

test('러너를 직접 쓰는 호출자가 종류가 다른 충돌에 overwrite 를 돌려주면 목적지를 건드리지 않고 EINVAL 로 실패한다', async () => {
  const fs = new MemoryFs().dir('/s').file('/s/x', 0x78).dir('/d').dir('/d/x');
  const asked: unknown[] = [];
  const result = await runJob(
    { operation: 'copy', sources: ['/s/x'], destDir: '/d' },
    {
      fsOps: fs,
      validatePath: () => {},
      decide: async (req) => {
        asked.push(req.choices);
        return { choice: 'overwrite' };
      },
      onProgress: () => {},
    },
  );
  assert.deepEqual(asked, [['rename', 'skip']], '러너가 종류가 다른 충돌에 overwrite 를 선택지로 내놓았다');
  assert.equal(result.outcome, 'failed');
  assert.equal((result.error as { code?: string } | undefined)?.code, 'EINVAL');
  assert.deepEqual(fs.list('/d'), ['x']);
  assert.deepEqual(fs.list('/d/x'), []);
});

// ── FR-FOP-004 : applyToAll 은 질문의 종류마다 따로 기억한다 ───────────────────

test('링크 오류 질문에 applyToAll=true 로 skip 을 고르면 같은 종류의 오류에만 적용되고 뒤의 충돌 질문은 다시 묻는다', async () => {
  const { FileJobManager } = await load();
  const time = new FakeTime();
  const sent: Sent[] = [];
  const answers: string[] = [];
  // 러너 대역: 오류 → 충돌 → 오류 순으로 묻는다. 결정의 범위만 보려는 것이라 디스크는 쓰지 않는다.
  const stubRun = async (_spec: FileJobSpec, deps: FileJobRunnerDeps): Promise<FileJobResult> => {
    // 관리자는 러너가 알린 상태로 답을 받을지 정한다 — 실제 러너처럼 묻는 동안 awaiting-decision 을 알린다.
    const ask = async (kind: 'error' | 'conflict', path: string, choices: Choice[]): Promise<void> => {
      deps.onStateChange?.('awaiting-decision');
      try {
        answers.push(`${kind}:${(await deps.decide({ kind, path, choices })).choice}`);
      } finally {
        deps.onStateChange?.('running');
      }
    };
    await ask('error', '/s/link1', ['skip']);
    await ask('conflict', '/d/a', ['overwrite', 'rename', 'skip']);
    await ask('error', '/s/link2', ['skip']);
    return { outcome: 'completed', processedEntries: 3 };
  };
  const manager = new FileJobManager({
    runJob: stubRun,
    fsOps: new MemoryFs(),
    broadcast: (sessionId, event, payload) => {
      sent.push({ sessionId, event, payload, at: time.nowMs });
    },
    clock: time.clock,
    timers: time.timers,
    validatePathFor: () => () => {},
  });
  try {
    const { jobId } = manager.start({ sourceSessionId: 's1', spec: { operation: 'copy', sources: ['/s/link1'], destDir: '/d' } });
    await until(() => decisionsOf(sent, jobId).length === 1, '첫 번째 링크 오류');
    assert.equal(decisionsOf(sent, jobId)[0].payload.kind, 'error');
    answer(manager, jobId, decisionsOf(sent, jobId)[0], 'skip', true);
    await until(() => decisionsOf(sent, jobId).length > 1 || doneOf(sent, jobId).length > 0, '충돌 질문 또는 done');
    assert.equal(doneOf(sent, jobId).length, 0, `오류에 고른 skip-for-all 이 충돌을 묻지 않고 건너뛰었다: ${JSON.stringify(answers)}`);
    const conflict = decisionsOf(sent, jobId)[1];
    assert.equal(conflict.payload.kind, 'conflict');
    answer(manager, jobId, conflict, 'overwrite');
    await until(() => doneOf(sent, jobId).length > 0 || decisionsOf(sent, jobId).length > 2, 'done 또는 세 번째 질문');
    // 대조군: 같은 종류(오류)에는 기억한 답이 그대로 적용된다 — 아무것도 기억하지 않는 관리자가 통과하지 못하게.
    assert.equal(decisionsOf(sent, jobId).length, 2, '같은 종류의 두 번째 링크 오류를 다시 물었다');
    assert.deepEqual(answers, ['error:skip', 'conflict:overwrite', 'error:skip']);
  } finally {
    manager.dispose();
  }
});
