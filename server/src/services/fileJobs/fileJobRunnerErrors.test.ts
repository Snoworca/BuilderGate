// FR-FEX-007 AC-5 · FR-FOP-001 · FR-FOP-002 · FR-FOP-005 · SEC-FOP-001 — 러너의 항목별 오류·차단 자손·
// 재확인·자기 안으로의 복사·임시 이름 쓰기.
//
// 가짜 fs 는 링크를 안다(lstat 이 symlink 를 보고하고 realpath 가 링크를 푼다). 링크를 모르는 가짜로는
// "스캔 뒤 디렉터리가 링크로 바뀐" 경우와 "자기 안으로의 복사가 링크를 거쳐 들어간" 경우를 만들 수 없다.
//
// 장치 경계는 경로의 첫 구간이다 — '/src' 와 '/dst' 사이의 rename 은 EXDEV 이고, '/vol/a' 와 '/vol/b'
// 사이는 같은 장치다. 가짜 fs 의 오류 주입(fail)은 연산·경로·횟수를 지정해 그 호출만 errno 로 실패시킨다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, realpath as fsRealpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runJob } from './fileJobRunner.js';
import type { FileJobFsOps, FileJobFsStat } from './fileJobFsOps.js';
import type { FileJobDecisionRequest, FileJobProgress, FileJobRunnerDeps, FileJobSpec } from './fileJobRunner.js';
import { nodeFileJobFsOps } from './fileJobFsOps.js';
import { validateCreatePath } from './fileJobPaths.js';
import { isPathBlocked } from '../../utils/pathValidator.js';

const norm = (p: string): string => {
  const s = p.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '');
  return s.length > 1 && s.endsWith('/') ? s.slice(0, -1) : s;
};
const parentOf = (p: string): string => {
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
};
const topOf = (p: string): string => p.split('/')[1] ?? '';

type Node = { kind: 'file'; data: Buffer } | { kind: 'directory' } | { kind: 'symlink'; target: string };
type Op = 'lstat' | 'readdir' | 'mkdir' | 'copy' | 'unlink' | 'rmdir' | 'rename';

function fsError(code: string, p: string): Error & { code: string } {
  const err = new Error(`${code}: ${p}`) as Error & { code: string };
  err.code = code;
  return err;
}

class LinkFs implements FileJobFsOps {
  readonly nodes = new Map<string, Node>([['/', { kind: 'directory' }]]);
  readonly log: string[] = [];
  private readonly faults: { op: Op; path: string; code: string; times: number; partial: boolean }[] = [];
  /** lstat 의 결과를 바꿀 수 있다. 호출 번호는 경로마다 1부터 센다. */
  lstatOverride?: (p: string, nth: number, actual: FileJobFsStat | null) => FileJobFsStat | null;
  private readonly lstatCount = new Map<string, number>();

  dir(p: string): this {
    this.nodes.set(p, { kind: 'directory' });
    return this;
  }

  file(p: string, text: string): this {
    this.nodes.set(p, { kind: 'file', data: Buffer.from(text) });
    return this;
  }

  link(p: string, target: string): this {
    this.nodes.set(p, { kind: 'symlink', target });
    return this;
  }

  /** op 의 다음 times 번 호출(경로 일치)을 code 로 실패시킨다. partial 이면 복사가 절반을 보고한 뒤 실패한다. */
  fail(op: Op, p: string, code: string, times = 1, partial = false): this {
    this.faults.push({ op, path: p, code, times, partial });
    return this;
  }

  has(p: string): boolean {
    return this.nodes.has(p);
  }

  text(p: string): string | undefined {
    const n = this.nodes.get(p);
    return n?.kind === 'file' ? n.data.toString() : undefined;
  }

  list(p: string): string[] {
    const prefix = p === '/' ? '/' : `${p}/`;
    const out: string[] = [];
    for (const key of this.nodes.keys()) {
      if (key !== p && key.startsWith(prefix) && !key.slice(prefix.length).includes('/')) out.push(key.slice(prefix.length));
    }
    return out.sort();
  }

  private injected(op: Op, p: string): { code: string; partial: boolean } | null {
    const f = this.faults.find((x) => x.op === op && x.path === p && x.times > 0);
    if (!f) return null;
    f.times -= 1;
    return { code: f.code, partial: f.partial };
  }

  private throwIfInjected(op: Op, p: string): void {
    const f = this.injected(op, p);
    if (f) throw fsError(f.code, p);
  }

  /** 링크를 모두 따라간 경로. 없으면 null. */
  private resolveReal(p: string, depth = 0): string | null {
    if (depth > 40) return null;
    const parts = p.split('/').filter(Boolean);
    let cur = '/';
    for (const part of parts) {
      const next = cur === '/' ? `/${part}` : `${cur}/${part}`;
      const node = this.nodes.get(next);
      if (!node) return null;
      if (node.kind === 'symlink') {
        const r = this.resolveReal(norm(node.target), depth + 1);
        if (r === null) return null;
        cur = r;
      } else {
        cur = next;
      }
    }
    return cur;
  }

  async lstat(raw: string): Promise<FileJobFsStat | null> {
    const p = norm(raw);
    this.log.push(`lstat ${p}`);
    this.throwIfInjected('lstat', p);
    const node = this.nodes.get(p);
    const actual: FileJobFsStat | null = !node
      ? null
      : node.kind === 'file'
        ? { kind: 'file', size: node.data.length }
        : node.kind === 'directory'
          ? { kind: 'directory', size: 0 }
          : { kind: 'symlink', size: 0 };
    const nth = (this.lstatCount.get(p) ?? 0) + 1;
    this.lstatCount.set(p, nth);
    return this.lstatOverride ? this.lstatOverride(p, nth, actual) : actual;
  }

  async realpath(raw: string): Promise<string> {
    const r = this.resolveReal(norm(raw));
    if (r === null) throw fsError('ENOENT', raw);
    return r;
  }

