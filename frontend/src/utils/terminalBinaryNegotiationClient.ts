import { ACTIVE_FLAG_MASK_V1, FRAME_VERSION_V1 } from './binaryFrameCodec.ts';
import { channelEntriesFromSubscribed } from './terminalChannelRegistry.ts';
import type { RefusedChannelRebind, TerminalChannelRegistry } from './terminalChannelRegistry.ts';

/**
 * The browser half of in-band negotiation (`01 §2.2` layer 2).
 *
 * Everything reaching `applyTerminalBinaryControlMessage` came off the wire, so
 * it is validated rather than trusted, and a malformed row costs only itself.
 */

export interface TerminalBinaryOffer {
  readonly type: 'terminal-binary:capability';
  readonly supportedFrameVersions: readonly number[];
  readonly acceptedFlagMask: number;
}

export function buildTerminalBinaryOffer(): TerminalBinaryOffer {
  return Object.freeze({
    type: 'terminal-binary:capability' as const,
    supportedFrameVersions: Object.freeze([FRAME_VERSION_V1]),
    // Includes the mandatory bits by construction: this decoder implements the
    // full v1 mask, and an offer missing them is refused by the server.
    acceptedFlagMask: ACTIVE_FLAG_MASK_V1,
  });
}

export type TerminalBinaryClientOutcome =
  | {
    readonly kind: 'negotiated';
    readonly frameVersion: number;
    readonly activeFlagMask: number;
    readonly codecEpoch: number;
    readonly seeded: number;
    readonly refused: readonly RefusedChannelRebind[];
  }
  | { readonly kind: 'rejected'; readonly reason: string; readonly supportedFrameVersions: readonly number[] }
  | { readonly kind: 'channels-retired'; readonly channelIds: readonly number[] }
  | { readonly kind: 'channels-cleared'; readonly reason: string }
  | { readonly kind: 'ignored'; readonly why: string };

/**
 * The reasons that retire individual channels. Everything else resets the whole
 * number space.
 *
 * The default is deliberately `clear`: an unknown channel is recoverable — the
 * client asks for a fresh snapshot of exactly that channel — whereas a table
 * that refuses legitimate reassignments is a silent blackout with no recovery
 * path at all (issue #31).
 */
const SESSION_SCOPED_RETIREMENT: ReadonlySet<string> = new Set([
  'session-exited',
  'session-deleted',
]);

/**
 * The server-to-client control types this module owns.
 *
 * The context routes a claimed message here and stops, so claiming one that
 * belongs to something else drops it silently — which is why this is an exact
 * membership test rather than a prefix match.
 */
const CONTROL_TYPES: ReadonlySet<string> = new Set([
  'terminal-binary:capability',
  'terminal-binary:rejected',
  'terminal-binary:channel-retired',
]);

export function isTerminalBinaryControlMessage(message: unknown): boolean {
  const record = asRecord(message);
  if (record === undefined) return false;
  if (!Object.prototype.hasOwnProperty.call(record, 'type')) return false;
  return typeof record.type === 'string' && CONTROL_TYPES.has(record.type);
}

export interface TerminalBinaryUnknownChannel {
  readonly type: 'terminal-binary:unknown-channel';
  readonly channelIds: readonly number[];
}

/**
 * The C->S recovery request for channels a batch could not be routed to
 * (`01:433`). Returns `undefined` when there is nothing to ask about, so the
 * caller cannot send an empty request once per arriving batch.
 *
 * Channel 0 is excluded: it is permanently reserved (`01:392`) and is refused
 * as `reserved-channel`, which no snapshot would fix.
 */
export function buildUnknownChannelRequest(
  channelIds: readonly number[],
): TerminalBinaryUnknownChannel | undefined {
  const recoverable = [...new Set(
    channelIds.filter(id => Number.isSafeInteger(id) && id > 0),
  )].sort((a, b) => a - b);
  if (recoverable.length === 0) return undefined;
  return Object.freeze({
    type: 'terminal-binary:unknown-channel' as const,
    channelIds: Object.freeze(recoverable),
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

export function applyTerminalBinaryControlMessage(
  message: unknown,
  registry: TerminalChannelRegistry,
): TerminalBinaryClientOutcome {
  const record = asRecord(message);
  if (record === undefined) return { kind: 'ignored', why: 'not-an-object' };

  if (record.type === 'terminal-binary:rejected') {
    const versions = Array.isArray(record.supportedFrameVersions)
      ? record.supportedFrameVersions.filter((v): v is number => typeof v === 'number')
      : [];
    return {
      kind: 'rejected',
      reason: typeof record.reason === 'string' ? record.reason : 'unspecified',
      supportedFrameVersions: versions,
    };
  }

  if (record.type === 'terminal-binary:channel-retired') {
    if (!Array.isArray(record.channelIds)) return { kind: 'ignored', why: 'no-channel-list' };
    const reason = typeof record.reason === 'string' ? record.reason : 'unspecified';

    if (!SESSION_SCOPED_RETIREMENT.has(reason)) {
      // The number space resets as a whole, so channels the message did not
      // name are landmines for the next reassignment and go too.
      registry.clear();
      return { kind: 'channels-cleared', reason };
    }

    const channelIds = record.channelIds.filter((id): id is number => Number.isSafeInteger(id));
    for (const channelId of channelIds) registry.retire(channelId);
    return { kind: 'channels-retired', channelIds };
  }

  if (record.type === 'terminal-binary:capability') {
    // The C→S offer shares this `type`. Only the server's acceptance carries
    // `accepted: true`, and only that seeds anything.
    if (record.accepted !== true) return { kind: 'ignored', why: 'not-an-acceptance' };

    const rows = Array.isArray(record.channels) ? record.channels : [];
    // An acceptance defines the authoritative table for its epoch; merging into
    // the previous one would refuse every reassigned number.
    registry.clear();
    const refused = registry.registerAll(channelEntriesFromSubscribed(rows));

    return {
      kind: 'negotiated',
      frameVersion: typeof record.frameVersion === 'number' ? record.frameVersion : FRAME_VERSION_V1,
      activeFlagMask: typeof record.activeFlagMask === 'number'
        ? record.activeFlagMask
        : ACTIVE_FLAG_MASK_V1,
      codecEpoch: typeof record.codecEpoch === 'number' ? record.codecEpoch : 0,
      seeded: registry.size,
      refused,
    };
  }

  return { kind: 'ignored', why: 'unrelated-type' };
}
