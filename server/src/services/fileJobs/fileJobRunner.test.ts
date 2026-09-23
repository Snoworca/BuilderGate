// FR-FOP-001 · FR-FOP-002 · SEC-FOP-001 — 작업 러너의 단계·진행률·결정 루프·중간 경로 검증.
//
// 계약(T-PH001-04 가 이 형태로 구현한다):
//   runJob(spec: FileJobSpec, deps: FileJobRunnerDeps): Promise<FileJobResult>
//     spec  = { operation: 'copy' | 'move' | 'delete', sources: string[], destDir?: string }
//     deps  = { fsOps, validatePath, decide, onProgress, onStateChange?, signal? }
//   fsOps(FileJobFsOps):
//     lstat(p)  → Promise<{ kind: 'file' | 'directory', size: number } | null>  (없으면 null)
//     readdir(p) → Promise<string[]>        (이름만)
//     mkdir(p)   → Promise<void>            (한 단계, 비재귀, 이미 있으면 EEXIST)
//     copyFileStream(src, dst, onBytes, signal?) → Promise<void>
//                 onBytes(n) 은 청크마다 그 청크의 바이트 수(누적이 아니다)로 불린다
//     unlink(p) · rmdir(p) · rename(src, dst) → Promise<void>
//   validatePath(p): void | Promise<void> — 거부는 throw. 러너는 만들기 직전의 모든 경로
//     (목적지 파일·디렉터리·재귀 자식·재명명 대상)를 넘긴다.
//   decide(req: { kind: 'conflict', path }) → Promise<{ choice: 'overwrite' | 'rename' | 'skip' }>
//     path 는 이미 있는 목적지 경로다. rename 은 resolveNameCollision 으로 이름을 정한다.
//   onProgress(p: { phase: 'scanning' | 'transferring', processedBytes, totalBytes,
//                   processedEntries, totalEntries, currentPath: string | null })
//     러너는 청크·항목마다 제한 없이 보고한다 — 초당 10회 제한은 관리자(PH-002)의 몫이다.
//     여기서 제한하면 가짜 fs 는 마이크로초 안에 끝나 진행 보고가 한 번으로 뭉개진다.
//   onStateChange(s: FileJobState) — 상태가 바뀔 때마다. 첫 호출은 'running'.
//   FileJobResult = { outcome: 'completed' | 'cancelled' | 'failed', processedEntries, error? }
//     실패하면 error 에 원인 객체를 그대로 싣는다.
//   항목(entry) = 작업이 손대는 파일과 디렉터리 전부(출발지 최상위 포함). 바이트 = 파일 크기의 합.
//   삭제도 두 번째 단계 이름은 'transferring' 이다.
//   move·signal(취소)·outcome 'cancelled' 는 이 파일의 범위가 아니다 — T-PH001-05 의
//   fileJobRunnerCancel*.test.ts 가 다룬다. 다만 덮어쓰기가 임시 이름 → rename 을 쓰므로 여기 가짜의
//   rename 은 메모리 이동이다(던지는 스텁으로 되돌리지 말 것). move 의미론은 fileJobRunnerCancel.test.ts 범위다.
//
// 모듈은 테스트마다 동적으로 import 한다. 정적 import 면 모듈이 없을 때 러너가 파일
// 단위로 죽어 테스트 이름이 출력되지 않고, 그 모습은 WSL esbuild 불일치로 러너가 죽는
// 것과 구별되지 않는다.
//
// 가짜 fs 는 목적지 부모가 없으면 ENOENT, 이미 있는 디렉터리 mkdir 은 EEXIST 를 던진다.
// 관대한 가짜는 순서가 틀린 러너도 통과시킨다.
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

type ConflictChoice = 'overwrite' | 'rename' | 'skip';

interface FileJobSpec {
  operation: 'copy' | 'move' | 'delete';
  sources: string[];
  destDir?: string;
}

