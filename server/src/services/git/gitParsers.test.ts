// FR-GIT-001/005/006/007: git output parsers. Pure functions over the exact text git prints.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LOG_FORMAT,
  parseLfsPointer,
  parseLog,
  parseNameStatusZ,
  parseNumstatZ,
  parseRefs,
  parseStatusV2,
  parseUnifiedDiff,
} from './gitParsers.js';

const Z = (...records: string[]) => records.map((r) => r + '\0').join('');

// @req FR-GIT-001
test('FR-GIT-001: porcelain v2 branch headers', () => {
  const s = parseStatusV2(Z(
    '# branch.oid 1111111111111111111111111111111111111111',
    '# branch.head feat/git-graph',
    '# branch.upstream origin/feat/git-graph',
    '# branch.ab +2 -1',
  ));
  assert.deepEqual(s.branch, { oid: '1111111111111111111111111111111111111111', head: 'feat/git-graph', detached: false, upstream: 'origin/feat/git-graph', ahead: 2, behind: 1 });
  assert.deepEqual(s.files, []);

  const detached = parseStatusV2(Z('# branch.oid 2222222222222222222222222222222222222222', '# branch.head (detached)'));
  assert.equal(detached.branch.detached, true);
  assert.equal(detached.branch.head, null);
  assert.equal(detached.branch.upstream, null);

  const unborn = parseStatusV2(Z('# branch.oid (initial)', '# branch.head main'));
  assert.equal(unborn.branch.oid, null);
  assert.equal(unborn.branch.head, 'main');
});

// @req FR-GIT-001
test('FR-GIT-001: porcelain v2 entries become per-area files, and paths count each path once', () => {
  const s = parseStatusV2(Z(
    '# branch.oid 1111111111111111111111111111111111111111',
    '# branch.head main',
    '1 MM N... 100644 100644 100644 aaaaaaaa bbbbbbbb src/a.ts',
    '1 .D N... 100644 100644 000000 aaaaaaaa aaaaaaaa src/gone.ts',
    '1 A. N... 000000 100644 100644 00000000 cccccccc new file.ts',
    '2 R. N... 100644 100644 100644 dddddddd dddddddd R92 src/b.ts', 'src/old b.ts',
    'u UU N... 100644 100644 100644 100644 e1 e2 e3 conflict.ts',
    '? untracked/x.txt',
    '! ignored.log',
  ));
  assert.deepEqual(s.files, [
    { path: 'src/a.ts', kind: 'M', area: 'staged' },
    { path: 'src/a.ts', kind: 'M', area: 'unstaged' },
    { path: 'src/gone.ts', kind: 'D', area: 'unstaged' },
    { path: 'new file.ts', kind: 'A', area: 'staged' },
    { path: 'src/b.ts', origPath: 'src/old b.ts', kind: 'R', similarity: 92, area: 'staged' },
    { path: 'conflict.ts', kind: 'X', area: 'conflict' },
    { path: 'untracked/x.txt', kind: '?', area: 'untracked' },
  ]);
  assert.deepEqual(s.counts, { staged: 3, unstaged: 2, untracked: 1, conflicted: 1, paths: 6 });
});

// @req FR-GIT-005
test('FR-GIT-005: refs from %D with --decorate=full', () => {
  assert.deepEqual(parseRefs('HEAD -> refs/heads/feat/x, refs/remotes/origin/feat/x, tag: refs/tags/v0.10.20, refs/heads/main'), [
    { kind: 'head', name: 'feat/x' },
    { kind: 'remote', name: 'origin/feat/x' },
    { kind: 'tag', name: 'v0.10.20' },
    { kind: 'local', name: 'main' },
  ]);
  assert.deepEqual(parseRefs('HEAD'), [{ kind: 'head', name: 'HEAD' }]);
  assert.deepEqual(parseRefs('refs/remotes/origin/HEAD'), [{ kind: 'remote', name: 'origin/HEAD' }]);
  assert.deepEqual(parseRefs(''), []);
});

// @req FR-GIT-005
test('FR-GIT-005: log records', () => {
  assert.match(LOG_FORMAT, /%H/);
  const rec = (...f: string[]) => f.join('\x1f') + '\x1e';
  const out = rec('aaa', 'bbb ccc', 'Kim', 'k@x', '1761200000', 'Merge: a, b', 'HEAD -> refs/heads/main')
    + '\n' + rec('bbb', '', 'Lee', 'l@x', '1761100000', 'root', '');
  assert.deepEqual(parseLog(out), [
    { sha: 'aaa', parents: ['bbb', 'ccc'], author: 'Kim', email: 'k@x', time: 1761200000, subject: 'Merge: a, b', refs: [{ kind: 'head', name: 'main' }] },
    { sha: 'bbb', parents: [], author: 'Lee', email: 'l@x', time: 1761100000, subject: 'root', refs: [] },
  ]);
  assert.deepEqual(parseLog(''), []);
});

