// FR-FOP-005 · SEC-FOP-001 — 배타 생성과 이동의 내구성.
//
// 계약(T-PH001-06 리뷰 후속):
//   copyFileStream(src, dst, onBytes, signal?, options?) 은 dst 를 배타적으로 만든다('wx').
//     러너는 없다고 확인한 경로(또는 새 임시 이름)에만 쓰므로 이미 있으면 그것은 남의 파일이다 —
//     EEXIST 로 실패해야 하고, 러너는 그 경로를 정리한다고 unlink 하지 않는다.
//   options.durable 이 true 면 resolve 전에 사본을 디스크에 flush 한다. 러너는 EXDEV 이동에서
//     원본을 지우기 전의 복사에 durable 을 요구한다 — 정전 뒤 사본은 비고 원본 삭제만 반영되면
//     파일이 양쪽에서 사라진다.
//
// 모듈은 테스트마다 동적으로 import 한다(fileJobRunner.test.ts 와 같은 이유).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface FsStat {
  kind: 'file' | 'directory';
  size: number;
}

interface CopyOptions {
  durable?: boolean;
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
    options?: CopyOptions,
  ): Promise<void>;
  unlink(p: string): Promise<void>;
  rmdir(p: string): Promise<void>;
  rename(src: string, dst: string): Promise<void>;
}

interface FileJobResult {
  outcome: 'completed' | 'cancelled' | 'failed';
  processedEntries: number;
  error?: unknown;
  atomic?: boolean;
}

type RunJob = (
  spec: { operation: 'copy' | 'move' | 'delete'; sources: string[]; destDir?: string },
  deps: {
    fsOps: FileJobFsOps;
    validatePath: (p: string) => void;
    decide: () => Promise<{ choice: 'overwrite' | 'rename' | 'skip' }>;
    onProgress: () => void;
  },
) => Promise<FileJobResult>;

async function loadRunner(): Promise<RunJob> {
  return ((await import('./fileJobRunner.js')) as unknown as { runJob: RunJob }).runJob;
}

const norm = (p: string): string => p.replace(/\\/g, '/');
const parentOf = (p: string): string => {
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
};
const topOf = (p: string): string => `/${p.split('/')[1] ?? ''}`;

type Node = { kind: 'file'; data: Buffer } | { kind: 'directory' };

type LogEntry =
  | { op: 'unlink'; path: string }
  | { op: 'copy-call'; src: string; path: string; durable: boolean }
  | { op: 'copy-done'; src: string; path: string };

function fsError(code: string, p: string): Error {
  const err = new Error(`${code}: ${p}`) as Error & { code: string };
  err.code = code;
  return err;
}

/** 배타 생성을 흉내 내는 가짜. rename 은 최상위가 다르면 EXDEV. */
class MemoryFs implements FileJobFsOps {
  readonly nodes = new Map<string, Node>([['/', { kind: 'directory' }]]);
  readonly log: LogEntry[] = [];
  /** lstat 가 path 를 본 직후 불린다 — 확인과 쓰기 사이에 끼어드는 다른 프로세스를 흉내 낸다. */
  afterLstat: (path: string) => void = () => {};

  dir(p: string): this {
    this.nodes.set(p, { kind: 'directory' });
    return this;
  }

  file(p: string, data: Buffer): this {
    this.nodes.set(p, { kind: 'file', data });
    return this;
  }

  bytes(p: string): Buffer | undefined {
    const node = this.nodes.get(p);
    return node && node.kind === 'file' ? node.data : undefined;
  }

  list(p: string): string[] {
    const prefix = p === '/' ? '/' : `${p}/`;
    return [...this.nodes.keys()]
      .filter((k) => k !== p && k.startsWith(prefix) && !k.slice(prefix.length).includes('/'))
      .map((k) => k.slice(prefix.length))
      .sort();
  }

  async lstat(raw: string): Promise<FsStat | null> {
    const p = norm(raw);
    const node = this.nodes.get(p);
    const result: FsStat | null = !node
      ? null
      : node.kind === 'file'
        ? { kind: 'file', size: node.data.length }
        : { kind: 'directory', size: 0 };
    this.afterLstat(p);
    return result;
  }

  async readdir(raw: string): Promise<string[]> {
    return this.list(norm(raw));
  }

  async mkdir(raw: string): Promise<void> {
    const p = norm(raw);
    if (this.nodes.has(p)) throw fsError('EEXIST', p);
    this.nodes.set(p, { kind: 'directory' });
  }

  async copyFileStream(
    rawSrc: string,
    rawDst: string,
    onBytes: (n: number) => void,
    _signal?: AbortSignal,
    options?: CopyOptions,
  ): Promise<void> {
    const src = norm(rawSrc);
    const dst = norm(rawDst);
    this.log.push({ op: 'copy-call', src, path: dst, durable: options?.durable === true });
    const node = this.nodes.get(src);
    if (!node || node.kind !== 'file') throw fsError('ENOENT', src);
    // 'wx' — 이미 있으면 열지 않는다.
    if (this.nodes.has(dst)) throw fsError('EEXIST', dst);
    this.nodes.set(dst, { kind: 'file', data: Buffer.from(node.data) });
    onBytes(node.data.length);
    this.log.push({ op: 'copy-done', src, path: dst });
  }

  async unlink(raw: string): Promise<void> {
    const p = norm(raw);
    this.log.push({ op: 'unlink', path: p });
    if (!this.nodes.delete(p)) throw fsError('ENOENT', p);
  }

  async rmdir(raw: string): Promise<void> {
    const p = norm(raw);
    if (this.list(p).length > 0) throw fsError('ENOTEMPTY', p);
    this.nodes.delete(p);
  }