interface FileJobRunnerDeps {
  fsOps: FileJobFsOps;
  validatePath: (p: string) => void | Promise<void>;
  decide: (req: { kind: 'conflict'; path: string }) => Promise<{ choice: ConflictChoice }>;
  onProgress: (p: FileJobProgress) => void;
  onStateChange?: (s: FileJobState) => void;
  signal?: AbortSignal;
}

interface FileJobResult {
  outcome: 'completed' | 'cancelled' | 'failed';
  processedEntries: number;
  error?: unknown;
}

interface FileJobRunnerModule {
  runJob(spec: FileJobSpec, deps: FileJobRunnerDeps): Promise<FileJobResult>;
}

async function load(): Promise<FileJobRunnerModule> {
  return (await import('./fileJobRunner.js')) as unknown as FileJobRunnerModule;
}

// 러너는 node:path 로 경로를 잇는다. Windows 에서는 역슬래시가 되므로 가짜 fs 와 기록은
// 전부 슬래시로 정규화해 비교한다.
const norm = (p: string): string => p.replace(/\\/g, '/');
const parentOf = (p: string): string => {
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
};

type Node = { kind: 'file'; data: Buffer } | { kind: 'directory' };

type LogEntry =
  | { op: 'lstat' | 'readdir' | 'mkdir' | 'unlink' | 'rmdir' | 'validate'; path: string }
  | { op: 'copy-start' | 'copy-done'; src: string; path: string }
  | { op: 'rename'; src: string; path: string }
  | { op: 'progress'; progress: FileJobProgress }
  | { op: 'decide'; path: string }
  | { op: 'state'; state: FileJobState };

function fsError(code: string, p: string): Error {
  const err = new Error(`${code}: ${p}`) as Error & { code: string };
  err.code = code;
  return err;
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

class MemoryFs implements FileJobFsOps {
  readonly nodes = new Map<string, Node>();
  readonly log: LogEntry[] = [];

  constructor(private readonly chunkSize: number) {
    this.nodes.set('/', { kind: 'directory' });
  }

  dir(p: string): this {
    this.nodes.set(p, { kind: 'directory' });
    return this;
  }

  file(p: string, size: number, fill = 0x61): this {
    this.nodes.set(p, { kind: 'file', data: Buffer.alloc(size, fill) });
    return this;
  }

  // 오프셋마다 다른 바이트 — 청크 순서가 뒤섞이거나 잘린 사본을 길이만으로는 못 잡는다.
  patternedFile(p: string, size: number): this {
    const data = Buffer.alloc(size);
    for (let i = 0; i < size; i += 1) data[i] = (i * 7 + 3) & 0xff;
    this.nodes.set(p, { kind: 'file', data });
    return this;
  }

  has(p: string): boolean {
    return this.nodes.has(p);
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
    return node.kind === 'file'
      ? { kind: 'file', size: node.data.length }
      : { kind: 'directory', size: 0 };
  }

  async readdir(raw: string): Promise<string[]> {
    const p = norm(raw);
    this.log.push({ op: 'readdir', path: p });
    this.requireDir(p);
    const prefix = p === '/' ? '/' : `${p}/`;
    const names: string[] = [];
    for (const key of this.nodes.keys()) {
      if (key !== p && key.startsWith(prefix) && !key.slice(prefix.length).includes('/')) {
        names.push(key.slice(prefix.length));
      }
    }
    return names.sort();
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
  ): Promise<void> {
    const src = norm(rawSrc);
    const dst = norm(rawDst);
    const node = this.nodes.get(src);
    if (!node || node.kind !== 'file') throw fsError('ENOENT', src);
    this.requireDir(parentOf(dst));
    const existing = this.nodes.get(dst);
    if (existing && existing.kind === 'directory') throw fsError('EISDIR', dst);
    this.log.push({ op: 'copy-start', src, path: dst });
    // 목적지는 첫 청크 전에 생긴다 — 실제 createWriteStream 과 같다.
    this.nodes.set(dst, { kind: 'file', data: Buffer.alloc(0) });
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < node.data.length; offset += this.chunkSize) {
      await tick();
      const chunk = node.data.subarray(offset, offset + this.chunkSize);
      chunks.push(chunk);
      this.nodes.set(dst, { kind: 'file', data: Buffer.concat(chunks) });
      onBytes(chunk.length);
    }
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
    if ((await this.readdir(p)).length > 0) throw fsError('ENOTEMPTY', p);
    this.nodes.delete(p);
  }

  async rename(rawSrc: string, rawDst: string): Promise<void> {
    const src = norm(rawSrc);
    const dst = norm(rawDst);
    if (!this.nodes.has(src)) throw fsError('ENOENT', src);
    this.requireDir(parentOf(dst));
    this.log.push({ op: 'rename', src, path: dst });
    // 출발지와 그 아래를 접두사로 옮긴다. 목적지에 파일이 있으면 교체한다 — 실제 rename 과 같다.
    const moved: Array<[string, Node]> = [];
    for (const [key, node] of this.nodes) {
      if (key === src || key.startsWith(`${src}/`)) moved.push([key, node]);
    }
    for (const [key] of moved) this.nodes.delete(key);
    for (const [key, node] of moved) this.nodes.set(dst + key.slice(src.length), node);
  }
}

