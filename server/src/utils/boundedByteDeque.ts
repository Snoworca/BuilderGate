export type BoundedByteDequeRejectReason = 'byte-limit' | 'chunk-limit';

export interface BoundedByteDequeEnqueueResult {
  ok: boolean;
  reason?: BoundedByteDequeRejectReason;
  pendingBytes: number;
  pendingChunks: number;
  itemBytes: number;
}

export interface BoundedByteDequeSnapshot {
  pendingBytes: number;
  pendingChunks: number;
  rejectedBytes: number;
  rejectedChunks: number;
  maxPendingBytes: number;
  maxPendingChunks: number;
}

export interface BoundedByteDequeOptions<T> {
  maxBytes: number;
  maxChunks: number;
  getByteLength: (item: T) => number;
}

export interface BoundedByteDeque<T> {
  enqueue(item: T): BoundedByteDequeEnqueueResult;
  peek(): T | undefined;
  dequeue(): T | undefined;
  clear(): void;
  snapshot(): BoundedByteDequeSnapshot;
}

class RingLikeBoundedByteDeque<T> implements BoundedByteDeque<T> {
  private readonly maxBytes: number;
  private readonly maxChunks: number;
  private readonly getByteLength: (item: T) => number;
  private items: Array<T | undefined>;
  private itemBytes: number[];
  private head = 0;
  private tail = 0;
  private pendingBytes = 0;
  private pendingChunks = 0;
  private rejectedBytes = 0;
  private rejectedChunks = 0;
  private maxPendingBytes = 0;
  private maxPendingChunks = 0;

  constructor(options: BoundedByteDequeOptions<T>) {
    assertNonNegativeSafeInteger(options.maxBytes, 'maxBytes');
    assertPositiveSafeInteger(options.maxChunks, 'maxChunks');
    this.maxBytes = options.maxBytes;
    this.maxChunks = options.maxChunks;
    this.getByteLength = options.getByteLength;
    this.items = new Array<T | undefined>(this.maxChunks);
    this.itemBytes = new Array<number>(this.maxChunks);
  }

  enqueue(item: T): BoundedByteDequeEnqueueResult {
    const nextItemBytes = this.getByteLength(item);
    assertNonNegativeSafeInteger(nextItemBytes, 'item byte length');

    if (this.pendingChunks >= this.maxChunks) {
      this.rejectedChunks += 1;
      return {
        ok: false,
        reason: 'chunk-limit',
        pendingBytes: this.pendingBytes,
        pendingChunks: this.pendingChunks,
        itemBytes: nextItemBytes,
      };
    }

    if (this.pendingBytes + nextItemBytes > this.maxBytes) {
      this.rejectedBytes += nextItemBytes;
      return {
        ok: false,
        reason: 'byte-limit',
        pendingBytes: this.pendingBytes,
        pendingChunks: this.pendingChunks,
        itemBytes: nextItemBytes,
      };
    }

    this.items[this.tail] = item;
    this.itemBytes[this.tail] = nextItemBytes;
    this.tail = (this.tail + 1) % this.maxChunks;
    this.pendingBytes += nextItemBytes;
    this.pendingChunks += 1;
    this.maxPendingBytes = Math.max(this.maxPendingBytes, this.pendingBytes);
    this.maxPendingChunks = Math.max(this.maxPendingChunks, this.pendingChunks);

    return {
      ok: true,
      pendingBytes: this.pendingBytes,
      pendingChunks: this.pendingChunks,
      itemBytes: nextItemBytes,
    };
  }

  dequeue(): T | undefined {
    if (this.pendingChunks === 0) {
      return undefined;
    }

    const item = this.items[this.head];
    const bytes = this.itemBytes[this.head] ?? 0;
    this.items[this.head] = undefined;
    this.itemBytes[this.head] = 0;
    this.head = (this.head + 1) % this.maxChunks;
    this.pendingChunks -= 1;
    this.pendingBytes -= bytes;

    return item;
  }

  peek(): T | undefined {
    if (this.pendingChunks === 0) {
      return undefined;
    }
    return this.items[this.head];
  }

  clear(): void {
    this.items = new Array<T | undefined>(this.maxChunks);
    this.itemBytes = new Array<number>(this.maxChunks);
    this.head = 0;
    this.tail = 0;
    this.pendingBytes = 0;
    this.pendingChunks = 0;
  }

  snapshot(): BoundedByteDequeSnapshot {
    return {
      pendingBytes: this.pendingBytes,
      pendingChunks: this.pendingChunks,
      rejectedBytes: this.rejectedBytes,
      rejectedChunks: this.rejectedChunks,
      maxPendingBytes: this.maxPendingBytes,
      maxPendingChunks: this.maxPendingChunks,
    };
  }
}

export function createBoundedByteDeque<T>(options: BoundedByteDequeOptions<T>): BoundedByteDeque<T> {
  return new RingLikeBoundedByteDeque(options);
}

function assertNonNegativeSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}

function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}