  async readdir(raw: string): Promise<string[]> {
    const p = norm(raw);
    this.log.push(`readdir ${p}`);
    this.throwIfInjected('readdir', p);
    const real = this.resolveReal(p);
    if (real === null || this.nodes.get(real)?.kind !== 'directory') throw fsError('ENOTDIR', p);
    return this.list(real);
  }

  async mkdir(raw: string): Promise<void> {
    const p = norm(raw);
    this.log.push(`mkdir ${p}`);
    this.throwIfInjected('mkdir', p);
    if (this.nodes.has(p)) throw fsError('EEXIST', p);
    if (this.nodes.get(parentOf(p))?.kind !== 'directory') throw fsError('ENOENT', p);
    this.nodes.set(p, { kind: 'directory' });
  }

  async copyFileStream(rawSrc: string, rawDst: string, onBytes: (n: number) => void): Promise<void> {
    const src = norm(rawSrc);
    const dst = norm(rawDst);
    this.log.push(`copy ${src} -> ${dst}`);
    const real = this.resolveReal(src);
    const node = real === null ? undefined : this.nodes.get(real);
    if (!node || node.kind !== 'file') throw fsError('ENOENT', src);
    if (this.nodes.has(dst)) throw fsError('EEXIST', dst);
    if (this.nodes.get(parentOf(dst))?.kind !== 'directory') throw fsError('ENOENT', dst);
    const f = this.injected('copy', src);
    if (f) {
      if (f.partial) {
        // 쓰기 스트림은 여는 순간 파일을 만들고 절반을 쓴 뒤 끊긴다.
        this.nodes.set(dst, { kind: 'file', data: node.data.subarray(0, node.data.length >> 1) });
        onBytes(node.data.length >> 1);
      }
      throw fsError(f.code, src);
    }
    this.nodes.set(dst, { kind: 'file', data: Buffer.from(node.data) });
    onBytes(node.data.length);
  }

  async unlink(raw: string): Promise<void> {
    const p = norm(raw);
    this.log.push(`unlink ${p}`);
    this.throwIfInjected('unlink', p);
    const node = this.nodes.get(p);
    if (!node) throw fsError('ENOENT', p);
    if (node.kind === 'directory') throw fsError('EPERM', p);
    this.nodes.delete(p);
  }

  async rmdir(raw: string): Promise<void> {
    const p = norm(raw);
    this.log.push(`rmdir ${p}`);
    this.throwIfInjected('rmdir', p);
    if (this.nodes.get(p)?.kind !== 'directory') throw fsError('ENOTDIR', p);
    if (this.list(p).length > 0) throw fsError('ENOTEMPTY', p);
    this.nodes.delete(p);
  }

  async rename(rawSrc: string, rawDst: string): Promise<void> {
    const src = norm(rawSrc);
    const dst = norm(rawDst);
    this.log.push(`rename ${src} -> ${dst}`);
    this.throwIfInjected('rename', src);
    if (topOf(src) !== topOf(dst)) throw fsError('EXDEV', src);
    if (!this.nodes.has(src)) throw fsError('ENOENT', src);
    if (this.nodes.get(parentOf(dst))?.kind !== 'directory') throw fsError('ENOENT', dst);
    const moved: [string, Node][] = [];
    for (const [key, node] of this.nodes) {
      if (key === src || key.startsWith(`${src}/`)) moved.push([key, node]);
    }
    for (const [key] of moved) this.nodes.delete(key);
    for (const [key, node] of moved) this.nodes.set(dst + key.slice(src.length), node);
  }
}

interface Run {
  outcome: string;
  error?: unknown;
  asked: FileJobDecisionRequest[];
  progress: FileJobProgress[];
}

async function run(
  fs: LinkFs,
  spec: FileJobSpec,
  answer: (req: FileJobDecisionRequest, nth: number) => string,
  extra: Partial<FileJobRunnerDeps> = {},
): Promise<Run> {
  const asked: FileJobDecisionRequest[] = [];
  const progress: FileJobProgress[] = [];
  const result = await runJob(spec, {
    fsOps: fs,
    validatePath: () => {},
    decide: async (req) => {
      asked.push({ ...req, path: norm(req.path), choices: [...req.choices] });
      return { choice: answer(req, asked.length) as never };
    },
    onProgress: (p) => progress.push(p),
    ...extra,
  });
  return { outcome: result.outcome, error: result.error, asked, progress };
}

const blockSsh = (p: string): boolean => norm(p).split('/').includes('.ssh');
const codeOf = (err: unknown): string | undefined => (err as { code?: string } | undefined)?.code;

// ── FND-004 : 항목별 fs 오류는 작업 실패가 아니라 error 결정이다 ─────────────────

// @req FR-FEX-007 AC-5
// @req FR-FOP-001
test('파일 쓰기가 EBUSY 로 실패하면 작업을 실패시키지 않고 retry·skip 선택지와 errno 코드를 실은 error 결정을 묻는다', async () => {
  const fs = new LinkFs().dir('/src').file('/src/a.txt', 'aaaa').dir('/dst').fail('copy', '/src/a.txt', 'EBUSY');
  const r = await run(fs, { operation: 'copy', sources: ['/src/a.txt'], destDir: '/dst' }, () => 'skip');
  assert.equal(r.outcome, 'completed', `작업이 항목 하나의 fs 오류로 끝났다: ${codeOf(r.error)}`);
  assert.deepEqual(r.asked, [{ kind: 'error', path: '/src/a.txt', choices: ['retry', 'skip'], detail: 'EBUSY' }]);
  assert.deepEqual(fs.list('/dst'), [], '건너뛴 파일의 사본이나 부분본이 목적지에 남았다');
});

