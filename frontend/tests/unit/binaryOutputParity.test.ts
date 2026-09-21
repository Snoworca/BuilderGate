import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fromBinaryOutputFrame, fromJsonOutputMessage } from '../../src/utils/terminalOutputDelivery.ts';
import { DATA_PLANE_OPCODE } from '../../src/utils/binaryFrameCodec.ts';
import type { OutputWireMessage } from '../../src/utils/binaryFrameCodec.ts';
import type { TerminalOutputMessage } from '../../src/types/ws-protocol.ts';

/**
 * SDS-AC-9 (FR-BGSTAB-024 AC-3): the two codecs must reconstruct the same text.
 *
 * The corpus is the one AC-3 names, because the failure this guards against is
 * not "binary is broken" but "binary is broken for one class of character" -- a
 * combining mark, a ZWJ sequence, a CJK wide cell. Those are exactly the cases a
 * byte-oriented path can get wrong while ASCII stays perfect.
 */

const ESC = '';
const CORPUS: ReadonlyArray<readonly [string, string]> = [
  ['ASCII', 'hello world\r\n$ '],
  ['CJK wide', '한글 中文 日本語\r\n'],
  ['combining', 'éà ȫ'],
  ['ZWJ emoji', '👩‍💻 🏳️‍🌈'],
  ['split ANSI', `${ESC}[38;5;226m${ESC}[1mwarn${ESC}[0m ${ESC}[2K`],
  ['mixed', `a한́👩‍💻${ESC}[31mz${ESC}[0m`],
];

function jsonDelivery(data: string) {
  const message = {
    type: 'output',
    sessionId: 's',
    data,
    screenSeq: 7,
    authorityEpoch: 'auth-1',
    authorityRevision: 3,
    chunkId: '42',
  } as unknown as TerminalOutputMessage;
  return fromJsonOutputMessage(data, message);
}

function frameFor(
  data: string,
  chunkIdBase = '42',
  screenSeq = '7',
  authorityRevision = 3,
): OutputWireMessage {
  return {
    opcode: DATA_PLANE_OPCODE.OUTPUT,
    flags: 0,
    channelId: 9,
    streamEpoch: '4',
    sourceSeq: '11',
    prologue: { screenSeq, chunkIdBase, authorityRevision, authorityEpochIndex: 0 },
    segments: [],
    body: new TextEncoder().encode(data),
  };
}

function asText(data: string | Uint8Array): string {
  return typeof data === 'string' ? data : new TextDecoder().decode(data);
}

for (const [label, data] of CORPUS) {
  test(`SDS-AC-9 ${label}: both codecs reconstruct the same text and identity`, () => {
    const json = jsonDelivery(data);
    const binary = fromBinaryOutputFrame(frameFor(data), { authorityEpoch: 'auth-1' });

    assert.equal(asText(binary.whole.data), asText(json.whole.data), `${label}: text differs`);
    assert.equal(asText(binary.whole.data), data, `${label}: binary did not round trip`);
    assert.equal(binary.whole.byteLength, json.whole.byteLength, `${label}: byte count differs`);
    assert.equal(binary.whole.screenSeq, json.whole.screenSeq);
    assert.equal(binary.whole.authorityEpoch, json.whole.authorityEpoch);
    assert.equal(binary.whole.authorityRevision, json.whole.authorityRevision);
    assert.equal(binary.whole.chunkId, json.whole.chunkId);
    assert.equal(binary.codec, 'binary');
    assert.equal(json.codec, 'json');
  });
}

test('SDS-AC-9 the byte count is the UTF-8 length, not the UTF-16 one', () => {
  // Control: comparing `data.length` would make every test above pass while the
  // credit ledger under-counted every non-ASCII payload.
  const data = '한글👩‍💻';
  const json = jsonDelivery(data);
  assert.notEqual(json.whole.byteLength, data.length, 'the corpus must not be ASCII-equivalent');
  assert.equal(json.whole.byteLength, new TextEncoder().encode(data).byteLength);
  assert.equal(fromBinaryOutputFrame(frameFor(data), {}).whole.byteLength, json.whole.byteLength);
});

test('SDS-AC-9 a chunkIdBase of 0 is absent, matching a JSON message with no chunkId', () => {
  const data = 'x';
  const binary = fromBinaryOutputFrame(frameFor(data, '0', '0', 0), {});
  const json = fromJsonOutputMessage(
    data,
    { type: 'output', sessionId: 's', data } as unknown as TerminalOutputMessage,
  );
  assert.equal(binary.whole.chunkId, undefined);
  assert.equal(json.whole.chunkId, undefined);
});
