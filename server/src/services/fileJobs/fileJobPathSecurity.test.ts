// SEC-FOP-001 AC-2 — 작업 도중 만들어지는 경로의 보안을 실제 디스크에서 확인한다.
//
// 가짜 fs 로는 링크를 흉내 낼 수 없다. 문제는 "검증기가 부른 경로 문자열" 이 아니라 "그 경로가
// 디스크에서 실제로 어디에 닿는가" 이고, 그것은 OS 가 링크를 풀어야만 드러난다. 그래서 실제
// FileJobManager + 실제 runJob + 실제 nodeFileJobFsOps + 실제 경로 정책 함수로 작업을 돌리고,
// 결과는 전부 fs.stat·readdir 로 본다.
//
// 지키는 틈(계획 R-06): resolveAndValidate 는 대상이 아직 없으면(ENOENT) realpath 없이 입력
// 경로를 그대로 돌려준다. 그러면 링크 아래에 새로 만들 경로는 문자열로는 cwd 안이지만 디스크에서는
// cwd 밖(또는 blocked 디렉터리 안)에 만들어진다. 막는 방법은 만들 경로의 가장 가까운 기존 조상을
// realpath 로 풀어 세션 정책으로 검증하는 것이다.
//
// 관리자가 러너에 넘기는 검증기: fileJobPaths 가 만들 경로 전용 검증(validateCreatePath)을
// 내보내면 그것을, 아니면 기존 validateSessionPath 를 쓴다. 둘 다 (policy, sessionId, p) 모양이다.
// 운영 배선이 쓰는 함수가 곧 이 테스트가 쓰는 함수여야 하므로 가짜 검증기를 만들지 않는다.
//
// 링크: 디렉터리 링크는 junction 으로 만든다 — Windows 에서 권한이 필요 없다. 그래도 EPERM 이면
// 이유를 적은 skip 으로 보고한다. 조용히 통과시키면 "링크가 없어서 통과" 와 구별되지 않는다.
//
// 실제 파일은 os.tmpdir() 아래 realpath 임시 디렉터리에서만 만들고 finally 로 지운다. 두 세션
// cwd 와 cwd 밖 디렉터리는 같은 임시 루트의 형제다 — 서로 realpath 가 다르다.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppError, ErrorCode } from '../../utils/errors.js';
import { FileJobManager, type FileJobEvent } from './fileJobManager.js';
import { nodeFileJobFsOps } from './fileJobFsOps.js';
import { runJob } from './fileJobRunner.js';
import * as fileJobPaths from './fileJobPaths.js';
import type { FileJobPathPolicy } from './fileJobPaths.js';

const SRC_SESSION = 'session-src';
const DEST_SESSION = 'session-dest';
const BLOCKED_SEGMENT = '.git';
/** 링크 대상에만 있는 큰 파일. 스캔이 링크를 따라가면 분모에 이만큼이 실린다. */
const OUTSIDE_BIG_BYTES = 1024 * 1024;
/** 작업 하나가 끝나기를 기다리는 상한. 넘으면 걸린 것으로 보고 실패시킨다 — 멈춘 채 두지 않는다. */
const JOB_DONE_TIMEOUT_MS = 20_000;

type PolicyFn = (policy: FileJobPathPolicy, sessionId: string, p: string) => Promise<string>;

/** 만들 경로 전용 검증이 있으면 그것, 없으면 기존 세션 경로 검증. */
function creationValidator(): PolicyFn {
  const exported = (fileJobPaths as unknown as Record<string, unknown>).validateCreatePath;
  return typeof exported === 'function' ? (exported as PolicyFn) : fileJobPaths.validateSessionPath;
}

interface Broadcast {
  sessionId: string;
  event: FileJobEvent;
  payload: Record<string, unknown>;
}

interface Fixture {
  root: string;
  srcCwd: string;
  destCwd: string;
  /** 두 세션 cwd 어디에도 속하지 않는 형제 디렉터리. */
  outside: string;
}

interface JobRun {
  outcome: string;
  decisions: Record<string, unknown>[];
  progress: Record<string, unknown>[];
}

