// PERF-GIT-001 AC-8: git processes are started from a worker thread, so creating a process
// (CreateProcess on Windows, with the antivirus scan it triggers) does not block the event loop.
import test from 'node:test';
import assert from 'node:assert/strict';
import { threadId } from 'node:worker_threads';
import { createWorkerRunGitFile } from './gitWorkerRunner.js';

const node = process.execPath;
const opts = (over: Record<string, unknown> = {}) => ({ env: { ...process.env }, timeout: 10_000, maxBuffer: 1 << 20, windowsHide: true as const, encoding: 'utf8' as const, ...over });

test('PERF-GIT-001 AC-8: a command runs off the main thread and returns its output', async (t) => {
  const run = createWorkerRunGitFile();
  t.after(() => run.close());
  const out = await run(node, ['-e', 'process.stdout.write("hi " + process.argv.length)'], opts());
  assert.equal(out.stdout, 'hi 1');
  assert.notEqual(out.threadId, threadId, 'spawned from a worker thread');
  assert.notEqual(out.threadId, undefined);
  const raw = await run(node, ['-e', 'process.stdout.write(Buffer.from([0, 255, 1]))'], opts({ encoding: 'buffer' }));
  assert.ok(Buffer.isBuffer(raw.stdout));
  assert.deepEqual([...(raw.stdout as Buffer)], [0, 255, 1]);
});

test('PERF-GIT-001 AC-8: failures keep what classifyGitError reads (code, stderr, killed)', async (t) => {
  const run = createWorkerRunGitFile();
  t.after(() => run.close());
  await assert.rejects(run(node, ['-e', 'process.stderr.write("fatal: not a git repository"); process.exit(128)'], opts()), (err: { code?: unknown; stderr?: unknown }) => {
    assert.equal(err.code, 128);
    assert.match(String(err.stderr), /not a git repository/);
    return true;
  });
  await assert.rejects(run('definitely-not-a-command-xyz', [], opts()), (err: { code?: unknown }) => err.code === 'ENOENT');
  await assert.rejects(run(node, ['-e', 'setTimeout(() => {}, 5000)'], opts({ timeout: 200 })), (err: { killed?: unknown }) => err.killed === true);
});

test('PERF-GIT-001 AC-8: many commands at once all complete', async (t) => {
  const run = createWorkerRunGitFile();
  t.after(() => run.close());
  const outs = await Promise.all(Array.from({ length: 12 }, (_, i) => run(node, ['-e', `process.stdout.write("${i}")`], opts())));
  assert.deepEqual(outs.map((o) => o.stdout), Array.from({ length: 12 }, (_, i) => String(i)));
});

test('PERF-GIT-001 AC-8: the git runner uses the worker by default', async () => {
  const { defaultRunGitFile } = await import('./gitRunner.js');
  const out = await defaultRunGitFile(node, ['-e', 'process.stdout.write("ok")'], opts()) as { stdout: string; threadId?: number };
  assert.equal(out.stdout, 'ok');
  assert.notEqual(out.threadId ?? threadId, threadId, 'started from a worker thread');
});

test('PERF-GIT-001 AC-8: an argument execFile refuses fails that command only', async (t) => {
  const run = createWorkerRunGitFile(1);
  t.after(() => run.close());
  const bad = run('git', ['--version', 'a\0b'], { env: process.env, timeout: 10_000, maxBuffer: 1 << 20, windowsHide: true, encoding: 'utf8' });
  const good = run('git', ['--version'], { env: process.env, timeout: 10_000, maxBuffer: 1 << 20, windowsHide: true, encoding: 'utf8' });
  await assert.rejects(bad);
  assert.match(String((await good).stdout), /^git version/);
});
