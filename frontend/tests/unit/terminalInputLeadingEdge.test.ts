// PERF-BGSTAB-029: the first typed chunk of a burst is sent at once.
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { TerminalInputSequencer, type SequencedTerminalInput } from '../../src/utils/terminalInputSequencer.ts';

const WINDOW_MS = 8;

function harness(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const emitted: Array<{ input: SequencedTerminalInput; reason: string }> = [];
  const sequencer = new TerminalInputSequencer((input, reason) => { emitted.push({ input, reason }); }, WINDOW_MS);
  const data = () => emitted.map((e) => e.input.data);
  const ranges = () => emitted.map((e) => [e.input.inputSeqStart, e.input.inputSeqEnd]);
  return { sequencer, emitted, data, ranges, tick: (ms: number) => t.mock.timers.tick(ms) };
}

test('PERF-BGSTAB-029 AC-1: a chunk typed while nothing is pending is emitted synchronously', (t) => {
  const h = harness(t);
  h.sequencer.submit('a');
  assert.deepEqual(h.data(), ['a'], 'no timer has run');
  assert.deepEqual(h.ranges(), [[1, 1]]);
  assert.equal(h.emitted[0].input.logicalChunkCount, 1);
});

test('PERF-BGSTAB-029 AC-2: chunks inside the window go out together when it ends', (t) => {
  const h = harness(t);
  h.sequencer.submit('a');
  h.tick(3);
  h.sequencer.submit('b');
  h.tick(3);
  h.sequencer.submit('c');
  assert.deepEqual(h.data(), ['a']);
  h.tick(2);
  assert.deepEqual(h.data(), ['a', 'bc'], 'the window is 8 ms from the leading chunk, not from the last one');
  assert.deepEqual(h.ranges(), [[1, 1], [2, 3]]);
});

test('PERF-BGSTAB-029 AC-3: after the window a chunk is again emitted at once', (t) => {
  const h = harness(t);
  h.sequencer.submit('a');
  h.tick(WINDOW_MS);
  h.sequencer.submit('b');
  assert.deepEqual(h.data(), ['a', 'b'], 'the window ended with nothing held, so b goes out at once');
  h.tick(1);
  h.sequencer.submit('c');
  assert.deepEqual(h.data(), ['a', 'b'], 'c is inside the window b opened');
  h.tick(WINDOW_MS);
  assert.deepEqual(h.data(), ['a', 'b', 'c']);
  // That window sent something, so one more follows it; after a quiet one, sending is immediate again.
  h.tick(WINDOW_MS);
  h.sequencer.submit('d');
  assert.deepEqual(h.data(), ['a', 'b', 'c', 'd']);
  assert.deepEqual(h.ranges(), [[1, 1], [2, 2], [3, 3], [4, 4]]);
});

test('PERF-BGSTAB-029 AC-2: steady typing is coalesced window after window, not sent chunk by chunk', (t) => {
  const h = harness(t);
  // One chunk every 3 ms for 48 ms.
  for (let i = 0; i < 16; i += 1) { h.sequencer.submit(String.fromCharCode(97 + i)); h.tick(3); }
  h.tick(WINDOW_MS);
  assert.equal(h.data().join(''), 'abcdefghijklmnop');
  assert.equal(h.data()[0], 'a', 'the first chunk still goes out at once');
  assert.ok(h.data().length <= 8, `sent ${h.data().length} messages for 16 chunks: ${JSON.stringify(h.data())}`);
});

test('PERF-BGSTAB-029 AC-4: a control chunk flushes what is pending and keeps the submit order', (t) => {
  const h = harness(t);
  h.sequencer.submit('l');
  h.sequencer.submit('s');
  h.sequencer.submit('\r');
  assert.deepEqual(h.data(), ['l', 's', '\r']);
  h.sequencer.submit('x');
  assert.deepEqual(h.data(), ['l', 's', '\r', 'x'], 'the control chunk closed the window');
  h.tick(100);
  assert.deepEqual(h.data().join(''), 'ls\rx', 'nothing is emitted twice');
});

test('PERF-BGSTAB-029 AC-2: Hangul syllables committed in a burst keep their order', (t) => {
  const h = harness(t);
  for (const syllable of ['한', '글', '입', '력']) { h.sequencer.submit(syllable); h.tick(2); }
  h.tick(WINDOW_MS);
  assert.equal(h.data().join(''), '한글입력');
  assert.equal(h.data()[0], '한');
});

test('PERF-BGSTAB-029 AC-5: reset and dispose drop the pending chunk and close the window', (t) => {
  const h = harness(t);
  h.sequencer.submit('a');
  h.sequencer.submit('b');
  h.sequencer.reset();
  h.tick(100);
  assert.deepEqual(h.data(), ['a'], 'the pending b is dropped');
  h.sequencer.submit('c');
  assert.deepEqual(h.data(), ['a', 'c'], 'the window is closed, so c goes out at once');
  assert.deepEqual(h.ranges()[1], [1, 1], 'reset restarted the sequence');
  h.sequencer.submit('d');
  h.sequencer.dispose();
  h.tick(100);
  assert.deepEqual(h.data(), ['a', 'c']);
});
