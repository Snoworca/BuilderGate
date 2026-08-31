import assert from 'node:assert/strict';
import test from 'node:test';

import { createDefaultProcessInfoProvider, readProcessStartIdentity } from './processTreeTerminator.js';

/**
 * The two halves of the identity check must be able to complete under the same
 * conditions.
 *
 * `readProcessStartIdentity` captures the identity under a configurable timeout
 * that defaults to 3000ms. The verification query that later re-reads it used a
 * hardcoded 1500ms. On a machine where the PowerShell CIM query costs about two
 * seconds — measured 2026-08-31 at 1990ms, 2033ms and once 3063ms — the capture
 * succeeds and the verification always times out, so `startIdentity` comes back
 * null, fails to equal what was captured, and the terminator answers
 * `skipped-unverified`. The session record is then removed while its process
 * tree keeps running.
 *
 * Measured on that machine before this change: `identityCaptureSucceeded: 6`,
 * `identityCaptureFailed: 0`, and yet `unverifiedSkipped: 3` with
 * `completed: 0`.
 */

interface ObservedCall { timeout: unknown }

function recordingExecFile(observed: ObservedCall[]) {
  return ((
    _file: string,
    _args: readonly string[],
    options: { timeout?: number },
    callback: (error: Error | null, stdout: string) => void,
  ) => {
    observed.push({ timeout: options.timeout });
    callback(new Error('probe did not finish'), '');
    return undefined as never;
  }) as never;
}

test('the verification query is given at least as long as the capture default', async () => {
  const observed: ObservedCall[] = [];
  const provider = createDefaultProcessInfoProvider({
    platform: 'win32',
    execFileFn: recordingExecFile(observed),
  });

  await provider(1234);

  assert.equal(observed.length, 1, 'the query did not run');
  assert.ok(
    typeof observed[0]!.timeout === 'number' && observed[0]!.timeout >= 3000,
    `the verification query kept a shorter budget than the capture: ${String(observed[0]!.timeout)}`,
  );
});

test('a configured probe timeout reaches the verification query', async () => {
  const observed: ObservedCall[] = [];
  const provider = createDefaultProcessInfoProvider({
    platform: 'win32',
    execFileFn: recordingExecFile(observed),
    processInfoTimeoutMs: 9_000,
  });

  await provider(1234);

  assert.equal(observed[0]!.timeout, 9_000, 'the configured timeout was ignored');
});

test('a failed query still reports what it can rather than throwing', async () => {
  const provider = createDefaultProcessInfoProvider({
    platform: 'win32',
    execFileFn: recordingExecFile([]),
  });

  const info = await provider(1234);

  assert.equal(info.pid, 1234);
  assert.equal(info.startIdentity, null);
  assert.deepEqual(info.childPids, []);
});

/**
 * The two halves must also agree, which is what `inspect` compares. They are
 * built by different code — capture runs a two-line CIM query, verification
 * runs a tree walk that also reports children — so agreement is a property to
 * assert, not one to assume.
 *
 * It did not hold. The verification script joined its statements with "; ",
 * which put a semicolon immediately after `[pscustomobject]@{` and made the
 * hash literal a parse error. PowerShell wrote nothing to stdout, the query was
 * treated as a failed probe, and `startIdentity` came back null for every
 * process — so the identities never matched and no process tree was ever
 * terminated.
 */

test('the query reports an identity for a process that is running', { skip: process.platform !== 'win32' }, async () => {
  const info = await createDefaultProcessInfoProvider({})(process.pid);

  assert.equal(info.running, true);
  assert.ok(info.startIdentity, 'the query produced no identity for a live process');
});

test('capture and verification agree on the same process', { skip: process.platform !== 'win32' }, async () => {
  const captured = await readProcessStartIdentity(process.pid);
  const verified = (await createDefaultProcessInfoProvider({})(process.pid)).startIdentity;

  assert.ok(captured, 'the capture half produced nothing');
  assert.equal(verified, captured, 'the two halves disagree, so every cleanup is skipped as unverified');
});