// 출발지 트리: 파일 3개(450 B)와 디렉터리 2개 — 항목 5개.
//   /src/a.txt (100)   /src/d/   /src/d/b.bin (300)   /src/d/e/   /src/d/e/c.txt (50)
function seedSourceTree(fs: MemoryFs): MemoryFs {
  return fs
    .dir('/src')
    .file('/src/a.txt', 100)
    .dir('/src/d')
    .file('/src/d/b.bin', 300)
    .dir('/src/d/e')
    .file('/src/d/e/c.txt', 50)
    .dir('/dst');
}

function deps(
  fs: MemoryFs,
  overrides: Partial<FileJobRunnerDeps> = {},
): FileJobRunnerDeps {
  return {
    fsOps: fs,
    validatePath: (p) => {
      fs.log.push({ op: 'validate', path: norm(p) });
    },
    decide: async (req) => {
      fs.log.push({ op: 'decide', path: norm(req.path) });
      return { choice: 'skip' };
    },
    onProgress: (progress) => {
      fs.log.push({ op: 'progress', progress: { ...progress } });
    },
    onStateChange: (state) => {
      fs.log.push({ op: 'state', state });
    },
    ...overrides,
  };
}

function progressOf(fs: MemoryFs): FileJobProgress[] {
  return fs.log.flatMap((e) => (e.op === 'progress' ? [e.progress] : []));
}

function indexOf(fs: MemoryFs, pred: (e: LogEntry) => boolean): number {
  return fs.log.findIndex(pred);
}

