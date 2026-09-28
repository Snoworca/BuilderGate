import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { FileService } from './FileService.js';
import { AppError, ErrorCode } from '../utils/errors.js';

test('FileService.updateConfig applies new limits to later operations', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'buildergate-file-service-'));
  const filePath = path.join(tempDir, 'note.txt');
  const fileContents = '12345';

  await fs.writeFile(filePath, fileContents, 'utf-8');

  const sessionManager = {
    getSession: () => ({ id: 'session-1' }),
    getPtyPid: () => null,
    getInitialCwd: () => tempDir,
    getCwdFilePath: () => null,
  };

  const service = new FileService(sessionManager, {
    maxFileSize: 10,
    maxDirectoryEntries: 10000,
    blockedExtensions: [],
    blockedPaths: [],
    cwdCacheTtlMs: 1000,
  });

  try {
    const initialRead = await service.readFile('session-1', 'note.txt');
    assert.equal(initialRead.content, fileContents);

    service.updateConfig({
      maxFileSize: 4,
      maxDirectoryEntries: 10000,
      blockedExtensions: [],
      blockedPaths: [],
      cwdCacheTtlMs: 1000,
    });

    await assert.rejects(
      () => service.readFile('session-1', 'note.txt'),
      (error: unknown) => error instanceof AppError && error.code === ErrorCode.FILE_TOO_LARGE,
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

// totalEntries counted '..' unconditionally (`dirents.length + 1`) while the entry
// list adds '..' only below a drive root, so at a root the count claimed one entry
// that was never there. Compared against readdir itself rather than against the
// entry list: entries that fail to stat are skipped from the list (pagefile.sys and
// friends at C:\), so the list is the wrong yardstick for what the directory holds.
function listingService(initialCwd: string): FileService {
  return new FileService({
    getSession: () => ({ id: 'session-1' }),
    getPtyPid: () => null,
    getInitialCwd: () => initialCwd,
    getCwdFilePath: () => null,
  }, {
    maxFileSize: 1024,
    maxDirectoryEntries: 10000,
    blockedExtensions: [],
    blockedPaths: [],
    cwdCacheTtlMs: 1000,
  });
}

test('FileService.listDirectory does not count a parent entry at a drive root', async () => {
  const root = path.parse(os.tmpdir()).root;
  const listing = await listingService(root).listDirectory('session-1', '.');

  assert.equal(listing.entries.some(entry => entry.name === '..'), false, 'a root has no parent row');
  assert.equal(listing.totalEntries, (await fs.readdir(root)).length);
});

test('FileService.listDirectory counts the parent entry below a root', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'buildergate-file-service-'));
  try {
    // FR-FEX-017: listed below the session root, where a parent is still reachable.
    await fs.mkdir(path.join(tempDir, 'sub'));
    await fs.writeFile(path.join(tempDir, 'sub', 'a.txt'), 'a');
    await fs.writeFile(path.join(tempDir, 'sub', 'b.txt'), 'b');
    const listing = await listingService(tempDir).listDirectory('session-1', 'sub');

    assert.deepEqual(listing.entries.map(entry => entry.name), ['..', 'a.txt', 'b.txt']);
    assert.equal(listing.totalEntries, 3);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

// RCK-006: 파일 작업이 쓰는 도중의 임시 파일(.bg-part-<16 hex>)이 목록에 보였고, 서버가 죽으면 영영 남아 보였다.
// 러너가 만드는 정확한 이름만 숨긴다 — 비슷하게 생긴 사용자 파일은 그대로 보인다. totalEntries 도 같은 기준이다.
test('FileService.listDirectory hides file-job temp names and counts totalEntries without them', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'buildergate-file-service-'));
  try {
    await fs.writeFile(path.join(tempDir, 'a.txt'), 'a');
    await fs.writeFile(path.join(tempDir, '.bg-part-0123456789abcdef'), 'partial');
    await fs.writeFile(path.join(tempDir, '.bg-part-mine'), 'user file');
    await fs.writeFile(path.join(tempDir, '.bg-part-0123456789abcdef0'), 'user file, too long');
    const listing = await listingService(tempDir).listDirectory('session-1', '.');

    assert.deepEqual(
      listing.entries.map(entry => entry.name),
      ['.bg-part-0123456789abcdef0', '.bg-part-mine', 'a.txt'],
    );
    assert.equal(listing.totalEntries, 3);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('the temp-name pattern FileService hides is the one the file-job runner generates', async () => {
  const runner = await import('./fileJobs/fileJobRunner.js') as unknown as { isFileJobTempName?: (name: string) => boolean };
  assert.equal(typeof runner.isFileJobTempName, 'function', 'fileJobRunner does not export isFileJobTempName');
  assert.equal(runner.isFileJobTempName!('.bg-part-0123456789abcdef'), true);
  assert.equal(runner.isFileJobTempName!('.bg-part-mine'), false);
  assert.equal(runner.isFileJobTempName!('x.bg-part-0123456789abcdef'), false);
});

// IR-MDE-002 / FR-MDE-016 — 읽기 응답의 encoding 은 본문이 UTF-8 로 온전한지를 알린다.
// 판정 순서(차단 확장자 → 크기 → 바이너리)와 쓰기 경로는 이 요구사항이 바꾸지 않는다.
async function withReadFixture(
  files: Record<string, Buffer | string>,
  run: (service: FileService, dir: string) => Promise<void>,
  options: { maxFileSize?: number; blockedExtensions?: string[] } = {},
): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'buildergate-file-service-encoding-'));
  try {
    for (const [name, body] of Object.entries(files)) {
      await fs.writeFile(path.join(tempDir, name), body);
    }
    const service = new FileService({
      getSession: () => ({ id: 'session-1' }),
      getPtyPid: () => null,
      getInitialCwd: () => tempDir,
      getCwdFilePath: () => null,
    }, {
      maxFileSize: options.maxFileSize ?? 1024,
      maxDirectoryEntries: 10000,
      blockedExtensions: options.blockedExtensions ?? [],
      blockedPaths: [],
      cwdCacheTtlMs: 1000,
    });
    await run(service, tempDir);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function rejectsWith(code: ErrorCode) {
  return (error: unknown) => error instanceof AppError && error.code === code;
}

// TC-REQ-IR-MDE-002-AC1-01 (IR-MDE-002 AC-1)
test('readFile: 0xC3 0x28 같은 잘못된 UTF-8 바이트는 encoding=unknown', async () => {
  const bytes = Buffer.concat([Buffer.from('abc '), Buffer.from([0xc3, 0x28]), Buffer.from(' def\n')]);
  await withReadFixture({ 'broken.txt': bytes }, async (service) => {
    const result = await service.readFile('session-1', 'broken.txt');
    assert.equal(result.encoding, 'unknown');
  });
});

// TC-REQ-IR-MDE-002-AC1-02 (IR-MDE-002 AC-1)
test('readFile: CP949 한글 바이트(0xC7 0xD1)는 encoding=unknown', async () => {
  // CP949 로 저장된 "한글" — C7 D1 B1 DB. 0xD1 은 UTF-8 연속 바이트(0x80–0xBF)가 아니다.
  const bytes = Buffer.concat([Buffer.from('title: '), Buffer.from([0xc7, 0xd1, 0xb1, 0xdb]), Buffer.from('\n')]);
  await withReadFixture({ 'cp949.txt': bytes }, async (service) => {
    const result = await service.readFile('session-1', 'cp949.txt');
    assert.equal(result.encoding, 'unknown');
  });
});

// TC-REQ-IR-MDE-002-AC2-01 (IR-MDE-002 AC-2)
test('readFile: BOM(EF BB BF) 포함 UTF-8 과 BOM 없는 UTF-8 모두 encoding=utf-8', async () => {
  const body = Buffer.from('# 제목\n한글 본문\n', 'utf-8');
  await withReadFixture({
    'bom.md': Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]),
    'plain.md': body,
  }, async (service) => {
    assert.equal((await service.readFile('session-1', 'bom.md')).encoding, 'utf-8');
    assert.equal((await service.readFile('session-1', 'plain.md')).encoding, 'utf-8');
  });
});

