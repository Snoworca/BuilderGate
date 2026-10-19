import assert from 'node:assert/strict';
import { test } from 'node:test';
import type * as TerminalPathOpenModule from '../../src/utils/terminalPathOpen.ts';
import type { PathStat } from '../../src/types/index.ts';

// FR-ARCH-012 AC-8 — a path from the terminal opens only after the server says it
// is a file the editor can open; anything else is refused with a reason, so the
// editor never offers to create a missing file.
const MODULE_PATH = '../../src/utils/terminalPathOpen.ts';
type M = typeof TerminalPathOpenModule;

async function load(): Promise<M> {
  return await import(MODULE_PATH) as M;
}

function stat(path: string, kind: PathStat['kind']): PathStat {
  const name = path.split(/[\\/]/).pop() ?? path;
  return {
    name, path, relativePath: name, kind, size: 1,
    modified: '', accessed: '', changed: '', mode: '', permissions: '',
  };
}

test('FR-ARCH-012 AC-8: a file opens at the path the server resolved', async () => {
  const { decideTerminalPathOpen } = await load();
  const asked: string[] = [];
  const decision = await decideTerminalPathOpen({ path: 'docs/a.html', alternatives: [] }, async (path) => {
    asked.push(path);
    return stat('C:\\w\\docs\\a.html', 'file');
  });
  assert.deepEqual(asked, ['docs/a.html']);
  assert.deepEqual(decision, { kind: 'open', path: 'C:\\w\\docs\\a.html' });
});

test('FR-ARCH-012 AC-8: a folder is refused', async () => {
  const { decideTerminalPathOpen } = await load();
  const decision = await decideTerminalPathOpen({ path: 'docs.md', alternatives: [] }, async () => stat('/w/docs.md', 'directory'));
  assert.equal(decision.kind, 'refuse');
});

test('FR-ARCH-012 AC-8: a resolved file the editor cannot open is refused', async () => {
  const { decideTerminalPathOpen } = await load();
  const decision = await decideTerminalPathOpen({ path: 'link.md', alternatives: [] }, async () => stat('/w/archive.zip', 'file'));
  assert.equal(decision.kind, 'refuse');
});

test('FR-ARCH-012 AC-8: a missing path or one outside the session folder is refused with the server reason', async () => {
  const { decideTerminalPathOpen } = await load();
  const decision = await decideTerminalPathOpen({ path: 'gone.md', alternatives: [] }, async () => {
    throw new Error('경로를 찾을 수 없습니다.');
  });
  assert.equal(decision.kind, 'refuse');
  assert.ok(decision.kind === 'refuse' && decision.reason.includes('경로를 찾을 수 없습니다.'));
});

test('FR-ARCH-012 AC-8: when the joined path is not found, its fragments are tried in order', async () => {
  const { decideTerminalPathOpen } = await load();
  const asked: string[] = [];
  const decision = await decideTerminalPathOpen({ path: 'docs/a.md', alternatives: ['a.md'] }, async (path) => {
    asked.push(path);
    if (path === 'a.md') return stat('/w/a.md', 'file');
    throw new Error('경로를 찾을 수 없습니다.');
  });
  assert.deepEqual(asked, ['docs/a.md', 'a.md']);
  assert.deepEqual(decision, { kind: 'open', path: '/w/a.md' });
});

test('FR-ARCH-012 AC-8: when nothing is found, the refusal names the joined path and its reason', async () => {
  const { decideTerminalPathOpen } = await load();
  const decision = await decideTerminalPathOpen({ path: 'docs/a.md', alternatives: ['a.md'] }, async () => {
    throw new Error('경로를 찾을 수 없습니다.');
  });
  assert.deepEqual(decision, { kind: 'refuse', path: 'docs/a.md', reason: '경로를 찾을 수 없습니다.' });
});
