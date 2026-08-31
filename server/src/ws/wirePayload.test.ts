import assert from 'node:assert/strict';
import test from 'node:test';

import { DATA_PLANE_OPCODE } from './binaryFrameCodec.js';
import {
  binaryWirePayload,
  encodeFor,
  jsonWirePayload,
  jsonWirePayloadText,
  resolveWireCodec,
  wireOpcodeOf,
  wirePayloadByteLength,
  type SocketCodecBinding,
  type WirePayload,
} from './wirePayload.js';

const BINARY_BINDING: SocketCodecBinding = { codec: 'binary', codecEpoch: 7 };

function neverEncodeBinary(): Uint8Array {
  throw new Error('binary encoder must not run on a JSON socket');
}

function neverEncodeJson(): string {
  throw new Error('JSON encoder must not run for a binary frame');
}

test('jsonWirePayload carries the discriminant and the text', () => {
  const payload = jsonWirePayload('{"type":"output"}');
  assert.equal(payload.codec, 'json');
  assert.equal(payload.codec === 'json' && payload.text, '{"type":"output"}');
});

test('binaryWirePayload carries the discriminant, the bytes and the codecEpoch', () => {
  const bytes = Uint8Array.of(1, 2, 3);
  const payload = binaryWirePayload(bytes, 4);
  assert.equal(payload.codec, 'binary');
  assert.ok(payload.codec === 'binary');
  assert.equal(payload.bytes, bytes);
  assert.equal(payload.codecEpoch, 4);
});

test('binaryWirePayload refuses a codecEpoch that is not a non-negative safe integer', () => {
  const bytes = Uint8Array.of(0);
  assert.throws(() => binaryWirePayload(bytes, -1), RangeError);
  assert.throws(() => binaryWirePayload(bytes, 1.5), RangeError);
  assert.throws(() => binaryWirePayload(bytes, Number.NaN), RangeError);
});

test('jsonWirePayloadText returns the text of a json payload', () => {
  assert.equal(jsonWirePayloadText(jsonWirePayload('{"a":1}')), '{"a":1}');
});

test('jsonWirePayloadText throws rather than stringifying a binary payload', () => {
  assert.throws(() => jsonWirePayloadText(binaryWirePayload(Uint8Array.of(1), 0)), TypeError);
});

test('wirePayloadByteLength measures a JSON payload in utf8 bytes, not code units', () => {
  assert.equal(wirePayloadByteLength(jsonWirePayload('한글')), 6);
});

test('wirePayloadByteLength measures a binary payload by its own byte view', () => {
  const backing = new Uint8Array(10);
  const view = backing.subarray(2, 6);
  assert.equal(wirePayloadByteLength(binaryWirePayload(view, 0)), 4);
});

test('wireOpcodeOf maps a known server-to-client type to its opcode', () => {
  assert.equal(wireOpcodeOf({ type: 'output' }), DATA_PLANE_OPCODE.OUTPUT);
  assert.equal(
    wireOpcodeOf({ type: 'terminal-checkpoint:commit' }),
    DATA_PLANE_OPCODE.CHECKPOINT_COMMIT,
  );
});

test('wireOpcodeOf returns undefined for a control-plane type', () => {
  assert.equal(wireOpcodeOf({ type: 'subscribed' }), undefined);
  assert.equal(wireOpcodeOf({ type: 'terminal-binary:capability' }), undefined);
});

test('wireOpcodeOf returns undefined when the type is absent or not a string', () => {
  assert.equal(wireOpcodeOf({}), undefined);
  assert.equal(wireOpcodeOf({ type: 1 }), undefined);
});

test('wireOpcodeOf does not let a non-string type be coerced into a key', () => {
  // Property lookup stringifies its key, so a `type` that merely *renders* as
  // 'output' would otherwise resolve to the OUTPUT opcode.
  assert.equal(wireOpcodeOf({ type: { toString: () => 'output' } }), undefined);
});

test('wireOpcodeOf does not resolve an Object.prototype member as an opcode', () => {
  assert.equal(wireOpcodeOf({ type: 'toString' }), undefined);
  assert.equal(wireOpcodeOf({ type: 'constructor' }), undefined);
});

