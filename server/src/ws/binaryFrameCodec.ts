/**
 * Binary terminal data-plane frame codec (v1).
 *
 * Frame contract: docs/research/binary-comms/01-frame-format-and-negotiation.md
 *   - header byte offsets            01:45-52   (28 B fixed, big-endian)
 *   - flag bits and mask algebra     01:71-93
 *   - opcode space                   01:156-171
 *   - prologues                      01:488-526
 *   - rejection codes                01:932-943
 *   - fatal / scoped grading         01:953-960
 *   - reference decoder / encoder    01 appendix B, B2
 *
 * This module is deliberately standalone: S2 builds the codec only and wires
 * nothing, so that the fair-scheduler provenance-pinned files (wsSendPolicy.ts,
 * WsRouter.ts) keep a zero diff.
 *
 * Two layers:
 *   frame layer   decodeWsMessage / encodeFrame / encodeBatch — header + opaque
 *                 payload, exactly what appendix B specifies.
 *   message layer parseFrameMessage — opcode-specific prologue, segment array
 *                 and body. Only opcodes with a v1 prologue schema (0x01, 0x02,
 *                 0x05) have one; every other known opcode stays opaque.
 */

import { isCanonicalOrdinal64, type Ordinal64 } from '../types/ws-protocol.js';

// ---------------------------------------------------------------------------
// Header and flag constants — 01:41-93
// ---------------------------------------------------------------------------

export const FRAME_HEADER_BYTES = 28;
export const FRAME_VERSION_V1 = 0x01;
export const SEGMENT_BYTES = 16;

export const FLAG_END_OF_BATCH = 0x0001;
export const FLAG_PAYLOAD_UTF8_TEXT = 0x0002;
export const FLAG_PROLOGUE_PRESENT = 0x0008;

/** bit0 | bit3 — structural, never negotiable (01:81-84). */
export const MANDATORY_FLAGS = FLAG_END_OF_BATCH | FLAG_PROLOGUE_PRESENT;
/** bit1 only in v1 (01:85). */
export const NEGOTIABLE_FLAGS_V1 = FLAG_PAYLOAD_UTF8_TEXT;
/** 0x000B — bit2 and bit4-15 fall outside it and are rejected (01:86-91). */
export const ACTIVE_FLAG_MASK_V1 = MANDATORY_FLAGS | NEGOTIABLE_FLAGS_V1;

// ---------------------------------------------------------------------------
// Opcode space — 01:156-171, decision D9 (06 §3.5)
// ---------------------------------------------------------------------------

export const DATA_PLANE_OPCODE = {
  OUTPUT: 0x01,
  SCREEN_SNAPSHOT: 0x02,
  SCREEN_REPAIR: 0x03,
  CHECKPOINT_START: 0x04,
  CHECKPOINT_CHUNK: 0x05,
  CHECKPOINT_COMMIT: 0x06,
  CHECKPOINT_OUTPUT: 0x07,
} as const;

/** Reserved; v1 never sends it (01:169). */
export const OPCODE_JSON_ENVELOPE = 0x80;

/**
 * Hand-maintained, server -> client only.
 *
 * Do NOT generate this from `ServerWsMessage`: that union is not the complete
 * wire list (01:129-152 — the `terminal-authority:*` family is absent from it),
 * and `screen-repair` carries a different payload shape in each direction
 * (ScreenRepairRequestMessage vs ScreenRepairMessage), so a direction-blind
 * table folds two types into one opcode (01:173, 06 §5 S2-c / S2-d).
 */
export const SERVER_TO_CLIENT_OPCODE_BY_TYPE: Readonly<Record<string, number>> = Object.freeze({
  output: DATA_PLANE_OPCODE.OUTPUT,
  'screen-snapshot': DATA_PLANE_OPCODE.SCREEN_SNAPSHOT,
  'screen-repair': DATA_PLANE_OPCODE.SCREEN_REPAIR,
  'terminal-checkpoint:start': DATA_PLANE_OPCODE.CHECKPOINT_START,
  'terminal-checkpoint:chunk': DATA_PLANE_OPCODE.CHECKPOINT_CHUNK,
  'terminal-checkpoint:commit': DATA_PLANE_OPCODE.CHECKPOINT_COMMIT,
  'terminal-checkpoint:output': DATA_PLANE_OPCODE.CHECKPOINT_OUTPUT,
});

/** Empty in v1: every client -> server message stays on the JSON plane (01:173). */
export const CLIENT_TO_SERVER_OPCODE_BY_TYPE: Readonly<Record<string, number>> = Object.freeze({});

export type OpcodeSpace =
  | 'permanently-reserved'
  | 'assigned'
  | 'reserved-data-plane'
  | 'vendor'
  | 'json-envelope-reserved'
  | 'unassigned';

export function opcodeSpace(opcode: number): OpcodeSpace {
  assertUint(opcode, 8, 'opcode');
  if (opcode === 0x00 || opcode === 0xff) return 'permanently-reserved';
  if (opcode <= 0x07) return 'assigned';
  if (opcode <= 0x3f) return 'reserved-data-plane';
  if (opcode <= 0x7f) return 'vendor';
  if (opcode === OPCODE_JSON_ENVELOPE) return 'json-envelope-reserved';
  return 'unassigned';
}

export function isKnownOpcode(opcode: number): boolean {
  return opcodeSpace(opcode) === 'assigned';
}

/**
 * 0x04's lease slot (07 §2.6.1). Fixed width so `prologueBytes` stays a pure
 * function of opcode — 01:108 and 01:518 rest the D14 safety argument on exactly
 * that, and a length-prefixed encoding would have to read payload bytes to size
 * the prologue.
 *
 * 38 is derived, not chosen: `responder-browser-` is 18 bytes
 * (TerminalAuthorityProductionAdapter.ts:4435) and an Ordinal64 is at most 20
 * decimal digits. The bound survives `nextOrdinal` having no upper clamp
 * (Adapter.ts:918-920) because 2^64 is still 20 digits.
 */
export const RESPONDER_LEASE_ID_MAX_BYTES = 38;
const RESPONDER_LEASE_ID_SLOT_BYTES = 39;
const CHECKPOINT_START_PROLOGUE_BYTES = 200;

