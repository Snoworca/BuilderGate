import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DATA_PLANE_OPCODE, type OutputWireMessage } from '../../src/utils/binaryFrameCodec.ts';
import {
  fromBinaryOutputFrame,
  fromJsonOutputMessage,
} from '../../src/utils/terminalOutputDelivery.ts';
import type { TerminalOutputMessage } from '../../src/types/ws-protocol.ts';

/**
 * S4-C5e — the binary half of the codec-neutral output IR.
 *
 * The adapter is where the wire's u64 ordinals narrow to the IR's `number`, and
 * where `authorityEpoch` / `replayToken` / `repairToken` — none of which the
 * 0x01 frame carries — are supplied by the caller. They arrive on the JSON
 * control plane, so taking them as an argument keeps this a pure function and
 * lets it be written before the channel registry (C5-c) exists.
 */

const BODY = new TextEncoder().encode('hello world');

function outputFrame(overrides: Partial<OutputWireMessage> = {}): OutputWireMessage {
  return {
    opcode: DATA_PLANE_OPCODE.OUTPUT,
    flags: 0x000b,
    channelId: 1,
    streamEpoch: '7',
    sourceSeq: '41',
    prologue: {
      screenSeq: '100',
      chunkIdBase: '42',
      authorityRevision: 3,
      authorityEpochIndex: 0,
    },
    segments: [],
    body: BODY,
    ...overrides,
  } as OutputWireMessage;
}

// ---------------------------------------------------------------------------
// 1. chunkIdBase — the field a spec rule would have thrown away.
// ---------------------------------------------------------------------------

test('a non-zero chunkIdBase is the chunkId even with no segments', () => {
  // 01:544 said not to read chunkIdBase as a chunkId when segmentCount is 0.
  // That is the NORMAL frame: the server issues a chunkId for every output and
  // segments are the exception. Following that rule would leave every live
  // frame without the key `visibleOutputRecovery.ts:1419-1422` requires, and the
  // client would drop the whole stream.
  const delivery = fromBinaryOutputFrame(outputFrame());
  assert.equal(delivery.whole.chunkId, '42');
  assert.equal(delivery.hasSourceSegments, false);
});

test('chunkIdBase 0 means absent, because the generator never issues 0', () => {
  // WsRouter.ts:3642-3646 counts from (prev ?? 0n) + 1n, so the first chunkId is
  // "1". That makes 0 an unambiguous sentinel — which is the disambiguation
  // 01:544 was reaching for, applied to the field that actually carries it.
  const delivery = fromBinaryOutputFrame(
    outputFrame({ prologue: { screenSeq: '100', chunkIdBase: '0', authorityRevision: 3, authorityEpochIndex: 0 } }),
  );
  assert.equal('chunkId' in delivery.whole, false, 'absence must be a missing key, not "0"');
});

// ---------------------------------------------------------------------------
// 2. Parity with the JSON adapter.
// ---------------------------------------------------------------------------

test('no segments produces the same shape as a JSON message without sourceSegments', () => {
  // wsSendPolicy.ts:122 never emits an empty sourceSegments array, so "absent"
  // and "empty" are already the same thing on the JSON wire. segmentCount 0 is
  // that same state, not a third one.
  const binary = fromBinaryOutputFrame(outputFrame());
  const json = fromJsonOutputMessage('hello world', {
    type: 'output',
    sessionId: 's',
    data: 'hello world',
    screenSeq: 100,
    authorityRevision: 3,
    chunkId: '42',
  } as TerminalOutputMessage);

  assert.equal(binary.hasSourceSegments, json.hasSourceSegments);
  assert.equal(binary.chunks?.length, json.chunks?.length);
  assert.equal(binary.chunks?.[0], binary.whole, 'chunks must reuse whole, not a copy');
  assert.equal(binary.whole.byteLength, json.whole.byteLength);
  assert.equal(binary.whole.screenSeq, json.whole.screenSeq);
  assert.equal(binary.whole.authorityRevision, json.whole.authorityRevision);
  assert.equal(binary.whole.chunkId, json.whole.chunkId);
  assert.equal(binary.codec, 'binary');
  assert.equal(json.codec, 'json');
});

