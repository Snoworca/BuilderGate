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
    await fs.writeFile(path.join(tempDir, 'a.txt'), 'a');
    await fs.writeFile(path.join(tempDir, 'b.txt'), 'b');
    const listing = await listingService(tempDir).listDirectory('session-1', '.');

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
      ['..', '.bg-part-0123456789abcdef0', '.bg-part-mine', 'a.txt'],
    );
    assert.equal(listing.totalEntries, 4);
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
