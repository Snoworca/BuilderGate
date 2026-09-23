// SEC-FOP-001 — 작업의 세션 루트는 작업을 받을 때 한 번 고정된다.
//
// 세션 cwd 는 사용자가 터미널에서 cd 할 때마다 바뀐다. 러너가 경로를 검증할 때마다 cwd 를 새로 읽으면,
// 큰 복사 도중 `cd sub` 한 번에 목적지가 "세션 밖" 이 되어 작업이 PATH_TRAVERSAL 로 끝난다. 반대로
// blockedPaths 는 설정 화면에서 바꾸면 곧바로 적용되어야 하므로 매번 새로 읽는다.
//
// 실제 fs 로 돈다 — 루트의 realpath 고정은 실제 경로 해석을 거쳐야 의미가 있다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runJob } from './fileJobRunner.js';
import { nodeFileJobFsOps, type FileJobFsOps } from './fileJobFsOps.js';
import * as paths from './fileJobPaths.js';

type Capture = (policy: paths.FileJobPathPolicy, sessionId: string) => Promise<string>;
type Validate = (policy: paths.FileJobPathPolicy, sessionId: string, p: string, options?: { root?: Promise<string> }) => Promise<unknown>;

const captureSessionRoot = (paths as unknown as { captureSessionRoot?: Capture }).captureSessionRoot;
const validateCreatePath = paths.validateCreatePath as unknown as Validate;

async function withProject(run: (proj: string) => Promise<void>): Promise<void> {
  const proj = await realpath(await mkdtemp(join(tmpdir(), 'bg-fj-root-')));
  try {
    await run(proj);
  } finally {
    await rm(proj, { recursive: true, force: true });
  }
}

// @req SEC-FOP-001
test('작업 도중 세션 cwd 가 하위 디렉터리로 바뀌어도(cd) 작업은 받을 때의 루트로 검증해 끝까지 간다', async () => {
  await withProject(async (proj) => {
    await mkdir(join(proj, 'big'));
    for (let i = 0; i < 5; i += 1) await writeFile(join(proj, 'big', `f${i}`), 'x');
    await mkdir(join(proj, 'backup'));
    let cwd = proj;
    const policy: paths.FileJobPathPolicy = { getCwd: async () => cwd, blockedPaths: ['.ssh'] };
    // 운영 배선(index.ts 의 validatePathFor)과 같은 모양 — 작업을 받을 때 루트를 한 번 잡는다.
    const root = captureSessionRoot?.(policy, 's');
    const v = async (p: string): Promise<void> => {
      await validateCreatePath(policy, 's', p, root === undefined ? undefined : { root });
    };
    let copies = 0;
    const fsOps: FileJobFsOps = {
      ...nodeFileJobFsOps,
      async copyFileStream(...args) {
        await nodeFileJobFsOps.copyFileStream(...args);
        copies += 1;
        // 사용자가 터미널에서 `cd big` 을 친다.
        if (copies === 2) cwd = join(proj, 'big');
      },
    };
    const result = await runJob(
      { operation: 'copy', sources: [join(proj, 'big')], destDir: join(proj, 'backup') },
      { fsOps, validatePath: v, validateSourcePath: v, decide: async () => ({ choice: 'skip' }), onProgress: () => {} },
    );
    assert.equal(copies >= 2, true, '픽스처가 cwd 를 바꾸는 지점에 닿지 않았다');
    assert.equal(result.outcome, 'completed', `cd 한 번에 작업이 끝났다: ${(result.error as { code?: string } | undefined)?.code}`);
    assert.deepEqual((await readdir(join(proj, 'backup', 'big'))).sort(), ['f0', 'f1', 'f2', 'f3', 'f4']);
  });
});

// @req SEC-FOP-001
test('고정한 루트 밖의 경로는 여전히 거부되고, blockedPaths 는 고정되지 않고 매번 새로 읽힌다', async () => {
  await withProject(async (proj) => {
    await mkdir(join(proj, 'session'));
    await mkdir(join(proj, 'session', 'keys'));
    await mkdir(join(proj, 'other'));
    const policy = { getCwd: async () => join(proj, 'session'), blockedPaths: [] as string[] };
    assert.ok(captureSessionRoot, 'captureSessionRoot 가 없다');
    const root = captureSessionRoot(policy, 's');
    await assert.rejects(validateCreatePath(policy, 's', join(proj, 'other', 'x'), { root }), { code: 'PATH_TRAVERSAL' });
    await validateCreatePath(policy, 's', join(proj, 'session', 'keys', 'x'), { root });
    policy.blockedPaths = ['keys'];
    await assert.rejects(validateCreatePath(policy, 's', join(proj, 'session', 'keys', 'x'), { root }), { code: 'PATH_BLOCKED' });
  });
});

// @req SEC-FOP-001
test('없는 세션의 루트를 잡아 두기만 하고 쓰지 않아도 처리되지 않은 거부가 남지 않는다', async () => {
  assert.ok(captureSessionRoot, 'captureSessionRoot 가 없다');
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', onUnhandled);
  try {
    const policy = { getCwd: async () => Promise.reject(Object.assign(new Error('gone'), { code: 'SESSION_NOT_FOUND' })), blockedPaths: [] };
    captureSessionRoot(policy, 'missing');
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  assert.deepEqual(unhandled, []);
});