  async rename(rawSrc: string, rawDst: string): Promise<void> {
    const src = norm(rawSrc);
    const dst = norm(rawDst);
    if (topOf(src) !== topOf(dst)) throw fsError('EXDEV', `${src} -> ${dst}`);
    const node = this.nodes.get(src);
    if (!node) throw fsError('ENOENT', src);
    if (parentOf(dst) && !this.nodes.has(parentOf(dst))) throw fsError('ENOENT', dst);
    this.nodes.delete(src);
    this.nodes.set(dst, node);
  }
}

function deps(fs: MemoryFs): Parameters<RunJob>[1] {
  return { fsOps: fs, validatePath: () => {}, decide: async () => ({ choice: 'skip' }), onProgress: () => {} };
}

// 러너는 새 파일도 임시 이름에 쓴 뒤 rename 한다(FR-FOP-005) — 목적지 이름에 쓰기 스트림을 열지 않는다.
// 그래서 배타 생성('wx')은 임시 이름을 지키고, 목적지 이름은 rename 직전의 재확인이 지킨다. 그 사이 생긴
// 남의 파일은 작업 실패가 아니라 그 항목의 fs 오류(EEXIST) 결정이다(FR-FEX-007 AC-5).
test('확인 뒤 목적지에 남의 파일이 생기면 러너는 그 파일을 덮어쓰거나 지우지 않고 EEXIST 오류 결정을 묻는다', async () => {
  const runJob = await loadRunner();
  const theirs = Buffer.from('someone else wrote this');
  const fs = new MemoryFs().dir('/src').file('/src/a.bin', Buffer.alloc(32, 0x61)).dir('/dst');
  // 러너가 /dst/a.bin 이 없다고 확인한 직후 다른 프로세스가 같은 이름으로 파일을 만든다.
  fs.afterLstat = (p) => {
    if (p === '/dst/a.bin' && !fs.nodes.has(p)) fs.file(p, theirs);
  };
  const asked: { kind: string; detail?: string }[] = [];
  const result = await runJob({ operation: 'copy', sources: ['/src/a.bin'], destDir: '/dst' }, {
    ...deps(fs),
    decide: async (req: { kind: string; detail?: string }) => {
      asked.push({ kind: req.kind, detail: req.detail });
      return { choice: 'skip' };
    },
  } as Parameters<RunJob>[1]);

  assert.ok(
    fs.log.some((e) => e.op === 'copy-call' && parentOf(e.path) === '/dst'),
    '픽스처가 경합 지점에 닿지 않았다 — 복사를 시도하지 않았다',
  );
  assert.equal(result.outcome, 'completed', `작업이 실패로 끝났다: ${(result.error as { code?: string } | undefined)?.code}`);
  assert.deepEqual(asked, [{ kind: 'error', detail: 'EEXIST' }]);
  const unlinks = fs.log.flatMap((e) => (e.op === 'unlink' ? [e.path] : []));
  assert.ok(!unlinks.includes('/dst/a.bin'), `남의 파일을 정리 대상으로 지웠다: ${JSON.stringify(unlinks)}`);
  assert.deepEqual(fs.bytes('/dst/a.bin'), theirs, '남의 파일의 바이트가 바뀌었다');
  assert.deepEqual(fs.list('/dst'), ['a.bin'], '임시 파일이 남았다');
});

test('실제 어댑터는 이미 있는 목적지에 쓰지 않고 EEXIST 로 실패한다', async () => {
  const { nodeFileJobFsOps } = (await import('./fileJobFsOps.js')) as unknown as { nodeFileJobFsOps: FileJobFsOps };
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'bg-filejob-wx-')));
  try {
    const src = join(dir, 'src.bin');
    const dst = join(dir, 'dst.bin');
    const theirs = randomBytes(4096);
    await writeFile(src, randomBytes(256 * 1024));
    await writeFile(dst, theirs);
    await assert.rejects(
      nodeFileJobFsOps.copyFileStream(src, dst, () => {}),
      (err: unknown) => (err as { code?: string }).code === 'EEXIST',
    );
    assert.ok((await readFile(dst)).equals(theirs), '이미 있던 목적지가 잘리거나 바뀌었다');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('EXDEV 이동은 원본을 지우기 전의 복사마다 durable flush 를 요구한다', async () => {
  const runJob = await loadRunner();
  const fs = new MemoryFs()
    .dir('/src')
    .file('/src/a.bin', Buffer.alloc(16, 0x61))
    .dir('/src/d')
    .file('/src/d/b.bin', Buffer.alloc(16, 0x62))
    .dir('/dst');
  const result = await runJob({ operation: 'move', sources: ['/src/a.bin', '/src/d'], destDir: '/dst' }, deps(fs));
  assert.equal(result.outcome, 'completed', `이동 실패: ${String((result.error as Error | undefined)?.message)}`);

  const copies = fs.log.flatMap((e) => (e.op === 'copy-call' ? [e] : []));
  assert.deepEqual(
    copies.map((c) => c.src),
    ['/src/a.bin', '/src/d/b.bin'],
    '파일 단위 폴백에 들어가지 않았다',
  );
  for (const copy of copies) {
    const unlinkAt = fs.log.findIndex((e) => e.op === 'unlink' && e.path === copy.src);
    const callAt = fs.log.indexOf(copy);
    assert.ok(unlinkAt > callAt, `${copy.src}: 원본 삭제가 없거나 복사보다 앞선다`);
    assert.equal(copy.durable, true, `${copy.src}: flush 없이 원본을 지웠다`);
  }
  assert.deepEqual(fs.list('/src'), []);
});
