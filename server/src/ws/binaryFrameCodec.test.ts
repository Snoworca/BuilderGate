import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { ptySchema } from '../schemas/config.schema.js';
import {
  ACTIVE_FLAG_MASK_V1,
  CLIENT_TO_SERVER_OPCODE_BY_TYPE,
  DATA_PLANE_OPCODE,
  DECODER_POLICY_CODES,
  FLAG_END_OF_BATCH,
  FLAG_PAYLOAD_UTF8_TEXT,
  FLAG_PROLOGUE_PRESENT,
  FRAME_HEADER_BYTES,
  FRAME_VERSION_V1,
  MANDATORY_FLAGS,
  NEGOTIABLE_FLAGS_V1,
  OPCODE_JSON_ENVELOPE,
  SEGMENT_BYTES,
  SERVER_TO_CLIENT_OPCODE_BY_TYPE,
  WIRE_REJECTION_CODES,
  createV1DecodeContext,
  decodeWsMessage,
  defaultFlagsForOpcode,
  deriveMaxBodyBytes,
  encodeBatch,
  encodeFrame,
  frameByteLength,
  isKnownOpcode,
  opcodeSpace,
  parseFrameMessage,
  prologueBytes,
  rejectionGrade,
  RESPONDER_LEASE_ID_MAX_BYTES,
  type BinaryDecodeContext,
  type BinaryWireMessage,
  type CheckpointStartPrologue,
  type ChannelState,
  type DecodedFrame,
} from './binaryFrameCodec.js';

// ---------------------------------------------------------------------------
// Fixture loading. The fixture is the SSOT (06 S2-a / 05:452) — the frontend
// codec test in S4 reads THIS file, it is never copied.
// ---------------------------------------------------------------------------

const FIXTURE_URL = new URL('./__fixtures__/binary-frame-vectors.json', import.meta.url);

interface LayoutRow extends Array<unknown> {
  0: number;
  1: string;
  2: string;
}

interface VectorFixture {
  name: string;
  note?: string;
  byteLength: number;
  layout: LayoutRow[];
  hexFrame: string;
  messages: Record<string, unknown>[];
}

interface DerivedFrom {
  vector?: string;
  fault?: string;
  patch?: Array<[number, string, string?]>;
  bodyFill?: { byteValue: number; count: number };
  truncateTo?: number;
  zeroFill?: boolean;
}

/**
 * What an accepted frame must decode to. Two forms:
 *   reference  `vector` (+ `index`) — the frame must decode to that golden
 *              message. `bodyByteLength` overrides it when the fault patched
 *              the body length. The expected side is hand-written fixture data
 *              that the layout self-audit already proved, so it never shares an
 *              origin with the decoder output it is compared against (05:450).
 *   literal    `payloadHex` + `prologue: null` — for a known opcode with no v1
 *              prologue schema, which stays opaque.
 */
interface DecodedExpectation {
  vector?: string;
  index?: number;
  bodyByteLength?: number;
  opcode?: number;
  flags?: number;
  channelId?: number;
  streamEpoch?: string;
  sourceSeq?: string;
  payloadHex?: string;
  prologue?: null;
}

interface FaultFixture {
  name: string;
  faultId: string;
  role: 'fault' | 'control';
  note?: string;
  byteLength?: number;
  layout?: LayoutRow[];
  hexFrame?: string;
  utf8Text?: string;
  derivedFrom?: DerivedFrom;
  context?: { codec?: 'json' | 'binary' };
  expect: {
    frames: number;
    fatal: string | null;
    detail?: string;
    scoped?: Array<{ code: string; channelId: number }>;
    diagnostics?: Array<{ event: string; channelId: number }>;
    decoded?: DecodedExpectation[];
  };
}

interface Fixture {
  $rules: Record<string, unknown>;
  defaultContext: {
    codec: 'json' | 'binary';
    frameVersion: number;
    activeFlagMask: number;
    channels: Record<string, ChannelState>;
  };
  vectors: VectorFixture[];
  faults: FaultFixture[];
}

const fixture = JSON.parse(readFileSync(FIXTURE_URL, 'utf8')) as Fixture;