// TC-REQ-IR-MDE-002-AC3-01 (IR-MDE-002 AC-3)
test('readFile: 크기 초과 FILE_TOO_LARGE·차단 확장자·NUL 바이너리 BINARY_FILE 판정 순서와 코드가 그대로다', async () => {
  const oversizedBinary = Buffer.alloc(64, 0x00);
  await withReadFixture({
    // 차단 확장자이면서 크기 초과·바이너리 — 차단이 먼저다
    'blocked.exe': oversizedBinary,
    // 크기 초과이면서 바이너리 — 크기가 먼저다
    'big.bin': oversizedBinary,
    // 한도 안의 NUL 다수 — 바이너리
    'small.bin': Buffer.alloc(16, 0x00),
    // 한도 안의 잘못된 UTF-8 이면서 NUL 다수 — 바이너리 판정이 encoding 판정보다 먼저다
    'mixed.bin': Buffer.from([0xc3, 0x28, 0x00, 0x00, 0x00, 0x00]),
  }, async (service) => {
    await assert.rejects(() => service.readFile('session-1', 'blocked.exe'), rejectsWith(ErrorCode.PATH_BLOCKED));
    await assert.rejects(() => service.readFile('session-1', 'big.bin'), rejectsWith(ErrorCode.FILE_TOO_LARGE));
    await assert.rejects(() => service.readFile('session-1', 'small.bin'), rejectsWith(ErrorCode.BINARY_FILE));
    await assert.rejects(() => service.readFile('session-1', 'mixed.bin'), rejectsWith(ErrorCode.BINARY_FILE));
  }, { maxFileSize: 32, blockedExtensions: ['.exe'] });
});

