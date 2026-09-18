import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  copyTextToClipboard,
  resolveCopyOutcome,
  type ClipboardCopyDeps,
} from '../../src/utils/clipboardCopy.ts';

/**
 * Issue #83: MetadataRow swallowed clipboard failures in a bare catch, so a
 * failed copy left no trace for the user or for the debug path — the user
 * believed the copy worked and pasted whatever was in the clipboard before.
 *
 * The assertions below are chosen so they cannot hold for BOTH the fixed and the
 * defective behaviour, which is the trap issue #83 names: asserting something
 * like "the handler did not throw" is true of the swallow too.
 */

function deps(overrides: Partial<ClipboardCopyDeps> = {}): ClipboardCopyDeps & {
  writes: string[];
  fallbacks: string[];
} {
  const writes: string[] = [];
  const fallbacks: string[] = [];
  return {
    writes,
    fallbacks,
    writeText: async (text: string) => { writes.push(text); },
    execCommandCopy: (text: string) => { fallbacks.push(text); return true; },
    ...overrides,
  } as ClipboardCopyDeps & { writes: string[]; fallbacks: string[] };
}

test('#83 the async clipboard API is used when it works, with no fallback', async () => {
  const d = deps();
  await copyTextToClipboard('/home/beom', d);
  assert.deepEqual(d.writes, ['/home/beom']);
  assert.deepEqual(d.fallbacks, [], 'the execCommand fallback must not run when the API succeeded');
});

test('#83 a rejected clipboard API falls back rather than failing outright', async () => {
  const d = deps({ writeText: async () => { throw new Error('NotAllowedError'); } });
  await copyTextToClipboard('/tmp/x', d);
  assert.deepEqual(d.fallbacks, ['/tmp/x'], 'the fallback must be attempted when the API rejects');
});

test('#83 failure of BOTH paths throws rather than being swallowed', async () => {
  const d = deps({
    writeText: async () => { throw new Error('NotAllowedError'); },
    execCommandCopy: () => false,
  });
  await assert.rejects(
    () => copyTextToClipboard('/tmp/x', d),
    /clipboard-copy-failed/,
    'a copy that did not happen must reach the caller as an error, not return normally',
  );
});

test('#83 a copy outcome distinguishes success from failure', () => {
  // The defect was that both outcomes rendered identically. These assertions
  // fail if the two collapse back onto one value.
  assert.equal(resolveCopyOutcome({ ok: true }), 'copied');
  assert.equal(resolveCopyOutcome({ ok: false }), 'failed');
  assert.notEqual(
    resolveCopyOutcome({ ok: true }),
    resolveCopyOutcome({ ok: false }),
    'success and failure must not resolve to the same user-visible state',
  );
});

test('#83 the idle state is distinct from both outcomes', () => {
  // Without this, "failed" could be implemented as "stay idle", which is exactly
  // the defect: indistinguishable from never having clicked.
  const outcomes = new Set([
    resolveCopyOutcome(null),
    resolveCopyOutcome({ ok: true }),
    resolveCopyOutcome({ ok: false }),
  ]);
  assert.equal(outcomes.size, 3, 'idle, copied and failed must be three distinct states');
});