test('ack is always absent on the binary path', () => {
  // deliverySeq is not in the frame header at all, and half an identity cannot
  // be acknowledged. TerminalContainer already branches on `ack !== undefined`.
  assert.equal(fromBinaryOutputFrame(outputFrame()).ack, undefined);
});

// ---------------------------------------------------------------------------
// 3. Segments — absolute values reconstructed from deltas.
// ---------------------------------------------------------------------------

test('segments tile the body and their deltas resolve to absolute values', () => {
  const delivery = fromBinaryOutputFrame(outputFrame({
    segments: [
      { byteStart: 0, byteEnd: 5, screenSeqDelta: 0, authorityRevisionDelta: 0, chunkIdDelta: 0 },
      { byteStart: 5, byteEnd: 11, screenSeqDelta: 2, authorityRevisionDelta: 1, chunkIdDelta: 3 },
    ],
  }));

  assert.equal(delivery.hasSourceSegments, true);
  assert.equal(delivery.chunks?.length, 2);

  const [first, second] = delivery.chunks!;
  assert.deepEqual(first!.data, BODY.subarray(0, 5));
  assert.equal(first!.byteLength, 5);
  assert.equal(first!.screenSeq, 100);
  assert.equal(first!.authorityRevision, 3);
  assert.equal(first!.chunkId, '42');

  // Distinct deltas, so a swapped pair would not survive.
  assert.deepEqual(second!.data, BODY.subarray(5, 11));
  assert.equal(second!.byteLength, 6);
  assert.equal(second!.screenSeq, 102);
  assert.equal(second!.authorityRevision, 4);
  assert.equal(second!.chunkId, '45');

  // Chunks must be views too, not copies. `deepEqual` above compares contents
  // and would pass either way, and a copy per segment is a per-frame allocation
  // on the hot path — the cost the byte path exists to avoid.
  assert.equal((first!.data as Uint8Array).buffer, BODY.buffer);
  assert.equal((second!.data as Uint8Array).buffer, BODY.buffer);
});

test('segments that do not tile the body yield chunks null, not a fallback', () => {
  // The IR distinguishes "no segments were sent" from "segments were sent and
  // failed". Collapsing the second into [whole] would silently write bytes the
  // sender said belonged to separate chunks.
  const gap = fromBinaryOutputFrame(outputFrame({
    segments: [
      { byteStart: 0, byteEnd: 4, screenSeqDelta: 0, authorityRevisionDelta: 0, chunkIdDelta: 0 },
      { byteStart: 5, byteEnd: 11, screenSeqDelta: 0, authorityRevisionDelta: 0, chunkIdDelta: 1 },
    ],
  }));
  assert.equal(gap.chunks, null);
  assert.equal(gap.hasSourceSegments, true, 'the caller must still know segments were sent');

  const short = fromBinaryOutputFrame(outputFrame({
    segments: [
      { byteStart: 0, byteEnd: 5, screenSeqDelta: 0, authorityRevisionDelta: 0, chunkIdDelta: 0 },
    ],
  }));
  assert.equal(short.chunks, null, 'segments must reach the final byte');
});

test('a segment whose chunkId resolves to 0 is not tileable', () => {
  // assertContiguousSegments rejects an empty chunkId, and a segment carrying no
  // identity cannot be deduplicated. Reaching 0 here means the sender combined
  // an absent base with a delta, which is incoherent rather than merely odd.
  const delivery = fromBinaryOutputFrame(outputFrame({
    prologue: { screenSeq: '100', chunkIdBase: '0', authorityRevision: 3, authorityEpochIndex: 0 },
    segments: [
      { byteStart: 0, byteEnd: 11, screenSeqDelta: 0, authorityRevisionDelta: 0, chunkIdDelta: 0 },
    ],
  }));
  assert.equal(delivery.chunks, null);
});

// ---------------------------------------------------------------------------
// 4. The Ordinal64 narrowing.
// ---------------------------------------------------------------------------

test('screenSeq narrows from the wire ordinal to the IR number', () => {
  const delivery = fromBinaryOutputFrame(outputFrame({
    prologue: { screenSeq: '9007199254740991', chunkIdBase: '42', authorityRevision: 3, authorityEpochIndex: 0 },
  }));
  assert.equal(delivery.whole.screenSeq, Number.MAX_SAFE_INTEGER);
});