async function withFixture(run: (f: Fixture) => Promise<void>): Promise<void> {
  // realpath 로 정규화한다 — tmpdir 에 8.3 이름이나 링크가 섞여 있으면 정상 경로도 cwd 밖으로 판정된다.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'fjsec-')));
  try {
    const f: Fixture = {
      root,
      srcCwd: join(root, 'src-cwd'),
      destCwd: join(root, 'dest-cwd'),
      outside: join(root, 'outside'),
    };
    await mkdir(f.srcCwd);
    await mkdir(f.destCwd);
    await mkdir(f.outside);
    await writeFile(join(f.outside, 'secret.txt'), 'outside-secret');
    await writeFile(join(f.outside, 'big.bin'), Buffer.alloc(OUTSIDE_BIG_BYTES, 7));
    await mkdir(join(f.outside, 'nested'));
    await writeFile(join(f.outside, 'nested', 'deep.txt'), 'deep');
    await run(f);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * 디렉터리 링크를 만든다. 만들 수 없으면(EPERM) 이유를 적어 skip 하고 false 를 돌려준다.
 * 다른 오류는 그대로 던진다 — 픽스처 결함을 skip 으로 숨기지 않는다.
 */
async function linkDir(t: TestContext, target: string, linkPath: string): Promise<boolean> {
  try {
    await symlink(target, linkPath, 'junction');
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EPERM') {
      t.skip('symlink needs privilege on this host (EPERM)');
      return false;
    }
    throw err;
  }
}

// lstat: 링크를 따라가지 않는다. 대상이 없는 링크가 만들어져도 "있다" 로 보아야 한다.
async function exists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/** dir 아래의 모든 이름(링크는 따라가지 않는다). */
async function listTree(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    out.push(entry.name);
    if (entry.isDirectory()) out.push(...(await listTree(join(dir, entry.name))));
  }
  return out;
}

/**
 * 실제 관리자로 작업 하나를 끝까지 돌린다. 결정이 오면 skip 을, 없으면 그 질문의 첫 선택지를
 * 답한다 — 이 테스트는 결정의 존재와 디스크 결과를 보지, 답의 종류를 보지 않는다.
 */
async function runRealJob(
  f: Fixture,
  input: { operation: 'copy' | 'move'; sources: string[]; destDir: string },
  /** 결정을 답하기 직전에 부른다 — 작업이 질문에 멈춰 있는 동안 디스크를 바꾸는 case 용. */
  beforeAnswer?: (decision: Record<string, unknown>) => Promise<void>,
): Promise<JobRun> {
  const policy: FileJobPathPolicy = {
    async getCwd(sessionId) {
      if (sessionId === SRC_SESSION) return f.srcCwd;
      if (sessionId === DEST_SESSION) return f.destCwd;
      throw new AppError(ErrorCode.SESSION_NOT_FOUND);
    },
    blockedPaths: [BLOCKED_SEGMENT],
  };
  const validate = creationValidator();
  const broadcasts: Broadcast[] = [];
  let onEvent: () => void = () => {};

  const manager = new FileJobManager({
    runJob,
    fsOps: nodeFileJobFsOps,
    broadcast: (sessionId, event, payload) => {
      broadcasts.push({ sessionId, event, payload });
      onEvent();
    },
    clock: { now: () => Date.now() },
    timers: { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout) },
    validatePathFor: (sessionId) => async (p) => {
      await validate(policy, sessionId, p);
    },
  });

  try {
    const { jobId } = manager.start({
      sourceSessionId: SRC_SESSION,
      destSessionId: DEST_SESSION,
      spec: { operation: input.operation, sources: input.sources, destDir: input.destDir },
    });

    // 한 작업의 이벤트가 두 세션에 한 번씩 나간다 — 출발지 세션 쪽만 본다.
    const mine = (event: FileJobEvent): Broadcast[] =>
      broadcasts.filter((b) => b.sessionId === SRC_SESSION && b.event === event && b.payload.jobId === jobId);
    const answered = new Set<unknown>();

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        manager.cancel(jobId);
        reject(new Error(`file job did not finish within ${JOB_DONE_TIMEOUT_MS}ms`));
      }, JOB_DONE_TIMEOUT_MS);
      onEvent = () => {
        for (const d of mine('file-job:decision-required')) {
          if (answered.has(d.payload.decisionId)) continue;
          answered.add(d.payload.decisionId);
          const choices = (d.payload.choices as string[] | undefined) ?? [];
          if (choices.length === 0) {
            manager.cancel(jobId);
            continue;
          }
          const choice = choices.includes('skip') ? 'skip' : choices[0];
          // 관리자는 broadcast 를 부르는 동안 아직 pending 을 확정하지 않았을 수 있다 — 한 틱 뒤에 답한다.
          setImmediate(() => {
            void (async () => {
              if (beforeAnswer) await beforeAnswer(d.payload);
              manager.decide(jobId, { decisionId: String(d.payload.decisionId), choice: choice as 'skip' });
            })().catch(reject);
          });
        }
        if (mine('file-job:done').length > 0) {
          clearTimeout(timer);
          resolve();
        }
      };
      onEvent();
    });

    return {
      outcome: String(mine('file-job:done')[0].payload.outcome),
      decisions: mine('file-job:decision-required').map((b) => b.payload),
      progress: mine('file-job:progress').map((b) => b.payload),
    };
  } finally {
    manager.dispose();
  }
}

