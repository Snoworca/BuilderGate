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
const NEXT_QUESTION = ['←  ☒ Color  ☐ Size  ✔ Submit  →', 'Which size?', '❯ 1. Small', '  2. Large', 'Enter to select · Esc to cancel'].join('\n');
const WORKING = ['● Writing the file', '✻ Thinking… (2s · esc to interrupt)'].join('\n');

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

test('FR-AITUI-024 AC-6: a menu scrolled out of view keeps the mark until the agent is back', async () => {
  // Seen on 2002: scrolling a waiting Claude Code menu redraws it with its footer
  // off screen, and the next read cleared the mark though nothing was answered.
  const h = harness();
  h.tracker.noteOutput('s1');
  await h.advance(AWAITING_INPUT_SETTLE_MS);
  // Scrolled far enough that only the selected option is left: no footer, no "2.".
  h.screens.set('s1', ['│ Proceed?', '❯ 1. Yes', '     the first option', '───── Jump to bottom (ctrl+End) ↓ ─────'].join('\n'));
  h.tracker.noteInput('s1', '\u001b[<65;10;10M'); // the wheel: not an answer
  h.tracker.noteOutput('s1');
  await h.advance(AWAITING_INPUT_SETTLE_MS);
  assert.deepEqual(h.changes, [['s1', true]], 'still waiting');
  assert.equal(h.tracker.isAwaiting('s1'), true);
  h.screens.set('s1', ['● Working on it', '✻ Thinking… (3s · esc to interrupt)'].join('\n'));
  h.tracker.noteOutput('s1');
  await h.advance(AWAITING_INPUT_SETTLE_MS);
  assert.deepEqual(h.changes, [['s1', true], ['s1', false]], 'the agent at work clears it');
});

test('FR-AITUI-024 AC-3: answering one question of a form keeps the mark while the next question waits', async () => {
  // 2026-11-18 user report: a form of several questions, one answered, the rest
  // untouched, must keep the ? on; clearing on the key made it blink or vanish.
  const h = harness();
  h.tracker.noteOutput('s1');
  await h.advance(AWAITING_INPUT_SETTLE_MS);
  h.tracker.noteInput('s1', '\r');
  assert.equal(h.tracker.isAwaiting('s1'), true, 'the key alone does not clear it');
  h.screens.set('s1', NEXT_QUESTION);
  h.tracker.noteOutput('s1');
  await h.advance(AWAITING_INPUT_MAX_WAIT_MS);
  assert.deepEqual(h.changes, [['s1', true]], 'no blink between the questions');
  assert.equal(h.tracker.isAwaiting('s1'), true);
});

test('FR-AITUI-024 AC-3: after the last answer the mark clears once the agent is shown back at work', async () => {
  const h = harness();
  h.tracker.noteOutput('s1');
  await h.advance(AWAITING_INPUT_SETTLE_MS);
  h.tracker.noteInput('s1', '\r');
  h.screens.set('s1', WORKING);
  h.tracker.noteOutput('s1');
  await h.advance(AWAITING_INPUT_SETTLE_MS);
  assert.deepEqual(h.changes, [['s1', true], ['s1', false]]);
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

test('FR-AITUI-024 AC-3: an answer the agent has not reacted to leaves the mark: the menu is still there', async () => {
  const h = harness();
  h.tracker.noteOutput('s1');
  await h.advance(AWAITING_INPUT_SETTLE_MS);
  h.tracker.noteInput('s1', '1');
  await h.advance(AWAITING_INPUT_MAX_WAIT_MS);
  assert.deepEqual(h.changes, [['s1', true]]);
  assert.equal(h.tracker.isAwaiting('s1'), true);
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

test('FR-AITUI-024 AC-3: an answering key schedules its own read, so a read in flight against the old menu does not leave the mark stuck', async () => {
  const h = harness();
  h.tracker.noteOutput('s1');
  await h.advance(AWAITING_INPUT_SETTLE_MS);
  h.holdReads();
  h.tracker.noteOutput('s1');
  await h.advance(AWAITING_INPUT_SETTLE_MS);
  assert.equal(h.reads.length, 2, 'a read of the old menu is in flight');
  h.tracker.noteInput('s1', '\r');
  h.screens.set('s1', WORKING);
  await h.releaseReads();
  assert.deepEqual(h.changes, [['s1', true]], 'the old menu keeps it for now');
  await h.advance(AWAITING_INPUT_MAX_WAIT_MS);
  assert.deepEqual(h.changes, [['s1', true], ['s1', false]], 'the read after the key sees the agent at work');
});

test('FR-AITUI-024 AC-4: a session closed while waiting reports not waiting, so its tab drops the mark', async () => {
  const h = harness();
  h.tracker.noteOutput('s1');
  await h.advance(AWAITING_INPUT_SETTLE_MS);
  h.tracker.forget('s1');
  assert.deepEqual(h.changes, [['s1', true], ['s1', false]]);
  assert.equal(h.tracker.isAwaiting('s1'), false);
});
