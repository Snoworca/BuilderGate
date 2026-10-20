/**
 * FR-FOP-008 (#153) — the exclusive new-file endpoint.
 *
 * Cases go through the mounted route on a real temporary directory, so both the
 * route and FileService.createFile are exercised. Run per file with node:test
 * (server/src/test-runner.ts does not discover *.test.ts).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import express from 'express';
import { FileService } from '../services/FileService.js';
import { createFileRoutes } from './fileRoutes.js';
import type { FileManagerConfig } from '../types/file.types.js';
import { withLocalHttpServer, type LocalHttpTestFixture } from '../testing/localHttpTestServer.js';

const SESSION_ID = 'session-create-1';

const CONFIG: FileManagerConfig = {
  maxFileSize: 1048576,
  maxDirectoryEntries: 10000,
  blockedExtensions: [],
  blockedPaths: ['.ssh'],
  cwdCacheTtlMs: 1000,
};

interface Harness {
  cwd: string;
  create(body: unknown): Promise<{ status: number; json: { success?: boolean; error?: { code: string } } }>;
}

async function withHarness(run: (harness: Harness) => Promise<void>): Promise<void> {
  const cwd = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'buildergate-file-create-')));
  const sessionManager = {
    getSession: (id: string): unknown => (id === SESSION_ID ? { id } : null),
    getPtyPid: (): number | null => null,
    getInitialCwd: (): string | null => cwd,
    getCwdFilePath: (): string | null => null,
  };
  const app = express();
  app.use(express.json());
  app.use('/api/sessions', createFileRoutes(new FileService(sessionManager, CONFIG)));
  try {
    await withLocalHttpServer(app, async (fixture: LocalHttpTestFixture) => {
      await run({
        cwd,
        async create(body) {
          const response = await fixture.request({
            method: 'POST',
            path: `/api/sessions/${SESSION_ID}/files/create`,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          });
          return { status: response.statusCode, json: JSON.parse(response.body || '{}') };
        },
      });
    });
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
}

test('FR-FOP-008 AC-1: a new name becomes an empty file', async () => {
  await withHarness(async ({ cwd, create }) => {
    const response = await create({ path: cwd, name: 'notes.md' });
    assert.equal(response.status, 200, JSON.stringify(response.json));
    assert.equal(response.json.success, true);
    const stat = await fs.stat(path.join(cwd, 'notes.md'));
    assert.equal(stat.isFile(), true);
    assert.equal(stat.size, 0);
  });
});

test('FR-FOP-008 AC-2: an existing file is refused with 409 and left as it was', async () => {
  await withHarness(async ({ cwd, create }) => {
    await fs.writeFile(path.join(cwd, 'README.md'), 'keep me\n');
    const response = await create({ path: cwd, name: 'README.md' });
    assert.equal(response.status, 409);
    assert.equal(response.json.error?.code, 'FILE_ALREADY_EXISTS');
    assert.equal(await fs.readFile(path.join(cwd, 'README.md'), 'utf8'), 'keep me\n');
  });
});

test('FR-FOP-008 AC-2: an existing folder with that name is refused with 409', async () => {
  await withHarness(async ({ cwd, create }) => {
    await fs.mkdir(path.join(cwd, 'docs'));
    const response = await create({ path: cwd, name: 'docs' });
    assert.equal(response.status, 409);
    assert.equal(response.json.error?.code, 'FILE_ALREADY_EXISTS');
    assert.equal((await fs.stat(path.join(cwd, 'docs'))).isDirectory(), true);
  });
});

test('FR-FOP-008 AC-3: separators, . and .., blocked names and missing fields are refused', async () => {
  await withHarness(async ({ cwd, create }) => {
    for (const name of ['a/b.txt', 'a\\b.txt', '.', '..', '../escape.txt']) {
      const response = await create({ path: cwd, name });
      assert.ok(response.status >= 400 && response.status < 500, `${name} answered ${response.status}`);
    }
    assert.equal((await create({ path: cwd, name: '.ssh' })).status, 403);
    assert.equal((await create({ path: cwd })).status, 400);
    assert.equal((await create({ path: cwd, name: '   ' })).status, 400);
    assert.deepEqual(await fs.readdir(cwd), [], 'nothing was created');
    await assert.rejects(fs.stat(path.join(path.dirname(cwd), 'escape.txt')));
  });
});

test('FR-FOP-008 AC-3: a folder outside the session root is refused', async () => {
  await withHarness(async ({ cwd, create }) => {
    const response = await create({ path: path.dirname(cwd), name: 'outside.txt' });
    assert.ok(response.status >= 400 && response.status < 500, `outside answered ${response.status}`);
    await assert.rejects(fs.stat(path.join(path.dirname(cwd), 'outside.txt')));
  });
});