test('출발지 트리 안에 cwd 밖 디렉터리를 가리키는 junction 이 있으면 그 항목이 kind=error 결정을 내고 그 아래 목적지 경로가 하나도 만들어지지 않는다', async (t) => {
  await withFixture(async (f) => {
    const tree = join(f.srcCwd, 'tree');
    await mkdir(tree);
    await writeFile(join(tree, 'keep.txt'), 'keep');
    if (!(await linkDir(t, f.outside, join(tree, 'link')))) return;
    const destDir = join(f.destCwd, 'out');
    await mkdir(destDir);

    const result = await runRealJob(f, { operation: 'copy', sources: [tree], destDir });

    // 링크를 만났을 때 작업 전체를 실패로 끝내면 사용자는 나머지 항목을 얻지 못하고 이유도 모른다.
    // 그 항목에 대한 질문(kind=error)으로 드러나야 한다.
    const errorDecisions = result.decisions.filter((d) => d.kind === 'error');
    assert.ok(
      errorDecisions.length >= 1,
      `expected a kind=error decision for the junction; outcome=${result.outcome}, decisions=${JSON.stringify(result.decisions)}`,
    );
    assert.ok(
      errorDecisions.some((d) => String(d.path).replace(/[\\/]+$/, '').endsWith('link')),
      `kind=error decision must name the junction entry: ${JSON.stringify(errorDecisions)}`,
    );
    assert.equal(await exists(join(destDir, 'tree', 'link')), false, 'no destination path for the junction entry');
    // 링크 하나 때문에 형제 항목까지 잃으면 "작업 전체 실패" 와 다르지 않다 — 나머지는 전달돼야 한다.
    assert.equal(await exists(join(destDir, 'tree', 'keep.txt')), true, 'the sibling of the junction must still be copied');
    const created = await listTree(destDir);
    for (const leaked of ['secret.txt', 'big.bin', 'nested', 'deep.txt']) {
      assert.ok(!created.includes(leaked), `content behind the junction leaked into destination: ${leaked} in ${JSON.stringify(created)}`);
    }
  });
});

test('매니저가 러너에 넘기는 검증기(실제 validateSessionPath)가 blockedPaths 아래 목적지 경로를 거부해 그 경로가 만들어지지 않는다', async (t) => {
  await withFixture(async (f) => {
    await writeFile(join(f.srcCwd, 'a.txt'), 'payload');
    // blocked 디렉터리는 목적지 cwd 안에 있다. 이름에 blocked 세그먼트가 없는 junction 을 거쳐 닿는다 —
    // 문자열 검사만으로는 보이지 않고, 가장 가까운 기존 조상을 realpath 로 풀어야 드러난다.
    const blockedDir = join(f.destCwd, BLOCKED_SEGMENT);
    await mkdir(blockedDir);
    const alias = join(f.destCwd, 'alias');
    if (!(await linkDir(t, blockedDir, alias))) return;

    const result = await runRealJob(f, { operation: 'copy', sources: [join(f.srcCwd, 'a.txt')], destDir: alias });

    assert.equal(
      await exists(join(blockedDir, 'a.txt')),
      false,
      `file was created inside the blocked directory through a junction; outcome=${result.outcome}`,
    );
    assert.notEqual(result.outcome, 'completed', 'a job whose only creation path is blocked must not report completed');
  });
});

