import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CHANNEL_ID_MAX,
  CHANNEL_RETIRED_GRACE_MS,
  createTerminalChannelAllocator,
} from './terminalChannelAllocator.js';

/**
 * The server side of `01 §1.5`: the group-scoped handle that replaces a 36-byte
 * `sessionId` with a uint32 in every frame header.
 *
 * The clock is injected rather than read, so the grace window is exercised
 * without timers and without making the test wait.
 */

function fixedClock(start = 1_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function allocator(graceMs?: number) {
  const clock = fixedClock();
  const subject = createTerminalChannelAllocator(
    graceMs === undefined ? { now: clock.now } : { now: clock.now, graceMs },
  );
  return { clock, subject };
}

// ---------------------------------------------------------------------------
// 1. Allocation — `01:392` rules 1 and 2.
// ---------------------------------------------------------------------------

test('channelId 0 is never allocated', () => {
  const { subject } = allocator();

  // 0 is permanently reserved so a zero-filled buffer cannot look like a valid
  // frame (01:392 rule 1).
  assert.notEqual(subject.allocate('session-a').channelId, 0);
});

test('allocation is monotonic across sessions', () => {
  const { subject } = allocator();

  const first = subject.allocate('session-a').channelId;
  const second = subject.allocate('session-b').channelId;
  const third = subject.allocate('session-c').channelId;

  assert.ok(first < second, `${first} should precede ${second}`);
  assert.ok(second < third, `${second} should precede ${third}`);
});

test('a retired channel is never handed out again', () => {
  const { subject, clock } = allocator();

  const retired = subject.allocate('session-a').channelId;
  subject.retire(retired);
  clock.advance(CHANNEL_RETIRED_GRACE_MS * 10);
  subject.sweep();

  // Reuse inside one codecEpoch is what lets a frame still in the socket buffer
  // be written to a different session's screen (01:396-401). The `sourceSeq`
  // monotonic check cannot catch it, so refusing reuse is the only defence.
  for (let i = 0; i < 5; i += 1) {
    assert.notEqual(subject.allocate(`session-${i}`).channelId, retired);
  }
});

test('resubscribing a session yields a fresh channel rather than the old one', () => {
  const { subject } = allocator();

  const first = subject.allocate('session-a').channelId;
  subject.retire(first);
  const second = subject.allocate('session-a').channelId;

  assert.notEqual(second, first);
});

test('the allocation reports the session it belongs to', () => {
  const { subject } = allocator();

  const allocation = subject.allocate('session-a');

  assert.equal(allocation.sessionId, 'session-a');
  assert.equal(subject.sessionOf(allocation.channelId), 'session-a');
});

// ---------------------------------------------------------------------------
// 2. The three-state lifecycle — `01:409-427`.
// ---------------------------------------------------------------------------

test('a fresh channel is active', () => {
  const { subject } = allocator();

  assert.equal(subject.lifecycle(subject.allocate('session-a').channelId), 'active');
});

test('a channel that was never allocated is free', () => {
  const { subject } = allocator();

  assert.equal(subject.lifecycle(4242), 'free');
});

test('retiring moves a channel out of active without freeing it', () => {
  const { subject } = allocator();

  const channelId = subject.allocate('session-a').channelId;
  assert.equal(subject.retire(channelId), true);

  // RETIRED exists so that frames still in the socket buffer are dropped with a
  // diagnostic instead of triggering a per-channel recovery storm (01:409).
  assert.equal(subject.lifecycle(channelId), 'retired');
});

test('a retired channel still names its session, for diagnostics', () => {
  const { subject } = allocator();

  const channelId = subject.allocate('session-a').channelId;
  subject.retire(channelId);

  assert.equal(subject.sessionOf(channelId), 'session-a');
});

test('the grace window has to elapse before a retired channel becomes free', () => {
  const { subject, clock } = allocator();

  const channelId = subject.allocate('session-a').channelId;
  subject.retire(channelId);

  clock.advance(CHANNEL_RETIRED_GRACE_MS - 1);
  assert.deepEqual(subject.sweep(), []);
  assert.equal(subject.lifecycle(channelId), 'retired');

  clock.advance(1);
  assert.deepEqual(subject.sweep(), [channelId]);
  assert.equal(subject.lifecycle(channelId), 'free');
});

test('an elapsed grace reads as free before any sweep runs', () => {
  const { subject, clock } = allocator();

  const channelId = subject.allocate('session-a').channelId;
  subject.retire(channelId);
  clock.advance(CHANNEL_RETIRED_GRACE_MS);

  // Deliberately no sweep. `lifecycle` computes from the clock precisely so a
  // caller gets the right answer between the grace elapsing and the next sweep;
  // reading `retired` here would keep dropping frames silently that should be
  // asking for a fresh snapshot.
  assert.equal(subject.lifecycle(channelId), 'free');
});

test('an elapsed grace stops naming its session before any sweep runs', () => {
  const { subject, clock } = allocator();

  const channelId = subject.allocate('session-a').channelId;
  subject.retire(channelId);
  clock.advance(CHANNEL_RETIRED_GRACE_MS);

  assert.equal(subject.sessionOf(channelId), undefined);
});

test('the grace boundary is inclusive to the millisecond, without a sweep', () => {
  const { subject, clock } = allocator();

  const channelId = subject.allocate('session-a').channelId;
  subject.retire(channelId);

  clock.advance(CHANNEL_RETIRED_GRACE_MS - 1);
  assert.equal(subject.lifecycle(channelId), 'retired');
  assert.equal(subject.sessionOf(channelId), 'session-a');

  clock.advance(1);
  assert.equal(subject.lifecycle(channelId), 'free');
  assert.equal(subject.sessionOf(channelId), undefined);
});

test('sweeping twice does not report the same channel again', () => {
  const { subject, clock } = allocator();

  const channelId = subject.allocate('session-a').channelId;
  subject.retire(channelId);
  clock.advance(CHANNEL_RETIRED_GRACE_MS);

  assert.deepEqual(subject.sweep(), [channelId]);
  assert.deepEqual(subject.sweep(), []);
});

test('retiring an already retired channel does not extend its grace', () => {
  const { subject, clock } = allocator();

  const channelId = subject.allocate('session-a').channelId;
  subject.retire(channelId);
  clock.advance(CHANNEL_RETIRED_GRACE_MS - 1);

  // A second retire must not restart the clock, or a repeatedly retired channel
  // would never reach FREE.
  assert.equal(subject.retire(channelId), false);
  clock.advance(1);

  assert.deepEqual(subject.sweep(), [channelId]);
});

test('retiring a channel that was never allocated changes nothing', () => {
  const { subject } = allocator();

  assert.equal(subject.retire(4242), false);
  assert.equal(subject.lifecycle(4242), 'free');
});

// ---------------------------------------------------------------------------
// 3. Retiring by session — the server-driven release that must be notified.
// ---------------------------------------------------------------------------

test('retiring a session retires every channel it holds', () => {
  const { subject } = allocator();

  const first = subject.allocate('session-a').channelId;
  const second = subject.allocate('session-a').channelId;
  const other = subject.allocate('session-b').channelId;

  const retired = subject.retireSession('session-a');

  assert.deepEqual([...retired].sort((l, r) => l - r), [first, second].sort((l, r) => l - r));
  assert.equal(subject.lifecycle(other), 'active');
});

test('retiring a session with no channels reports nothing', () => {
  const { subject } = allocator();
  subject.allocate('session-a');

  assert.deepEqual(subject.retireSession('session-b'), []);
});

test('an already retired channel is not reported a second time by its session', () => {
  const { subject } = allocator();

  const channelId = subject.allocate('session-a').channelId;
  subject.retire(channelId);

  assert.deepEqual(subject.retireSession('session-a'), []);
});

// ---------------------------------------------------------------------------
// 4. Exhaustion — `01:392` rule 3.
// ---------------------------------------------------------------------------

test('exhausting the counter is refused rather than wrapping to a reused id', () => {
  const clock = fixedClock();
  const subject = createTerminalChannelAllocator({ now: clock.now, nextChannelId: CHANNEL_ID_MAX });

  assert.equal(subject.allocate('session-a').channelId, CHANNEL_ID_MAX);
  // Wrapping would hand out 0, or restart at 1 and reuse a live handle. Both
  // are the reuse accident rule 2 exists to prevent, so the caller is told to
  // bump the codecEpoch and renegotiate instead.
  assert.throws(() => subject.allocate('session-b'), /exhaust/i);
});

// ---------------------------------------------------------------------------
// 5. Defaults.
// ---------------------------------------------------------------------------

test('the default grace matches the existing pair-token window', () => {
  // 01:427 — no new policy constant, so it reuses the 30s already in WsRouter.
  assert.equal(CHANNEL_RETIRED_GRACE_MS, 30_000);
});

test('an allocator built without a grace uses the default', () => {
  const { subject, clock } = allocator();

  const channelId = subject.allocate('session-a').channelId;
  subject.retire(channelId);

  clock.advance(CHANNEL_RETIRED_GRACE_MS - 1);
  assert.equal(subject.lifecycle(channelId), 'retired');
  clock.advance(1);
  subject.sweep();
  assert.equal(subject.lifecycle(channelId), 'free');
});