test('scanning 단계는 항목 수와 전체 바이트를 세고 그동안 processedBytes 진행을 내지 않는다', async () => {
  const { runJob } = await load();
  const fs = seedSourceTree(new MemoryFs(64));
  const result = await runJob(
    { operation: 'copy', sources: ['/src/a.txt', '/src/d'], destDir: '/dst' },
    deps(fs),
  );
  assert.equal(result.outcome, 'completed');

  const progress = progressOf(fs);
  const firstTransfer = progress.findIndex((p) => p.phase === 'transferring');
  const scanning = progress.filter((p) => p.phase === 'scanning');
  // 화면이 회전 프로그레스를 띄울 신호가 있어야 한다 — scanning 보고가 하나도 없으면
  // "세는 중" 을 표시할 근거가 없다. 그리고 그것은 전송 보고보다 앞서야 한다.
  assert.ok(scanning.length >= 1, `scanning 보고가 없다: ${JSON.stringify(progress)}`);
  assert.ok(firstTransfer > 0, `scanning 보다 먼저 transferring 이 나왔다: ${JSON.stringify(progress)}`);
  assert.ok(progress.slice(0, firstTransfer).every((p) => p.phase === 'scanning'));
  // 세는 동안 막대가 움직이면 안 된다.
  for (const p of scanning) assert.equal(p.processedBytes, 0, JSON.stringify(p));

  // 센 결과는 전송 첫 보고의 분모로 드러난다. 값을 정확히 건다 — "양수" 만 보면
  // 파일만 세거나 최상위만 세는 구현도 통과한다.
  const first = progress[firstTransfer];
  assert.equal(first.totalEntries, 5);
  assert.equal(first.totalBytes, 450);

  // 세는 일은 실제 복사보다 먼저 끝난다 — 첫 copy 가 첫 transferring 보고 뒤에 온다.
  const firstTransferLog = indexOf(fs, (e) => e.op === 'progress' && e.progress.phase === 'transferring');
  const firstCopy = indexOf(fs, (e) => e.op === 'copy-start');
  const firstMkdir = indexOf(fs, (e) => e.op === 'mkdir');
  assert.ok(firstCopy > firstTransferLog, 'scanning 도중 복사가 시작되었다');
  assert.ok(firstMkdir === -1 || firstMkdir > firstTransferLog, 'scanning 도중 디렉터리가 만들어졌다');
});

test('transferring 의 processedBytes 는 단조 증가하는 누적값이고 마지막 값이 totalBytes 와 같다', async () => {
  const { runJob } = await load();
  const fs = seedSourceTree(new MemoryFs(64));
  const result = await runJob(
    { operation: 'copy', sources: ['/src/a.txt', '/src/d'], destDir: '/dst' },
    deps(fs),
  );
  assert.equal(result.outcome, 'completed');

  const transferring = progressOf(fs).filter((p) => p.phase === 'transferring');
  const bytes = transferring.map((p) => p.processedBytes);
  for (let i = 1; i < bytes.length; i += 1) {
    assert.ok(bytes[i] >= bytes[i - 1], `processedBytes 가 줄었다: ${bytes.join(',')}`);
  }
  assert.equal(bytes[bytes.length - 1], 450);
  assert.equal(transferring[transferring.length - 1].totalBytes, 450);
  // 누적이라는 증거: 450 B 는 64 B 청크로 파일 셋에 걸쳐 흐르므로 서로 다른 중간값이
  // 여럿 나와야 한다. 마지막 한 번만 보고하는 구현은 단조성과 최종값을 공짜로 만족한다.
  // 청크 수는 a 2 + b 5 + c 1 = 8 — 그중 최종값 전의 서로 다른 양수 값이 파일 수(3)보다 많아야 한다.
  const distinctPartials = new Set(bytes.filter((b) => b > 0 && b < 450));
  assert.ok(distinctPartials.size > 3, `중간 누적값이 부족하다: ${bytes.join(',')}`);
  // 청크 크기(64)를 거꾸로 확인한다 — 파일 크기 단위로만 보고하면 100·400 두 값만 나온다.
  assert.ok(distinctPartials.has(64), `첫 청크의 누적값 64 가 없다: ${bytes.join(',')}`);
});

