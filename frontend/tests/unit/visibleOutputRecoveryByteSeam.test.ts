import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTerminalContainerRestoreAdapter } from '../../src/utils/visibleOutputRecovery.ts';
import {
  createRecordingRecoveryAdapter,
  requireRecoveryCoordinatorFactory,
  type RecoveryChunk,
} from '../helpers/visibleOutputRecoveryContract.ts';

/**
 * IR-BGSTAB-001 characterization of the one write seam the type system does not
 * cover.
 *
 * `BoundTerminalRestoreAdapter.handle` takes `Record<string, unknown> & {type}`
 * (`visibleOutputRecovery.ts:873-875`), so widening a payload to bytes produces no
 * compile error on this path — unlike every other consumer, where making the field
 * a union surfaces each call site as a type error. These tests pin what actually
 * happens today so the binary receive path cannot change it unnoticed.
 */

const SCOPE = { clientId: 'client-byte-seam', sessionId: 'session-byte-seam' };
const IDENTITY = {
  transactionId: 'tx-current',
  repairToken: 'repair-current',
  replayToken: 'replay-current',
  connectionGeneration: 7,
  sessionGeneration: 11,
};

/**
 * Drives the real `BoundTerminalRestoreAdapter.handle` rather than the coordinator
 * directly, so the untyped seam this file is about is the one actually exercised.
 */
function createSeam(signature: string): {
  seam: ReturnType<typeof createTerminalContainerRestoreAdapter>;
  recorder: ReturnType<typeof createRecordingRecoveryAdapter>;
} {
  const createVisibleOutputRecoveryCoordinator = requireRecoveryCoordinatorFactory(signature);
  const recorder = createRecordingRecoveryAdapter();
  const coordinator = createVisibleOutputRecoveryCoordinator({
    maxHeldBytes: 4096,
    maxHeldChunks: 32,
    transportMode: 'unified',
    adapter: recorder,
  });

  const seam = createTerminalContainerRestoreAdapter({
    coordinator: coordinator as unknown as Parameters<
      typeof createTerminalContainerRestoreAdapter
    >[0]['coordinator'],
    scope: SCOPE,
    identity: { ...IDENTITY },
  });

  // The cast above spans the test-helper and production type declarations. Assert the
  // runtime shape so a drift in either turns this red instead of silently vacuous.
  assert.equal(typeof seam.handle, 'function', signature);
  assert.equal(typeof seam.begin, 'function', signature);
  assert.equal(typeof coordinator.dispatch, 'function', signature);

  return { seam, recorder };
}

function outputArrived(chunk: RecoveryChunk): Record<string, unknown> & { type: string } {
  // `handle` merges identity and scope itself; passing only the payload is what a
  // production caller does.
  return { type: 'output-arrived', chunk };
}

// Control. Without this, every assertion below could pass because the harness
// never reached `acceptOutput` at all.
test('a text chunk is admitted and metered through the restore seam', () => {
  const signature = 'IR-BGSTAB-001: the restore seam must admit text output';
  const { seam } = createSeam(signature);
  seam.begin();

  const result = seam.handle(outputArrived({ chunkId: 'chunk-text', data: 'hello' }));

  assert.equal(result.ignored, false, signature);
  assert.equal(result.state?.heldChunks.length, 1, signature);
  assert.equal(result.state?.heldOutputBytes, 5, signature);
});

/**
 * Every non-string shape, not just `Uint8Array`. Pinning one shape would leave the
 * guard narrowable to `chunk.data instanceof Uint8Array` — which still passes while
 * admitting ArrayBuffer, DataView, Int8Array and friends, each metered by its
 * `String()` spelling. That narrowing is a plausible edit, because the write side
 * already uses exactly that idiom (`terminalOutputScheduler.ts:427`).
 *
 * And the shape most likely to arrive raw is NOT `Uint8Array`: `WebSocket.onmessage`
 * with `binaryType = 'arraybuffer'` delivers an `ArrayBuffer`.
 */
const NON_STRING_PAYLOADS: ReadonlyArray<{ label: string; value: unknown; corruptBytes: number }> = [
  { label: 'Uint8Array', value: new Uint8Array([104, 101, 108, 108, 111]), corruptBytes: 19 },
  { label: 'ArrayBuffer', value: new Uint8Array([104, 101, 108, 108, 111]).buffer, corruptBytes: 20 },
  { label: 'DataView', value: new DataView(new Uint8Array([104, 105]).buffer), corruptBytes: 17 },
  { label: 'Int8Array', value: new Int8Array([104, 105]), corruptBytes: 7 },
  { label: 'number', value: 12345, corruptBytes: 5 },
  { label: 'plain object', value: { toString: () => 'hello' }, corruptBytes: 5 },
  { label: 'boxed String', value: new String('hello'), corruptBytes: 5 },
];

