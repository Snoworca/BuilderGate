import type { TerminalOutputMessage } from '../types/ws-protocol.ts';
import type { OutputWireMessage } from './binaryFrameCodec.ts';
import { getOutputUtf8ByteLength } from './terminalOutputHotPath.ts';
import type { TerminalOutputWriteData } from './terminalOutputScheduler.ts';
import {
  assertContiguousSegments,
  splitVisibleOutputSourceSegments,
  type VisibleOutputSourceSegment,
} from './visibleOutputRecovery.ts';

/**
 * Codec-neutral representation of one terminal output delivery.
 *
 * The output handler splits a payload into segments, meters bytes, applies the
 * hidden-output policy, extracts a delivery identity, and dispatches writes. Only
 * the split depends on how the payload arrived; the rest needs a write payload
 * and a byte count. Lifting those two into a neutral shape lets both codecs share
 * the handler, with the choice of codec confined to which adapter built the value.
 *
 * `data` is deliberately `TerminalOutputWriteData` and not `string`: the write
 * path already accepts bytes, and forcing a decode here would reintroduce exactly
 * the round trip the binary path exists to remove.
 */
export interface TerminalOutputDeliveryChunk {
  readonly data: TerminalOutputWriteData;
  /** Already known at construction. Never recompute it by re-encoding. */
  readonly byteLength: number;
  readonly screenSeq?: number;
  readonly authorityEpoch?: string;
  readonly authorityRevision?: number;
  readonly chunkId?: string;
}

export interface TerminalOutputDelivery {
  readonly codec: 'json' | 'binary';
  /** The payload before any segment split. */
  readonly whole: TerminalOutputDeliveryChunk;
  /**
   * `null` means "segments were supplied but do not tile the payload", which is
   * not the same as an empty list. Callers fall back to `whole` on `null`.
   */
  readonly chunks: readonly TerminalOutputDeliveryChunk[] | null;
  /** Distinguishes "no segments were sent" from "segments were sent and failed". */
  readonly hasSourceSegments: boolean;
  readonly replayToken?: string;
  readonly repairToken?: string;
  readonly ack?: { readonly connectionEpoch: string; readonly deliverySeq: number };
  /**
   * A deferred call so a byte-backed adapter can decode on demand rather than up
   * front. Both call sites in `TerminalContainer` forward it unevaluated, so the
   * decision to materialize belongs to the consumer that knows whether it needs
   * the text: `resolveHiddenOutput` reads it only for a `debug-tail` skip with a
   * positive tail budget, and `recordTerminalDebugEvent` only while capture is on.
   * Calling it at the call site would decode every live frame and defeat the IR.
   */
  readonly previewText: () => string;
}

function optional<T>(key: string, value: T | undefined): Record<string, T> {
  return value === undefined ? {} : { [key]: value };
}

/**
 * Adapter for the JSON wire format.
 *
 * `data` is passed separately from `message` because the caller already holds the
 * decoded payload; reading `message.data` again would be the same value.
 */
export function fromJsonOutputMessage(
  data: string,
  message: TerminalOutputMessage,
): TerminalOutputDelivery {
  const whole: TerminalOutputDeliveryChunk = {
    data,
    byteLength: getOutputUtf8ByteLength(data),
    ...optional('screenSeq', message.screenSeq),
    ...optional('authorityEpoch', message.authorityEpoch),
    ...optional('authorityRevision', message.authorityRevision),
    ...optional('chunkId', message.chunkId),
  };

  // Narrowed off the field itself rather than a separate boolean, so no `?? []`
  // fallback is needed. That fallback would have been unreachable, and had it ever
  // run it would have produced `null` — the opposite of what an empty list means
  // to the caller.
  const sourceSegments = message.sourceSegments;
  const split = sourceSegments !== undefined
    ? splitVisibleOutputSourceSegments(data, sourceSegments)
    : null;

  const chunks: readonly TerminalOutputDeliveryChunk[] | null = sourceSegments !== undefined
    ? split?.map(chunk => ({
      data: chunk.data,
      byteLength: getOutputUtf8ByteLength(chunk.data),
      ...optional('screenSeq', chunk.screenSeq),
      ...optional('authorityEpoch', chunk.authorityEpoch),
      ...optional('authorityRevision', chunk.authorityRevision),
      chunkId: chunk.chunkId,
    })) ?? null
    : [whole];

  return {
    codec: 'json',
    whole,
    chunks,
    hasSourceSegments: sourceSegments !== undefined,
    ...optional('replayToken', message.replayToken),
    ...optional('repairToken', message.repairToken),
    // Half an identity cannot be acknowledged, so it is treated as absent rather
    // than partially populated.
    ...(message.connectionEpoch !== undefined && message.deliverySeq !== undefined
      ? { ack: { connectionEpoch: message.connectionEpoch, deliverySeq: message.deliverySeq } }
      : {}),
    previewText: () => data,
  };
}