test('큰 파일 하나를 복사할 때 그 파일이 끝나기 전에 중간 진행이 한 번 이상 나온다', async () => {
  const { runJob } = await load();
  const fs = new MemoryFs(100).dir('/src').patternedFile('/src/big.bin', 1000).dir('/dst');
  const result = await runJob(
    { operation: 'copy', sources: ['/src/big.bin'], destDir: '/dst' },
    deps(fs),
  );
  assert.equal(result.outcome, 'completed');

  // 새 파일도 임시 이름에 쓴 뒤 rename 하므로(FR-FOP-005) 복사의 끝은 출발지로 찾는다.
  const copyDone = indexOf(fs, (e) => e.op === 'copy-done' && e.src === '/src/big.bin');
  assert.ok(copyDone >= 0, '복사가 copyFileStream 을 거치지 않았다');
  const before = fs.log
    .slice(0, copyDone)
    .flatMap((e) => (e.op === 'progress' && e.progress.phase === 'transferring' ? [e.progress] : []));
  const partial = before.filter((p) => p.processedBytes > 0 && p.processedBytes < 1000);
  assert.ok(
    partial.length >= 1,
    `파일이 끝나기 전의 중간 진행이 없다: ${JSON.stringify(before.map((p) => p.processedBytes))}`,
  );
  // 사본이 온전하다 — 진행만 흉내 내고 내용을 옮기지 않는 구현을 막는다.
  const copied = fs.nodes.get('/dst/big.bin');
  const original = fs.nodes.get('/src/big.bin');
  assert.ok(copied && copied.kind === 'file' && original && original.kind === 'file');
  assert.ok(copied.data.equals(original.data), '사본 바이트가 원본과 다르다');
});

test('삭제는 processedEntries 로 진행하고 processedBytes 를 진행 지표로 쓰지 않는다', async () => {
  const { runJob } = await load();
  const fs = seedSourceTree(new MemoryFs(64));
  const result = await runJob({ operation: 'delete', sources: ['/src/d'] }, deps(fs));
  assert.equal(result.outcome, 'completed');
  // 대조군: 실제로 지웠다. 진행만 보고하고 아무것도 지우지 않는 구현을 막는다.
  for (const p of ['/src/d', '/src/d/b.bin', '/src/d/e', '/src/d/e/c.txt']) {
    assert.equal(fs.has(p), false, `${p} 가 남아 있다`);
  }
  assert.equal(fs.has('/src/a.txt'), true, '대상 밖의 파일까지 지웠다');

  const transferring = progressOf(fs).filter((p) => p.phase === 'transferring');
  assert.ok(transferring.length >= 1, '삭제가 진행을 보고하지 않았다');
  // 바이트는 움직이지 않는다.
  for (const p of transferring) assert.equal(p.processedBytes, 0, JSON.stringify(p));
  // 항목 수는 d · b.bin · e · c.txt 넷이고, 하나 지울 때마다 한 칸씩 오른다.
  const last = transferring[transferring.length - 1];
  assert.equal(last.totalEntries, 4);
  assert.equal(last.processedEntries, 4);
  const entries = transferring.map((p) => p.processedEntries);
  for (let i = 1; i < entries.length; i += 1) {
    assert.ok(entries[i] >= entries[i - 1], `processedEntries 가 줄었다: ${entries.join(',')}`);
  }
  assert.deepEqual(
    [...new Set(entries.filter((n) => n > 0))].sort((a, b) => a - b),
    [1, 2, 3, 4],
    `항목마다 보고하지 않았다: ${entries.join(',')}`,
  );
});

