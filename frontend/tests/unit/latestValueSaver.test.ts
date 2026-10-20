import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createLatestValueSaver } from '../../src/utils/latestValueSaver.ts';

// PERF-BGSTAB-024 (#156): a tab or view-mode selection shows at once and is saved behind it. Saves
// go one at a time and only the latest value is sent after the one in flight, so the server ends
// on the last selection whatever order the network answers in.

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('PERF-BGSTAB-024 AC-2: while one save is in flight only the latest value follows it', async () => {
  const sent: string[] = [];
  const pending: ReturnType<typeof deferred>[] = [];
  const saver = createLatestValueSaver<string>((value) => {
    sent.push(value);
    const d = deferred();
    pending.push(d);
    return d.promise;
  });
  void saver.save('a');
  void saver.save('b');
  void saver.save('c');
  assert.deepEqual(sent, ['a'], 'one request at a time');
  pending[0].resolve();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(sent, ['a', 'c'], 'b was superseded by c');
  pending[1].resolve();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(sent, ['a', 'c']);
});

test('PERF-BGSTAB-024 AC-3: a failure is reported once and the next value is still sent', async () => {
  const errors: unknown[] = [];
  let calls = 0;
  const saver = createLatestValueSaver<string>(async (value) => {
    calls += 1;
    if (value === 'bad') throw new Error('offline');
  }, (error) => errors.push(error));
  await saver.save('bad');
  await saver.save('good');
  assert.equal(errors.length, 1);
  assert.equal(calls, 2);
});

test('PERF-BGSTAB-024 AC-1/AC-4: the workspace manager shows the selection before saving it', () => {
  const source = readFileSync(new URL('../../src/hooks/useWorkspaceManager.ts', import.meta.url), 'utf8');
  for (const name of ['setActiveTab', 'setViewMode']) {
    const start = source.indexOf(`const ${name} = useCallback(`);
    assert.ok(start >= 0, `${name} exists`);
    const body = source.slice(start, source.indexOf('}, [', start));
    const shown = body.indexOf('setWorkspaces(');
    assert.ok(shown >= 0, `${name} updates the screen`);
    assert.doesNotMatch(body.slice(0, shown), /await /, `${name} does not wait before showing the selection`);
    assert.match(body, /Saver\(workspaceId\)\.save\(/, `${name} saves through the latest-value saver`);
  }
});