/** 07 §2.9 flags2 bit table. Each declares which prologue offsets carry a value. */
const FLAGS2_RETAINED_STATE_PRESENT = 0x0001;
const FLAGS2_TRANSITION_EPOCH_PRESENT = 0x0002;
const FLAGS2_BOUNDARY_SOURCE_SEQ_PRESENT = 0x0004;
const FLAGS2_SAVED_CURSOR_NON_NULL = 0x0008;
/** 07 §2.6.1. Declares off 160/161 valid; it never changes the prologue's size. */
export const FLAGS2_RESPONDER_LEASE_ID_PRESENT = 0x0010;
/** bits 5-15 stay reserved; bit4 was the last free one 07 had set aside. */
const CHECKPOINT_START_FLAGS2_RESERVED_MASK = 0xffe0;

/** Prologue size in bytes. 0 means "no v1 prologue schema" (01 §1.8 defines 0x01/0x02/0x05 only). */
export function prologueBytes(opcode: number): number {
  switch (opcode) {
    case DATA_PLANE_OPCODE.OUTPUT:
    case DATA_PLANE_OPCODE.SCREEN_SNAPSHOT:
      return 24;
    case DATA_PLANE_OPCODE.CHECKPOINT_CHUNK:
      return 12;
    case DATA_PLANE_OPCODE.CHECKPOINT_START:
      return CHECKPOINT_START_PROLOGUE_BYTES;
    default:
      return 0;
  }
}

// ---------------------------------------------------------------------------
// Rejection codes and grading — 01:932-960
// ---------------------------------------------------------------------------

/** The complete wire rejection vocabulary (01:934-943). Ten codes, no more. */
export const WIRE_REJECTION_CODES = Object.freeze([
  'binary-frame-on-json-group',
  'truncated-header',
  'bad-frame-version',
  'unknown-opcode',
  'reserved-flag-set',
  'reserved-channel',
  'unknown-channel',
  'length-overrun',
  'batch-terminated-early',
  'batch-not-terminated',
] as const);

export type WireRejectionCode = (typeof WIRE_REJECTION_CODES)[number];

/**
 * Decoder-emitted codes that are NOT part of the frozen wire vocabulary above.
 *
 * Membership rule: `01:934-943` has no code for the condition, yet it must be
 * rejected. Keeping these out of `WIRE_REJECTION_CODES` is what lets that list
 * stay a verbatim mirror of the spec text, so the inventory test compares the
 * implementation against `01` rather than against itself.
 *
 *   payload-underrun       the declared payloadLength cannot hold the mandatory
 *                          prologue (+ segment array). PROLOGUE_PRESENT is a
 *                          MANDATORY flag (01:84), so an OUTPUT frame declaring
 *                          payloadLength = 0 is not "an empty body", it is a
 *                          frame with no prologue (06 §5 S2-b, P7 correction).
 *   payload-limit-exceeded bodyBytes exceeds the policy bound. Kept separate
 *                          from length-overrun on purpose: if the two shared a
 *                          code, F5 would be measuring F2 (06 §5 S2-b F5 note).
 *   mandatory-flag-cleared a frame that carries a prologue declares
 *                          PROLOGUE_PRESENT = 0 (06 §5 S2-g, D14). Not folded
 *                          into `reserved-flag-set`: that code means a bit
 *                          OUTSIDE the mask was set, and this is a bit INSIDE it
 *                          being cleared, so sharing it would invert the
 *                          diagnostic and blur F10's fault against its control.
 *
 * They are graded differently, by 01:953-958's own rule rather than by which
 * list they sit in — see `rejectionGrade`. The vocabulary gap itself is a spec
 * item for the negotiation work, not something this module invents wire codes
 * for.
 */
export const DECODER_POLICY_CODES = Object.freeze([
  'payload-underrun',
  'payload-limit-exceeded',
  'mandatory-flag-cleared',
  'prologue-domain-violation',
] as const);

export type DecoderPolicyCode = (typeof DECODER_POLICY_CODES)[number];
export type DecodeRejectionCode = WireRejectionCode | DecoderPolicyCode;
export type RejectionGrade = 'fatal' | 'scoped';

/**
 * 01:957 defines fatal by a property, not by a list: "framing itself cannot be
 * trusted, so every offset past this point is meaningless". The grade follows
 * that property.
 *
 *   unknown-channel        framing is sound, only that channel is in doubt
 *                          (01:958) — the code 01 itself grades scoped.
 *   payload-limit-exceeded framing is sound too: `payloadLength` agrees with
 *                          the buffer (exactly what separates it from
 *                          length-overrun), so `frameEnd` is known and the
 *                          batch resumes. Grading it fatal would discard every
 *                          later frame of the same WS message, which is the
 *                          loss pattern 01:951 argues against.
 *
 * `payload-underrun` stays fatal: there the declared length is itself not
 * believable, so the frame boundary it implies cannot be trusted either.
 *
 * `mandatory-flag-cleared` is fatal even though `frameEnd` IS knowable (the
 * opcode gives the layout, not bit3). The property in 01:957 is about what the
 * receiver can still trust, and here that is not one offset but the peer's
 * encoder as a whole — the remedy is connection-level renegotiation, so there
 * is nothing to be gained by resuming the batch (06 §5 S2-g, D14).
 */
export function rejectionGrade(code: DecodeRejectionCode): RejectionGrade {
  if (
    code === 'unknown-channel'
    || code === 'payload-limit-exceeded'
    || code === 'prologue-domain-violation'
  ) {
    // Scoped for the same reason as payload-limit-exceeded: `payloadLength`
    // agrees with the buffer, so `frameEnd` is trustworthy and only this frame is
    // in doubt. The prologue's CONTENT is wrong, not the framing.
    return 'scoped';
  }
  if ((WIRE_REJECTION_CODES as readonly string[]).includes(code)) return 'fatal';
  if ((DECODER_POLICY_CODES as readonly string[]).includes(code)) return 'fatal';
  throw new RangeError(`unknown rejection code: ${String(code)}`);
}

// ---------------------------------------------------------------------------
// Decode context
// ---------------------------------------------------------------------------

export type ChannelState = 'active' | 'retired';