test('모든 진행 보고가 processedBytes·totalBytes·processedEntries·totalEntries 를 함께 싣는다', async () => {
  const { runJob } = await load();
  const reports: FileJobProgress[] = [];
  for (const spec of [
    { operation: 'copy', sources: ['/src/a.txt', '/src/d'], destDir: '/dst' },
    { operation: 'delete', sources: ['/src/d'] },
  ] as FileJobSpec[]) {
    const fs = seedSourceTree(new MemoryFs(64));
    const result = await runJob(spec, deps(fs));
    assert.equal(result.outcome, 'completed', spec.operation);
    const progress = progressOf(fs);
    // 두 작업 모두 두 단계를 다 보고해야 한다 — 한쪽 단계만 검사되면 나머지 단계의
    // 페이로드는 이 단언을 비켜 간다.
    assert.ok(progress.some((p) => p.phase === 'scanning'), `${spec.operation}: scanning 보고 없음`);
    assert.ok(progress.some((p) => p.phase === 'transferring'), `${spec.operation}: transferring 보고 없음`);
    reports.push(...progress);
  }

  for (const p of reports) {
    for (const key of ['processedBytes', 'totalBytes', 'processedEntries', 'totalEntries'] as const) {
      assert.equal(typeof p[key], 'number', `${key} 누락: ${JSON.stringify(p)}`);
      assert.ok(Number.isFinite(p[key]) && p[key] >= 0, `${key} 가 음수이거나 유한하지 않다: ${JSON.stringify(p)}`);
    }
    assert.ok(p.phase === 'scanning' || p.phase === 'transferring', JSON.stringify(p));
    if (p.phase === 'transferring') {
      assert.ok(p.processedEntries <= p.totalEntries, JSON.stringify(p));
      assert.ok(p.processedBytes <= p.totalBytes, JSON.stringify(p));
    }
  }
  // 복사는 마지막에 항목 수도 다 채운다 — 바이트만 올리고 항목을 0 에 두는 구현은
  // 필드는 실었지만 화면이 고를 값이 없다.
  const copyLast = reports.filter((p) => p.phase === 'transferring' && p.totalBytes === 450).pop();
  assert.ok(copyLast, '복사의 transferring 보고를 찾지 못했다');
  assert.equal(copyLast.processedEntries, 5);
});

test('충돌에서 멈췄다가 답을 받으면 running 으로 돌아가 남은 항목을 처리한다', async () => {
  const { runJob } = await load();
  const fs = new MemoryFs(64)
    .dir('/src')
    .file('/src/a.txt', 10)
    .file('/src/b.txt', 20, 0x62)
    .file('/src/c.txt', 30)
    .dir('/dst')
    .file('/dst/b.txt', 5, 0x7a);

  let answer!: (v: { choice: ConflictChoice }) => void;
  let asked!: () => void;
  const askedP = new Promise<void>((resolve) => {
    asked = resolve;
  });
  const running = runJob(
    { operation: 'copy', sources: ['/src/a.txt', '/src/b.txt', '/src/c.txt'], destDir: '/dst' },
    deps(fs, {
      decide: (req) => {
        fs.log.push({ op: 'decide', path: norm(req.path) });
        asked();
        return new Promise((resolve) => {
          answer = resolve;
        });
      },
    }),
  );

  // decide 를 부르지 않는 구현이면 여기서 영원히 멈춘다. 멈춤은 실패보다 진단이 어려우므로
  // 기한을 두고 이유를 적어 실패시킨다.
  let guard: NodeJS.Timeout | undefined;
  await Promise.race([
    askedP,
    new Promise<never>((_, reject) => {
      guard = setTimeout(
        () => reject(new Error('충돌(/dst/b.txt)에서 decide 가 2초 안에 불리지 않았다')),
        2000,
      );
    }),
  ]).finally(() => clearTimeout(guard));
  // 기다리는 동안: 상태는 awaiting-decision 이고 남은 항목(c)은 아직 손대지 않았다.
  for (let i = 0; i < 5; i += 1) await tick();
  const states = (): FileJobState[] => fs.log.flatMap((e) => (e.op === 'state' ? [e.state] : []));
  assert.equal(states().at(-1), 'awaiting-decision', `상태 기록: ${states().join(' → ')}`);
  assert.equal(fs.has('/dst/c.txt'), false, '답을 받기 전에 남은 항목을 처리했다');

  answer({ choice: 'overwrite' });
  const result = await running;
  assert.equal(result.outcome, 'completed');

  // running → awaiting-decision → running → completed 순서.
  const seq = states();
  const waitAt = seq.indexOf('awaiting-decision');
  assert.ok(waitAt > 0 && seq[waitAt - 1] === 'running', `상태 기록: ${seq.join(' → ')}`);
  assert.equal(seq[waitAt + 1], 'running', `답 뒤에 running 으로 돌아가지 않았다: ${seq.join(' → ')}`);
  assert.equal(seq.at(-1), 'completed');

  // 답(overwrite)이 반영되었고 남은 항목도 처리되었다.
  const b = fs.nodes.get('/dst/b.txt');
  assert.ok(b && b.kind === 'file' && b.data.length === 20 && b.data[0] === 0x62, 'overwrite 가 반영되지 않았다');
  const c = fs.nodes.get('/dst/c.txt');
  assert.ok(c && c.kind === 'file' && c.data.length === 30, '남은 항목 c.txt 가 처리되지 않았다');
  assert.equal(result.processedEntries, 3);
});