// @req FR-FEX-007 AC-5
test('retry 를 고르면 같은 항목을 다시 시도해 두 번째에 성공하고, 끊긴 시도의 바이트를 두 번 세지 않는다', async () => {
  const fs = new LinkFs()
    .dir('/src').file('/src/a.txt', 'abcdefgh').file('/src/b.txt', '12345678').dir('/dst')
    .fail('copy', '/src/a.txt', 'EPERM', 1, true);
  const r = await run(fs, { operation: 'copy', sources: ['/src/a.txt', '/src/b.txt'], destDir: '/dst' }, () => 'retry');
  assert.equal(r.outcome, 'completed', `retry 뒤 실패: ${codeOf(r.error)}`);
  assert.equal(r.asked.length, 1);
  assert.equal(fs.text('/dst/a.txt'), 'abcdefgh');
  assert.deepEqual(fs.list('/dst'), ['a.txt', 'b.txt'], '끊긴 시도의 부분본이 남았다');
  // a 가 끝난 순간의 막대는 a 의 8바이트여야 한다. 끊긴 시도의 4바이트가 남아 있으면 12 가 된다 —
  // 분모(16)에 잘리지 않는 자리에서 봐야 이중 집계가 드러난다.
  const aReports = r.progress.filter((p) => p.phase === 'transferring' && p.currentPath !== null && norm(p.currentPath) === '/src/a.txt');
  assert.equal(aReports[aReports.length - 1]?.processedBytes, 8, `a 완료 시점 바이트: ${JSON.stringify(aReports.map((p) => p.processedBytes))}`);
  assert.equal(r.progress[r.progress.length - 1].processedBytes, 16);
});

// @req FR-FEX-007 AC-5
test('skip 을 고르면 그 항목만 빠지고 다음 항목은 계속 처리된다', async () => {
  const fs = new LinkFs().dir('/src').file('/src/a.txt', 'a').file('/src/b.txt', 'b').dir('/dst').fail('copy', '/src/a.txt', 'EACCES');
  const r = await run(fs, { operation: 'copy', sources: ['/src/a.txt', '/src/b.txt'], destDir: '/dst' }, () => 'skip');
  assert.equal(r.outcome, 'completed');
  assert.deepEqual(fs.list('/dst'), ['b.txt']);
  assert.equal(r.progress[r.progress.length - 1].processedEntries, 2, '건너뛴 항목도 처리된 것으로 세야 막대가 100% 에 닿는다');
});

// @req FR-FEX-007 AC-5
// @req FR-FOP-002
test('삭제 중 unlink 가 EBUSY 면 묻고, 건너뛴 파일이 남은 부모 디렉터리는 rmdir 하지 않은 채 나머지를 지운다', async () => {
  const fs = new LinkFs().dir('/src').dir('/src/d').file('/src/d/a.txt', 'a').file('/src/d/b.txt', 'b').fail('unlink', '/src/d/a.txt', 'EBUSY');
  const r = await run(fs, { operation: 'delete', sources: ['/src/d'] }, () => 'skip');
  assert.equal(r.outcome, 'completed', `삭제가 실패로 끝났다: ${codeOf(r.error)}`);
  assert.deepEqual(r.asked.map((q) => [q.kind, q.path, q.detail]), [['error', '/src/d/a.txt', 'EBUSY']]);
  assert.deepEqual(fs.list('/src/d'), ['a.txt']);
  assert.ok(!fs.log.includes('rmdir /src/d'), '건너뛴 파일이 남은 디렉터리에 rmdir 을 시도했다');
});

// @req FR-FEX-007 AC-5
// @req FR-FOP-005
test('같은 장치 이동의 rename 이 EXDEV 가 아닌 EBUSY 로 실패하면 묻고, retry 로 두 번째에 옮긴다', async () => {
  const fs = new LinkFs().dir('/vol').dir('/vol/src').file('/vol/src/a.txt', 'a').dir('/vol/dst').fail('rename', '/vol/src/a.txt', 'EBUSY');
  const r = await run(fs, { operation: 'move', sources: ['/vol/src/a.txt'], destDir: '/vol/dst' }, () => 'retry');
  assert.equal(r.outcome, 'completed', `이동이 실패로 끝났다: ${codeOf(r.error)}`);
  assert.deepEqual(r.asked.map((q) => [q.kind, q.detail, q.choices]), [['error', 'EBUSY', ['retry', 'skip']]]);
  assert.equal(fs.text('/vol/dst/a.txt'), 'a');
  assert.equal(fs.has('/vol/src/a.txt'), false);
});

// @req FR-FEX-007 AC-5
// @req FR-FOP-005
test('EXDEV 이동에서 사본을 만든 뒤 원본 unlink 가 실패해 skip 하면 원본을 남기고, 부모 디렉터리를 지우지 않으며, 충돌 질문을 다시 하지 않는다', async () => {
  const fs = new LinkFs().dir('/src').dir('/src/d').file('/src/d/a.txt', 'a').dir('/dst').fail('unlink', '/src/d/a.txt', 'EPERM');
  const r = await run(fs, { operation: 'move', sources: ['/src/d'], destDir: '/dst' }, () => 'skip');
  assert.equal(r.outcome, 'completed', `이동이 실패로 끝났다: ${codeOf(r.error)}`);
  assert.deepEqual(r.asked.map((q) => [q.kind, q.path, q.detail]), [['error', '/src/d/a.txt', 'EPERM']]);
  assert.equal(fs.text('/dst/d/a.txt'), 'a');
  assert.equal(fs.text('/src/d/a.txt'), 'a');
  assert.ok(fs.has('/src/d'), '원본이 남은 디렉터리를 지웠다');
});

// @req FR-FOP-001
test('fs 연산이 아닌 곳의 오류(경로 검증 거부)는 여전히 묻지 않고 작업을 실패시킨다', async () => {
  const fs = new LinkFs().dir('/src').file('/src/a.txt', 'a').dir('/dst');
  const refusal = Object.assign(new Error('refused'), { code: 'PATH_BLOCKED' });
  const r = await run(fs, { operation: 'copy', sources: ['/src/a.txt'], destDir: '/dst' }, () => 'retry', {
    validatePath: () => {
      throw refusal;
    },
  });
  assert.equal(r.outcome, 'failed');
  assert.equal(r.error, refusal);
  assert.deepEqual(r.asked, []);
});

