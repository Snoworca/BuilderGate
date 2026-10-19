import assert from 'node:assert/strict';
import { test } from 'node:test';
import type * as TerminalPathDetectionModule from '../../src/utils/terminalPathDetection.ts';

// FR-ARCH-013 AC-7 — a path shown in the terminal menu is its file name and,
// below it, its folder relative to the session folder, shortened from the front.
const MODULE_PATH = '../../src/utils/terminalPathDetection.ts';
type M = typeof TerminalPathDetectionModule;

async function load(): Promise<M> {
  return await import(MODULE_PATH) as M;
}

test('FR-ARCH-013 AC-7: an absolute path inside the session folder shows the folder relative to it', async () => {
  const { describeTerminalPath } = await load();
  assert.deepEqual(
    describeTerminalPath('C:\\w\\proj\\docs\\mockups\\a.html', 'C:\\w\\proj'),
    { name: 'a.html', folder: 'docs\\mockups' },
  );
  // Windows paths compare without case, and either separator may appear.
  assert.deepEqual(describeTerminalPath('C:/W/Proj/docs/a.html', 'c:\\w\\proj'), { name: 'a.html', folder: 'docs' });
  assert.deepEqual(describeTerminalPath('/home/u/p/src/a.ts', '/home/u/p'), { name: 'a.ts', folder: 'src' });
});

test('FR-ARCH-013 AC-7: a file in the session folder itself has no folder line of its own', async () => {
  const { describeTerminalPath } = await load();
  assert.deepEqual(describeTerminalPath('C:\\w\\proj\\a.html', 'C:\\w\\proj'), { name: 'a.html', folder: null });
  assert.deepEqual(describeTerminalPath('a.html', 'C:\\w\\proj'), { name: 'a.html', folder: null });
  assert.deepEqual(describeTerminalPath('./a.html', ''), { name: 'a.html', folder: null });
});

test('FR-ARCH-013 AC-7: a relative path keeps its folders; one outside the session folder keeps them all', async () => {
  const { describeTerminalPath } = await load();
  assert.deepEqual(describeTerminalPath('docs/mockups/a.html', 'C:\\w\\proj'), { name: 'a.html', folder: 'docs/mockups' });
  assert.deepEqual(describeTerminalPath('../x/a.md', '/p'), { name: 'a.md', folder: '../x' });
  assert.deepEqual(describeTerminalPath('D:\\x\\y\\a.html', 'C:\\w\\proj'), { name: 'a.html', folder: 'D:\\x\\y' });
  // A sibling folder that only shares a prefix is not inside the session folder.
  assert.deepEqual(describeTerminalPath('C:\\w\\project2\\a.html', 'C:\\w\\proj'), { name: 'a.html', folder: 'C:\\w\\project2' });
});

test('FR-ARCH-013 AC-7: a long folder is shortened from the front, keeping the folders nearest the file', async () => {
  const { shortenFolder } = await load();
  assert.equal(shortenFolder('docs/mockups', 40), 'docs/mockups');
  assert.equal(shortenFolder('aaaa/bbbb/cccc/dddd/eeee', 12), '…/dddd/eeee');
  assert.equal(shortenFolder('C:\\Users\\uhds\\VSCodeProjects\\other', 24), '…\\VSCodeProjects\\other');
  // The nearest folder alone is kept even when it is longer than the limit.
  assert.equal(shortenFolder('a/averyveryverylongfoldername', 10), '…/averyveryverylongfoldername');
});