test('목적지 세션 cwd 밖을 가리키는 junction 아래에 새로 만들 경로는 가장 가까운 기존 조상을 realpath 로 풀어 검증하므로 거부된다', async (t) => {
  await withFixture(async (f) => {
    const dir = join(f.srcCwd, 'dir');
    await mkdir(dir);
    await writeFile(join(dir, 'inner.txt'), 'inner');
    await writeFile(join(f.srcCwd, 'a.txt'), 'payload');
    const escape = join(f.destCwd, 'escape');
    if (!(await linkDir(t, f.outside, escape))) return;
    const before = (await readdir(f.outside)).sort();

    const result = await runRealJob(f, {
      operation: 'copy',
      sources: [join(f.srcCwd, 'a.txt'), dir],
      destDir: escape,
    });

    const after = (await readdir(f.outside)).sort();
    assert.deepEqual(
      after,
      before,
      `paths were created outside the destination session cwd through a junction; outcome=${result.outcome}`,
    );
    assert.notEqual(result.outcome, 'completed', 'a job whose creation paths all escape the cwd must not report completed');
  });
});

test('scanning 은 lstat 을 쓴다 — 심볼릭 항목의 크기·자식을 링크 대상에서 세지 않는다', async (t) => {
  await withFixture(async (f) => {
    const tree = join(f.srcCwd, 'tree');
    await mkdir(tree);
    await writeFile(join(tree, 'a.txt'), '0123456789');
    if (!(await linkDir(t, f.outside, join(tree, 'link')))) return;
    const destDir = join(f.destCwd, 'out');
    await mkdir(destDir);

    const result = await runRealJob(f, { operation: 'copy', sources: [tree], destDir });

    // 스캔이 끝났다는 증거는 transferring 진행이다. 링크에서 스캔이 멈춰 버리면 "세지 않았다" 가
    // 공허하게 참이 되므로, 스캔이 끝까지 가서 분모를 확정했는지부터 본다.
    const transferring = result.progress.filter((p) => p.phase === 'transferring');
    assert.ok(
      transferring.length >= 1,
      `scanning must finish past the link and reach transferring; outcome=${result.outcome}, phases=${JSON.stringify(result.progress.map((p) => p.phase))}`,
    );
    const totals = transferring[0];
    const totalBytes = Number(totals.totalBytes);
    const totalEntries = Number(totals.totalEntries);
    // 링크 대상의 1 MiB 파일이 분모에 실리면 링크를 따라간 것이다. 링크 자신의 lstat 크기(경로 길이
    // 정도)는 허용한다.
    assert.ok(totalBytes >= 10 && totalBytes < OUTSIDE_BIG_BYTES, `totalBytes must not include the link target: ${totalBytes}`);
    // tree + a.txt (+ 링크 항목 자신). 링크 대상의 자식(secret.txt, big.bin, nested, deep.txt)은 세지 않는다.
    assert.ok(totalEntries === 2 || totalEntries === 3, `totalEntries must not include the link target's children: ${totalEntries}`);
  });
});

