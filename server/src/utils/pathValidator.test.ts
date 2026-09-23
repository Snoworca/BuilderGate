// pathValidator — 실제 디스크에서 경로 검증의 두 틈을 막는지 본다.
//
// A. 대상이 아직 없으면(ENOENT) resolveAndValidate 가 realpath 없이 입력 경로를 돌려주던 틈.
//    문자열로는 cwd 안이고 blocked 이름도 없지만, 경로 중간의 junction 이 cwd 밖이나 blocked 디렉터리를
//    가리키면 디스크에서는 거기에 만들어진다. 막는 법은 가장 가까운 기존 조상을 realpath 로 풀어
//    traversal·blocked 를 실제 경로로 다시 보는 것이다.
// B. blocked 이름을 글자 그대로 비교하던 틈. NTFS·APFS 는 대소문자를 가리지 않으므로 '.GIT' 가
//    '.git' 이고, Windows 는 끝의 점·공백을 버리므로 '.git.' · '.git ' 도 '.git' 이다.
//
// 가짜 fs 로는 링크를 흉내 낼 수 없다 — 문제는 경로 문자열이 아니라 그 경로가 디스크에서 닿는 곳이다.
// 디렉터리 링크는 junction 으로 만든다(Windows 에서 권한이 필요 없다). 그래도 EPERM 이면 이유를
// 적어 skip 한다 — 조용히 통과시키면 "링크가 없어서 통과" 와 구별되지 않는다.
//
// server/src/test-runner.ts 는 *.test.ts 를 찾지 않으므로 이 파일은 node:test 로 파일별로 돌린다.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppError, ErrorCode } from './errors.js';
import { isPathBlocked, resolveAndValidate } from './pathValidator.js';
import { FileService } from '../services/FileService.js';
import type { FileManagerConfig } from '../types/file.types.js';

const BLOCKED = '.git';
const SESSION_ID = 'session-path-validator';

interface Fixture {
  cwd: string;
  /** cwd 의 형제 — 세션 트리 밖. */
  outside: string;
  /** cwd 안의 blocked 디렉터리. */
  blockedDir: string;
}

