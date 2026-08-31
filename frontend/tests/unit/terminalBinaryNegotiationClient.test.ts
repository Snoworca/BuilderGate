import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ACTIVE_FLAG_MASK_V1, FRAME_VERSION_V1, MANDATORY_FLAGS } from '../../src/utils/binaryFrameCodec.ts';
import {
  applyTerminalBinaryControlMessage,
  buildUnknownChannelRequest,
  isTerminalBinaryControlMessage,
  buildTerminalBinaryOffer,
} from '../../src/utils/terminalBinaryNegotiationClient.ts';
import { createTerminalChannelRegistry } from '../../src/utils/terminalChannelRegistry.ts';

/**
 * The browser half of `01 §2.2`, and the fix issue #31 asks for.
 *
 * `terminal-binary:channel-retired` carries a `reason`, and the two groups of
 * reasons need opposite handling. Treating them alike is what turns a codec
 * epoch bump into a silent, every-channel blackout: `retire` marks a channel used
 * forever, so a legitimate reassignment of the same numbers is refused and
 * every frame is dropped with nothing on screen and nothing in the console.
 */

const EPOCH_A = '11111111-1111-4111-8111-111111111111';
const EPOCH_B = '22222222-2222-4222-8222-222222222222';

function seed(channelId: number, sessionId: string, authorityEpoch = EPOCH_A) {
  return { channelId, sessionId, authorityEpoch, streamEpoch: '1', authorityEpochIndex: 0 };
}

function accepted(channels: ReturnType<typeof seed>[], codecEpoch = 0) {
  return {
    type: 'terminal-binary:capability',
    accepted: true,
    frameVersion: FRAME_VERSION_V1,
    activeFlagMask: ACTIVE_FLAG_MASK_V1,
    codecEpoch,
    channels,
  };
}

// ---------------------------------------------------------------------------
// 1. The offer.
// ---------------------------------------------------------------------------

test('the offer accepts every mandatory flag', () => {
  const offer = buildTerminalBinaryOffer();

  // A client that cannot read the mandatory bits cannot read any frame, and the
  // server refuses such an offer outright.
  assert.equal(offer.acceptedFlagMask & MANDATORY_FLAGS, MANDATORY_FLAGS);
});

test('the offer advertises the frame version this decoder implements', () => {
  const offer = buildTerminalBinaryOffer();

  assert.deepEqual(offer.supportedFrameVersions, [FRAME_VERSION_V1]);
  assert.equal(offer.type, 'terminal-binary:capability');
});

// ---------------------------------------------------------------------------
// 2. Acceptance seeds the table.
// ---------------------------------------------------------------------------

test('an acceptance seeds the channel table', () => {
  const registry = createTerminalChannelRegistry();

  const outcome = applyTerminalBinaryControlMessage(
    accepted([seed(1, 'session-a'), seed(2, 'session-b')]),
    registry,
  );

  assert.equal(outcome.kind, 'negotiated');
  assert.equal(registry.lookup(1)?.sessionId, 'session-a');
  assert.equal(registry.lookup(2)?.sessionId, 'session-b');
});

test('a seeded channel carries the authority UUID, not just the index', () => {
  const registry = createTerminalChannelRegistry();

  applyTerminalBinaryControlMessage(accepted([seed(1, 'session-a', EPOCH_B)]), registry);

  assert.equal(registry.lookup(1)?.authorityEpoch, EPOCH_B);
});

test('a fresh acceptance replaces the previous table rather than colliding with it', () => {
  const registry = createTerminalChannelRegistry();
  applyTerminalBinaryControlMessage(accepted([seed(1, 'session-a')]), registry);

  // Renegotiation defines the authoritative table for the new epoch. Merging
  // into the old one would refuse every reassigned number.
  const outcome = applyTerminalBinaryControlMessage(
    accepted([seed(1, 'session-z')], 1),
    registry,
  );

  assert.equal(outcome.kind, 'negotiated');
  assert.equal(registry.lookup(1)?.sessionId, 'session-z');
});

// ---------------------------------------------------------------------------
// 3. Issue #31 — the reason decides retire versus clear.
// ---------------------------------------------------------------------------

test('a session-scoped retirement retires only the named channels', () => {
  const registry = createTerminalChannelRegistry();
  applyTerminalBinaryControlMessage(
    accepted([seed(1, 'session-a'), seed(2, 'session-b')]),
    registry,
  );

  const outcome = applyTerminalBinaryControlMessage({
    type: 'terminal-binary:channel-retired',
    channelIds: [1],
    reason: 'session-exited',
  }, registry);

  assert.equal(outcome.kind, 'channels-retired');
  assert.equal(registry.channelState(1), 'retired');
  assert.equal(registry.channelState(2), 'active');
});

test('session-deleted retires rather than clearing', () => {
  const registry = createTerminalChannelRegistry();
  applyTerminalBinaryControlMessage(
    accepted([seed(1, 'session-a'), seed(2, 'session-b')]),
    registry,
  );

  applyTerminalBinaryControlMessage({
    type: 'terminal-binary:channel-retired',
    channelIds: [1],
    reason: 'session-deleted',
  }, registry);

  assert.equal(registry.channelState(2), 'active');
});

