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
