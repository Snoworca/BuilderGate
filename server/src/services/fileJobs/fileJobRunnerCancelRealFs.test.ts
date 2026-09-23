// FR-FOP-005 — 취소·이동 의미론을 실제 디스크에서 확인한다.
//
// 가짜 fs 는 호출 순서를 보여 주지만 "디스크에서 사라졌는가" 는 보여 주지 못한다. Windows 에서는
// 열린 쓰기 스트림 아래의 unlink 가 EBUSY/EPERM 으로 실패하므로, 호출은 있었는데 파일은 남는
// 일이 실제로 생긴다. 그래서 여기서는 결과를 전부 fs.stat·readdir·바이트 비교로 본다.
//
// 계약은 fileJobRunnerCancel.test.ts 머리말과 같다. 여기서 더 요구하는 것:
//   - 덮어쓰기 도중 취소해도 목적지의 원래 파일이 바이트 그대로 남는다. createWriteStream 은
//     여는 순간 목적지를 자르므로, 목적지에 바로 쓰는 구현은 이것을 지킬 수 없다.
//   - 취소 뒤 목적지 디렉터리에 임시 파일 잔재가 없다(목록을 정확한 집합으로 비교한다).
//
// 장치 간 이동은 실제 교차 장치 파일 시스템 없이 흉내 낸다: rename 만 "출발지 루트 ↔ 목적지
// 루트" 사이에서 EXDEV 를 던지게 감싸고, 복사·삭제·같은 루트 안의 rename 은 실제 어댑터로 돈다.
//
// 실제 파일은 os.tmpdir() 아래 realpath 임시 디렉터리에서만 만들고 finally 로 지운다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';

interface FsStat {
  kind: 'file' | 'directory';
  size: number;
}

interface FileJobFsOps {
  lstat(p: string): Promise<FsStat | null>;
  readdir(p: string): Promise<string[]>;
  mkdir(p: string): Promise<void>;
  copyFileStream(src: string, dst: string, onBytes: (n: number) => void, signal?: AbortSignal): Promise<void>;
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
  signal?: AbortSignal;
}

interface FileJobResult {
  outcome: 'completed' | 'cancelled' | 'failed';
  processedEntries: number;
  error?: unknown;
  atomic?: boolean;
}

async function loadModules(): Promise<{
  runJob(spec: FileJobSpec, deps: FileJobRunnerDeps): Promise<FileJobResult>;
  nodeFileJobFsOps: FileJobFsOps;
}> {
  const runner = (await import('./fileJobRunner.js')) as unknown as {
    runJob(spec: FileJobSpec, deps: FileJobRunnerDeps): Promise<FileJobResult>;
  };
  const fsOps = (await import('./fileJobFsOps.js')) as unknown as { nodeFileJobFsOps: FileJobFsOps };
  return { runJob: runner.runJob, nodeFileJobFsOps: fsOps.nodeFileJobFsOps };
}

const MIB = 1024 * 1024;

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'bg-filejob-cancel-')));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** 디스크에서 사라졌는가. 존재하면 크기를 메시지에 싣는다. */
async function assertGone(p: string, what: string): Promise<void> {
  let size: number | undefined;
  try {
    size = (await stat(p)).size;
  } catch (err) {
    assert.equal((err as { code?: string }).code, 'ENOENT', `${what}: stat 이 ENOENT 가 아닌 오류를 냈다: ${String(err)}`);
    return;
  }
  assert.fail(`${what} 가 디스크에 남았다 (${size} B): ${p}`);
}

function errorText(result: FileJobResult): string {
  const err = result.error as { name?: string; code?: string; message?: string } | undefined;
  return err ? `${String(err.name)} ${String(err.code)} ${String(err.message)}` : '(error 없음)';
}

/** 전송 단계에서 bigSrc 의 첫 청크 보고가 오면 취소한다. 스캔 단계의 보고는 건너뛴다. */
function abortOnFirstChunkOf(bigSrc: string, controller: AbortController): (p: FileJobProgress) => void {
  return (p) => {
    if (p.phase === 'transferring' && p.currentPath === bigSrc && !controller.signal.aborted) controller.abort();
  };
}