export interface BinaryDecodeContext {
  readonly codec: 'json' | 'binary';
  readonly frameVersion: number;
  readonly activeFlagMask: number;
  /** Upper bound on body bytes. Derive it — never introduce a new policy constant. */
  readonly maxBodyBytes: number;
  /** `undefined` means FREE or never seen (01:401). */
  channelState(channelId: number): ChannelState | undefined;
}

/**
 * Derives the decoder's body-byte bound from existing configuration.
 *
 * `PERF-BGSTAB-010` AC-4 forbids new policy constants (01:397, 01:477), so the
 * bound is the configured PTY snapshot bound (`config.schema.ts:77`, itself
 * `maxSnapshotBytes ?? maxBufferSize ?? 2097152`). The bound applies to the
 * bodyBytes domain, not payloadLength: prologue size varies per opcode, so
 * bounding payloadLength would let one policy value admit different amounts of
 * application data per opcode.
 */
export function deriveMaxBodyBytes(pty: { maxSnapshotBytes: number }): number {
  const bound = pty?.maxSnapshotBytes;
  if (!Number.isSafeInteger(bound) || bound <= 0) {
    throw new RangeError('maxSnapshotBytes must be a positive safe integer');
  }
  return bound;
}

export function createV1DecodeContext(input: {
  codec?: 'json' | 'binary';
  maxBodyBytes: number;
  channelState(channelId: number): ChannelState | undefined;
}): BinaryDecodeContext {
  if (!Number.isSafeInteger(input.maxBodyBytes) || input.maxBodyBytes <= 0) {
    throw new RangeError('maxBodyBytes must be a positive safe integer');
  }
  return Object.freeze({
    codec: input.codec ?? 'binary',
    frameVersion: FRAME_VERSION_V1,
    activeFlagMask: ACTIVE_FLAG_MASK_V1,
    maxBodyBytes: input.maxBodyBytes,
    channelState: input.channelState,
  });
}

// ---------------------------------------------------------------------------
// Decode result shapes
// ---------------------------------------------------------------------------

export interface DecodedFrame {
  frameVersion: number;
  opcode: number;
  flags: number;
  channelId: number;
  streamEpoch: Ordinal64;
  sourceSeq: Ordinal64;
  /** A view into the input buffer — never a copy (01:1310). */
  payload: Uint8Array;
  frameOffset: number;
}

export interface DecodeRejection {
  code: DecodeRejectionCode;
  grade: RejectionGrade;
  frameOffset: number;
  channelId?: number;
  /**
   * Diagnostic metadata, not a code. `0x00` / `0xFF` frameVersion values are
   * far more likely to be a zero-filled or 0xFF-filled buffer than a genuine
   * negotiation mismatch, but 01:934-943 has no separate code for them, so the
   * distinction is recorded here (06 §5 S2-b F9 note, decided).
   */
  detail?: string;
}

export interface DecodeDiagnostic {
  event: 'terminal_binary_retired_channel_frame';
  channelId: number;
  frameOffset: number;
}

export interface DecodeResult {
  frames: DecodedFrame[];
  fatal?: DecodeRejection;
  scoped: DecodeRejection[];
  diagnostics: DecodeDiagnostic[];
}

// ---------------------------------------------------------------------------
// Message layer shapes
// ---------------------------------------------------------------------------

export interface OutputPrologue {
  screenSeq: Ordinal64;
  chunkIdBase: Ordinal64;
  authorityRevision: number;
  authorityEpochIndex: number;
}

export interface OutputSegment {
  byteStart: number;
  byteEnd: number;
  screenSeqDelta: number;
  authorityRevisionDelta: number;
  chunkIdDelta: number;
}

export interface SnapshotPrologue {
  seq: Ordinal64;
  cols: number;
  rows: number;
  mode: number;
  truncated: number;
  flags2: number;
  authorityRevision: number;
  authorityEpochIndex: number;
  replayTokenIndex: number;
}

/**
 * 07 §2.9 plus the lease slot of §2.6.1. Offsets 0..159 are §2.9 verbatim.
 *
 * `responderLeaseId` is optional here and the ABSENCE MUST BE A MISSING KEY, not
 * an empty string. `''` would satisfy the client's own comparison
 * (terminalCheckpointRuntime.ts:522, `'' === ''`) and then be echoed back and
 * rejected server-side at TerminalAuthorityProductionAdapter.ts:790 against an
 * `undefined` record -- failing after the local check passed, which is the worst
 * diagnostic path available. `flags2` bit4 and this field are cross-checked on
 * both encode and decode so they can never disagree.
 */
export interface CheckpointStartPrologue {
  checkpointSourceSeq: Ordinal64;
  viewGeneration: number;
  chunkCount: number;
  checkpointStreamEpoch: Ordinal64;
  checkpointEpoch: Ordinal64;
  snapshotSeq: Ordinal64;
  oldestRetainedSeq: Ordinal64;
  transitionEpoch: Ordinal64;
  boundarySourceSeq: Ordinal64;
  encodedByteTotal: number;
  cols: number;
  rows: number;
  authorityEpochIndex: number;
  flags2: number;
  modesPresentMask: number;
  modesValueMask: number;
  retainedActiveBuffer: number;
  retainedCursorX: number;
  retainedCursorY: number;
  retainedSavedCursorX: number;
  retainedSavedCursorY: number;
  digest: Uint8Array;
  retainedStateDigest: Uint8Array;
  responderLeaseId?: string;
}

export interface CheckpointChunkPrologue {
  chunkIndex: number;
  chunkCount: number;
  viewGeneration: number;
}

interface FrameHead {
  flags: number;
  channelId: number;
  streamEpoch: Ordinal64;
  sourceSeq: Ordinal64;
}

export interface OutputWireMessage extends FrameHead {
  opcode: typeof DATA_PLANE_OPCODE.OUTPUT;
  prologue: OutputPrologue;
  segments: OutputSegment[];
  body: Uint8Array;
}

export interface SnapshotWireMessage extends FrameHead {
  opcode: typeof DATA_PLANE_OPCODE.SCREEN_SNAPSHOT;
  prologue: SnapshotPrologue;
  body: Uint8Array;
}

