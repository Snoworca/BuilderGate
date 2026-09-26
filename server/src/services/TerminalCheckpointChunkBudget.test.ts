// Issue #78: two of the six reported budgets were `value: null` / `unconfigured`, and one of
// them -- the checkpoint chunk size -- was not absent at all. It was the module constant
// TERMINAL_CHECKPOINT_CHUNK_BYTES, applied on every checkpoint while the budget report said it
// could not be found. #26 measured checkpoints crossing the browser's acceptance limit on wide
// terminals, and there was no way to make the chunks smaller.
//
// The test drives the chunking function the production adapter calls, at a configured size and
// at the default, because "the key exists in the config" and "the chunker used it" are different
// claims (#9 AC-4, #95, #101).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  TERMINAL_CHECKPOINT_CHUNK_BYTES,
  __testing as adapterTesting,
} from './TerminalAuthorityProductionAdapter.js';

const encodeCheckpointChunks = adapterTesting.encodeCheckpointChunks;

function decodedLengths(chunks: ReadonlyArray<{ data: string; encodedBytes: number }>): number[] {
  return chunks.map(chunk => chunk.encodedBytes);
}

test('#78 the checkpoint chunker splits at the size it is given', () => {
  const payload = 'x'.repeat(10_000);
  assert.deepEqual(decodedLengths(encodeCheckpointChunks(payload, 4096)), [4096, 4096, 1808]);
  assert.deepEqual(decodedLengths(encodeCheckpointChunks(payload, 2048)), [2048, 2048, 2048, 2048, 1808]);
});

// The control. Without it the case above would also pass against a chunker that ignored the
// argument and happened to be called with sizes that divide the payload the same way.
test('#78 the default is the shipped constant, so omitting the size changes nothing', () => {
  const payload = 'y'.repeat(200_000);
  assert.deepEqual(
    decodedLengths(encodeCheckpointChunks(payload)),
    decodedLengths(encodeCheckpointChunks(payload, TERMINAL_CHECKPOINT_CHUNK_BYTES)),
  );
  assert.equal(decodedLengths(encodeCheckpointChunks(payload))[0], TERMINAL_CHECKPOINT_CHUNK_BYTES);
});

test('#78 an unusable size falls back to the default instead of producing one chunk per byte', () => {
  const payload = 'z'.repeat(100_000);
  for (const size of [0, -1, 1, 1023, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
    const chunks = encodeCheckpointChunks(payload, size as number);
    assert.equal(chunks[0].encodedBytes, TERMINAL_CHECKPOINT_CHUNK_BYTES,
      `size ${String(size)} must fall back to the shipped default`);
  }
});

test('#78 an empty payload is still one empty chunk whatever the size', () => {
  for (const size of [undefined, 4096, 0]) {
    const chunks = encodeCheckpointChunks('', size as number | undefined);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].encodedBytes, 0);
    assert.equal(chunks[0].data, '');
  }
});

test('#78 chunking is lossless at every size', () => {
  const payload = 'ü한글x'.repeat(5_000);
  for (const size of [undefined, 1024, 4096, 65_536]) {
    const joined = Buffer.concat(
      encodeCheckpointChunks(payload, size as number | undefined).map(chunk => Buffer.from(chunk.data, 'base64')),
    ).toString('utf8');
    assert.equal(joined, payload, `size ${String(size)} lost or reordered bytes`);
  }
});