test('실제 파일 복사 도중 abort 하면 fs.stat 이 부분 사본의 ENOENT 와 끝난 사본의 존재를 보인다 — 쓰기 스트림 destroy·close 대기 후 unlink 라 Windows 에서도 EBUSY/EPERM 이 없다', async () => {
  const { runJob, nodeFileJobFsOps } = await loadModules();
  await withTempDir(async (dir) => {
    const srcDir = join(dir, 'src');
    const dstDir = join(dir, 'dst');
    await mkdir(srcDir);
    await mkdir(dstDir);
    const done = randomBytes(128 * 1024);
    const big = randomBytes(8 * MIB);
    await writeFile(join(srcDir, 'done.bin'), done);
    await writeFile(join(srcDir, 'big.bin'), big);

    const controller = new AbortController();
    const result = await runJob(
      { operation: 'copy', sources: [join(srcDir, 'done.bin'), join(srcDir, 'big.bin')], destDir: dstDir },
      {
        fsOps: nodeFileJobFsOps,
        validatePath: () => {},
        decide: async () => ({ choice: 'skip' }),
        onProgress: abortOnFirstChunkOf(join(srcDir, 'big.bin'), controller),
        signal: controller.signal,
      },
    );
    assert.ok(controller.signal.aborted, `픽스처가 취소 지점에 닿지 않았다: ${result.outcome}`);

    // 끝난 사본: 존재하고 바이트가 같다.
    assert.ok((await readFile(join(dstDir, 'done.bin'))).equals(done), '끝난 사본 done.bin 이 온전하지 않다');
    // 쓰던 사본: 디스크에서 사라졌다. 임시 이름으로 썼더라도 잔재가 없다 — 목록을 정확히 건다.
    await assertGone(join(dstDir, 'big.bin'), '쓰다 만 big.bin');
    assert.deepEqual((await readdir(dstDir)).sort(), ['done.bin']);
    // 출발지는 복사에서 건드리지 않는다.
    assert.ok((await readFile(join(srcDir, 'big.bin'))).equals(big));
    assert.equal(result.outcome, 'cancelled', `취소가 ${result.outcome} 로 보고되었다: ${errorText(result)}`);
    assert.equal(result.processedEntries, 1);
  });
});

test('덮어쓰기 도중 취소해도 목적지의 원래 파일이 바이트 그대로 남고 임시 파일 잔재가 없다', async () => {
  const { runJob, nodeFileJobFsOps } = await loadModules();
  await withTempDir(async (dir) => {
    const srcDir = join(dir, 'src');
    const dstDir = join(dir, 'dst');
    await mkdir(srcDir);
    await mkdir(dstDir);
    const incoming = randomBytes(8 * MIB);
    const original = randomBytes(256 * 1024);
    await writeFile(join(srcDir, 'big.bin'), incoming);
    await writeFile(join(dstDir, 'big.bin'), original);

    const controller = new AbortController();
    const decisions: string[] = [];
    const result = await runJob(
      { operation: 'copy', sources: [join(srcDir, 'big.bin')], destDir: dstDir },
      {
        fsOps: nodeFileJobFsOps,
        validatePath: () => {},
        decide: async (req) => {
          decisions.push(req.path);
          return { choice: 'overwrite' };
        },
        onProgress: abortOnFirstChunkOf(join(srcDir, 'big.bin'), controller),
        signal: controller.signal,
      },
    );
    assert.equal(decisions.length, 1, '충돌을 묻지 않았다 — 덮어쓰기 경로에 들어가지 않았다');
    assert.ok(controller.signal.aborted, `픽스처가 취소 지점에 닿지 않았다: ${result.outcome}`);

    // 원래 파일이 살아 있다. 길이만 보면 우연히 같은 길이의 부분본을 놓치므로 바이트를 비교한다.
    const after = await readFile(join(dstDir, 'big.bin')).catch((err: unknown) => {
      assert.fail(`덮어쓰기 취소 뒤 원래 파일이 사라졌다: ${String(err)}`);
    });
    assert.equal(after.length, original.length, `원래 ${original.length} B 가 ${after.length} B 가 되었다`);
    assert.ok(after.equals(original), '원래 파일의 바이트가 바뀌었다');
    assert.deepEqual((await readdir(dstDir)).sort(), ['big.bin'], '목적지에 임시 파일 잔재가 있다');
    assert.equal(result.outcome, 'cancelled', `취소가 ${result.outcome} 로 보고되었다: ${errorText(result)}`);
  });
});

