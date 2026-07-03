export type TerminalOutputSchedulerDecision =
  | { ok: true }
  | { ok: false; reason: 'visible-output-overflow'; droppedBytes: number };

export interface TerminalOutputSchedulerOptions {
  visibleOutputQueueMaxBytes: number;
  visibleOutputMaxChunks: number;
  visibleFlushBudgetBytes: number;
  visibleFlushFrameBudgetMs?: number;
  write: (data: string, onWritten: () => void) => void;
  schedule?: (drain: () => void) => void;
  shouldYield?: () => boolean;
  now?: () => number;
}

export type TerminalOutputSchedulerConfig = Pick<
  TerminalOutputSchedulerOptions,
  'visibleOutputQueueMaxBytes' | 'visibleOutputMaxChunks' | 'visibleFlushBudgetBytes' | 'visibleFlushFrameBudgetMs'
>;

export interface TerminalOutputScheduler {
  enqueue: (data: string, onWritten?: () => void) => TerminalOutputSchedulerDecision;
  configure: (options: Partial<TerminalOutputSchedulerConfig>) => void;
  flush: () => void;
  reset: () => void;
  isIdle: () => boolean;
  isStale: () => boolean;
  pendingBytes: () => number;
}

interface PendingOutputChunk {
  data: string;
  callbacks: Array<() => void>;
}

const textEncoder = new TextEncoder();
export const DEFAULT_VISIBLE_FLUSH_FRAME_BUDGET_MS = 7;

export function createTerminalOutputScheduler(options: TerminalOutputSchedulerOptions): TerminalOutputScheduler {
  let config: TerminalOutputSchedulerConfig = {
    visibleOutputQueueMaxBytes: options.visibleOutputQueueMaxBytes,
    visibleOutputMaxChunks: options.visibleOutputMaxChunks,
    visibleFlushBudgetBytes: options.visibleFlushBudgetBytes,
    visibleFlushFrameBudgetMs: normalizeFrameBudgetMs(options.visibleFlushFrameBudgetMs),
  };
  let queue: PendingOutputChunk[] = [];
  let queuedBytes = 0;
  let inFlight = false;
  let scheduled = false;
  let stale = false;
  let generation = 0;
  let consecutiveInputYields = 0;

  const schedule = options.schedule ?? defaultSchedule;
  const now = options.now ?? defaultNow;

  const requestFlush = (): void => {
    if (stale || inFlight || scheduled || queue.length === 0) {
      return;
    }
    scheduled = true;
    schedule(() => {
      scheduled = false;
      flush();
    });
  };

  const flush = (): void => {
    if (stale || inFlight || queue.length === 0) {
      return;
    }

    const frameDeadline = now() + normalizeFrameBudgetMs(config.visibleFlushFrameBudgetMs);
    drainFrame(frameDeadline);
  };

  const drainFrame = (frameDeadline: number): void => {
    while (!stale && !inFlight && queue.length > 0) {
      if (consecutiveInputYields === 0 && options.shouldYield?.()) {
        consecutiveInputYields += 1;
        requestFlush();
        return;
      }
      consecutiveInputYields = 0;

      const currentGeneration = generation;
      const entry = queue[0];
      const split = takeUtf8Prefix(entry.data, config.visibleFlushBudgetBytes);
      if (!split.head) {
        return;
      }

      queuedBytes -= split.headBytes;
      if (split.tail) {
        queue[0] = {
          data: split.tail,
          callbacks: entry.callbacks,
        };
      } else {
        queue.shift();
      }

      inFlight = true;
      let continuedInCallback = false;
      options.write(split.head, () => {
        if (currentGeneration !== generation) {
          return;
        }
        inFlight = false;
        if (!split.tail) {
          for (const callback of entry.callbacks) {
            callback();
          }
        }
        if (queue.length === 0) {
          return;
        }
        continuedInCallback = true;
        if (now() >= frameDeadline) {
          requestFlush();
          return;
        }
        if (consecutiveInputYields === 0 && options.shouldYield?.()) {
          requestFlush();
          return;
        }
        drainFrame(frameDeadline);
      });

      if (continuedInCallback) {
        return;
      }
      if (inFlight) {
        return;
      }
      if (now() >= frameDeadline) {
        requestFlush();
        return;
      }
    }
  };

  return {
    enqueue(data, onWritten) {
      if (stale) {
        return {
          ok: false,
          reason: 'visible-output-overflow',
          droppedBytes: getUtf8ByteLength(data),
        };
      }

      const byteLength = getUtf8ByteLength(data);
      if (byteLength > config.visibleOutputQueueMaxBytes || queuedBytes + byteLength > config.visibleOutputQueueMaxBytes) {
        const droppedBytes = queuedBytes + byteLength;
        queue = [];
        queuedBytes = 0;
        stale = true;
        return {
          ok: false,
          reason: 'visible-output-overflow',
          droppedBytes,
        };
      }

      queue.push({
        data,
        callbacks: onWritten ? [onWritten] : [],
      });
      queuedBytes += byteLength;
      if (queue.length > config.visibleOutputMaxChunks) {
        queue = coalesceChunks(queue);
      }
      requestFlush();
      return { ok: true };
    },
    configure(nextOptions) {
      config = {
        ...config,
        ...nextOptions,
      };
      config.visibleFlushFrameBudgetMs = normalizeFrameBudgetMs(config.visibleFlushFrameBudgetMs);
      if (queue.length > config.visibleOutputMaxChunks) {
        queue = coalesceChunks(queue);
      }
    },
    flush,
    reset() {
      generation += 1;
      queue = [];
      queuedBytes = 0;
      inFlight = false;
      scheduled = false;
      stale = false;
      consecutiveInputYields = 0;
    },
    isIdle() {
      return !stale && !inFlight && !scheduled && queue.length === 0;
    },
    isStale() {
      return stale;
    },
    pendingBytes() {
      return queuedBytes;
    },
  };
}

function coalesceChunks(chunks: PendingOutputChunk[]): PendingOutputChunk[] {
  return [{
    data: chunks.map(chunk => chunk.data).join(''),
    callbacks: chunks.flatMap(chunk => chunk.callbacks),
  }];
}

function takeUtf8Prefix(value: string, maxBytes: number): { head: string; tail: string; headBytes: number } {
  if (maxBytes <= 0) {
    return { head: '', tail: value, headBytes: 0 };
  }

  let bytes = 0;
  let index = 0;
  for (const codePoint of value) {
    const codePointBytes = getUtf8ByteLength(codePoint);
    if (bytes + codePointBytes > maxBytes) {
      break;
    }
    bytes += codePointBytes;
    index += codePoint.length;
  }

  return {
    head: value.slice(0, index),
    tail: value.slice(index),
    headBytes: bytes,
  };
}

function getUtf8ByteLength(value: string): number {
  return textEncoder.encode(value).length;
}

function defaultSchedule(drain: () => void): void {
  requestAnimationFrame(drain);
}

function defaultNow(): number {
  return typeof performance === 'object' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function normalizeFrameBudgetMs(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_VISIBLE_FLUSH_FRAME_BUDGET_MS;
}