for (const reason of ['codec-epoch-bump', 'group-rebound'] as const) {
  test(`${reason} clears the whole table so reassignment is accepted`, () => {
    const registry = createTerminalChannelRegistry();
    applyTerminalBinaryControlMessage(
      accepted([seed(1, 'session-a'), seed(2, 'session-b'), seed(3, 'session-c')]),
      registry,
    );

    const outcome = applyTerminalBinaryControlMessage({
      type: 'terminal-binary:channel-retired',
      channelIds: [1, 2, 3],
      reason,
    }, registry);

    assert.equal(outcome.kind, 'channels-cleared');
    assert.equal(registry.size, 0);

    // The whole point: the server legitimately hands the same numbers to other
    // sessions after the bump. Retiring instead of clearing would refuse all
    // three and leave the terminal black with no error.
    const refused = registry.registerAll([
      { channelId: 1, sessionId: 'session-x', authorityEpoch: EPOCH_B, streamEpoch: '1' },
      { channelId: 2, sessionId: 'session-y', authorityEpoch: EPOCH_B, streamEpoch: '1' },
      { channelId: 3, sessionId: 'session-z', authorityEpoch: EPOCH_B, streamEpoch: '1' },
    ]);

    assert.deepEqual(refused, []);
    assert.equal(registry.lookup(1)?.sessionId, 'session-x');
  });
}

test('an epoch bump clears channels the message did not even name', () => {
  const registry = createTerminalChannelRegistry();
  applyTerminalBinaryControlMessage(
    accepted([seed(1, 'session-a'), seed(2, 'session-b')]),
    registry,
  );

  applyTerminalBinaryControlMessage({
    type: 'terminal-binary:channel-retired',
    channelIds: [1],
    reason: 'codec-epoch-bump',
  }, registry);

  // The number space resets as a whole, so a partial clear would leave 2 as a
  // landmine for the next reassignment.
  assert.equal(registry.size, 0);
});

test('an unrecognised reason clears rather than retires', () => {
  const registry = createTerminalChannelRegistry();
  applyTerminalBinaryControlMessage(accepted([seed(1, 'session-a')]), registry);

  // Fail safe: an unknown channel is recoverable — the client asks for a fresh
  // snapshot of that channel — while a frozen table is a silent blackout with
  // no recovery path at all.
  const outcome = applyTerminalBinaryControlMessage({
    type: 'terminal-binary:channel-retired',
    channelIds: [1],
    reason: 'something-a-newer-server-invented',
  }, registry);

  assert.equal(outcome.kind, 'channels-cleared');
  assert.equal(registry.size, 0);
});

// ---------------------------------------------------------------------------
// 4. Rejection.
// ---------------------------------------------------------------------------

test('a rejection reports the reason and leaves the table untouched', () => {
  const registry = createTerminalChannelRegistry();
  applyTerminalBinaryControlMessage(accepted([seed(1, 'session-a')]), registry);

  const outcome = applyTerminalBinaryControlMessage({
    type: 'terminal-binary:rejected',
    supportedFrameVersions: [2],
    phase: 'offer',
    reason: 'unsupported-version',
  }, registry);

  assert.equal(outcome.kind, 'rejected');
  assert.equal(registry.size, 1);
});

// ---------------------------------------------------------------------------
// 5. Untrusted input — every one of these arrives from the wire.
// ---------------------------------------------------------------------------

test('a message of an unrelated type is ignored', () => {
  const registry = createTerminalChannelRegistry();

  assert.equal(applyTerminalBinaryControlMessage({ type: 'output' }, registry).kind, 'ignored');
});

test('a non-object message is ignored', () => {
  const registry = createTerminalChannelRegistry();

  for (const value of [null, undefined, 42, 'terminal-binary:capability', []]) {
    assert.equal(applyTerminalBinaryControlMessage(value, registry).kind, 'ignored');
  }
});

test('an array is ignored even when it carries a message-shaped property', () => {
  const registry = createTerminalChannelRegistry();
  applyTerminalBinaryControlMessage(accepted([seed(1, 'session-a')]), registry);

  // `JSON.parse` cannot produce this, but the entry point takes `unknown` and
  // the array guard is what stops a caller from reaching the table with one.
  const arrayWithType = Object.assign([], {
    type: 'terminal-binary:channel-retired',
    channelIds: [1],
    reason: 'codec-epoch-bump',
  });

  assert.equal(applyTerminalBinaryControlMessage(arrayWithType, registry).kind, 'ignored');
  assert.equal(registry.size, 1);
});

test('an acceptance with a malformed channel row seeds the rest', () => {
  const registry = createTerminalChannelRegistry();

  const outcome = applyTerminalBinaryControlMessage({
    ...accepted([seed(1, 'session-a')]),
    channels: [seed(1, 'session-a'), { channelId: 'two', sessionId: 'session-b' }],
  }, registry);

  // A bad row is the server's bug, not a reason to lose the good rows with it.
  assert.equal(outcome.kind, 'negotiated');
  assert.equal(registry.lookup(1)?.sessionId, 'session-a');
  assert.equal(registry.size, 1);
});