// 위 네 case 는 "링크를 막는가" 만 본다. 그것만으로는 "링크를 전부 거부" 하는 값싼 수정이 통과한다 —
// 세션 cwd 안을 가리키는 링크는 사용자가 만든 정상 트리의 일부이고, 그 내용을 잃으면 결함이다.
test('링크의 실제 대상이 출발지 세션 cwd 안이면 따라가서 내용을 복사하고 error 결정을 내지 않는다', async (t) => {
  await withFixture(async (f) => {
    const inner = join(f.srcCwd, 'inner');
    await mkdir(inner);
    await writeFile(join(inner, 'inner.txt'), 'inner-content');
    await mkdir(join(inner, 'nested'));
    await writeFile(join(inner, 'nested', 'deep.txt'), 'deep-content');
    const tree = join(f.srcCwd, 'tree');
    await mkdir(tree);
    await writeFile(join(tree, 'keep.txt'), 'keep');
    if (!(await linkDir(t, inner, join(tree, 'link')))) return;
    const destDir = join(f.destCwd, 'out');
    await mkdir(destDir);

    const result = await runRealJob(f, { operation: 'copy', sources: [tree], destDir });

    assert.deepEqual(
      result.decisions.filter((d) => d.kind === 'error'),
      [],
      `a link resolving inside the source session cwd must not raise an error decision; outcome=${result.outcome}`,
    );
    assert.equal(result.outcome, 'completed');
    // 링크 자체가 아니라 내용이 복사되어야 한다 — 목적지에 링크가 생기면 목적지 세션에서 출발지 트리를 가리키게 된다.
    const copiedLink = await lstat(join(destDir, 'tree', 'link'));
    assert.equal(copiedLink.isSymbolicLink(), false, 'the destination must hold a copy, not a link');
    assert.equal(copiedLink.isDirectory(), true);
    assert.equal(await readFile(join(destDir, 'tree', 'link', 'inner.txt'), 'utf8'), 'inner-content');
    assert.equal(await readFile(join(destDir, 'tree', 'link', 'nested', 'deep.txt'), 'utf8'), 'deep-content');
    assert.equal(await readFile(join(destDir, 'tree', 'keep.txt'), 'utf8'), 'keep');
  });
});

test('따라간 링크가 cwd 안의 상위 디렉터리를 가리켜 순환하면 끝없이 내려가지 않고 그 항목에 error 결정을 낸다', async (t) => {
  await withFixture(async (f) => {
    const tree = join(f.srcCwd, 'tree');
    await mkdir(tree);
    await writeFile(join(tree, 'keep.txt'), 'keep');
    // 대상은 cwd 안이라 정책 검사는 통과한다 — 끊는 것은 방문 집합뿐이다.
    if (!(await linkDir(t, tree, join(tree, 'loop')))) return;
    const destDir = join(f.destCwd, 'out');
    await mkdir(destDir);

    const result = await runRealJob(f, { operation: 'copy', sources: [tree], destDir });

    const errorDecisions = result.decisions.filter((d) => d.kind === 'error');
    assert.ok(
      errorDecisions.some((d) => String(d.path).replace(/[\\/]+$/, '').endsWith('loop')),
      `the cyclic link must raise a kind=error decision naming it; outcome=${result.outcome}, decisions=${JSON.stringify(result.decisions)}`,
    );
    assert.equal(await exists(join(destDir, 'tree', 'loop')), false, 'no destination path for the cyclic link');
    assert.equal(await readFile(join(destDir, 'tree', 'keep.txt'), 'utf8'), 'keep');
    assert.equal(result.outcome, 'completed');
  });
});

test('출발지 cwd 안에 있어도 blocked 디렉터리를 가리키는 링크는 따라가지 않고 그 항목에 error 결정을 낸다', async (t) => {
  await withFixture(async (f) => {
    // 대상은 cwd 안이다 — traversal 만 보는 구현은 통과시킨다. 거르는 것은 blocked 목록뿐이다.
    const blockedDir = join(f.srcCwd, BLOCKED_SEGMENT);
    await mkdir(blockedDir);
    await writeFile(join(blockedDir, 'config'), 'blocked-content');
    const tree = join(f.srcCwd, 'tree');
    await mkdir(tree);
    await writeFile(join(tree, 'keep.txt'), 'keep');
    if (!(await linkDir(t, blockedDir, join(tree, 'alias')))) return;
    const destDir = join(f.destCwd, 'out');
    await mkdir(destDir);

    const result = await runRealJob(f, { operation: 'copy', sources: [tree], destDir });

    const errorDecisions = result.decisions.filter((d) => d.kind === 'error');
    assert.ok(
      errorDecisions.some((d) => String(d.path).replace(/[\\/]+$/, '').endsWith('alias')),
      `a link into a blocked directory must raise a kind=error decision naming it; decisions=${JSON.stringify(result.decisions)}`,
    );
    assert.equal(await exists(join(destDir, 'tree', 'alias')), false, 'nothing may be created for the blocked link');
    assert.equal(await readFile(join(destDir, 'tree', 'keep.txt'), 'utf8'), 'keep');
  });
});

