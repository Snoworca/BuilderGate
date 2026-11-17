/**
 * FR-AITUI-024 AC-2 / AC-3: when the server reads a session's screen for a waiting
 * choice prompt, and what clears the mark.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AWAITING_INPUT_MAX_WAIT_MS,
  AWAITING_INPUT_SETTLE_MS,
  AgentAwaitingInputTracker,
} from './AgentAwaitingInputTracker.js';

const PROMPT = ['Do you want to proceed?', '❯ 1. Yes', '  2. No', 'Esc to cancel'].join('\n');
const PLAIN = ['❯ ', '? for shortcuts'].join('\n');

/** A hand-driven clock: timers fire only when advance() passes them. */
function harness(initialScreen = PROMPT) {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const screens = new Map<string, string>([['s1', initialScreen]]);
  const reads: string[] = [];
  const changes: Array<[string, boolean]> = [];
  let pendingRead: Array<() => void> | null = null;
  const tracker = new AgentAwaitingInputTracker({
    now: () => now,
    setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimer: (id) => { timers.delete(id as number); },
    readScreen: (id) => {
      reads.push(id);
      const screen = screens.get(id) ?? null;
      if (pendingRead) return new Promise<string | null>((resolve) => { pendingRead!.push(() => resolve(screen)); });
      return screen;
    },
    onChange: (id, awaiting) => { changes.push([id, awaiting]); },
  });
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  const advance = async (ms: number) => {
    const until = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      now = due[1].at;
      timers.delete(due[0]);
      due[1].fn();
      await flush();
    }
    now = until;
    await flush();
  };
  return {
    tracker, screens, reads, changes, timers, advance, flush,
    holdReads: () => { pendingRead = []; },
    releaseReads: async () => { const r = pendingRead ?? []; pendingRead = null; r.forEach(fn => fn()); await flush(); },
  };
}

test('FR-AITUI-024 AC-2: the screen is read once the output has been quiet for the settle time', async () => {
  const h = harness();
  h.tracker.noteOutput('s1');
  await h.advance(AWAITING_INPUT_SETTLE_MS - 1);
  assert.equal(h.reads.length, 0, 'not while the output may still be coming');
  await h.advance(1);
  assert.deepEqual(h.reads, ['s1']);
  assert.deepEqual(h.changes, [['s1', true]]);
  assert.equal(h.tracker.isAwaiting('s1'), true);
});

test('FR-AITUI-024 AC-2: output that keeps coming is still read at least every max wait', async () => {
  const h = harness(PLAIN);
  for (let t = 0; t < AWAITING_INPUT_MAX_WAIT_MS * 3; t += 100) {
    h.tracker.noteOutput('s1');
    await h.advance(100);
  }
  assert.ok(h.reads.length >= 2 && h.reads.length <= 4, `read ${h.reads.length} times in ${AWAITING_INPUT_MAX_WAIT_MS * 3} ms`);
});

test('FR-AITUI-024 AC-2: no output, no read: there is no poll', async () => {
  const h = harness();
  await h.advance(60_000);
  assert.equal(h.reads.length, 0);
  assert.equal(h.timers.size, 0);
});

test('FR-AITUI-024 AC-2: a read that does not change the answer reports nothing', async () => {
  const h = harness();
  h.tracker.noteOutput('s1');
  await h.advance(AWAITING_INPUT_SETTLE_MS);
  h.tracker.noteOutput('s1');
  await h.advance(AWAITING_INPUT_SETTLE_MS);
  assert.equal(h.reads.length, 2);
  assert.deepEqual(h.changes, [['s1', true]], 'reported once');
  h.screens.set('s1', PLAIN);
  h.tracker.noteOutput('s1');
  await h.advance(AWAITING_INPUT_SETTLE_MS);
  assert.deepEqual(h.changes, [['s1', true], ['s1', false]], 'the prompt going away clears it');
});