/**
 * Identity a `0x01` frame cannot carry.
 *
 * `authorityEpoch` is on the wire only as a uint16 channel-local alias, and both
 * tokens are channel state that arrives on the JSON control plane. Taking them
 * as an argument keeps this a pure function and lets the adapter exist before
 * the channel registry does.
 */
export interface BinaryOutputIdentity {
  readonly authorityEpoch?: string;
  readonly replayToken?: string;
  readonly repairToken?: string;
}

/**
 * The wire widens `screenSeq` to u64, but it originates as a JS number
 * (`SessionManager.ts:810`) and the IR is typed `number`, so narrowing back is
 * lossless for anything our server can produce.
 *
 * Past the safe range it is refused rather than rounded: a rounded value still
 * looks like a sequence number and would corrupt ordering and dedup downstream
 * instead of failing where it can be seen.
 */
function narrowOrdinal(value: string, field: string): number {
  const narrowed = Number(value);
  if (!Number.isSafeInteger(narrowed)) {
    throw new RangeError(`${field} ${value} is outside the safe integer range`);
  }
  return narrowed;
}

const previewDecoder = new TextDecoder('utf-8');

/**
 * Builds the neutral delivery from a decoded `0x01` frame.
 *
 * Body bytes are forwarded as bytes. Decoding here would reintroduce the round
 * trip the binary path exists to remove, on every live frame.
 */
export function fromBinaryOutputFrame(
  message: OutputWireMessage,
  identity: BinaryOutputIdentity = {},
): TerminalOutputDelivery {
  const { prologue, segments, body } = message;
  const screenSeq = narrowOrdinal(prologue.screenSeq, 'screenSeq');

  // `chunkIdBase` 0 is the encoder's "absent" sentinel: the generator counts from
  // 1 (`WsRouter.ts:3642-3646`), so 0 is never a real chunkId and needs no extra
  // presence bit. The size of the segment array says nothing about it — a normal
  // frame has a chunkId and no segments at all.
  const chunkIdBase = prologue.chunkIdBase === '0' ? undefined : prologue.chunkIdBase;

  const whole: TerminalOutputDeliveryChunk = {
    data: body,
    byteLength: body.byteLength,
    screenSeq,
    ...optional('authorityEpoch', identity.authorityEpoch),
    authorityRevision: prologue.authorityRevision,
    ...optional('chunkId', chunkIdBase),
  };

  if (segments.length === 0) {
    // Matches the JSON path exactly: `wsSendPolicy.ts:122` never emits an empty
    // `sourceSegments`, so "absent" and "empty" are already one state there too.
    return {
      codec: 'binary',
      whole,
      chunks: [whole],
      hasSourceSegments: false,
      ...optional('replayToken', identity.replayToken),
      ...optional('repairToken', identity.repairToken),
      previewText: () => previewDecoder.decode(body),
    };
  }

  // Deltas are relative to the prologue, so absolute values are reconstructed
  // before the shared invariant runs. With no base the segment identities are
  // underivable, and an empty `chunkId` is what `assertContiguousSegments`
  // already rejects — no second rule needed for that case.
  const resolved: VisibleOutputSourceSegment[] = segments.map(segment => ({
    byteStart: segment.byteStart,
    byteEnd: segment.byteEnd,
    screenSeq: screenSeq + segment.screenSeqDelta,
    ...optional('authorityEpoch', identity.authorityEpoch),
    authorityRevision: prologue.authorityRevision + segment.authorityRevisionDelta,
    chunkId: chunkIdBase === undefined
      ? ''
      : (BigInt(chunkIdBase) + BigInt(segment.chunkIdDelta)).toString(10),
  }));

  const chunks = assertContiguousSegments(resolved, body.byteLength)
    ? resolved.map(segment => ({
      data: body.subarray(segment.byteStart, segment.byteEnd),
      byteLength: segment.byteEnd - segment.byteStart,
      screenSeq: segment.screenSeq,
      ...optional('authorityEpoch', segment.authorityEpoch),
      authorityRevision: segment.authorityRevision,
      chunkId: segment.chunkId,
    }))
    : null;

  return {
    codec: 'binary',
    whole,
    chunks,
    hasSourceSegments: true,
    ...optional('replayToken', identity.replayToken),
    ...optional('repairToken', identity.repairToken),
    previewText: () => previewDecoder.decode(body),
  };
}