// TC-REQ-IR-MDE-002-AC4-01 (IR-MDE-002 AC-4)
test('writeFile: 문자열을 UTF-8 로 쓰는 기존 쓰기 결과 바이트가 바뀌지 않는다', async () => {
  const content = '# 제목\r\n한글 🙂 text\n';
  await withReadFixture({}, async (service, dir) => {
    await service.writeFile('session-1', 'out.md', content);
    const written = await fs.readFile(path.join(dir, 'out.md'));
    assert.deepEqual(written, Buffer.from(content, 'utf-8'));
  });
});

// TC-REQ-FR-MDE-016-AC5-01 (FR-MDE-016 AC-5, IR-MDE-002 AC-3)
test('readFile: UTF-16LE(BOM FF FE + NUL 다수) 파일은 BINARY_FILE 로 거절된다', async () => {
  const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hello world\n', 'utf16le')]);
  await withReadFixture({ 'utf16.txt': bytes }, async (service) => {
    await assert.rejects(() => service.readFile('session-1', 'utf16.txt'), rejectsWith(ErrorCode.BINARY_FILE));
  });
});

// IR-MDE-003 — 이미지 파일의 원본 바이트. 텍스트 읽기(readFile)와 같은 경로 검증·차단 규칙을 쓰되
// 크기 한도는 별도 설정 maxImageFileSize(기본 20 MiB)다. 텍스트 쪽 maxFileSize 는 이 요구사항이 바꾸지 않는다.
const DEFAULT_MAX_IMAGE_FILE_SIZE = 20 * 1024 * 1024;

interface ImageFixtureOptions {
  maxFileSize?: number;
  maxImageFileSize?: number;
  blockedExtensions?: string[];
  blockedPaths?: string[];
}

function imageServiceConfig(options: ImageFixtureOptions) {
  const config: Record<string, unknown> = {
    maxFileSize: options.maxFileSize ?? 1024 * 1024,
    maxDirectoryEntries: 10000,
    blockedExtensions: options.blockedExtensions ?? [],
    blockedPaths: options.blockedPaths ?? [],
    cwdCacheTtlMs: 1000,
  };
  if (options.maxImageFileSize !== undefined) config.maxImageFileSize = options.maxImageFileSize;
  return config as unknown as ConstructorParameters<typeof FileService>[1];
}

async function withImageFixture(
  files: Record<string, Buffer | string>,
  run: (service: FileService, dir: string) => Promise<void>,
  options: ImageFixtureOptions = {},
): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'buildergate-file-service-image-'));
  const workDir = path.join(root, 'work');
  try {
    await fs.mkdir(workDir);
    for (const [name, body] of Object.entries(files)) {
      const target = path.join(workDir, name);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, body);
    }
    const service = new FileService({
      getSession: () => ({ id: 'session-1' }),
      getPtyPid: () => null,
      getInitialCwd: () => workDir,
      getCwdFilePath: () => null,
    }, imageServiceConfig(options));
    await run(service, workDir);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

// PNG 시그니처 + 임의 바이트. NUL 이 섞여 있어 readFile 이라면 BINARY_FILE 로 거절될 내용이다.
function pngBytes(size: number): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const body = Buffer.alloc(Math.max(0, size - signature.length), 0x00);
  return Buffer.concat([signature, body]).subarray(0, size);
}

async function errorCodeOf(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
  } catch (error) {
    assert.ok(error instanceof AppError, `expected AppError, got ${String(error)}`);
    return error.code;
  }
  assert.fail('expected the call to reject');
}

