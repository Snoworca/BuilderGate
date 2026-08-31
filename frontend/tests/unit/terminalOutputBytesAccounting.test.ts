import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getOutputUtf8ByteLength } from '../../src/utils/terminalOutputHotPath.ts';
import {
  createTerminalOutputIngressRetryQueue,
  type TerminalOutputWriteData,
} from '../../src/utils/terminalOutputScheduler.ts';

/**
 * S4-C3 — byte accounting on the ingress path.
 *
 * Every assertion here uses bytes whose *decimal rendering* is a different length
 * than the bytes themselves: `Uint8Array([200, 201])` is 2 bytes, but
 * `TextEncoder.encode(String(view))` is `"200,201"` — 7. So an implementation that
 * stringifies cannot produce the expected number by accident. A test built on
 * ASCII-range bytes would pass either way and prove nothing.
 */

/** 2 bytes; stringifies to "200,201" (7 bytes). */
const WIDE_DECIMAL_BYTES = () => new Uint8Array([200, 201]);

/** 3 bytes; stringifies to "1,2,3" (5 bytes). */
const NARROW_DECIMAL_BYTES = () => new Uint8Array([1, 2, 3]);

test('getOutputUtf8ByteLength reports byte length for a byte view without stringifying', () => {
  assert.equal(getOutputUtf8ByteLength(WIDE_DECIMAL_BYTES()), 2);
  assert.equal(getOutputUtf8ByteLength(NARROW_DECIMAL_BYTES()), 3);
  assert.equal(getOutputUtf8ByteLength(new Uint8Array(0)), 0);
});

test('boundary control — getOutputUtf8ByteLength still measures UTF-8 length for text', () => {
  assert.equal(getOutputUtf8ByteLength('abc'), 3);
  assert.equal(getOutputUtf8ByteLength('한'), 3, 'a multi-byte codepoint must not be counted as one');
  assert.equal(getOutputUtf8ByteLength(''), 0);
});

interface RetryProbe {
  queue: ReturnType<typeof createTerminalOutputIngressRetryQueue>;
  attempts: TerminalOutputWriteData[];
}

function createRetryProbe(): RetryProbe {
  const attempts: TerminalOutputWriteData[] = [];
  const queue = createTerminalOutputIngressRetryQueue({
    maxBytes: 1024,
    maxChunks: 16,
    attempt: (data: TerminalOutputWriteData) => {
      attempts.push(data);
      return 'retryable';
    },
    isIdle: () => false,
    armBarrier: () => true,
  });
  return { queue, attempts };
}

test('the ingress retry queue accounts a deferred byte view by its byte length', () => {
  const { queue } = createRetryProbe();

  const deferred = queue.defer({
    data: WIDE_DECIMAL_BYTES(),
    onWritten: () => {},
    onRejected: () => {},
  });

  assert.equal(deferred, true, 'a byte view must be deferrable, not rejected outright');
  assert.equal(
    queue.getSnapshot().queuedBytes,
    2,
    'a stringifying implementation would report 7 here',
  );
  assert.equal(queue.getSnapshot().queuedChunks, 1);
});

test('boundary control — the retry queue still accounts text by UTF-8 length', () => {
  const { queue } = createRetryProbe();

  queue.defer({ data: '한', onWritten: () => {}, onRejected: () => {} });

  assert.equal(
    queue.getSnapshot().queuedBytes,
    3,
    'text accounting must stay UTF-8 based; 1 would mean it switched to .length',
  );
});

test('boundary control — mixed text and byte deferrals accumulate on one scale', () => {
  const { queue } = createRetryProbe();

  queue.defer({ data: '한', onWritten: () => {}, onRejected: () => {} });
  queue.defer({ data: WIDE_DECIMAL_BYTES(), onWritten: () => {}, onRejected: () => {} });

  assert.equal(queue.getSnapshot().queuedBytes, 5, '3 UTF-8 bytes plus 2 raw bytes');
  assert.equal(queue.getSnapshot().queuedChunks, 2);
});

test('the retry queue hands bytes to attempt unchanged', () => {
  const bytes = WIDE_DECIMAL_BYTES();
  const seen: TerminalOutputWriteData[] = [];
  // Collected in an array rather than a `let` — a `let` assigned only inside the
  // callback narrows to `never`, and the release call becomes statically dead
  // while still appearing to work at runtime.
  const armedBarriers: Array<() => void> = [];

  const queue = createTerminalOutputIngressRetryQueue({
    maxBytes: 1024,
    maxChunks: 16,
    attempt: (data: TerminalOutputWriteData) => {
      seen.push(data);
      return 'accepted';
    },
    isIdle: () => true,
    armBarrier: onReady => {
      armedBarriers.push(onReady);
      return true;
    },
  });

  queue.defer({ data: bytes, onWritten: () => {}, onRejected: () => {} });
  // An idle queue retries without waiting on a barrier, so this releases nothing
  // today. It is here so the test keeps working if that ordering changes.
  armedBarriers.forEach(release => release());

  assert.deepEqual(
    seen,
    [bytes],
    'the retried payload must be the same view, not a re-encoded copy',
  );
  assert.equal(queue.getSnapshot().queuedChunks, 0, 'an accepted retry must leave the queue');
});

test('boundary control — a busy queue holds the deferral instead of attempting it', () => {
  const seen: TerminalOutputWriteData[] = [];
  const queue = createTerminalOutputIngressRetryQueue({
    maxBytes: 1024,
    maxChunks: 16,
    attempt: (data: TerminalOutputWriteData) => {
      seen.push(data);
      return 'accepted';
    },
    isIdle: () => false,
    armBarrier: () => true,
  });

  queue.defer({ data: WIDE_DECIMAL_BYTES(), onWritten: () => {}, onRejected: () => {} });

  assert.deepEqual(seen, [], 'a busy queue must not attempt immediately');
  assert.equal(
    queue.getSnapshot().queuedChunks,
    1,
    'if this were 0 the previous test could not distinguish attempted from dropped',
  );
});
