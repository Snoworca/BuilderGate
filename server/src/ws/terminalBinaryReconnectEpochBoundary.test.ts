import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ACTIVE_FLAG_MASK_V1, FRAME_VERSION_V1 } from './binaryFrameCodec.js';
import { createTerminalBinaryGroupSession } from './terminalBinaryGroupSession.js';
import type { TerminalWireFormat } from './terminalWireFormat.js';
import type { WsTransportMode } from './wsTransportMode.js';

/**
 * #20 acceptance criterion: socket/protocol mode switches ONLY at a reconnect
 * epoch.
 *
 * The mechanism for that already exists — a group captures `wireFormat` and
 * `transportMode` once at construction, and a connection group is created per
 * connection — but until now nothing asserted it. #20 exists precisely to
 * catch mechanisms that were never asserted, so these are the assertions.
 *
 * What these tests pin, stated plainly so nobody reads more into them:
 *
 *  - a group that opened on JSON cannot be talked onto the binary plane by any
 *    number of offers, so "switch now, new mode from the next message" is not
 *    reachable from the client side;
 *  - a renegotiation inside a live group does not move the codec epoch and does
 *    not empty the channel table, so no frame already on the wire is
 *    invalidated mid-connection;
 *  - two groups are independent, which is what makes a NEW connection the only
 *    thing that can carry a different mode.
 *
 * What they do NOT pin: that `codecEpoch` would be correct if something ever
 * did bump it. It is a constant 0 today; this guard exists so that adding a
 * bump is a visible, argued edit rather than a silent one.
 */

const EPOCH = '6f1a2c34-5b6d-4e7f-8091-a2b3c4d5e6f7';

function group(overrides: {
  wireFormat?: TerminalWireFormat;
  transportMode?: WsTransportMode;
} = {}) {
  return createTerminalBinaryGroupSession({
    now: () => 1000,
    wireFormat: overrides.wireFormat ?? 'binary',
    transportMode: overrides.transportMode ?? 'unified',
  });
}

function offer() {
  return {
    type: 'terminal-binary:negotiate' as const,
    supportedFrameVersions: [FRAME_VERSION_V1],
    acceptedFlagMask: ACTIVE_FLAG_MASK_V1,
  };
}

function session(sessionId: string) {
  return { sessionId, streamEpoch: '3', authorityEpoch: EPOCH };
}

test('#20 a group that opened on JSON stays on JSON however many offers arrive', () => {
  const subject = group({ wireFormat: 'json' });

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const result = subject.negotiate(offer());
    assert.equal(result.type, 'terminal-binary:rejected', `offer ${attempt}`);
    assert.equal(subject.isNegotiable, false, `offer ${attempt}`);
    assert.equal(subject.isNegotiated, false, `offer ${attempt}`);
    assert.equal(subject.wireDecision().encodeBinary, false, `offer ${attempt}`);
    assert.equal(subject.wireDecision().sendBinary, false, `offer ${attempt}`);
    assert.deepEqual(subject.openChannel(session(`s-${attempt}`)), {});
  }
});

test('#20 a split transport cannot be moved onto the binary plane inside a live group', () => {
  for (const transportMode of ['split', 'split-shadow'] as const) {
    const subject = group({ wireFormat: 'binary', transportMode });

    assert.equal(subject.isNegotiable, false, transportMode);
    assert.equal(subject.negotiate(offer()).type, 'terminal-binary:rejected', transportMode);
    assert.equal(subject.isNegotiated, false, transportMode);
    assert.equal(subject.wireDecision().sendBinary, false, transportMode);
  }
});

test('#20 renegotiating a live group moves neither the codec epoch nor the channel table', () => {
  const subject = group();

  const first = subject.negotiate(offer());
  assert.equal(first.type, 'terminal-binary:capability');
  const firstEpoch = subject.codecEpoch;
  assert.equal(first.type === 'terminal-binary:capability' ? first.codecEpoch : -1, firstEpoch);

  const opened = subject.openChannel(session('session-a'));
  assert.equal(typeof opened.channelId, 'number');

  const second = subject.negotiate(offer());
  assert.equal(second.type, 'terminal-binary:capability');
  assert.equal(subject.codecEpoch, firstEpoch, 'a renegotiation must not invalidate frames in flight');
  assert.equal(
    second.type === 'terminal-binary:capability' ? second.codecEpoch : -1,
    firstEpoch,
    'the re-acceptance must carry the epoch the client is already decoding with',
  );

  // The live table, not an empty one. An emptied table would make the client
  // refuse the very channel it is currently reading.
  const reannounced = subject.reannounce();
  assert.notEqual(reannounced, undefined);
  assert.deepEqual(
    (second.type === 'terminal-binary:capability' ? second.channels : []).map(c => c.channelId),
    [opened.channelId],
  );
  assert.deepEqual(reannounced!.channels.map(c => c.channelId), [opened.channelId]);
  assert.equal(reannounced!.codecEpoch, firstEpoch);
});

test('#20 a new group is the only thing that carries a different mode', () => {
  const live = group({ wireFormat: 'json' });
  live.negotiate(offer());
  assert.equal(live.isNegotiable, false);

  // A configuration change reaches the next connection, which is a new group.
  const next = group({ wireFormat: 'binary' });
  assert.equal(next.isNegotiable, true);
  assert.equal(next.negotiate(offer()).type, 'terminal-binary:capability');

  // ... and it does not reach back into the connection that is already open.
  assert.equal(live.isNegotiable, false);
  assert.equal(live.isNegotiated, false);
  assert.equal(live.wireDecision().sendBinary, false);
});
