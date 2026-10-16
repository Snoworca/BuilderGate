// FR-MCP-012 AC-2, AC-5: the path checks and the directory-creating write behind the MCP editor tools,
// on a real temporary directory. Run per-file: cwd=server/, npx tsx --test src/services/FileServiceEditorOpen.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { FileService } from './FileService.js';

const SESSION_ID = 'session-editor-open';

async function createService(): Promise<{ cwd: string; service: FileService }> {
  const cwd = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'buildergate-editor-open-')));
  const sessionManager = {
    getSession: (id: string): unknown => (id === SESSION_ID ? { id } : null),
    getPtyPid: (): number | null => null,
    getInitialCwd: (): string | null => cwd,
    getCwdFilePath: (): string | null => null,
  };
  const service = new FileService(sessionManager as never, {
    maxFileSize: 1024,
    maxDirectoryEntries: 100,
    blockedExtensions: ['.exe'],
    blockedPaths: ['.ssh'],
    cwdCacheTtlMs: 1000,
  });
  return { cwd, service };
}

test('FR-MCP-012 AC-5: inspectPath reports files and directories and applies the file API rules', async () => {
  const { cwd, service } = await createService();
  try {
    await fs.writeFile(path.join(cwd, 'a.md'), '# a');
    await fs.mkdir(path.join(cwd, 'dir'));
    assert.deepEqual(await service.inspectPath(SESSION_ID, 'a.md'), { path: path.join(cwd, 'a.md'), exists: true, isFile: true });
    assert.deepEqual(await service.inspectPath(SESSION_ID, 'dir'), { path: path.join(cwd, 'dir'), exists: true, isFile: false });
    assert.deepEqual(await service.inspectPath(SESSION_ID, 'no/such.md'), { path: path.join(cwd, 'no', 'such.md'), exists: false, isFile: false });
    await assert.rejects(service.inspectPath(SESSION_ID, '../outside.md'), { code: 'PATH_TRAVERSAL' });
    await assert.rejects(service.inspectPath(SESSION_ID, '.ssh/key.md'), { code: 'PATH_BLOCKED' });
    await assert.rejects(service.inspectPath(SESSION_ID, 'tool.exe'), { code: 'PATH_BLOCKED' });
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('FR-MCP-012 AC-2: writeFileCreatingDirectories creates the parents and keeps the size limit', async () => {
  const { cwd, service } = await createService();
  try {
    const written = await service.writeFileCreatingDirectories(SESSION_ID, '.buildergate/mcp-docs/x.md', '# x');
    assert.equal(written, path.join(cwd, '.buildergate', 'mcp-docs', 'x.md'));
    assert.equal(await fs.readFile(written, 'utf-8'), '# x');
    await assert.rejects(service.writeFileCreatingDirectories(SESSION_ID, 'big.md', 'x'.repeat(2048)), { code: 'FILE_TOO_LARGE' });
    await assert.rejects(service.writeFileCreatingDirectories(SESSION_ID, '../escape/x.md', 'x'), { code: 'PATH_TRAVERSAL' });
    await assert.rejects(fs.stat(path.join(cwd, '..', 'escape')), 'nothing was created outside');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