export interface CheckpointChunkWireMessage extends FrameHead {
  opcode: typeof DATA_PLANE_OPCODE.CHECKPOINT_CHUNK;
  prologue: CheckpointChunkPrologue;
  body: Uint8Array;
}

export interface CheckpointStartWireMessage extends FrameHead {
  opcode: typeof DATA_PLANE_OPCODE.CHECKPOINT_START;
  prologue: CheckpointStartPrologue;
  body: Uint8Array;
}

export type BinaryWireMessage =
  | OutputWireMessage
  | SnapshotWireMessage
  | CheckpointStartWireMessage
  | CheckpointChunkWireMessage;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function assertUint(value: number, bits: 8 | 16 | 32, field: string): void {
  const max = bits === 32 ? 0xffffffff : bits === 16 ? 0xffff : 0xff;
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new RangeError(`${field} must be a uint${bits} (0..${max}), received ${String(value)}`);
  }
}

/**
 * `Ordinal64` is a bare `string` alias, not a branded type (ws-protocol.ts:16),
 * so the compiler cannot stop a wrong assignment. The encoder asserts at its
 * entry point instead (01:1374-1378, 06 §5 S2-f).
 */
function assertOrdinal64(value: unknown, field: string): asserts value is Ordinal64 {
  if (!isCanonicalOrdinal64(value)) {
    throw new RangeError(`${field} must be a canonical Ordinal64 decimal string, received ${String(value)}`);
  }
}

function readOrdinal64(view: DataView, offset: number): Ordinal64 {
  const hi = view.getUint32(offset);
  const lo = view.getUint32(offset + 4);
  // 2^32 shortcut: no BigInt allocation for the overwhelmingly common case.
  if (hi === 0) return String(lo);
  return (((BigInt(hi) << 32n) | BigInt(lo))).toString(10);
}

function writeOrdinal64(view: DataView, offset: number, value: Ordinal64): void {
  view.setBigUint64(offset, BigInt(value));
}

function segmentsOf(message: BinaryWireMessage): OutputSegment[] {
  return message.opcode === DATA_PLANE_OPCODE.OUTPUT ? message.segments : [];
}

// ---------------------------------------------------------------------------
// Encoder
// ---------------------------------------------------------------------------

/**
 * The flags an encoder sets for a given opcode (01 appendix B2:1383-1385).
 * PAYLOAD_UTF8_TEXT is set for OUTPUT only: its body is always a UTF-8 encoded
 * JS string, so the bit costs no validation scan (01:123).
 */
export function defaultFlagsForOpcode(opcode: number, options: { endOfBatch: boolean }): number {
  let flags = FLAG_PROLOGUE_PRESENT;
  if (opcode === DATA_PLANE_OPCODE.OUTPUT) flags |= FLAG_PAYLOAD_UTF8_TEXT;
  if (options.endOfBatch) flags |= FLAG_END_OF_BATCH;
  return flags & ACTIVE_FLAG_MASK_V1;
}

/** 28 + prologueBytes + 16 * segmentCount + bodyBytes (06 §5 S2-b, P2). */
export function frameByteLength(message: BinaryWireMessage): number {
  return (
    FRAME_HEADER_BYTES +
    prologueBytes(message.opcode) +
    SEGMENT_BYTES * segmentsOf(message).length +
    message.body.byteLength
  );
}

function assertEncodableHead(message: BinaryWireMessage): void {
  if (prologueBytes(message.opcode) === 0) {
    throw new RangeError(
      `opcode 0x${message.opcode.toString(16).padStart(2, '0')} has no v1 prologue schema and cannot be encoded`,
    );
  }

  assertUint(message.flags, 16, 'flags');
  if ((message.flags & ~ACTIVE_FLAG_MASK_V1) !== 0) {
    throw new RangeError(
      `flags 0x${message.flags.toString(16)} sets bits outside the v1 activeFlagMask 0x${ACTIVE_FLAG_MASK_V1.toString(16)}`,
    );
  }
  if ((message.flags & FLAG_PROLOGUE_PRESENT) === 0) {
    throw new RangeError('PROLOGUE_PRESENT is mandatory and cannot be cleared');
  }

  assertUint(message.channelId, 32, 'channelId');
  if (message.channelId === 0) {
    throw new RangeError('channelId 0 is permanently reserved and must never be encoded');
  }

  assertOrdinal64(message.streamEpoch, 'streamEpoch');
  assertOrdinal64(message.sourceSeq, 'sourceSeq');
}

const utf8Encoder = new TextEncoder();
/** fatal, not lenient: a replacement char would silently change the echoed
 * string and be rejected far away at Adapter.ts:790 instead of here. */
const utf8StrictDecoder = new TextDecoder('utf-8', { fatal: true });

function assertDigest32(value: Uint8Array, label: string): void {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) {
    throw new RangeError(`${label} must be exactly 32 bytes`);
  }
}

/**
 * The presence bit and the field are two spellings of one fact. Letting them
 * disagree is how `undefined` and `''` start to blur, so this refuses both
 * directions rather than trusting either as authoritative.
 */
function encodeResponderLeaseId(prologue: CheckpointStartPrologue): Uint8Array {
  const declared = (prologue.flags2 & FLAGS2_RESPONDER_LEASE_ID_PRESENT) !== 0;
  const present = prologue.responderLeaseId !== undefined;
  if (declared !== present) {
    throw new RangeError(
      'flags2 RESPONDER_LEASE_ID_PRESENT must agree with prologue.responderLeaseId',
    );
  }
  if (!present) return new Uint8Array(0);

  const bytes = utf8Encoder.encode(prologue.responderLeaseId);
  if (bytes.byteLength === 0) {
    throw new RangeError('prologue.responderLeaseId must not be empty when present');
  }
  if (bytes.byteLength > RESPONDER_LEASE_ID_MAX_BYTES) {
    throw new RangeError(
      `prologue.responderLeaseId is ${bytes.byteLength} bytes, over the ${RESPONDER_LEASE_ID_MAX_BYTES}-byte bound`,
    );
  }
  return bytes;
}