/**
 * 출발지 루트와 목적지 루트를 서로 다른 장치처럼 보이게 한다. rename 만 두 루트를 건널 때
 * EXDEV 를 던지고, 나머지는 실제 어댑터에 그대로 넘긴다.
 */
function crossDeviceOps(real: FileJobFsOps, srcRoot: string, dstRoot: string, renames: string[]): FileJobFsOps {
  const within = (root: string, p: string): boolean => {
    const rel = relative(root, p);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  };
  const side = (p: string): 'src' | 'dst' | 'other' => (within(srcRoot, p) ? 'src' : within(dstRoot, p) ? 'dst' : 'other');
  return {
    lstat: (p) => real.lstat(p),
    readdir: (p) => real.readdir(p),
    mkdir: (p) => real.mkdir(p),
    copyFileStream: (s, d, onBytes, signal) => real.copyFileStream(s, d, onBytes, signal),
    unlink: (p) => real.unlink(p),
    rmdir: (p) => real.rmdir(p),
    async rename(s, d) {
      renames.push(`${s} -> ${d}`);
      if (side(s) !== side(d)) {
        const err = new Error(`EXDEV: cross-device link not permitted, rename '${s}' -> '${d}'`) as Error & {
          code: string;
        };
        err.code = 'EXDEV';
        throw err;
      }
      await real.rename(s, d);
    },
  };
}

test('rename 만 EXDEV 를 던지고 복사·삭제는 실제 어댑터로 도는 이동을 도중 취소하면 이동 끝난 파일은 목적지에만 있고, 쓰던 파일은 목적지 부분본이 없고 원본이 남으며, 손대지 않은 파일은 원본에 남는다', async () => {
  const { runJob, nodeFileJobFsOps } = await loadModules();
  await withTempDir(async (dir) => {
    const srcDir = join(dir, 'src');
    const dstDir = join(dir, 'dst');
    await mkdir(join(srcDir, 'd'), { recursive: true });
    await mkdir(dstDir);
    const a = randomBytes(64 * 1024);
    const big = randomBytes(8 * MIB);
    const c = randomBytes(32 * 1024);
    await writeFile(join(srcDir, 'a.bin'), a);
    // readdir 순서에서 big.bin 이 c.bin 보다 앞선다 — c.bin 은 취소 시점에 손대지 않은 파일이다.
    await writeFile(join(srcDir, 'd', 'big.bin'), big);
    await writeFile(join(srcDir, 'd', 'c.bin'), c);

    const renames: string[] = [];
    const controller = new AbortController();
    const result = await runJob(
      { operation: 'move', sources: [join(srcDir, 'a.bin'), join(srcDir, 'd')], destDir: dstDir },
      {
        fsOps: crossDeviceOps(nodeFileJobFsOps, srcDir, dstDir, renames),
        validatePath: () => {},
        decide: async () => ({ choice: 'skip' }),
        onProgress: abortOnFirstChunkOf(join(srcDir, 'd', 'big.bin'), controller),
        signal: controller.signal,
      },
    );
    assert.equal(result.outcome, 'cancelled', `이동 취소가 ${result.outcome} 로 보고되었다: ${errorText(result)}`);
    assert.ok(renames.length >= 1, 'rename 을 시도하지 않았다 — EXDEV 분기에 들어갔는지 알 수 없다');

    // 이동을 마친 파일: 목적지에만.
    assert.ok((await readFile(join(dstDir, 'a.bin'))).equals(a), '이동을 마친 a.bin 이 목적지에 온전하지 않다');
    await assertGone(join(srcDir, 'a.bin'), '이동을 마친 a.bin 의 원본');
    // 쓰던 파일: 목적지 부분본(임시 이름 포함)이 없고 원본은 바이트 그대로.
    await assertGone(join(dstDir, 'd', 'big.bin'), '쓰다 만 big.bin 부분본');
    const dstD = await readdir(join(dstDir, 'd')).catch(() => [] as string[]);
    assert.deepEqual(dstD.sort(), [], `목적지 d 에 잔재가 있다: ${dstD.join(',')}`);
    assert.ok((await readFile(join(srcDir, 'd', 'big.bin'))).equals(big), '쓰던 big.bin 의 원본이 온전하지 않다');
    // 손대지 않은 파일: 원본에만.
    assert.ok((await readFile(join(srcDir, 'd', 'c.bin'))).equals(c));
    await assertGone(join(dstDir, 'd', 'c.bin'), '손대지 않은 c.bin 의 사본');
  });
});
