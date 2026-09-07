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
test('PERF-BGSTAB-011 source transport sidecars preserve canonical uint64 boundaries', () => {
  for (const sourceSeq of ['0', '9007199254740993', '18446744073709551615']) {
    const message = createWsTransportMessage({ type: 'output', sessionId: 'source-boundary', data: 'body', streamEpoch: '18446744073709551615', sourceSeq });
    assert.equal(message.sourceSeq, sourceSeq);
    assert.equal(Reflect.get(message, 'streamEpoch'), '18446744073709551615');
  }
});

test('PERF-BGSTAB-011 source sidecar rejects noncanonical and overflowing ordinals', () => {
  for (const value of ['01', '-1', '1.0', '', '18446744073709551616', '999999999999999999999999999999999']) {
    const message = createWsTransportMessage({ type: 'output', sessionId: 'source-invalid', data: 'body', streamEpoch: value, sourceSeq: value });
    assert.equal(message.sourceSeq, undefined, value);
    assert.equal(Reflect.get(message, 'streamEpoch'), undefined, value);
  }
  const gap = createWsTransportMessage({ type: 'terminal-delivery:data-gap', sessionId: 'source-gap', deliverySeq: 1 });
  assert.equal(gap.sourceSeq, undefined);
  assert.equal(Reflect.get(gap, 'streamEpoch'), undefined);
});

test('PERF-BGSTAB-011 canonical sourceSeq survives an invalid or absent streamEpoch sidecar', () => {
  for (const streamEpoch of ['01', '-1', '1.0', '', '18446744073709551616', '999999999999999999999999999999999', undefined]) {
    const message = createWsTransportMessage({
      type: 'output', sessionId: 'independent-source', data: 'body',
      sourceSeq: '18446744073709551615',
      ...(streamEpoch === undefined ? {} : { streamEpoch }),
    });
    assert.equal(message.sourceSeq, '18446744073709551615', `sourceSeq must survive epoch ${String(streamEpoch)}`);
    assert.equal(Reflect.get(message, 'streamEpoch'), undefined, `reject only epoch ${String(streamEpoch)}`);
  }
});

test('PERF-BGSTAB-011 canonical streamEpoch survives an invalid or absent sourceSeq sidecar', () => {
  for (const sourceSeq of ['01', '-1', '1.0', '', '18446744073709551616', '999999999999999999999999999999999', undefined]) {
    const message = createWsTransportMessage({
      type: 'output', sessionId: 'independent-epoch', data: 'body',
      streamEpoch: '18446744073709551615',
      ...(sourceSeq === undefined ? {} : { sourceSeq }),
    });
    assert.equal(Reflect.get(message, 'streamEpoch'), '18446744073709551615', `epoch must survive sourceSeq ${String(sourceSeq)}`);
    assert.equal(message.sourceSeq, undefined, `reject only sourceSeq ${String(sourceSeq)}`);
  }
});
