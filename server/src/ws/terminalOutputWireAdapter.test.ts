import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { decodeWsMessage, createV1DecodeContext, encodeFrame, parseFrameMessage } from './binaryFrameCodec.js';
import { toBinaryOutputFrame } from './terminalOutputWireAdapter.js';
import type { OutputWireContext, TerminalOutputJsonMessage } from './terminalOutputWireAdapter.js';

/**
 * The server half of the output codec: the JSON message the send path already
 * builds, turned into the wire message `encodeFrame` accepts.
 *
 * This is the mirror of the browser's `fromBinaryOutputFrame`. The two are kept
 * honest by the golden corpus: encoding the JSON equivalent of a vector must
 * reproduce that vector's bytes exactly.
 */

const FIXTURE_URL = new URL('./__fixtures__/binary-frame-vectors.json', import.meta.url);
const fixture = JSON.parse(readFileSync(FIXTURE_URL, 'utf8')) as {
  vectors: { name: string; hexFrame: string; messages: { bodyHex: string }[] }[];
};

function vector(name: string) {
  const found = fixture.vectors.find(v => v.name === name);
  assert.ok(found, `unknown vector ${name}`);
  return found;
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

const CONTEXT: OutputWireContext = {
  channelId: 1,
  streamEpoch: '1',
  sourceSeq: '1',
  authorityEpochIndex: 0,
};

function message(overrides: Partial<TerminalOutputJsonMessage> = {}): TerminalOutputJsonMessage {
  return { type: 'output', sessionId: 'session-a', data: '', ...overrides };
}

// ---------------------------------------------------------------------------
// 1. The golden corpus, encoded from the JSON side.
// ---------------------------------------------------------------------------

test('the minimal vector is reproduced byte for byte from its JSON equivalent', () => {
  const wire = toBinaryOutputFrame(message({ data: '' }), CONTEXT);

  assert.equal(bytesToHex(encodeFrame(wire)), vector('output-minimal-52').hexFrame);
});

test('a multi-byte UTF-8 body is reproduced byte for byte', () => {
  const golden = vector('output-utf8-body-60');
  // 'a' + a Hangul syllable (3 bytes) + an emoji outside the BMP (4 bytes), so
  // any per-character or UTF-16 assumption in the encoder shows up as a length
  // mismatch against the golden bytes.
  const data = Buffer.from(golden.messages[0].bodyHex, 'hex').toString('utf8');

  const wire = toBinaryOutputFrame(message({
    data,
    screenSeq: 300,
    chunkId: '1000',
    authorityRevision: 5,
  }), { channelId: 7, streamEpoch: '2', sourceSeq: '42', authorityEpochIndex: 3 });

  assert.equal(bytesToHex(encodeFrame(wire)), golden.hexFrame);
});

test('the two-segment vector is reproduced byte for byte', () => {
  const golden = vector('output-two-segments-95');

  const wire = toBinaryOutputFrame(message({
    data: 'hello world',
    screenSeq: 10,
    chunkId: '500',
    authorityRevision: 1,
    sourceSegments: [
      { byteStart: 0, byteEnd: 5, screenSeq: 10, authorityRevision: 1, chunkId: '500' },
      { byteStart: 5, byteEnd: 11, screenSeq: 11, authorityRevision: 3, chunkId: '503' },
    ],
  }), { channelId: 2, streamEpoch: '1', sourceSeq: '100', authorityEpochIndex: 0 });

  assert.equal(bytesToHex(encodeFrame(wire)), golden.hexFrame);
});

// ---------------------------------------------------------------------------
// 2. Round trip — what the adapter writes, the decoder must read back.
// ---------------------------------------------------------------------------

test('an encoded frame decodes back to the same wire message', () => {
  const wire = toBinaryOutputFrame(message({
    data: 'abcdef',
    screenSeq: 7,
    chunkId: '42',
    authorityRevision: 3,
  }), CONTEXT);

  const result = decodeWsMessage(encodeFrame(wire), createV1DecodeContext({
    maxBodyBytes: 1 << 20,
    channelState: () => 'active',
  }));

  assert.equal(result.fatal, undefined);
  assert.equal(result.frames.length, 1);
  assert.deepEqual(parseFrameMessage(result.frames[0]), wire);
});

// ---------------------------------------------------------------------------
// 3. The absent-chunkId sentinel.
// ---------------------------------------------------------------------------

test('an absent chunkId becomes the zero sentinel', () => {
  const wire = toBinaryOutputFrame(message({ data: 'x' }), CONTEXT);

  // 0 is never a real chunkId — the generator counts from 1 — so it needs no
  // presence bit of its own.
  assert.equal(wire.prologue.chunkIdBase, '0');
});

test('segment chunkIds without a whole-message chunkId are refused', () => {
  // The browser reads `chunkIdBase === '0'` as absent and then cannot rebuild
  // segment chunkIds at all. Encoding such a message would lose them silently,
  // so it is refused where it can still be seen.
  assert.throws(
    () => toBinaryOutputFrame(message({
      data: 'hello',
      sourceSegments: [{ byteStart: 0, byteEnd: 5, chunkId: '7' }],
    }), CONTEXT),
    /chunkId/i,
  );
});

// ---------------------------------------------------------------------------
// 4. Segment invariants — refused at encode rather than at the far end.
// ---------------------------------------------------------------------------

test('segments that do not cover the body are refused', () => {
  assert.throws(
    () => toBinaryOutputFrame(message({
      data: 'hello world',
      chunkId: '1',
      sourceSegments: [{ byteStart: 0, byteEnd: 5, chunkId: '1' }],
    }), CONTEXT),
    /contiguous|cover/i,
  );
});

test('segments with a gap are refused', () => {
  assert.throws(
    () => toBinaryOutputFrame(message({
      data: 'hello world',
      chunkId: '1',
      sourceSegments: [
        { byteStart: 0, byteEnd: 5, chunkId: '1' },
        { byteStart: 6, byteEnd: 11, chunkId: '2' },
      ],
    }), CONTEXT),
    /contiguous|cover/i,
  );
});

test('a segment ending past the body is refused', () => {
  assert.throws(
    () => toBinaryOutputFrame(message({
      data: 'hi',
      chunkId: '1',
      sourceSegments: [{ byteStart: 0, byteEnd: 99, chunkId: '1' }],
    }), CONTEXT),
    /contiguous|cover/i,
  );
});

test('segment offsets are byte offsets, not character offsets', () => {
  // 'é' is two bytes in UTF-8. A character-indexed segment would cover 2 here
  // and the body length check would reject it, which is the point.
  const wire = toBinaryOutputFrame(message({
    data: 'éx',
    chunkId: '1',
    sourceSegments: [
      { byteStart: 0, byteEnd: 2, chunkId: '1' },
      { byteStart: 2, byteEnd: 3, chunkId: '2' },
    ],
  }), CONTEXT);

  assert.equal(wire.body.byteLength, 3);
  assert.deepEqual(wire.segments.map(s => [s.byteStart, s.byteEnd]), [[0, 2], [2, 3]]);
});

// ---------------------------------------------------------------------------
// 5. Deltas are relative to the prologue.
// ---------------------------------------------------------------------------

test('segment fields are encoded as deltas from the prologue base', () => {
  const wire = toBinaryOutputFrame(message({
    data: 'ab',
    screenSeq: 100,
    chunkId: '1000',
    authorityRevision: 5,
    sourceSegments: [
      { byteStart: 0, byteEnd: 1, screenSeq: 100, authorityRevision: 5, chunkId: '1000' },
      { byteStart: 1, byteEnd: 2, screenSeq: 104, authorityRevision: 9, chunkId: '1007' },
    ],
  }), CONTEXT);

  assert.deepEqual(wire.segments[0], {
    byteStart: 0, byteEnd: 1, screenSeqDelta: 0, authorityRevisionDelta: 0, chunkIdDelta: 0,
  });
  assert.deepEqual(wire.segments[1], {
    byteStart: 1, byteEnd: 2, screenSeqDelta: 4, authorityRevisionDelta: 4, chunkIdDelta: 7,
  });
});

test('a segment omitting screenSeq inherits the prologue value', () => {
  const wire = toBinaryOutputFrame(message({
    data: 'a',
    screenSeq: 12,
    chunkId: '3',
    sourceSegments: [{ byteStart: 0, byteEnd: 1, chunkId: '3' }],
  }), CONTEXT);

  assert.equal(wire.segments[0].screenSeqDelta, 0);
});

test('a segment omitting authorityRevision inherits the prologue value', () => {
  // The symmetric case to screenSeq above. Inheriting 0 instead of the base
  // would encode a delta that reads back as revision 0 on a frame whose
  // prologue says 5, and the browser would treat the segment as older than the
  // message that carries it.
  const wire = toBinaryOutputFrame(message({
    data: 'a',
    screenSeq: 12,
    authorityRevision: 5,
    chunkId: '3',
    sourceSegments: [{ byteStart: 0, byteEnd: 1, chunkId: '3' }],
  }), CONTEXT);

  assert.equal(wire.prologue.authorityRevision, 5);
  assert.equal(wire.segments[0].authorityRevisionDelta, 0);
});

test('a segment preceding the prologue base is refused', () => {
  // Deltas are unsigned on the wire, so a negative one would wrap into a huge
  // positive value and silently reorder the stream.
  assert.throws(
    () => toBinaryOutputFrame(message({
      data: 'a',
      screenSeq: 12,
      chunkId: '3',
      sourceSegments: [{ byteStart: 0, byteEnd: 1, screenSeq: 11, chunkId: '3' }],
    }), CONTEXT),
    /delta|negative/i,
  );
});

// ---------------------------------------------------------------------------
// 6. The header comes from the caller, not from the message.
// ---------------------------------------------------------------------------

test('the frame header is taken from the channel context', () => {
  const wire = toBinaryOutputFrame(message({ data: 'a' }), {
    channelId: 9,
    streamEpoch: '4',
    sourceSeq: '77',
    authorityEpochIndex: 3,
  });

  assert.equal(wire.channelId, 9);
  assert.equal(wire.streamEpoch, '4');
  assert.equal(wire.sourceSeq, '77');
  assert.equal(wire.prologue.authorityEpochIndex, 3);
});

test('channelId 0 is refused', () => {
  // Permanently reserved: a zero-filled buffer must never look like a frame.
  assert.throws(
    () => toBinaryOutputFrame(message({ data: 'a' }), { ...CONTEXT, channelId: 0 }),
    /channelId/i,
  );
});
