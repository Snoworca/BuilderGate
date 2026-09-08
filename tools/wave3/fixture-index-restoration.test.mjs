import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

// PERF-BGSTAB-011: execute only the actual index-restoration statement, never its parent suite.
const require = createRequire(import.meta.url);
const ts = require('../../server/node_modules/typescript/lib/typescript.js');
const sourcePath = new URL('./fair-readmission-closure-v3.internal-core-race.test.mjs', import.meta.url);
const source = readFileSync(sourcePath, 'utf8');
const ast = ts.createSourceFile(sourcePath.pathname, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const statements = [];
function visit(node) {
  if (ts.isIfStatement(node) && node.expression.getText(ast) === 'configIndexed'
    && node.thenStatement.getText(ast).includes('runFixtureGit')) statements.push(node);
  ts.forEachChild(node, visit);
}
visit(ast);
assert.equal(statements.length, 1, 'exact production-test cleanup statement must be selected');
const execute = new Function('configIndexed', 'runFixtureGit', 'fixtureRoot', statements[0].getText(ast));
const gitPath = 'C:/Program Files/Git/cmd/git.exe';
function git(root, args) {
  assert.ok(!args.some(arg => arg === 'reset' || arg === 'clean'), 'prohibited Git command blocked before dispatch');
  return execFileSync(gitPath, args, {
    cwd: root, encoding: 'utf8', windowsHide: true,
    env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL' },
  }).trim();
}
function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'buildergate-index-restoration-'));
  try {
    git(root, ['init', '--quiet']);
    writeFileSync(join(root, '.gitignore'), 'server/config.json5\n', 'utf8');
    git(root, ['add', '--', '.gitignore']);
    git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture baseline']);
    mkdirSync(join(root, 'server'));
    const config = Buffer.from('{ sentinel: "owned UTF-8 fixture" }\n', 'utf8');
    writeFileSync(join(root, 'server/config.json5'), config);
    writeFileSync(join(root, 'other.txt'), 'unrelated staged bytes\n', 'utf8');
    git(root, ['add', '--', 'other.txt']);
    run(root, config);
  } finally {
    assert.equal(resolve(root).startsWith(resolve(tmpdir()) + '\\'), true);
    assert.equal(root.split(/[\\/]/).at(-1).startsWith('buildergate-index-restoration-'), true);
    rmSync(root, { recursive: true, force: true });
  }
}

test('fixture cleanup unstages only newly indexed ignored config and preserves HEAD bytes and unrelated index', () => {
  fixture((root, bytes) => {
    const head = git(root, ['rev-parse', 'HEAD']);
    const other = git(root, ['ls-files', '--stage', '--', 'other.txt']);
    assert.equal(git(root, ['ls-files', '--', 'server/config.json5']), '');
    git(root, ['add', '--force', '--', 'server/config.json5']);
    assert.notEqual(git(root, ['ls-files', '--stage', '--', 'server/config.json5']), '');
    execute(true, git, root);
    assert.equal(git(root, ['ls-files', '--', 'server/config.json5']), '');
    assert.equal(git(root, ['rev-parse', 'HEAD']), head);
    assert.equal(git(root, ['ls-files', '--stage', '--', 'other.txt']), other);
    assert.deepEqual(readFileSync(join(root, 'server/config.json5')), bytes);
    assert.equal(readFileSync(join(root, 'other.txt'), 'utf8'), 'unrelated staged bytes\n');
  });
});

test('fixture cleanup with configIndexed false makes no Git call and preserves existing staged entries', () => {
  fixture(root => {
    const before = git(root, ['ls-files', '--stage']); let calls = 0;
    execute(false, () => { calls++; assert.fail('unstarted index mutation must not trigger cleanup'); }, root);
    assert.equal(calls, 0); assert.equal(git(root, ['ls-files', '--stage']), before);
  });
});

test('fixture cleanup propagates the exact Git failure without deleting config bytes', () => {
  fixture((root, bytes) => {
    git(root, ['add', '--force', '--', 'server/config.json5']);
    const failure = Error('controlled Git dispatch failure'); let calls = 0;
    assert.throws(() => execute(true, (actualRoot, args) => {
      assert.equal(actualRoot, root);
      assert.ok(!args.includes('reset') && !args.includes('clean'), 'prohibited command rejected before even failure injection');
      calls++; throw failure;
    }, root), error => error === failure);
    assert.equal(calls, 1); assert.deepEqual(readFileSync(join(root, 'server/config.json5')), bytes);
  });
});
