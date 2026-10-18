// FR-FEX-023 AC-5, AC-6 (#139): the upload temp-file name and the record that lets a restart
// remove what a crash left behind. Run: cwd=server/, npx tsx --test src/services/upload/uploadTemp.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { UploadTempRegistry, isUploadTempName, newUploadTempName, validateUploadRelativePath } from './uploadTemp.js';

test('FR-FEX-023 AC-5: upload temp names are recognised and nothing else is', () => {
  const name = newUploadTempName();
  assert.match(name, /^\.bgupload-[0-9a-f]{16}\.part$/);
  assert.equal(isUploadTempName(name), true);
  assert.notEqual(newUploadTempName(), name);
  for (const other of ['.bgupload-mine.part', 'x.bgupload-0123456789abcdef.part', '.bgupload-0123456789abcdef', 'a.part']) {
    assert.equal(isUploadTempName(other), false, other);
  }
});

test('FR-FEX-023 AC-3: relative path validation returns the segments or refuses', () => {
  assert.deepEqual(validateUploadRelativePath('a/b\\c.txt'), ['a', 'b', 'c.txt']);
  for (const bad of ['', '..', 'a/..', '/a', 'C:a', 'a:b', 'a\u0000', 'CON', 'Com3.txt', 'LPT1', 'a//b', '.', 'nul.', 'aux ', newUploadTempName()]) {
    assert.equal(validateUploadRelativePath(bad), null, JSON.stringify(bad));
  }
});

test('FR-FEX-023 AC-6: temp files recorded before a crash are deleted at startup and the record emptied', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'buildergate-upload-temp-'));
  try {
    const registryPath = path.join(root, 'data', 'upload-temp.json');
    const dir = path.join(root, 'work');
    await fs.mkdir(dir);
    const before = new UploadTempRegistry(registryPath);
    const left = path.join(dir, newUploadTempName());
    const gone = path.join(dir, newUploadTempName());
    await fs.writeFile(left, 'partial');
    await before.add(left);
    await before.add(gone); // recorded, never created
    // A recorded path that is not an upload temp name is never deleted, whatever the file says.
    const userFile = path.join(dir, 'report.md');
    await fs.writeFile(userFile, 'mine');
    await fs.writeFile(registryPath, JSON.stringify([left, gone, userFile]));

    // "Restart": a fresh registry over the same file.
    const after = new UploadTempRegistry(registryPath);
    const removed = await after.cleanupStale();
    assert.deepEqual(removed, [left]);
    assert.deepEqual(await fs.readdir(dir), ['report.md']);
    assert.deepEqual(JSON.parse(await fs.readFile(registryPath, 'utf8')), []);
    assert.deepEqual(after.list(), []);

    // No record at all is not an error.
    const fresh = new UploadTempRegistry(path.join(root, 'none', 'upload-temp.json'));
    assert.deepEqual(await fresh.cleanupStale(), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('FR-FEX-023 AC-6: add and remove persist in order', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'buildergate-upload-temp-'));
  try {
    const registryPath = path.join(root, 'upload-temp.json');
    const registry = new UploadTempRegistry(registryPath);
    const a = path.join(root, newUploadTempName());
    const b = path.join(root, newUploadTempName());
    await Promise.all([registry.add(a), registry.add(b)]);
    await registry.remove(a);
    assert.deepEqual(registry.list(), [b]);
    assert.deepEqual(JSON.parse(await fs.readFile(registryPath, 'utf8')), [b]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