test('스캔 뒤 질문에 멈춘 사이 따라간 링크가 cwd 밖으로 다시 걸려도 검증한 대상의 내용만 복사된다', async (t) => {
  await withFixture(async (f) => {
    const inner = join(f.srcCwd, 'inner');
    await mkdir(inner);
    await writeFile(join(inner, 'inner.txt'), 'inner-content');
    // cwd 밖에도 같은 이름의 파일을 둔다 — 링크 경로로 다시 읽으면 이 내용이 목적지로 새어 나간다.
    await writeFile(join(f.outside, 'inner.txt'), 'outside-secret');
    // 첫 출발지 a.txt 는 목적지에서 충돌한다 — 그 질문이 tree 의 스캔과 복사 사이의 창이다.
    const first = join(f.srcCwd, 'a.txt');
    await writeFile(first, 'a');
    const tree = join(f.srcCwd, 'tree');
    await mkdir(tree);
    const link = join(tree, 'link');
    if (!(await linkDir(t, inner, link))) return;
    const destDir = join(f.destCwd, 'out');
    await mkdir(destDir);
    await writeFile(join(destDir, 'a.txt'), 'existing');

    let repointed = false;
    const result = await runRealJob(f, { operation: 'copy', sources: [first, tree], destDir }, async (d) => {
      if (repointed || d.kind !== 'conflict') return;
      repointed = true;
      await rm(link, { force: true });
      await symlink(f.outside, link, 'junction');
    });

    assert.equal(repointed, true, 'the conflict question that opens the window must have been asked');
    const copied = join(destDir, 'tree', 'link', 'inner.txt');
    // 존재부터 요구한다 — "아무것도 복사하지 않음" 도 누출은 없지만, 검증을 통과한 내용을 잃는 결함이다.
    assert.equal(await exists(copied), true, `the validated link content must be copied; outcome=${result.outcome}, decisions=${JSON.stringify(result.decisions)}`);
    assert.equal(await readFile(copied, 'utf8'), 'inner-content', `content behind the re-pointed link leaked; outcome=${result.outcome}`);
    assert.equal(result.outcome, 'completed');
    const created = await listTree(destDir);
    for (const leaked of ['secret.txt', 'big.bin', 'nested', 'deep.txt']) {
      assert.ok(!created.includes(leaked), `content behind the re-pointed link leaked into destination: ${leaked}`);
    }
  });
});

// ── 링크 거부의 이유와 범위 ──────────────────────────────────────────────────

test('링크 거부의 kind=error 결정은 detail 에 사람이 읽을 이유를 싣고 링크 너머의 절대 경로는 싣지 않는다', async (t) => {
  await withFixture(async (f) => {
    const tree = join(f.srcCwd, 'tree');
    await mkdir(tree);
    const blockedDir = join(f.srcCwd, BLOCKED_SEGMENT);
    await mkdir(blockedDir);
    if (!(await linkDir(t, f.outside, join(tree, 'out-link')))) return;
    if (!(await linkDir(t, blockedDir, join(tree, 'blocked-link')))) return;
    const destDir = join(f.destCwd, 'out');
    await mkdir(destDir);

    const result = await runRealJob(f, { operation: 'copy', sources: [tree], destDir });

    const byName = (name: string): Record<string, unknown> | undefined =>
      result.decisions.find((d) => d.kind === 'error' && String(d.path).replace(/[\\/]+$/, '').endsWith(name));
    const out = byName('out-link');
    const blocked = byName('blocked-link');
    assert.ok(out && blocked, `두 링크 모두 error 결정을 내야 한다: ${JSON.stringify(result.decisions)}`);
    for (const [d, reason] of [[out, /outside/i], [blocked, /blocked/i]] as const) {
      assert.equal(typeof d.detail, 'string', `detail 이 이유 문자열이 아니다: ${JSON.stringify(d)}`);
      assert.match(String(d.detail), reason);
      // 결정의 path 가 이미 보여 주는 것 이상을 새지 않는다 — 링크 대상의 실제 위치는 싣지 않는다.
      assert.ok(!String(d.detail).includes(f.outside) && !String(d.detail).includes(blockedDir), `detail 이 링크 대상 경로를 드러냈다: ${String(d.detail)}`);
      assert.ok(!String(d.detail).includes(f.root), `detail 이 절대 경로를 드러냈다: ${String(d.detail)}`);
    }
  });
});

