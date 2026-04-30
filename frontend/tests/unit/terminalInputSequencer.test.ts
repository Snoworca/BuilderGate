import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MAX_INPUT_SEQUENCE_SPAN,
  TerminalInputSequencer,
  type SequencedTerminalInput,
} from '../../src/utils/terminalInputSequencer.ts';

test('TerminalInputSequencer splits printable runs at the server sequence span limit', () => {
  const emitted: Array<{ input: SequencedTerminalInput; reason: string }> = [];
  const sequencer = new TerminalInputSequencer((input, reason) => {
    emitted.push({ input, reason });
  }, 10_000);

  for (let index = 0; index < MAX_INPUT_SEQUENCE_SPAN + 1; index += 1) {
    sequencer.submit('x');
  }
  sequencer.flush('test-end');

  assert.equal(emitted.length, 2);
  assert.equal(emitted[0].reason, 'sequence-span-limit');
  assert.equal(emitted[0].input.logicalChunkCount, MAX_INPUT_SEQUENCE_SPAN);
  assert.equal(emitted[0].input.inputSeqStart, 1);
  assert.equal(emitted[0].input.inputSeqEnd, MAX_INPUT_SEQUENCE_SPAN);
  assert.equal(emitted[1].input.logicalChunkCount, 1);
  assert.equal(emitted[1].input.inputSeqStart, MAX_INPUT_SEQUENCE_SPAN + 1);
  assert.equal(emitted[1].input.inputSeqEnd, MAX_INPUT_SEQUENCE_SPAN + 1);
});

test('TerminalInputSequencer keeps control input as an ordered boundary after printable coalescing', () => {
  const emitted: Array<{ input: SequencedTerminalInput; reason: string }> = [];
  const sequencer = new TerminalInputSequencer((input, reason) => {
    emitted.push({ input, reason });
  }, 10_000);

  sequencer.submit('a');
  sequencer.submit('b');
  sequencer.submit('\r');

  assert.equal(emitted.length, 2);
  assert.equal(emitted[0].input.data, 'ab');
  assert.equal(emitted[0].input.inputSeqStart, 1);
  assert.equal(emitted[0].input.inputSeqEnd, 2);
  assert.equal(emitted[1].input.data, '\r');
  assert.equal(emitted[1].input.inputSeqStart, 3);
  assert.equal(emitted[1].input.inputSeqEnd, 3);
});
