import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { digestTerminalBytes } from '../../src/utils/terminalRawMutationAdapter.ts';
import { createTerminalWriteCoordinator } from '../../src/utils/terminalWriteCoordinator.ts';

/**
 * `06 §S4-c` / `03 §6.3` — xterm holds two decoders that do not share state, so
 * a non-empty string write landing while `_utf8Decoder.interim` still holds a
 * partial UTF-8 sequence is processed *before* those pending bytes and inverts
 * the output order.
 *
 * Measured 2026-08-28: the mixing condition already exists in production —
 * `compatibility-write` keeps a string (`terminalWriteCoordinator.ts:1983`) and
 * `terminalRawMutationAdapter.ts:82` passes it straight to `terminal.write`,
 * while live, repair, checkpoint-body and parser-tail writes are all
 * `Uint8Array`. What prevents the inversion is not the encoding but the queue:
 * one mutation runs at a time, and a checkpoint keeps the head of the queue
 * across its slices. These are regression tests for that, not new contracts.
 */

const coordinatorSource = readFileSync(
  new URL('../../src/utils/terminalWriteCoordinator.ts', import.meta.url),
  'utf8',
);

interface AdapterWrite {
  readonly kind: string;
  readonly isString: boolean;
}

function harness() {
  const writes: AdapterWrite[] = [];
  const pending: Array<() => void> = [];
  const coordinator = createTerminalWriteCoordinator({
    viewGeneration: 7,
    digestBytes: digestTerminalBytes,
    adapter: {
      write: (command, callback) => {
        writes.push({ kind: command.kind, isString: typeof command.data === 'string' });
        pending.push(callback);
      },
      resetParser: () => {},
      resize: () => {},
      applyModes: () => {},
      clearScreen: () => {},
      fit: () => ({ cols: 80, rows: 24 }),
      setWindowsPty: () => {},
      checkpointApplied: () => {},
      checkpointDrained: () => {},
      markReady: () => {},
      releaseInput: () => {},
      settleInput: () => {},
      requestFreshRecovery: reason => { throw new Error(`unexpected recovery: ${reason}`); },
      requestRuntimeRecreation: reason => { throw new Error(`unexpected recreation: ${reason}`); },
      compatibilityRecoveryDrained: () => {},
      settle: () => {},
    },
    timeoutMs: 100_000,
    postCheckpointMaxBytes: 1024,
    postCheckpointMaxChunks: 16,
    pendingInputMaxBytes: 1024,
    pendingInputMaxCount: 16,
    setTimer: () => 0,
  });
  return { coordinator, writes, pending };
}

function submitWrite(
  h: ReturnType<typeof harness>,
  data: string | Uint8Array,
): { accepted: boolean } {
  return h.coordinator.submitCompatibility({
    type: 'write',
    viewGeneration: 7,
    kind: 'live',
    data,
    onWritten: () => {},
    onRejected: () => {},
  });
}

test('a second write does not reach the terminal while the first is in flight', () => {
  const h = harness();

  assert.equal(submitWrite(h, new Uint8Array([0xed])).accepted, true);
  assert.equal(submitWrite(h, 'plain text').accepted, true);

  // This is the property that keeps a string write out of the middle of a byte
  // write. If it ever stops holding, the pending UTF-8 bytes above would be
  // rendered after the text below.
  assert.deepEqual(h.writes, [{ kind: 'live', isString: false }]);
});

test('the held-back write runs only after the first settles', () => {
  const h = harness();
  submitWrite(h, new Uint8Array([0xed]));
  submitWrite(h, 'plain text');

  h.pending.shift()?.();

  assert.deepEqual(h.writes, [
    { kind: 'live', isString: false },
    { kind: 'live', isString: true },
  ]);
});

test('order is preserved across a mixed run of strings and bytes', () => {
  const h = harness();
  const submitted: boolean[] = [];
  for (const data of ['a', new Uint8Array([1]), 'b', new Uint8Array([2]), 'c']) {
    submitted.push(submitWrite(h, data).accepted);
  }
  assert.deepEqual(submitted, [true, true, true, true, true]);

  while (h.pending.length > 0) h.pending.shift()?.();

  assert.deepEqual(h.writes.map(w => w.isString), [true, false, true, false, true]);
});

test('the pump refuses to start a mutation while one is active', () => {
  // The behavioural tests above rest on this guard; naming it keeps a future
  // reader from removing it as redundant.
  assert.ok(
    coordinatorSource.includes('if (disposed || writeInFlight || activeMutation !== null) return;'),
    'the pump no longer serialises mutations',
  );
});

test('a checkpoint keeps the head of the queue between its body slices', () => {
  // `queue.unshift` is what makes the slices contiguous. `push` would let a
  // queued string write land between two slices, and the checkpoint body is
  // sliced at a flat 32 KiB boundary with no codepoint alignment — unlike the
  // live path, which uses `findUtf8SliceEnd`. So the queue, not the encoding,
  // is what keeps `_utf8Decoder.interim` from being observed by a string write.
  const branch = coordinatorSource.slice(
    coordinatorSource.indexOf("mutation.type === 'checkpoint' && mutation.phase === 'body'"),
  );
  assert.notEqual(branch.length, coordinatorSource.length, 'the checkpoint body branch is gone');
  const unshiftAt = branch.indexOf('queue.unshift(mutation);');
  assert.notEqual(unshiftAt, -1, 'the checkpoint no longer returns to the head of the queue');
  assert.ok(unshiftAt < 600, 'the unshift is no longer inside the checkpoint body branch');
});