test('wireOpcodeOf does not read inherited properties', () => {
  const inherited = Object.create({ type: 'output' }) as object;
  assert.equal(wireOpcodeOf(inherited), undefined);
});

test('resolveWireCodec falls back to JSON when the socket has no binding', () => {
  assert.deepEqual(resolveWireCodec(undefined, { type: 'output' }), { codec: 'json' });
});

test('resolveWireCodec chooses binary for a data-plane message on a bound socket', () => {
  assert.deepEqual(resolveWireCodec(BINARY_BINDING, { type: 'output' }), {
    codec: 'binary',
    opcode: DATA_PLANE_OPCODE.OUTPUT,
    codecEpoch: 7,
  });
});

test('resolveWireCodec keeps the control plane on JSON even on a bound socket', () => {
  assert.deepEqual(resolveWireCodec(BINARY_BINDING, { type: 'subscribed' }), { codec: 'json' });
});

test('encodeFor produces a JSON payload when the socket has no binding', () => {
  const payload = encodeFor({
    binding: undefined,
    message: { type: 'output' },
    encodeJson: () => '{"type":"output"}',
    encodeBinary: neverEncodeBinary,
  });
  assert.deepEqual(payload, { codec: 'json', text: '{"type":"output"}' });
});

test('encodeFor hands the resolved opcode to the binary encoder', () => {
  const seen: number[] = [];
  const payload = encodeFor({
    binding: BINARY_BINDING,
    message: { type: 'screen-snapshot' },
    encodeJson: neverEncodeJson,
    encodeBinary: (_message, opcode) => {
      seen.push(opcode);
      return Uint8Array.of(9);
    },
  });
  assert.deepEqual(seen, [DATA_PLANE_OPCODE.SCREEN_SNAPSHOT]);
  assert.ok(payload.codec === 'binary');
  assert.deepEqual([...payload.bytes], [9]);
});

test('encodeFor stamps the binding codecEpoch onto the binary payload', () => {
  const payload = encodeFor({
    binding: { codec: 'binary', codecEpoch: 12 },
    message: { type: 'output' },
    encodeJson: neverEncodeJson,
    encodeBinary: () => Uint8Array.of(0),
  });
  assert.ok(payload.codec === 'binary');
  assert.equal(payload.codecEpoch, 12);
});

test('encodeFor routes a control message on a bound socket through the JSON encoder', () => {
  const payload = encodeFor({
    binding: BINARY_BINDING,
    message: { type: 'subscribed' },
    encodeJson: () => '{"type":"subscribed"}',
    encodeBinary: neverEncodeBinary,
  });
  assert.deepEqual(payload, { codec: 'json', text: '{"type":"subscribed"}' });
});

test('a binary payload cannot be read as text without narrowing', () => {
  const payload: WirePayload = binaryWirePayload(Uint8Array.of(1), 0);
  // @ts-expect-error `text` exists only on the json branch — this is the invariant of `01:910`.
  const text: string | undefined = payload.text;
  assert.equal(text, undefined);
});

// ---------------------------------------------------------------------------
// An encoder that cannot yet build a frame for this opcode.
// ---------------------------------------------------------------------------

test('encodeFor falls back to JSON when the binary encoder declines', () => {
  const payload = encodeFor({
    binding: BINARY_BINDING,
    message: { type: 'screen-repair' },
    encodeJson: () => '{"type":"screen-repair"}',
    // Opcodes reach the table before their encoders exist; declining must mean
    // "send it as JSON", not "send nothing".
    encodeBinary: () => undefined,
  });
  assert.deepEqual(payload, { codec: 'json', text: '{"type":"screen-repair"}' });
});

test('encodeFor does not call the JSON encoder when the binary encoder succeeds', () => {
  const payload = encodeFor({
    binding: BINARY_BINDING,
    message: { type: 'output' },
    encodeJson: neverEncodeJson,
    encodeBinary: () => Uint8Array.of(5),
  });
  assert.ok(payload.codec === 'binary');
});

test('a declining encoder is asked before the JSON text is built', () => {
  const order: string[] = [];
  encodeFor({
    binding: BINARY_BINDING,
    message: { type: 'output' },
    encodeJson: () => { order.push('json'); return '{}'; },
    encodeBinary: () => { order.push('binary'); return undefined; },
  });
  assert.deepEqual(order, ['binary', 'json']);
});