// TC-REQ-IR-MDE-003-AC1-01 (IR-MDE-003 AC-1)
test('readImageFile: 이미지 모드 확장자만 Buffer+mimeType, .txt 는 거절', async () => {
  const imageExtensions = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'svg'];
  const exactMime: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
  };
  const files: Record<string, Buffer | string> = { 'note.txt': 'plain text', 'data.json': '{}' };
  for (const ext of imageExtensions) files[`pic.${ext}`] = pngBytes(64);
  files['UPPER.PNG'] = pngBytes(32);

  await withImageFixture(files, async (service) => {
    for (const ext of imageExtensions) {
      const result = await service.readImageFile('session-1', `pic.${ext}`);
      assert.ok(Buffer.isBuffer(result.buffer), `${ext}: buffer must be a Buffer`);
      assert.deepEqual(result.buffer, pngBytes(64), `${ext}: bytes must be returned unmodified`);
      assert.equal(result.size, 64, `${ext}: size`);
      assert.ok(result.mimeType.startsWith('image/'), `${ext}: mimeType ${result.mimeType} is not an image MIME`);
      if (exactMime[ext]) assert.equal(result.mimeType, exactMime[ext], `${ext}: mimeType`);
    }
    const upper = await service.readImageFile('session-1', 'UPPER.PNG');
    assert.equal(upper.mimeType, 'image/png', 'extension match is case-insensitive');

    await assert.rejects(() => service.readImageFile('session-1', 'note.txt'), (error: unknown) => error instanceof AppError);
    await assert.rejects(() => service.readImageFile('session-1', 'data.json'), (error: unknown) => error instanceof AppError);
  });
});

// TC-REQ-IR-MDE-003-AC2-01 (IR-MDE-003 AC-2)
test('readImageFile: 작업 경로 밖·차단 경로·차단 확장자는 readFile 과 같은 오류 코드', async () => {
  await withImageFixture({
    '.ssh/key.png': pngBytes(16),
    'blocked.png': pngBytes(16),
  }, async (service, dir) => {
    await fs.writeFile(path.join(dir, '..', 'outside.png'), pngBytes(16));

    const cases: Array<[string, string]> = [
      ['../outside.png', ErrorCode.PATH_TRAVERSAL],
      ['.ssh/key.png', ErrorCode.PATH_BLOCKED],
      ['blocked.png', ErrorCode.PATH_BLOCKED],
    ];
    for (const [target, expected] of cases) {
      const textCode = await errorCodeOf(() => service.readFile('session-1', target));
      const imageCode = await errorCodeOf(() => service.readImageFile('session-1', target));
      assert.equal(textCode, expected, `${target}: readFile baseline`);
      assert.equal(imageCode, textCode, `${target}: readImageFile must use readFile's error code`);
    }
  }, { blockedPaths: ['.ssh'], blockedExtensions: ['.png'] });
});

// TC-REQ-IR-MDE-003-AC3-01 (IR-MDE-003 AC-3)
test('readImageFile: maxImageFileSize 초과 FILE_TOO_LARGE, maxFileSize(1MiB) 보다 큰 2MiB png 는 통과', async () => {
  const twoMiB = 2 * 1024 * 1024;
  await withImageFixture({
    'big.png': pngBytes(twoMiB),
    'huge.png': pngBytes(twoMiB + 1),
    'big.txt': 'x'.repeat(1024 * 1024 + 1),
  }, async (service) => {
    const result = await service.readImageFile('session-1', 'big.png');
    assert.equal(result.size, twoMiB);
    assert.equal(result.buffer.length, twoMiB);

    await assert.rejects(() => service.readImageFile('session-1', 'huge.png'), rejectsWith(ErrorCode.FILE_TOO_LARGE));
    // 텍스트 한도는 그대로 maxFileSize 다
    await assert.rejects(() => service.readFile('session-1', 'big.txt'), rejectsWith(ErrorCode.FILE_TOO_LARGE));
  }, { maxFileSize: 1024 * 1024, maxImageFileSize: twoMiB });
});

