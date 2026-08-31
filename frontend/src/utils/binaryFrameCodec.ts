/**
 * S4-C5 — the client half of the binary terminal data plane. **Decode only.**
 *
 * v1 sends nothing binary client-to-server (06 §5 S2-d: "C→S opcode 표는 비어
 * 있다"), so there is no encoder here and no reason to grow one.
 *
 * [설계결정] This does not import `server/src/ws/binaryFrameCodec.ts`, and that
 * is not a §10.2 duplication violation (08 §5.2). Importing it would drag the
 * server type graph into the browser bundle, and — more to the point — the
 * golden-vector test is a *differential* test: it is only evidence because the
 * two sides derive the same bytes from the same written spec rather than from
 * the same code. The shared artefact is the fixture, not the implementation.
 *
 * Layout SSOT: `docs/research/binary-comms/01-frame-format-and-negotiation.md`
 * §1.8, which incorporates `07-prologue-spec-remaining-opcodes.md` by reference
 * for the four checkpoint opcodes.
 */

export const FRAME_HEADER_BYTES = 28;
export const FRAME_VERSION_V1 = 0x01;
export const SEGMENT_BYTES = 16;

export const FLAG_END_OF_BATCH = 0x0001;
export const FLAG_PAYLOAD_UTF8_TEXT = 0x0002;
export const FLAG_PROLOGUE_PRESENT = 0x0008;

export const MANDATORY_FLAGS = FLAG_END_OF_BATCH | FLAG_PROLOGUE_PRESENT;
export const NEGOTIABLE_FLAGS_V1 = FLAG_PAYLOAD_UTF8_TEXT;
export const ACTIVE_FLAG_MASK_V1 = MANDATORY_FLAGS | NEGOTIABLE_FLAGS_V1;

export const DATA_PLANE_OPCODE = Object.freeze({
  OUTPUT: 0x01,
  SCREEN_SNAPSHOT: 0x02,
  SCREEN_REPAIR: 0x03,
  CHECKPOINT_START: 0x04,
  CHECKPOINT_CHUNK: 0x05,
  CHECKPOINT_COMMIT: 0x06,
  CHECKPOINT_OUTPUT: 0x07,
});

/** 07 §2.6.1. Declares off 160/161 valid; it never changes the prologue's size. */
export const FLAGS2_RESPONDER_LEASE_ID_PRESENT = 0x0010;

/** 07 §2.9 flags2 bit table — each declares which prologue offsets carry a value. */
const FLAGS2_RETAINED_STATE_PRESENT = 0x0001;
const FLAGS2_TRANSITION_EPOCH_PRESENT = 0x0002;
const FLAGS2_BOUNDARY_SOURCE_SEQ_PRESENT = 0x0004;
const FLAGS2_SAVED_CURSOR_NON_NULL = 0x0008;
const CHECKPOINT_START_FLAGS2_RESERVED_MASK = 0xffe0;

const RESPONDER_LEASE_ID_MAX_BYTES = 38;
const RESPONDER_LEASE_ID_SLOT_BYTES = 39;
const CHECKPOINT_START_PROLOGUE_BYTES = 200;

const utf8StrictDecoder = new TextDecoder('utf-8', { fatal: true });

/**
 * Prologue size in bytes. 0 means "no v1 prologue schema", which is a valid
 * frame that stays opaque rather than an error.
 *
 * The size is a pure function of the opcode alone — never of `flags` (01 §1.8
 * invariant 1). That is what lets the decoder grade a cleared bit3 as a fatal
 * lie without ever having misread the layout because of it.
 */
export function prologueBytes(opcode: number): number {
  switch (opcode) {
    case DATA_PLANE_OPCODE.OUTPUT:
      return 24;
    case DATA_PLANE_OPCODE.SCREEN_SNAPSHOT:
      return 24;
    case DATA_PLANE_OPCODE.CHECKPOINT_START:
      return CHECKPOINT_START_PROLOGUE_BYTES;
    case DATA_PLANE_OPCODE.CHECKPOINT_CHUNK:
      return 12;
    default:
      return 0;
  }
}