// ── FND-003 : blocked 자손은 읽지도, 만들지도, 지우지도, 옮기지도 않는다 ────────────

// @req SEC-FOP-001
test('복사 중 만난 blocked 자손은 skip 선택지만 있는 error 결정이 되고, 그 아래를 읽거나 목적지에 어떤 이름으로도 만들지 않는다', async () => {
  const fs = new LinkFs()
    .dir('/src').dir('/src/a').file('/src/a/ok.txt', 'ok').dir('/src/a/.ssh').file('/src/a/.ssh/id_rsa', 'PRIVATE')
    .dir('/dst').dir('/dst/a').dir('/dst/a/.ssh');
  const r = await run(fs, { operation: 'copy', sources: ['/src/a'], destDir: '/dst' },
    (req) => (req.kind === 'conflict' ? (norm(req.path).endsWith('.ssh') ? 'rename' : 'overwrite') : 'skip'),
    { isBlocked: blockSsh } as Partial<FileJobRunnerDeps>);
  assert.equal(r.outcome, 'completed', `복사가 실패로 끝났다: ${codeOf(r.error)}`);
  const blocked = r.asked.filter((q) => q.kind === 'error');
  assert.deepEqual(blocked.map((q) => [q.path, q.choices]), [['/src/a/.ssh', ['skip']]]);
  assert.deepEqual(fs.list('/dst/a'), ['.ssh', 'ok.txt'], `blocked 자손이 다른 이름으로 목적지에 생겼다: ${fs.list('/dst/a')}`);
  assert.deepEqual(fs.list('/dst/a/.ssh'), []);
  assert.ok(!fs.log.includes('readdir /src/a/.ssh'), 'blocked 디렉터리의 목록을 읽었다');
  assert.ok(!fs.log.some((l) => l.startsWith('copy /src/a/.ssh/')), 'blocked 자손의 내용을 읽었다');
});

// @req SEC-FOP-001
test('링크를 따라간 복사에서 실제 경로(readPath)가 blocked 면 표시 경로가 막혀 있지 않아도 거부한다', async () => {
  const fs = new LinkFs()
    .dir('/src').dir('/src/a').link('/src/a/keys', '/src/.ssh').dir('/src/.ssh').file('/src/.ssh/id_rsa', 'PRIVATE').dir('/dst');
  const r = await run(fs, { operation: 'copy', sources: ['/src/a'], destDir: '/dst' }, () => 'skip', {
    isBlocked: blockSsh,
    validateSourcePath: () => {},
  } as Partial<FileJobRunnerDeps>);
  assert.equal(r.outcome, 'completed');
  assert.deepEqual(r.asked.map((q) => [q.kind, q.path]), [['error', '/src/a/keys']]);
  assert.deepEqual(fs.list('/dst/a'), []);
});

// @req SEC-FOP-001
// @req FR-FOP-002
test('삭제는 blocked 자손을 지우지 않고, 그것이 남은 부모도 지우지 않는다', async () => {
  const fs = new LinkFs().dir('/src').dir('/src/a').file('/src/a/ok.txt', 'ok').dir('/src/a/.ssh').file('/src/a/.ssh/id_rsa', 'PRIVATE');
  const r = await run(fs, { operation: 'delete', sources: ['/src/a'] }, () => 'skip', { isBlocked: blockSsh } as Partial<FileJobRunnerDeps>);
  assert.equal(r.outcome, 'completed', `삭제가 실패로 끝났다: ${codeOf(r.error)}`);
  assert.deepEqual(r.asked.map((q) => [q.kind, q.path, q.choices]), [['error', '/src/a/.ssh', ['skip']]]);
  assert.equal(fs.text('/src/a/.ssh/id_rsa'), 'PRIVATE');
  assert.deepEqual(fs.list('/src/a'), ['.ssh']);
  assert.equal(r.progress[r.progress.length - 1].processedEntries, r.progress[r.progress.length - 1].totalEntries);
});

// @req SEC-FOP-001
// @req FR-FOP-005
test('같은 장치 이동은 blocked 자손을 품은 디렉터리를 rename 한 번으로 옮기지 않고, 그 자손만 출발지에 남긴다', async () => {
  const fs = new LinkFs()
    .dir('/vol').dir('/vol/src').dir('/vol/src/a').file('/vol/src/a/ok.txt', 'ok').dir('/vol/src/a/.ssh')
    .file('/vol/src/a/.ssh/id_rsa', 'PRIVATE').dir('/vol/dst');
  const r = await run(fs, { operation: 'move', sources: ['/vol/src/a'], destDir: '/vol/dst' }, () => 'skip', {
    isBlocked: blockSsh,
  } as Partial<FileJobRunnerDeps>);
  assert.equal(r.outcome, 'completed', `이동이 실패로 끝났다: ${codeOf(r.error)}`);
  assert.ok(!fs.log.includes('rename /vol/src/a -> /vol/dst/a'), 'blocked 자손째로 디렉터리를 rename 했다');
  assert.equal(fs.text('/vol/src/a/.ssh/id_rsa'), 'PRIVATE');
  assert.equal(fs.has('/vol/dst/a/.ssh'), false);
  assert.equal(fs.text('/vol/dst/a/ok.txt'), 'ok');
  assert.deepEqual(fs.list('/vol/src/a'), ['.ssh']);
});

