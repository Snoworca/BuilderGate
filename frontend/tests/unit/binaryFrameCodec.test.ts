import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  ACTIVE_FLAG_MASK_V1,
  DATA_PLANE_OPCODE,
  FRAME_HEADER_BYTES,
  FRAME_VERSION_V1,
  MANDATORY_FLAGS,
  NEGOTIABLE_FLAGS_V1,
  SEGMENT_BYTES,
  createV1DecodeContext,
  decodeWsMessage,
  deriveMaxBodyBytes,
  isKnownOpcode,
  parseFrameMessage,
  prologueBytes,
  rejectionGrade,
  type BinaryDecodeContext,
  type BinaryWireMessage,
  type CheckpointStartPrologue,
} from '../../src/utils/binaryFrameCodec.ts';

/**
 * S4-C5 — the frontend decoder, read against the server's hand-computed golden
 * vectors.
 *
 * This file deliberately does NOT import the server codec (08 §5.2). The two
 * implementations are independent, and the fixture is the only thing they share
 * — which is the entire point: a differential test where both sides deriving
 * the same bytes from the same spec is evidence, and both sides deriving them
 * from the same *code* would be circular (05:450).
 *
 * The constants below are likewise re-declared by hand rather than imported.
 * `$rules` in the fixture is their control.
 */

const FIXTURE_URL = new URL(
  '../../../server/src/ws/__fixtures__/binary-frame-vectors.json',
  import.meta.url,
);

interface LayoutRow extends Array<unknown> {
  0: number;
  1: string;
  2: string;
}

interface VectorFixture {
  name: string;
  byteLength: number;
  layout: LayoutRow[];
  hexFrame: string;
  messages: Record<string, any>[];
}

interface DerivedFrom {
  vector?: string;
  fault?: string;
  patch?: Array<[number, string, string?]>;
  bodyFill?: { byteValue: number; count: number };
  truncateTo?: number;
  zeroFill?: boolean;
}

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
  /** Present on 2 of the 44 faults — the ones whose layout is spelled out in full. */
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
  $rules: Record<string, any>;
  defaultContext: {
    codec: 'json' | 'binary';
    channels: Record<string, 'active' | 'retired'>;
  };
  vectors: VectorFixture[];
  faults: FaultFixture[];
}

const fixture = JSON.parse(readFileSync(FIXTURE_URL, 'utf8')) as Fixture;

function hexToBytes(hex: string): Uint8Array {
  assert.equal(hex.length % 2, 0, `hex must have an even length: ${hex.slice(0, 32)}…`);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    assert.ok(Number.isInteger(byte), `non-hex digit at byte ${i}`);
    out[i] = byte;
  }
  return out;
}

function utf8Bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function vectorByName(name: string): VectorFixture {
  const found = fixture.vectors.find(v => v.name === name);
  assert.ok(found, `unknown vector ${name}`);
  return found;
}

function faultByName(name: string): FaultFixture {
  const found = fixture.faults.find(f => f.name === name);
  assert.ok(found, `unknown fault ${name}`);
  return found;
}

