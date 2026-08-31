import assert from 'node:assert/strict';
import { test } from 'node:test';

import { classifyWsFrame } from '../../src/utils/wsFrameDispatch.ts';

/**
 * S4-C5b — the one place that decides "is this message JSON or binary".
 *
 * The branch shape is fixed by `08:128-134` and `03:108-113`:
 *
 *   ArrayBuffer          → binary
 *   not a string         → explicit rejection + record   (this is the Blob arm)
 *   string               → JSON
 *
 * The middle arm exists because a Blob cannot be read synchronously — there is
 * no way to get its bytes without `await blob.arrayBuffer()`, so a synchronous
 * message handler can only refuse it. `03:113` records that an earlier draft
 * collapsed the first two arms and thereby handed Blobs to a sync parser.
 *
 * This module is separate from `WebSocketContext.tsx` because the unit runner
 * (`node --experimental-strip-types`) strips types but cannot compile JSX, so a
 * test can never import the context. Keeping the decision here also keeps it to
 * a single entry point rather than one copy per socket.
 */

const encoder = new TextEncoder();

function bufferOf(bytes: number[] | Uint8Array): ArrayBuffer {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  // A fresh, exactly-sized buffer — `view.buffer` may be larger than the view.
  return view.slice().buffer;
}

// ---------------------------------------------------------------------------
// 1. The binary arm.
// ---------------------------------------------------------------------------

test('an ArrayBuffer is classified as binary', () => {
  const buffer = bufferOf([0x01, 0x00, 0x00, 0x1c]);
  const frame = classifyWsFrame(buffer);

  assert.equal(frame.kind, 'binary');
  assert.equal(frame.kind === 'binary' && frame.buffer, buffer, 'the buffer must be forwarded, not copied');
});

test('an ArrayBuffer whose bytes are valid JSON text is still binary', () => {
  // This is the test the whole step exists for. `JSON.parse` accepts a
  // Buffer-like via coercion, so "it happened to parse" is not evidence the
  // branch worked — only a payload that WOULD parse proves the branch ran
  // first. A frame's opcode byte can be any value, including one that starts a
  // JSON document.
  const buffer = bufferOf(encoder.encode('{"type":"output","sessionId":"s"}'));
  const frame = classifyWsFrame(buffer);

  assert.equal(frame.kind, 'binary');
  assert.equal('message' in frame, false, 'the bytes must not have been parsed');
});

test('an ArrayBuffer that is not valid UTF-8 is binary, not a decode failure', () => {
  // A real frame header is mostly non-textual bytes. Reaching a text path at
  // all would surface as a spurious "malformed" rather than as binary.
  const frame = classifyWsFrame(bufferOf([0xff, 0xfe, 0x00, 0x80]));
  assert.equal(frame.kind, 'binary');
});

test('an empty ArrayBuffer is binary, not unsupported', () => {
  // A zero-length message is a protocol violation the codec reports, not a
  // classification failure. Deciding it here would put the same judgement in
  // two layers and let them disagree.
  const frame = classifyWsFrame(new ArrayBuffer(0));
  assert.equal(frame.kind, 'binary');
});

// ---------------------------------------------------------------------------
// 2. The rejection arm — Blob and anything else that is not a string.
// ---------------------------------------------------------------------------

test('a Blob is refused explicitly and names itself in the record', () => {
  // `binaryType` left at its 'blob' default is a misconfiguration that must
  // show up at runtime. Silently returning would hide it (03:113).
  const frame = classifyWsFrame(new Blob([new Uint8Array([1, 2, 3])]));

  assert.equal(frame.kind, 'unsupported');
  assert.equal(frame.kind === 'unsupported' && frame.frameType, 'Blob');
});

test('a Uint8Array is refused, because a socket never delivers one', () => {
  // `instanceof ArrayBuffer` is false for a view. Broadening the check to
  // `ArrayBuffer.isView` would accept a shape the WebSocket API cannot produce
  // and would then read `.buffer`, which may be larger than the view.
  const frame = classifyWsFrame(new Uint8Array([1, 2, 3]));

  assert.equal(frame.kind, 'unsupported');
  assert.equal(frame.kind === 'unsupported' && frame.frameType, 'Uint8Array');
});

test('null and undefined are refused without throwing', () => {
  const forNull = classifyWsFrame(null);
  assert.equal(forNull.kind, 'unsupported');
  assert.equal(forNull.kind === 'unsupported' && forNull.frameType, 'null');

  const forUndefined = classifyWsFrame(undefined);
  assert.equal(forUndefined.kind, 'unsupported');
  assert.equal(forUndefined.kind === 'unsupported' && forUndefined.frameType, 'undefined');
});