test('충돌은 전송 도중 만나는 순서대로 하나씩 묻는다 — 첫 결정 요청 전에 이미 한 파일 이상이 전송되어 있다', async () => {
  const { runJob } = await load();
  const fs = new MemoryFs(64)
    .dir('/src')
    .file('/src/a.txt', 10)
    .file('/src/b.txt', 20)
    .file('/src/c.txt', 30)
    .dir('/dst')
    .file('/dst/b.txt', 1)
    .file('/dst/c.txt', 1);

  const result = await runJob(
    { operation: 'copy', sources: ['/src/a.txt', '/src/b.txt', '/src/c.txt'], destDir: '/dst' },
    deps(fs),
  );
  assert.equal(result.outcome, 'completed');

  const decides = fs.log.flatMap((e, i) => (e.op === 'decide' ? [{ i, path: e.path }] : []));
  // 두 충돌을 한 번에 모으지 않고 만나는 순서대로 하나씩 묻는다.
  assert.deepEqual(
    decides.map((d) => d.path),
    ['/dst/b.txt', '/dst/c.txt'],
  );
  // 새 파일은 임시 이름에 쓴 뒤 rename 한다(FR-FOP-005) — 전송의 끝은 목적지 이름으로의 rename 이다.
  const aDone = indexOf(fs, (e) => e.op === 'rename' && e.path === '/dst/a.txt');
  assert.ok(aDone >= 0 && aDone < decides[0].i, '첫 결정 요청 전에 a.txt 전송이 끝나 있지 않다');
  // 사전 스캔이 없다는 직접 증거: 첫 질문 시점까지 c 의 목적지는 들여다보지도 않았다.
  // 미리 훑어 모은 뒤 게으르게 묻는 구현은 위의 순서 단언을 통과하지만 이것에 걸린다.
  const cLooked = indexOf(fs, (e) => e.op === 'lstat' && e.path === '/dst/c.txt');
  assert.ok(cLooked > decides[0].i, `첫 질문 전에 /dst/c.txt 를 검사했다 (lstat@${cLooked}, decide@${decides[0].i})`);
  // 두 번째 질문은 b 를 처리한 뒤다 — 첫 답(skip)을 받고 나서야 c 에 도달한다.
  assert.ok(decides[1].i > decides[0].i);
  // skip 이 반영되었다: 기존 파일은 그대로 1 B.
  const b = fs.nodes.get('/dst/b.txt');
  assert.ok(b && b.kind === 'file' && b.data.length === 1);
});