function hexToBytes(hex: string): Uint8Array {
  assert.equal(hex.length % 2, 0, `hex string must have an even length: ${hex.slice(0, 32)}…`);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    assert.ok(Number.isInteger(byte), `non-hex digit at byte ${i}`);
    out[i] = byte;
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

function vectorByName(name: string): VectorFixture {
  const found = fixture.vectors.find((v) => v.name === name);
  assert.ok(found, `unknown vector ${name}`);
  return found;
}

function faultByName(name: string): FaultFixture {
  const found = fixture.faults.find((f) => f.name === name);
  assert.ok(found, `unknown fault ${name}`);
  return found;
}

/**
 * Rebuilds a fault buffer from its hand-computed base vector plus the declared
 * patch. Only the patched bytes are hand-written per fault; the base bytes are
 * the layout-verified golden vector.
 */
function buildFaultBuffer(entry: FaultFixture): Uint8Array {
  if (entry.utf8Text !== undefined) return new Uint8Array(Buffer.from(entry.utf8Text, 'utf8'));

  const derived = entry.derivedFrom;
  let base: Uint8Array;
  if (derived?.vector !== undefined) base = hexToBytes(vectorByName(derived.vector).hexFrame);
  else if (derived?.fault !== undefined) {
    const parent = faultByName(derived.fault);
    assert.ok(parent.hexFrame, `parent fault ${parent.name} has no literal hexFrame`);
    base = hexToBytes(parent.hexFrame);
  } else {
    assert.ok(entry.hexFrame, `fault ${entry.name} has neither derivedFrom nor hexFrame`);
    base = hexToBytes(entry.hexFrame);
  }

  const bytes = new Uint8Array(base);
  if (derived?.zeroFill) bytes.fill(0);
  for (const [offset, hex] of derived?.patch ?? []) {
    const patch = hexToBytes(hex);
    assert.ok(offset + patch.length <= bytes.length, `patch out of range in ${entry.name}`);
    bytes.set(patch, offset);
  }

  let out = bytes;
  if (derived?.truncateTo !== undefined) out = out.slice(0, derived.truncateTo);
  if (derived?.bodyFill !== undefined) {
    const filled = new Uint8Array(out.length + derived.bodyFill.count);
    filled.set(out, 0);
    filled.fill(derived.bodyFill.byteValue, out.length);
    out = filled;
  }
  return out;
}

const MAX_BODY_BYTES = deriveMaxBodyBytes(ptySchema.parse({}));

function buildContext(entry?: FaultFixture): BinaryDecodeContext {
  const channels = fixture.defaultContext.channels;
  return createV1DecodeContext({
    codec: entry?.context?.codec ?? fixture.defaultContext.codec,
    maxBodyBytes: MAX_BODY_BYTES,
    channelState: (channelId: number) => channels[String(channelId)],
  });
}

function toWireMessage(raw: Record<string, any>): BinaryWireMessage {
  const body = hexToBytes(String(raw.bodyHex ?? ''));
  const head = {
    flags: raw.flags as number,
    channelId: raw.channelId as number,
    streamEpoch: raw.streamEpoch as string,
    sourceSeq: raw.sourceSeq as string,
  };
  if (raw.opcode === DATA_PLANE_OPCODE.OUTPUT) {
    return { opcode: DATA_PLANE_OPCODE.OUTPUT, ...head, prologue: raw.prologue, segments: raw.segments ?? [], body };
  }
  if (raw.opcode === DATA_PLANE_OPCODE.SCREEN_SNAPSHOT) {
    return { opcode: DATA_PLANE_OPCODE.SCREEN_SNAPSHOT, ...head, prologue: raw.prologue, body };
  }
  if (raw.opcode === DATA_PLANE_OPCODE.CHECKPOINT_START) {
    // The two 32-byte digests live in the fixture as hex so the file stays
    // reviewable byte-for-byte against its own `layout` rows.
    const { digestHex, retainedStateDigestHex, ...rest } = raw.prologue as Record<string, any>;
    return {
      opcode: DATA_PLANE_OPCODE.CHECKPOINT_START,
      ...head,
      prologue: {
        ...rest,
        digest: hexToBytes(String(digestHex)),
        retainedStateDigest: hexToBytes(String(retainedStateDigestHex)),
      } as CheckpointStartPrologue,
      body,
    };
  }
  if (raw.opcode === DATA_PLANE_OPCODE.CHECKPOINT_CHUNK) {
    return { opcode: DATA_PLANE_OPCODE.CHECKPOINT_CHUNK, ...head, prologue: raw.prologue, body };
  }
  throw new Error(`fixture message uses opcode ${raw.opcode} which has no v1 prologue schema`);
}

// ---------------------------------------------------------------------------
// 0. The fixture is self-auditing: the per-byte derivation must reproduce the
//    hexFrame. This is what makes "hand computed" checkable by a reviewer.
// ---------------------------------------------------------------------------

test('S2-a golden vector layouts are contiguous and reproduce their hexFrame', () => {
  const withLayout = [...fixture.vectors, ...fixture.faults.filter((f) => f.layout)];
  assert.ok(withLayout.length >= 8, 'expected at least 8 layout-carrying entries');

  for (const entry of withLayout) {
    const layout = entry.layout as LayoutRow[];
    let offset = 0;
    for (const [rowOffset, hex] of layout) {
      assert.equal(rowOffset, offset, `${entry.name}: layout offset gap at ${rowOffset}`);
      offset += hex.length / 2;
    }
    const joined = layout.map((row) => row[1]).join('');
    assert.equal(joined, (entry as VectorFixture).hexFrame, `${entry.name}: layout != hexFrame`);
    assert.equal(offset, (entry as VectorFixture).byteLength, `${entry.name}: byteLength mismatch`);
  }
});

test('S2-a fixture covers every wire fault id plus the P7 prologue boundary', () => {
  const ids = new Set(fixture.faults.map((f) => f.faultId));
  // F6 is an encode-time rejection (Ordinal64 range) and produces no wire bytes,
  // so it has no fixture entry; it is covered by the dedicated encoder test below.
  for (const id of ['F1', 'F2', 'F3', 'F4', 'F5', 'F7', 'F8', 'F9', 'F10', 'F11']) {
    assert.ok(ids.has(id), `fault id ${id} missing from fixture`);
  }
  assert.ok(!ids.has('F6'), 'F6 is encode-side; it must not claim a wire fixture entry');
  assert.ok(ids.has('P7'), 'P7 prologue boundary missing from fixture');
  assert.ok(ids.has('P8'), 'P8 empty-message boundary missing from fixture');

  // Every fault id must carry at least one fault AND at least one boundary control.
  // A fault case with no control is exactly the "we measured something else" trap.
  for (const id of ids) {
    const group = fixture.faults.filter((f) => f.faultId === id);
    assert.ok(group.some((f) => f.role === 'fault'), `${id} has no fault case`);
    assert.ok(group.some((f) => f.role === 'control'), `${id} has no boundary control`);
  }
});

// ---------------------------------------------------------------------------
// 1. Golden vectors — encode and decode measured against the hand-written hex,
//    not against each other.
// ---------------------------------------------------------------------------

test('S2-a encode(message) equals the hand-computed hexFrame for every golden vector', () => {
  for (const vector of fixture.vectors) {
    const messages = vector.messages.map(toWireMessage);
    const encoded = encodeBatch(messages);
    assert.equal(bytesToHex(encoded), vector.hexFrame, `${vector.name}: encoder output != golden hex`);
    assert.equal(encoded.byteLength, vector.byteLength, `${vector.name}: byte length`);
  }
});

test('S2-a decode(hexFrame) reproduces the golden message for every vector', () => {
  let observedOutputFrames = 0;

  for (const vector of fixture.vectors) {
    const bytes = hexToBytes(vector.hexFrame);
    const result = decodeWsMessage(bytes, buildContext());
    assert.equal(result.fatal, undefined, `${vector.name}: unexpected fatal ${result.fatal?.code}`);
    assert.deepEqual(result.scoped, [], `${vector.name}: unexpected scoped rejections`);
    assert.equal(result.frames.length, vector.messages.length, `${vector.name}: frame count`);

    const decoded = result.frames.map((frame) => {
      if (frame.opcode === DATA_PLANE_OPCODE.OUTPUT) observedOutputFrames += 1;
      return parseFrameMessage(frame);
    });
    assert.deepEqual(decoded, vector.messages.map(toWireMessage), `${vector.name}: round-trip`);
  }

  // 05:479-481 — the only structural defence against a vacuous green.
  assert.ok(observedOutputFrames > 0, 'no OUTPUT frame was ever decoded');
});

test('P2 frame size is 28 + prologueBytes + 16*segmentCount + bodyBytes', () => {
  for (const vector of fixture.vectors) {
    for (const raw of vector.messages) {
      const message = toWireMessage(raw);
      const segments = 'segments' in message ? message.segments.length : 0;
      const expected =
        FRAME_HEADER_BYTES + prologueBytes(message.opcode) + SEGMENT_BYTES * segments + message.body.byteLength;
      assert.equal(encodeFrame(message).byteLength, expected, `${vector.name}: P2`);
      assert.equal(frameByteLength(message), expected, `${vector.name}: frameByteLength`);
    }
  }
});

test('P3 decode does not mutate the input buffer and returns views into it', () => {
  const vector = vectorByName('output-two-segments-95');
  const bytes = hexToBytes(vector.hexFrame);
  const before = bytesToHex(bytes);

  const result = decodeWsMessage(bytes, buildContext());

  assert.equal(bytesToHex(bytes), before, 'decode mutated the input buffer');
  assert.equal(result.frames.length, 1);
  assert.equal(result.frames[0]!.payload.buffer, bytes.buffer, 'payload must be a view, not a copy');
});

test('P4 a two-frame batch decodes into exactly two frames with END_OF_BATCH on the last only', () => {
  const vector = vectorByName('batch-two-output-frames-106');
  const result = decodeWsMessage(hexToBytes(vector.hexFrame), buildContext());

  assert.equal(result.fatal, undefined);
  assert.equal(result.frames.length, 2);
  assert.equal(result.frames[0]!.flags & FLAG_END_OF_BATCH, 0, 'first frame must not carry END_OF_BATCH');
  assert.notEqual(result.frames[1]!.flags & FLAG_END_OF_BATCH, 0, 'last frame must carry END_OF_BATCH');
  assert.equal(result.frames[0]!.sourceSeq, '1');
  assert.equal(result.frames[1]!.sourceSeq, '2');
});

test('P5 u64 ordinals survive the round-trip at 2^53, 2^53+1 and 2^64-1', () => {
  const vector = vectorByName('output-ordinal-extremes-52');
  const result = decodeWsMessage(hexToBytes(vector.hexFrame), buildContext());
  const message = parseFrameMessage(result.frames[0]!);

  assert.equal(result.frames[0]!.streamEpoch, '9007199254740992');
  assert.equal(result.frames[0]!.sourceSeq, '18446744073709551615');
  assert.ok(message && message.opcode === DATA_PLANE_OPCODE.OUTPUT);
  assert.equal(message.prologue.chunkIdBase, '9007199254740993');
  assert.equal(message.prologue.screenSeq, '18446744073709551615');
});

/** IR-BGSTAB-001 AC-2, verbatim: 0, 1, 2^53-1, 2^53, 2^63, 2^64-1. */
const AC2_ORDINAL_BOUNDARIES = [
  '0',
  '1',
  '9007199254740991',
  '9007199254740992',
  '9223372036854775808',
  '18446744073709551615',
] as const;

test('IR-BGSTAB-001 AC-2 every mandated Ordinal64 boundary is carried by a golden vector', () => {
  const decodedOrdinals = new Set<string>();

  for (const vector of fixture.vectors) {
    const result = decodeWsMessage(hexToBytes(vector.hexFrame), buildContext());
    assert.equal(result.fatal, undefined, `${vector.name}: unexpected fatal ${result.fatal?.code}`);
    for (const frame of result.frames) {
      decodedOrdinals.add(frame.streamEpoch);
      decodedOrdinals.add(frame.sourceSeq);
      const message = parseFrameMessage(frame);
      if (message?.opcode === DATA_PLANE_OPCODE.OUTPUT) {
        decodedOrdinals.add(message.prologue.screenSeq);
        decodedOrdinals.add(message.prologue.chunkIdBase);
      }
      if (message?.opcode === DATA_PLANE_OPCODE.SCREEN_SNAPSHOT) decodedOrdinals.add(message.prologue.seq);
    }
  }

  // The expected side is the AC text; the observed side is decoder output. The
  // two never touch, so this cannot go vacuously green (05:450).
  for (const boundary of AC2_ORDINAL_BOUNDARIES) {
    assert.ok(decodedOrdinals.has(boundary), `AC-2 boundary ${boundary} is proved by no golden vector`);
  }
});

test('AC-2 the signed/unsigned flip point round-trips: 2^53-1 and 2^63', () => {
  const vector = vectorByName('output-ordinal-signed-boundary-52');
  const result = decodeWsMessage(hexToBytes(vector.hexFrame), buildContext());
  const frame = result.frames[0]!;
  const message = parseFrameMessage(frame);

  assert.equal(frame.streamEpoch, '9007199254740991');
  assert.equal(frame.sourceSeq, '9223372036854775808');
  assert.ok(message && message.opcode === DATA_PLANE_OPCODE.OUTPUT);
  assert.equal(message.prologue.screenSeq, '9223372036854775808');
  assert.equal(message.prologue.chunkIdBase, '9007199254740991');

  // A signed 64-bit read surfaces as a negative decimal at 2^63 and above.
  for (const value of [frame.streamEpoch, frame.sourceSeq, message.prologue.screenSeq]) {
    assert.ok(!value.startsWith('-'), `Ordinal64 is unsigned, got ${value}`);
  }
});

test('M-4 readOrdinal64 is probed on both sides of its fast/slow branch', () => {
  const vector = vectorByName('output-ordinal-fastpath-boundary-52');
  const result = decodeWsMessage(hexToBytes(vector.hexFrame), buildContext());
  const frame = result.frames[0]!;
  const message = parseFrameMessage(frame);

  assert.equal(frame.streamEpoch, '2147483648', '2^31 — fast path, int32 would read it negative');
  assert.equal(frame.sourceSeq, '4294967295', '2^32-1 — largest fast-path value');
  assert.ok(message && message.opcode === DATA_PLANE_OPCODE.OUTPUT);
  assert.equal(message.prologue.screenSeq, '4294967296', '2^32 — first value that must take the BigInt path');
  assert.equal(message.prologue.chunkIdBase, '2147483647', '2^31-1 — last value int32 and uint32 agree on');
});

test('P6 multi-byte UTF-8 body bytes survive the round-trip unchanged', () => {
  const vector = vectorByName('output-utf8-body-60');
  const result = decodeWsMessage(hexToBytes(vector.hexFrame), buildContext());
  const message = parseFrameMessage(result.frames[0]!);

  assert.ok(message);
  assert.equal(Buffer.from(message.body).toString('utf8'), 'a한😀');
  assert.equal(message.body.byteLength, 8);
});

test('encodeBatch sets no flags of its own — the last message must already carry END_OF_BATCH', () => {
  const [first, last] = vectorByName('batch-two-output-frames-106').messages.map(toWireMessage);

  assert.throws(() => encodeBatch([last!, first!]), /END_OF_BATCH/i, 'EOB on a non-last frame must be rejected');
  assert.throws(() => encodeBatch([first!, first!]), /END_OF_BATCH/i, 'missing EOB on the last frame must be rejected');
  assert.throws(() => encodeBatch([]), /empty/i);
});

// ---------------------------------------------------------------------------
// 2. Fault table F1..F11 + P7, each with its boundary control.
// ---------------------------------------------------------------------------

for (const entry of fixture.faults) {
  test(`${entry.faultId} ${entry.role} — ${entry.name}`, () => {
    const bytes = buildFaultBuffer(entry);
    const result = decodeWsMessage(bytes, buildContext(entry));

    assert.equal(result.frames.length, entry.expect.frames, `${entry.name}: frame count`);

    if (entry.expect.fatal === null) {
      assert.equal(result.fatal, undefined, `${entry.name}: expected acceptance, got ${result.fatal?.code}`);
    } else {
      assert.ok(result.fatal, `${entry.name}: expected fatal ${entry.expect.fatal}, got none`);
      assert.equal(result.fatal.code, entry.expect.fatal, `${entry.name}: rejection code`);
      assert.equal(result.fatal.grade, 'fatal');
      if (entry.expect.detail !== undefined) {
        assert.equal(result.fatal.detail, entry.expect.detail, `${entry.name}: diagnostic metadata`);
      }
    }

    assert.deepEqual(
      result.scoped.map((r) => ({ code: r.code, channelId: r.channelId })),
      entry.expect.scoped ?? [],
      `${entry.name}: scoped rejections`,
    );
    assert.deepEqual(
      result.diagnostics.map((d) => ({ event: d.event, channelId: d.channelId })),
      entry.expect.diagnostics ?? [],
      `${entry.name}: diagnostics`,
    );

    assertDecodedFrames(entry, result.frames);
  });
}

/**
 * L-3 — a count plus "no fatal" does not pin an accepted frame. Every patched
 * variant here (F5's three points, F2-control-exact-152, F4-control-exact, and
 * the two F11 batch controls where the SURVIVING frame's identity is the whole
 * claim) would pass those two assertions even if the decoder read the fields
 * wrong or truncated the payload. So an accepted frame must say what it decodes
 * to, and the fixture is not allowed to stay silent about one.
 */
function assertDecodedFrames(entry: FaultFixture, frames: DecodedFrame[]): void {
  if (entry.expect.frames === 0) return;

  const expectations = entry.expect.decoded;
  assert.ok(expectations, `${entry.name}: an accepted frame must declare expect.decoded`);
  assert.equal(expectations.length, entry.expect.frames, `${entry.name}: expect.decoded length`);

  frames.forEach((frame, index) => {
    const want = expectations[index]!;
    const label = `${entry.name}[${index}]`;
    const golden = want.vector === undefined ? undefined : toWireMessage(vectorByName(want.vector).messages[want.index ?? 0]!);

    assert.equal(frame.opcode, want.opcode ?? golden?.opcode, `${label}: opcode`);
    assert.equal(frame.flags, want.flags ?? golden?.flags, `${label}: flags`);
    assert.equal(frame.channelId, want.channelId ?? golden?.channelId, `${label}: channelId`);
    assert.equal(frame.streamEpoch, want.streamEpoch ?? golden?.streamEpoch, `${label}: streamEpoch`);
    assert.equal(frame.sourceSeq, want.sourceSeq ?? golden?.sourceSeq, `${label}: sourceSeq`);

    const message = parseFrameMessage(frame);

    if (want.prologue === null) {
      assert.equal(message, undefined, `${label}: opcode has no v1 prologue schema, so it must stay opaque`);
      assert.equal(bytesToHex(frame.payload), want.payloadHex, `${label}: opaque payload`);
      return;
    }

    assert.ok(golden, `${label}: expect.decoded needs either a vector reference or prologue: null`);
    assert.ok(message, `${label}: frame did not parse`);
    assert.deepEqual(message.prologue, golden.prologue, `${label}: prologue`);
    assert.equal(
      'segments' in message ? message.segments.length : 0,
      'segments' in golden ? golden.segments.length : 0,
      `${label}: segmentCount`,
    );
    assert.equal(
      message.body.byteLength,
      want.bodyByteLength ?? golden.body.byteLength,
      `${label}: bodyByteLength`,
    );
    assert.equal(
      frame.payload.byteLength,
      prologueBytes(frame.opcode) +
        SEGMENT_BYTES * ('segments' in message ? message.segments.length : 0) +
        message.body.byteLength,
      `${label}: payload must be exactly prologue + segments + body`,
    );
  });
}

test('F2 and F4 do not converge on one rejection code', () => {
  const overrun = decodeWsMessage(buildFaultBuffer(faultByName('F2-fault-length-overrun-142')), buildContext());
  const surplus = decodeWsMessage(buildFaultBuffer(faultByName('F2-control-surplus-153')), buildContext());
  const minusOne = decodeWsMessage(buildFaultBuffer(faultByName('F4-fault-declared-minus-one')), buildContext());
  const plusOne = decodeWsMessage(buildFaultBuffer(faultByName('F4-fault-declared-plus-one')), buildContext());

  assert.equal(overrun.fatal?.code, 'length-overrun');
  assert.equal(plusOne.fatal?.code, 'length-overrun');
  assert.equal(surplus.fatal?.code, 'batch-terminated-early');
  assert.equal(minusOne.fatal?.code, 'batch-terminated-early');
  assert.notEqual(
    plusOne.fatal?.code,
    minusOne.fatal?.code,
    'declared+1 and declared-1 must split; if they do not, the length field is not being read',
  );
});

test('F3 splits at the opcode boundary 0x07 / 0x08', () => {
  const accepted = decodeWsMessage(buildFaultBuffer(faultByName('F3-control-max-defined-opcode-07')), buildContext());
  const rejected = decodeWsMessage(buildFaultBuffer(faultByName('F3-control-min-undefined-opcode-08')), buildContext());

  assert.equal(accepted.fatal, undefined);
  assert.equal(accepted.frames.length, 1);
  assert.equal(rejected.fatal?.code, 'unknown-opcode');
  assert.equal(rejected.frames.length, 0);
});

test('F5 bound is measured on bodyBytes, three points apart', () => {
  const below = decodeWsMessage(buildFaultBuffer(faultByName('F5-control-below-limit')), buildContext());
  const at = decodeWsMessage(buildFaultBuffer(faultByName('F5-control-at-limit')), buildContext());
  const over = decodeWsMessage(buildFaultBuffer(faultByName('F5-fault-above-limit')), buildContext());

  assert.equal(below.fatal, undefined);
  assert.deepEqual(below.scoped, []);
  assert.equal(at.fatal, undefined);
  assert.deepEqual(at.scoped, []);
  assert.equal(over.frames.length, 0);
  assert.equal(over.scoped[0]?.code, 'payload-limit-exceeded');
  assert.notEqual(over.scoped[0]?.code, 'length-overrun', 'F5 must not collapse into F2');
  assert.equal(MAX_BODY_BYTES, 2097152, 'the limit must come from pty.maxSnapshotBytes, not a new constant');
});

test('M-3 payload-limit-exceeded is scoped — the frame is skipped and the rest of the batch survives', () => {
  // 01:957 defines fatal as "framing itself cannot be trusted, so every later
  // offset is meaningless". That is false for this code: payloadLength agrees
  // with the buffer (which is exactly what separates it from length-overrun),
  // so frameEnd is known and the batch can resume. Grading it fatal would drop
  // every later frame of the same WS message — the loss 01:951 argues against.
  assert.equal(rejectionGrade('payload-limit-exceeded'), 'scoped');
  assert.equal(rejectionGrade('payload-underrun'), 'fatal', 'a declared length we cannot trust stays fatal');

  const result = decodeWsMessage(
    buildFaultBuffer(faultByName('F5-control-oversized-frame-keeps-the-batch')),
    buildContext(),
  );

  assert.equal(result.fatal, undefined, 'framing is sound, so the batch must not be aborted');
  assert.deepEqual(
    result.scoped.map((r) => ({ code: r.code, grade: r.grade, channelId: r.channelId })),
    [{ code: 'payload-limit-exceeded', grade: 'scoped', channelId: 1 }],
  );
  assert.equal(result.frames.length, 1, 'the frame decoded before the oversized one must survive');
  assert.equal(result.frames[0]!.sourceSeq, '1');
  assert.equal(result.frames[0]!.frameOffset, 0);
});

test('F6 the encoder rejects non-canonical or out-of-range Ordinal64 at its entry point', () => {
  const base = toWireMessage(vectorByName('output-minimal-52').messages[0]!);

  assert.doesNotThrow(() => encodeFrame({ ...base, sourceSeq: '18446744073709551615' }));
  assert.throws(() => encodeFrame({ ...base, sourceSeq: '18446744073709551616' }), /Ordinal64/);
  assert.throws(() => encodeFrame({ ...base, sourceSeq: '01' }), /Ordinal64/);
  assert.throws(() => encodeFrame({ ...base, sourceSeq: '-1' }), /Ordinal64/);
  assert.throws(() => encodeFrame({ ...base, streamEpoch: 1 as unknown as string }), /Ordinal64/);
  assert.throws(
    () => encodeFrame({ ...base, prologue: { ...base.prologue, chunkIdBase: '18446744073709551616' } } as BinaryWireMessage),
    /Ordinal64/,
  );
});

test('the encoder refuses to emit the reserved channel and out-of-mask flags', () => {
  const base = toWireMessage(vectorByName('output-minimal-52').messages[0]!);

  assert.throws(() => encodeFrame({ ...base, channelId: 0 }), /channelId/);
  assert.throws(() => encodeFrame({ ...base, flags: 0x000f }), /flag/i);
  assert.throws(() => encodeFrame({ ...base, flags: 0x0001 }), /PROLOGUE_PRESENT/);
  assert.throws(() => encodeFrame({ ...base, opcode: OPCODE_JSON_ENVELOPE } as unknown as BinaryWireMessage), /opcode/);
});

// ---------------------------------------------------------------------------
// 3. Error grading — a fatal must not erase the frames already parsed.
// ---------------------------------------------------------------------------

test('a fatal rejection still returns the frames parsed before it (no silent drop)', () => {
  // Hand-assembled from two golden vectors: batch-two-output-frames-106 with the
  // second frame's END_OF_BATCH cleared (flags u16 lives at offsets 55..56, so
  // 0x000B -> 0x000A means byte 56), followed by output-minimal-52 with
  // frameVersion patched to 0x02.
  const batch = hexToBytes(vectorByName('batch-two-output-frames-106').hexFrame);
  assert.equal(batch[55], 0x00, 'flags high byte');
  assert.equal(batch[56], 0x0b, 'flags low byte');
  batch[56] = 0x0a;
  const bad = hexToBytes(vectorByName('output-minimal-52').hexFrame);
  bad[0] = 0x02;

  const buffer = new Uint8Array(batch.length + bad.length);
  buffer.set(batch, 0);
  buffer.set(bad, batch.length);

  const result = decodeWsMessage(buffer, buildContext());

  assert.equal(result.fatal?.code, 'bad-frame-version');
  assert.equal(result.frames.length, 2, 'frames parsed before the fatal must survive');
  assert.equal(result.frames[0]!.sourceSeq, '1');
  assert.equal(result.frames[1]!.sourceSeq, '2');
  assert.equal(result.fatal?.frameOffset, batch.length);
});

test('L-1 an empty binary WS message is accepted as a no-op — pinned, not incidental', () => {
  const result = decodeWsMessage(new Uint8Array(0), buildContext());

  assert.equal(result.fatal, undefined, 'zero bytes carry no payload, so nothing is dropped');
  assert.deepEqual(result, { frames: [], scoped: [], diagnostics: [] });

  // The acceptance holds at exactly zero. One byte is already a rejection, so
  // this is not "the decoder tolerates short buffers".
  const oneByte = decodeWsMessage(new Uint8Array([FRAME_VERSION_V1]), buildContext());
  assert.equal(oneByte.fatal?.code, 'truncated-header');
  assert.equal(oneByte.fatal?.grade, 'fatal');
});

test('the rejection code inventory matches 01:934-943 exactly and grades them', () => {
  assert.deepEqual([...WIRE_REJECTION_CODES].sort(), [
    'bad-frame-version',
    'batch-not-terminated',
    'batch-terminated-early',
    'binary-frame-on-json-group',
    'length-overrun',
    'reserved-channel',
    'reserved-flag-set',
    'truncated-header',
    'unknown-channel',
    'unknown-opcode',
  ]);
  assert.equal(WIRE_REJECTION_CODES.length, 10);

  // 01:957-958 — unknown-channel is the only scoped code; everything else is fatal.
  for (const code of WIRE_REJECTION_CODES) {
    assert.equal(rejectionGrade(code), code === 'unknown-channel' ? 'scoped' : 'fatal', code);
  }

  // Decoder-emitted codes with no entry in 01:934-943 live outside the frozen
  // wire set. That is the membership rule, and it is what keeps the list above
  // comparable against the spec text instead of against this file. They are NOT
  // graded as a block: 01:957 grades by whether framing survives, and the codes
  // differ on exactly that.
  assert.deepEqual(
    [...DECODER_POLICY_CODES].sort(),
    ['mandatory-flag-cleared', 'payload-limit-exceeded', 'payload-underrun', 'prologue-domain-violation'],
  );
  for (const code of DECODER_POLICY_CODES) {
    assert.ok(!(WIRE_REJECTION_CODES as readonly string[]).includes(code), `${code} must not shadow a wire code`);
  }
  assert.equal(rejectionGrade('payload-underrun'), 'fatal');
  assert.equal(rejectionGrade('payload-limit-exceeded'), 'scoped');
  // D14: fatal even though frameEnd is knowable here (opcode, not bit3, gives the
  // layout). What is in doubt is the peer's encoder, and the remedy is connection
  // -level renegotiation — not skipping one frame.
  assert.equal(rejectionGrade('mandatory-flag-cleared'), 'fatal');
  // Scoped for the same reason as payload-limit-exceeded: payloadLength agrees
  // with the buffer, so frameEnd is trustworthy and only this frame is in doubt.
  // What is wrong is the prologue's content, not the framing.
  assert.equal(rejectionGrade('prologue-domain-violation'), 'scoped');
});

// ---------------------------------------------------------------------------
// 4. Opcode space (D9) and direction-scoped namespaces (S2-d).
// ---------------------------------------------------------------------------

test('D9 opcode space classification follows 01 section 1.3 verbatim', () => {
  assert.equal(opcodeSpace(0x00), 'permanently-reserved');
  assert.equal(opcodeSpace(0xff), 'permanently-reserved');
  for (let op = 0x01; op <= 0x07; op += 1) assert.equal(opcodeSpace(op), 'assigned', `0x0${op}`);
  for (const op of [0x08, 0x20, 0x3f]) assert.equal(opcodeSpace(op), 'reserved-data-plane', String(op));
  for (const op of [0x40, 0x60, 0x7f]) assert.equal(opcodeSpace(op), 'vendor', String(op));
  assert.equal(opcodeSpace(0x80), 'json-envelope-reserved');
  for (const op of [0x81, 0xc0, 0xfe]) assert.equal(opcodeSpace(op), 'unassigned', String(op));

  for (let op = 0; op <= 0xff; op += 1) {
    assert.equal(isKnownOpcode(op), op >= 0x01 && op <= 0x07, `isKnownOpcode(${op})`);
  }
});

test('S2-c the opcode table is hand-maintained, not generated from ServerWsMessage', () => {
  assert.deepEqual(SERVER_TO_CLIENT_OPCODE_BY_TYPE, {
    output: 0x01,
    'screen-snapshot': 0x02,
    'screen-repair': 0x03,
    'terminal-checkpoint:start': 0x04,
    'terminal-checkpoint:chunk': 0x05,
    'terminal-checkpoint:commit': 0x06,
    'terminal-checkpoint:output': 0x07,
  });
  assert.equal(Object.keys(SERVER_TO_CLIENT_OPCODE_BY_TYPE).length, 7);
});

test('S2-d the C->S opcode namespace is separate and empty in v1', () => {
  // screen-repair exists in both directions with different payload shapes
  // (ScreenRepairRequestMessage vs ScreenRepairMessage). A direction-blind table
  // would fold them into one opcode. v1 keeps every C->S message on JSON.
  assert.deepEqual(CLIENT_TO_SERVER_OPCODE_BY_TYPE, {});
  assert.equal(SERVER_TO_CLIENT_OPCODE_BY_TYPE['screen-repair'], 0x03);
});

test('prologue sizes match 01 section 1.8', () => {
  assert.equal(prologueBytes(DATA_PLANE_OPCODE.OUTPUT), 24);
  assert.equal(prologueBytes(DATA_PLANE_OPCODE.SCREEN_SNAPSHOT), 24);
  assert.equal(prologueBytes(DATA_PLANE_OPCODE.CHECKPOINT_CHUNK), 12);
  // 07 section 2.6.1 gave 0x04 a layout: 160 bytes of section 2.9 plus the
  // 40-byte responderLeaseId slot.
  assert.equal(prologueBytes(DATA_PLANE_OPCODE.CHECKPOINT_START), 200);
  // 01 section 1.8 still defines none for 0x03/0x06/0x07.
  for (const op of [0x03, 0x06, 0x07]) assert.equal(prologueBytes(op), 0, String(op));
});

test('frames whose opcode has no v1 prologue schema decode as opaque, not as a rejection', () => {
  const result = decodeWsMessage(buildFaultBuffer(faultByName('F3-control-max-defined-opcode-07')), buildContext());
  assert.equal(result.fatal, undefined);
  assert.equal(parseFrameMessage(result.frames[0]!), undefined);
  assert.equal(bytesToHex(result.frames[0]!.payload), '0011223344556677');
});

// ---------------------------------------------------------------------------
// 5. Flag and header constants — the negotiation contract in 01 section 1.2.
// ---------------------------------------------------------------------------

test('flag constants satisfy the 01 section 1.2 mask algebra', () => {
  assert.equal(FRAME_HEADER_BYTES, 28);
  assert.equal(FRAME_VERSION_V1, 0x01);
  assert.equal(SEGMENT_BYTES, 16);
  assert.equal(FLAG_END_OF_BATCH, 0x0001);
  assert.equal(FLAG_PAYLOAD_UTF8_TEXT, 0x0002);
  assert.equal(FLAG_PROLOGUE_PRESENT, 0x0008);
  assert.equal(MANDATORY_FLAGS, FLAG_END_OF_BATCH | FLAG_PROLOGUE_PRESENT);
  assert.equal(MANDATORY_FLAGS, 0x0009);
  assert.equal(NEGOTIABLE_FLAGS_V1, 0x0002);
  assert.equal(ACTIVE_FLAG_MASK_V1, MANDATORY_FLAGS | NEGOTIABLE_FLAGS_V1);
  assert.equal(ACTIVE_FLAG_MASK_V1, 0x000b);
  assert.equal(ACTIVE_FLAG_MASK_V1 & 0x0004, 0, 'bit2 must sit outside the v1 mask');
});

test('defaultFlagsForOpcode sets PAYLOAD_UTF8_TEXT for OUTPUT only', () => {
  assert.equal(defaultFlagsForOpcode(DATA_PLANE_OPCODE.OUTPUT, { endOfBatch: true }), 0x000b);
  assert.equal(defaultFlagsForOpcode(DATA_PLANE_OPCODE.OUTPUT, { endOfBatch: false }), 0x000a);
  assert.equal(defaultFlagsForOpcode(DATA_PLANE_OPCODE.SCREEN_SNAPSHOT, { endOfBatch: true }), 0x0009);
  assert.equal(defaultFlagsForOpcode(DATA_PLANE_OPCODE.CHECKPOINT_CHUNK, { endOfBatch: false }), 0x0008);
});

test('D14 the per-frame flag invariant is bit3 alone — never the MANDATORY_FLAGS mask', () => {
  // 01:84's MANDATORY_FLAGS = bit0|bit3 mixes two invariants. The NEGOTIATION one
  // (the client's acceptedFlagMask must contain both bits, 01:93) is where that
  // value belongs. The PER-FRAME one is bit3 only, because 01:75 puts END_OF_BATCH
  // on the last frame and only the last frame — so bit0 = 0 is correct, not a
  // fault, on every other frame of a batch.
  const midBatch = decodeWsMessage(
    buildFaultBuffer(faultByName('D14-control-mid-batch-mandatory-flag-only')),
    buildContext(),
  );

  assert.equal(midBatch.fatal, undefined, 'a mid-batch frame with END_OF_BATCH cleared must be accepted');
  assert.equal(midBatch.frames.length, 2);

  const frameA = midBatch.frames[0]!;
  assert.equal(frameA.flags, FLAG_PROLOGUE_PRESENT, 'frame A carries bit3 and nothing else');
  assert.equal(frameA.flags & FLAG_END_OF_BATCH, 0, 'frame A is not the last frame, so bit0 is legitimately 0');
  assert.notEqual(
    frameA.flags & MANDATORY_FLAGS,
    MANDATORY_FLAGS,
    'this accepted frame FAILS the MANDATORY_FLAGS mask — a decoder using that mask would have rejected it',
  );
  assert.notEqual(frameA.flags & FLAG_PROLOGUE_PRESENT, 0, 'and it PASSES the bit3-only predicate');

  // Same claim on the untouched golden batch, where bit1 is still set: it is the
  // bit0 = 0 that must not be fatal, not the absence of PAYLOAD_UTF8_TEXT.
  const golden = decodeWsMessage(buildFaultBuffer(faultByName('D14-control-mid-batch-bit0-cleared')), buildContext());
  assert.equal(golden.fatal, undefined);
  assert.equal(golden.frames.length, 2);
  assert.equal(golden.frames[0]!.flags, 0x000a);
});

test('D14 a frame carrying its prologue with PROLOGUE_PRESENT cleared is rejected, fatally', () => {
  const single = decodeWsMessage(
    buildFaultBuffer(faultByName('D14-fault-prologue-present-cleared-52')),
    buildContext(),
  );

  assert.equal(single.fatal?.code, 'mandatory-flag-cleared');
  assert.equal(single.fatal?.grade, 'fatal', 'what is in doubt is the peer encoder, not this frame offset');
  assert.equal(single.fatal?.frameOffset, 0);
  assert.equal(single.frames.length, 0);

  // Per frame, not per WS message: the batch variant clears bit3 on the SECOND
  // frame, and the first must survive the fatal (01:949-960).
  const midBatch = decodeWsMessage(
    buildFaultBuffer(faultByName('D14-fault-mid-batch-prologue-present-cleared')),
    buildContext(),
  );
  assert.equal(midBatch.fatal?.code, 'mandatory-flag-cleared');
  assert.equal(midBatch.fatal?.frameOffset, 53, 'the rejected frame is the second one');
  assert.equal(midBatch.frames.length, 1, 'the frame parsed before the fatal must survive');
  assert.equal(midBatch.frames[0]!.sourceSeq, '1');
});

test('D14 encoder and decoder now agree on PROLOGUE_PRESENT — the asymmetry is closed', () => {
  const base = toWireMessage(vectorByName('output-minimal-52').messages[0]!);
  const clearedFlags = base.flags & ~FLAG_PROLOGUE_PRESENT;

  assert.equal(clearedFlags, 0x0003);
  assert.throws(() => encodeFrame({ ...base, flags: clearedFlags }), /PROLOGUE_PRESENT/);

  // The exact wire shape the encoder refuses to emit is the shape the decoder
  // now refuses to accept. Before D14 the encoder was strict and the decoder was
  // not, so a non-conformant peer went undetected.
  const refusedOnTheWire = buildFaultBuffer(faultByName('D14-fault-prologue-present-cleared-52'));
  assert.equal(new DataView(refusedOnTheWire.buffer, refusedOnTheWire.byteOffset).getUint16(2), clearedFlags);
  assert.equal(decodeWsMessage(refusedOnTheWire, buildContext()).fatal?.code, 'mandatory-flag-cleared');
});

test('D14 an opcode with no v1 prologue schema is not held to bit3', () => {
  // 01 section 1.8 defines no prologue for 0x03/0x04/0x06/0x07, so such a frame
  // genuinely carries none: for it, SETTING bit3 would be the false statement.
  // The encoder cannot emit these opcodes at all (prologueBytes === 0 is its own
  // encodability gate), so there is no asymmetry here for D14 to close, and a
  // rejection would pre-judge the spec gap D15 records.
  const result = decodeWsMessage(
    buildFaultBuffer(faultByName('D14-control-no-prologue-schema-bit3-cleared')),
    buildContext(),
  );

  assert.equal(result.fatal, undefined);
  assert.equal(result.frames.length, 1);
  assert.equal(result.frames[0]!.opcode, 0x07);
  assert.equal(prologueBytes(result.frames[0]!.opcode), 0, 'the premise of the acceptance');
  assert.equal(result.frames[0]!.flags & FLAG_PROLOGUE_PRESENT, 0, 'bit3 really is cleared');
  assert.equal(parseFrameMessage(result.frames[0]!), undefined, 'and the frame stays opaque');
});

test('a group whose codec is JSON never yields frames, whatever the bytes are', () => {
  const jsonContext = createV1DecodeContext({
    codec: 'json',
    maxBodyBytes: MAX_BODY_BYTES,
    channelState: () => 'active',
  });
  const result = decodeWsMessage(hexToBytes(vectorByName('batch-two-output-frames-106').hexFrame), jsonContext);

  assert.deepEqual(result.frames, []);
  assert.equal(result.fatal?.code, 'binary-frame-on-json-group');
});

// ---------------------------------------------------------------------------
// 8. 0x04 CHECKPOINT_START prologue — 07 section 2.6.1 / 2.9.
//
// The 40 bytes at off 160 exist because `responderLeaseId` is on the wire
// (Controller.ts:1592 injects it into every rollback checkpoint message) and the
// client compares it (terminalCheckpointRuntime.ts:522) before it inherits
// anything. A fixed-width slot keeps `prologueBytes` a pure function of opcode,
// which is what 01:108 and 01:518 rest the D14 safety argument on.
// ---------------------------------------------------------------------------

const CHECKPOINT_START_PROLOGUE_BYTES = 200;
const LEASE_PRESENT = 0x0010;
const ROLLBACK_LEASE = 'responder-browser-9';

function checkpointStartMessage(
  overrides: Partial<CheckpointStartPrologue> = {},
  body = new Uint8Array(0),
): BinaryWireMessage {
  return {
    opcode: DATA_PLANE_OPCODE.CHECKPOINT_START,
    flags: defaultFlagsForOpcode(DATA_PLANE_OPCODE.CHECKPOINT_START, { endOfBatch: true }),
    channelId: 1,
    streamEpoch: '7',
    sourceSeq: '41',
    prologue: {
      checkpointSourceSeq: '41',
      viewGeneration: 3,
      chunkCount: 2,
      checkpointStreamEpoch: '7',
      checkpointEpoch: '11',
      snapshotSeq: '12',
      oldestRetainedSeq: '5',
      transitionEpoch: '0',
      boundarySourceSeq: '0',
      encodedByteTotal: 64,
      cols: 80,
      rows: 24,
      authorityEpochIndex: 0,
      flags2: 0,
      modesPresentMask: 0,
      modesValueMask: 0,
      retainedActiveBuffer: 0,
      retainedCursorX: 0,
      retainedCursorY: 0,
      retainedSavedCursorX: 0,
      retainedSavedCursorY: 0,
      digest: new Uint8Array(32),
      retainedStateDigest: new Uint8Array(32),
      ...overrides,
    },
    body,
  };
}

test('0x04 has a 200-byte prologue and it is a pure function of the opcode', () => {
  assert.equal(prologueBytes(DATA_PLANE_OPCODE.CHECKPOINT_START), CHECKPOINT_START_PROLOGUE_BYTES);
  // The size must not depend on whether the lease slot is populated — that is the
  // property 01:108 names, and the only reason bit3 can be graded fatal without
  // claiming the decoder would misread the layout.
  const withLease = checkpointStartMessage({ flags2: LEASE_PRESENT, responderLeaseId: ROLLBACK_LEASE });
  const withoutLease = checkpointStartMessage();
  assert.equal(frameByteLength(withLease), frameByteLength(withoutLease));
  assert.equal(frameByteLength(withoutLease), FRAME_HEADER_BYTES + CHECKPOINT_START_PROLOGUE_BYTES);
});

test('0x04 round-trips a rollback lease and a promotion absence distinctly', () => {
  const rollback = checkpointStartMessage({ flags2: LEASE_PRESENT, responderLeaseId: ROLLBACK_LEASE });
  const decodedRollback = parseFrameMessage(
    decodeWsMessage(encodeFrame(rollback), buildContext()).frames[0]!,
  );
  assert.equal(decodedRollback?.opcode, DATA_PLANE_OPCODE.CHECKPOINT_START);
  assert.deepEqual(decodedRollback, rollback);

  const promotion = checkpointStartMessage();
  const decodedPromotion = parseFrameMessage(
    decodeWsMessage(encodeFrame(promotion), buildContext()).frames[0]!,
  ) as { prologue: CheckpointStartPrologue } | undefined;
  assert.deepEqual(decodedPromotion, promotion);
  // Absence must be a MISSING KEY, never ''. An empty string passes the client's
  // own `matchesTransactionIdentity` ('' === '') and then dies server-side on the
  // ACK echo at Adapter.ts:790 — the worst diagnostic path there is.
  assert.equal('responderLeaseId' in (decodedPromotion!.prologue as object), false);
});

test('the 38-byte lease bound still equals what it was derived from', () => {
  // 38 is derived, not chosen: the prefix plus the widest Ordinal64. Lowering the
  // constant without changing the template would start rejecting real leases at
  // the top of the epoch range, where nothing else would notice until it happened.
  const prefixBytes = Buffer.byteLength('responder-browser-', 'utf8');
  const widestOrdinal64 = String(2n ** 64n - 1n).length;
  assert.equal(prefixBytes, 18);
  assert.equal(widestOrdinal64, 20);
  assert.equal(RESPONDER_LEASE_ID_MAX_BYTES, prefixBytes + widestOrdinal64);

  // The compatibility-recovery generator appends `-runtime-N`, so at the top of
  // the epoch range it is past the bound and this encoder would throw. It reaches
  // `terminal-checkpoint:start` through exactly one producer
  // (TerminalAuthorityProductionAdapter.ts:4442) which uses the unsuffixed form.
  // Pin the overflow so a future widening of the bound has to confront it.
  const widestSuffixed = `responder-browser-${'9'.repeat(widestOrdinal64)}-runtime-9`;
  assert.ok(
    Buffer.byteLength(widestSuffixed, 'utf8') > RESPONDER_LEASE_ID_MAX_BYTES,
    'the suffixed form must remain out of bounds; only the unsuffixed one may reach this encoder',
  );
  assert.throws(
    () => encodeFrame(checkpointStartMessage({
      flags2: LEASE_PRESENT,
      responderLeaseId: widestSuffixed,
    })),
    /responderLeaseId/u,
  );
});

test('0x04 carries a lease at the derived 38-byte bound', () => {
  // 'responder-browser-' is 18 bytes; an Ordinal64 is at most 20 decimal digits.
  const maxLease = 'responder-browser-' + '1'.repeat(20);
  assert.equal(Buffer.byteLength(maxLease, 'utf8'), 38);

  const message = checkpointStartMessage({ flags2: LEASE_PRESENT, responderLeaseId: maxLease });
  const decoded = parseFrameMessage(decodeWsMessage(encodeFrame(message), buildContext()).frames[0]!);
  assert.deepEqual(decoded, message);
});

test('0x04 encoder rejects a lease past the bound and a flags2 that disagrees with it', () => {
  assert.throws(
    () => encodeFrame(checkpointStartMessage({
      flags2: LEASE_PRESENT,
      responderLeaseId: 'responder-browser-' + '1'.repeat(21),
    })),
    /responderLeaseId/u,
  );
  // The presence bit and the field are two representations of one fact; letting
  // them disagree is how '' and undefined start to blur.
  assert.throws(
    () => encodeFrame(checkpointStartMessage({ flags2: 0, responderLeaseId: ROLLBACK_LEASE })),
    /RESPONDER_LEASE_ID_PRESENT/u,
  );
  assert.throws(
    () => encodeFrame(checkpointStartMessage({ flags2: LEASE_PRESENT })),
    /RESPONDER_LEASE_ID_PRESENT/u,
  );
});

test('0x04 decoder rejects every prologue domain violation, scoped not fatal', () => {
  const base = encodeFrame(checkpointStartMessage({
    flags2: LEASE_PRESENT,
    responderLeaseId: ROLLBACK_LEASE,
  }));
  const at = (offset: number) => FRAME_HEADER_BYTES + offset;

  const mutate = (edit: (bytes: Uint8Array) => void) => {
    const bytes = base.slice();
    edit(bytes);
    return decodeWsMessage(bytes, buildContext());
  };

  // Control: the unmutated frame decodes cleanly. Without it every case below
  // could pass because the fixture never decoded at all.
  assert.deepEqual(decodeWsMessage(base.slice(), buildContext()).scoped, []);

  const lengthPastBound = mutate(bytes => { bytes[at(160)] = 39; });
  assert.equal(lengthPastBound.scoped[0]?.code, 'prologue-domain-violation');
  assert.equal(rejectionGrade('prologue-domain-violation'), 'scoped');
  assert.equal(lengthPastBound.fatal, undefined, 'a bad prologue must not discard the rest of the batch');

  // The slot has to be cleared as well. Zeroing only the length byte leaves the
  // old lease bytes in place, so the padding clause fires and this case passes
  // even with the zero-length clause deleted -- it pinned nothing.
  const presentButEmpty = mutate(bytes => {
    bytes[at(160)] = 0;
    bytes.fill(0, at(161), at(200));
  });
  assert.equal(presentButEmpty.scoped[0]?.code, 'prologue-domain-violation');

  const absentButPopulated = mutate(bytes => { bytes[at(75)] &= ~LEASE_PRESENT; });
  assert.equal(absentButPopulated.scoped[0]?.code, 'prologue-domain-violation');

  const dirtyPadding = mutate(bytes => { bytes[at(199)] = 1; });
  assert.equal(dirtyPadding.scoped[0]?.code, 'prologue-domain-violation');

  const reservedFlags2 = mutate(bytes => { bytes[at(74)] |= 0x01; });
  assert.equal(reservedFlags2.scoped[0]?.code, 'prologue-domain-violation');

  const dirtyReservedByte = mutate(bytes => { bytes[at(79)] = 1; });
  assert.equal(dirtyReservedByte.scoped[0]?.code, 'prologue-domain-violation');

  const invalidUtf8 = mutate(bytes => { bytes[at(161)] = 0xff; });
  assert.equal(invalidUtf8.scoped[0]?.code, 'prologue-domain-violation');
});

const RETAINED_STATE_PRESENT = 0x0001;
const TRANSITION_EPOCH_PRESENT = 0x0002;
const BOUNDARY_SOURCE_SEQ_PRESENT = 0x0004;
const SAVED_CURSOR_NON_NULL = 0x0008;

/**
 * Every case below mutates exactly one thing away from a prologue that decodes
 * cleanly, so a rejection cannot be credited to the wrong clause. The shared
 * control asserts the unmutated frame is accepted -- without it each case could
 * pass because the fixture never decoded at all.
 */
function assertEachCaseRejected(
  base: Uint8Array,
  cases: ReadonlyArray<readonly [string, (bytes: Uint8Array, view: DataView) => void]>,
): void {
  assert.deepEqual(
    decodeWsMessage(base.slice(), buildContext()).scoped,
    [],
    'control: the unmutated frame must decode cleanly',
  );
  for (const [label, edit] of cases) {
    const bytes = base.slice();
    edit(bytes, new DataView(bytes.buffer, bytes.byteOffset));
    const result = decodeWsMessage(bytes, buildContext());
    assert.equal(result.scoped[0]?.code, 'prologue-domain-violation', label);
    assert.equal(result.fatal, undefined, `${label} must stay scoped, not fatal`);
  }
}

test('0x04 decoder rejects the 07 section 2.11 value-domain violations', () => {
  // bit0 set so the retained-state fields are legitimately in play; otherwise a
  // mutation to off 78 would trip the presence clause instead of the range one.
  const base = encodeFrame(checkpointStartMessage({
    flags2: RETAINED_STATE_PRESENT,
    retainedActiveBuffer: 1,
    retainedStateDigest: new Uint8Array(32).fill(0x22),
  }));
  const at = (offset: number) => FRAME_HEADER_BYTES + offset;

  assertEachCaseRejected(base, [
    ['chunkCount 0 (07:394 requires positive)', (_b, v) => v.setUint32(at(12), 0)],
    ['cols 0 (07:492)', (_b, v) => v.setUint16(at(68), 0)],
    ['rows 0 (07:492)', (_b, v) => v.setUint16(at(70), 0)],
    ['retainedActiveBuffer 2 (07:493)', b => { b[at(78)] = 2; }],
    ['modesValueMask outside modesPresentMask (07:494)', b => { b[at(76)] = 0x01; b[at(77)] = 0x02; }],
  ]);
});

test('0x04 decoder rejects a cleared presence bit whose field carries a value', () => {
  // 07 section 2.9 spells each of these as "valid only when bit N = 1". A decoder
  // that returns the bytes anyway fabricates a value the server never asserted --
  // and the client compares boundarySourceSeq as strictly as the lease
  // (terminalCheckpointRuntime.ts:522 vs :523), so a fabricated '0' there
  // mismatches every subsequent chunk instead of failing once, loudly.
  const base = encodeFrame(checkpointStartMessage());
  const at = (offset: number) => FRAME_HEADER_BYTES + offset;

  assertEachCaseRejected(base, [
    ['transitionEpoch set with bit1 clear (07:399)', (_b, v) => v.setUint32(at(52), 99)],
    ['boundarySourceSeq set with bit2 clear (07:400)', (_b, v) => v.setUint32(at(60), 41)],
    ['retainedActiveBuffer set with bit0 clear (07:408)', b => { b[at(78)] = 1; }],
    ['retainedStateDigest set with bit0 clear (07:415)', b => { b[at(128)] = 0xab; }],
    ['retainedSavedCursorX set with bit3 clear (07:412)', (_b, v) => v.setUint32(at(88), 7)],
    ['retainedSavedCursorY set with bit3 clear (07:412)', (_b, v) => v.setUint32(at(92), 7)],
    ['SAVED_CURSOR_NON_NULL set with bit0 clear (07:496)', b => { b[at(75)] |= SAVED_CURSOR_NON_NULL; }],
  ]);
});

test('0x04 round-trips every prologue field at a distinct non-zero value', () => {
  // Nine fields were only ever encoded as 0, so their offsets, widths and
  // endianness were unpinned: an encoder that wrote constant 0 for all of them
  // passed the whole suite. Distinct values make a swapped pair fail too.
  const message = checkpointStartMessage({
    flags2: RETAINED_STATE_PRESENT | TRANSITION_EPOCH_PRESENT
      | BOUNDARY_SOURCE_SEQ_PRESENT | SAVED_CURSOR_NON_NULL,
    transitionEpoch: '4294967297',
    boundarySourceSeq: '4294967298',
    authorityEpochIndex: 0x1234,
    modesPresentMask: 0xff,
    modesValueMask: 0xa5,
    retainedActiveBuffer: 1,
    retainedCursorX: 0x11223344,
    retainedCursorY: 0x55667788,
    retainedSavedCursorX: 0x99aabbcc,
    retainedSavedCursorY: 0xddeeff00,
    retainedStateDigest: new Uint8Array(32).fill(0x22),
  });
  const decoded = parseFrameMessage(
    decodeWsMessage(encodeFrame(message), buildContext()).frames[0]!,
  );
  assert.deepEqual(decoded, message);
});

test('0x04 encoder refuses a prologue it would have to encode inconsistently', () => {
  // Each of these guards exists but nothing pinned it, so deleting any one of
  // them left the suite green while the server emitted a frame its own decoder
  // rejects.
  assert.throws(
    () => encodeFrame(checkpointStartMessage({ flags2: 0x0020 })),
    /flags2/u,
    'a reserved flags2 bit must not reach the wire',
  );
  assert.throws(
    () => encodeFrame(checkpointStartMessage({ digest: new Uint8Array(31) })),
    /32 bytes/u,
    'a short digest must not be padded silently',
  );
  assert.throws(
    () => encodeFrame(checkpointStartMessage({
      flags2: LEASE_PRESENT,
      responderLeaseId: '',
    })),
    /empty/u,
    'an empty lease declared present would decode as a missing key',
  );
});

test('0x04 declaring less than its prologue underruns fatally', () => {
  // The buffer has to shrink with the declared length, otherwise frameEnd lands
  // short of the end and `batch-terminated-early` fires first -- which would make
  // this test pass for the wrong reason.
  const full = encodeFrame(checkpointStartMessage());
  const short = full.slice(0, FRAME_HEADER_BYTES + CHECKPOINT_START_PROLOGUE_BYTES - 1);
  new DataView(short.buffer, short.byteOffset).setUint32(24, CHECKPOINT_START_PROLOGUE_BYTES - 1);

  const result = decodeWsMessage(short, buildContext());
  assert.equal(result.fatal?.code, 'payload-underrun');
  assert.equal(rejectionGrade('payload-underrun'), 'fatal');
});
