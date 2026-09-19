import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildTerminalInputIdentityFields,
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

// --- #18 criterion 6: the id and its ordering must travel together ----------------
//
// The server treats `inputOperationId` as opaque and reads the ordering from
// `inputSequencerEpoch` + `inputSeqStart`. Sending one without the other misjudges the
// forgotten-watermark in both directions: no epoch means an old retry is re-executed,
// and an epoch with no id means nothing is deduplicated at all.
//
// This is the same class of gap as DEFECT A, where the identifier was declared on the
// wire type and never actually written by anyone for months, because the only thing
// covering the send site was the type. A function is testable; a spread at a call site
// two thousand lines into a component is not.

test('#18: identity fields are emitted as a pair', () => {
  const fields = buildTerminalInputIdentityFields({
    sequencerEpoch: 3,
    inputSeqStart: 7,
    inputSeqEnd: 9,
  });

  assert.deepEqual(fields, { inputOperationId: 'e3:7-9', inputSequencerEpoch: 3 });
});

test('#18: when no id can be built, neither field is emitted', () => {
  // Falling back to AC-4's unidentified path is correct. Sending a bare epoch would
  // claim an ordering for an operation the server cannot name.
  const fields = buildTerminalInputIdentityFields({
    sequencerEpoch: 0,
    inputSeqStart: 7,
    inputSeqEnd: 9,
  });

  assert.deepEqual(fields, {});
});

test('#18: the emitted epoch is the one the id was built from, not a separate read', () => {
  // Boundary against the obvious refactor mistake: reading the epoch from a ref a second
  // time at the call site, where a re-attach between the two reads would pair an id from
  // epoch 3 with epoch 4 and silently corrupt the watermark.
  const fields = buildTerminalInputIdentityFields({
    sequencerEpoch: 4,
    inputSeqStart: 1,
    inputSeqEnd: 1,
  });

  assert.equal(fields.inputOperationId, 'e4:1-1');
  assert.equal(fields.inputSequencerEpoch, 4);
});
