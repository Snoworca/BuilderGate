import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  MAX_INPUT_SEQUENCE_SPAN,
  TerminalInputSequencer,
  type SequencedTerminalInput,
} from '../../src/utils/terminalInputSequencer.ts';
import {
  buildTerminalInputDebugPayload,
  resolveTerminalInputDebugPayload,
  type TerminalDebugInputPayload,
  type TerminalInputDebugPayloadOptions,
} from '../../src/utils/terminalDebugCapture.ts';
import type { InputDebugMetadata } from '../../src/types/ws-protocol.ts';
import * as terminalInputSequencerModule from '../../src/utils/terminalInputSequencer.ts';

/**
 * Stands in for `Intl.Segmenter` in tests that assert the segmenter is never
 * constructed. Every member throws, so any real use surfaces as `message`.
 */
function createUnusableSegmenter(message: string): typeof Intl.Segmenter {
  return class {
    static supportedLocalesOf(): string[] {
      throw new Error(message);
    }
    segment(): Intl.Segments {
      throw new Error(message);
    }
    resolvedOptions(): Intl.ResolvedSegmenterOptions {
      throw new Error(message);
    }
  };
}

interface TerminalPendingInputQueueLifetimeContract {
  disposeTerminalPendingInputQueueLifetime(input: Readonly<{
    expiryTimers: Set<ReturnType<typeof setTimeout>>;
    rejectPending: () => void;
  }>): void;
}

test('same-session xterm recreation retains pending input while session lifetime cleanup settles it once', async () => {
  const signature = 'MIG-BGSTAB-002 AC-4 xterm revision must not own the component pending-input queue';
  const disposeLifetime = (
    terminalInputSequencerModule as unknown as Partial<TerminalPendingInputQueueLifetimeContract>
  ).disposeTerminalPendingInputQueueLifetime;
  assert.equal(typeof disposeLifetime, 'function', signature);
  if (!disposeLifetime) return;

  let expired = 0;
  let rejected = 0;
  const expiryTimers = new Set<ReturnType<typeof setTimeout>>();
  expiryTimers.add(setTimeout(() => {
    expired += 1;
  }, 10_000));

  disposeLifetime({
    expiryTimers,
    rejectPending: () => {
      rejected += 1;
    },
  });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(expiryTimers.size, 0, signature);
  assert.equal(expired, 0, signature);
  assert.equal(rejected, 1, signature);

  const view = readFileSync(new URL('../../src/components/Terminal/TerminalView.tsx', import.meta.url), 'utf8');
  const runtimeEffectStart = view.indexOf('void terminalRuntimeRevision;');
  const runtimeEffectEnd = view.indexOf("workspaceIdRef.current = workspaceId", runtimeEffectStart);
  const runtimeEffect = view.slice(runtimeEffectStart, runtimeEffectEnd);
  assert.notEqual(runtimeEffectStart, -1, signature);
  assert.notEqual(runtimeEffectEnd, -1, signature);
  assert.doesNotMatch(runtimeEffect, /inputQueueExpiryTimersRef/u, signature);
  assert.doesNotMatch(runtimeEffect, /rejectPendingInputQueue\(/u, signature);

  const lifetimeEffectStart = view.indexOf('disposeTerminalPendingInputQueueLifetime({');
  const lifetimeEffectEnd = view.indexOf(']);', lifetimeEffectStart);
  const lifetimeEffect = view.slice(lifetimeEffectStart, lifetimeEffectEnd + 3);
  assert.notEqual(lifetimeEffectStart, -1, signature);
  assert.match(lifetimeEffect, /expiryTimers: inputQueueExpiryTimersRef\.current/u, signature);
  assert.match(lifetimeEffect, /rejectPending: \(\) => rejectPendingInputQueue\('context-changed', 'terminal-disposed'\)/u, signature);
  assert.match(lifetimeEffect, /\[rejectPendingInputQueue, sessionId\]/u, signature);
});

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

test('TerminalInputSequencer reuses provided client-observed metadata when coalescing printable input', () => {
  const emitted: Array<{ input: SequencedTerminalInput; reason: string }> = [];
  const sequencer = new TerminalInputSequencer((input, reason) => {
    emitted.push({ input, reason });
  }, 10_000);
  const originalTextEncoder = globalThis.TextEncoder;
  const originalSegmenter = Intl.Segmenter;

  try {
    globalThis.TextEncoder = class {
      encode(): Uint8Array {
        throw new Error('TextEncoder should not be constructed while metadata is reusable');
      }
    } as typeof TextEncoder;
    (Intl as unknown as { Segmenter?: typeof Intl.Segmenter }).Segmenter = createUnusableSegmenter(
      'Intl.Segmenter should not be constructed while metadata is reusable',
    );

    sequencer.submit('한', {
      clientObservedByteLength: 3,
      clientObservedCodePointCount: 1,
      clientObservedGraphemeCount: 1,
      clientObservedGraphemeApproximate: false,
      clientObservedHasHangul: true,
      clientObservedHasCjk: false,
      clientObservedHasEnter: false,
    });
    sequencer.submit('a', {
      clientObservedByteLength: 1,
      clientObservedCodePointCount: 1,
      clientObservedGraphemeCount: 1,
      clientObservedGraphemeApproximate: false,
      clientObservedHasHangul: false,
      clientObservedHasCjk: false,
      clientObservedHasEnter: false,
    });
    sequencer.flush('metadata-reuse');
  } finally {
    globalThis.TextEncoder = originalTextEncoder;
    (Intl as unknown as { Segmenter?: typeof Intl.Segmenter }).Segmenter = originalSegmenter;
  }

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].input.metadata?.clientObservedByteLength, 4);
  assert.equal(emitted[0].input.metadata?.clientObservedCodePointCount, 2);
  assert.equal(emitted[0].input.metadata?.clientObservedGraphemeCount, 2);
  assert.equal(emitted[0].input.metadata?.clientObservedGraphemeApproximate, false);
  assert.equal(emitted[0].input.metadata?.clientObservedHasHangul, true);
  assert.equal(emitted[0].input.metadata?.clientObservedHasCjk, false);
  assert.equal(emitted[0].input.metadata?.clientObservedHasEnter, false);
});

