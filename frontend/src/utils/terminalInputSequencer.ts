/* eslint-disable no-control-regex */
import type { InputDebugMetadata } from '../types/ws-protocol';

const DEFAULT_COALESCE_DELAY_MS = 8;
export const MAX_INPUT_SEQUENCE_SPAN = 1024;
const HANGUL_RE = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/u;
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;
const CONTROL_RE = /[\x00-\x1f\x7f]/u;
const inputTextEncoder = new TextEncoder();
const graphemeSegmenter = createGraphemeSegmenter();

export interface SequencedTerminalInput {
  data: string;
  metadata?: InputDebugMetadata;
  inputSeqStart: number;
  inputSeqEnd: number;
  logicalChunkCount: number;
}

export type SequencedTerminalInputEmitter = (
  input: SequencedTerminalInput,
  reason: string,
) => void;

interface PendingSequencerInput {
  data: string;
  metadata: InputDebugMetadata[];
  logicalChunkCount: number;
}

export class TerminalInputSequencer {
  private nextSeq = 1;
  private pending: PendingSequencerInput | null = null;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private emitter: SequencedTerminalInputEmitter;
  private readonly coalesceDelayMs: number;

  constructor(emitter: SequencedTerminalInputEmitter, coalesceDelayMs = DEFAULT_COALESCE_DELAY_MS) {
    this.emitter = emitter;
    this.coalesceDelayMs = coalesceDelayMs;
  }

  setEmitter(emitter: SequencedTerminalInputEmitter): void {
    this.emitter = emitter;
  }

  reset(nextSeq = 1): void {
    this.clearTimer();
    this.pending = null;
    this.nextSeq = Math.max(1, nextSeq);
  }

  dispose(): void {
    this.clearTimer();
    this.pending = null;
  }

  submit(data: string, metadata?: InputDebugMetadata): void {
    if (!isCoalesciblePrintableChunk(data)) {
      this.flush('control-boundary');
      this.emitSequenced(data, metadata, 1, 'boundary');
      return;
    }

    if (!this.pending) {
      this.pending = {
        data,
        metadata: metadata ? [metadata] : [],
        logicalChunkCount: 1,
      };
    } else {
      if (this.pending.logicalChunkCount >= MAX_INPUT_SEQUENCE_SPAN) {
        this.flush('sequence-span-limit');
        this.pending = {
          data,
          metadata: metadata ? [metadata] : [],
          logicalChunkCount: 1,
        };
        this.scheduleFlush();
        return;
      }
      this.pending.data += data;
      if (metadata) {
        this.pending.metadata.push(metadata);
      }
      this.pending.logicalChunkCount += 1;
    }

    this.scheduleFlush();
  }

  flush(reason = 'manual'): void {
    const pending = this.pending;
    if (!pending) {
      return;
    }

    this.clearTimer();
    this.pending = null;
    this.emitSequenced(
      pending.data,
      mergeInputMetadata(pending.data, pending.metadata),
      pending.logicalChunkCount,
      reason,
    );
  }

  nextInputSeqRange(logicalChunkCount: number): { inputSeqStart: number; inputSeqEnd: number } {
    const safeChunkCount = Number.isSafeInteger(logicalChunkCount) && logicalChunkCount > 0
      ? logicalChunkCount
      : 1;
    const inputSeqStart = this.nextSeq;
    const inputSeqEnd = inputSeqStart + safeChunkCount - 1;
    this.nextSeq = inputSeqEnd + 1;
    return { inputSeqStart, inputSeqEnd };
  }

  private emitSequenced(
    data: string,
    metadata: InputDebugMetadata | undefined,
    logicalChunkCount: number,
    reason: string,
  ): void {
    const range = this.nextInputSeqRange(logicalChunkCount);
    this.emitter({
      data,
      metadata,
      inputSeqStart: range.inputSeqStart,
      inputSeqEnd: range.inputSeqEnd,
      logicalChunkCount,
    }, reason);
  }

  private scheduleFlush(): void {
    this.clearTimer();
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null;
      this.flush('coalesce-window');
    }, this.coalesceDelayMs);
  }

  private clearTimer(): void {
    if (this.pendingTimer !== null) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
  }
}

export function isCoalesciblePrintableChunk(data: string): boolean {
  if (data.length === 0 || CONTROL_RE.test(data)) {
    return false;
  }

  return Array.from(data).length === 1;
}

