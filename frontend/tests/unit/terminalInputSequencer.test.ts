import assert from 'node:assert/strict';
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
    (Intl as unknown as { Segmenter?: typeof Intl.Segmenter }).Segmenter = class {
      segment(): Iterable<unknown> {
        throw new Error('Intl.Segmenter should not be constructed while metadata is reusable');
      }
    } as typeof Intl.Segmenter;

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
    (Intl as unknown as { Segmenter?: typeof Intl.Segmenter }).Segmenter = class {
      segment(): Iterable<unknown> {
        throw new Error('Intl.Segmenter should be a module singleton');
      }
    } as typeof Intl.Segmenter;

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
    (Intl as unknown as { Segmenter?: typeof Intl.Segmenter }).Segmenter = class {
      segment(): Iterable<unknown> {
        throw new Error('Intl.Segmenter should not run when metrics are skipped');
      }
    } as typeof Intl.Segmenter;

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
    metadata: Pick<InputDebugMetadata, 'captureSeq' | 'compositionSeq'>,
    options: TerminalInputDebugPayloadOptions,
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
