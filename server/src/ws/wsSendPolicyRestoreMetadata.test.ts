import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createWsTransportMessage,
  tryCoalesceOutputMessage,
  type WsTransportMessage,
} from './wsSendPolicy.js';
import { jsonWirePayloadText } from './wirePayload.js';

const SIGNATURE = 'expected normal output identities to survive coalescing as source segments';

interface SourceSegment {
  byteStart: number;
  byteEnd: number;
  screenSeq: number;
  authorityEpoch: string;
  authorityRevision: number;
  chunkId: string;
}

type SegmentedTransportMessage = WsTransportMessage & {
  sourceSegments?: SourceSegment[];
};

function createSegmentedMessage(input: {
  data: string;
  queuedAt: number;
  segment: SourceSegment;
}): SegmentedTransportMessage {
  return Object.assign(
    createWsTransportMessage({
      type: 'output',
      sessionId: 'session-restore',
      data: input.data,
      chunkId: input.segment.chunkId,
    }, input.queuedAt),
    { sourceSegments: [input.segment] },
  );
}

test('server RED — normal identified output coalesces while preserving source segment boundaries', () => {
  const beforeSnapshot = createSegmentedMessage({
    data: 'ABC',
    queuedAt: 100,
    segment: {
      byteStart: 0,
      byteEnd: 3,
      screenSeq: 40,
      authorityEpoch: 'authority-a',
      authorityRevision: 40,
      chunkId: 'chunk-40',
    },
  });
  const afterSnapshot = createSegmentedMessage({
    data: '한글',
    queuedAt: 101,
    segment: {
      byteStart: 0,
      byteEnd: 6,
      screenSeq: 41,
      authorityEpoch: 'authority-a',
      authorityRevision: 41,
      chunkId: 'chunk-41',
    },
  });

  const coalesced = tryCoalesceOutputMessage(
    beforeSnapshot,
    afterSnapshot,
    10,
  ) as SegmentedTransportMessage | null;
  assert.ok(coalesced, SIGNATURE);
  assert.equal(coalesced.outputData, 'ABC한글');
  assert.equal(coalesced.screenSeq, undefined);
  assert.equal(coalesced.chunkId, undefined);
  assert.deepEqual(coalesced.sourceSegments, [
    {
      byteStart: 0,
      byteEnd: 3,
      screenSeq: 40,
      authorityEpoch: 'authority-a',
      authorityRevision: 40,
      chunkId: 'chunk-40',
    },
    {
      byteStart: 3,
      byteEnd: 9,
      screenSeq: 41,
      authorityEpoch: 'authority-a',
      authorityRevision: 41,
      chunkId: 'chunk-41',
    },
  ]);
  const wire = JSON.parse(jsonWirePayloadText(coalesced.payload)) as Record<string, unknown>;
  assert.equal(wire.data, 'ABC한글');
  assert.equal(wire.screenSeq, undefined);
  assert.equal(wire.chunkId, undefined);
  assert.deepEqual(wire.sourceSegments, coalesced.sourceSegments);
});

test('server RED — three identity-less output frames remain coalescible', () => {
  const first = createWsTransportMessage({
    type: 'output',
    sessionId: 'session-restore',
    data: 'A',
  }, 100);
  const second = createWsTransportMessage({
    type: 'output',
    sessionId: 'session-restore',
    data: '한',
  }, 101);
  const third = createWsTransportMessage({
    type: 'output',
    sessionId: 'session-restore',
    data: '😀',
  }, 102);

  const firstMerge = tryCoalesceOutputMessage(first, second, 10);
  assert.ok(firstMerge);
  assert.equal(firstMerge.sourceSegments, undefined);

  const secondMerge = tryCoalesceOutputMessage(firstMerge, third, 10);
  assert.ok(secondMerge);
  assert.deepEqual({
    data: secondMerge.outputData,
    sourceSegments: secondMerge.sourceSegments,
    byteLength: Buffer.byteLength(secondMerge.outputData ?? '', 'utf8'),
  }, {
    data: 'A한😀',
    sourceSegments: undefined,
    byteLength: 8,
  });
});

test('PERF-BGSTAB-010 ACK-identified delivery frames never coalesce away their ledger identity', () => {
  const first = createWsTransportMessage({
    type: 'output',
    sessionId: 'session-fair',
    data: 'first',
    connectionEpoch: 'epoch-fair',
    deliverySeq: 1,
    deliveryKind: 'output',
  }, 100);
  const second = createWsTransportMessage({
    type: 'output',
    sessionId: 'session-fair',
    data: 'second',
    connectionEpoch: 'epoch-fair',
    deliverySeq: 2,
    deliveryKind: 'output',
  }, 101);

  assert.equal(tryCoalesceOutputMessage(first, second, 10), null);
});

test('server RED — split surrogate chunks never produce invalid UTF-8 source offsets', () => {
  const high = createWsTransportMessage({
    type: 'output',
    sessionId: 'session-restore',
    data: '\ud83d',
    screenSeq: 50,
    chunkId: 'chunk-high',
  }, 100);
  const low = createWsTransportMessage({
    type: 'output',
    sessionId: 'session-restore',
    data: '\ude00',
    screenSeq: 51,
    chunkId: 'chunk-low',
  }, 101);

  assert.equal(tryCoalesceOutputMessage(high, low, 10), null);
});