function writePrologue(view: DataView, at: number, message: BinaryWireMessage): void {
  if (message.opcode === DATA_PLANE_OPCODE.OUTPUT) {
    const { prologue, segments } = message;
    assertOrdinal64(prologue.screenSeq, 'prologue.screenSeq');
    assertOrdinal64(prologue.chunkIdBase, 'prologue.chunkIdBase');
    assertUint(prologue.authorityRevision, 32, 'prologue.authorityRevision');
    assertUint(prologue.authorityEpochIndex, 16, 'prologue.authorityEpochIndex');
    assertUint(segments.length, 16, 'prologue.segmentCount');

    writeOrdinal64(view, at + 0, prologue.screenSeq);
    writeOrdinal64(view, at + 8, prologue.chunkIdBase);
    view.setUint32(at + 16, prologue.authorityRevision);
    view.setUint16(at + 20, prologue.authorityEpochIndex);
    view.setUint16(at + 22, segments.length);

    segments.forEach((segment, index) => {
      const base = at + 24 + index * SEGMENT_BYTES;
      assertUint(segment.byteStart, 32, `segments[${index}].byteStart`);
      assertUint(segment.byteEnd, 32, `segments[${index}].byteEnd`);
      assertUint(segment.screenSeqDelta, 32, `segments[${index}].screenSeqDelta`);
      assertUint(segment.authorityRevisionDelta, 16, `segments[${index}].authorityRevisionDelta`);
      assertUint(segment.chunkIdDelta, 16, `segments[${index}].chunkIdDelta`);
      view.setUint32(base + 0, segment.byteStart);
      view.setUint32(base + 4, segment.byteEnd);
      view.setUint32(base + 8, segment.screenSeqDelta);
      view.setUint16(base + 12, segment.authorityRevisionDelta);
      view.setUint16(base + 14, segment.chunkIdDelta);
    });
    return;
  }

  if (message.opcode === DATA_PLANE_OPCODE.SCREEN_SNAPSHOT) {
    const p = message.prologue;
    assertOrdinal64(p.seq, 'prologue.seq');
    assertUint(p.cols, 16, 'prologue.cols');
    assertUint(p.rows, 16, 'prologue.rows');
    assertUint(p.mode, 8, 'prologue.mode');
    assertUint(p.truncated, 8, 'prologue.truncated');
    assertUint(p.flags2, 16, 'prologue.flags2');
    assertUint(p.authorityRevision, 32, 'prologue.authorityRevision');
    assertUint(p.authorityEpochIndex, 16, 'prologue.authorityEpochIndex');
    assertUint(p.replayTokenIndex, 16, 'prologue.replayTokenIndex');

    writeOrdinal64(view, at + 0, p.seq);
    view.setUint16(at + 8, p.cols);
    view.setUint16(at + 10, p.rows);
    view.setUint8(at + 12, p.mode);
    view.setUint8(at + 13, p.truncated);
    view.setUint16(at + 14, p.flags2);
    view.setUint32(at + 16, p.authorityRevision);
    view.setUint16(at + 20, p.authorityEpochIndex);
    view.setUint16(at + 22, p.replayTokenIndex);
    return;
  }

  if (message.opcode === DATA_PLANE_OPCODE.CHECKPOINT_START) {
    const p = message.prologue;
    const lease = encodeResponderLeaseId(p);

    assertOrdinal64(p.checkpointSourceSeq, 'prologue.checkpointSourceSeq');
    assertOrdinal64(p.checkpointStreamEpoch, 'prologue.checkpointStreamEpoch');
    assertOrdinal64(p.checkpointEpoch, 'prologue.checkpointEpoch');
    assertOrdinal64(p.snapshotSeq, 'prologue.snapshotSeq');
    assertOrdinal64(p.oldestRetainedSeq, 'prologue.oldestRetainedSeq');
    assertOrdinal64(p.transitionEpoch, 'prologue.transitionEpoch');
    assertOrdinal64(p.boundarySourceSeq, 'prologue.boundarySourceSeq');
    assertUint(p.viewGeneration, 32, 'prologue.viewGeneration');
    assertUint(p.chunkCount, 32, 'prologue.chunkCount');
    assertUint(p.encodedByteTotal, 32, 'prologue.encodedByteTotal');
    assertUint(p.cols, 16, 'prologue.cols');
    assertUint(p.rows, 16, 'prologue.rows');
    assertUint(p.authorityEpochIndex, 16, 'prologue.authorityEpochIndex');
    assertUint(p.flags2, 16, 'prologue.flags2');
    assertUint(p.modesPresentMask, 8, 'prologue.modesPresentMask');
    assertUint(p.modesValueMask, 8, 'prologue.modesValueMask');
    assertUint(p.retainedActiveBuffer, 8, 'prologue.retainedActiveBuffer');
    assertUint(p.retainedCursorX, 32, 'prologue.retainedCursorX');
    assertUint(p.retainedCursorY, 32, 'prologue.retainedCursorY');
    assertUint(p.retainedSavedCursorX, 32, 'prologue.retainedSavedCursorX');
    assertUint(p.retainedSavedCursorY, 32, 'prologue.retainedSavedCursorY');
    assertDigest32(p.digest, 'prologue.digest');
    assertDigest32(p.retainedStateDigest, 'prologue.retainedStateDigest');
    if ((p.flags2 & CHECKPOINT_START_FLAGS2_RESERVED_MASK) !== 0) {
      throw new RangeError(
        `prologue.flags2 0x${p.flags2.toString(16)} sets bits outside the v1 mask`,
      );
    }

    writeOrdinal64(view, at + 0, p.checkpointSourceSeq);
    view.setUint32(at + 8, p.viewGeneration);
    view.setUint32(at + 12, p.chunkCount);
    writeOrdinal64(view, at + 16, p.checkpointStreamEpoch);
    writeOrdinal64(view, at + 24, p.checkpointEpoch);
    writeOrdinal64(view, at + 32, p.snapshotSeq);
    writeOrdinal64(view, at + 40, p.oldestRetainedSeq);
    writeOrdinal64(view, at + 48, p.transitionEpoch);
    writeOrdinal64(view, at + 56, p.boundarySourceSeq);
    view.setUint32(at + 64, p.encodedByteTotal);
    view.setUint16(at + 68, p.cols);
    view.setUint16(at + 70, p.rows);
    view.setUint16(at + 72, p.authorityEpochIndex);
    view.setUint16(at + 74, p.flags2);
    view.setUint8(at + 76, p.modesPresentMask);
    view.setUint8(at + 77, p.modesValueMask);
    view.setUint8(at + 78, p.retainedActiveBuffer);
    view.setUint8(at + 79, 0);

    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    view.setUint32(at + 80, p.retainedCursorX);
    view.setUint32(at + 84, p.retainedCursorY);
    view.setUint32(at + 88, p.retainedSavedCursorX);
    view.setUint32(at + 92, p.retainedSavedCursorY);
    bytes.set(p.digest, at + 96);
    bytes.set(p.retainedStateDigest, at + 128);
    view.setUint8(at + 160, lease.byteLength);
    bytes.set(lease, at + 161);
    bytes.fill(0, at + 161 + lease.byteLength, at + 161 + RESPONDER_LEASE_ID_SLOT_BYTES);
    return;
  }

  const p = message.prologue;
  assertUint(p.chunkIndex, 32, 'prologue.chunkIndex');
  assertUint(p.chunkCount, 32, 'prologue.chunkCount');
  assertUint(p.viewGeneration, 32, 'prologue.viewGeneration');
  view.setUint32(at + 0, p.chunkIndex);
  view.setUint32(at + 4, p.chunkCount);
  view.setUint32(at + 8, p.viewGeneration);
}

