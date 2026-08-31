import {
  DATA_PLANE_OPCODE,
  createV1DecodeContext,
  decodeWsMessage,
  parseFrameMessage,
} from './binaryFrameCodec.ts';
import type {
  ChannelState,
  DecodeDiagnostic,
  DecodeRejection,
} from './binaryFrameCodec.ts';
import type { LiveOutputTokens } from './liveOutputTokens.ts';
import type { TerminalChannelRecord } from './terminalChannelRegistry.ts';
import { fromBinaryOutputFrame } from './terminalOutputDelivery.ts';
import type { TerminalOutputDelivery } from './terminalOutputDelivery.ts';

/**
 * Turns an arriving binary message into the same `onOutput` deliveries the JSON
 * path produces (`08 §2`).
 *
 * The collaborators are passed in rather than imported because the three values
 * the adapter needs live in three different owners: the channel registry holds
 * the `authorityEpoch` the frame carries only as an index, the live token store
 * holds both tokens, and only the container knows the generation those tokens
 * are stamped with. Taking them as functions keeps this module free of React
 * and therefore testable — the unit runner cannot compile JSX.
 */
export interface BinaryIntakeCollaborators {
  readonly maxBodyBytes: number;
  channelState(channelId: number): ChannelState | undefined;
  /** The channel's owner, or `undefined` when it was never registered. */
  lookupChannel(channelId: number): TerminalChannelRecord | undefined;
  /**
   * The tokens currently valid for this session, or `undefined` when none are.
   *
   * The generation is resolved by the owner at call time. Passing one in from
   * here would let a stale generation satisfy the lookup, and a token that
   * outlives its generation is written into a restore entry under an authority
   * it does not belong to.
   */
  liveTokens(sessionId: string): LiveOutputTokens | undefined;
  deliverOutput(sessionId: string, delivery: TerminalOutputDelivery): void;
}

export interface BinaryIntakeReport {
  readonly delivered: number;
  /** Channels that decoded but belong to no known session. */
  readonly unroutable: readonly number[];
  /** Opcodes that decoded but have no client wiring yet. */
  readonly unhandledOpcodes: readonly number[];
  readonly fatal?: DecodeRejection;
  readonly scoped: readonly DecodeRejection[];
  readonly diagnostics: readonly DecodeDiagnostic[];
}

export function intakeBinaryFrames(
  buffer: Uint8Array | ArrayBuffer,
  collaborators: BinaryIntakeCollaborators,
): BinaryIntakeReport {
  const result = decodeWsMessage(buffer, createV1DecodeContext({
    maxBodyBytes: collaborators.maxBodyBytes,
    channelState: channelId => collaborators.channelState(channelId),
  }));

  const unroutable: number[] = [];
  const unhandledOpcodes: number[] = [];
  let delivered = 0;

  // Frames are delivered even when `fatal` is set. The decoder reports both,
  // and the frames it already parsed are output the peer sent correctly —
  // discarding them would lose it to a fault further along the buffer.
  for (const frame of result.frames) {
    const message = parseFrameMessage(frame);
    if (message === undefined) {
      // `prologueBytes` is 0 for the opcodes that have no prologue parser yet.
      // The frame itself decoded, so reporting it here is what keeps it from
      // disappearing more quietly than an opcode that does parse.
      unhandledOpcodes.push(frame.opcode);
      continue;
    }
    if (message.opcode !== DATA_PLANE_OPCODE.OUTPUT) {
      unhandledOpcodes.push(message.opcode);
      continue;
    }

    const record = collaborators.lookupChannel(message.channelId);
    if (record === undefined) {
      unroutable.push(message.channelId);
      continue;
    }

    // Absent tokens stay absent. The container fails a delivery whose token
    // does not match the convergence it is waiting for, and that is the same
    // outcome a JSON output message carrying no token already produces.
    const tokens = collaborators.liveTokens(record.sessionId);
    collaborators.deliverOutput(record.sessionId, fromBinaryOutputFrame(message, {
      authorityEpoch: record.authorityEpoch,
      ...(tokens?.replayToken === undefined ? {} : { replayToken: tokens.replayToken }),
      ...(tokens?.repairToken === undefined ? {} : { repairToken: tokens.repairToken }),
    }));
    delivered += 1;
  }

  return {
    delivered,
    unroutable,
    unhandledOpcodes,
    ...(result.fatal === undefined ? {} : { fatal: result.fatal }),
    scoped: result.scoped,
    diagnostics: result.diagnostics,
  };
}
