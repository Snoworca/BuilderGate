import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  channelEntriesFromSubscribed,
  createTerminalChannelRegistry,
  type TerminalChannelRecord,
} from '../../src/utils/terminalChannelRegistry.ts';
import { createV1DecodeContext } from '../../src/utils/binaryFrameCodec.ts';

/**
 * S4-C5c — the channel registry.
 *
 * `08:192` fixes the shape: `Map<channelId, { sessionId, authorityEpoch,
 * streamEpoch }>`, owned by a `WebSocketContext` ref so its lifetime is the
 * socket's rather than a view's.
 *
 * There is no `authorityEpochIndex` column. A channel is 1:1 with a session
 * (`01:369-371` allocates on subscribe and releases on unsubscribe; `01:393`
 * forbids reuse) and `authorityEpoch` is assigned once per session and never
 * reassigned (`08:170`), so within one channel the index has exactly one
 * possible value — the session's. Keying by channel makes the index a
 * redundant restatement rather than a lookup key.
 *
 * The registry's real consumer is `createV1DecodeContext`, which needs
 * `channelState(channelId)` to return `'active' | 'retired' | undefined`. Those
 * three answers are not interchangeable: `undefined` is a scoped rejection,
 * `'retired'` is a silent drop with a diagnostic.
 */