// TC-REQ-IR-MDE-003-AC3-04 (IR-MDE-003 AC-3)
test('updateConfig(maxImageFileSize=4096) 뒤 8KiB png 는 FILE_TOO_LARGE — 설정 복제 경로가 필드를 떨어뜨리지 않는다; 필드 없는 설정은 20MiB 로 대체', async () => {
  await withImageFixture({
    'eight.png': pngBytes(8 * 1024),
    'two-mib.png': pngBytes(2 * 1024 * 1024),
  }, async (service, dir) => {
    // 필드 없는 설정 — 기본 20 MiB. maxFileSize(1 MiB)보다 큰 2 MiB 도 통과한다
    assert.equal((await service.readImageFile('session-1', 'eight.png')).size, 8 * 1024);
    assert.equal((await service.readImageFile('session-1', 'two-mib.png')).size, 2 * 1024 * 1024);

    // 20 MiB 를 넘는 파일은 거절 — stat 크기만 보므로 희소 파일로 충분하다
    const overDefault = path.join(dir, 'over-default.png');
    await fs.writeFile(overDefault, pngBytes(8));
    await fs.truncate(overDefault, DEFAULT_MAX_IMAGE_FILE_SIZE + 1);
    await assert.rejects(() => service.readImageFile('session-1', 'over-default.png'), rejectsWith(ErrorCode.FILE_TOO_LARGE));

    service.updateConfig(imageServiceConfig({ maxFileSize: 1024 * 1024, maxImageFileSize: 4096 }));
    await assert.rejects(() => service.readImageFile('session-1', 'eight.png'), rejectsWith(ErrorCode.FILE_TOO_LARGE));

    // 필드를 뺀 설정으로 다시 갱신하면 기본 20 MiB 로 돌아온다
    service.updateConfig(imageServiceConfig({ maxFileSize: 1024 * 1024 }));
    assert.equal((await service.readImageFile('session-1', 'eight.png')).size, 8 * 1024);
  }, { maxFileSize: 1024 * 1024 });
});

// FR-FEX-017: the session root used to carry a '..' row whose listing the server then refused
// (PATH_TRAVERSAL), so the up action was offered only to fail.
test('FR-FEX-017 AC-1 listing the session root offers no parent entry', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'buildergate-file-service-'));
  try {
    await fs.writeFile(path.join(tempDir, 'a.txt'), 'a');
    const service = listingService(tempDir);
    for (const target of [undefined, '.', tempDir]) {
      const listing = await service.listDirectory('session-1', target);
      assert.equal(listing.entries.some(entry => entry.name === '..'), false, `target ${String(target)}`);
      assert.equal(listing.totalEntries, 1);
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('FR-FEX-017 AC-4 listing above the session root is still refused', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'buildergate-file-service-'));
  try {
    await assert.rejects(
      () => listingService(tempDir).listDirectory('session-1', '..'),
      (error: unknown) => error instanceof AppError && error.code === ErrorCode.PATH_TRAVERSAL,
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

// FR-FEX-018: the information modal reads one path's attributes, inside the session root only.
test('FR-FEX-018 AC-2 stat reports a file and a directory inside the session root', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'buildergate-file-service-'));
  try {
    await fs.mkdir(path.join(tempDir, 'dir'));
    await fs.writeFile(path.join(tempDir, 'dir', 'x.txt'), 'x');
    await fs.writeFile(path.join(tempDir, 'dir', 'y.txt'), 'yy');
    await fs.writeFile(path.join(tempDir, 'note.md'), 'hello');
    const service = listingService(tempDir);

    const file = await service.statPath('session-1', 'note.md');
    assert.equal(file.name, 'note.md');
    assert.equal(file.kind, 'file');
    assert.equal(file.size, 5);
    assert.equal(file.extension, '.md');
    assert.equal(file.relativePath, 'note.md');
    assert.equal(path.basename(file.path), 'note.md');
    for (const key of ['modified', 'accessed', 'changed'] as const) assert.ok(!Number.isNaN(Date.parse(file[key])), key);
    assert.match(file.mode, /^0[0-7]{3}$/);
    assert.match(file.permissions, /^[r-][w-][x-][r-][w-][x-][r-][w-][x-]$/);
    assert.equal(file.childCount, undefined);

    const dir = await service.statPath('session-1', 'dir');
    assert.equal(dir.kind, 'directory');
    assert.equal(dir.childCount, 2);
    assert.equal(dir.relativePath, 'dir');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('FR-FEX-018 AC-2 stat refuses a path outside the session root', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'buildergate-file-service-'));
  try {
    await assert.rejects(
      () => listingService(tempDir).statPath('session-1', '..'),
      (error: unknown) => error instanceof AppError && error.code === ErrorCode.PATH_TRAVERSAL,
    );
    await assert.rejects(
      () => listingService(tempDir).statPath('session-1', 'missing.txt'),
      (error: unknown) => error instanceof AppError && error.code === ErrorCode.PATH_NOT_FOUND,
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
