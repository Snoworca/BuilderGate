// REL-BGSTAB-055: one terminal's failed recovery resubscribes that session on the shared
// socket. Closing the socket instead makes every session on it fetch its screen again and
// holds their input meanwhile.

export type VisibleRecoveryTransport = 'resubscribe' | 'reconnect';

/** Every budgeted attempt but the last resubscribes; the last falls back to a full reconnect. */
export function chooseVisibleRecoveryTransport(input: {
  attempt: number;
  maxAttempts: number;
}): VisibleRecoveryTransport {
  return input.attempt >= input.maxAttempts ? 'reconnect' : 'resubscribe';
}

export type ResubscribeFenceDecision =
  | { deliver: true }
  | { deliver: false; sessionId: string; type: string | null };

export interface SessionResubscribeFence {
  begin: (sessionId: string) => void;
  /** Every unsubscribe sent is counted, so a reply to an earlier one cannot lift a newer fence. */
  noteUnsubscribeSent: (sessionId: string) => void;
  cancel: (sessionId: string) => void;
  isFenced: (sessionId: string) => boolean;
  /**
   * The server's `unsubscribed` reply. After the reply to the last unsubscribe sent, every
   * frame belongs to the new subscription — including the new snapshot, which the server
   * sends before its `subscribed` reply. Returns true when the message was that reply.
   */
  consumeMarker: (message: unknown) => boolean;
  /**
   * Frames of the old subscription still in flight are dropped. Input replies pass: they
   * answer keystrokes the input pipeline is still waiting on.
   */
  admit: (message: unknown) => ResubscribeFenceDecision;
  /** A new socket starts with no fence: its own subscribe covers every session. */
  clear: () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function createSessionResubscribeFence(): SessionResubscribeFence {
  const fenced = new Set<string>();
  const awaitingReplies = new Map<string, number>();
  return {
    begin: (sessionId) => { fenced.add(sessionId); },
    noteUnsubscribeSent: (sessionId) => {
      awaitingReplies.set(sessionId, (awaitingReplies.get(sessionId) ?? 0) + 1);
    },
    cancel: (sessionId) => { fenced.delete(sessionId); },
    isFenced: (sessionId) => fenced.has(sessionId),
    consumeMarker(message) {
      if (!isRecord(message) || message.type !== 'unsubscribed') return false;
      if (typeof message.sessionId !== 'string') return true;
      const remaining = Math.max(0, (awaitingReplies.get(message.sessionId) ?? 0) - 1);
      if (remaining > 0) {
        awaitingReplies.set(message.sessionId, remaining);
      } else {
        awaitingReplies.delete(message.sessionId);
        fenced.delete(message.sessionId);
      }
      return true;
    },
    admit(message) {
      if (fenced.size === 0 || !isRecord(message)) return { deliver: true };
      if (typeof message.sessionId !== 'string' || !fenced.has(message.sessionId)) return { deliver: true };
      const type = typeof message.type === 'string' ? message.type : null;
      if (type?.startsWith('input:')) return { deliver: true };
      return { deliver: false, sessionId: message.sessionId, type };
    },
    clear: () => {
      fenced.clear();
      awaitingReplies.clear();
    },
  };
}

export interface ResubscribeSocketDeps {
  isOpen: () => boolean;
  sendJson: (message: { type: 'subscribe' | 'unsubscribe'; sessionIds: string[] }) => boolean;
  /** Re-registers the checkpoint view and binary channel the unsubscribe released. */
  refreshCapabilities: () => void;
  retireChannels: (sessionId: string) => void;
  dropGraceBuffer: (sessionId: string) => void;
  fence: SessionResubscribeFence;
}

/**
 * Sends unsubscribe, the capability refresh and subscribe for one session. Returns false
 * when the socket is not open or a send fails, so the caller falls back to a reconnect.
 */
export function resubscribeSessionOnSocket(sessionId: string, deps: ResubscribeSocketDeps): boolean {
  if (!deps.isOpen()) return false;
  deps.dropGraceBuffer(sessionId);
  deps.retireChannels(sessionId);
  deps.fence.begin(sessionId);
  if (!deps.sendJson({ type: 'unsubscribe', sessionIds: [sessionId] })) {
    deps.fence.cancel(sessionId);
    return false;
  }
  deps.fence.noteUnsubscribeSent(sessionId);
  deps.refreshCapabilities();
  if (!deps.sendJson({ type: 'subscribe', sessionIds: [sessionId] })) {
    deps.fence.cancel(sessionId);
    return false;
  }
  return true;
}