function record(overrides: Partial<TerminalChannelRecord> = {}): TerminalChannelRecord {
  return {
    sessionId: 'sess-1',
    authorityEpoch: '3f1b2c4d-0000-4000-8000-000000000001',
    streamEpoch: '7',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Lookup — the three distinct answers.
// ---------------------------------------------------------------------------

test('a registered channel resolves to its record', () => {
  const registry = createTerminalChannelRegistry();
  registry.registerOrRefusal(1, record());

  assert.deepEqual(registry.lookup(1), record());
  assert.equal(registry.channelState(1), 'active');
});

test('an unregistered channel is undefined, not a default record', () => {
  // `decodeWsMessage` turns `undefined` into `scoped('unknown-channel')`. A
  // fabricated record would route someone else's bytes into a live session.
  const registry = createTerminalChannelRegistry();
  registry.registerOrRefusal(1, record());

  assert.equal(registry.lookup(2), undefined);
  assert.equal(registry.channelState(2), undefined);
  assert.equal(registry.channelState(0), undefined);
});

test('a retired channel is retired, not unknown and not active', () => {
  // The codec branches three ways. Collapsing retired into unknown would turn a
  // silent drop into a rejection; collapsing it into active would write to a
  // session the client already discarded.
  const registry = createTerminalChannelRegistry();
  registry.registerOrRefusal(1, record());
  registry.retire(1);

  assert.equal(registry.channelState(1), 'retired');
  assert.equal(registry.lookup(1), undefined, 'a retired channel has no usable record');
});

test('retiring a channel that was never registered leaves it unknown', () => {
  // Otherwise a stray `channel-retired` would mint a retired entry and convert
  // later unknown-channel rejections into silent drops.
  const registry = createTerminalChannelRegistry();
  registry.retire(9);

  assert.equal(registry.channelState(9), undefined);
});

// ---------------------------------------------------------------------------
// 2. Population — both sources carry the same object shape.
// ---------------------------------------------------------------------------

test('registerAll fills the table from an array of rows', () => {
  // ⚠️ This does NOT cover `terminal-binary:capability.channels[]` (`01:725-737`).
  // That message type does not exist in the frontend yet — D10 is unimplemented
  // — so there is no call site to test. This exercises `registerAll` with a
  // hand-built array and would pass unchanged if the capability message were
  // deleted from the spec. Naming it after that message would have claimed
  // coverage this file does not have.
  const registry = createTerminalChannelRegistry();
  registry.registerAll([
    { channelId: 1, ...record({ sessionId: 'a', streamEpoch: '1' }) },
    { channelId: 2, ...record({ sessionId: 'b', streamEpoch: '2' }) },
  ]);

  assert.equal(registry.lookup(1)?.sessionId, 'a');
  assert.equal(registry.lookup(2)?.sessionId, 'b');
  assert.equal(registry.size, 2);
});

test('registerAll on an empty list is a no-op, not a reset', () => {
  // A JSON-only group accepts with `channels: []`. Treating that as "clear"
  // would drop channels a prior message established.
  const registry = createTerminalChannelRegistry();
  registry.registerOrRefusal(1, record());
  registry.registerAll([]);

  assert.equal(registry.channelState(1), 'active');
});

test('re-registering a retired channel to the SAME session revives it', () => {
  // A session that unsubscribes and resubscribes within one codecEpoch keeps
  // its channel id (`01:394` — one channel per session). Leaving it retired
  // would silently drop that session's output for the life of the socket, and
  // nothing is ambiguous here: same channel, same session, same authorityEpoch.
  const registry = createTerminalChannelRegistry();
  registry.registerOrRefusal(1, record({ sessionId: 'a', streamEpoch: '1' }));
  registry.retire(1);
  registry.registerOrRefusal(1, record({ sessionId: 'a', streamEpoch: '9' }));

  assert.equal(registry.channelState(1), 'active');
  assert.equal(registry.lookup(1)?.streamEpoch, '9');
});

test('re-registering a retired channel to a DIFFERENT session is refused', () => {
  // `01:392` rule 2 forbids the allocator from reusing a released channelId
  // within a codecEpoch, and `01:396-400` spells out why: a frame for the old
  // owner can still be sitting in the socket buffer. Accepting the reassignment
  // is exactly what lets that frame be written to the new owner's screen.
  //
  // So this is an impossible state, and `08:197` says impossible states
  // fail closed. The channel stays retired: frames on it keep being dropped
  // instead of being handed to the wrong session.
  const registry = createTerminalChannelRegistry();
  registry.registerOrRefusal(1, record({ sessionId: 'a' }));
  registry.retire(1);
  registry.registerOrRefusal(1, record({ sessionId: 'b' }));

  assert.equal(registry.channelState(1), 'retired');
  assert.equal(registry.lookup(1), undefined);
});

test('a refused reassignment does not keep the old session addressable either', () => {
  // Fail-closed means neither owner gets the bytes. Reverting to session 'a'
  // would be just as wrong in the other direction — 'a' has unsubscribed.
  const registry = createTerminalChannelRegistry();
  registry.registerOrRefusal(1, record({ sessionId: 'a' }));
  registry.retire(1);
  registry.registerOrRefusal(1, record({ sessionId: 'b' }));

  assert.equal(registry.lookup(1), undefined);
  assert.equal(registry.size, 1, 'the channel is still tracked, so it stays retired rather than unknown');
});

test('clear lets a channel id be reassigned, because codecEpoch moved', () => {
  // The reuse ban is scoped to one codecEpoch (`01:392`). A codecEpoch change
  // discards the queue and calls `clear()`, after which the id is genuinely
  // free — refusing there would strand ids permanently.
  const registry = createTerminalChannelRegistry();
  registry.registerOrRefusal(1, record({ sessionId: 'a' }));
  registry.retire(1);
  registry.clear();
  registry.registerOrRefusal(1, record({ sessionId: 'b' }));

  assert.equal(registry.channelState(1), 'active');
  assert.equal(registry.lookup(1)?.sessionId, 'b');
});

test('an ACTIVE channel is refused a different session too', () => {
  // The earlier version of this test asserted the opposite, on the premise that
  // only retired channels carry the in-flight-frame hazard. That premise is
  // false: frames for the old owner are in flight the whole time it is
  // subscribed. Retirement is only the case the client happens to observe — and
  // the one it observes least, since `terminal-binary:channel-retired` is not
  // wired. The server-driven reassignment therefore usually arrives while the
  // channel still reads 'active', which is exactly where the old guard was blind.
  const registry = createTerminalChannelRegistry();
  registry.registerOrRefusal(1, record({ sessionId: 'a' }));
  registry.registerOrRefusal(1, record({ sessionId: 'b' }));

  assert.equal(registry.lookup(1)?.sessionId, 'a', 'the incumbent keeps the channel');
});

test('a same-session revival does not reopen the channel to a third party', () => {
  // Keying the guard on `state === 'retired'` made a legitimate revival erase
  // the retirement memory, so the very next message could rebind freely.
  const registry = createTerminalChannelRegistry();
  registry.registerOrRefusal(1, record({ sessionId: 'a' }));
  registry.retire(1);
  registry.registerOrRefusal(1, record({ sessionId: 'a' }));
  registry.registerOrRefusal(1, record({ sessionId: 'b' }));

  assert.equal(registry.lookup(1)?.sessionId, 'a');
});

test('a refusal is reported to the caller, not swallowed', () => {
  // A refusal means the server reassigned a channel it still owed to someone
  // else — the most alarming thing this module can witness. Afterwards the
  // codec emits `terminal_binary_retired_channel_frame` per frame, which reads
  // as an ordinary retired-channel drop, so without a distinct signal here the
  // violation is indistinguishable from routine traffic in telemetry.
  const registry = createTerminalChannelRegistry();
  assert.equal(registry.registerOrRefusal(1, record({ sessionId: 'a' })), undefined);
  assert.deepEqual(registry.registerOrRefusal(1, record({ sessionId: 'b' })), {
    channelId: 1,
    incumbentSessionId: 'a',
    incomingSessionId: 'b',
  });
});

test('the refusal names the incumbent even when the channel is retired', () => {
  // The retired entry still remembers who owned it, and that is the session
  // whose frames may be in flight — the whole reason the rebind is refused.
  const registry = createTerminalChannelRegistry();
  registry.registerOrRefusal(1, record({ sessionId: 'a' }));
  registry.retire(1);

  assert.deepEqual(registry.registerOrRefusal(1, record({ sessionId: 'b' })), {
    channelId: 1,
    incumbentSessionId: 'a',
    incomingSessionId: 'b',
  });
});

test('registerAll returns every row it refused, with both session ids', () => {
  // Both ids are needed to act on it: the incumbent says whose frames are still
  // in flight, the incoming one says which session is now without a channel.
  const registry = createTerminalChannelRegistry();
  registry.registerOrRefusal(4, record({ sessionId: 'a' }));

  const refused = registry.registerAll([
    { channelId: 4, ...record({ sessionId: 'b' }) },
    { channelId: 5, ...record({ sessionId: 'c' }) },
  ]);

  assert.deepEqual(refused, [{ channelId: 4, incumbentSessionId: 'a', incomingSessionId: 'b' }]);
  assert.equal(registry.lookup(5)?.sessionId, 'c', 'the healthy row still lands');
});

test('registerAll reports nothing when every row is accepted', () => {
  // The empty array is the normal case, so it must be distinguishable from "we
  // did not check" — a caller that logs on truthiness would otherwise be silent
  // forever or noisy forever.
  const registry = createTerminalChannelRegistry();
  const refused = registry.registerAll([{ channelId: 4, ...record({ sessionId: 'a' }) }]);

  assert.deepEqual(refused, []);
});

test('a duplicate channelId inside one registerAll is not last-wins', () => {
  // Two rows for one channel in a single message is itself a server fault. The
  // first row winning is arbitrary but stable; the second winning would be a
  // rebind performed inside one message, with no retirement in between.
  const registry = createTerminalChannelRegistry();
  const refused = registry.registerAll([
    { channelId: 1, ...record({ sessionId: 'a' }) },
    { channelId: 1, ...record({ sessionId: 'b' }) },
  ]);

  assert.equal(registry.size, 1);
  assert.equal(registry.lookup(1)?.sessionId, 'a');
  // The incumbent named is row 1's session, established moments earlier in this
  // same call — which is right, because that is who owns the channel at the
  // instant row 2 is refused and whose frames could be in flight.
  assert.deepEqual(refused, [{ channelId: 1, incumbentSessionId: 'a', incomingSessionId: 'b' }]);
});

test('registering the same channel twice replaces the record', () => {
  const registry = createTerminalChannelRegistry();
  registry.registerOrRefusal(1, record({ streamEpoch: '1' }));
  registry.registerOrRefusal(1, record({ streamEpoch: '2' }));

  assert.equal(registry.lookup(1)?.streamEpoch, '2');
  assert.equal(registry.size, 1);
});

// ---------------------------------------------------------------------------
// 3. Wrong use fails at the call, not three layers down.
// ---------------------------------------------------------------------------

test('channel 0 is refused because the wire reserves it', () => {
  // The codec rejects `channelId === 0` as `reserved-channel`. Accepting a
  // registration for it would create an entry nothing can ever match.
  const registry = createTerminalChannelRegistry();
  assert.throws(() => registry.registerOrRefusal(0, record()), /channelId/u);
});

test('a non-integer or out-of-range channel id is refused', () => {
  const registry = createTerminalChannelRegistry();
  assert.throws(() => registry.registerOrRefusal(1.5, record()), /channelId/u);
  assert.throws(() => registry.registerOrRefusal(-1, record()), /channelId/u);
  assert.throws(() => registry.registerOrRefusal(2 ** 32, record()), /channelId/u, 'channelId is uint32');
});

test('an empty authorityEpoch or sessionId is refused', () => {
  // Both are equality keys downstream. An empty string compares equal to
  // another empty string, so a missing value would silently unify two sessions.
  const registry = createTerminalChannelRegistry();
  assert.throws(() => registry.registerOrRefusal(1, record({ authorityEpoch: '' })), /authorityEpoch/u);
  assert.throws(() => registry.registerOrRefusal(1, record({ sessionId: '' })), /sessionId/u);
});

test('a refused registration does not partially apply', () => {
  const registry = createTerminalChannelRegistry();
  assert.throws(() => registry.registerOrRefusal(1, record({ authorityEpoch: '' })));
  assert.equal(registry.channelState(1), undefined);
  assert.equal(registry.size, 0);
});

// ---------------------------------------------------------------------------
// 4. Disposal (08:196).
// ---------------------------------------------------------------------------

test('clear empties the table so ids are unknown, not retired', () => {
  // A socket close or a codecEpoch change discards everything; the ids may then
  // be reissued for different sessions. Leaving them retired would silently
  // drop the new owner's frames.
  const registry = createTerminalChannelRegistry();
  registry.registerOrRefusal(1, record());
  registry.registerOrRefusal(2, record({ sessionId: 'b' }));
  registry.retire(2);
  registry.clear();

  assert.equal(registry.channelState(1), undefined);
  assert.equal(registry.channelState(2), undefined);
  assert.equal(registry.size, 0);
});

test('retiring by session id retires every channel that session owns', () => {
  // `unsubscribe` names a session, not a channel. The caller should not have to
  // reverse the mapping itself.
  const registry = createTerminalChannelRegistry();
  registry.registerOrRefusal(1, record({ sessionId: 'a' }));
  registry.registerOrRefusal(2, record({ sessionId: 'b' }));
  registry.retireSession('a');

  assert.equal(registry.channelState(1), 'retired');
  assert.equal(registry.channelState(2), 'active');
});

test('retiring an unknown session touches nothing', () => {
  const registry = createTerminalChannelRegistry();
  registry.registerOrRefusal(1, record({ sessionId: 'a' }));
  registry.retireSession('zzz');

  assert.equal(registry.channelState(1), 'active');
  assert.equal(registry.size, 1);
});

// ---------------------------------------------------------------------------
// 5. The consumer contract — this is what the registry exists for.
// ---------------------------------------------------------------------------

test('channelState is accepted verbatim by createV1DecodeContext', () => {
  // The signature the codec requires is `(channelId: number) => ChannelState |
  // undefined`. Passing the method directly proves it is not `this`-bound,
  // which is how the context will actually use it.
  const registry = createTerminalChannelRegistry();
  registry.registerOrRefusal(1, record());

  const context = createV1DecodeContext({
    maxBodyBytes: 4_194_304,
    channelState: registry.channelState,
  });

  assert.equal(context.channelState(1), 'active');
  assert.equal(context.channelState(2), undefined);
});

test('the context sees later registrations, because it holds the live table', () => {
  // Snapshotting the map at context-construction time would freeze the channel
  // set at the first frame and reject every session subscribed afterwards.
  const registry = createTerminalChannelRegistry();
  const context = createV1DecodeContext({
    maxBodyBytes: 4_194_304,
    channelState: registry.channelState,
  });

  assert.equal(context.channelState(1), undefined);
  registry.registerOrRefusal(1, record());
  assert.equal(context.channelState(1), 'active');
});

// ---------------------------------------------------------------------------
// 6. The record is not a live handle into the registry.
// ---------------------------------------------------------------------------

test('a returned record refuses mutation loudly', () => {
  // The record flows to `fromBinaryOutputFrame` as identity, and lookup runs
  // once per frame — copying it per call would be an allocation on the hot
  // path. So the stored object is shared and frozen instead, which under the
  // module's strict mode turns a careless write into a throw rather than into a
  // silently rewritten authority identity.
  const registry = createTerminalChannelRegistry();
  registry.registerOrRefusal(1, record());

  const found = registry.lookup(1)!;
  assert.throws(() => { (found as { sessionId: string }).sessionId = 'hijacked'; }, TypeError);
  assert.equal(registry.lookup(1)?.sessionId, 'sess-1');
});

test('mutating the input after registering does not change the stored record', () => {
  const registry = createTerminalChannelRegistry();
  const input = record();
  registry.registerOrRefusal(1, input);
  input.sessionId = 'changed';

  assert.equal(registry.lookup(1)?.sessionId, 'sess-1');
});

// ---------------------------------------------------------------------------
// 7. Reading the wire — `subscribed` is untrusted input, not our own call.
// ---------------------------------------------------------------------------

const EPOCH = '3f1b2c4d-0000-4000-8000-000000000001';

test('a fully populated session becomes a registration', () => {
  assert.deepEqual(
    channelEntriesFromSubscribed([
      { sessionId: 'a', channelId: 4, streamEpoch: '9', authorityEpoch: EPOCH },
    ]),
    [{ channelId: 4, sessionId: 'a', authorityEpoch: EPOCH, streamEpoch: '9' }],
  );
});

test('a session with no channel fields is skipped, not defaulted', () => {
  // This is every session in a JSON-only group — the common case, and the one
  // that must not produce a channel nothing will ever address.
  assert.deepEqual(
    channelEntriesFromSubscribed([{ sessionId: 'a', status: 'running', ready: true }]),
    [],
  );
});

test('a session missing any one channel field is skipped whole', () => {
  // A partial record cannot be completed later: there is no second message that
  // fills in the gap, so half an entry would be a channel with no identity.
  const partials = [
    { sessionId: 'a', streamEpoch: '9', authorityEpoch: EPOCH },
    { sessionId: 'a', channelId: 4, authorityEpoch: EPOCH },
    { sessionId: 'a', channelId: 4, streamEpoch: '9' },
  ];
  for (const partial of partials) {
    assert.deepEqual(channelEntriesFromSubscribed([partial]), [], JSON.stringify(partial));
  }
});

test('a session the wire describes invalidly is skipped, never thrown on', () => {
  // `register` throws, because a bad call there is our bug. This runs on a
  // server message, where throwing would abort the whole subscribe handler and
  // take the healthy sessions in the same array down with the bad one.
  const entries = channelEntriesFromSubscribed([
    { sessionId: 'reserved', channelId: 0, streamEpoch: '9', authorityEpoch: EPOCH },
    { sessionId: 'fractional', channelId: 1.5, streamEpoch: '9', authorityEpoch: EPOCH },
    { sessionId: 'blank-epoch', channelId: 5, streamEpoch: '9', authorityEpoch: '' },
    { sessionId: 'good', channelId: 6, streamEpoch: '9', authorityEpoch: EPOCH },
  ]);

  assert.deepEqual(entries.map(e => e.sessionId), ['good']);
});

test('the extracted entries are exactly what registerAll accepts', () => {
  // The two halves are only useful together, so the seam between them is worth
  // pinning: a shape change on either side has to break this.
  const registry = createTerminalChannelRegistry();
  registry.registerAll(channelEntriesFromSubscribed([
    { sessionId: 'a', channelId: 4, streamEpoch: '9', authorityEpoch: EPOCH },
    { sessionId: 'b', status: 'running', ready: true },
  ]));

  assert.equal(registry.size, 1);
  assert.equal(registry.lookup(4)?.sessionId, 'a');
  assert.equal(registry.lookup(4)?.authorityEpoch, EPOCH);
});

test('an empty session array yields no entries', () => {
  assert.deepEqual(channelEntriesFromSubscribed([]), []);
});

test('wire values of the wrong TYPE are skipped, not coerced', () => {
  // Distinct from the invalid-value cases above. A JSON peer can send a number
  // where a string belongs, and the `typeof` guards exist for exactly that —
  // but they are only reachable if the parameter type keeps its values
  // `unknown`. Typing them after `SubscribedSessionInfo` would make this case
  // inexpressible here while leaving the guards live at runtime.
  const entries = channelEntriesFromSubscribed([
    { sessionId: 42, channelId: 4, streamEpoch: '9', authorityEpoch: EPOCH },
    { sessionId: 'a', channelId: '4', streamEpoch: '9', authorityEpoch: EPOCH },
    { sessionId: 'b', channelId: 5, streamEpoch: 9, authorityEpoch: EPOCH },
    { sessionId: 'c', channelId: 6, streamEpoch: '9', authorityEpoch: { toString: () => EPOCH } },
    { sessionId: 'good', channelId: 7, streamEpoch: '9', authorityEpoch: EPOCH },
  ]);

  assert.deepEqual(entries.map(e => e.sessionId), ['good']);
});
