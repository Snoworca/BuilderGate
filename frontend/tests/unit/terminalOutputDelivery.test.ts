import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fromJsonOutputMessage } from '../../src/utils/terminalOutputDelivery.ts';
import { splitVisibleOutputSourceSegments } from '../../src/utils/visibleOutputRecovery.ts';
import type { TerminalOutputMessage } from '../../src/types/ws-protocol.ts';

/**
 * S4-C4 — the codec-neutral output delivery IR.
 *
 * `onOutput` currently receives `(data: string, message: TerminalOutputMessage)`
 * and does its own segment splitting. Only that split actually depends on the
 * codec; everything else needs a byte length and a write payload. Lifting both
 * into one neutral shape lets the JSON and binary paths share the handler
 * unchanged, with the codec confined to which adapter built the value.
 *
 * This file covers the JSON adapter only. Building it is a pure addition — no
 * call site is rewired here, so production behaviour is unchanged.
 */

const message = (overrides: Partial<TerminalOutputMessage> = {}): TerminalOutputMessage => ({
  type: 'output',
  sessionId: 'session-1',
  data: 'abcd',
  ...overrides,
});

test('a message without sourceSegments yields one whole chunk and reports no segments', () => {
  const msg = message({ data: 'abcd' });
  const delivery = fromJsonOutputMessage(msg.data, msg);

  assert.equal(delivery.codec, 'json');
  assert.equal(delivery.hasSourceSegments, false);
  assert.equal(delivery.chunks?.length, 1);
  assert.equal(delivery.chunks?.[0].data, 'abcd');
  assert.equal(delivery.whole.data, 'abcd');
  assert.equal(delivery.whole.byteLength, 4);
});

test('the whole chunk carries the message-level identity fields', () => {
  const msg = message({
    data: 'abcd',
    screenSeq: 7,
    authorityEpoch: 'epoch-1',
    authorityRevision: 3,
    chunkId: 'chunk-9',
  });
  const delivery = fromJsonOutputMessage(msg.data, msg);

  assert.equal(delivery.whole.screenSeq, 7);
  assert.equal(delivery.whole.authorityEpoch, 'epoch-1');
  assert.equal(delivery.whole.authorityRevision, 3);
  assert.equal(delivery.whole.chunkId, 'chunk-9');
});

test('byteLength is UTF-8, not character count', () => {
  const msg = message({ data: '한글' });
  const delivery = fromJsonOutputMessage(msg.data, msg);

  assert.equal(delivery.whole.byteLength, 6, '2 characters, 6 bytes');
  assert.equal(delivery.chunks?.[0].byteLength, 6);
});

test('sourceSegments produce per-segment chunks with their own identity', () => {
  const msg = message({
    data: '한글',
    sourceSegments: [
      { byteStart: 0, byteEnd: 3, chunkId: 'c1', screenSeq: 1 },
      { byteStart: 3, byteEnd: 6, chunkId: 'c2', screenSeq: 2, authorityEpoch: 'e2' },
    ],
  });
  const delivery = fromJsonOutputMessage(msg.data, msg);

  assert.equal(delivery.hasSourceSegments, true);
  assert.equal(delivery.chunks?.length, 2);
  assert.deepEqual(delivery.chunks?.map(chunk => chunk.data), ['한', '글']);
  assert.deepEqual(delivery.chunks?.map(chunk => chunk.byteLength), [3, 3]);
  assert.deepEqual(delivery.chunks?.map(chunk => chunk.chunkId), ['c1', 'c2']);
  assert.deepEqual(delivery.chunks?.map(chunk => chunk.screenSeq), [1, 2]);
  assert.equal(delivery.chunks?.[1].authorityEpoch, 'e2');
});

test('an unsatisfiable segment list yields null chunks, not an empty list', () => {
  const msg = message({
    data: 'abcd',
    sourceSegments: [{ byteStart: 0, byteEnd: 3, chunkId: 'c1' }],
  });
  const delivery = fromJsonOutputMessage(msg.data, msg);

  assert.equal(
    delivery.chunks,
    null,
    'null and [] mean different things downstream — null is "could not split"',
  );
  assert.equal(delivery.hasSourceSegments, true, 'the message did carry segments; they were invalid');
  assert.equal(delivery.whole.data, 'abcd', 'the whole payload must survive an unusable split');
});

test('differential — chunk data matches splitVisibleOutputSourceSegments exactly', () => {
  const segments = [
    { byteStart: 0, byteEnd: 3, chunkId: 'c1' },
    { byteStart: 3, byteEnd: 6, chunkId: 'c2' },
  ];
  const msg = message({ data: '한글', sourceSegments: segments });

  const viaAdapter = fromJsonOutputMessage(msg.data, msg).chunks?.map(chunk => chunk.data);
  const viaExisting = splitVisibleOutputSourceSegments('한글', [...segments])?.map(chunk => chunk.data);

  // Both are compared to the same literal, not to each other.
  assert.deepEqual(viaAdapter, ['한', '글']);
  assert.deepEqual(viaExisting, ['한', '글']);
});

test('tokens and the ack identity are carried through', () => {
  const msg = message({
    replayToken: 'replay-1',
    repairToken: 'repair-1',
    connectionEpoch: 'conn-1',
    deliverySeq: 42,
  });
  const delivery = fromJsonOutputMessage(msg.data, msg);

  assert.equal(delivery.replayToken, 'replay-1');
  assert.equal(delivery.repairToken, 'repair-1');
  assert.deepEqual(delivery.ack, { connectionEpoch: 'conn-1', deliverySeq: 42 });
});

test('boundary control — a partial ack identity yields no ack at all', () => {
  const withoutSeq = fromJsonOutputMessage('abcd', message({ connectionEpoch: 'conn-1' }));
  const withoutEpoch = fromJsonOutputMessage('abcd', message({ deliverySeq: 42 }));

  assert.equal(withoutSeq.ack, undefined, 'half an identity must not be acknowledged');
  assert.equal(withoutEpoch.ack, undefined);
});

/**
 * `previewText` is a function rather than a string because the binary adapter has
 * to decode to produce it, and the debug-tail and capture paths that read it are
 * both off by default. Keeping it callable is what lets that cost stay unpaid.
 */
test('previewText is a deferred call, not a precomputed string', () => {
  const delivery = fromJsonOutputMessage('abcd', message({ data: 'abcd' }));

  assert.equal(typeof delivery.previewText, 'function');
  assert.equal(delivery.previewText(), 'abcd');
});

test('boundary control — an empty payload is still a well-formed delivery', () => {
  const delivery = fromJsonOutputMessage('', message({ data: '' }));

  assert.equal(delivery.whole.byteLength, 0);
  assert.equal(delivery.whole.data, '');
  assert.equal(delivery.hasSourceSegments, false);
  assert.equal(delivery.chunks?.length, 1);
});

/**
 * `TerminalContainer` now forwards `delivery.previewText` unevaluated, which detaches
 * it from the delivery object. `previewText` is declared as a property holding a
 * function, so an adapter written with method shorthand — `previewText() { return
 * this.decode(); }` — type-checks and then throws at runtime once detached. No
 * compile error would catch it. Every adapter must therefore be `this`-free.
 */
test('previewText survives being detached from its delivery', () => {
  const delivery = fromJsonOutputMessage('abcd', message({ data: 'abcd' }));

  const detached = delivery.previewText;
  assert.equal(detached(), 'abcd', 'a this-dependent adapter would throw or return undefined here');

  // Reassigned onto an unrelated host: still `this`-free, so still correct.
  const rehosted = { previewText: delivery.previewText };
  assert.equal(rehosted.previewText(), 'abcd');
});
