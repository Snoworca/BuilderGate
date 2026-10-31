// FR-MDE-033 AC-2..AC-5: what a click on a rendered markdown link opens.
//
// Contract under test (src/components/editor/markdownLinkTarget.ts):
//   resolveMarkdownLink(url, fromFilePath)
//     -> { kind: 'external'; url } | { kind: 'document'; filePath } | { kind: 'none' }
// The module is loaded inside each test so a missing module names the test.
import test from 'node:test';
import assert from 'node:assert/strict';
import type * as LinkTargetModule from '../../src/components/editor/markdownLinkTarget.ts';

type Resolve = typeof LinkTargetModule.resolveMarkdownLink;

async function load(): Promise<Resolve> {
  const mod = await import('../../src/components/editor/markdownLinkTarget.ts') as typeof LinkTargetModule;
  return mod.resolveMarkdownLink;
}

const POSIX = '/repo/docs/guide/intro.md';
const WIN = 'C:\\work\\repo\\docs\\intro.md';

test('AC-2: 스킴이 있는 주소와 // 주소는 external', async () => {
  const resolve = await load();
  assert.deepEqual(resolve('https://example.com/a?b=1#c', POSIX), { kind: 'external', url: 'https://example.com/a?b=1#c' });
  assert.deepEqual(resolve('http://x.org', POSIX), { kind: 'external', url: 'http://x.org' });
  assert.deepEqual(resolve('mailto:a@b.c', POSIX), { kind: 'external', url: 'mailto:a@b.c' });
  assert.deepEqual(resolve('//cdn.example.com/x', POSIX), { kind: 'external', url: '//cdn.example.com/x' });
  assert.deepEqual(resolve('  https://example.com  ', POSIX), { kind: 'external', url: 'https://example.com' });
});

test('AC-3: 상대 경로는 현재 파일의 폴더 기준으로 풀린다 (POSIX)', async () => {
  const resolve = await load();
  assert.deepEqual(resolve('./other.md', POSIX), { kind: 'document', filePath: '/repo/docs/guide/other.md' });
  assert.deepEqual(resolve('other.md', POSIX), { kind: 'document', filePath: '/repo/docs/guide/other.md' });
  assert.deepEqual(resolve('../../PRD.md', POSIX), { kind: 'document', filePath: '/repo/PRD.md' });
  assert.deepEqual(resolve('sub/./a/../b.md', POSIX), { kind: 'document', filePath: '/repo/docs/guide/sub/b.md' });
  assert.deepEqual(resolve('/etc/notes.md', POSIX), { kind: 'document', filePath: '/etc/notes.md' });
});

test('AC-3: ? 와 # 뒤는 버리고 %XX 는 풀며 잘못된 %XX 는 그대로 둔다', async () => {
  const resolve = await load();
  assert.deepEqual(resolve('a%20b.md#section', POSIX), { kind: 'document', filePath: '/repo/docs/guide/a b.md' });
  assert.deepEqual(resolve('c.md?raw=1', POSIX), { kind: 'document', filePath: '/repo/docs/guide/c.md' });
  assert.deepEqual(resolve('100%.md', POSIX), { kind: 'document', filePath: '/repo/docs/guide/100%.md' });
  assert.deepEqual(resolve('%ED%95%9C%EA%B8%80.md', POSIX), { kind: 'document', filePath: '/repo/docs/guide/한글.md' });
});

test('AC-3: Windows 경로는 백슬래시를 따르고 드라이브 문자는 절대 경로다', async () => {
  const resolve = await load();
  assert.deepEqual(resolve('../PRD.md', WIN), { kind: 'document', filePath: 'C:\\work\\repo\\PRD.md' });
  assert.deepEqual(resolve('sub/a.md', WIN), { kind: 'document', filePath: 'C:\\work\\repo\\docs\\sub\\a.md' });
  assert.deepEqual(resolve('D:/notes/x.md', WIN), { kind: 'document', filePath: 'D:\\notes\\x.md' });
  assert.deepEqual(resolve('C:\\a\\b.md', WIN), { kind: 'document', filePath: 'C:\\a\\b.md' });
});

test('AC-3: 루트 위로 올라가는 .. 는 루트에서 멈춘다', async () => {
  const resolve = await load();
  assert.deepEqual(resolve('../../../../../x.md', POSIX), { kind: 'document', filePath: '/x.md' });
  assert.deepEqual(resolve('../../../x.md', WIN), { kind: 'document', filePath: 'C:\\x.md' });
});

test('AC-4: file: 주소는 경로로, # 만 있거나 빈 주소는 none', async () => {
  const resolve = await load();
  assert.deepEqual(resolve('file:///repo/README.md', POSIX), { kind: 'document', filePath: '/repo/README.md' });
  assert.deepEqual(resolve('file:///C:/work/a.md', WIN), { kind: 'document', filePath: 'C:\\work\\a.md' });
  assert.deepEqual(resolve('#heading', POSIX), { kind: 'none' });
  assert.deepEqual(resolve('', POSIX), { kind: 'none' });
  assert.deepEqual(resolve('   ', POSIX), { kind: 'none' });
});

test('AC-2: 허용 목록 밖의 스킴(javascript·data·vbscript·blob·알 수 없는 것)은 none', async () => {
  const resolve = await load();
  assert.deepEqual(resolve('javascript:alert(1)', POSIX), { kind: 'none' });
  assert.deepEqual(resolve('JavaScript:alert(1)', POSIX), { kind: 'none' });
  assert.deepEqual(resolve('data:text/html,<b>x</b>', POSIX), { kind: 'none' });
  assert.deepEqual(resolve('vbscript:msgbox', POSIX), { kind: 'none' });
  assert.deepEqual(resolve('blob:https://x/1', POSIX), { kind: 'none' });
  assert.deepEqual(resolve('localhost:3000/x', POSIX), { kind: 'none' });
  assert.deepEqual(resolve('tel:+821012345678', POSIX), { kind: 'external', url: 'tel:+821012345678' });
  assert.deepEqual(resolve('HTTPS://Example.com', POSIX), { kind: 'external', url: 'HTTPS://Example.com' });
});

test('AC-3: Windows 파일에서 드라이브 없는 절대 경로는 현재 파일의 드라이브를 쓴다', async () => {
  const resolve = await load();
  assert.deepEqual(resolve('/docs/a.md', WIN), { kind: 'document', filePath: 'C:\\docs\\a.md' });
});