test('a channel-retired message with no channel list is ignored', () => {
  const registry = createTerminalChannelRegistry();
  applyTerminalBinaryControlMessage(accepted([seed(1, 'session-a')]), registry);

  const outcome = applyTerminalBinaryControlMessage({
    type: 'terminal-binary:channel-retired',
    reason: 'session-exited',
  }, registry);

  assert.equal(outcome.kind, 'ignored');
  assert.equal(registry.channelState(1), 'active');
});

test('a capability message that is not an acceptance is ignored', () => {
  const registry = createTerminalChannelRegistry();

  // The C→S offer shares the `type` string; receiving one back is not an
  // acceptance and must not seed anything.
  const outcome = applyTerminalBinaryControlMessage({
    type: 'terminal-binary:capability',
    supportedFrameVersions: [1],
    acceptedFlagMask: ACTIVE_FLAG_MASK_V1,
  }, registry);

  assert.equal(outcome.kind, 'ignored');
  assert.equal(registry.size, 0);
});

// ---------------------------------------------------------------------------
// Which arriving JSON messages belong to this module at all.
// ---------------------------------------------------------------------------

test('the three server control types are recognised', () => {
  for (const type of [
    'terminal-binary:capability',
    'terminal-binary:rejected',
    'terminal-binary:channel-retired',
  ]) {
    assert.equal(isTerminalBinaryControlMessage({ type }), true, type);
  }
});

test('an unrelated type is not claimed', () => {
  // Claiming one would swallow it: the context routes a claimed message here
  // and returns, so a false positive silently drops a real message.
  for (const type of ['subscribed', 'output', 'terminal-delivery:capability', 'pong']) {
    assert.equal(isTerminalBinaryControlMessage({ type }), false, type);
  }
});

test('a prefix match is not enough', () => {
  assert.equal(isTerminalBinaryControlMessage({ type: 'terminal-binary:' }), false);
  assert.equal(isTerminalBinaryControlMessage({ type: 'terminal-binary:capability-v2' }), false);
});

test('a non-object or a missing type is not claimed', () => {
  assert.equal(isTerminalBinaryControlMessage(null), false);
  assert.equal(isTerminalBinaryControlMessage('terminal-binary:capability'), false);
  assert.equal(isTerminalBinaryControlMessage([{ type: 'terminal-binary:capability' }]), false);
  assert.equal(isTerminalBinaryControlMessage({}), false);
  assert.equal(isTerminalBinaryControlMessage({ type: 1 }), false);
});

test('an inherited type is not claimed', () => {
  const inherited = Object.create({ type: 'terminal-binary:capability' }) as object;
  assert.equal(isTerminalBinaryControlMessage(inherited), false);
});

// ---------------------------------------------------------------------------
// Asking the server to recover exactly the channels we could not route.
// ---------------------------------------------------------------------------

test('an unknown channel becomes a recovery request naming only that channel', () => {
  assert.deepEqual(buildUnknownChannelRequest([7]), {
    type: 'terminal-binary:unknown-channel',
    channelIds: [7],
  });
});

test('nothing unroutable produces no request at all', () => {
  // Sending an empty request would ask the server to recover nothing, once per
  // arriving batch.
  assert.equal(buildUnknownChannelRequest([]), undefined);
});

test('a repeated channel is asked about once', () => {
  assert.deepEqual(buildUnknownChannelRequest([7, 7, 7])?.channelIds, [7]);
});

test('the request is ordered so two identical batches produce identical messages', () => {
  assert.deepEqual(buildUnknownChannelRequest([9, 2, 7])?.channelIds, [2, 7, 9]);
});

test('a reserved or malformed channel id is never asked about', () => {
  // `01:392` — channel 0 is permanently reserved and is refused as
  // `reserved-channel`, not recovered.
  assert.equal(buildUnknownChannelRequest([0]), undefined);
  assert.equal(buildUnknownChannelRequest([-1]), undefined);
  assert.equal(buildUnknownChannelRequest([1.5]), undefined);
  assert.equal(buildUnknownChannelRequest([Number.NaN]), undefined);
});

test('valid ids survive alongside invalid ones', () => {
  assert.deepEqual(buildUnknownChannelRequest([0, 5, -1])?.channelIds, [5]);
});

test('the request is frozen so a caller cannot mutate what was sent', () => {
  const request = buildUnknownChannelRequest([3]);
  assert.ok(request);
  assert.equal(Object.isFrozen(request), true);
  assert.equal(Object.isFrozen(request.channelIds), true);
});

test('the offer is frozen so a caller cannot alter what every socket sends', () => {
  const offer = buildTerminalBinaryOffer();

  // The offer is shared across sockets; a mutable one lets a single caller
  // change what every later connection negotiates.
  assert.equal(Object.isFrozen(offer), true);
  assert.equal(Object.isFrozen(offer.supportedFrameVersions), true);
});