async function withFixture(run: (f: Fixture) => Promise<void>): Promise<void> {
  // realpath 로 정규화한다 — tmpdir 이 8.3 이름이면 정상 경로도 밖으로 보일 수 있다.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pathval-')));
  try {
    const f: Fixture = { cwd: join(root, 'cwd'), outside: join(root, 'outside'), blockedDir: '' };
    f.blockedDir = join(f.cwd, BLOCKED);
    await mkdir(f.cwd);
    await mkdir(f.outside);
    await mkdir(f.blockedDir);
    await writeFile(join(f.blockedDir, 'config'), 'blocked-content');
    await run(f);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** 디렉터리 junction 을 만든다. EPERM 이면 이유를 적어 skip 하고 false. 다른 오류는 던진다. */
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

async function exists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/** code 를 가진 AppError 로 reject 되는지. 다른 오류(예: fs 오류)로 실패하면 틀린 이유의 거부다. */
async function rejectsWith(p: Promise<unknown>, code: ErrorCode): Promise<void> {
  await assert.rejects(p, (err: unknown) => {
    assert.ok(err instanceof AppError, `AppError 가 아니다: ${String(err)}`);
    assert.equal(err.code, code);
    return true;
  });
}

// ── A. 아직 없는 대상 ─────────────────────────────────────────────────────────

test('A: blocked 디렉터리를 가리키는 junction 아래의 새 파일 경로는 PATH_BLOCKED 로 거부된다', async (t) => {
  await withFixture(async (f) => {
    if (!(await linkDir(t, f.blockedDir, join(f.cwd, 'alias')))) return;
    await rejectsWith(resolveAndValidate(f.cwd, 'alias/new.txt', [BLOCKED]), ErrorCode.PATH_BLOCKED);
    // 한 단계 더 깊이 없는 경로도 같다 — 가장 가까운 기존 조상을 찾아 올라가야 한다.
    await rejectsWith(resolveAndValidate(f.cwd, 'alias/a/b/new.txt', [BLOCKED]), ErrorCode.PATH_BLOCKED);
  });
});

test('A: cwd 밖을 가리키는 junction 아래의 새 파일 경로는 PATH_TRAVERSAL 로 거부된다', async (t) => {
  await withFixture(async (f) => {
    if (!(await linkDir(t, f.outside, join(f.cwd, 'out')))) return;
    await rejectsWith(resolveAndValidate(f.cwd, 'out/new.txt', []), ErrorCode.PATH_TRAVERSAL);
    await rejectsWith(resolveAndValidate(f.cwd, 'out/a/b/new.txt', []), ErrorCode.PATH_TRAVERSAL);
  });
});

test('A: 대상이 사라진 junction 아래의 새 경로는 어디에 닿는지 풀 수 없으므로 거부된다', async (t) => {
  await withFixture(async (f) => {
    const gone = join(f.outside, 'gone');
    await mkdir(gone);
    if (!(await linkDir(t, gone, join(f.cwd, 'dangling')))) return;
    await rm(gone, { recursive: true });
    await rejectsWith(resolveAndValidate(f.cwd, 'dangling/new.txt', []), ErrorCode.PATH_TRAVERSAL);
  });
});

test('A 회귀: cwd 바로 아래·기존 하위 폴더 아래의 새 경로는 여전히 허용되고 cwd 안의 경로를 돌려준다', async () => {
  await withFixture(async (f) => {
    await mkdir(join(f.cwd, 'sub'));
    assert.equal(await resolveAndValidate(f.cwd, 'new.txt', [BLOCKED]), join(f.cwd, 'new.txt'));
    assert.equal(await resolveAndValidate(f.cwd, 'sub/missing/new.txt', [BLOCKED]), join(f.cwd, 'sub', 'missing', 'new.txt'));
    // cwd 안을 가리키는 junction 은 막지 않는다 — 막는 것은 밖·blocked 로 닿는 것뿐이다.
    await mkdir(join(f.cwd, 'real-target'));
    let linked = false;
    try {
      await symlink(join(f.cwd, 'real-target'), join(f.cwd, 'inside-link'), 'junction');
      linked = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EPERM') throw err;
    }
    if (linked) {
      assert.equal(
        await resolveAndValidate(f.cwd, 'inside-link/new.txt', [BLOCKED]),
        join(f.cwd, 'real-target', 'new.txt'),
      );
    }
    // 기존 대상의 동작은 그대로다.
    await writeFile(join(f.cwd, 'sub', 'here.txt'), 'x');
    assert.equal(await resolveAndValidate(f.cwd, 'sub/here.txt', [BLOCKED]), join(f.cwd, 'sub', 'here.txt'));
    await rejectsWith(resolveAndValidate(f.cwd, '../outside/new.txt', []), ErrorCode.PATH_TRAVERSAL);
  });
});

test('A: 이미 있는 대상도 junction 을 거쳐 blocked 디렉터리 안에 닿으면 PATH_BLOCKED 로 거부된다', async (t) => {
  // 문자열 검사는 'alias/config' 에서 blocked 이름을 보지 못한다. 실제 경로(cwd/.git/config)로 다시 봐야 한다.
  await withFixture(async (f) => {
    if (!(await linkDir(t, f.blockedDir, join(f.cwd, 'alias')))) return;
    await rejectsWith(resolveAndValidate(f.cwd, 'alias/config', [BLOCKED]), ErrorCode.PATH_BLOCKED);
  });
});

// ── B. blocked 이름 비교 ─────────────────────────────────────────────────────

test('B: win32 에서는 대소문자·끝의 점·공백·스트림 접미사가 달라도 blocked 이름으로 본다', () => {
  const base = 'C:\\work\\proj';
  for (const seg of ['.GIT', '.Git', '.git.', '.git ', '.git. .', '.GIT..', '.git::$INDEX_ALLOCATION']) {
    assert.equal(isPathBlocked(`${base}\\${seg}\\config`, [BLOCKED], 'win32'), true, `win32 에서 '${seg}' 가 통과했다`);
  }
  // blocked 목록 쪽의 표기도 같은 규칙으로 접는다.
  assert.equal(isPathBlocked(`${base}\\.git\\config`, ['.GIT'], 'win32'), true);
  // 대조군: 다른 이름은 막지 않는다 — 전부 막는 구현이 위 단언을 공짜로 통과하지 못하게.
  for (const seg of ['.gitignore', 'git', '.github', 'x.git']) {
    assert.equal(isPathBlocked(`${base}\\${seg}\\config`, [BLOCKED], 'win32'), false, `win32 에서 '${seg}' 가 막혔다`);
  }
});

test('B: darwin 에서는 대소문자만 접고, linux 에서는 글자 그대로 비교한다', () => {
  assert.equal(isPathBlocked('/Users/u/proj/.GIT/config', [BLOCKED], 'darwin'), true);
  // 끝의 점은 APFS 에서 다른 이름이다 — Windows 규칙을 번지게 하지 않는다.
  assert.equal(isPathBlocked('/Users/u/proj/.git./config', [BLOCKED], 'darwin'), false);
  assert.equal(isPathBlocked('/home/u/proj/.GIT/config', [BLOCKED], 'linux'), false);
  assert.equal(isPathBlocked('/home/u/proj/.git/config', [BLOCKED], 'linux'), true);
});

test('B: 이 호스트가 win32 면 resolveAndValidate 가 .GIT · .git. · .git  경로를 PATH_BLOCKED 로 거부한다', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('Windows-only name normalization');
    return;
  }
  await withFixture(async (f) => {
    for (const seg of ['.GIT', '.git.', '.git ']) {
      await rejectsWith(resolveAndValidate(f.cwd, `${seg}/config`, [BLOCKED]), ErrorCode.PATH_BLOCKED);
      await rejectsWith(resolveAndValidate(f.cwd, `${seg}/new.txt`, [BLOCKED]), ErrorCode.PATH_BLOCKED);
    }
  });
});

