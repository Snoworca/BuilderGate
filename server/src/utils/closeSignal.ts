// REL-BGSTAB-061 (#208): a signal that work can be raced against without the signal keeping a
// reference to every race. `Promise.race([work, longLivedPromise])` attaches a reaction to the
// long-lived promise each time and that reaction stays until the promise settles; raced once per
// terminal output chunk for the life of a session, it grew the heap without bound.

export interface CloseSignal {
  /** Settles with the work, or with undefined once the signal closes, whichever comes first. */
  race<T>(work: Promise<T>): Promise<T | undefined>;
  /** Releases every pending race; later races settle at once. */
  close(): void;
  isClosed(): boolean;
  /** Races still waiting; a leak shows up here. */
  pendingWaits(): number;
}

export function createCloseSignal(): CloseSignal {
  let closed = false;
  const waiters = new Set<() => void>();
  return {
    race<T>(work: Promise<T>): Promise<T | undefined> {
      if (closed) return Promise.resolve(undefined);
      let wake!: () => void;
      const released = new Promise<undefined>((resolve) => {
        wake = () => resolve(undefined);
      });
      waiters.add(wake);
      return Promise.race([work, released]).finally(() => {
        waiters.delete(wake);
      });
    },
    close() {
      if (closed) return;
      closed = true;
      for (const wake of waiters) wake();
      waiters.clear();
    },
    isClosed: () => closed,
    pendingWaits: () => waiters.size,
  };
}
