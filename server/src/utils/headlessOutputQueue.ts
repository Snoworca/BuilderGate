import {
  createBoundedByteDeque,
  type BoundedByteDeque,
  type BoundedByteDequeEnqueueResult,
  type BoundedByteDequeRejectReason,
} from './boundedByteDeque.js';

export type HeadlessOutputOverflowPolicy = 'degrade-headless';

export interface HeadlessOutputQueueOptions {
  maxBytes: number;
  maxChunks: number;
  overflowPolicy: HeadlessOutputOverflowPolicy;
  now?: () => number;
}

export interface HeadlessOutputQueueEntry {
  data: string;
  byteLength: number;
  queuedAt: number;
}

export interface HeadlessOutputQueueOverflow {
  reason: BoundedByteDequeRejectReason;
  policy: HeadlessOutputOverflowPolicy;
  itemBytes: number;
}

export interface HeadlessOutputQueueEnqueueResult extends BoundedByteDequeEnqueueResult {
  policy?: HeadlessOutputOverflowPolicy;
  shouldDegradeHeadless?: boolean;
}

export interface HeadlessOutputQueueSnapshot {
  pendingBytes: number;
  pendingChunks: number;
  overflowCount: number;
  maxPendingBytes: number;
  maxPendingChunks: number;
  oldestPendingAgeMs: number;
  lastOverflow?: HeadlessOutputQueueOverflow;
  degradedCount: number;
}

export interface HeadlessOutputQueue {
  enqueue(data: string): HeadlessOutputQueueEnqueueResult;
  dequeue(): HeadlessOutputQueueEntry | undefined;
  drain(): HeadlessOutputQueueEntry[];
  clear(): void;
  recordDegraded(): void;
  snapshot(): HeadlessOutputQueueSnapshot;
}

class DefaultHeadlessOutputQueue implements HeadlessOutputQueue {
  private readonly queue: BoundedByteDeque<HeadlessOutputQueueEntry>;
  private readonly overflowPolicy: HeadlessOutputOverflowPolicy;
  private readonly now: () => number;
  private overflowCount = 0;
  private degradedCount = 0;
  private lastOverflow: HeadlessOutputQueueOverflow | undefined;

  constructor(options: HeadlessOutputQueueOptions) {
    this.overflowPolicy = options.overflowPolicy;
    this.now = options.now ?? Date.now;
    this.queue = createBoundedByteDeque<HeadlessOutputQueueEntry>({
      maxBytes: options.maxBytes,
      maxChunks: options.maxChunks,
      getByteLength: (entry) => entry.byteLength,
    });
  }

  enqueue(data: string): HeadlessOutputQueueEnqueueResult {
    const entry = {
      data,
      byteLength: Buffer.byteLength(data, 'utf8'),
      queuedAt: this.now(),
    };
    const result = this.queue.enqueue(entry);
    if (result.ok) {
      return result;
    }

    const overflow: HeadlessOutputQueueOverflow = {
      reason: result.reason ?? 'byte-limit',
      policy: this.overflowPolicy,
      itemBytes: result.itemBytes,
    };
    this.overflowCount += 1;
    this.lastOverflow = overflow;
    return {
      ...result,
      policy: this.overflowPolicy,
      shouldDegradeHeadless: this.overflowPolicy === 'degrade-headless',
    };
  }

  dequeue(): HeadlessOutputQueueEntry | undefined {
    return this.queue.dequeue();
  }

  drain(): HeadlessOutputQueueEntry[] {
    const entries: HeadlessOutputQueueEntry[] = [];
    let entry = this.queue.dequeue();
    while (entry !== undefined) {
      entries.push(entry);
      entry = this.queue.dequeue();
    }
    return entries;
  }

  clear(): void {
    this.queue.clear();
  }

  recordDegraded(): void {
    this.degradedCount += 1;
  }

  snapshot(): HeadlessOutputQueueSnapshot {
    const queueSnapshot = this.queue.snapshot();
    const oldest = this.queue.peek();
    return {
      pendingBytes: queueSnapshot.pendingBytes,
      pendingChunks: queueSnapshot.pendingChunks,
      overflowCount: this.overflowCount,
      maxPendingBytes: queueSnapshot.maxPendingBytes,
      maxPendingChunks: queueSnapshot.maxPendingChunks,
      oldestPendingAgeMs: oldest ? Math.max(0, this.now() - oldest.queuedAt) : 0,
      degradedCount: this.degradedCount,
      ...(this.lastOverflow ? { lastOverflow: { ...this.lastOverflow } } : {}),
    };
  }
}

export function createHeadlessOutputQueue(options: HeadlessOutputQueueOptions): HeadlessOutputQueue {
  return new DefaultHeadlessOutputQueue(options);
}