test('재귀 자식과 이름 바꾼 대상을 포함해 작업이 만드는 모든 경로가 경로 검증 콜백을 거친다', async () => {
  const { runJob } = await load();
  const fs = seedSourceTree(new MemoryFs(64)).file('/dst/a.txt', 1);
  const result = await runJob(
    { operation: 'copy', sources: ['/src/a.txt', '/src/d'], destDir: '/dst' },
    deps(fs, {
      decide: async (req) => {
        fs.log.push({ op: 'decide', path: norm(req.path) });
        return { choice: 'rename' };
      },
    }),
  );
  assert.equal(result.outcome, 'completed');

  // 파일은 임시 이름에 쓴 뒤(copy-start) 목적지 이름으로 rename 한다(FR-FOP-005). 셋 다 만드는 경로다.
  const created = fs.log.flatMap((e, i) =>
    e.op === 'mkdir' || e.op === 'copy-start' || e.op === 'rename' ? [{ i, op: e.op, path: e.path }] : [],
  );
  // 무엇이 만들어졌는지를 정확히 건다 — 아무것도 만들지 않는 구현은 "만든 것은 모두
  // 검증되었다" 를 공짜로 만족한다. 재명명 대상은 resolveNameCollision 의 'a (2).txt'.
  assert.deepEqual(
    created.filter((c) => c.op !== 'copy-start').map((c) => c.path).sort(),
    ['/dst/a (2).txt', '/dst/d', '/dst/d/b.bin', '/dst/d/e', '/dst/d/e/c.txt'].sort(),
  );
  // 임시 이름은 최종 이름과 같은 디렉터리에 있다 — 다른 디렉터리면 rename 이 장치 경계를 넘을 수 있다.
  assert.deepEqual(
    created.filter((c) => c.op === 'copy-start').map((c) => parentOf(c.path)).sort(),
    ['/dst', '/dst/d', '/dst/d/e'],
  );
  // 각 경로는 만들어지기 직전에(그보다 앞선 시점에) 검증 콜백을 거쳤다.
  for (const c of created) {
    const validatedAt = fs.log.slice(0, c.i).map((e) => (e.op === 'validate' ? e.path : null));
    assert.ok(validatedAt.includes(c.path), `${c.path} 가 검증 없이 만들어졌다`);
  }
  // 원래 이름(/dst/a.txt)으로는 쓰지 않았다 — 재명명이 반영되었다.
  const original = fs.nodes.get('/dst/a.txt');
  assert.ok(original && original.kind === 'file' && original.data.length === 1);
});

test('검증 콜백이 거부한 중간 경로는 만들어지지 않는다', async () => {
  const { runJob } = await load();
  const fs = seedSourceTree(new MemoryFs(64));
  class PathRefusedForTest extends Error {
    override name = 'PathRefusedForTest';
  }
  const refusal = new PathRefusedForTest('blocked path: /dst/d/e');
  const result = await runJob(
    { operation: 'copy', sources: ['/src/d'], destDir: '/dst' },
    deps(fs, {
      validatePath: (raw) => {
        const p = norm(raw);
        fs.log.push({ op: 'validate', path: p });
        if (p === '/dst/d/e') throw refusal;
      },
    }),
  );

  // 거부가 실제로 일어났다 — 콜백을 부르지 않고 우연히 e 를 건너뛴 구현을 막는다.
  assert.ok(fs.log.some((e) => e.op === 'validate' && e.path === '/dst/d/e'), '/dst/d/e 를 검증하지 않았다');
  // 거부된 경로와 그 아래는 만들어지지 않았다.
  assert.equal(fs.has('/dst/d/e'), false);
  assert.equal(fs.has('/dst/d/e/c.txt'), false);
  assert.ok(
    !fs.log.some(
      (e) => (e.op === 'mkdir' || e.op === 'copy-start') && (e.path === '/dst/d/e' || e.path.startsWith('/dst/d/e/')),
    ),
    '거부된 경로에 대해 만들기 연산을 호출했다',
  );
  // 대조군: 거부 전의 형제는 정상 처리되었다 — 시작부터 아무것도 안 하는 구현을 막는다.
  assert.equal(fs.has('/dst/d/b.bin'), true, '거부 이전의 항목이 처리되지 않았다');
  // 결과는 실패이고, 원인은 그 거부 객체 자체다. outcome 만 보면 가짜 fs 의 ENOENT 처럼
  // 전혀 다른 이유로 실패한 구현도 통과하므로 원인의 정체를 건다.
  assert.equal(result.outcome, 'failed');
  assert.equal(result.error, refusal);
  assert.ok(result.error instanceof PathRefusedForTest);
  assert.equal((result.error as Error).message, 'blocked path: /dst/d/e');
});