test('a screenSeq past the safe range is refused, never rounded', () => {
  // The value originates as a JS number (SessionManager.ts:810) and the frame
  // widens it to u64, so this cannot happen from our own server. Rounding it
  // silently would corrupt the dedup key rather than fail visibly.
  assert.throws(
    () => fromBinaryOutputFrame(outputFrame({
      prologue: { screenSeq: '9007199254740993', chunkIdBase: '42', authorityRevision: 3, authorityEpochIndex: 0 },
    })),
    /screenSeq/u,
  );
});

// ---------------------------------------------------------------------------
// 5. What the frame does not carry.
// ---------------------------------------------------------------------------

test('identity the frame cannot carry comes from the caller, or not at all', () => {
  const bare = fromBinaryOutputFrame(outputFrame());
  assert.equal('authorityEpoch' in bare.whole, false);
  assert.equal('replayToken' in bare, false);
  assert.equal('repairToken' in bare, false);

  const supplied = fromBinaryOutputFrame(outputFrame(), {
    authorityEpoch: 'epoch-uuid',
    replayToken: 'replay-1',
    repairToken: 'repair-1',
  });
  assert.equal(supplied.whole.authorityEpoch, 'epoch-uuid');
  assert.equal(supplied.replayToken, 'replay-1');
  assert.equal(supplied.repairToken, 'repair-1');
});

test('a supplied authorityEpoch reaches every segment chunk too', () => {
  const delivery = fromBinaryOutputFrame(
    outputFrame({
      segments: [
        { byteStart: 0, byteEnd: 11, screenSeqDelta: 0, authorityRevisionDelta: 0, chunkIdDelta: 0 },
      ],
    }),
    { authorityEpoch: 'epoch-uuid' },
  );
  assert.equal(delivery.chunks?.[0]?.authorityEpoch, 'epoch-uuid');
});

// ---------------------------------------------------------------------------
// 6. Bytes stay bytes.
// ---------------------------------------------------------------------------

test('the payload is forwarded as bytes and never decoded on construction', () => {
  // Decoding here would reintroduce the exact round trip the binary path exists
  // to remove, and would run on every live frame.
  const delivery = fromBinaryOutputFrame(outputFrame());
  assert.ok(delivery.whole.data instanceof Uint8Array);
  assert.equal((delivery.whole.data as Uint8Array).buffer, BODY.buffer, 'must stay a view');
  assert.equal(delivery.whole.byteLength, BODY.byteLength);
});

test('previewText decodes when called, not when the delivery is built', () => {
  // `typeof previewText === 'function'` proves nothing: a closure over an
  // already-decoded string satisfies it. The observable difference is WHEN the
  // bytes are read — `data` is a view into the caller's buffer, so mutating it
  // after construction changes what a deferred decode returns and cannot change
  // what an eager one captured.
  const mutable = new TextEncoder().encode('before');
  const delivery = fromBinaryOutputFrame(outputFrame({ body: mutable }));
  mutable.set(new TextEncoder().encode('AFTER!'));

  assert.equal(delivery.previewText(), 'AFTER!', 'the decode must happen at call time');
  assert.equal(delivery.previewText(), 'AFTER!', 'repeated calls must agree');
});

test('previewText does not throw on a body that is not valid UTF-8', () => {
  // A live frame can be cut mid-codepoint; a fatal decoder here would turn a
  // debug-capture preview into a thrown error on the output hot path.
  const invalid = new Uint8Array([0x68, 0x69, 0xff]);
  const text = fromBinaryOutputFrame(outputFrame({ body: invalid })).previewText();
  assert.ok(text.startsWith('hi'), 'the valid prefix must survive');
});

test('previewText survives being detached from the delivery', () => {
  // The property type `() => string` also admits a method shorthand, so a
  // `this`-bound implementation would compile and then break at the call site,
  // where TerminalContainer forwards the function unevaluated.
  const { previewText } = fromBinaryOutputFrame(outputFrame());
  assert.equal(previewText(), 'hello world');
});