test('FR-AITUI-024 AC-3: a key that answers clears the mark at once', async () => {
  const h = harness();
  h.tracker.noteOutput('s1');
  await h.advance(AWAITING_INPUT_SETTLE_MS);
  h.tracker.noteInput('s1', '\r');
  assert.deepEqual(h.changes, [['s1', true], ['s1', false]]);
  assert.equal(h.tracker.isAwaiting('s1'), false);
});

test('FR-AITUI-024 AC-3: an arrow key does not clear it, so moving through the menu does not flicker', async () => {
  const h = harness();
  h.tracker.noteOutput('s1');
  await h.advance(AWAITING_INPUT_SETTLE_MS);
  h.tracker.noteInput('s1', '\u001b[B');
  h.tracker.noteInput('s1', '\u001b[I');
  h.tracker.noteInput('s1', '\u001b[<0;3;4M');
  assert.deepEqual(h.changes, [['s1', true]]);
});

test('FR-AITUI-024 AC-3: a read that started before the answer cannot set the mark again', async () => {
  const h = harness();
  h.tracker.noteOutput('s1');
  await h.advance(AWAITING_INPUT_SETTLE_MS);
  h.holdReads();
  h.tracker.noteOutput('s1');
  await h.advance(AWAITING_INPUT_SETTLE_MS);
  assert.equal(h.reads.length, 2, 'the second read is in flight');
  h.tracker.noteInput('s1', '1');
  await h.releaseReads();
  assert.deepEqual(h.changes, [['s1', true], ['s1', false]]);
  assert.equal(h.tracker.isAwaiting('s1'), false);
});

test('FR-AITUI-024 AC-3: input to a session that is not waiting reports nothing', () => {
  const h = harness();
  h.tracker.noteInput('s1', '\r');
  assert.deepEqual(h.changes, []);
});

test('FR-AITUI-024 AC-2: a closed session leaves no timer behind and is not read', async () => {
  const h = harness();
  h.tracker.noteOutput('s1');
  h.tracker.forget('s1');
  assert.equal(h.timers.size, 0);
  await h.advance(AWAITING_INPUT_MAX_WAIT_MS);
  assert.equal(h.reads.length, 0);
});

test('FR-AITUI-024 AC-2: a screen that cannot be read (no headless replica) answers not waiting', async () => {
  const h = harness();
  h.screens.delete('s1');
  h.tracker.noteOutput('s1');
  await h.advance(AWAITING_INPUT_SETTLE_MS);
  assert.deepEqual(h.changes, []);
  assert.equal(h.tracker.isAwaiting('s1'), false);
});

test('FR-AITUI-024 AC-3: an answering key cancels a read already scheduled, so the old menu cannot set the mark again', async () => {
  // PR #241 review: Down redraws the menu and arms a read; Enter lands before it fires.
  // The read must not run against the menu still on screen before the agent's reply.
  const h = harness();
  h.tracker.noteOutput('s1');
  await h.advance(AWAITING_INPUT_SETTLE_MS);
  assert.deepEqual(h.changes, [['s1', true]]);
  h.tracker.noteOutput('s1');
  h.tracker.noteInput('s1', '\r');
  assert.equal(h.timers.size, 0, 'the scheduled read is cancelled');
  await h.advance(AWAITING_INPUT_MAX_WAIT_MS);
  assert.deepEqual(h.changes, [['s1', true], ['s1', false]]);
  assert.equal(h.reads.length, 1);
});

test('FR-AITUI-024 AC-4: a session closed while waiting reports not waiting, so its tab drops the mark', async () => {
  const h = harness();
  h.tracker.noteOutput('s1');
  await h.advance(AWAITING_INPUT_SETTLE_MS);
  h.tracker.forget('s1');
  assert.deepEqual(h.changes, [['s1', true], ['s1', false]]);
  assert.equal(h.tracker.isAwaiting('s1'), false);
});