test('an object with no prototype is refused without throwing', () => {
  // `data.constructor.name` throws on a null-prototype object, and this runs on
  // every inbound message.
  const frame = classifyWsFrame(Object.create(null));
  assert.equal(frame.kind, 'unsupported');
  assert.equal(frame.kind === 'unsupported' && frame.frameType, 'object');
});

// ---------------------------------------------------------------------------
// 3. The JSON arm — unchanged behaviour, now observable.
// ---------------------------------------------------------------------------

test('a JSON string parses to the same value the old inline parse produced', () => {
  const text = '{"type":"output","sessionId":"s","data":"hi","screenSeq":7}';
  const frame = classifyWsFrame(text);

  assert.equal(frame.kind, 'json');
  assert.deepEqual(frame.kind === 'json' && frame.message, JSON.parse(text));
});

test('a JSON string carrying a non-object value still parses', () => {
  // The old path parsed first and type-checked later; narrowing here would
  // change which messages reach the type guards.
  assert.deepEqual(classifyWsFrame('42'), { kind: 'json', message: 42 });
  assert.deepEqual(classifyWsFrame('null'), { kind: 'json', message: null });
});

test('a malformed JSON string is reported, not silently dropped', () => {
  // Today `WebSocketContext.tsx:694-696` is `catch { return; }` — a parse
  // failure leaves no trace at all. The caller can only record what it is told
  // about, so the failure has to be a value rather than an early return.
  const frame = classifyWsFrame('{"type":');

  assert.equal(frame.kind, 'malformed-json');
  assert.equal(frame.kind === 'malformed-json' && frame.textLength, 8);
});

test('an empty string is malformed, not an empty message', () => {
  const frame = classifyWsFrame('');
  assert.equal(frame.kind, 'malformed-json');
  assert.equal(frame.kind === 'malformed-json' && frame.textLength, 0);
});

// ---------------------------------------------------------------------------
// 4. Arm order — the property that a merged branch would break.
// ---------------------------------------------------------------------------

test('the ArrayBuffer check runs before the non-string rejection', () => {
  // An ArrayBuffer is also `typeof !== 'string'`. If the arms were reordered —
  // the exact mistake `03:113` records from the draft — every binary frame
  // would be rejected as unsupported and the data plane would carry nothing.
  assert.equal(classifyWsFrame(new ArrayBuffer(4)).kind, 'binary');
});

test('the string check does not run before the ArrayBuffer check', () => {
  // The mirror mutant: coercing to string first would turn every frame into
  // "[object ArrayBuffer]" and then into malformed JSON.
  //
  // Asserted positively rather than as a pair of `notEqual`s. Both the
  // arm-deleted and the arm-swapped mutant yield 'unsupported', which satisfies
  // "not json" and "not malformed-json" while being just as wrong — so the
  // negative form let two of the three mutants this test names walk away.
  const frame = classifyWsFrame(bufferOf(encoder.encode('"text"')));
  assert.equal(frame.kind, 'binary');
});

// ---------------------------------------------------------------------------
// 5. The classifier is total and side-effect free.
// ---------------------------------------------------------------------------

test('every arm returns a value and none of them throws', () => {
  const inputs: unknown[] = [
    new ArrayBuffer(0),
    new ArrayBuffer(28),
    'null',
    '{',
    '',
    new Blob([]),
    new Uint8Array(1),
    new DataView(new ArrayBuffer(1)),
    null,
    undefined,
    42,
    Symbol('x'),
    { data: 1 },
    [],
  ];

  const kinds = new Set<string>();
  for (const input of inputs) {
    const frame = classifyWsFrame(input);
    assert.ok(
      frame.kind === 'binary'
      || frame.kind === 'json'
      || frame.kind === 'malformed-json'
      || frame.kind === 'unsupported',
      `unexpected kind for ${String(frame.kind)}`,
    );
    kinds.add(frame.kind);
  }

  assert.deepEqual(
    [...kinds].sort(),
    ['binary', 'json', 'malformed-json', 'unsupported'],
    'the corpus must exercise all four arms, or this test proves nothing',
  );
});

test('classifying the same buffer twice yields the same result', () => {
  // The classifier must not consume or advance anything — the caller decodes
  // the buffer afterwards.
  const buffer = bufferOf([0x01, 0x02]);
  assert.deepEqual(classifyWsFrame(buffer), classifyWsFrame(buffer));
  assert.equal(buffer.byteLength, 2, 'the input must be untouched');
});
