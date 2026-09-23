// FR-FOP-005 — 취소·이동 의미론 (주입형 가짜 fs).
//
// 계약(T-PH001-06 이 이 형태로 구현한다). fileJobRunner.test.ts 의 계약에 더해:
//   FileJobResult = { outcome, processedEntries, error?, atomic?: boolean }
//     - 취소되면 outcome 'cancelled'. 실패('failed')가 아니다 — 사용자가 고른 결과다.
//     - processedEntries 는 실제로 끝난 항목 수다(취소 순간 쓰던 파일은 세지 않는다).
//     - move 가 같은 장치 안의 rename 으로 끝났으면 atomic: true. 파일 단위로 옮겼으면 true 가 아니다.
//   취소(deps.signal abort):
//     - 이미 끝난 파일은 건드리지 않는다. 되돌리기(끝난 사본 삭제·역방향 rename)는 없다.
//     - 취소 순간 쓰던 파일 하나 — copyFileStream 에 dst 로 넘긴 경로 — 만 unlink 한다.
//       그 경로가 임시 이름이어도 된다. 정리는 copyFileStream 이 settle 된 뒤에 한다.
//     - 취소 뒤에는 새 파일 복사를 시작하지 않는다(파일 사이의 취소도 즉시 먹는다).
//   move:
//     - 출발지 최상위마다 rename 을 먼저 시도한다. 성공하면 그 항목은 그것으로 끝이다.
//     - rename 이 EXDEV 를 던지면 파일마다 "복사 → 그 파일의 원본 unlink" 를 하고, 디렉터리는
//       자식이 모두 끝난 뒤 rmdir 한다. 전체 복사 후 전체 삭제로 하지 않는다.
//
// 가짜 fs 는 실제 스트림을 흉내 낸다: copyFileStream 은 signal 이 abort 되면 AbortError 로
// reject 하고, 이미 abort 된 signal 로 불려도 목적지를 먼저 만든 뒤 reject 한다(createWriteStream
// 이 여는 순간 파일이 생기는 것과 같다). 복사가 settle 되기 전의 목적지 unlink 는 EBUSY 로
// 실패한다(Windows 에서 열린 쓰기 스트림 아래 unlink 가 그렇다). 관대한 가짜는 정리 순서가
// 틀린 러너도 통과시킨다.
//
// 모듈은 테스트마다 동적으로 import 한다 — 부재가 러너 사망이 아니라 이름 붙은 실패로
// 드러나게 하려는 것이다(fileJobRunner.test.ts 와 같은 이유).
import test from 'node:test';
import assert from 'node:assert/strict';

type FileJobState =
  | 'queued'
  | 'running'
  | 'awaiting-decision'
  | 'completed'
  | 'cancelled'
  | 'failed';

interface FsStat {
  kind: 'file' | 'directory';
  size: number;
}

interface FileJobFsOps {
  lstat(p: string): Promise<FsStat | null>;
  readdir(p: string): Promise<string[]>;
  mkdir(p: string): Promise<void>;
  copyFileStream(
    src: string,
    dst: string,
    onBytes: (n: number) => void,
    signal?: AbortSignal,
  ): Promise<void>;
  unlink(p: string): Promise<void>;
  rmdir(p: string): Promise<void>;
  rename(src: string, dst: string): Promise<void>;
}

interface FileJobProgress {
  phase: 'scanning' | 'transferring';
  processedBytes: number;
  totalBytes: number;
  processedEntries: number;
  totalEntries: number;
  currentPath: string | null;
}

interface FileJobSpec {
  operation: 'copy' | 'move' | 'delete';
  sources: string[];
  destDir?: string;
}

interface FileJobRunnerDeps {
  fsOps: FileJobFsOps;
  validatePath: (p: string) => void | Promise<void>;
  decide: (req: { kind: 'conflict'; path: string }) => Promise<{ choice: 'overwrite' | 'rename' | 'skip' }>;
  onProgress: (p: FileJobProgress) => void;
  onStateChange?: (s: FileJobState) => void;
  signal?: AbortSignal;
}

interface FileJobResult {
  outcome: 'completed' | 'cancelled' | 'failed';
  processedEntries: number;
  error?: unknown;
  atomic?: boolean;
}

async function load(): Promise<{ runJob(spec: FileJobSpec, deps: FileJobRunnerDeps): Promise<FileJobResult> }> {
  return (await import('./fileJobRunner.js')) as unknown as {
    runJob(spec: FileJobSpec, deps: FileJobRunnerDeps): Promise<FileJobResult>;
  };
}

