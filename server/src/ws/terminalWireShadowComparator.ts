/**
 * The `binary-shadow` rung (`05 §8.2`).
 *
 * The server encodes an output both ways and checks that the binary one carries
 * the same meaning, while only the JSON reaches the wire. There is deliberately
 * no socket in this module: "shadow does not send binary" is then a property of
 * the code rather than a promise about how it is called.
 *
 * A mismatch names the field that differed. A boolean would tell the operator
 * that the codec is wrong without telling them which part, which is the one
 * thing this rung exists to find out.
 */

import {
  createV1DecodeContext,
  decodeWsMessage,
  encodeFrame,
  parseFrameMessage,
  type OutputWireMessage,
} from './binaryFrameCodec.js';
import { toBinaryOutputFrame } from './terminalOutputWireAdapter.js';
import type { OutputWireContext, TerminalOutputJsonMessage } from './terminalOutputWireAdapter.js';

export interface ShadowMismatch {
  /** `encode`, `decode`, or the wire field whose value did not survive. */
  readonly field: string;
  readonly expected: string;
  readonly actual: string;
}

export interface ShadowComparisonTally {
  compared: number;
  mismatched: number;
  byField: Record<string, number>;
}

export interface ShadowComparison {
  readonly ok: boolean;
  readonly mismatches: readonly ShadowMismatch[];
  readonly jsonBytes: number;
  readonly binaryBytes: number;
}

export interface ShadowComparisonOptions {
  /** Fault injection for the tests that prove a mismatch is actually detected. */
  readonly corruptBytes?: (bytes: Uint8Array) => Uint8Array;
  readonly tally?: ShadowComparisonTally;
}

const utf8Decoder = new TextDecoder('utf-8', { fatal: false });

function record(tally: ShadowComparisonTally | undefined, mismatches: readonly ShadowMismatch[]): void {
  if (tally === undefined) return;
  tally.compared += 1;
  if (mismatches.length === 0) return;
  tally.mismatched += 1;
  for (const mismatch of mismatches) {
    tally.byField[mismatch.field] = (tally.byField[mismatch.field] ?? 0) + 1;
  }
}

function compareWireMessages(
  encoded: OutputWireMessage,
  decoded: OutputWireMessage,
  data: string,
): ShadowMismatch[] {
  const mismatches: ShadowMismatch[] = [];
  const differs = (field: string, expected: unknown, actual: unknown): void => {
    if (Object.is(expected, actual)) return;
    mismatches.push({ field, expected: String(expected), actual: String(actual) });
  };

  differs('channelId', encoded.channelId, decoded.channelId);
  differs('streamEpoch', encoded.streamEpoch, decoded.streamEpoch);
  differs('sourceSeq', encoded.sourceSeq, decoded.sourceSeq);
  differs('flags', encoded.flags, decoded.flags);
  differs('screenSeq', encoded.prologue.screenSeq, decoded.prologue.screenSeq);
  differs('chunkIdBase', encoded.prologue.chunkIdBase, decoded.prologue.chunkIdBase);
  differs('authorityRevision', encoded.prologue.authorityRevision, decoded.prologue.authorityRevision);
  differs('authorityEpochIndex', encoded.prologue.authorityEpochIndex, decoded.prologue.authorityEpochIndex);
  differs('segmentCount', encoded.segments.length, decoded.segments.length);

  const shared = Math.min(encoded.segments.length, decoded.segments.length);
  for (let index = 0; index < shared; index += 1) {
    const want = encoded.segments[index]!;
    const got = decoded.segments[index]!;
    differs(`segment[${index}].byteStart`, want.byteStart, got.byteStart);
    differs(`segment[${index}].byteEnd`, want.byteEnd, got.byteEnd);
    differs(`segment[${index}].screenSeqDelta`, want.screenSeqDelta, got.screenSeqDelta);
    differs(`segment[${index}].authorityRevisionDelta`, want.authorityRevisionDelta, got.authorityRevisionDelta);
    differs(`segment[${index}].chunkIdDelta`, want.chunkIdDelta, got.chunkIdDelta);
  }

  // Compared as text rather than bytes: the JSON side carries a string, so the
  // question the rung asks is whether the client would render the same thing.
  differs('data', data, utf8Decoder.decode(decoded.body));
  return mismatches;
}

export function compareTerminalWireEncoding(
  message: TerminalOutputJsonMessage,
  context: OutputWireContext,
  options: ShadowComparisonOptions = {},
): ShadowComparison {
  const jsonBytes = Buffer.byteLength(JSON.stringify(message), 'utf8');

  let encoded: OutputWireMessage;
  let bytes: Uint8Array;
  try {
    encoded = toBinaryOutputFrame(message, context);
    bytes = encodeFrame(encoded);
  } catch (error) {
    const mismatches = [{
      field: 'encode',
      expected: 'a frame',
      actual: error instanceof Error ? error.message : String(error),
    }];
    record(options.tally, mismatches);
    return { ok: false, mismatches, jsonBytes, binaryBytes: 0 };
  }

  const onWire = options.corruptBytes ? options.corruptBytes(bytes) : bytes;
  const result = decodeWsMessage(onWire, createV1DecodeContext({
    // The frame was just built for this channel, so it is active by definition;
    // the comparison is about the codec, not about routing.
    channelState: () => 'active',
    maxBodyBytes: Math.max(1, onWire.byteLength),
  }));

  const frame = result.frames[0];
  const decoded = frame === undefined ? undefined : parseFrameMessage(frame);
  if (decoded === undefined || decoded.opcode !== encoded.opcode) {
    const mismatches = [{
      field: 'decode',
      expected: `opcode ${encoded.opcode}`,
      actual: result.fatal?.code ?? result.scoped[0]?.code ?? 'no-frame',
    }];
    record(options.tally, mismatches);
    return { ok: false, mismatches, jsonBytes, binaryBytes: bytes.byteLength };
  }

  const mismatches = compareWireMessages(encoded, decoded, message.data);
  record(options.tally, mismatches);
  return {
    ok: mismatches.length === 0,
    mismatches,
    jsonBytes,
    binaryBytes: bytes.byteLength,
  };
}