test('terminal input debug payload reuses module codec singletons and can skip high-cost details when capture is disabled', () => {
  const originalTextEncoder = globalThis.TextEncoder;
  const originalSegmenter = Intl.Segmenter;

  try {
    globalThis.TextEncoder = class {
      encode(): Uint8Array {
        throw new Error('TextEncoder should be a module singleton');
      }
    } as typeof TextEncoder;
    (Intl as unknown as { Segmenter?: typeof Intl.Segmenter }).Segmenter = createUnusableSegmenter(
      'Intl.Segmenter should be a module singleton',
    );

    const enabledPayload = buildTerminalInputDebugPayload('한', { captureSeq: 7 });
    assert.equal(enabledPayload.details.byteLength, 3);
    assert.equal(enabledPayload.details.graphemeCount, 1);

    const disabledPayload = buildTerminalInputDebugPayload('printable-secret', {}, { captureEnabled: false });
    assert.deepEqual(disabledPayload, { details: { clientObservedMetricsSkipped: true } });
  } finally {
    globalThis.TextEncoder = originalTextEncoder;
    (Intl as unknown as { Segmenter?: typeof Intl.Segmenter }).Segmenter = originalSegmenter;
  }
});

test('TerminalInputSequencer preserves debug-disabled metadata without recomputing expensive metrics', () => {
  const emitted: Array<{ input: SequencedTerminalInput; reason: string }> = [];
  const sequencer = new TerminalInputSequencer((input, reason) => emitted.push({ input, reason }));
  const originalTextEncoder = globalThis.TextEncoder;
  const originalSegmenter = Intl.Segmenter;

  try {
    globalThis.TextEncoder = class {
      encode(): Uint8Array {
        throw new Error('TextEncoder should not run when metrics are skipped');
      }
    } as typeof TextEncoder;
    (Intl as unknown as { Segmenter?: typeof Intl.Segmenter }).Segmenter = createUnusableSegmenter(
      'Intl.Segmenter should not run when metrics are skipped',
    );

    sequencer.submit('한', { captureSeq: 9, clientObservedMetricsSkipped: true });
    sequencer.submit('a', { clientObservedMetricsSkipped: true });
    sequencer.flush('debug-disabled');
  } finally {
    globalThis.TextEncoder = originalTextEncoder;
    (Intl as unknown as { Segmenter?: typeof Intl.Segmenter }).Segmenter = originalSegmenter;
  }

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].input.metadata?.captureSeq, 9);
  assert.equal(emitted[0].input.metadata?.clientObservedMetricsSkipped, true);
  assert.equal(emitted[0].input.metadata?.clientObservedByteLength, undefined);
  assert.equal(emitted[0].input.metadata?.clientObservedGraphemeCount, undefined);
});