function mergeInputMetadata(data: string, chunks: InputDebugMetadata[]): InputDebugMetadata {
  const metadata: InputDebugMetadata = {};
  for (const chunk of chunks) {
    if (metadata.captureSeq === undefined && isSafeInteger(chunk.captureSeq)) {
      metadata.captureSeq = chunk.captureSeq;
    }
    if (metadata.compositionSeq === undefined && isSafeInteger(chunk.compositionSeq)) {
      metadata.compositionSeq = chunk.compositionSeq;
    }
  }

  const mergedClientObserved = mergeClientObservedMetadata(chunks);
  if (mergedClientObserved) {
    Object.assign(metadata, mergedClientObserved);
    return metadata;
  }
  if (areClientObservedMetricsSkipped(chunks)) {
    metadata.clientObservedMetricsSkipped = true;
    return metadata;
  }

  metadata.clientObservedByteLength = utf8ByteLength(data);
  metadata.clientObservedCodePointCount = Array.from(data).length;
  const grapheme = countGraphemes(data);
  metadata.clientObservedGraphemeCount = grapheme.count;
  metadata.clientObservedGraphemeApproximate = grapheme.approximate;
  metadata.clientObservedHasHangul = HANGUL_RE.test(data);
  metadata.clientObservedHasCjk = CJK_RE.test(data);
  metadata.clientObservedHasEnter = false;
  return metadata;
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function utf8ByteLength(data: string): number {
  return inputTextEncoder.encode(data).length;
}

function countGraphemes(data: string): { count: number; approximate: boolean } {
  if (!graphemeSegmenter) {
    return { count: Array.from(data).length, approximate: true };
  }

  return { count: Array.from(graphemeSegmenter.segment(data)).length, approximate: false };
}

function createGraphemeSegmenter(): { segment(input: string): Iterable<unknown> } | null {
  const segmenterCtor = (Intl as unknown as {
    Segmenter?: new (
      locale?: string,
      options?: { granularity?: 'grapheme' },
    ) => { segment(input: string): Iterable<unknown> };
  }).Segmenter;

  if (!segmenterCtor) {
    return null;
  }

  return new segmenterCtor(undefined, { granularity: 'grapheme' });
}

function mergeClientObservedMetadata(chunks: InputDebugMetadata[]): InputDebugMetadata | null {
  if (chunks.length === 0) {
    return null;
  }

  let clientObservedByteLength = 0;
  let clientObservedCodePointCount = 0;
  let clientObservedGraphemeCount = 0;
  let clientObservedGraphemeApproximate = false;
  let clientObservedHasHangul = false;
  let clientObservedHasCjk = false;
  let clientObservedHasEnter = false;

  for (const chunk of chunks) {
    if (
      !isSafeInteger(chunk.clientObservedByteLength)
      || !isSafeInteger(chunk.clientObservedCodePointCount)
      || !isSafeInteger(chunk.clientObservedGraphemeCount)
      || typeof chunk.clientObservedGraphemeApproximate !== 'boolean'
      || typeof chunk.clientObservedHasHangul !== 'boolean'
      || typeof chunk.clientObservedHasCjk !== 'boolean'
      || typeof chunk.clientObservedHasEnter !== 'boolean'
    ) {
      return null;
    }

    clientObservedByteLength += chunk.clientObservedByteLength;
    clientObservedCodePointCount += chunk.clientObservedCodePointCount;
    clientObservedGraphemeCount += chunk.clientObservedGraphemeCount;
    clientObservedGraphemeApproximate ||= chunk.clientObservedGraphemeApproximate;
    clientObservedHasHangul ||= chunk.clientObservedHasHangul;
    clientObservedHasCjk ||= chunk.clientObservedHasCjk;
    clientObservedHasEnter ||= chunk.clientObservedHasEnter;
  }

  return {
    clientObservedByteLength,
    clientObservedCodePointCount,
    clientObservedGraphemeCount,
    clientObservedGraphemeApproximate,
    clientObservedHasHangul,
    clientObservedHasCjk,
    clientObservedHasEnter,
  };
}

function areClientObservedMetricsSkipped(chunks: InputDebugMetadata[]): boolean {
  return chunks.length > 0 && chunks.every((chunk) => chunk.clientObservedMetricsSkipped === true);
}
