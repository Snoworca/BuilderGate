import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loopDirectoryExists } from './loopDirectory.js';

// FR-LOOP-003 AC-5: the directory check for a new-session loop uses the rule session creation uses
// (SessionManager.resolveSpawnCwd): on Windows a WSL mount path is the Windows folder it names.

const disk = (folders: string[]) => {
  const asked: string[] = [];
  const isDirectory = async (p: string) => { asked.push(p); return folders.includes(p); };
  return { asked, isDirectory };
};

test('FR-LOOP-003 AC-5: on Windows /mnt/<drive>/… is checked as the Windows folder it names', async () => {
  const fs = disk(['C:\\Users\\beom']);
  assert.equal(await loopDirectoryExists('/mnt/c/Users/beom', 'win32', fs.isDirectory), true);
  assert.deepEqual(fs.asked, ['C:\\Users\\beom']);
  assert.equal(await loopDirectoryExists('/mnt/d/nowhere', 'win32', fs.isDirectory), false);
  assert.equal(await loopDirectoryExists('/mnt/c', 'win32', disk(['C:\\']).isDirectory), true);
});

test('FR-LOOP-003 AC-5: on Windows another WSL path cannot be checked from Windows, so it is not refused', async () => {
  const fs = disk([]);
  assert.equal(await loopDirectoryExists('/home/beom/work', 'win32', fs.isDirectory), true);
  assert.equal(await loopDirectoryExists('/tmp', 'win32', fs.isDirectory), true);
  assert.deepEqual(fs.asked, [], 'no Windows stat of a Linux path (C:\\tmp happening to exist decided it before)');
});

test('FR-LOOP-003 AC-5: a Windows path on Windows, and any path elsewhere, is checked as given', async () => {
  assert.equal(await loopDirectoryExists('C:\\work\\market', 'win32', disk(['C:\\work\\market']).isDirectory), true);
  assert.equal(await loopDirectoryExists('C:\\missing', 'win32', disk([]).isDirectory), false);
  assert.equal(await loopDirectoryExists('/mnt/c/Users/beom', 'linux', disk(['/mnt/c/Users/beom']).isDirectory), true);
  assert.equal(await loopDirectoryExists('/home/x', 'linux', disk([]).isDirectory), false);
});
