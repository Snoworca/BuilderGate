import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildTerminalInputOperationId,
  MAX_TERMINAL_INPUT_OPERATION_ID_LENGTH,
} from '../../src/utils/terminalInputOperationId.ts';

test('#18: a retry of the same logical input produces the same id, which is the whole point', () => {
  const first = buildTerminalInputOperationId({ sequencerEpoch: 1, inputSeqStart: 7, inputSeqEnd: 9 });
  const retry = buildTerminalInputOperationId({ sequencerEpoch: 1, inputSeqStart: 7, inputSeqEnd: 9 });
  assert.equal(first, retry);
  assert.notEqual(first, null);
});

test('#18: two different operations in one epoch never share an id', () => {
  const a = buildTerminalInputOperationId({ sequencerEpoch: 1, inputSeqStart: 7, inputSeqEnd: 9 });
  const b = buildTerminalInputOperationId({ sequencerEpoch: 1, inputSeqStart: 10, inputSeqEnd: 10 });
  assert.notEqual(a, b);
});

test('#18: the sequencer restarts at 1 on every session attach, so the epoch has to separate them', () => {
  // Without the epoch this is the dangerous case: a genuinely new command reusing an old
  // sequence number would be read as a duplicate and dropped, which is worse than no dedup.
  const beforeReset = buildTerminalInputOperationId({ sequencerEpoch: 1, inputSeqStart: 1, inputSeqEnd: 1 });
  const afterReset = buildTerminalInputOperationId({ sequencerEpoch: 2, inputSeqStart: 1, inputSeqEnd: 1 });
  assert.notEqual(beforeReset, afterReset);
});

test('#18: the id fits the server bound, which rejects anything over 128 characters', () => {
  const id = buildTerminalInputOperationId({
    sequencerEpoch: Number.MAX_SAFE_INTEGER,
    inputSeqStart: Number.MAX_SAFE_INTEGER,
    inputSeqEnd: Number.MAX_SAFE_INTEGER,
  });
  assert.notEqual(id, null);
  assert.ok((id as string).length <= MAX_TERMINAL_INPUT_OPERATION_ID_LENGTH, id as string);
});

test('#18: an unusable input yields null rather than a malformed id the server would refuse', () => {
  for (const bad of [
    { sequencerEpoch: 0, inputSeqStart: 1, inputSeqEnd: 1 },
    { sequencerEpoch: 1, inputSeqStart: 0, inputSeqEnd: 1 },
    { sequencerEpoch: 1, inputSeqStart: 2, inputSeqEnd: 1 },
    { sequencerEpoch: 1.5, inputSeqStart: 1, inputSeqEnd: 1 },
    { sequencerEpoch: 1, inputSeqStart: Number.NaN, inputSeqEnd: 1 },
    { sequencerEpoch: 1, inputSeqStart: 1, inputSeqEnd: Number.POSITIVE_INFINITY },
  ]) {
    assert.equal(buildTerminalInputOperationId(bad), null, JSON.stringify(bad));
  }
});
