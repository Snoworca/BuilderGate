/**
 * REL-BGSTAB-022 AC-5 and AC-6 — the rename retry is bounded, its wait schedule
 * is exact, and it fires only for the codes named in the requirement.
 *
 * Platform note, and it matters: EPERM, EACCES and EBUSY on a rename are
 * Windows semantics. A rename on this Linux/WSL2 host is not refused because a
 * peer holds the destination open, so these codes cannot be produced natively
 * here and are injected at the filesystem boundary instead. That is weaker
 * evidence than a native reproduction, and a Windows run remains the stronger
 * check. What these tests do establish is the shape of the retry: how many
 * attempts, how long between them, and which errors are eligible.
 *
 * Every assertion counts attempts. An assertion that only checked "it rejected"
 * or "it resolved" would pass against a helper that never retries at all, which
 * is exactly the state this suite is written against.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { publishStoreAtomically, RENAME_RETRY_WAITS_MS } from './atomicStoreWrite.js';

async function withPatchedRename<T>(
  replacement: (from: string, to: string) => Promise<void>,
  body: () => Promise<T>,
): Promise<T> {
  const target = fs as unknown as Record<string, unknown>;
  const original = target.rename;
  target.rename = replacement;
  try {
    return await body();
  } finally {
    target.rename = original;
  }
}

async function makeDir(tag: string): Promise<{ dir: string; dest: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `bgstab022-${tag}-`));
  return { dir, dest: path.join(dir, 'store.json') };
}

const errno = (code: string): NodeJS.ErrnoException => {
  const error = new Error(`injected ${code}`) as NodeJS.ErrnoException;
  error.code = code;
  return error;
};

/**
 * Counts attempts on the destination rename only. The helper also renames its
 * backup temp file into place, and counting that too would make the attempt
 * numbers depend on whether a backup happened to be written.
 */
function renameHarness(dest: string, behaviour: (attempt: number) => NodeJS.ErrnoException | null) {
  const realRename = fs.rename.bind(fs);
  const state = { attempts: 0, waits: [] as number[] };
  const replacement = async (from: string, to: string): Promise<void> => {
    if (String(to) !== dest) {
      return realRename(from, to);
    }
    state.attempts += 1;
    const failure = behaviour(state.attempts);
    if (failure) throw failure;
    return realRename(from, to);
  };
  const delay = async (ms: number): Promise<void> => {
    state.waits.push(ms);
  };
  return { state, replacement, delay };
}

for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
  test(`REL-BGSTAB-022 AC-5: ${code} on the destination rename is retried to five attempts`, async () => {
    const { dest } = await makeDir(`retry-${code.toLowerCase()}`);
    // Fails four times, succeeds on the fifth — the last attempt the budget allows.
    const harness = renameHarness(dest, attempt => (attempt <= 4 ? errno(code) : null));

    await withPatchedRename(harness.replacement, async () => {
      await publishStoreAtomically(dest, JSON.stringify({ version: 1 }), { delay: harness.delay });
    });

    assert.equal(
      harness.state.attempts,
      5,
      `a ${code} rename should be retried up to five attempts in total`,
    );
    assert.deepEqual(JSON.parse(await fs.readFile(dest, 'utf-8')), { version: 1 });
  });
}

test('REL-BGSTAB-022 AC-5: the recorded waits are exactly 10, 20, 40 and 80 ms', async () => {
  const { dest } = await makeDir('waits');
  const harness = renameHarness(dest, attempt => (attempt <= 4 ? errno('EPERM') : null));

  await withPatchedRename(harness.replacement, async () => {
    await publishStoreAtomically(dest, JSON.stringify({ version: 1 }), { delay: harness.delay });
  });

  assert.deepEqual(
    harness.state.waits,
    [10, 20, 40, 80],
    'the wait schedule is fixed by the requirement so that an implementation retrying at any other cadence fails here',
  );
  assert.deepEqual(harness.state.waits, [...RENAME_RETRY_WAITS_MS]);
});

test('REL-BGSTAB-022 AC-5: an exhausted budget rejects after five attempts and leaves the destination intact', async () => {
  const { dest } = await makeDir('exhausted');
  const previous = JSON.stringify({ version: 1, generation: 'previous' });
  await fs.writeFile(dest, previous, 'utf-8');

  const harness = renameHarness(dest, () => errno('EPERM'));

  await withPatchedRename(harness.replacement, async () => {
    await assert.rejects(
      publishStoreAtomically(dest, JSON.stringify({ version: 1, generation: 'next' }), { delay: harness.delay }),
      (error: NodeJS.ErrnoException) => error.code === 'EPERM',
      'an exhausted budget should reject with the last error',
    );
  });

  assert.equal(harness.state.attempts, 5, 'the budget is one initial attempt plus four retries');
  assert.equal(harness.state.waits.length, 4);
  assert.deepEqual(
    JSON.parse(await fs.readFile(dest, 'utf-8')),
    { version: 1, generation: 'previous' },
    'a publish that could not complete must leave the previous store readable',
  );
});

test('REL-BGSTAB-022 AC-6: ENOSPC rejects on the first attempt with zero recorded waits', async () => {
  const { dest } = await makeDir('enospc');
  const harness = renameHarness(dest, () => errno('ENOSPC'));

  await withPatchedRename(harness.replacement, async () => {
    await assert.rejects(
      publishStoreAtomically(dest, JSON.stringify({ version: 1 }), { delay: harness.delay }),
      (error: NodeJS.ErrnoException) => error.code === 'ENOSPC',
    );
  });

  assert.equal(
    harness.state.attempts,
    1,
    'a permanent failure must reject on the first attempt; retrying it only delays the same failure',
  );
  assert.deepEqual(harness.state.waits, [], 'a non-transient error must not consume the retry budget');
});

test('REL-BGSTAB-022 AC-5: a failed publish leaves no temp file behind', async () => {
  const { dir, dest } = await makeDir('cleanup');
  const harness = renameHarness(dest, () => errno('ENOSPC'));

  await withPatchedRename(harness.replacement, async () => {
    await assert.rejects(
      publishStoreAtomically(dest, JSON.stringify({ version: 1 }), { delay: harness.delay }),
    );
  });

  const leftovers = (await fs.readdir(dir)).filter(name => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, [], 'the failing publish left its own temp file on disk');
});