export function isKnownOpcode(opcode: number): boolean {
  return opcode >= DATA_PLANE_OPCODE.OUTPUT && opcode <= DATA_PLANE_OPCODE.CHECKPOINT_OUTPUT;
}

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

export const DECODER_POLICY_CODES = Object.freeze([
  'payload-underrun',
  'payload-limit-exceeded',
  'mandatory-flag-cleared',
  'prologue-domain-violation',
] as const);

export type WireRejectionCode = (typeof WIRE_REJECTION_CODES)[number];
export type DecoderPolicyCode = (typeof DECODER_POLICY_CODES)[number];
export type DecodeRejectionCode = WireRejectionCode | DecoderPolicyCode;
export type RejectionGrade = 'fatal' | 'scoped';

/**
 * Scoped means "drop this frame, keep the batch". It is only sound when the
 * frame's own boundary is already trustworthy — i.e. the declared length agreed
 * with the buffer — because the decoder still has to jump over it.
 *
 * Everything else is fatal: once framing is in doubt there is no defensible
 * place to resume, and guessing would replay attacker-chosen bytes as frames.
 */
export function rejectionGrade(code: DecodeRejectionCode): RejectionGrade {
  if (
    code === 'unknown-channel'
    || code === 'payload-limit-exceeded'
    || code === 'prologue-domain-violation'
  ) {
    return 'scoped';
  }
  if ((WIRE_REJECTION_CODES as readonly string[]).includes(code)) return 'fatal';
  if ((DECODER_POLICY_CODES as readonly string[]).includes(code)) return 'fatal';
  throw new RangeError(`unknown rejection code: ${String(code)}`);
}

export type ChannelState = 'active' | 'retired';

export interface BinaryDecodeContext {
  readonly codec: 'json' | 'binary';
  readonly frameVersion: number;
  readonly activeFlagMask: number;
  readonly maxBodyBytes: number;
  channelState(channelId: number): ChannelState | undefined;
}

/**
 * [설계결정] The client body budget is the visible output queue cap, not a new
 * constant — `PERF-BGSTAB-010` AC-4 forbids introducing one (08 §5.5).
 *
 * The caller passes the value rather than this module reading runtime config,
 * so the codec stays a pure boundary with no dependency on the config layer.
 *
 * The default (4 MiB) is looser than the server's 2 MiB, so a server honouring
 * its own limit never trips this. Configuring the queue down to its 1024 floor
 * makes the client stricter than the server, and a legitimate frame can then be
 * dropped — deliberately, because a frame that cannot enter the queue is not
 * worth decoding. It stays scoped, so the rest of the batch survives.
 */