/** Rebuilds a fault buffer from its layout-verified base plus the declared patch. */
function buildFaultBuffer(entry: FaultFixture): Uint8Array {
  if (entry.utf8Text !== undefined) return utf8Bytes(entry.utf8Text);

  const derived = entry.derivedFrom;
  let base: Uint8Array;
  if (derived?.vector !== undefined) {
    base = hexToBytes(vectorByName(derived.vector).hexFrame);
  } else if (derived?.fault !== undefined) {
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

/**
 * 08 §5.5: the client budget comes from the visible output queue cap, not from a
 * new constant. 4 MiB by default, which is looser than the server's 2 MiB — so a
 * server honouring its own limit never trips this one.
 */
const CLIENT_DEFAULT_VISIBLE_QUEUE_BYTES = 4_194_304;
const MAX_BODY_BYTES = deriveMaxBodyBytes({
  visibleOutputQueueMaxBytes: CLIENT_DEFAULT_VISIBLE_QUEUE_BYTES,
});

/**
 * The F5 corpus encodes "one byte over the budget" as literal byte counts, and
 * those counts were computed against the SERVER budget (pty.maxSnapshotBytes,
 * 2 MiB) — not the client's 4 MiB. Running them under the client default would
 * accept `F5-fault-above-limit`, which is 08 §5.5's whole point rather than a
 * bug, but it would also stop testing the limit path at all.
 *
 * So the budget is read out of the corpus itself: `F5-control-at-limit` is the
 * frame that sits exactly ON the limit, so its body length IS the limit. If the
 * server ever regenerates the vectors at a different bound, this follows.
 */
const FAULT_CORPUS_MAX_BODY_BYTES = (() => {
  const atLimit = faultByName('F5-control-at-limit');
  const count = atLimit.derivedFrom?.bodyFill?.count;
  assert.ok(count, 'F5-control-at-limit must declare the body size that sits on the limit');
  return count;
})();

function buildContext(entry?: FaultFixture, maxBodyBytes?: number): BinaryDecodeContext {
  const channels = fixture.defaultContext.channels;
  return createV1DecodeContext({
    codec: entry?.context?.codec ?? fixture.defaultContext.codec,
    maxBodyBytes: maxBodyBytes ?? (entry === undefined ? MAX_BODY_BYTES : FAULT_CORPUS_MAX_BODY_BYTES),
    channelState: (channelId: number) => channels[String(channelId)],
  });
}

/** Fixture messages carry the two 32-byte digests as hex so the file stays reviewable. */
function toWireMessage(raw: Record<string, any>): BinaryWireMessage {
  const body = hexToBytes(String(raw.bodyHex ?? ''));
  const head = {
    flags: raw.flags as number,
    channelId: raw.channelId as number,
    streamEpoch: raw.streamEpoch as string,
    sourceSeq: raw.sourceSeq as string,
  };
  switch (raw.opcode) {
    case DATA_PLANE_OPCODE.OUTPUT:
      return {
        opcode: DATA_PLANE_OPCODE.OUTPUT,
        ...head,
        prologue: raw.prologue,
        segments: raw.segments ?? [],
        body,
      };
    case DATA_PLANE_OPCODE.SCREEN_SNAPSHOT:
      return { opcode: DATA_PLANE_OPCODE.SCREEN_SNAPSHOT, ...head, prologue: raw.prologue, body };
    case DATA_PLANE_OPCODE.CHECKPOINT_CHUNK:
      return { opcode: DATA_PLANE_OPCODE.CHECKPOINT_CHUNK, ...head, prologue: raw.prologue, body };
    case DATA_PLANE_OPCODE.CHECKPOINT_START: {
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
    default:
      throw new Error(`fixture message uses opcode ${raw.opcode}, which has no v1 prologue schema`);
  }
}

// ---------------------------------------------------------------------------
// 0. Schema drift guard (08 §5.4). If the server grows the corpus and this file
//    keeps reading the old shape, coverage shrinks silently.
// ---------------------------------------------------------------------------

test('the fixture still has the shape this file was written against', () => {
  assert.equal(fixture.vectors.length, 11, 'accept vector count changed');
  assert.equal(fixture.faults.length, 44, 'fault/control entry count changed');

  // Two arrays, not one. Iterating only `vectors` would silently skip 80% of the
  // corpus, which is the larger half of the decoder's contract.
  assert.ok(Array.isArray(fixture.faults), 'the faults array must exist alongside vectors');

  assert.deepEqual(fixture.$rules.prologueBytes, { 1: 24, 2: 24, 4: 200, 5: 12 });
  assert.equal(fixture.$rules.headerBytes, 28);
  assert.equal(fixture.$rules.segmentBytes, 16);
  assert.equal(fixture.$rules.mandatoryFlags, 9);
  assert.equal(fixture.$rules.negotiableFlagsV1, 2);
  assert.equal(fixture.$rules.activeFlagMaskV1, 11);
  assert.equal(fixture.$rules.frameVersionV1, 1);
  assert.equal(fixture.$rules.minimumValidOutputFrameBytes, 52);
  assert.match(String(fixture.$rules.endianness), /big-endian/u);
});

test('the frontend constants agree with the fixture rules', () => {
  // Hand-declared on this side; the fixture is the control. If they ever drift
  // the differential test below stops meaning anything.
  assert.equal(FRAME_HEADER_BYTES, fixture.$rules.headerBytes);
  assert.equal(SEGMENT_BYTES, fixture.$rules.segmentBytes);
  assert.equal(MANDATORY_FLAGS, fixture.$rules.mandatoryFlags);
  assert.equal(NEGOTIABLE_FLAGS_V1, fixture.$rules.negotiableFlagsV1);
  assert.equal(ACTIVE_FLAG_MASK_V1, fixture.$rules.activeFlagMaskV1);
  assert.equal(FRAME_VERSION_V1, fixture.$rules.frameVersionV1);

  for (const [opcode, bytes] of Object.entries(fixture.$rules.prologueBytes)) {
    assert.equal(prologueBytes(Number(opcode)), bytes, `prologueBytes(${opcode})`);
  }
  // The four opcodes with no v1 prologue schema must report 0, not throw.
  for (const opcode of [0x03, 0x06, 0x07]) {
    assert.equal(prologueBytes(opcode), 0, `opcode ${opcode} has no v1 schema`);
  }
  assert.equal(isKnownOpcode(0x07), true);
  assert.equal(isKnownOpcode(0x08), false);
  assert.equal(isKnownOpcode(0x00), false);
});

// ---------------------------------------------------------------------------
// 1. Layout self-audit, re-done here (08 §5.4). Skipping it because the server
//    test already does it would leave fixture corruption invisible to anyone
//    running only the frontend suite.
// ---------------------------------------------------------------------------

test('every layout-carrying entry is contiguous from 0 and reproduces its hexFrame', () => {
  const withLayout = [...fixture.vectors, ...fixture.faults.filter(f => f.layout)];
  assert.ok(withLayout.length >= 8, 'expected at least 8 layout-carrying entries');

  for (const entry of withLayout) {
    const layout = entry.layout as LayoutRow[];
    let offset = 0;
    let hex = '';
    for (const [rowOffset, rowHex] of layout) {
      assert.equal(rowOffset, offset, `${entry.name}: layout gap at ${rowOffset}`);
      offset += rowHex.length / 2;
      hex += rowHex;
    }
    assert.equal(hex, entry.hexFrame, `${entry.name}: layout rows do not reproduce hexFrame`);
    if (entry.byteLength !== undefined) {
      assert.equal(offset, entry.byteLength, `${entry.name}: byteLength disagrees with layout`);
    }
  }
});

// ---------------------------------------------------------------------------
// 2. The differential body: bytes the server computed by hand, decoded here.
// ---------------------------------------------------------------------------

for (const vector of fixture.vectors) {
  test(`decode reproduces the golden message — ${vector.name}`, () => {
    const bytes = hexToBytes(vector.hexFrame);
    assert.equal(bytes.byteLength, vector.byteLength);

    const result = decodeWsMessage(bytes, buildContext());
    assert.equal(result.fatal, undefined, `${vector.name} must decode without a fatal rejection`);
    assert.deepEqual(result.scoped, [], `${vector.name} must decode without scoped rejections`);
    assert.equal(result.frames.length, vector.messages.length);

    for (const [index, raw] of vector.messages.entries()) {
      const decoded = parseFrameMessage(result.frames[index]!);
      assert.deepEqual(decoded, toWireMessage(raw), `${vector.name}[${index}]`);
    }
  });
}

// ---------------------------------------------------------------------------
// 3. Fault corpus — code AND grade. 06 D13 made `payload-limit-exceeded` scoped,
//    so a grade mismatch here is a batch-loss bug on the client, not a nit.
// ---------------------------------------------------------------------------

for (const entry of fixture.faults) {
  test(`${entry.faultId} ${entry.role} — ${entry.name}`, () => {
    const bytes = buildFaultBuffer(entry);
    const result = decodeWsMessage(bytes, buildContext(entry));

    assert.equal(result.frames.length, entry.expect.frames, 'frame count');

    if (entry.expect.fatal === null) {
      assert.equal(result.fatal, undefined, 'expected no fatal rejection');
    } else {
      assert.equal(result.fatal?.code, entry.expect.fatal, 'fatal code');
      assert.equal(result.fatal?.grade, 'fatal', 'a fatal rejection must be graded fatal');
      assert.equal(rejectionGrade(entry.expect.fatal as never), 'fatal');
      if (entry.expect.detail !== undefined) {
        assert.equal(result.fatal?.detail, entry.expect.detail, 'fatal detail');
      }
    }

    const expectedScoped = entry.expect.scoped ?? [];
    assert.equal(result.scoped.length, expectedScoped.length, 'scoped rejection count');
    for (const [index, expected] of expectedScoped.entries()) {
      const actual = result.scoped[index]!;
      assert.equal(actual.code, expected.code, `scoped[${index}] code`);
      assert.equal(actual.channelId, expected.channelId, `scoped[${index}] channelId`);
      assert.equal(actual.grade, 'scoped', `scoped[${index}] must be graded scoped`);
      assert.equal(rejectionGrade(expected.code as never), 'scoped');
    }

    const expectedDiagnostics = entry.expect.diagnostics ?? [];
    assert.equal(result.diagnostics.length, expectedDiagnostics.length, 'diagnostic count');
    for (const [index, expected] of expectedDiagnostics.entries()) {
      assert.equal(result.diagnostics[index]?.event, expected.event);
      assert.equal(result.diagnostics[index]?.channelId, expected.channelId);
    }

    // Accepted frames are asserted field-by-field, never just counted. The S2
    // corpus recorded a decoder that silently truncated 4 KiB+ payloads and
    // still passed every count-only assertion (06 §S2-g).
    //
    // A fault patches specific header bytes, so an explicit field on the
    // expectation OVERRIDES the referenced golden message. Comparing the whole
    // message wholesale would fail on exactly the byte the fault set out to test.
    if (entry.expect.frames > 0) {
      const expectations = entry.expect.decoded;
      assert.ok(expectations, `${entry.name}: an accepted frame must declare expect.decoded`);
      assert.equal(expectations.length, entry.expect.frames, 'expect.decoded length');
    }

    for (const [index, expected] of (entry.expect.decoded ?? []).entries()) {
      const frame = result.frames[index];
      assert.ok(frame, `expected a decoded frame at ${index}`);
      const label = `${entry.name}[${index}]`;
      const golden = expected.vector === undefined
        ? undefined
        : toWireMessage(vectorByName(expected.vector).messages[expected.index ?? 0]!);

      assert.equal(frame.opcode, expected.opcode ?? golden?.opcode, `${label}: opcode`);
      assert.equal(frame.flags, expected.flags ?? golden?.flags, `${label}: flags`);
      assert.equal(frame.channelId, expected.channelId ?? golden?.channelId, `${label}: channelId`);
      assert.equal(
        frame.streamEpoch,
        expected.streamEpoch ?? golden?.streamEpoch,
        `${label}: streamEpoch`,
      );
      assert.equal(frame.sourceSeq, expected.sourceSeq ?? golden?.sourceSeq, `${label}: sourceSeq`);

      const message = parseFrameMessage(frame);

      if (expected.prologue === null) {
        assert.equal(message, undefined, `${label}: no v1 prologue schema, so it stays opaque`);
        let hex = '';
        for (const byte of frame.payload) hex += byte.toString(16).padStart(2, '0');
        assert.equal(hex, expected.payloadHex, `${label}: opaque payload`);
        continue;
      }

      assert.ok(golden, `${label}: needs either a vector reference or prologue: null`);
      assert.ok(message, `${label}: frame did not parse`);
      assert.deepEqual(message.prologue, golden.prologue, `${label}: prologue`);
      assert.equal(
        'segments' in message ? message.segments.length : 0,
        'segments' in golden ? golden.segments.length : 0,
        `${label}: segment count`,
      );
      assert.equal(
        message.body.byteLength,
        expected.bodyByteLength ?? golden.body.byteLength,
        `${label}: body byte length`,
      );
      // The truncation guard: payload must be accounted for exactly, with
      // nothing quietly dropped between the prologue and the body.
      assert.equal(
        frame.payload.byteLength,
        prologueBytes(frame.opcode)
          + SEGMENT_BYTES * ('segments' in message ? message.segments.length : 0)
          + message.body.byteLength,
        `${label}: payload must be exactly prologue + segments + body`,
      );
    }
  });
}

// ---------------------------------------------------------------------------
// 3b. The 0x04 prologue domain checks.
//
// The fixture carries no 0x04 fault entries, so nothing above exercises these —
// a mutant that bypasses the whole check survived the corpus. They matter more
// on this side than on the server's: a client that accepts a prologue its
// server would reject draws a screen the server never asserted.
// ---------------------------------------------------------------------------

const CHECKPOINT_START_FLAGS2_LOW_BYTE = FRAME_HEADER_BYTES + 75;
const SAVED_CURSOR_NON_NULL = 0x0008;
const LEASE_PRESENT = 0x0010;
const END_OF_BATCH_BIT = 0x0001;

function assertPrologueRejected(
  vectorName: string,
  cases: ReadonlyArray<readonly [string, (bytes: Uint8Array, view: DataView) => void]>,
): void {
  const base = hexToBytes(vectorByName(vectorName).hexFrame);

  const control = decodeWsMessage(base.slice(), buildContext());
  assert.deepEqual(control.scoped, [], `control: ${vectorName} must decode cleanly unmutated`);
  assert.equal(control.frames.length, 1, `control: ${vectorName} must yield a frame`);

  for (const [label, edit] of cases) {
    const bytes = base.slice();
    edit(bytes, new DataView(bytes.buffer, bytes.byteOffset));
    const result = decodeWsMessage(bytes, buildContext());
    assert.equal(result.scoped[0]?.code, 'prologue-domain-violation', label);
    assert.equal(result.scoped[0]?.grade, 'scoped', `${label} must stay scoped`);
    assert.equal(result.fatal, undefined, `${label} must not discard the batch`);
    assert.equal(result.frames.length, 0, `${label} must not yield a frame`);
  }
}

test('0x04 value-domain violations are rejected, scoped', () => {
  const at = (offset: number) => FRAME_HEADER_BYTES + offset;
  // rollback carries RETAINED_STATE_PRESENT, so retained fields are in play and
  // a mutation to off 78 trips the range clause rather than the presence one.
  assertPrologueRejected('checkpoint-start-rollback-228', [
    ['chunkCount 0', (_b, v) => v.setUint32(at(12), 0)],
    ['cols 0', (_b, v) => v.setUint16(at(68), 0)],
    ['rows 0', (_b, v) => v.setUint16(at(70), 0)],
    ['retainedActiveBuffer 2', b => { b[at(78)] = 2; }],
    ['modesValueMask outside modesPresentMask', b => { b[at(76)] = 0x01; b[at(77)] = 0x02; }],
    ['flags2 reserved bit', b => { b[at(74)] |= 0x01; }],
    ['reserved byte at off 79', b => { b[at(79)] = 1; }],
  ]);
});

test('0x04 lease-slot violations are rejected, scoped', () => {
  const at = (offset: number) => FRAME_HEADER_BYTES + offset;
  assertPrologueRejected('checkpoint-start-rollback-228', [
    ['lease length past the bound', b => { b[at(160)] = 39; }],
    // The slot must be cleared too: leaving the old bytes lets the padding
    // clause fire instead, which would pin nothing.
    ['declared present with zero length', b => { b[at(160)] = 0; b.fill(0, at(161), at(200)); }],
    ['populated without the presence bit', b => { b[CHECKPOINT_START_FLAGS2_LOW_BYTE] &= ~LEASE_PRESENT; }],
    ['padding is not zero-filled', b => { b[at(199)] = 1; }],
    ['lease bytes are not valid UTF-8', b => { b[at(161)] = 0xff; }],
  ]);
});

test('0x04 rejects a cleared presence bit whose field carries a value', () => {
  const at = (offset: number) => FRAME_HEADER_BYTES + offset;
  // promotion has every presence bit clear, so setting any gated field is a
  // single-cause contradiction.
  assertPrologueRejected('checkpoint-start-promotion-228', [
    ['transitionEpoch without TRANSITION_EPOCH_PRESENT', (_b, v) => v.setUint32(at(52), 99)],
    ['boundarySourceSeq without BOUNDARY_SOURCE_SEQ_PRESENT', (_b, v) => v.setUint32(at(60), 41)],
    ['retainedActiveBuffer without RETAINED_STATE_PRESENT', b => { b[at(78)] = 1; }],
    ['retainedStateDigest without RETAINED_STATE_PRESENT', b => { b[at(128)] = 0xab; }],
    ['retainedSavedCursorX without SAVED_CURSOR_NON_NULL', (_b, v) => v.setUint32(at(88), 7)],
    ['retainedSavedCursorY without SAVED_CURSOR_NON_NULL', (_b, v) => v.setUint32(at(92), 7)],
    ['SAVED_CURSOR_NON_NULL without RETAINED_STATE_PRESENT',
      b => { b[CHECKPOINT_START_FLAGS2_LOW_BYTE] |= SAVED_CURSOR_NON_NULL; }],
  ]);
});

test('a rejected 0x04 prologue costs only its own frame', () => {
  // The grading claim, driven rather than asserted about: a violation mid-batch
  // must leave the sibling frame decodable.
  const rollback = hexToBytes(vectorByName('checkpoint-start-rollback-228').hexFrame);
  const tail = hexToBytes(vectorByName('output-minimal-52').hexFrame);

  // rollback currently terminates its own batch; clear END_OF_BATCH so it can
  // precede another frame, and let the OUTPUT frame terminate instead.
  const head = rollback.slice();
  const headView = new DataView(head.buffer, head.byteOffset);
  headView.setUint16(2, headView.getUint16(2) & ~END_OF_BATCH_BIT);
  const batch = new Uint8Array(head.byteLength + tail.byteLength);
  batch.set(head, 0);
  batch.set(tail, head.byteLength);

  const clean = decodeWsMessage(batch.slice(), buildContext());
  assert.equal(clean.frames.length, 2, 'control: both frames decode before the mutation');

  const broken = batch.slice();
  broken[FRAME_HEADER_BYTES + 79] = 1;
  const result = decodeWsMessage(broken, buildContext());
  assert.equal(result.scoped[0]?.code, 'prologue-domain-violation');
  assert.equal(result.fatal, undefined);
  assert.equal(result.frames.length, 1, 'the sibling frame must survive');
  assert.equal(result.frames[0]?.opcode, DATA_PLANE_OPCODE.OUTPUT);
});

// ---------------------------------------------------------------------------
// 4. The client-side budget (08 §5.5).
// ---------------------------------------------------------------------------

test('the client body budget is derived from the visible output queue cap', () => {
  // Not a new constant: PERF-BGSTAB-010 AC-4 forbids introducing one.
  assert.equal(deriveMaxBodyBytes({ visibleOutputQueueMaxBytes: 4_194_304 }), 4_194_304);
  assert.equal(deriveMaxBodyBytes({ visibleOutputQueueMaxBytes: 1024 }), 1024);

  // The configured range is [1024, 268_435_456]; anything outside it is a
  // programming error, not a frame to decode against.
  assert.throws(() => deriveMaxBodyBytes({ visibleOutputQueueMaxBytes: 0 }), /positive/u);
  assert.throws(() => deriveMaxBodyBytes({ visibleOutputQueueMaxBytes: -1 }), /positive/u);
  assert.throws(() => deriveMaxBodyBytes({ visibleOutputQueueMaxBytes: 1.5 }), /positive/u);
});

test('a client budget tighter than the server drops the frame but keeps the batch', () => {
  // 08 §5.5 pins this deliberately: with visibleOutputQueueMaxBytes at its floor
  // a legitimate server frame can exceed the client budget. That IS the intended
  // behaviour -- decoding a frame that cannot enter the queue is pointless -- but
  // it must stay scoped so the rest of the WS message survives.
  const batch = hexToBytes(vectorByName('batch-two-output-frames-106').hexFrame);
  const tight = buildContext(undefined, deriveMaxBodyBytes({ visibleOutputQueueMaxBytes: 1024 }));

  const roomy = decodeWsMessage(batch.slice(), buildContext());
  assert.equal(roomy.frames.length, 2, 'control: both frames decode under the default budget');

  // Same bytes, tighter budget: the oversized frame is dropped, its sibling is not.
  const oversized = hexToBytes(vectorByName('output-utf8-body-60').hexFrame);
  const padded = new Uint8Array(oversized.byteLength + 2048);
  padded.set(oversized, 0);
  new DataView(padded.buffer).setUint32(24, padded.byteLength - FRAME_HEADER_BYTES);
  const result = decodeWsMessage(padded, tight);
  assert.equal(result.scoped[0]?.code, 'payload-limit-exceeded');
  assert.equal(result.scoped[0]?.grade, 'scoped');
  assert.equal(result.fatal, undefined, 'an oversized frame must not discard the batch');
});

// ---------------------------------------------------------------------------
// 5. Channel state, from the fixture's own table (5 = retired).
// ---------------------------------------------------------------------------

test('a retired channel is dropped observably, an unknown one is scoped', () => {
  assert.equal(fixture.defaultContext.channels['5'], 'retired', 'fixture premise');

  const base = hexToBytes(vectorByName('output-minimal-52').hexFrame);
  const retired = base.slice();
  new DataView(retired.buffer, retired.byteOffset).setUint32(4, 5);
  const retiredResult = decodeWsMessage(retired, buildContext());
  assert.equal(retiredResult.frames.length, 0, 'a retired channel yields no frames');
  assert.deepEqual(retiredResult.scoped, [], 'and it is not a rejection');
  assert.equal(retiredResult.diagnostics[0]?.event, 'terminal_binary_retired_channel_frame');
  assert.equal(retiredResult.diagnostics[0]?.channelId, 5);

  const unknown = base.slice();
  new DataView(unknown.buffer, unknown.byteOffset).setUint32(4, 9);
  const unknownResult = decodeWsMessage(unknown, buildContext());
  assert.equal(unknownResult.scoped[0]?.code, 'unknown-channel');
  assert.equal(unknownResult.scoped[0]?.channelId, 9);
  assert.equal(unknownResult.fatal, undefined);
});

test('decode returns views into the caller buffer and never mutates it', () => {
  const bytes = hexToBytes(vectorByName('output-utf8-body-60').hexFrame);
  const before = bytes.slice();
  const result = decodeWsMessage(bytes, buildContext());

  assert.deepEqual(bytes, before, 'the input buffer must be untouched');
  assert.equal(result.frames[0]?.payload.buffer, bytes.buffer, 'payload must be a view, not a copy');
});
