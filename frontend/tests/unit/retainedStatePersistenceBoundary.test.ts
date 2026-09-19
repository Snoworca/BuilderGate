import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  beginRecovery,
  createRecordingRecoveryAdapter,
  requireRecoveryCoordinatorFactory,
  type RecoveryChunk,
  type RecoveryScope,
} from '../helpers/visibleOutputRecoveryContract.ts';

/**
 * REL-BGSTAB-026 — server-restart and offline retained-state persistence scope boundary.
 *
 * AC-3: after a server restart, a screen filled from a provisional local cache must be
 * marked non-authoritative and must not be counted as preservation success, as `ready`,
 * or as a dirty-clear.
 *
 * `finishCurrentView` (src/utils/visibleOutputRecovery.ts) does all three of those in one
 * block: it sets `currentViewTransactionReady = true`, clears `provisionalLocalState`, and
 * clears `hiddenDirty`. The only thing standing between a provisional restore and that
 * block is `record.serverReadyLatched`.
 *
 * These tests are deliberately kept in their own file, separate from live-server refresh
 * coverage, because AC-4 requires the restart scope and the live-refresh scope to be
 * verified by different tests so that one passing cannot be cited for the other.
 */

const CONNECTION_GENERATION = 7;
const SESSION_GENERATION = 11;

interface ConvergedTransaction {
  readonly coordinator: ReturnType<ReturnType<typeof requireRecoveryCoordinatorFactory>>;
  readonly scope: RecoveryScope;
}

/**
 * Drives a recovery transaction to the point where every gate except the server-ready
 * latch is satisfied: a snapshot is accepted at a complete parser boundary and every
 * scheduled write has drained. Whether the view becomes `ready` from here is decided
 * solely by the authority signal, which is what both tests below are about.
 */
function convergeAllButAuthority(
  signature: string,
  scope: RecoveryScope,
  beginOverrides: Record<string, unknown>,
): ConvergedTransaction {
  const factory = requireRecoveryCoordinatorFactory(signature);
  const adapter = createRecordingRecoveryAdapter();
  const coordinator = factory({
    maxHeldBytes: 4096,
    maxHeldChunks: 16,
    transportMode: 'unified',
    adapter,
  });

  beginRecovery(coordinator, scope, beginOverrides);

  const localCacheTail: RecoveryChunk = {
    chunkId: 'provisional-local-cache-tail',
    data: 'restored-from-local-cache',
  };
  coordinator.dispatch({
    type: 'output-arrived',
    ...scope,
    transactionId: 'tx-current',
    connectionGeneration: CONNECTION_GENERATION,
    sessionGeneration: SESSION_GENERATION,
    chunk: localCacheTail,
  });
  coordinator.dispatch({
    type: 'authoritative-snapshot-applied',
    ...scope,
    transactionId: 'tx-current',
    repairToken: 'repair-current',
    replayToken: 'replay-current',
    snapshotSeq: 10_000,
    parserBoundary: 'complete',
    connectionGeneration: CONNECTION_GENERATION,
    sessionGeneration: SESSION_GENERATION,
  });

  assert.strictEqual(adapter.scheduled[0]?.chunk, localCacheTail, signature);
  adapter.scheduled[0]?.onWritten();

  return { coordinator, scope };
}

/**
 * The coordinator resolves an absent `serverReadyLatched` in favour of authority
 * (`visibleOutputRecovery.ts`: `event.serverReadyLatched !== false`). A RED test written
 * against that default confirmed it: a `begin-resync` that omits the field converges to
 * `ready`, drops `provisionalLocalState` and clears `hiddenDirty` with no server authority
 * ever arriving -- the three outcomes AC-3 forbids.
 *
 * That default is NOT reachable from production today. `src/` has exactly one
 * `begin-resync` producer, `createBoundTerminalRestoreAdapter().begin()`, and its only
 * production caller states the absence explicitly. The adapter's `remount()` would reach
 * the fail-open default, but no production code calls it.
 *
 * So the live guarantee is a wiring property, and this test asserts the wiring rather than
 * re-asserting a coordinator default that production never exercises. Closing the default
 * itself would mean making the dependency explicit at seven call sites inside
 * REL-BGSTAB-009's tests, which is not this requirement's to change.
 */
test('REL-BGSTAB-026 AC-3 — the production restore path never begins without an authority signal', () => {
  const signature = 'the production begin-resync stopped stating serverReadyLatched explicitly';
  const container = readFileSync(
    fileURLToPath(new URL('../../src/components/Terminal/TerminalContainer.tsx', import.meta.url)),
    'utf8',
  );

  const beginCall = /restoreAdapter\.begin\(\{([\s\S]*?)\}\)/.exec(container);
  assert.ok(beginCall, `${signature}: no restoreAdapter.begin({...}) call found`);
  assert.match(beginCall[1], /serverReadyLatched:\s*false/u, signature);
});

test('REL-BGSTAB-026 AC-3 — a provisional restore without server authority stays provisional', () => {
  const signature = 'a provisional local restore was counted as ready, clean, and authoritative';
  const scope: RecoveryScope = {
    clientId: 'client-explicit-no-authority',
    sessionId: 'session-restart-provisional',
  };

  // The production restore path states the absence explicitly
  // (TerminalContainer.tsx `restoreAdapter.begin({ serverReadyLatched: false, ... })`).
  const { coordinator } = convergeAllButAuthority(signature, scope, { serverReadyLatched: false });

  const state = coordinator.getState(scope);
  assert.equal(state?.currentViewTransactionReady, false, signature);
  assert.equal(state?.provisionalLocalState, true, signature);
  assert.equal(state?.hiddenDirty, true, signature);
});