test('terminal input debug payload resolver does not rebuild when client metadata already exists', () => {
  let buildCalls = 0;
  const buildPayload = (
    raw: string,
    metadata?: Pick<InputDebugMetadata, 'captureSeq' | 'compositionSeq'>,
    options?: TerminalInputDebugPayloadOptions,
  ): TerminalDebugInputPayload => {
    buildCalls += 1;
    return buildTerminalInputDebugPayload(raw, metadata, options);
  };

  const metadata: InputDebugMetadata = {
    captureSeq: 42,
    clientObservedByteLength: 99,
    clientObservedCodePointCount: 3,
    clientObservedGraphemeCount: 2,
    clientObservedGraphemeApproximate: false,
    clientObservedHasHangul: true,
    clientObservedHasCjk: false,
    clientObservedHasEnter: false,
  };

  const reused = resolveTerminalInputDebugPayload('x', metadata, {
    captureEnabled: true,
    buildPayload,
  });
  const computed = resolveTerminalInputDebugPayload('x', undefined, {
    captureEnabled: true,
    buildPayload,
  });

  assert.equal(reused.details.byteLength, 99);
  assert.equal(reused.details.captureSeq, 42);
  assert.equal(computed.details.byteLength, 1);
  assert.equal(buildCalls, 1);
});

interface TerminalQueryReplyResponderIdentity {
  sessionId: string;
  connectionId: string;
  viewGeneration: number;
  transitionEpoch: string;
  authorityEpoch: string;
  streamEpoch: string;
  boundarySourceSeq: string;
  responderLeaseId: string;
}

type TerminalInputRouteRequest = Readonly<{
  inputKind: 'user';
  userInputKind: 'key' | 'paste' | 'ime' | 'mouse';
  data: string;
}> | Readonly<{
  inputKind: 'query-reply';
  data: string;
  replyOrdinal: number;
  responderIdentity: TerminalQueryReplyResponderIdentity;
}>;

interface TerminalInputKindRouteResult {
  accepted: boolean;
  reason?: string;
}

type OrderedTerminalInputSendResult = Readonly<{
  ok: true;
  controlSocketId: string;
  enqueueOrdinal: number;
}> | Readonly<{
  ok: false;
  reason: string;
  queued?: boolean;
  controlSocketId: string;
}>;

interface TerminalInputKindRouterContract {
  createTerminalInputKindRouter(options: {
    controlSocketId: string;
    getCurrentResponderIdentity: () => TerminalQueryReplyResponderIdentity | null;
    submitUserInput: (input: Extract<TerminalInputRouteRequest, { inputKind: 'user' }>) => void;
    flushPendingUserInputBeforeQueryReply: (input: {
      controlSocketId: string;
      responderIdentity: TerminalQueryReplyResponderIdentity;
    }) => OrderedTerminalInputSendResult;
    sendQueryReplyImmediate: (input: {
      expectedControlSocketId: string;
      afterEnqueueOrdinal: number;
      inputKind: 'query-reply';
      data: string;
      replyOrdinal: number;
      responderIdentity: TerminalQueryReplyResponderIdentity;
    }) => OrderedTerminalInputSendResult;
  }): {
    route(input: TerminalInputRouteRequest): TerminalInputKindRouteResult;
  };
}

