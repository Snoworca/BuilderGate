import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('../../src/components/Terminal/TerminalContainer.tsx', import.meta.url), 'utf8');

test('TerminalContainer maps visible output recovery into the input transport barrier', () => {
  assert.match(source, /resolveVisibleOutputRecoveryBarrierReason/);
  assert.match(source, /visible-output-recovery/);
  assert.match(source, /syncInputTransportState\('visible-output-recovery/);
});

test('TerminalContainer keeps queued input deferred while visible output recovery is blocking', () => {
  const readyForFlushIndex = source.indexOf('const readyForFlush = Boolean(');
  assert.notEqual(readyForFlushIndex, -1);
  const visibleBarrierIndex = source.lastIndexOf(
    'const visibleRecoveryBarrier = resolveVisibleOutputRecoveryBarrierReason(visibleOutputRecoveryStateRef.current);',
    readyForFlushIndex,
  );
  assert.notEqual(visibleBarrierIndex, -1);
  const readyForFlushChunk = source.slice(visibleBarrierIndex, readyForFlushIndex + 350);

  assert.match(readyForFlushChunk, /resolveVisibleOutputRecoveryBarrierReason/);
  assert.match(readyForFlushChunk, /=== 'none'/);
});

test('TerminalContainer retries queued input after visible output recovery finishes', () => {
  const finishIndex = source.indexOf('const finishVisibleOutputRecoveryIfPending = useCallback');
  assert.notEqual(finishIndex, -1);
  const finishChunk = source.slice(finishIndex, finishIndex + 900);

  assert.match(finishChunk, /const finishReason = `visible-output-recovery-finished-\$\{source\}`/);
  assert.match(finishChunk, /syncInputTransportState\(finishReason\)/);
  assert.match(finishChunk, /flushTransportOutbox\(finishReason\)/);
});

test('TerminalContainer does not finish visible recovery after fallback snapshot placeholder', () => {
  const finishIndex = source.indexOf("finishVisibleOutputRecoveryIfPending('screen-snapshot')");
  assert.notEqual(finishIndex, -1);
  const surroundingChunk = source.slice(Math.max(0, finishIndex - 250), finishIndex + 120);

  assert.match(surroundingChunk, /if \(visibleOutputRecoverySnapshotSucceeded\) \{\s*finishVisibleOutputRecoveryIfPending\('screen-snapshot'\)/);
});

test('TerminalContainer does not suppress authoritative repair while visible recovery is pending', () => {
  const suppressIndex = source.indexOf('const shouldSuppressScreenRepairRequest = useCallback');
  assert.notEqual(suppressIndex, -1);
  const suppressChunk = source.slice(suppressIndex, suppressIndex + 1400);

  const inFlightIndex = suppressChunk.indexOf('const inFlight = screenRepairInFlightRef.current');
  const visibleRecoveryIndex = suppressChunk.indexOf('resolveVisibleOutputRecoveryBarrierReason(visibleOutputRecoveryStateRef.current)');
  const completedIndex = suppressChunk.indexOf('const completed = lastCompletedScreenRepairRef.current');
  assert.notEqual(inFlightIndex, -1);
  assert.notEqual(visibleRecoveryIndex, -1);
  assert.notEqual(completedIndex, -1);
  assert.ok(inFlightIndex < visibleRecoveryIndex);
  assert.ok(visibleRecoveryIndex < completedIndex);

  const visibleRecoveryChunk = suppressChunk.slice(visibleRecoveryIndex, completedIndex);
  assert.match(visibleRecoveryChunk, /visibleRecoveryBarrier !== 'none'/);
  assert.match(visibleRecoveryChunk, /return false/);
});

test('TerminalContainer uses runtime-configured transport outbox limits', () => {
  assert.doesNotMatch(source, /const TRANSPORT_INPUT_QUEUE_TTL_MS/);
  assert.doesNotMatch(source, /const TRANSPORT_INPUT_QUEUE_BYTE_BUDGET/);
  assert.match(source, /getTransportOutboxLimits/);
});

test('TerminalContainer does not clear hidden output recovery after fallback placeholder', () => {
  const placeholderIndex = source.indexOf('screen_snapshot_fallback_placeholder_applied');
  assert.notEqual(placeholderIndex, -1);
  const nextChunk = source.slice(placeholderIndex, placeholderIndex + 700);

  assert.doesNotMatch(nextChunk, /finishHiddenOutputRecovery/);
  assert.match(source, /shouldClearHiddenOutputAfterSnapshotRecovery/);
});

test('TerminalContainer only finishes visible recovery after authoritative snapshot or local restore success', () => {
  const snapshotIndex = source.indexOf('const handleScreenSnapshot = useEffectEvent');
  assert.notEqual(snapshotIndex, -1);
  const snapshotChunk = source.slice(snapshotIndex, snapshotIndex + 9000);

  assert.match(snapshotChunk, /let visibleOutputRecoverySnapshotSucceeded = false;/);

  const localRestoreIndex = snapshotChunk.indexOf('screen_snapshot_fallback_local_restore');
  assert.notEqual(localRestoreIndex, -1);
  const localRestoreChunk = snapshotChunk.slice(localRestoreIndex, localRestoreIndex + 700);
  assert.match(localRestoreChunk, /visibleOutputRecoverySnapshotSucceeded = true;/);

  const authoritativeIndex = snapshotChunk.indexOf('screen_snapshot_authoritative_applied');
  assert.notEqual(authoritativeIndex, -1);
  const authoritativeChunk = snapshotChunk.slice(authoritativeIndex, authoritativeIndex + 900);
  assert.match(authoritativeChunk, /visibleOutputRecoverySnapshotSucceeded = true;/);

  const fallbackIndex = snapshotChunk.indexOf('screen_snapshot_fallback_applied');
  assert.notEqual(fallbackIndex, -1);
  const fallbackChunk = snapshotChunk.slice(fallbackIndex, fallbackIndex + 650);
  assert.doesNotMatch(fallbackChunk, /visibleOutputRecoverySnapshotSucceeded = true;/);

  const placeholderIndex = snapshotChunk.indexOf('screen_snapshot_fallback_placeholder_applied');
  assert.notEqual(placeholderIndex, -1);
  const placeholderChunk = snapshotChunk.slice(placeholderIndex, placeholderIndex + 650);
  assert.doesNotMatch(placeholderChunk, /visibleOutputRecoverySnapshotSucceeded = true;/);

  const finishIndex = snapshotChunk.indexOf("finishVisibleOutputRecoveryIfPending('screen-snapshot')");
  assert.notEqual(finishIndex, -1);
  const finishGuardChunk = snapshotChunk.slice(Math.max(0, finishIndex - 180), finishIndex + 90);
  assert.match(finishGuardChunk, /if \(visibleOutputRecoverySnapshotSucceeded\)/);
});

test('TerminalContainer does not suppress recent repair while visible recovery is pending', () => {
  const repairIndex = source.indexOf('const requestScreenRepair = useCallback');
  assert.notEqual(repairIndex, -1);
  const repairChunk = source.slice(repairIndex, repairIndex + 2200);

  assert.match(repairChunk, /if \(shouldSuppressScreenRepairRequest\(reason, geometry\.cols, geometry\.rows\)\)/);
  assert.doesNotMatch(repairChunk, /!visibleOutputRecoveryStateRef\.current\.pending\s*&&\s*shouldSuppressScreenRepairRequest/);
});

test('TerminalContainer uses runtime terminal limits for transport outbox budget and TTL', () => {
  assert.match(source, /getTransportOutboxLimits/);
  assert.doesNotMatch(source, /TRANSPORT_INPUT_QUEUE_BYTE_BUDGET/);
  assert.doesNotMatch(source, /TRANSPORT_INPUT_QUEUE_TTL_MS/);

  const classifyIndex = source.indexOf('const classifyTransportQueueDecision = useCallback');
  assert.notEqual(classifyIndex, -1);
  const classifyChunk = source.slice(classifyIndex, classifyIndex + 1800);
  assert.match(classifyChunk, /transportOutboxTtlMs/);
  assert.match(classifyChunk, /ttlMs: transportOutboxTtlMs/);

  const enqueueIndex = source.indexOf('const enqueueTransportInput = useCallback');
  assert.notEqual(enqueueIndex, -1);
  const enqueueChunk = source.slice(enqueueIndex, enqueueIndex + 2600);
  assert.match(enqueueChunk, /transportOutboxMaxBytes/);
  assert.match(enqueueChunk, /queuedByteBudget: transportOutboxMaxBytes/);
});