// ── FileService 표면 ──────────────────────────────────────────────────────────

const FILE_MANAGER_CONFIG: FileManagerConfig = {
  maxFileSize: 1048576,
  maxDirectoryEntries: 10000,
  blockedExtensions: [],
  blockedPaths: [BLOCKED],
  cwdCacheTtlMs: 1000,
};

function serviceOn(cwd: string): FileService {
  const sessionManager = {
    getSession: (id: string): unknown => (id === SESSION_ID ? { id } : null),
    getPtyPid: (): number | null => null,
    getInitialCwd: (): string | null => cwd,
    getCwdFilePath: (): string | null => null,
  };
  return new FileService(sessionManager, { ...FILE_MANAGER_CONFIG });
}

test('FileService: writeFile 은 junction 을 거쳐 blocked 디렉터리나 cwd 밖에 새 파일을 쓰지 않고, cwd 안의 새 파일은 쓴다', async (t) => {
  await withFixture(async (f) => {
    if (!(await linkDir(t, f.blockedDir, join(f.cwd, 'alias')))) return;
    if (!(await linkDir(t, f.outside, join(f.cwd, 'out')))) return;
    const service = serviceOn(f.cwd);

    await rejectsWith(service.writeFile(SESSION_ID, 'alias/hooks.txt', 'pwned'), ErrorCode.PATH_BLOCKED);
    assert.equal(await exists(join(f.blockedDir, 'hooks.txt')), false, 'blocked 디렉터리 안에 파일이 만들어졌다');

    await rejectsWith(service.writeFile(SESSION_ID, 'out/escaped.txt', 'pwned'), ErrorCode.PATH_TRAVERSAL);
    assert.deepEqual(await readdir(f.outside), [], 'cwd 밖에 파일이 만들어졌다');

    // 대조군: 정상 쓰기는 그대로 된다.
    await service.writeFile(SESSION_ID, 'ok.txt', 'fine');
    assert.equal(await exists(join(f.cwd, 'ok.txt')), true);
  });
});

test('FileService: copyFile·moveFile 의 목적지가 junction 을 거쳐 cwd 밖·blocked 로 닿으면 거부된다', async (t) => {
  await withFixture(async (f) => {
    if (!(await linkDir(t, f.blockedDir, join(f.cwd, 'alias')))) return;
    if (!(await linkDir(t, f.outside, join(f.cwd, 'out')))) return;
    await writeFile(join(f.cwd, 'src.txt'), 'data');
    const service = serviceOn(f.cwd);

    await rejectsWith(service.copyFile(SESSION_ID, 'src.txt', 'out/copied.txt'), ErrorCode.PATH_TRAVERSAL);
    await rejectsWith(service.copyFile(SESSION_ID, 'src.txt', 'alias/copied.txt'), ErrorCode.PATH_BLOCKED);
    await rejectsWith(service.moveFile(SESSION_ID, 'src.txt', 'out/moved.txt'), ErrorCode.PATH_TRAVERSAL);
    await rejectsWith(service.moveFile(SESSION_ID, 'src.txt', 'alias/moved.txt'), ErrorCode.PATH_BLOCKED);
    assert.deepEqual(await readdir(f.outside), []);
    assert.deepEqual((await readdir(f.blockedDir)).sort(), ['config']);
    assert.equal(await exists(join(f.cwd, 'src.txt')), true, '거부된 이동이 원본을 옮겼다');
  });
});

test('FileService: createDirectory 는 blocked 이름의 새 폴더를 만들지 않는다', async () => {
  // basePath 만 검증하고 name 을 검사하지 않으면 '.git' 폴더를 cwd 에 새로 만들 수 있다.
  await withFixture(async (f) => {
    await rm(f.blockedDir, { recursive: true });
    const service = serviceOn(f.cwd);
    await rejectsWith(service.createDirectory(SESSION_ID, '.', BLOCKED), ErrorCode.PATH_BLOCKED);
    assert.equal(await exists(f.blockedDir), false);
    if (process.platform === 'win32') {
      await rejectsWith(service.createDirectory(SESSION_ID, '.', '.GIT'), ErrorCode.PATH_BLOCKED);
      await rejectsWith(service.createDirectory(SESSION_ID, '.', '.git.'), ErrorCode.PATH_BLOCKED);
      assert.equal(await exists(f.blockedDir), false);
    }
    // 대조군
    await service.createDirectory(SESSION_ID, '.', 'plain');
    assert.equal(await exists(join(f.cwd, 'plain')), true);
  });
});
