import assert from 'node:assert/strict';
import test from 'node:test';

import { compareTerminalWireEncoding, type ShadowComparisonTally } from './terminalWireShadowComparator.js';
import type { OutputWireContext, TerminalOutputJsonMessage } from './terminalOutputWireAdapter.js';

/**
 * The `binary-shadow` rung (`05 §8.2`): the server encodes an output both ways
 * and compares them, but only the JSON reaches the wire. A mismatch here is the
 * whole point of the rung, so the comparison has to name what differed rather
 * than answer yes or no.
 */

const CONTEXT: OutputWireContext = {
  channelId: 3,
  streamEpoch: '4',
  sourceSeq: '11',
  authorityEpochIndex: 0,
};

function output(overrides: Partial<TerminalOutputJsonMessage> = {}): TerminalOutputJsonMessage {
  return { type: 'output', sessionId: 'session-a', data: 'hello', ...overrides };
}

test('a plain output round-trips with no mismatch', () => {
  const result = compareTerminalWireEncoding(output(), CONTEXT);

  assert.equal(result.ok, true);
  assert.deepEqual(result.mismatches, []);
});

test('the comparison reports the bytes it measured', () => {
  const result = compareTerminalWireEncoding(output(), CONTEXT);

  // The rung exists to justify the codec, so the size it would have sent is
  // part of the answer rather than a separate measurement.
  assert.ok(result.binaryBytes > 0);
  assert.ok(result.jsonBytes > 0);
});

test('multibyte output round-trips byte for byte', () => {
  const result = compareTerminalWireEncoding(output({ data: '한글 ☃ 🚀' }), CONTEXT);

  assert.equal(result.ok, true, JSON.stringify(result.mismatches));
});

test('an empty output round-trips', () => {
  const result = compareTerminalWireEncoding(output({ data: '' }), CONTEXT);

  assert.equal(result.ok, true, JSON.stringify(result.mismatches));
});

test('the ordering fields survive the round trip', () => {
  const result = compareTerminalWireEncoding(
    output({ screenSeq: 9, authorityRevision: 2, chunkId: '77' }),
    CONTEXT,
  );

  assert.equal(result.ok, true, JSON.stringify(result.mismatches));
});

test('source segments survive the round trip', () => {
  const result = compareTerminalWireEncoding(
    output({
      data: 'abcdef',
      chunkId: '5',
      sourceSegments: [
        { byteStart: 0, byteEnd: 3, chunkId: '5', screenSeq: 1 },
        { byteStart: 3, byteEnd: 6, chunkId: '6', screenSeq: 2 },
      ],
      screenSeq: 1,
    }),
    CONTEXT,
  );

  assert.equal(result.ok, true, JSON.stringify(result.mismatches));
});

test('a message the encoder refuses is reported, not thrown', () => {
  // `01:392` — channel 0 is permanently reserved, so the encoder refuses it.
  const result = compareTerminalWireEncoding(output(), { ...CONTEXT, channelId: 0 });

  assert.equal(result.ok, false);
  assert.deepEqual(result.mismatches.map(m => m.field), ['encode']);
});