const norm = (p: string): string => p.replace(/\\/g, '/');
const parentOf = (p: string): string => {
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
};
/** '/src/d/x' → '/src'. 가짜의 "장치" 경계다. */
const topOf = (p: string): string => `/${p.split('/')[1] ?? ''}`;

type Node = { kind: 'file'; data: Buffer } | { kind: 'directory' };

type CopyCall = { op: 'copy-call'; src: string; path: string };

type LogEntry =
  | { op: 'lstat' | 'readdir' | 'mkdir' | 'unlink' | 'rmdir'; path: string }
  | CopyCall
  | { op: 'copy-done' | 'copy-aborted'; src: string; path: string }
  | { op: 'rename'; src: string; path: string; ok: boolean }
  | { op: 'abort' };

function fsError(code: string, p: string): Error {
  const err = new Error(`${code}: ${p}`) as Error & { code: string };
  err.code = code;
  return err;
}

// node:stream pipeline 이 signal 로 끊길 때 던지는 것과 같은 모양.
function abortError(): Error {
  const err = new Error('The operation was aborted') as Error & { code: string };
  err.name = 'AbortError';
  err.code = 'ABORT_ERR';
  return err;
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

class MemoryFs implements FileJobFsOps {
  readonly nodes = new Map<string, Node>();
  readonly log: LogEntry[] = [];
  /** 쓰기 스트림이 열려 있는 목적지. */
  private readonly busy = new Set<string>();
  /** true 면 최상위 디렉터리가 다른 두 경로 사이의 rename 이 EXDEV 를 던진다. */
  exdev = false;
  /** 청크를 쓴 직후 불린다. 테스트가 여기서 abort 한다. */
  onChunk: (src: string, chunkIndex: number) => void = () => {};

  constructor(private readonly chunkSize: number) {
    this.nodes.set('/', { kind: 'directory' });
  }

  dir(p: string): this {
    this.nodes.set(p, { kind: 'directory' });
    return this;
  }

  file(p: string, size: number, fill: number): this {
    this.nodes.set(p, { kind: 'file', data: Buffer.alloc(size, fill) });
    return this;
  }

  bytes(p: string): Buffer | undefined {
    const node = this.nodes.get(p);
    return node && node.kind === 'file' ? node.data : undefined;
  }

  /** 디렉터리 바로 아래 이름. 임시 파일 잔재를 잡으려고 정확한 집합으로 비교한다. */
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

  private requireDir(p: string): void {
    const node = this.nodes.get(p);
    if (!node) throw fsError('ENOENT', p);
    if (node.kind !== 'directory') throw fsError('ENOTDIR', p);
  }

  async lstat(raw: string): Promise<FsStat | null> {
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

  async copyFileStream(
    rawSrc: string,
    rawDst: string,
    onBytes: (n: number) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const src = norm(rawSrc);
    const dst = norm(rawDst);
    // 호출 자체를 먼저 적는다 — 취소 뒤에 새 복사를 "시도" 했는지가 판정 대상이다.
    this.log.push({ op: 'copy-call', src, path: dst });
    const node = this.nodes.get(src);
    if (!node || node.kind !== 'file') throw fsError('ENOENT', src);
    this.requireDir(parentOf(dst));
    const existing = this.nodes.get(dst);
    if (existing && existing.kind === 'directory') throw fsError('EISDIR', dst);
    // 여는 순간 목적지가 잘린 빈 파일이 된다 — 실제 createWriteStream 과 같다.
    this.nodes.set(dst, { kind: 'file', data: Buffer.alloc(0) });
    this.busy.add(dst);
    try {
      const chunks: Buffer[] = [];
      let index = 0;
      for (let offset = 0; offset < node.data.length; offset += this.chunkSize) {
        if (signal?.aborted) throw abortError();
        await tick();
        if (signal?.aborted) throw abortError();
        const chunk = node.data.subarray(offset, offset + this.chunkSize);
        chunks.push(chunk);
        this.nodes.set(dst, { kind: 'file', data: Buffer.concat(chunks) });
        onBytes(chunk.length);
        this.onChunk(src, index);
        index += 1;
      }
      if (signal?.aborted) throw abortError();
      this.log.push({ op: 'copy-done', src, path: dst });
    } catch (err) {
      this.log.push({ op: 'copy-aborted', src, path: dst });
      throw err;
    } finally {
      this.busy.delete(dst);
    }
  }

  async unlink(raw: string): Promise<void> {
    const p = norm(raw);
    this.log.push({ op: 'unlink', path: p });
    if (this.busy.has(p)) throw fsError('EBUSY', p);
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
    if (this.exdev && topOf(src) !== topOf(dst)) {
      this.log.push({ op: 'rename', src, path: dst, ok: false });
      throw fsError('EXDEV', `${src} -> ${dst}`);
    }
    if (!this.nodes.has(src)) throw fsError('ENOENT', src);
    if (this.busy.has(src) || this.busy.has(dst)) throw fsError('EBUSY', src);
    this.requireDir(parentOf(dst));
    this.log.push({ op: 'rename', src, path: dst, ok: true });
    const moved: Array<[string, Node]> = [];
    for (const [key, node] of this.nodes) {
      if (key === src || key.startsWith(`${src}/`)) moved.push([key, node]);
    }
    for (const [key] of moved) this.nodes.delete(key);
    for (const [key, node] of moved) this.nodes.set(dst + key.slice(src.length), node);
  }
}

const CHUNK = 64;

function deps(fs: MemoryFs, controller: AbortController, overrides: Partial<FileJobRunnerDeps> = {}): FileJobRunnerDeps {
  return {
    fsOps: fs,
    validatePath: () => {},
    decide: async () => ({ choice: 'skip' }),
    onProgress: () => {},
    signal: controller.signal,
    ...overrides,
  };
}

/** 세 파일(각 3청크)을 /dst 로 복사하다가 b.bin 첫 청크 직후 취소한다. */
async function copyCancelledDuringB(): Promise<{ fs: MemoryFs; result: FileJobResult }> {
  const { runJob } = await load();
  const fs = new MemoryFs(CHUNK)
    .dir('/src')
    .file('/src/a.bin', CHUNK * 3, 0x61)
    .file('/src/b.bin', CHUNK * 3, 0x62)
    .file('/src/c.bin', CHUNK * 3, 0x63)
    .dir('/dst');
  const controller = new AbortController();
  fs.onChunk = (src, index) => {
    if (src === '/src/b.bin' && index === 0) {
      fs.log.push({ op: 'abort' });
      controller.abort();
    }
  };
  const result = await runJob(
    { operation: 'copy', sources: ['/src/a.bin', '/src/b.bin', '/src/c.bin'], destDir: '/dst' },
    deps(fs, controller),
  );
  return { fs, result };
}

/** 취소 순간 쓰던 파일 — b.bin 을 넘긴 마지막 copyFileStream 의 dst. 임시 이름이어도 된다. */
function inFlightDst(fs: MemoryFs): string | undefined {
  const calls = fs.log.filter((e): e is CopyCall => e.op === 'copy-call');
  return calls.filter((c) => c.src === '/src/b.bin').at(-1)?.path;
}

test('취소 전에 끝난 파일은 목적지에 그대로 남는다', async () => {
  const { fs, result } = await copyCancelledDuringB();
  // 끝난 사본은 바이트까지 온전해야 한다 — 길이 0 의 잔재도 "존재" 는 한다.
  assert.deepEqual(fs.bytes('/dst/a.bin'), Buffer.alloc(CHUNK * 3, 0x61), '/dst/a.bin 이 온전하지 않다');
  assert.equal(
    result.outcome,
    'cancelled',
    `취소가 실패로 보고되었다: ${String((result.error as Error | undefined)?.name)} ${String((result.error as Error | undefined)?.message)}`,
  );
});

test('취소 순간 쓰던 파일 하나만 목적지에서 unlink 된다', async () => {
  const { fs, result } = await copyCancelledDuringB();
  const partial = inFlightDst(fs);
  assert.ok(partial, 'b.bin 복사가 시작되지 않았다 — 픽스처가 취소 지점에 닿지 않았다');
  // 디스크 상태: 쓰던 사본(임시 이름 포함)은 없고, 끝난 사본만 있다. 목록을 정확히 건다 —
  // 임시 파일 잔재나 쓰다 만 b.bin 을 "있어도 되는 것" 으로 흘려보내지 않는다.
  assert.equal(fs.nodes.has(partial), false, `쓰던 파일 ${partial} 이 목적지에 남았다`);
  assert.deepEqual(fs.list('/dst'), ['a.bin'], `목적지 목록: ${fs.list('/dst').join(',')}`);
  // 호출: unlink 는 정확히 한 번, 그 쓰던 파일에만. 끝난 사본·출발지는 건드리지 않는다.
  const unlinks = fs.log.flatMap((e) => (e.op === 'unlink' ? [e.path] : []));
  assert.deepEqual(unlinks, [partial], `unlink 호출: ${JSON.stringify(unlinks)}`);
  assert.equal(result.outcome, 'cancelled');
});

test('취소 뒤 되돌리기 연산(끝난 사본의 rm·역방향 rename)이 한 번도 호출되지 않는다', async () => {
  const { fs, result } = await copyCancelledDuringB();
  assert.equal(
    result.outcome,
    'cancelled',
    `취소 경로에 들어가지 않았다(outcome=${result.outcome}) — 되돌리기 부재를 볼 근거가 없다`,
  );
  const afterAbort = fs.log.slice(fs.log.findIndex((e) => e.op === 'abort'));
  const rollback = afterAbort.filter(
    (e) =>
      (e.op === 'unlink' && e.path === '/dst/a.bin') ||
      e.op === 'rmdir' ||
      // 목적지 쪽에서 출발지 쪽으로 가는 rename 은 이동의 되돌리기다.
      (e.op === 'rename' && topOf(e.src) === '/dst' && topOf(e.path) === '/src'),
  );
  assert.deepEqual(rollback, [], `되돌리기 호출: ${JSON.stringify(rollback)}`);
  assert.deepEqual(fs.bytes('/dst/a.bin'), Buffer.alloc(CHUNK * 3, 0x61));
});

test('취소 결과가 실제로 끝난 항목 수를 processedEntries 로 싣는다', async () => {
  const { result } = await copyCancelledDuringB();
  // outcome 을 먼저 건다 — 실패 경로도 같은 카운터를 싣기 때문에 숫자만 보면 취소 보고인지
  // 알 수 없다.
  assert.equal(result.outcome, 'cancelled');
  // a.bin 하나만 끝났다. 쓰던 b.bin 을 세면 2, 시작하지 않은 c.bin 까지 세면 3 이다.
  assert.equal(result.processedEntries, 1);
});

test('취소는 파일 사이에서도 즉시 먹는다 — 취소 이후 새 copyFileStream 호출이 없다', async () => {
  const { runJob } = await load();
  const fs = new MemoryFs(CHUNK).dir('/src').dir('/dst');
  for (const name of ['a.bin', 'b.bin', 'c.bin', 'd.bin']) fs.file(`/src/${name}`, CHUNK, 0x70);
  const controller = new AbortController();
  const result = await runJob(
    { operation: 'copy', sources: ['a.bin', 'b.bin', 'c.bin', 'd.bin'].map((n) => `/src/${n}`), destDir: '/dst' },
    deps(fs, controller, {
      // 첫 파일이 끝났다는 보고에서 취소한다 — 쓰는 도중이 아니라 두 파일 사이다.
      onProgress: (p) => {
        if (p.phase === 'transferring' && p.processedEntries === 1 && !controller.signal.aborted) {
          fs.log.push({ op: 'abort' });
          controller.abort();
        }
      },
    }),
  );
  const abortAt = fs.log.findIndex((e) => e.op === 'abort');
  assert.ok(abortAt >= 0, '픽스처가 취소 지점에 닿지 않았다');
  const callsAfter = fs.log.slice(abortAt).filter((e) => e.op === 'copy-call');
  assert.deepEqual(callsAfter, [], `취소 뒤 복사 시도: ${JSON.stringify(callsAfter)}`);
  assert.deepEqual(fs.list('/dst'), ['a.bin']);
  assert.equal(result.outcome, 'cancelled');
  assert.equal(result.processedEntries, 1);
});

test('같은 장치 이동은 rename 한 번으로 끝나 결과가 atomic: true 를 싣는다', async () => {
  const { runJob } = await load();
  const fs = new MemoryFs(CHUNK)
    .dir('/src')
    .dir('/src/d')
    .file('/src/d/x.bin', CHUNK * 2, 0x78)
    .file('/src/d/y.bin', CHUNK, 0x79)
    .dir('/dst');
  const result = await runJob({ operation: 'move', sources: ['/src/d'], destDir: '/dst' }, deps(fs, new AbortController()));

  const renames = fs.log.flatMap((e) => (e.op === 'rename' ? [`${e.src} -> ${e.path}`] : []));
  assert.deepEqual(renames, ['/src/d -> /dst/d'], `rename 호출: ${JSON.stringify(renames)}`);
  // 파일 단위로 옮겼다면 원자적이지 않다 — 복사·삭제가 하나도 없어야 한다.
  const perFile = fs.log.filter((e) => e.op === 'copy-call' || e.op === 'unlink' || e.op === 'rmdir');
  assert.deepEqual(perFile, [], `rename 뒤 파일 단위 연산: ${JSON.stringify(perFile)}`);
  assert.equal(result.outcome, 'completed', `이동 실패: ${String((result.error as Error | undefined)?.message)}`);
  assert.equal(result.atomic, true);
  assert.deepEqual(fs.list('/dst/d'), ['x.bin', 'y.bin']);
  assert.equal(fs.nodes.has('/src/d'), false);
});

/** EXDEV 이동 픽스처: /src/a.bin 과 /src/d/{b.bin,c.bin}. rename 은 /src↔/dst 사이에서 EXDEV. */
function exdevTree(): MemoryFs {
  const fs = new MemoryFs(CHUNK)
    .dir('/src')
    .file('/src/a.bin', CHUNK * 2, 0x61)
    .dir('/src/d')
    .file('/src/d/b.bin', CHUNK * 3, 0x62)
    .file('/src/d/c.bin', CHUNK * 2, 0x63)
    .dir('/dst');
  fs.exdev = true;
  return fs;
}

test('rename 이 EXDEV 를 던지면 파일마다 복사 직후 원본을 지운다 — 모든 복사가 모든 삭제보다 앞서는 순서가 나오지 않는다', async () => {
  const { runJob } = await load();
  const fs = exdevTree();
  const result = await runJob(
    { operation: 'move', sources: ['/src/a.bin', '/src/d'], destDir: '/dst' },
    deps(fs, new AbortController()),
  );
  assert.ok(
    fs.log.some((e) => e.op === 'rename' && !e.ok),
    'rename 을 먼저 시도하지 않았다 — EXDEV 분기에 들어갔는지 알 수 없다',
  );
  assert.equal(result.outcome, 'completed', `이동 실패: ${String((result.error as Error | undefined)?.message)}`);

  // 파일마다: 그 파일의 copy-done 다음, 다른 어떤 복사가 시작되기 전에 그 원본 unlink 가 온다.
  const copies = fs.log.filter((e): e is CopyCall => e.op === 'copy-call');
  assert.deepEqual(
    copies.map((c) => c.src),
    ['/src/a.bin', '/src/d/b.bin', '/src/d/c.bin'],
  );
  for (const copy of copies) {
    const doneAt = fs.log.findIndex((e) => e.op === 'copy-done' && e.src === copy.src);
    const unlinkAt = fs.log.findIndex((e) => e.op === 'unlink' && e.path === copy.src);
    const nextCopyAt = fs.log.findIndex((e, i) => i > doneAt && e.op === 'copy-call');
    assert.ok(doneAt >= 0 && unlinkAt > doneAt, `${copy.src}: 복사 완료 뒤 원본 unlink 가 없다`);
    assert.ok(nextCopyAt === -1 || unlinkAt < nextCopyAt, `${copy.src}: 원본 삭제가 다음 복사 뒤로 밀렸다`);
  }
  assert.notEqual(result.atomic, true, '파일 단위 이동을 원자적이라고 보고했다');
  assert.deepEqual(fs.bytes('/dst/a.bin'), Buffer.alloc(CHUNK * 2, 0x61));
  assert.deepEqual(fs.list('/dst/d'), ['b.bin', 'c.bin']);
  assert.deepEqual(fs.list('/src'), [], '출발지가 비지 않았다');
});

test('EXDEV 이동 도중 취소하면 끝난 파일은 목적지에만, 쓰던 파일은 원본에만 남는다', async () => {
  const { runJob } = await load();
  const fs = exdevTree();
  const controller = new AbortController();
  fs.onChunk = (src, index) => {
    if (src === '/src/d/b.bin' && index === 0) {
      fs.log.push({ op: 'abort' });
      controller.abort();
    }
  };
  const result = await runJob(
    { operation: 'move', sources: ['/src/a.bin', '/src/d'], destDir: '/dst' },
    deps(fs, controller),
  );
  assert.equal(result.outcome, 'cancelled', `outcome=${result.outcome} ${String((result.error as Error | undefined)?.message)}`);
  // 끝난 파일: 목적지에만.
  assert.deepEqual(fs.bytes('/dst/a.bin'), Buffer.alloc(CHUNK * 2, 0x61));
  assert.equal(fs.nodes.has('/src/a.bin'), false, '이동을 마친 a.bin 의 원본이 남았다');
  // 쓰던 파일: 원본은 온전하고 목적지에는 부분본(임시 이름 포함)이 없다.
  assert.deepEqual(fs.bytes('/src/d/b.bin'), Buffer.alloc(CHUNK * 3, 0x62), '쓰던 b.bin 의 원본이 온전하지 않다');
  assert.deepEqual(fs.nodes.has('/dst/d') ? fs.list('/dst/d') : [], [], '목적지 d 에 부분본·잔재가 남았다');
  // 손대지 않은 파일: 원본에만.
  assert.deepEqual(fs.bytes('/src/d/c.bin'), Buffer.alloc(CHUNK * 2, 0x63));
});
