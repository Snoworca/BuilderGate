import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ACTIVE_FLAG_MASK_V1, FRAME_VERSION_V1 } from './binaryFrameCodec.js';
import { createTerminalBinaryGroupSession } from './terminalBinaryGroupSession.js';
import type { TerminalWireFormat } from './terminalWireFormat.js';
import type { WsTransportMode } from './wsTransportMode.js';

/**
 * What a connection group owns for the binary data plane: its channel
 * allocator and whether it negotiated at all.
 *
 * The default configuration (`json`) must make every one of these methods a
 * no-op, because that is what keeps the whole feature invisible until someone
 * turns it on.
 */

const EPOCH = '6f1a2c34-5b6d-4e7f-8091-a2b3c4d5e6f7';

function fixedClock(start = 1000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

function group(overrides: {
  wireFormat?: TerminalWireFormat;
  transportMode?: WsTransportMode;
  everySocketBinaryCapable?: () => boolean;
} = {}) {
  const clock = fixedClock();
  const subject = createTerminalBinaryGroupSession({
    now: clock.now,
    wireFormat: overrides.wireFormat ?? 'binary',
    transportMode: overrides.transportMode ?? 'unified',
    ...(overrides.everySocketBinaryCapable
      ? { everySocketBinaryCapable: overrides.everySocketBinaryCapable }
      : {}),
  });
  return { clock, subject };
}

function offer() {
  return {
    type: 'terminal-binary:capability' as const,
    supportedFrameVersions: [FRAME_VERSION_V1],
    acceptedFlagMask: ACTIVE_FLAG_MASK_V1,
  };
}

function session(sessionId = 'session-a') {
  return { sessionId, streamEpoch: '3', authorityEpoch: EPOCH };
}

// ---------------------------------------------------------------------------
// 1. The default configuration changes nothing.
// ---------------------------------------------------------------------------

test('a json group opens no channel', () => {
  const { subject } = group({ wireFormat: 'json' });

  // The subscribed row must come back exactly as it does today: no new fields,
  // so no client can even tell the feature exists.
  assert.deepEqual(subject.openChannel(session()), {});
});

test('a json group is not negotiable', () => {
  const { subject } = group({ wireFormat: 'json' });

  assert.equal(subject.isNegotiable, false);
});

test('a json group refuses an offer instead of negotiating', () => {
  const { subject } = group({ wireFormat: 'json' });

  const result = subject.negotiate(offer());

  assert.equal(result.type, 'terminal-binary:rejected');
  assert.equal(subject.isNegotiated, false);
});

test('a shadow group opens no channel either', () => {
  // Nothing binary reaches the wire in shadow, so there is nothing to address.
  const { subject } = group({ wireFormat: 'binary-shadow' });

  assert.deepEqual(subject.openChannel(session()), {});
});

test('a split-transport group opens no channel whatever the format says', () => {
  const { subject } = group({ wireFormat: 'binary', transportMode: 'split' });

  assert.deepEqual(subject.openChannel(session()), {});
  assert.equal(subject.isNegotiable, false);
});

// ---------------------------------------------------------------------------
// 2. Channels appear only after a completed negotiation.
// ---------------------------------------------------------------------------

test('a negotiable group still opens no channel before the handshake', () => {
  const { subject } = group();

  // Negotiation happens after `connected`, and a subscribe can arrive first.
  // Handing out a channel before the client agreed to binary would address
  // frames it cannot read.
  assert.equal(subject.isNegotiable, true);
  assert.deepEqual(subject.openChannel(session()), {});
});

test('after acceptance a channel is opened and fully described', () => {
  const { subject } = group();
  subject.negotiate(offer());

  const fields = subject.openChannel(session());

  assert.ok(typeof fields.channelId === 'number' && fields.channelId > 0);
  assert.equal(fields.streamEpoch, '3');
  assert.equal(fields.authorityEpoch, EPOCH);
  assert.equal(typeof fields.authorityEpochIndex, 'number');
});

test('the row carries the UUID, not only its alias', () => {
  // Revision R3 (01:350): an index alone leaves the client unable to fill its
  // table, and every frame is then refused as unknown-channel.
  const { subject } = group();
  subject.negotiate(offer());

  assert.equal(subject.openChannel(session()).authorityEpoch, EPOCH);
});

test('two sessions get two different channels', () => {
  const { subject } = group();
  subject.negotiate(offer());

  const first = subject.openChannel(session('session-a')).channelId;
  const second = subject.openChannel(session('session-b')).channelId;

  assert.notEqual(first, second);
});

// ---------------------------------------------------------------------------
// 3. The acceptance carries the table of channels already open.
// ---------------------------------------------------------------------------

test('the acceptance seeds the channels opened before it', () => {
  const { subject } = group();
  subject.negotiate(offer());
  subject.openChannel(session('session-a'));

  // A renegotiation must hand back the live table, or the client rebuilds an
  // empty one and refuses everything already in flight.
  const result = subject.negotiate(offer());

  assert.equal(result.type, 'terminal-binary:capability');
  assert.equal('channels' in result ? result.channels.length : -1, 1);
});

test('the first acceptance seeds an empty table', () => {
  const { subject } = group();

  const result = subject.negotiate(offer());

  assert.equal('channels' in result ? result.channels.length : -1, 0);
});

test('a rejected offer leaves the group unnegotiated', () => {
  const { subject } = group();

  const result = subject.negotiate({ ...offer(), supportedFrameVersions: [] });

  assert.equal(result.type, 'terminal-binary:rejected');
  assert.equal(subject.isNegotiated, false);
});

// ---------------------------------------------------------------------------
// 4. Release.
// ---------------------------------------------------------------------------

test('closing a session reports the channels to retire', () => {
  const { subject } = group();
  subject.negotiate(offer());
  const channelId = subject.openChannel(session('session-a')).channelId;
  subject.openChannel(session('session-b'));

  assert.deepEqual(subject.closeSession('session-a'), [channelId]);
});

test('closing a session with no channel reports nothing to notify', () => {
  const { subject } = group();
  subject.negotiate(offer());

  assert.deepEqual(subject.closeSession('session-a'), []);
});

test('a closed channel is not reused for the next session', () => {
  const { subject } = group();
  subject.negotiate(offer());
  const first = subject.openChannel(session('session-a')).channelId;
  subject.closeSession('session-a');

  // Reuse is what lets a frame still in the socket buffer be written to a
  // different session's screen (01:396-401).
  assert.notEqual(subject.openChannel(session('session-b')).channelId, first);
});

test('a closed session drops out of the seeded table', () => {
  const { subject } = group();
  subject.negotiate(offer());
  subject.openChannel(session('session-a'));
  subject.closeSession('session-a');

  const result = subject.negotiate(offer());

  assert.equal('channels' in result ? result.channels.length : -1, 0);
});

// ---------------------------------------------------------------------------
// 5. The wire decision the send path asks for.
// ---------------------------------------------------------------------------

test('the send decision follows the negotiation state', () => {
  const { subject } = group();

  assert.equal(subject.wireDecision().sendBinary, false);
  subject.negotiate(offer());
  assert.equal(subject.wireDecision().sendBinary, true);
});

test('a shadow group encodes without sending, negotiated or not', () => {
  const { subject } = group({ wireFormat: 'binary-shadow' });

  const decision = subject.wireDecision();

  assert.equal(decision.encodeBinary, true);
  assert.equal(decision.sendBinary, false);
});

test('a json group never encodes', () => {
  const { subject } = group({ wireFormat: 'json' });

  assert.equal(subject.wireDecision().encodeBinary, false);
});

// ---------------------------------------------------------------------------
// A configuration gate and a socket capability are different facts.
// ---------------------------------------------------------------------------

test('a configuration that forbids binary is reported as group-not-eligible', () => {
  const { subject } = group({ wireFormat: 'json' });

  const result = subject.negotiate(offer());

  // Reporting a socket problem here would send the client chasing its own
  // connection for something only the server operator can change.
  assert.equal(result.type, 'terminal-binary:rejected');
  assert.equal(result.type === 'terminal-binary:rejected' && result.reason, 'group-not-eligible');
});

test('a transport that forbids binary is reported as group-not-eligible', () => {
  const { subject } = group({ transportMode: 'split' });

  const result = subject.negotiate(offer());

  assert.equal(result.type === 'terminal-binary:rejected' && result.reason, 'group-not-eligible');
});

test('a socket that cannot speak binary is reported as socket-not-binary-capable', () => {
  const { subject } = group({ everySocketBinaryCapable: () => false });

  const result = subject.negotiate(offer());

  assert.equal(
    result.type === 'terminal-binary:rejected' && result.reason,
    'socket-not-binary-capable',
  );
});

test('socket capability is read at each offer, not captured once', () => {
  let capable = false;
  const { subject } = group({ everySocketBinaryCapable: () => capable });
  assert.equal(
    subject.negotiate(offer()).type === 'terminal-binary:rejected',
    true,
    'the first offer should have been refused',
  );

  capable = true;

  assert.equal(subject.negotiate(offer()).type, 'terminal-binary:capability');
});

test('every socket is assumed capable when the caller supplies no predicate', () => {
  const { subject } = group();

  assert.equal(subject.negotiate(offer()).type, 'terminal-binary:capability');
});

// ---------------------------------------------------------------------------
// The codec epoch a frame must carry to still be deliverable.
// ---------------------------------------------------------------------------

test('a group reports the codec epoch it accepted the offer under', () => {
  const { subject } = group();
  const result = subject.negotiate(offer());

  assert.equal(result.type, 'terminal-binary:capability');
  assert.equal(
    subject.codecEpoch,
    result.type === 'terminal-binary:capability' ? result.codecEpoch : -1,
  );
});

test('a group that never negotiated still reports a codec epoch', () => {
  const { subject } = group({ wireFormat: 'json' });

  // A frame is only ever built after a handshake, so the value here just has to
  // be a number no frame can match rather than a crash.
  assert.equal(typeof subject.codecEpoch, 'number');
});

// ---------------------------------------------------------------------------
// Repairing a client that lost a channel row.
// ---------------------------------------------------------------------------

test('a re-announcement carries the live table and the same codec epoch', () => {
  const { subject } = group();
  const accepted = subject.negotiate(offer());
  subject.openChannel({ sessionId: 'session-a', streamEpoch: '4', authorityEpoch: 'a-uuid' });

  const again = subject.reannounce();

  assert.ok(again);
  assert.deepEqual(again.channels.map(row => row.sessionId), ['session-a']);
  assert.equal(
    again.codecEpoch,
    accepted.type === 'terminal-binary:capability' ? accepted.codecEpoch : -1,
  );
});

test('a group that never negotiated has nothing to re-announce', () => {
  const { subject } = group({ wireFormat: 'json' });

  assert.equal(subject.reannounce(), undefined);
});