for (const { label, value, corruptBytes } of NON_STRING_PAYLOADS) {
  test(`a ${label} chunk is dropped by the restore seam rather than admitted or re-encoded`, () => {
    const signature = `IR-BGSTAB-001: ${label} reaching the untyped restore seam must not be admitted`;
    const { seam, recorder } = createSeam(signature);
    seam.begin();

    assert.notEqual(typeof value, 'string', 'the fixture must really not be a string');

    const result = seam.handle(outputArrived({
      chunkId: `chunk-${label.replace(/\s+/gu, '-')}`,
      // The seam's own signature is `Record<string, unknown>`, so this cast is what a
      // binary receive path would produce with no compiler objection whatsoever.
      data: value as string,
    }));

    assert.equal(result.ignored, true, signature);
    assert.equal(result.state?.heldChunks.length, 0, signature);
    // 0, never `corruptBytes`. A seam that dropped the `typeof data !== 'string'`
    // guard would reach `recoveryTextEncoder.encode(chunk.data)` and meter the
    // `String()` spelling — the silent corruption `enqueueBytes` exists to stop.
    assert.equal(result.state?.heldOutputBytes, 0, `${signature} (corrupt form would be ${corruptBytes})`);
    assert.equal(recorder.scheduled.length, 0, 'a dropped chunk must not schedule a write');
    assert.equal(recorder.outcomes.length, 0, 'dropping a chunk is silent — it publishes no outcome');
  });
}

// This is the property that makes the drop recoverable rather than terminal, and it
// holds only because the payload validation runs before the dedup check.
test('a dropped byte chunk does not burn its chunkId for a later text retry', () => {
  const signature = 'IR-BGSTAB-001: a rejected chunk must stay retryable under the same id';
  const { seam } = createSeam(signature);
  seam.begin();

  const dropped = seam.handle(outputArrived({
    chunkId: 'chunk-retried',
    data: new Uint8Array([104, 105]) as unknown as string,
  }));
  assert.equal(dropped.ignored, true, signature);

  const retried = seam.handle(outputArrived({ chunkId: 'chunk-retried', data: 'hi' }));

  assert.equal(retried.ignored, false, signature);
  assert.equal(retried.state?.heldChunks.length, 1, signature);
  assert.equal(retried.state?.heldOutputBytes, 2, signature);
});

/**
 * Pins the spread order inside `dispatchFrom` (`visibleOutputRecovery.ts:900-906`):
 * `{...event, ...identity, ...scope}` means the adapter's bound identity OVERRIDES
 * whatever the caller supplied. Reversing it lets a caller's stale value win, and
 * every other test in this file still passes.
 *
 * Only `transactionId` is asserted, because it is the only overlapping key that
 * `output-arrived` actually compares: `acceptOutput` calls `matchesCurrentTransaction`
 * with no options, and `repairToken` is compared only under `requireRepairToken`
 * (`visibleOutputRecovery.ts:1030`). Passing a stale `repairToken` here would look
 * like a stronger test while asserting nothing.
 */
test('the seam overrides a caller-supplied transactionId with its own bound identity', () => {
  const signature = 'IR-BGSTAB-001: bound identity must win over caller-supplied fields';
  const { seam } = createSeam(signature);
  seam.begin();

  const result = seam.handle({
    ...outputArrived({ chunkId: 'chunk-stale-identity', data: 'hello' }),
    transactionId: 'tx-STALE',
  });

  assert.equal(
    result.ignored,
    false,
    'a stale caller identity must be overwritten, not honoured — otherwise the chunk is dropped',
  );
  assert.equal(result.state?.heldChunks.length, 1, signature);
});

// Boundary control for the drop: an empty text chunk is rejected too, so "ignored"
// alone never proves the seam inspected the payload's TYPE.
test('the seam rejects an empty text chunk on the same branch as bytes', () => {
  const signature = 'IR-BGSTAB-001: empty payloads share the rejection branch';
  const { seam } = createSeam(signature);
  seam.begin();

  const result = seam.handle(outputArrived({ chunkId: 'chunk-empty', data: '' }));

  assert.equal(result.ignored, true, signature);
  assert.equal(result.state?.heldChunks.length, 0, signature);
});