export function encodeFrame(message: BinaryWireMessage): Uint8Array {
  assertEncodableHead(message);

  const payloadLength = frameByteLength(message) - FRAME_HEADER_BYTES;
  assertUint(payloadLength, 32, 'payloadLength');

  const bytes = new Uint8Array(FRAME_HEADER_BYTES + payloadLength);
  const view = new DataView(bytes.buffer);

  view.setUint8(0, FRAME_VERSION_V1);
  view.setUint8(1, message.opcode);
  view.setUint16(2, message.flags);
  view.setUint32(4, message.channelId);
  writeOrdinal64(view, 8, message.streamEpoch);
  writeOrdinal64(view, 16, message.sourceSeq);
  view.setUint32(24, payloadLength);

  writePrologue(view, FRAME_HEADER_BYTES, message);
  bytes.set(message.body, FRAME_HEADER_BYTES + prologueBytes(message.opcode) + SEGMENT_BYTES * segmentsOf(message).length);

  return bytes;
}

/**
 * One WS message = N complete frames (01:459). END_OF_BATCH belongs to the last
 * frame and only the last frame (01:75) — this function verifies that rather
 * than silently rewriting flags, so a caller that gets it wrong is red instead
 * of shipping a frame whose flags do not match what it believes it sent.
 */