export function deriveMaxBodyBytes(limits: { visibleOutputQueueMaxBytes: number }): number {
  const bound = limits?.visibleOutputQueueMaxBytes;
  if (!Number.isSafeInteger(bound) || bound <= 0) {
    throw new RangeError('visibleOutputQueueMaxBytes must be a positive safe integer');
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

export interface DecodedFrame {
  frameVersion: number;
  opcode: number;
  flags: number;
  channelId: number;
  streamEpoch: string;
  sourceSeq: string;
  /** A view into the input buffer — never a copy (01:1310). */
  payload: Uint8Array;
  frameOffset: number;
}

export interface DecodeRejection {
  code: DecodeRejectionCode;
  grade: RejectionGrade;
  frameOffset: number;
  channelId?: number;
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

export interface OutputPrologue {
  screenSeq: string;
  chunkIdBase: string;
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
  seq: string;
  cols: number;
  rows: number;
  mode: number;
  truncated: number;
  flags2: number;
  authorityRevision: number;
  authorityEpochIndex: number;
  replayTokenIndex: number;
}

export interface CheckpointStartPrologue {
  checkpointSourceSeq: string;
  viewGeneration: number;
  chunkCount: number;
  checkpointStreamEpoch: string;
  checkpointEpoch: string;
  snapshotSeq: string;
  oldestRetainedSeq: string;
  transitionEpoch: string;
  boundarySourceSeq: string;
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
  /** Absent means absent. `''` would pass the client's own identity compare. */
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
  streamEpoch: string;
  sourceSeq: string;
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

export interface CheckpointStartWireMessage extends FrameHead {
  opcode: typeof DATA_PLANE_OPCODE.CHECKPOINT_START;
  prologue: CheckpointStartPrologue;
  body: Uint8Array;
}

export interface CheckpointChunkWireMessage extends FrameHead {
  opcode: typeof DATA_PLANE_OPCODE.CHECKPOINT_CHUNK;
  prologue: CheckpointChunkPrologue;
  body: Uint8Array;
}

export type BinaryWireMessage =
  | OutputWireMessage
  | SnapshotWireMessage
  | CheckpointStartWireMessage
  | CheckpointChunkWireMessage;

/** Restores the canonical decimal string an Ordinal64 was sent as. */
function readOrdinal64(view: DataView, offset: number): string {
  const hi = view.getUint32(offset);
  const lo = view.getUint32(offset + 4);
  if (hi === 0) return String(lo);
  return ((BigInt(hi) << 32n) | BigInt(lo)).toString(10);
}

/**
 * `0x00` / `0xFF` are far more likely to be a zero-filled or 0xFF-filled buffer
 * than a real negotiation mismatch. 01:934-943 has no separate code, so the
 * distinction is carried as metadata.
 */
function reservedVersionDetail(version: number): string | undefined {
  if (version === 0x00) return 'reserved-frame-version-zero';
  if (version === 0xff) return 'reserved-frame-version-ff';
  return undefined;
}

/**
 * Returns a reason when the 0x04 prologue contradicts itself, `undefined` when
 * it is sound. Mirrors the server's checks so the two decoders cannot disagree
 * about which frames exist: a client more permissive than its server would draw
 * a screen the server never asserted.
 */
function checkpointStartPrologueViolation(
  view: DataView,
  bytes: Uint8Array,
  at: number,
): string | undefined {
  const flags2 = view.getUint16(at + 74);
  if ((flags2 & CHECKPOINT_START_FLAGS2_RESERVED_MASK) !== 0) return 'flags2 reserved bit set';
  if (view.getUint8(at + 79) !== 0) return 'reserved byte at off 79 is not zero';

  // Value domains (07 §2.11) — the values the client's own validator rejects a
  // layer up. Letting them through turns a framing fault into a whole-message drop.
  if (view.getUint32(at + 12) === 0) return 'chunkCount must be positive';
  if (view.getUint16(at + 68) === 0 || view.getUint16(at + 70) === 0) {
    return 'cols and rows must be positive';
  }
  if (view.getUint8(at + 78) > 1) return 'retainedActiveBuffer is neither normal nor alternate';
  const modesPresentMask = view.getUint8(at + 76);
  if ((view.getUint8(at + 77) & ~modesPresentMask) !== 0) {
    return 'modesValueMask asserts a mode outside modesPresentMask';
  }

  // Presence bits (07 §2.9). Each field is "valid only when bit N = 1"; handing
  // back its bytes anyway fabricates a value the server never asserted.
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

/**
 * Decodes one WS message into its frames.
 *
 * A fatal rejection never discards the frames already parsed: one WS message is
 * N frames spanning several channels, so returning early would delete healthy
 * output belonging to unrelated sessions. The caller dispatches `frames` first,
 * then handles `fatal`.
 */
export function decodeWsMessage(
  buffer: Uint8Array | ArrayBuffer,
  context: BinaryDecodeContext,
): DecodeResult {
  const result: DecodeResult = { frames: [], scoped: [], diagnostics: [] };

  if (context.codec !== 'binary') {
    result.fatal = { code: 'binary-frame-on-json-group', grade: 'fatal', frameOffset: 0 };
    return result;
  }

  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const fatal = (
    code: DecodeRejectionCode,
    frameOffset: number,
    extra?: Partial<DecodeRejection>,
  ): DecodeResult => {
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

    // The per-frame invariant is bit3 ALONE (D14). `MANDATORY_FLAGS` must never
    // be a decode predicate: END_OF_BATCH belongs to the last frame only, so
    // testing both bits would reject every mid-batch frame ever sent. And the
    // condition only applies where a v1 prologue exists — for the opcodes with
    // none, setting the bit would be the false claim, not clearing it.
    if (prologueBytes(opcode) > 0 && (flags & FLAG_PROLOGUE_PRESENT) === 0) {
      return fatal('mandatory-flag-cleared', offset);
    }

    const channelId = view.getUint32(offset + 4);
    if (channelId === 0) return fatal('reserved-channel', offset);

    // Length and batch boundaries are checked before channel state, so an
    // unknown or retired channel can never make us jump on an unvalidated
    // length (01:1280-1281).
    const payloadLength = view.getUint32(offset + 24);
    const frameEnd = offset + FRAME_HEADER_BYTES + payloadLength;
    if (frameEnd > bytes.byteLength) return fatal('length-overrun', offset);

    const isLast = frameEnd === bytes.byteLength;
    const hasEndOfBatch = (flags & FLAG_END_OF_BATCH) !== 0;
    if (hasEndOfBatch && !isLast) return fatal('batch-terminated-early', offset);
    if (isLast && !hasEndOfBatch) return fatal('batch-not-terminated', offset);

    let overhead = prologueBytes(opcode);
    if (payloadLength < overhead) return fatal('payload-underrun', offset);
    if (opcode === DATA_PLANE_OPCODE.OUTPUT) {
      const segmentCount = view.getUint16(offset + FRAME_HEADER_BYTES + 22);
      overhead += SEGMENT_BYTES * segmentCount;
      if (payloadLength < overhead) return fatal('payload-underrun', offset);
    }

    // Scoped, not fatal: `frameEnd` is already known good, so only this frame
    // is lost. `parseFrameMessage` stays contractually infallible because a
    // frame with a self-contradicting prologue never reaches it.
    if (opcode === DATA_PLANE_OPCODE.CHECKPOINT_START) {
      const violation = checkpointStartPrologueViolation(view, bytes, offset + FRAME_HEADER_BYTES);
      if (violation !== undefined) {
        scoped('prologue-domain-violation', offset, channelId);
        offset = frameEnd;
        continue;
      }
    }

    if (payloadLength - overhead > context.maxBodyBytes) {
      scoped('payload-limit-exceeded', offset, channelId);
      offset = frameEnd;
      continue;
    }

    const state = context.channelState(channelId);
    if (state === undefined) {
      scoped('unknown-channel', offset, channelId);
      offset = frameEnd;
      continue;
    }
    if (state === 'retired') {
      // Not a silent drop: the client already discarded that session, so there
      // is no screen to draw. Observability is kept via the diagnostic.
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
 * frame. Returns `undefined` for a known opcode with no v1 prologue schema
 * (0x03/0x06/0x07) — the frame is valid and stays opaque for dispatch.
 *
 * Every length precondition was already enforced by `decodeWsMessage`, so this
 * cannot fail on a frame that function produced.
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
        // Absence must be a missing key, never ''. An empty string satisfies the
        // client's own identity compare and then dies on the server's ACK echo.
        ...(lease === undefined ? {} : { responderLeaseId: lease }),
      },
      body: payload.subarray(CHECKPOINT_START_PROLOGUE_BYTES),
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
