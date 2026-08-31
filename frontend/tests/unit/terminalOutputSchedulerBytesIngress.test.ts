import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createTerminalOutputScheduler,
  type TerminalOutputSchedulerOptions,
  type TerminalOutputWriteData,
} from '../../src/utils/terminalOutputScheduler.ts';

/**
 * S4-C2 — the bytes ingress entry point.
 *
 * `enqueue` is typed `data: string`, but `Uint8Array` also has `.length`, so the
 * empty-input guard waves one through and `TextEncoder.encode` then stringifies
 * it: `new Uint8Array([27,91,49])` becomes the seven characters `27,91,49`.
 * That is silent corruption, not a decode error, so nothing downstream reports it.
 *
 * Byte input therefore gets its own entry point rather than a widened `enqueue`,
 * and `enqueue`/`enqueueLegacy` reject bytes outright.
 */

interface Harness {
  scheduler: ReturnType<typeof createTerminalOutputScheduler>;
  writes: TerminalOutputWriteData[];
  encodeCalls: () => number;
}

function createHarness(overrides: Partial<TerminalOutputSchedulerOptions> = {}): Harness {
  const writes: TerminalOutputWriteData[] = [];
  let encodeCalls = 0;
  const realEncoder = new TextEncoder();

  const scheduler = createTerminalOutputScheduler({
    visibleOutputQueueMaxBytes: 1024 * 1024,
    visibleOutputMaxChunks: 256,
    visibleFlushBudgetBytes: 1024 * 1024,
    write: (data, onWritten) => {
      writes.push(data);
      onWritten();
    },
    textEncoder: {
      encode: (input?: string) => {
        encodeCalls += 1;
        return realEncoder.encode(input);
      },
    },
    schedule: drain => drain(),
    ...overrides,
  });

  return { scheduler, writes, encodeCalls: () => encodeCalls };
}

const ESC_BRACKET_ONE = () => new Uint8Array([27, 91, 49]);

/** The same three bytes as text. Written escaped so the file holds no raw control bytes. */
const ESC_BRACKET_ONE_TEXT = '\x1b[1';

function concatWrites(writes: readonly TerminalOutputWriteData[]): Uint8Array {
  const encoder = new TextEncoder();
  const parts = writes.map(write => (typeof write === 'string' ? encoder.encode(write) : write));
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const merged = new Uint8Array(total);
  let cursor = 0;
  for (const part of parts) {
    merged.set(part, cursor);
    cursor += part.byteLength;
  }
  return merged;
}

test('enqueue rejects byte input instead of stringifying it', () => {
  const { scheduler, writes } = createHarness();

  assert.throws(
    () => scheduler.enqueue(ESC_BRACKET_ONE() as unknown as string),
    TypeError,
    'enqueue must reject Uint8Array rather than encode its decimal rendering',
  );
  assert.deepEqual(writes, [], 'a rejected ingress must not reach the write path');
});

test('enqueueLegacy rejects byte input instead of stringifying it', () => {
  const { scheduler, writes } = createHarness();

  assert.throws(
    () => scheduler.enqueueLegacy(ESC_BRACKET_ONE() as unknown as string),
    TypeError,
    'the legacy entry point must not be left as an unguarded byte path',
  );
  assert.deepEqual(writes, [], 'a rejected ingress must not reach the write path');
});

test('enqueueBytes writes bytes verbatim without invoking the encoder', () => {
  const { scheduler, writes, encodeCalls } = createHarness();

  const decision = scheduler.enqueueBytes(ESC_BRACKET_ONE());
  scheduler.flush();

  assert.deepEqual(decision, { ok: true });
  assert.deepEqual(
    concatWrites(writes),
    ESC_BRACKET_ONE(),
    'bytes must arrive unchanged — a stringified round trip would widen them',
  );
  assert.equal(
    encodeCalls(),
    0,
    'a bytes ingress must not re-encode; PERF-BGSTAB-009 counts this call',
  );
});

test('boundary control — the same bytes as a string are accepted and encoded exactly once', () => {
  const { scheduler, writes, encodeCalls } = createHarness();

  const decision = scheduler.enqueue(ESC_BRACKET_ONE_TEXT);
  scheduler.flush();

  assert.deepEqual(decision, { ok: true }, 'rejection must be about the type, not the content');
  assert.deepEqual(concatWrites(writes), ESC_BRACKET_ONE());
  assert.equal(
    encodeCalls(),
    1,
    'if this is 0 the encoder counter is dead and the enqueueBytes assertion proves nothing',
  );
});

test('boundary control — enqueueBytes treats an empty view as empty, not as a zero-length write', () => {
  const { scheduler, writes } = createHarness();

  const decision = scheduler.enqueueBytes(new Uint8Array(0));
  scheduler.flush();

  assert.deepEqual(decision, { ok: true });
  assert.deepEqual(writes, [], 'an empty ingress must not produce a write');
});

/**
 * The legacy path needs its own byte entry point, not just a guard. `attemptLegacy`
 * is the canary-rollback fallback in `TerminalView`; if it could not carry bytes,
 * byte output would be dropped precisely while the system is already degrading.
 */
test('enqueueBytesLegacy writes bytes verbatim without invoking the encoder', () => {
  const { scheduler, writes, encodeCalls } = createHarness();

  const decision = scheduler.enqueueBytesLegacy(ESC_BRACKET_ONE());
  scheduler.flush();

  assert.deepEqual(decision, { ok: true });
  assert.deepEqual(concatWrites(writes), ESC_BRACKET_ONE());
  assert.equal(encodeCalls(), 0, 'the legacy byte path must not re-encode either');
});

test('boundary control — enqueueLegacy(string) still routes through the encoder exactly once', () => {
  const { scheduler, writes, encodeCalls } = createHarness();

  const decision = scheduler.enqueueLegacy(ESC_BRACKET_ONE_TEXT);
  scheduler.flush();

  assert.deepEqual(decision, { ok: true });
  assert.deepEqual(concatWrites(writes), ESC_BRACKET_ONE());
  assert.equal(encodeCalls(), 1, 'a 0 here would mean the legacy text path lost its encode step');
});

test('boundary control — enqueueBytes still reports overflow through the existing decision shape', () => {
  const { scheduler } = createHarness({ visibleOutputQueueMaxBytes: 8 });

  const decision = scheduler.enqueueBytes(new Uint8Array(64));

  assert.equal(decision.ok, false, 'the queue bound must apply to bytes as well as strings');
  assert.equal(
    decision.ok === false ? decision.reason : null,
    'visible-output-overflow',
    'bytes ingress must reuse the existing overflow reason rather than inventing one',
  );
});