export function encodeBatch(messages: readonly BinaryWireMessage[]): Uint8Array {
  if (messages.length === 0) throw new RangeError('cannot encode an empty batch');

  messages.forEach((message, index) => {
    const isLast = index === messages.length - 1;
    const hasEndOfBatch = (message.flags & FLAG_END_OF_BATCH) !== 0;
    if (isLast && !hasEndOfBatch) {
      throw new RangeError(`the last frame of a batch must set END_OF_BATCH (frame ${index})`);
    }
    if (!isLast && hasEndOfBatch) {
      throw new RangeError(`END_OF_BATCH must be set on the last frame only (frame ${index})`);
    }
  });

  const frames = messages.map(encodeFrame);
  const total = frames.reduce((sum, frame) => sum + frame.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const frame of frames) {
    out.set(frame, offset);
    offset += frame.byteLength;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Decoder — 01 appendix B
// ---------------------------------------------------------------------------

function reservedVersionDetail(version: number): string | undefined {
  if (version === 0x00) return 'reserved-frame-version-zero';
  if (version === 0xff) return 'reserved-frame-version-ff';
  return undefined;
}

/**
 * Decodes one WS message into its frames.
 *
 * A fatal rejection never discards the frames already parsed: 1 WS message is
 * N frames spanning several channels, so returning early would delete healthy
 * output from unrelated channels — the silent drop the issue AC forbids
 * (01:949-960). The caller dispatches `frames` first, then handles `fatal`.
 */
/**
 * Returns a reason when the 0x04 prologue is self-inconsistent, `undefined` when
 * it is sound. Every clause guards a way the lease slot could otherwise reach the
 * client as something other than what the server recorded.
 *
 * The reason is not surfaced today -- `DecodeDiagnostic` is a single-event type
 * and widening it for this would be a spec change. It stays as the clause's own
 * label so the call site reads as a decision rather than a boolean.
 */
function checkpointStartPrologueViolation(
  view: DataView,
  bytes: Uint8Array,
  at: number,
): string | undefined {
  const flags2 = view.getUint16(at + 74);
  if ((flags2 & CHECKPOINT_START_FLAGS2_RESERVED_MASK) !== 0) return 'flags2 reserved bit set';
  if (view.getUint8(at + 79) !== 0) return 'reserved byte at off 79 is not zero';

  // Value domains (07 section 2.11). These are the values the client's own
  // validator would reject one layer up: letting them through here turns a
  // framing fault into a whole-message `invalid-message` drop.
  if (view.getUint32(at + 12) === 0) return 'chunkCount must be positive';
  if (view.getUint16(at + 68) === 0 || view.getUint16(at + 70) === 0) {
    return 'cols and rows must be positive';
  }
  if (view.getUint8(at + 78) > 1) return 'retainedActiveBuffer is neither normal nor alternate';
  const modesPresentMask = view.getUint8(at + 76);
  if ((view.getUint8(at + 77) & ~modesPresentMask) !== 0) {
    return 'modesValueMask asserts a mode outside modesPresentMask';
  }

  // Presence bits (07 section 2.9). Each field is "valid only when bit N = 1";
  // returning its bytes anyway would fabricate a value the server never
  // asserted, and the client compares these as strictly as the lease.
  const retainedState = (flags2 & FLAGS2_RETAINED_STATE_PRESENT) !== 0;
  const savedCursor = (flags2 & FLAGS2_SAVED_CURSOR_NON_NULL) !== 0;
  if ((flags2 & FLAGS2_TRANSITION_EPOCH_PRESENT) === 0 && view.getBigUint64(at + 48) !== 0n) {
    return 'transitionEpoch is set without TRANSITION_EPOCH_PRESENT';
  }
  if ((flags2 & FLAGS2_BOUNDARY_SOURCE_SEQ_PRESENT) === 0 && view.getBigUint64(at + 56) !== 0n) {
    return 'boundarySourceSeq is set without BOUNDARY_SOURCE_SEQ_PRESENT';
  }
  if (!retainedState) {
    if (savedCursor) return 'SAVED_CURSOR_NON_NULL is set without RETAINED_STATE_PRESENT';
    if (view.getUint8(at + 78) !== 0) {
      return 'retainedActiveBuffer is set without RETAINED_STATE_PRESENT';
    }
    for (let index = at + 128; index < at + 160; index += 1) {
      if (bytes[index] !== 0) return 'retainedStateDigest is set without RETAINED_STATE_PRESENT';
    }
  }
  if (!savedCursor && (view.getUint32(at + 88) !== 0 || view.getUint32(at + 92) !== 0)) {
    return 'retainedSavedCursor is set without SAVED_CURSOR_NON_NULL';
  }

  const declared = (flags2 & FLAGS2_RESPONDER_LEASE_ID_PRESENT) !== 0;
  const length = view.getUint8(at + 160);
  if (declared && length === 0) return 'RESPONDER_LEASE_ID_PRESENT set with zero length';
  if (!declared && length !== 0) return 'lease length set without RESPONDER_LEASE_ID_PRESENT';
  if (length > RESPONDER_LEASE_ID_MAX_BYTES) return 'lease length past the 38-byte bound';

  for (let index = at + 161 + length; index < at + 161 + RESPONDER_LEASE_ID_SLOT_BYTES; index += 1) {
    if (bytes[index] !== 0) return 'lease padding is not zero-filled';
  }
  if (length > 0) {
    try {
      utf8StrictDecoder.decode(bytes.subarray(at + 161, at + 161 + length));
    } catch {
      return 'lease bytes are not valid UTF-8';
    }
  }
  return undefined;
}

export function decodeWsMessage(buffer: Uint8Array | ArrayBuffer, context: BinaryDecodeContext): DecodeResult {
  const result: DecodeResult = { frames: [], scoped: [], diagnostics: [] };

  if (context.codec !== 'binary') {
    result.fatal = { code: 'binary-frame-on-json-group', grade: 'fatal', frameOffset: 0 };
    return result;
  }

  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const fatal = (code: DecodeRejectionCode, frameOffset: number, extra?: Partial<DecodeRejection>): DecodeResult => {
    result.fatal = { code, grade: 'fatal', frameOffset, ...extra };
    return result;
  };

  const scoped = (code: DecodeRejectionCode, frameOffset: number, channelId: number): void => {
    result.scoped.push({ code, grade: 'scoped', frameOffset, channelId });
  };

  let offset = 0;
  while (offset < bytes.byteLength) {
    if (bytes.byteLength - offset < FRAME_HEADER_BYTES) return fatal('truncated-header', offset);

    const frameVersion = view.getUint8(offset);
    if (frameVersion !== context.frameVersion) {
      return fatal('bad-frame-version', offset, { detail: reservedVersionDetail(frameVersion) });
    }

    const opcode = view.getUint8(offset + 1);
    if (!isKnownOpcode(opcode)) return fatal('unknown-opcode', offset);

    const flags = view.getUint16(offset + 2);
    if ((flags & ~context.activeFlagMask) !== 0) return fatal('reserved-flag-set', offset);

    // The per-frame flag invariant is bit3 ALONE (06 §5 S2-g, D14).
    //
    // `MANDATORY_FLAGS` (bit0|bit3) must never be used as a decode predicate: it
    // is a negotiation invariant (the client's acceptedFlagMask has to contain
    // both bits, 01:93), and 01:75 puts END_OF_BATCH on the last frame and only
    // the last frame — so `(flags & MANDATORY_FLAGS) === MANDATORY_FLAGS` would
    // reject every mid-batch frame ever sent.
    //
    // The condition is scoped to opcodes that actually have a v1 prologue: for
    // 0x03/0x04/0x06/0x07 01 §1.8 defines none, so setting the bit — not
    // clearing it — would be the false claim. `prologueBytes(opcode) > 0` is the
    // encoder's own encodability gate (`assertEncodableHead`), which is exactly
    // the domain where the two sides were asymmetric.
    if (prologueBytes(opcode) > 0 && (flags & FLAG_PROLOGUE_PRESENT) === 0) {
      return fatal('mandatory-flag-cleared', offset);
    }

    const channelId = view.getUint32(offset + 4);
    if (channelId === 0) return fatal('reserved-channel', offset);

    // Length and batch boundaries are validated before channel state, so that a
    // retired or unknown channel can never make us jump on an unchecked length
    // (01:1280-1281).
    const payloadLength = view.getUint32(offset + 24);
    const frameEnd = offset + FRAME_HEADER_BYTES + payloadLength;
    if (frameEnd > bytes.byteLength) return fatal('length-overrun', offset);

    const isLast = frameEnd === bytes.byteLength;
    const hasEndOfBatch = (flags & FLAG_END_OF_BATCH) !== 0;
    if (hasEndOfBatch && !isLast) return fatal('batch-terminated-early', offset);
    if (isLast && !hasEndOfBatch) return fatal('batch-not-terminated', offset);

    // Length-domain policy checks (see DECODER_POLICY_CODES).
    let overhead = prologueBytes(opcode);
    if (payloadLength < overhead) return fatal('payload-underrun', offset);
    if (opcode === DATA_PLANE_OPCODE.OUTPUT) {
      const segmentCount = view.getUint16(offset + FRAME_HEADER_BYTES + 22);
      overhead += SEGMENT_BYTES * segmentCount;
      if (payloadLength < overhead) return fatal('payload-underrun', offset);
    }
    // 0x04 prologue domain checks. They live here, not in `parseFrameMessage`,
    // because that function is contractually infallible on a frame this decoder
    // accepted. Scoped: `frameEnd` is already known good, so the rest of the
    // batch survives a frame whose prologue content is wrong.
    if (opcode === DATA_PLANE_OPCODE.CHECKPOINT_START) {
      const violation = checkpointStartPrologueViolation(
        view,
        bytes,
        offset + FRAME_HEADER_BYTES,
      );
      if (violation !== undefined) {
        scoped('prologue-domain-violation', offset, channelId);
        offset = frameEnd;
        continue;
      }
    }

    if (payloadLength - overhead > context.maxBodyBytes) {
      // Scoped, not fatal: the declared length agrees with the buffer, so
      // frameEnd is trustworthy and only this frame is dropped (see
      // `rejectionGrade`). Aborting here would take the rest of the batch with it.
      scoped('payload-limit-exceeded', offset, channelId);
      offset = frameEnd;
      continue;
    }

    const state = context.channelState(channelId);
    if (state === undefined) {
      // Scoped: framing is sound, only this channel is in doubt (01:958).
      scoped('unknown-channel', offset, channelId);
      offset = frameEnd;
      continue;
    }
    if (state === 'retired') {
      // Not a silent drop: the client already discarded that session, so there
      // is no screen to draw. Observability is kept via the diagnostic (01:395).
      result.diagnostics.push({
        event: 'terminal_binary_retired_channel_frame',
        channelId,
        frameOffset: offset,
      });
      offset = frameEnd;
      continue;
    }

    result.frames.push({
      frameVersion,
      opcode,
      flags,
      channelId,
      streamEpoch: readOrdinal64(view, offset + 8),
      sourceSeq: readOrdinal64(view, offset + 16),
      payload: bytes.subarray(offset + FRAME_HEADER_BYTES, frameEnd),
      frameOffset: offset,
    });

    offset = frameEnd;
  }

  return result;
}

/**
 * Parses the opcode-specific prologue, segment array and body out of a decoded
 * frame. Returns `undefined` for a known opcode that has no v1 prologue schema
 * (0x03/0x04/0x06/0x07) — the frame is valid and stays opaque for dispatch.
 *
 * Every length precondition was already enforced by `decodeWsMessage`, so this
 * function cannot fail on a frame it produced.
 */
export function parseFrameMessage(frame: DecodedFrame): BinaryWireMessage | undefined {
  const size = prologueBytes(frame.opcode);
  if (size === 0) return undefined;

  const payload = frame.payload;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const head: FrameHead = {
    flags: frame.flags,
    channelId: frame.channelId,
    streamEpoch: frame.streamEpoch,
    sourceSeq: frame.sourceSeq,
  };

  if (frame.opcode === DATA_PLANE_OPCODE.OUTPUT) {
    const segmentCount = view.getUint16(22);
    const segments: OutputSegment[] = [];
    for (let index = 0; index < segmentCount; index += 1) {
      const base = 24 + index * SEGMENT_BYTES;
      segments.push({
        byteStart: view.getUint32(base + 0),
        byteEnd: view.getUint32(base + 4),
        screenSeqDelta: view.getUint32(base + 8),
        authorityRevisionDelta: view.getUint16(base + 12),
        chunkIdDelta: view.getUint16(base + 14),
      });
    }
    return {
      opcode: DATA_PLANE_OPCODE.OUTPUT,
      ...head,
      prologue: {
        screenSeq: readOrdinal64(view, 0),
        chunkIdBase: readOrdinal64(view, 8),
        authorityRevision: view.getUint32(16),
        authorityEpochIndex: view.getUint16(20),
      },
      segments,
      body: payload.subarray(24 + segmentCount * SEGMENT_BYTES),
    };
  }

  if (frame.opcode === DATA_PLANE_OPCODE.CHECKPOINT_START) {
    const flags2 = view.getUint16(74);
    const leaseLength = view.getUint8(160);
    const lease = leaseLength === 0
      ? undefined
      : utf8StrictDecoder.decode(payload.subarray(161, 161 + leaseLength));
    return {
      opcode: DATA_PLANE_OPCODE.CHECKPOINT_START,
      ...head,
      prologue: {
        checkpointSourceSeq: readOrdinal64(view, 0),
        viewGeneration: view.getUint32(8),
        chunkCount: view.getUint32(12),
        checkpointStreamEpoch: readOrdinal64(view, 16),
        checkpointEpoch: readOrdinal64(view, 24),
        snapshotSeq: readOrdinal64(view, 32),
        oldestRetainedSeq: readOrdinal64(view, 40),
        transitionEpoch: readOrdinal64(view, 48),
        boundarySourceSeq: readOrdinal64(view, 56),
        encodedByteTotal: view.getUint32(64),
        cols: view.getUint16(68),
        rows: view.getUint16(70),
        authorityEpochIndex: view.getUint16(72),
        flags2,
        modesPresentMask: view.getUint8(76),
        modesValueMask: view.getUint8(77),
        retainedActiveBuffer: view.getUint8(78),
        retainedCursorX: view.getUint32(80),
        retainedCursorY: view.getUint32(84),
        retainedSavedCursorX: view.getUint32(88),
        retainedSavedCursorY: view.getUint32(92),
        digest: payload.slice(96, 128),
        retainedStateDigest: payload.slice(128, 160),
        // Spread, not `lease`: absence has to leave the key off entirely.
        ...(lease === undefined ? {} : { responderLeaseId: lease }),
      },
      body: payload.subarray(200),
    };
  }

  if (frame.opcode === DATA_PLANE_OPCODE.SCREEN_SNAPSHOT) {
    return {
      opcode: DATA_PLANE_OPCODE.SCREEN_SNAPSHOT,
      ...head,
      prologue: {
        seq: readOrdinal64(view, 0),
        cols: view.getUint16(8),
        rows: view.getUint16(10),
        mode: view.getUint8(12),
        truncated: view.getUint8(13),
        flags2: view.getUint16(14),
        authorityRevision: view.getUint32(16),
        authorityEpochIndex: view.getUint16(20),
        replayTokenIndex: view.getUint16(22),
      },
      body: payload.subarray(24),
    };
  }

  return {
    opcode: DATA_PLANE_OPCODE.CHECKPOINT_CHUNK,
    ...head,
    prologue: {
      chunkIndex: view.getUint32(0),
      chunkCount: view.getUint32(4),
      viewGeneration: view.getUint32(8),
    },
    body: payload.subarray(12),
  };
}
