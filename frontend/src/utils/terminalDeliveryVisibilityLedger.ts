/**
 * The delivery visibility the client reports per session (REL-BGSTAB-012 AC-1 AC-7).
 *
 * REL-BGSTAB-052 AC-10: entries used to stay for every session ever shown, and every reconnect
 * re-sent all of them. A session is forgotten when it is unsubscribed. The generation comes
 * from one counter for the whole connection rather than per session, so a session seen again
 * after being forgotten still sends a generation above any the server has seen for it (the
 * server ignores a generation that is not higher than the last one on the socket).
 */
export interface DeliveryVisibility {
  generation: bigint;
  isVisible: boolean;
  deliveryInterestRefCount: number;
}

export interface DeliveryVisibilityLedger {
  /** Records the session's visibility; false when it is what was already recorded. */
  publish(sessionId: string, isVisible: boolean, deliveryInterestRefCount: number): boolean;
  get(sessionId: string): DeliveryVisibility | undefined;
  entries(): IterableIterator<[string, DeliveryVisibility]>;
  forget(sessionId: string): void;
}

export function createDeliveryVisibilityLedger(): DeliveryVisibilityLedger {
  const bySession = new Map<string, DeliveryVisibility>();
  let lastGeneration = 0n;
  return {
    publish(sessionId, isVisible, deliveryInterestRefCount) {
      const current = bySession.get(sessionId);
      if (current && current.isVisible === isVisible && current.deliveryInterestRefCount === deliveryInterestRefCount) {
        return false;
      }
      lastGeneration += 1n;
      bySession.set(sessionId, { generation: lastGeneration, isVisible, deliveryInterestRefCount });
      return true;
    },
    get: (sessionId) => bySession.get(sessionId),
    entries: () => bySession.entries(),
    forget: (sessionId) => { bySession.delete(sessionId); },
  };
}
