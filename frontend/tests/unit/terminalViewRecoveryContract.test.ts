import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('../../src/components/Terminal/TerminalView.tsx', import.meta.url), 'utf8');

test('TerminalView allows screen repair readiness while visible output recovery barrier is active', () => {
  const readinessIndex = source.indexOf('const getScreenRepairReadiness = useCallback');
  assert.notEqual(readinessIndex, -1);
  const readinessChunk = source.slice(readinessIndex, readinessIndex + 1300);

  assert.match(readinessChunk, /transportBarrierReasonRef\.current !== 'visible-output-recovery'/);
  assert.match(readinessChunk, /reason: 'input-active'/);
});

test('TerminalView uses runtime terminal limits for input queue budget and TTL', () => {
  assert.match(source, /getInputQueueLimits/);
  assert.doesNotMatch(source, /INPUT_QUEUE_BYTE_BUDGET/);
  assert.doesNotMatch(source, /INPUT_QUEUE_TTL_MS/);

  const expireIndex = source.indexOf('const expirePendingInputQueue = useCallback');
  assert.notEqual(expireIndex, -1);
  const expireChunk = source.slice(expireIndex, expireIndex + 850);
  assert.match(expireChunk, /inputQueueTtlMs/);
  assert.match(expireChunk, /now - entry\.queuedAt > inputQueueTtlMs/);

  const enqueueIndex = source.indexOf('const enqueuePendingInput = useCallback');
  assert.notEqual(enqueueIndex, -1);
  const enqueueChunk = source.slice(enqueueIndex, enqueueIndex + 2200);
  assert.match(enqueueChunk, /inputQueueMaxBytes/);
  assert.match(enqueueChunk, /queuedByteBudget: inputQueueMaxBytes/);
});

test('TerminalView uses runtime-configured input queue limits', () => {
  assert.doesNotMatch(source, /const INPUT_QUEUE_BYTE_BUDGET/);
  assert.doesNotMatch(source, /const INPUT_QUEUE_TTL_MS/);
  assert.match(source, /getInputQueueLimits/);
});