/** 링크 하나가 든 출발지 트리를 실제 러너로 복사하되, 출발지 검증기를 주어진 것으로 바꾼다. */
async function copyWithSourceValidator(
  f: Fixture,
  t: TestContext,
  validateSourcePath: (p: string) => void | Promise<void>,
): Promise<{ result: Awaited<ReturnType<typeof runJob>>; asked: unknown[] } | null> {
  const tree = join(f.srcCwd, 'tree');
  await mkdir(tree);
  await mkdir(join(f.srcCwd, 'inside'));
  await writeFile(join(f.srcCwd, 'inside', 'x.txt'), 'x');
  if (!(await linkDir(t, join(f.srcCwd, 'inside'), join(tree, 'link')))) return null;
  const destDir = join(f.destCwd, 'out');
  await mkdir(destDir);
  const asked: unknown[] = [];
  const result = await runJob(
    { operation: 'copy', sources: [tree], destDir },
    {
      fsOps: nodeFileJobFsOps,
      validatePath: () => {},
      validateSourcePath,
      decide: async (req) => {
        asked.push(req);
        return { choice: 'skip' };
      },
      onProgress: () => {},
    },
  );
  return { result, asked };
}

test('링크 대상 검증이 PATH_TRAVERSAL·PATH_BLOCKED 가 아닌 이유(SESSION_NOT_FOUND·I/O)로 실패하면 건너뛰지 않고 작업이 그 오류로 실패한다', async (t) => {
  await withFixture(async (f) => {
    const run = await copyWithSourceValidator(f, t, () => {
      throw new AppError(ErrorCode.SESSION_NOT_FOUND);
    });
    if (!run) return;
    assert.deepEqual(run.asked, [], `세션 부재가 링크 건너뛰기 질문으로 바뀌었다: ${JSON.stringify(run.asked)}`);
    assert.equal(run.result.outcome, 'failed');
    assert.equal((run.result.error as { code?: string } | undefined)?.code, ErrorCode.SESSION_NOT_FOUND);
  });
  await withFixture(async (f) => {
    const run = await copyWithSourceValidator(f, t, () => {
      const err = new Error('EIO: i/o error') as Error & { code: string };
      err.code = 'EIO';
      throw err;
    });
    if (!run) return;
    assert.deepEqual(run.asked, [], `I/O 오류가 링크 건너뛰기 질문으로 바뀌었다: ${JSON.stringify(run.asked)}`);
    assert.equal(run.result.outcome, 'failed');
    assert.equal((run.result.error as { code?: string } | undefined)?.code, 'EIO');
  });
  // 대조군: 정책 거부는 여전히 그 링크만 건너뛰는 질문이다.
  await withFixture(async (f) => {
    const run = await copyWithSourceValidator(f, t, () => {
      throw new AppError(ErrorCode.PATH_TRAVERSAL);
    });
    if (!run) return;
    assert.equal(run.asked.length, 1, `정책 거부가 질문을 내지 않았다: ${JSON.stringify(run.asked)}`);
    assert.equal((run.asked[0] as { kind?: string }).kind, 'error');
    assert.equal(run.result.outcome, 'completed');
  });
});