// @req FR-GIT-006
test('FR-GIT-006: name-status and numstat with -z, renames carry both paths, binaries have no counts', () => {
  assert.deepEqual(parseNameStatusZ(Z('M', 'a.ts', 'R092', 'old.ts', 'new.ts', 'A', 'img.png', 'D', 'gone.ts', 'T', 'link')), [
    { kind: 'M', path: 'a.ts' },
    { kind: 'R', path: 'new.ts', origPath: 'old.ts', similarity: 92 },
    { kind: 'A', path: 'img.png' },
    { kind: 'D', path: 'gone.ts' },
    { kind: 'T', path: 'link' },
  ]);
  assert.deepEqual(parseNumstatZ('3\t1\ta.ts\0' + '2\t2\t\0old.ts\0new.ts\0' + '-\t-\timg.png\0'), [
    { path: 'a.ts', add: 3, del: 1, binary: false },
    { path: 'new.ts', origPath: 'old.ts', add: 2, del: 2, binary: false },
    { path: 'img.png', add: 0, del: 0, binary: true },
  ]);
});

// @req FR-GIT-007
test('FR-GIT-007: unified diff into hunks with line numbers', () => {
  const d = parseUnifiedDiff([
    'diff --git a/src/a.ts b/src/a.ts',
    'index 1111111..2222222 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -12,4 +12,5 @@ export function layout',
    ' keep',
    '-old',
    '+new',
    '+added',
    ' tail',
    '\\ No newline at end of file',
    '@@ -40 +41,0 @@',
    '-only',
    '',
  ].join('\n'));
  assert.equal(d.length, 1);
  const f = d[0];
  assert.equal(f.oldPath, 'src/a.ts');
  assert.equal(f.newPath, 'src/a.ts');
  assert.equal(f.binary, false);
  assert.deepEqual(f.hunks[0], {
    oldStart: 12, oldLines: 4, newStart: 12, newLines: 5, header: '@@ -12,4 +12,5 @@ export function layout',
    lines: [
      { k: ' ', o: 12, n: 12, t: 'keep' },
      { k: '-', o: 13, n: null, t: 'old' },
      { k: '+', o: null, n: 13, t: 'new' },
      { k: '+', o: null, n: 14, t: 'added' },
      { k: ' ', o: 14, n: 15, t: 'tail' },
    ],
  });
  assert.deepEqual(f.hunks[1], { oldStart: 40, oldLines: 1, newStart: 41, newLines: 0, header: '@@ -40 +41,0 @@', lines: [{ k: '-', o: 40, n: null, t: 'only' }] });
});

// @req FR-GIT-007
test('FR-GIT-007: diff headers report binary, mode, symlink, submodule, new and deleted files, renames', () => {
  const files = parseUnifiedDiff([
    'diff --git a/img.png b/img.png',
    'new file mode 100644',
    'index 0000000..3333333',
    'Binary files /dev/null and b/img.png differ',
    'diff --git a/tools/release.sh b/tools/release.sh',
    'old mode 100644',
    'new mode 100755',
    'diff --git a/link b/link',
    'index 4444444..5555555 120000',
    '--- a/link',
    '+++ b/link',
    '@@ -1 +1 @@',
    '-../a',
    '\\ No newline at end of file',
    '+../b',
    '\\ No newline at end of file',
    'diff --git a/vendor/xterm b/vendor/xterm',
    'index 3f2a1c0..9e8d7b6 160000',
    '--- a/vendor/xterm',
    '+++ b/vendor/xterm',
    '@@ -1 +1 @@',
    '-Subproject commit 3f2a1c0',
    '+Subproject commit 9e8d7b6',
    'diff --git a/gone.ts b/gone.ts',
    'deleted file mode 100644',
    'index 6666666..0000000',
    '--- a/gone.ts',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-bye',
    'diff --git a/old name.ts b/new name.ts',
    'similarity index 100%',
    'rename from old name.ts',
    'rename to new name.ts',
  ].join('\n'));
  assert.equal(files.length, 6);
  assert.deepEqual([files[0].binary, files[0].isNew], [true, true]);
  assert.deepEqual([files[1].oldMode, files[1].newMode, files[1].hunks.length], ['100644', '100755', 0]);
  assert.equal(files[2].mode, '120000');
  assert.equal(files[3].mode, '160000');
  assert.equal(files[4].isDeleted, true);
  assert.deepEqual([files[5].oldPath, files[5].newPath, files[5].similarity], ['old name.ts', 'new name.ts', 100]);
});

// @req FR-GIT-007
test('FR-GIT-007: Git LFS pointer', () => {
  const oid = 'a'.repeat(64);
  assert.deepEqual(parseLfsPointer(`version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize 12345\n`), { oid, size: 12345 });
  assert.equal(parseLfsPointer('export const x = 1;\n'), null);
});
