import { DATA_PLANE_OPCODE, ACTIVE_FLAG_MASK_V1 } from './binaryFrameCodec.js';
import type { OutputSegment, OutputWireMessage } from './binaryFrameCodec.js';

/**
 * Turns the outgoing JSON `output` message into the wire message `encodeFrame`
 * accepts (`01 §1.8`).
 *
 * This is the mirror of the browser's `fromBinaryOutputFrame`. Anything the
 * browser cannot rebuild from the wire is refused here rather than encoded and
 * lost quietly at the far end — the failure is visible on the machine that
 * produced it, with the message still in hand.
 */

/** The subset of the outgoing `output` message this adapter reads. */
export interface TerminalOutputJsonMessage {
  readonly type: 'output';
  readonly sessionId: string;
  readonly data: string;
  readonly screenSeq?: number;
  readonly authorityRevision?: number;
  readonly chunkId?: string;
  readonly sourceSegments?: readonly {
    readonly byteStart: number;
    readonly byteEnd: number;
    readonly screenSeq?: number;
    readonly authorityRevision?: number;
    readonly chunkId: string;
  }[];
}

/**
 * The header values the message does not carry. They belong to the channel,
 * not to the payload, so the send path supplies them.
 */
export interface OutputWireContext {
  readonly channelId: number;
  readonly streamEpoch: string;
  readonly sourceSeq: string;
  /** The channel-local alias of the session's `authorityEpoch` UUID. */
  readonly authorityEpochIndex: number;
}

const utf8 = new TextEncoder();

/** `01:392` rule 1 — 0 is permanently reserved and must never be encoded. */
function assertChannelId(channelId: number): void {
  if (!Number.isSafeInteger(channelId) || channelId <= 0) {
    throw new RangeError(`channelId ${channelId} is not a valid handle`);
  }
}

function delta(value: number, base: number, field: string): number {
  const difference = value - base;
  if (difference < 0) {
    // Wire deltas are unsigned. A negative one would wrap to a large positive
    // value and reorder the stream instead of failing.
    throw new RangeError(`${field} ${value} precedes its prologue base ${base}: negative delta`);
  }
  return difference;
}

function chunkIdDelta(chunkId: string, base: string): number {
  const difference = BigInt(chunkId) - BigInt(base);
  if (difference < 0n) {
    throw new RangeError(`chunkId ${chunkId} precedes its prologue base ${base}: negative delta`);
  }
  return Number(difference);
}

export function toBinaryOutputFrame(
  message: TerminalOutputJsonMessage,
  context: OutputWireContext,
): OutputWireMessage {
  assertChannelId(context.channelId);

  const body = utf8.encode(message.data);
  const screenSeq = message.screenSeq ?? 0;
  const authorityRevision = message.authorityRevision ?? 0;
  // `0` is the absent sentinel: the chunkId generator counts from 1, so no
  // separate presence bit is needed.
  const chunkIdBase = message.chunkId ?? '0';

  const sourceSegments = message.sourceSegments ?? [];
  const segments: OutputSegment[] = [];

  if (sourceSegments.length > 0) {
    if (chunkIdBase === '0') {
      // The browser reads an absent base as "no chunkIds at all" and blanks
      // every segment id. Encoding this would drop them without a trace.
      throw new RangeError('sourceSegments require a message-level chunkId to be encoded');
    }

    let expectedStart = 0;
    for (const segment of sourceSegments) {
      if (segment.byteStart !== expectedStart || segment.byteEnd < segment.byteStart) {
        throw new RangeError(
          `sourceSegments are not contiguous at byte ${segment.byteStart} (expected ${expectedStart})`,
        );
      }
      expectedStart = segment.byteEnd;
      segments.push({
        byteStart: segment.byteStart,
        byteEnd: segment.byteEnd,
        screenSeqDelta: delta(segment.screenSeq ?? screenSeq, screenSeq, 'segment screenSeq'),
        authorityRevisionDelta: delta(
          segment.authorityRevision ?? authorityRevision,
          authorityRevision,
          'segment authorityRevision',
        ),
        chunkIdDelta: chunkIdDelta(segment.chunkId, chunkIdBase),
      });
    }
    if (expectedStart !== body.byteLength) {
      throw new RangeError(
        `sourceSegments cover ${expectedStart} of ${body.byteLength} body bytes`,
      );
    }
  }

  return {
    opcode: DATA_PLANE_OPCODE.OUTPUT,
    flags: ACTIVE_FLAG_MASK_V1,
    channelId: context.channelId,
    streamEpoch: context.streamEpoch,
    sourceSeq: context.sourceSeq,
    prologue: {
      screenSeq: String(screenSeq),
      chunkIdBase,
      authorityRevision,
      authorityEpochIndex: context.authorityEpochIndex,
    },
    segments,
    body,
  };
}
