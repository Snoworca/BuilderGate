import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ACTIVE_FLAG_MASK_V1, FRAME_VERSION_V1, MANDATORY_FLAGS } from './binaryFrameCodec.js';
import { resolveTerminalBinaryNegotiation } from './terminalBinaryNegotiation.js';
import type {
  TerminalBinaryCapabilityAccepted,
  TerminalBinaryCapabilityOffer,
  TerminalBinaryNegotiationInput,
  TerminalBinaryNegotiationResult,
  TerminalBinaryRejected,
} from './terminalBinaryNegotiation.js';

/**
 * Narrow on the discriminant at runtime so the compiler narrows too. A bare
 * cast would keep compiling after the union changed shape, and the assertions
 * below it would quietly stop checking anything.
 */
function assertAccepted(
  result: TerminalBinaryNegotiationResult,
): asserts result is TerminalBinaryCapabilityAccepted {
  assert.equal(result.type, 'terminal-binary:capability');
  assert.equal((result as TerminalBinaryCapabilityAccepted).accepted, true);
}

function assertRejected(
  result: TerminalBinaryNegotiationResult,
): asserts result is TerminalBinaryRejected {
  assert.equal(result.type, 'terminal-binary:rejected');
}

/**
 * `01 §2.2` layer 2 — the in-band, group-scoped half of the handshake.
 *
 * The resolver is pure: it takes the client's offer plus what the server can do
 * and returns the message to send back. Nothing here touches a socket, so every
 * rejection reason is reachable in a test.
 */

const CHANNELS = [
  {
    sessionId: 'session-a',
    channelId: 1,
    streamEpoch: '3',
    authorityEpochIndex: 0,
    authorityEpoch: '6f1a2c34-5b6d-4e7f-8091-a2b3c4d5e6f7',
  },
];

function offer(overrides: Partial<TerminalBinaryCapabilityOffer> = {}): TerminalBinaryCapabilityOffer {
  return {
    type: 'terminal-binary:capability',
    supportedFrameVersions: [FRAME_VERSION_V1],
    acceptedFlagMask: ACTIVE_FLAG_MASK_V1,
    ...overrides,
  };
}

