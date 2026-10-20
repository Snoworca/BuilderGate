// Saves a value the screen already shows (PERF-BGSTAB-024).
//
// One request at a time. A value set while a request is in flight waits, and only the newest
// waiting value is sent next, so quick repeated selections end on the server as the last one
// regardless of the order responses come back in. A failure is reported and does not block the
// next value.
// @req PERF-BGSTAB-024

export interface LatestValueSaver<T> {
  /** Resolves once this value has been sent, superseded, or failed. */
  save: (value: T) => Promise<void>;
}

export function createLatestValueSaver<T>(
  send: (value: T) => Promise<void>,
  onError?: (error: unknown) => void,
): LatestValueSaver<T> {
  let inFlight: Promise<void> | null = null;
  let waiting: { value: T } | null = null;
  let waiters: (() => void)[] = [];

  const run = (value: T): Promise<void> => {
    inFlight = send(value)
      .catch((error: unknown) => { onError?.(error); })
      .finally(() => {
        inFlight = null;
        const settled = waiters;
        waiters = [];
        if (waiting !== null) {
          const next = waiting.value;
          waiting = null;
          void run(next).then(() => settled.forEach((done) => done()));
        } else {
          settled.forEach((done) => done());
        }
      });
    return inFlight;
  };

  return {
    save(value) {
      if (inFlight === null) return run(value);
      waiting = { value };
      return new Promise<void>((resolve) => { waiters.push(resolve); });
    },
  };
}

/**
 * A selection shown on screen but not yet saved wins over server data that arrives meanwhile
 * (a refetch on reconnect, a workspace:updated broadcast), which still carries the old value.
 */
export function applyPendingSelections<T extends { id: string }>(
  items: readonly T[],
  pending: ReadonlyMap<string, Partial<T>>,
): T[] {
  if (pending.size === 0) return items as T[];
  return items.map((item) => {
    const overlay = pending.get(item.id);
    return overlay === undefined ? item : { ...item, ...overlay };
  });
}