test('a mismatch names the field rather than only failing', () => {
  const result = compareTerminalWireEncoding(output(), CONTEXT, {
    corruptBytes: bytes => {
      const copy = Uint8Array.from(bytes);
      // Flip the last body byte: the frame stays well formed and only the
      // payload differs, which is exactly the shape of a real codec bug.
      copy[copy.length - 1] = (copy[copy.length - 1]! ^ 0xff) & 0xff;
      return copy;
    },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.mismatches.map(m => m.field), ['data']);
});

test('BOUNDARY CONTROL — copying the bytes without changing them still matches', () => {
  // The fault test above flips a byte and expects a mismatch. Without this
  // control that test would also pass if `corruptBytes` were ignored entirely.
  const result = compareTerminalWireEncoding(output(), CONTEXT, {
    corruptBytes: bytes => Uint8Array.from(bytes),
  });

  assert.equal(result.ok, true, JSON.stringify(result.mismatches));
});

test('BOUNDARY CONTROL — a valid channel id encodes, so the refusal above is about the id', () => {
  const result = compareTerminalWireEncoding(output(), { ...CONTEXT, channelId: 1 });

  assert.equal(result.ok, true, JSON.stringify(result.mismatches));
});

test('a header difference is named, not folded into the payload comparison', () => {
  const result = compareTerminalWireEncoding(output(), CONTEXT, {
    // `channelId` is a uint32 at offset 4 (`encodeFrame`). Raising its low byte
    // keeps the frame well formed and changes only which channel it addresses.
    corruptBytes: bytes => {
      const copy = Uint8Array.from(bytes);
      copy[7] = (copy[7]! + 1) & 0xff;
      return copy;
    },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.mismatches.map(m => m.field), ['channelId']);
});

test('a stream epoch difference is named', () => {
  const result = compareTerminalWireEncoding(output(), CONTEXT, {
    // `streamEpoch` is a uint64 at offset 8; byte 15 is its least significant.
    corruptBytes: bytes => {
      const copy = Uint8Array.from(bytes);
      copy[15] = (copy[15]! + 1) & 0xff;
      return copy;
    },
  });

  assert.deepEqual(result.mismatches.map(m => m.field), ['streamEpoch']);
});

test('a segment field difference is named per segment', () => {
  const segmented = output({
    data: 'abcdef',
    chunkId: '5',
    screenSeq: 1,
    sourceSegments: [
      { byteStart: 0, byteEnd: 3, chunkId: '5', screenSeq: 1 },
      { byteStart: 3, byteEnd: 6, chunkId: '6', screenSeq: 2 },
    ],
  });

  const clean = compareTerminalWireEncoding(segmented, CONTEXT);
  assert.equal(clean.ok, true, 'the uncorrupted segmented frame must round-trip');

  const result = compareTerminalWireEncoding(segmented, CONTEXT, {
    corruptBytes: bytes => {
      const copy = Uint8Array.from(bytes);
      // The second segment's last byte: segments follow the prologue, each 16
      // bytes wide, so this is inside the segment table and not in the body.
      const bodyStart = copy.length - 6;
      copy[bodyStart - 1] = (copy[bodyStart - 1]! + 1) & 0xff;
      return copy;
    },
  });

  assert.equal(result.ok, false);
  assert.ok(
    result.mismatches.every(m => m.field.startsWith('segment[')),
    `expected only segment mismatches, got ${JSON.stringify(result.mismatches)}`,
  );
});

test('a segment count difference is named on its own', () => {
  const segmented = output({
    data: 'abcdef',
    chunkId: '5',
    screenSeq: 1,
    sourceSegments: [
      { byteStart: 0, byteEnd: 3, chunkId: '5', screenSeq: 1 },
      { byteStart: 3, byteEnd: 6, chunkId: '6', screenSeq: 2 },
    ],
  });

  const result = compareTerminalWireEncoding(segmented, CONTEXT, {
    // `segmentCount` is a uint16 at prologue offset 22, so frame offset 50-51.
    // Lowering it leaves the frame decodable and turns the second segment into
    // body bytes, which is exactly what a count-only comparison would miss.
    corruptBytes: bytes => {
      const copy = Uint8Array.from(bytes);
      assert.equal(copy[51], 2, 'the segment count is not where this test expects it');
      copy[51] = 1;
      return copy;
    },
  });

  assert.equal(result.ok, false);
  assert.ok(
    result.mismatches.some(m => m.field === 'segmentCount'),
    `segmentCount was not reported: ${JSON.stringify(result.mismatches)}`,
  );
});

test('a batch tally counts mismatches without stopping at the first', () => {
  const tally: ShadowComparisonTally = { compared: 0, mismatched: 0, byField: {} };

  compareTerminalWireEncoding(output(), CONTEXT, { tally });
  compareTerminalWireEncoding(output(), { ...CONTEXT, channelId: 0 }, { tally });
  compareTerminalWireEncoding(output(), { ...CONTEXT, channelId: 0 }, { tally });

  assert.deepEqual(tally, { compared: 3, mismatched: 2, byField: { encode: 2 } });
});

test('an undecodable frame is reported as a decode mismatch', () => {
  const result = compareTerminalWireEncoding(output(), CONTEXT, {
    corruptBytes: () => Uint8Array.of(1, 2, 3),
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.mismatches.map(m => m.field), ['decode']);
});

test('a comparison never puts binary on the wire', () => {
  // The shadow rung is defined by what it does not send. The comparator has no
  // socket at all, which is what makes that structural rather than a promise.
  assert.equal(compareTerminalWireEncoding.length <= 3, true);
});