// @req SEC-FOP-001
test('실제 fs: 병합 복사에서 rename 을 골라도 blocked 자손이 "(2)" 이름으로 목적지에 생기지 않는다', async () => {
  const cwd = await fsRealpath(await mkdtemp(join(tmpdir(), 'bg-fj-blk-')));
  try {
    await mkdir(join(cwd, 'a', '.ssh'), { recursive: true });
    await writeFile(join(cwd, 'a', '.ssh', 'id_rsa'), 'PRIVATE');
    await writeFile(join(cwd, 'a', 'ok.txt'), 'ok');
    await mkdir(join(cwd, 'dest', 'a', '.ssh'), { recursive: true });
    const policy = { getCwd: async () => cwd, blockedPaths: ['.ssh'] };
    const v = async (p: string): Promise<void> => {
      await validateCreatePath(policy, 's', p);
    };
    const result = await runJob({ operation: 'copy', sources: [join(cwd, 'a')], destDir: join(cwd, 'dest') }, {
      fsOps: nodeFileJobFsOps,
      validatePath: v,
      validateSourcePath: v,
      isBlocked: (p: string) => isPathBlocked(p, policy.blockedPaths),
      decide: async (req) => ({ choice: req.kind === 'error' ? 'skip' : req.path.endsWith('.ssh') ? 'rename' : 'overwrite' }),
      onProgress: () => {},
    } as FileJobRunnerDeps);
    assert.equal(result.outcome, 'completed', `복사 실패: ${codeOf(result.error)}`);
    assert.deepEqual((await readdir(join(cwd, 'dest', 'a'))).sort(), ['.ssh', 'ok.txt']);
    assert.deepEqual(await readdir(join(cwd, 'dest', 'a', '.ssh')), []);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

// ── FND-006 : 내려가기 전에 디렉터리인지 다시 본다 ─────────────────────────────

// @req SEC-FOP-001
// @req FR-FOP-002
test('삭제는 스캔 때 디렉터리였던 항목이 링크로 바뀌었으면 그 너머로 내려가지 않고 error 결정을 묻는다', async () => {
  const fs = new LinkFs().dir('/src').dir('/src/d').file('/src/d/a.txt', 'a').file('/src/keep.txt', 'k');
  fs.lstatOverride = (p, nth, actual) => (p === '/src/d' && nth >= 2 ? { kind: 'symlink', size: 0 } : actual);
  const r = await run(fs, { operation: 'delete', sources: ['/src/d', '/src/keep.txt'] }, () => 'skip');
  assert.equal(r.outcome, 'completed', `삭제가 실패로 끝났다: ${codeOf(r.error)}`);
  assert.ok(fs.log.filter((l) => l === 'lstat /src/d').length >= 2, '내려가기 전에 다시 lstat 하지 않았다');
  assert.deepEqual(r.asked.map((q) => [q.kind, q.path, q.choices]), [['error', '/src/d', ['skip']]]);
  assert.equal(fs.text('/src/d/a.txt'), 'a', '링크로 바뀐 디렉터리 너머의 파일을 지웠다');
  assert.equal(fs.has('/src/keep.txt'), false, '다음 항목을 처리하지 않았다');
});

// @req SEC-FOP-001
// @req FR-FOP-005
test('EXDEV 이동의 파일 단위 경로도 내려가기 전에 다시 lstat 해 링크로 바뀐 디렉터리를 따라가지 않는다', async () => {
  const fs = new LinkFs().dir('/src').dir('/src/d').file('/src/d/a.txt', 'a').dir('/dst');
  fs.lstatOverride = (p, nth, actual) => (p === '/src/d' && nth >= 2 ? { kind: 'symlink', size: 0 } : actual);
  const r = await run(fs, { operation: 'move', sources: ['/src/d'], destDir: '/dst' }, () => 'skip');
  assert.equal(r.outcome, 'completed', `이동이 실패로 끝났다: ${codeOf(r.error)}`);
  assert.deepEqual(r.asked.map((q) => [q.kind, q.path, q.choices]), [['error', '/src/d', ['skip']]]);
  assert.equal(fs.text('/src/d/a.txt'), 'a');
  assert.equal(fs.has('/dst/d'), false, '링크로 바뀐 디렉터리를 위해 목적지를 만들었다');
});

// ── FND-007 : 자기 안으로의 복사·이동 ──────────────────────────────────────────

for (const operation of ['copy', 'move'] as const) {
  // @req FR-FOP-001
  test(`디렉터리를 자기 하위 디렉터리로 ${operation} 하면 아무것도 만들지 않고 EINVAL 로 실패한다`, async () => {
    const fs = new LinkFs().dir('/vol').dir('/vol/d').file('/vol/d/a.txt', 'a').dir('/vol/d/sub');
    const r = await run(fs, { operation, sources: ['/vol/d'], destDir: '/vol/d/sub' }, () => 'skip');
    assert.equal(r.outcome, 'failed');
    assert.equal(codeOf(r.error), 'EINVAL');
    assert.deepEqual(fs.list('/vol/d/sub'), []);
    assert.ok(!fs.log.some((l) => /^(mkdir|copy|rename|unlink|rmdir) /.test(l)), `만들기·옮기기 연산이 불렸다: ${fs.log}`);
  });

  // @req FR-FOP-001
  test(`목적지가 링크를 거쳐 출발지 디렉터리 안을 가리켜도 실제 경로로 비교해 ${operation} 를 EINVAL 로 거부한다`, async () => {
    const fs = new LinkFs().dir('/vol').dir('/vol/d').file('/vol/d/a.txt', 'a').dir('/vol/d/sub').link('/vol/alias', '/vol/d');
    const r = await run(fs, { operation, sources: ['/vol/d'], destDir: '/vol/alias/sub' }, () => 'skip');
    assert.equal(r.outcome, 'failed');
    assert.equal(codeOf(r.error), 'EINVAL');
    assert.deepEqual(fs.list('/vol/d/sub'), []);
  });
}

// @req FR-FOP-001
test('대조군: 이름이 출발지로 시작하는 형제 디렉터리로의 복사는 자기 안이 아니다', async () => {
  const fs = new LinkFs().dir('/vol').dir('/vol/d').file('/vol/d/a.txt', 'a').dir('/vol/d2');
  const r = await run(fs, { operation: 'copy', sources: ['/vol/d'], destDir: '/vol/d2' }, () => 'skip');
  assert.equal(r.outcome, 'completed', `형제 디렉터리를 자기 안으로 판정했다: ${codeOf(r.error)}`);
  assert.equal(fs.text('/vol/d2/d/a.txt'), 'a');
});

// ── FND-005 : 새 파일도 임시 이름에 쓴 뒤 rename 한다 ───────────────────────────

// @req FR-FOP-005
test('새 파일은 목적지 이름에 바로 쓰지 않고 같은 디렉터리의 임시 이름에 다 쓴 뒤 rename 한다', async () => {
  const fs = new LinkFs().dir('/src').file('/src/a.txt', 'aaaa').dir('/dst');
  const r = await run(fs, { operation: 'copy', sources: ['/src/a.txt'], destDir: '/dst' }, () => 'skip');
  assert.equal(r.outcome, 'completed');
  const copy = fs.log.find((l) => l.startsWith('copy '));
  assert.match(copy ?? '', /^copy \/src\/a\.txt -> \/dst\/\.bg-part-[0-9a-f]+$/, `목적지 이름에 바로 썼다: ${copy}`);
  const temp = (copy ?? '').split(' -> ')[1];
  assert.ok(fs.log.includes(`rename ${temp} -> /dst/a.txt`), '임시 파일을 목적지 이름으로 rename 하지 않았다');
  assert.deepEqual(fs.list('/dst'), ['a.txt']);
});

// @req FR-FOP-005
test('새 파일 쓰기가 도중에 실패해 건너뛰면 임시 파일이 남지 않고 목적지 이름은 한 번도 생기지 않는다', async () => {
  const fs = new LinkFs().dir('/src').file('/src/a.txt', 'abcdefgh').dir('/dst').fail('copy', '/src/a.txt', 'EIO', 1, true);
  const r = await run(fs, { operation: 'copy', sources: ['/src/a.txt'], destDir: '/dst' }, () => 'skip');
  assert.equal(r.outcome, 'completed');
  assert.deepEqual(fs.list('/dst'), [], `부분본이나 임시 파일이 남았다: ${fs.list('/dst')}`);
  assert.ok(!fs.log.some((l) => l.endsWith('-> /dst/a.txt') && l.startsWith('copy ')), '목적지 이름에 바로 썼다');
});

// @req FR-FOP-005
test('임시 파일을 다 쓴 사이 목적지 이름에 남의 파일이 생기면 덮어쓰지 않고 EEXIST 결정을 묻는다', async () => {
  const fs = new LinkFs().dir('/src').file('/src/a.txt', 'mine').dir('/dst');
  let armed = true;
  const inner = fs.copyFileStream.bind(fs);
  fs.copyFileStream = async (src, dst, onBytes) => {
    await inner(src, dst, onBytes);
    if (armed) {
      armed = false;
      fs.file('/dst/a.txt', 'theirs');
    }
  };
  const r = await run(fs, { operation: 'copy', sources: ['/src/a.txt'], destDir: '/dst' }, () => 'skip');
  assert.equal(r.outcome, 'completed', `작업이 실패로 끝났다: ${codeOf(r.error)}`);
  assert.deepEqual(r.asked.map((q) => [q.kind, q.detail]), [['error', 'EEXIST']]);
  assert.equal(fs.text('/dst/a.txt'), 'theirs', '남의 파일을 덮어썼다');
  assert.deepEqual(fs.list('/dst'), ['a.txt'], '임시 파일이 남았다');
  assert.ok(!fs.log.includes('unlink /dst/a.txt'), '남의 파일을 지웠다');
});

// ── RCK-005 : '..' 로 시작하는 이름의 자식도 자기 안이다 ─────────────────────────

// @req FR-FOP-001
test("디렉터리를 '..x' 라는 이름의 자기 하위 디렉터리로 복사·이동하면 자기 안으로 판정해 EINVAL 로 실패한다", async () => {
  for (const operation of ['copy', 'move'] as const) {
    const fs = new LinkFs().dir('/vol').dir('/vol/d').file('/vol/d/a.txt', 'a').dir('/vol/d/..x');
    const r = await run(fs, { operation, sources: ['/vol/d'], destDir: '/vol/d/..x' }, () => 'skip');
    assert.equal(r.outcome, 'failed', `${operation}: '..x' 를 출발지 밖으로 보았다`);
    assert.equal(codeOf(r.error), 'EINVAL');
    assert.deepEqual(fs.list('/vol/d/..x'), []);
  }
});

// ── RCK-003 : 스캔 중 하위 폴더를 읽지 못해도 작업 전체를 실패시키지 않는다 ─────────

// @req FR-FEX-007 AC-5
// @req FR-FOP-001
test('복사 스캔 중 하위 폴더의 readdir 이 EACCES 면 retry·skip 을 묻고, skip 하면 그 폴더만 빠진 채 나머지를 복사한다', async () => {
  const fs = new LinkFs().dir('/src').dir('/src/d').file('/src/d/ok.txt', 'ok').dir('/src/d/locked').file('/src/d/locked/s.txt', 's').dir('/dst');
  fs.fail('readdir', '/src/d/locked', 'EACCES');
  const r = await run(fs, { operation: 'copy', sources: ['/src/d'], destDir: '/dst' }, () => 'skip');
  assert.equal(r.outcome, 'completed', `스캔 중 폴더 하나의 읽기 오류로 작업이 끝났다: ${codeOf(r.error)}`);
  assert.deepEqual(r.asked, [{ kind: 'error', path: '/src/d/locked', choices: ['retry', 'skip'], detail: 'EACCES' }]);
  assert.equal(fs.text('/dst/d/ok.txt'), 'ok');
  assert.equal(fs.has('/dst/d/locked'), false, '건너뛴 폴더를 목적지에 만들었다');
  const last = r.progress[r.progress.length - 1];
  assert.equal(last.processedEntries, last.totalEntries, '건너뛴 폴더를 처리한 것으로 세지 않아 막대가 100% 에 닿지 않는다');
});

// @req FR-FOP-001
test('스캔 중 readdir 오류에 retry 를 고르면 그 폴더를 다시 읽어 자식까지 복사한다', async () => {
  const fs = new LinkFs().dir('/src').dir('/src/d').dir('/src/d/locked').file('/src/d/locked/s.txt', 's').dir('/dst');
  fs.fail('readdir', '/src/d/locked', 'EBUSY');
  const r = await run(fs, { operation: 'copy', sources: ['/src/d'], destDir: '/dst' }, () => 'retry');
  assert.equal(r.outcome, 'completed', `작업이 실패로 끝났다: ${codeOf(r.error)}`);
  assert.equal(r.asked.length, 1);
  assert.equal(fs.text('/dst/d/locked/s.txt'), 's');
});

// @req FR-FOP-002
// @req SEC-FOP-001
test('삭제 스캔에서 읽지 못해 건너뛴 폴더는 지우지 않고, 그것이 남은 부모도 지우지 않은 채 나머지를 지운다', async () => {
  const fs = new LinkFs().dir('/src').dir('/src/d').file('/src/d/ok.txt', 'ok').dir('/src/d/locked').file('/src/d/locked/s.txt', 's');
  fs.fail('readdir', '/src/d/locked', 'EACCES');
  const r = await run(fs, { operation: 'delete', sources: ['/src/d'] }, () => 'skip');
  assert.equal(r.outcome, 'completed', `작업이 실패로 끝났다: ${codeOf(r.error)}`);
  assert.equal(fs.has('/src/d/ok.txt'), false);
  assert.equal(fs.text('/src/d/locked/s.txt'), 's', '읽지 못한(스캔하지 않은) 폴더의 내용이 지워졌다');
  assert.equal(fs.has('/src/d'), true);
  assert.ok(!fs.log.includes('rmdir /src/d/locked'), '건너뛴 폴더에 rmdir 을 시도했다');
});

// @req FR-FOP-002
test('최상위 출발지 폴더를 읽지 못해 건너뛰면 삭제는 그것을 지우지 않는다', async () => {
  const fs = new LinkFs().dir('/src').dir('/src/locked').file('/src/locked/s.txt', 's');
  fs.fail('readdir', '/src/locked', 'EACCES');
  const r = await run(fs, { operation: 'delete', sources: ['/src/locked'] }, () => 'skip');
  assert.equal(r.outcome, 'completed', `작업이 실패로 끝났다: ${codeOf(r.error)}`);
  assert.equal(fs.text('/src/locked/s.txt'), 's');
  assert.ok(!fs.log.some((l) => l === 'rmdir /src/locked' || l === 'unlink /src/locked'), `건너뛴 폴더를 지우려 했다: ${fs.log}`);
});

// @req FR-FOP-005
test('같은 장치 이동에서 읽지 못해 건너뛴 폴더는 옮기지 않는다 — 그 폴더를 품은 부모도 rename 한 번으로 통째로 옮기지 않는다', async () => {
  const fs = new LinkFs().dir('/vol').dir('/vol/d').file('/vol/d/ok.txt', 'ok').dir('/vol/d/locked').file('/vol/d/locked/s.txt', 's').dir('/vol/out');
  fs.fail('readdir', '/vol/d/locked', 'EACCES');
  const r = await run(fs, { operation: 'move', sources: ['/vol/d'], destDir: '/vol/out' }, () => 'skip');
  assert.equal(r.outcome, 'completed', `작업이 실패로 끝났다: ${codeOf(r.error)}`);
  assert.equal(fs.text('/vol/d/locked/s.txt'), 's', '건너뛴 폴더가 옮겨졌다');
  assert.equal(fs.has('/vol/out/d/locked'), false);
  assert.equal(fs.text('/vol/out/d/ok.txt'), 'ok');
  assert.equal(fs.has('/vol/d'), true, '건너뛴 폴더가 남은 부모를 지웠다');

  const top = new LinkFs().dir('/vol').dir('/vol/locked').file('/vol/locked/s.txt', 's').dir('/vol/out');
  top.fail('readdir', '/vol/locked', 'EACCES');
  const r2 = await run(top, { operation: 'move', sources: ['/vol/locked'], destDir: '/vol/out' }, () => 'skip');
  assert.equal(r2.outcome, 'completed');
  assert.equal(top.text('/vol/locked/s.txt'), 's');
  assert.equal(top.has('/vol/out/locked'), false, '건너뛴 최상위 폴더를 rename 으로 옮겼다');
});

// ── RCK-004 : 새 파일은 하드 링크로 "없을 때만" 놓는다 ──────────────────────────

/** 하드 링크를 아는 가짜 fs. hardLinkError 가 있으면 다음 hardLink 가 그 코드로 실패한다. */
class HardLinkFs extends LinkFs {
  hardLinkError?: string;

  async hardLink(rawExisting: string, rawNew: string): Promise<void> {
    const existing = norm(rawExisting);
    const next = norm(rawNew);
    this.log.push(`hardlink ${existing} -> ${next}`);
    if (this.hardLinkError !== undefined) {
      const code = this.hardLinkError;
      this.hardLinkError = undefined;
      throw fsError(code, next);
    }
    const node = this.nodes.get(existing);
    if (!node || node.kind !== 'file') throw fsError('ENOENT', existing);
    if (this.nodes.has(next)) throw fsError('EEXIST', next);
    if (this.nodes.get(parentOf(next))?.kind !== 'directory') throw fsError('ENOENT', next);
    this.nodes.set(next, { kind: 'file', data: Buffer.from(node.data) });
  }
}

// @req FR-FOP-005
test('hardLink 가 있으면 새 파일은 임시 이름에서 목적지로 하드 링크한 뒤 임시 이름을 지운다 — rename 으로 놓지 않는다', async () => {
  const fs = new HardLinkFs().dir('/src').file('/src/a.txt', 'aaaa').dir('/dst');
  const r = await run(fs, { operation: 'copy', sources: ['/src/a.txt'], destDir: '/dst' }, () => 'skip');
  assert.equal(r.outcome, 'completed', `작업이 실패로 끝났다: ${codeOf(r.error)}`);
  const copy = fs.log.find((l) => l.startsWith('copy ')) ?? '';
  const temp = copy.split(' -> ')[1];
  assert.ok(fs.log.includes(`hardlink ${temp} -> /dst/a.txt`), `하드 링크로 놓지 않았다: ${fs.log}`);
  assert.ok(fs.log.includes(`unlink ${temp}`), '임시 이름을 지우지 않았다');
  assert.ok(!fs.log.some((l) => l.startsWith('rename ') && l.endsWith('-> /dst/a.txt')), '새 파일을 rename 으로 놓았다(교체 가능)');
  // 충돌 확인의 lstat 한 번뿐이다 — 쓰기 뒤의 재확인은 하드 링크가 대신한다.
  assert.equal(fs.log.filter((l) => l === 'lstat /dst/a.txt').length, 1, `쓰기 뒤 lstat 재확인을 했다: ${fs.log}`);
  assert.deepEqual(fs.list('/dst'), ['a.txt']);
  assert.equal(fs.text('/dst/a.txt'), 'aaaa');
});

// @req FR-FOP-005
test('하드 링크가 EEXIST 로 실패하면(쓰는 사이 남의 파일이 생겼다) 그 파일을 건드리지 않고 EEXIST 결정을 묻는다', async () => {
  const fs = new HardLinkFs().dir('/src').file('/src/a.txt', 'mine').dir('/dst');
  let armed = true;
  const inner = fs.copyFileStream.bind(fs);
  fs.copyFileStream = async (src, dst, onBytes) => {
    await inner(src, dst, onBytes);
    if (armed) {
      armed = false;
      fs.file('/dst/a.txt', 'theirs');
    }
  };
  // 러너가 lstat 재확인으로 먼저 잡으면 하드 링크 경로를 시험하지 못한다 — 쓰기 뒤 lstat 은 없는 것으로 보이게 한다.
  fs.lstatOverride = (p, nth, actual) => (p === '/dst/a.txt' && nth >= 2 ? null : actual);
  const r = await run(fs, { operation: 'copy', sources: ['/src/a.txt'], destDir: '/dst' }, () => 'skip');
  assert.equal(r.outcome, 'completed', `작업이 실패로 끝났다: ${codeOf(r.error)}`);
  assert.deepEqual(r.asked.map((q) => [q.kind, q.detail]), [['error', 'EEXIST']]);
  assert.equal(fs.text('/dst/a.txt'), 'theirs', '남의 파일을 덮어썼다');
  assert.deepEqual(fs.list('/dst'), ['a.txt'], '임시 파일이 남았다');
});

// FAT·exFAT·일부 SMB 는 하드 링크가 없다. 그때 작업이 실패하면 그런 볼륨으로는 아무것도 복사할 수 없다.
for (const code of ['EPERM', 'ENOTSUP', 'EISDIR', 'ENOSYS', 'EXDEV']) {
  // @req FR-FOP-005
  test(`하드 링크가 ${code} 로 실패하면(하드 링크가 없는 볼륨) lstat 재확인 + rename 으로 되돌아가 파일을 놓는다`, async () => {
    const fs = new HardLinkFs().dir('/src').file('/src/a.txt', 'aaaa').dir('/dst');
    fs.hardLinkError = code;
    const r = await run(fs, { operation: 'copy', sources: ['/src/a.txt'], destDir: '/dst' }, () => 'skip');
    assert.equal(r.outcome, 'completed', `작업이 실패로 끝났다: ${codeOf(r.error)}`);
    assert.deepEqual(r.asked, [], '하드 링크 미지원을 사용자에게 물었다');
    const temp = (fs.log.find((l) => l.startsWith('copy ')) ?? '').split(' -> ')[1];
    assert.ok(fs.log.includes(`rename ${temp} -> /dst/a.txt`), `rename 으로 되돌아가지 않았다: ${fs.log}`);
    assert.deepEqual(fs.list('/dst'), ['a.txt']);
    assert.equal(fs.text('/dst/a.txt'), 'aaaa');
  });
}

// @req FR-FOP-005
test('덮어쓰기는 하드 링크가 아니라 rename 으로 기존 파일을 교체한다', async () => {
  const fs = new HardLinkFs().dir('/src').file('/src/a.txt', 'new').dir('/dst').file('/dst/a.txt', 'old');
  const r = await run(fs, { operation: 'copy', sources: ['/src/a.txt'], destDir: '/dst' }, () => 'overwrite');
  assert.equal(r.outcome, 'completed', `작업이 실패로 끝났다: ${codeOf(r.error)}`);
  assert.equal(fs.text('/dst/a.txt'), 'new');
  assert.ok(!fs.log.some((l) => l.startsWith('hardlink ')), '덮어쓰기에 하드 링크를 썼다');
});

// RCK-006: 목록에서 숨기는 이름과 러너가 실제로 쓰는 임시 이름이 어긋나면 숨김이 공허해진다.
// @req FR-FOP-005
test('러너가 새 파일을 쓰는 임시 이름은 isFileJobTempName 이 알아보는 이름이다', async () => {
  const { isFileJobTempName } = (await import('./fileJobRunner.js')) as unknown as { isFileJobTempName?: (name: string) => boolean };
  assert.equal(typeof isFileJobTempName, 'function', 'isFileJobTempName 이 export 되지 않았다');
  const fs = new LinkFs().dir('/src').file('/src/a.txt', 'a').dir('/dst');
  await run(fs, { operation: 'copy', sources: ['/src/a.txt'], destDir: '/dst' }, () => 'skip');
  const temp = (fs.log.find((l) => l.startsWith('copy ')) ?? '').split(' -> ')[1] ?? '';
  const name = temp.slice(temp.lastIndexOf('/') + 1);
  assert.ok(name.length > 0, `임시 이름을 찾지 못했다: ${fs.log}`);
  assert.equal(isFileJobTempName!(name), true, `${name} 을 임시 이름으로 알아보지 못한다`);
});