test('query reply input kind bypasses user sequencer and outbox and rejects stale responder identity', () => {
  const signature = 'MIG-BGSTAB-002 AC-2 query reply routing contract missing';
  const createRouter = (
    terminalInputSequencerModule as unknown as Partial<TerminalInputKindRouterContract>
  ).createTerminalInputKindRouter;
  assert.equal(typeof createRouter, 'function', signature);
  if (!createRouter) return;

  const currentResponderIdentity: TerminalQueryReplyResponderIdentity = Object.freeze({
    sessionId: 'session-1',
    connectionId: 'connection-a',
    viewGeneration: 7,
    transitionEpoch: '8',
    authorityEpoch: 'authority-7',
    streamEpoch: '8',
    boundarySourceSeq: '41',
    responderLeaseId: 'responder-browser-7',
  });
  const userSequencer: string[] = [];
  const userOutbox: string[] = [];
  const reconnectReplay: string[] = [];
  const pendingUserInput: string[] = [];
  const immediateQueryReplies: Array<{
    socketId: string;
    data: string;
    replyOrdinal: number;
    identity: TerminalQueryReplyResponderIdentity;
  }> = [];
  const events: string[] = [];
  let nextEnqueueOrdinal = 10;
  const router = createRouter({
    controlSocketId: 'control-socket-1',
    getCurrentResponderIdentity: () => currentResponderIdentity,
    submitUserInput: input => {
      userSequencer.push(input.data);
      userOutbox.push(input.data);
      reconnectReplay.push(input.data);
      pendingUserInput.push(input.data);
      events.push(`user:${input.userInputKind}`);
    },
    flushPendingUserInputBeforeQueryReply: input => {
      const pending = pendingUserInput.splice(0);
      if (pending.length > 0) {
        events.push(`user-flushed:${input.controlSocketId}:${pending.join('|')}`);
      }
      return {
        ok: true,
        controlSocketId: input.controlSocketId,
        enqueueOrdinal: nextEnqueueOrdinal++,
      };
    },
    sendQueryReplyImmediate: input => {
      assert.equal(input.expectedControlSocketId, 'control-socket-1');
      assert.equal(input.afterEnqueueOrdinal, nextEnqueueOrdinal - 1);
      if (input.data === 'queued-query-reply') {
        events.push('query-reply-queued');
        return {
          ok: false,
          reason: 'socket-send-queued',
          queued: true,
          controlSocketId: input.expectedControlSocketId,
        };
      }
      if (input.data === 'failed-query-reply') {
        events.push('query-reply-failed');
        return {
          ok: false,
          reason: 'socket-send-failed',
          controlSocketId: input.expectedControlSocketId,
        };
      }
      immediateQueryReplies.push({
        socketId: input.expectedControlSocketId,
        data: input.data,
        replyOrdinal: input.replyOrdinal,
        identity: input.responderIdentity,
      });
      events.push('query-reply-immediate');
      return {
        ok: true,
        controlSocketId: input.expectedControlSocketId,
        enqueueOrdinal: nextEnqueueOrdinal++,
      };
    },
  });

  assert.equal(router.route({
    inputKind: 'user',
    userInputKind: 'key',
    data: 'pending-before-query',
  }).accepted, true, signature);
  const sequencerBeforeQuery = [...userSequencer];
  const outboxBeforeQuery = [...userOutbox];
  const replayBeforeQuery = [...reconnectReplay];

  const queryReply = router.route({
    inputKind: 'query-reply',
    data: '\x1b[?1;2c',
    replyOrdinal: 0,
    responderIdentity: currentResponderIdentity,
  });
  assert.equal(queryReply.accepted, true, signature);
  assert.deepEqual(immediateQueryReplies, [{
    socketId: 'control-socket-1',
    data: '\x1b[?1;2c',
    replyOrdinal: 0,
    identity: currentResponderIdentity,
  }], signature);
  assert.deepEqual(userSequencer, sequencerBeforeQuery, signature);
  assert.deepEqual(userOutbox, outboxBeforeQuery, signature);
  assert.deepEqual(reconnectReplay, replayBeforeQuery, signature);
  assert.deepEqual(events.slice(0, 3), [
    'user:key',
    'user-flushed:control-socket-1:pending-before-query',
    'query-reply-immediate',
  ], 'pending user bytes must enter the same control socket before the immediate query reply');

  for (const input of [
    { userInputKind: 'key', data: 'k' },
    { userInputKind: 'paste', data: 'pasted text' },
    { userInputKind: 'ime', data: '한글' },
    { userInputKind: 'mouse', data: '\x1b[<0;10;5M' },
    { userInputKind: 'key', data: '\x1b[1;2R' },
  ] as const) {
    assert.equal(router.route({ inputKind: 'user', ...input }).accepted, true, signature);
  }
  assert.deepEqual(userSequencer, [
    'pending-before-query', 'k', 'pasted text', '한글', '\x1b[<0;10;5M', '\x1b[1;2R',
  ], signature);
  assert.deepEqual(userOutbox, userSequencer, signature);
  assert.deepEqual(reconnectReplay, userSequencer, signature);

  const invalidResponderIdentities: TerminalQueryReplyResponderIdentity[] = [
    { ...currentResponderIdentity, sessionId: 'session-peer' },
    { ...currentResponderIdentity, connectionId: 'connection-peer' },
    {
      ...currentResponderIdentity,
      viewGeneration: currentResponderIdentity.viewGeneration - 1,
    },
    { ...currentResponderIdentity, transitionEpoch: '7' },
    { ...currentResponderIdentity, authorityEpoch: 'authority-peer' },
    { ...currentResponderIdentity, streamEpoch: '7' },
    { ...currentResponderIdentity, boundarySourceSeq: '40' },
    { ...currentResponderIdentity, responderLeaseId: 'responder-browser-stale' },
  ];
  for (const responderIdentity of invalidResponderIdentities) {
    const staleOrPeer = router.route({
      inputKind: 'query-reply',
      data: '\x1b[0n',
      replyOrdinal: 0,
      responderIdentity,
    });
    assert.equal(staleOrPeer.accepted, false, signature);
  }
  for (const responderIdentity of [
    { ...currentResponderIdentity, transitionEpoch: 8 as unknown as string },
    { ...currentResponderIdentity, transitionEpoch: '08' },
    { ...currentResponderIdentity, streamEpoch: '-1' },
    { ...currentResponderIdentity, streamEpoch: '18446744073709551616' },
    { ...currentResponderIdentity, boundarySourceSeq: 41 as unknown as string },
    { ...currentResponderIdentity, boundarySourceSeq: '041' },
    { ...currentResponderIdentity, authorityEpoch: '' },
  ]) {
    assert.equal(router.route({
      inputKind: 'query-reply',
      data: '\x1b[0n',
      replyOrdinal: 0,
      responderIdentity,
    }).accepted, false, 'malformed wire identity must fail before current-identity equality');
  }
  for (const replyOrdinal of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(router.route({
      inputKind: 'query-reply',
      data: '\x1b[0n',
      replyOrdinal,
      responderIdentity: currentResponderIdentity,
    }).accepted, false, 'reply ordinal must be a non-negative safe integer');
  }
  assert.equal(immediateQueryReplies.length, 1, signature);

  const queued = router.route({
    inputKind: 'query-reply',
    data: 'queued-query-reply',
    replyOrdinal: 1,
    responderIdentity: currentResponderIdentity,
  });
  const failed = router.route({
    inputKind: 'query-reply',
    data: 'failed-query-reply',
    replyOrdinal: 2,
    responderIdentity: currentResponderIdentity,
  });
  assert.equal(queued.accepted, false, signature);
  assert.equal(failed.accepted, false, signature);
  assert.equal(immediateQueryReplies.length, 1, signature);
  assert.deepEqual(userOutbox, userSequencer, signature);
  assert.deepEqual(reconnectReplay, userSequencer, signature);
  assert.deepEqual(events, [
    'user:key',
    'user-flushed:control-socket-1:pending-before-query',
    'query-reply-immediate',
    'user:key',
    'user:paste',
    'user:ime',
    'user:mouse',
    'user:key',
    'user-flushed:control-socket-1:k|pasted text|한글|\x1b[<0;10;5M|\x1b[1;2R',
    'query-reply-queued',
    'query-reply-failed',
  ], signature);

  let outOfOrderReplySent = false;
  const flushFailureRouter = createRouter({
    controlSocketId: 'control-socket-1',
    getCurrentResponderIdentity: () => currentResponderIdentity,
    submitUserInput: () => {},
    flushPendingUserInputBeforeQueryReply: () => ({
      ok: false,
      reason: 'pending-user-flush-queued',
      queued: true,
      controlSocketId: 'control-socket-1',
    }),
    sendQueryReplyImmediate: () => {
      outOfOrderReplySent = true;
      return { ok: true, controlSocketId: 'control-socket-1', enqueueOrdinal: 100 };
    },
  });
  assert.deepEqual(flushFailureRouter.route({
    inputKind: 'query-reply',
    data: '\x1b[0n',
    replyOrdinal: 3,
    responderIdentity: currentResponderIdentity,
  }), {
    accepted: false,
    reason: 'pending-user-flush-queued',
  }, 'a query reply cannot overtake pending user input when its ordered flush cannot enqueue');
  assert.equal(outOfOrderReplySent, false, signature);

  let wrongSocketReplySent = false;
  const wrongSocketFlushRouter = createRouter({
    controlSocketId: 'control-socket-1',
    getCurrentResponderIdentity: () => currentResponderIdentity,
    submitUserInput: () => {},
    flushPendingUserInputBeforeQueryReply: () => ({
      ok: true,
      controlSocketId: 'control-socket-peer',
      enqueueOrdinal: 101,
    }),
    sendQueryReplyImmediate: () => {
      wrongSocketReplySent = true;
      return { ok: true, controlSocketId: 'control-socket-1', enqueueOrdinal: 102 };
    },
  });
  assert.deepEqual(wrongSocketFlushRouter.route({
    inputKind: 'query-reply',
    data: '\x1b[0n',
    replyOrdinal: 4,
    responderIdentity: currentResponderIdentity,
  }), {
    accepted: false,
    reason: 'pending-user-flush-control-socket-mismatch',
  }, 'pending user bytes and their query reply must be fenced to one control socket');
  assert.equal(wrongSocketReplySent, false, signature);

  const storedUserOutboxBeforeSendResultFences = [...userOutbox];
  const storedReconnectReplayBeforeSendResultFences = [...reconnectReplay];
  let sendSocketMismatchPrimitiveInvocations = 0;
  let sendSocketMismatchUnderlyingSideEffects = 0;
  const sendSocketMismatchRouter = createRouter({
    controlSocketId: 'control-socket-1',
    getCurrentResponderIdentity: () => currentResponderIdentity,
    submitUserInput: () => {},
    flushPendingUserInputBeforeQueryReply: () => ({
      ok: true,
      controlSocketId: 'control-socket-1',
      enqueueOrdinal: 200,
    }),
    sendQueryReplyImmediate: input => {
      sendSocketMismatchPrimitiveInvocations += 1;
      const plannedControlSocketId = 'control-socket-peer';
      if (plannedControlSocketId !== input.expectedControlSocketId) {
        return {
          ok: false,
          reason: 'query-send-control-socket-mismatch',
          controlSocketId: plannedControlSocketId,
        };
      }
      sendSocketMismatchUnderlyingSideEffects += 1;
      return { ok: true, controlSocketId: plannedControlSocketId, enqueueOrdinal: 201 };
    },
  });
  assert.deepEqual(sendSocketMismatchRouter.route({
    inputKind: 'query-reply',
    data: '\x1b[0n',
    replyOrdinal: 5,
    responderIdentity: currentResponderIdentity,
  }), {
    accepted: false,
    reason: 'query-send-control-socket-mismatch',
  }, 'a send result from a different control socket cannot complete the query reply route');
  assert.equal(sendSocketMismatchPrimitiveInvocations, 1, 'the router must invoke the atomic send primitive once');
  assert.equal(sendSocketMismatchUnderlyingSideEffects, 0, 'a socket mismatch must fail before the atomic primitive sends bytes');

  for (const [replyOrdinal, sendEnqueueOrdinal] of [
    [6, 300],
    [7, 299],
  ] as const) {
    let regressedSendPrimitiveInvocations = 0;
    let regressedSendUnderlyingSideEffects = 0;
    const sendOrdinalRegressionRouter = createRouter({
      controlSocketId: 'control-socket-1',
      getCurrentResponderIdentity: () => currentResponderIdentity,
      submitUserInput: () => {},
      flushPendingUserInputBeforeQueryReply: () => ({
        ok: true,
        controlSocketId: 'control-socket-1',
        enqueueOrdinal: 300,
      }),
      sendQueryReplyImmediate: input => {
        regressedSendPrimitiveInvocations += 1;
        if (sendEnqueueOrdinal <= input.afterEnqueueOrdinal) {
          return {
            ok: false,
            reason: 'query-send-enqueue-order-regression',
            controlSocketId: input.expectedControlSocketId,
          };
        }
        regressedSendUnderlyingSideEffects += 1;
        return {
          ok: true,
          controlSocketId: input.expectedControlSocketId,
          enqueueOrdinal: sendEnqueueOrdinal,
        };
      },
    });
    assert.deepEqual(sendOrdinalRegressionRouter.route({
      inputKind: 'query-reply',
      data: '\x1b[0n',
      replyOrdinal,
      responderIdentity: currentResponderIdentity,
    }), {
      accepted: false,
      reason: 'query-send-enqueue-order-regression',
    }, 'a query reply send must have an enqueue ordinal strictly after its pending-user flush');
    assert.equal(regressedSendPrimitiveInvocations, 1, 'the router must invoke the atomic send primitive once');
    assert.equal(regressedSendUnderlyingSideEffects, 0, 'an ordinal regression must fail before the atomic primitive sends bytes');
  }

  for (const invalidEnqueueOrdinal of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    let sendInvoked = false;
    const invalidFlushReceiptRouter = createRouter({
      controlSocketId: 'control-socket-1',
      getCurrentResponderIdentity: () => currentResponderIdentity,
      submitUserInput: () => {},
      flushPendingUserInputBeforeQueryReply: () => ({
        ok: true,
        controlSocketId: 'control-socket-1',
        enqueueOrdinal: invalidEnqueueOrdinal,
      }),
      sendQueryReplyImmediate: () => {
        sendInvoked = true;
        return { ok: true, controlSocketId: 'control-socket-1', enqueueOrdinal: 999 };
      },
    });
    assert.deepEqual(invalidFlushReceiptRouter.route({
      inputKind: 'query-reply',
      data: '\x1b[0n',
      replyOrdinal: 8,
      responderIdentity: currentResponderIdentity,
    }), {
      accepted: false,
      reason: 'pending-user-flush-invalid-enqueue-ordinal',
    }, 'flush receipts must carry a canonical non-negative safe enqueue ordinal');
    assert.equal(sendInvoked, false, 'an invalid flush receipt must block the atomic query send');

    const invalidSendReceiptRouter = createRouter({
      controlSocketId: 'control-socket-1',
      getCurrentResponderIdentity: () => currentResponderIdentity,
      submitUserInput: () => {},
      flushPendingUserInputBeforeQueryReply: () => ({
        ok: true,
        controlSocketId: 'control-socket-1',
        enqueueOrdinal: 400,
      }),
      sendQueryReplyImmediate: input => {
        assert.equal(input.expectedControlSocketId, 'control-socket-1');
        assert.equal(input.afterEnqueueOrdinal, 400);
        return {
          ok: true,
          controlSocketId: input.expectedControlSocketId,
          enqueueOrdinal: invalidEnqueueOrdinal,
        };
      },
    });
    assert.deepEqual(invalidSendReceiptRouter.route({
      inputKind: 'query-reply',
      data: '\x1b[0n',
      replyOrdinal: 9,
      responderIdentity: currentResponderIdentity,
    }), {
      accepted: false,
      reason: 'query-send-invalid-enqueue-ordinal',
    }, 'immediate-send receipts must carry a canonical non-negative safe enqueue ordinal');
  }

  const nullableCurrentIdentity: TerminalQueryReplyResponderIdentity | null = null;
  const noIdentityUserInput: string[] = [];
  let noIdentityFlushCalls = 0;
  let noIdentitySendCalls = 0;
  const noIdentityRouter = createRouter({
    controlSocketId: 'control-socket-1',
    getCurrentResponderIdentity: () => nullableCurrentIdentity,
    submitUserInput: input => noIdentityUserInput.push(input.data),
    flushPendingUserInputBeforeQueryReply: () => {
      noIdentityFlushCalls += 1;
      return { ok: true, controlSocketId: 'control-socket-1', enqueueOrdinal: 500 };
    },
    sendQueryReplyImmediate: () => {
      noIdentitySendCalls += 1;
      return { ok: true, controlSocketId: 'control-socket-1', enqueueOrdinal: 501 };
    },
  });
  assert.deepEqual(noIdentityRouter.route({
    inputKind: 'query-reply',
    data: '\x1b[0n',
    replyOrdinal: 10,
    responderIdentity: currentResponderIdentity,
  }), {
    accepted: false,
    reason: 'query-responder-identity-unavailable',
  }, 'a query reply must fail closed while the current responder identity is unavailable');
  assert.equal(noIdentityFlushCalls, 0);
  assert.equal(noIdentitySendCalls, 0);
  assert.equal(noIdentityRouter.route({ inputKind: 'user', userInputKind: 'key', data: 'u' }).accepted, true);
  assert.deepEqual(noIdentityUserInput, ['u'], 'ordinary user input must remain routable without a query responder identity');
  assert.deepEqual(userOutbox, storedUserOutboxBeforeSendResultFences, signature);
  assert.deepEqual(reconnectReplay, storedReconnectReplayBeforeSendResultFences, signature);
  assert.equal(immediateQueryReplies.length, 1, 'rejected send completions must not enter user storage or accepted reply completion');
});