function input(overrides: Partial<TerminalBinaryNegotiationInput> = {}): TerminalBinaryNegotiationInput {
  return {
    offer: offer(),
    supportedFrameVersions: [FRAME_VERSION_V1],
    serverFlagMask: ACTIVE_FLAG_MASK_V1,
    codecEpoch: 0,
    channels: CHANNELS,
    everySocketBinaryCapable: true,
    groupEligible: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. The accepted path.
// ---------------------------------------------------------------------------

test('a matching offer is accepted with a single frame version', () => {
  const result = resolveTerminalBinaryNegotiation(input());

  assertAccepted(result);
  assert.equal(result.frameVersion, FRAME_VERSION_V1);
});

test('the accepted mask is the intersection, never wider than the client accepted', () => {
  // The server may only set bits the client said it can read (01 §1.2).
  const result = resolveTerminalBinaryNegotiation(input({
    offer: offer({ acceptedFlagMask: MANDATORY_FLAGS }),
  }));

  assertAccepted(result);
  assert.equal(result.activeFlagMask, MANDATORY_FLAGS);
});

test('a client mask with bits the server does not set narrows to the server mask', () => {
  const result = resolveTerminalBinaryNegotiation(input({
    offer: offer({ acceptedFlagMask: 0xFFFF }),
  }));

  assertAccepted(result);
  assert.equal(result.activeFlagMask, ACTIVE_FLAG_MASK_V1);
});

test('the highest common frame version is chosen', () => {
  const result = resolveTerminalBinaryNegotiation(input({
    offer: offer({ supportedFrameVersions: [1, 2, 3] }),
    supportedFrameVersions: [1, 2],
  }));

  assertAccepted(result);
  assert.equal(result.frameVersion, 2);
});

test('the initial channel table is carried on the acceptance', () => {
  // Negotiation happens after `connected`, by which time subscribes may already
  // be in flight. Without the seed table those sessions' first frames would all
  // be unknown-channel (01:739).
  const result = resolveTerminalBinaryNegotiation(input());

  assertAccepted(result);
  assert.deepEqual(result.channels, CHANNELS);
});

test('the acceptance carries the codec epoch', () => {
  const result = resolveTerminalBinaryNegotiation(input({ codecEpoch: 7 }));

  assertAccepted(result);
  assert.equal(result.codecEpoch, 7);
});

test('each accepted channel carries the UUID as well as its index', () => {
  // Revision R3 (01:350): an index alone cannot be resolved back to an
  // authority, so the table would stay empty and every frame would be refused.
  const result = resolveTerminalBinaryNegotiation(input());

  assertAccepted(result);
  assert.equal(typeof result.channels[0].authorityEpoch, 'string');
  assert.equal(typeof result.channels[0].authorityEpochIndex, 'number');
});

// ---------------------------------------------------------------------------
// 2. Rejections — every reason in `01:748-755` is reachable.
// ---------------------------------------------------------------------------

test('no common frame version is rejected as unsupported-version', () => {
  const result = resolveTerminalBinaryNegotiation(input({
    offer: offer({ supportedFrameVersions: [9] }),
  }));

  assertRejected(result);
  assert.equal(result.reason, 'unsupported-version');
  assert.equal(result.phase, 'offer');
});

test('a rejection advertises what the server does support', () => {
  const result = resolveTerminalBinaryNegotiation(input({
    offer: offer({ supportedFrameVersions: [9] }),
    supportedFrameVersions: [1, 2],
  }));

  assertRejected(result);
  assert.deepEqual(result.supportedFrameVersions, [1, 2]);
});

test('dropping a mandatory flag is rejected', () => {
  // The mandatory bits are what make a frame self-delimiting; a client that
  // cannot read them cannot read any frame (01 §1.2).
  const result = resolveTerminalBinaryNegotiation(input({
    offer: offer({ acceptedFlagMask: ACTIVE_FLAG_MASK_V1 & ~MANDATORY_FLAGS }),
  }));

  assertRejected(result);
  assert.equal(result.reason, 'mandatory-flag-not-accepted');
});

test('dropping only part of the mandatory bits is still rejected', () => {
  const result = resolveTerminalBinaryNegotiation(input({
    offer: offer({ acceptedFlagMask: ACTIVE_FLAG_MASK_V1 & ~0x0008 }),
  }));

  assertRejected(result);
  assert.equal(result.reason, 'mandatory-flag-not-accepted');
});

test('a socket that never negotiated the subprotocol is rejected', () => {
  // Terminal payload falls back from the output socket to the control socket,
  // so one non-capable socket in the group makes the whole group unusable.
  const result = resolveTerminalBinaryNegotiation(input({ everySocketBinaryCapable: false }));

  assertRejected(result);
  assert.equal(result.reason, 'socket-not-binary-capable');
});

test('an ineligible group is rejected', () => {
  const result = resolveTerminalBinaryNegotiation(input({ groupEligible: false }));

  assertRejected(result);
  assert.equal(result.reason, 'group-not-eligible');
});

// ---------------------------------------------------------------------------
// 3. Malformed offers — the message arrives from the wire and is untrusted.
// ---------------------------------------------------------------------------

test('an empty version list is rejected as invalid rather than unsupported', () => {
  const result = resolveTerminalBinaryNegotiation(input({
    offer: offer({ supportedFrameVersions: [] }),
  }));

  assertRejected(result);
  assert.equal(result.reason, 'invalid-message');
});

test('a non-integer frame version is rejected as invalid', () => {
  const result = resolveTerminalBinaryNegotiation(input({
    offer: offer({ supportedFrameVersions: [1.5] }),
  }));

  assertRejected(result);
  assert.equal(result.reason, 'invalid-message');
});

test('a negative flag mask is rejected as invalid', () => {
  const result = resolveTerminalBinaryNegotiation(input({
    offer: offer({ acceptedFlagMask: -1 }),
  }));

  assertRejected(result);
  assert.equal(result.reason, 'invalid-message');
});

test('a non-integer flag mask is rejected as invalid', () => {
  const result = resolveTerminalBinaryNegotiation(input({
    offer: offer({ acceptedFlagMask: Number.NaN }),
  }));

  assertRejected(result);
  assert.equal(result.reason, 'invalid-message');
});

test('a non-positive maxBatchBytes is rejected as invalid', () => {
  const result = resolveTerminalBinaryNegotiation(input({
    offer: offer({ maxBatchBytes: 0 }),
  }));

  assertRejected(result);
  assert.equal(result.reason, 'invalid-message');
});

test('an omitted maxBatchBytes is accepted', () => {
  const result = resolveTerminalBinaryNegotiation(input({
    offer: offer({ maxBatchBytes: undefined }),
  }));

  assertAccepted(result);
});

// ---------------------------------------------------------------------------
// 4. Precedence — a malformed offer is not diagnosed as something subtler.
// ---------------------------------------------------------------------------

test('validity is decided before eligibility', () => {
  // Reporting `group-not-eligible` for a malformed message would send the
  // client looking for a server-side condition that is not the problem.
  const result = resolveTerminalBinaryNegotiation(input({
    offer: offer({ supportedFrameVersions: [] }),
    groupEligible: false,
  }));

  assertRejected(result);
  assert.equal(result.reason, 'invalid-message');
});

test('socket capability is decided before version intersection', () => {
  const result = resolveTerminalBinaryNegotiation(input({
    offer: offer({ supportedFrameVersions: [9] }),
    everySocketBinaryCapable: false,
  }));

  assertRejected(result);
  assert.equal(result.reason, 'socket-not-binary-capable');
});
