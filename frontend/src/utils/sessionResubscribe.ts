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

/** REL-BGSTAB-056 AC-1: why a session is resubscribed, logged by the server. */
export interface SessionRecoveryReason {
  reason: string;
  attempt: number;
}

export interface ResubscribeSocketDeps {
  isOpen: () => boolean;
  /**
   * False in split transport, where output rides its own socket: the `unsubscribed` reply
   * cannot be ordered against that output, so the caller reconnects instead (REL-BGSTAB-056 AC-2).
   */
  sharesOneSocket: () => boolean;
  sendJson: (message: {
    type: 'subscribe' | 'unsubscribe';
    sessionIds: string[];
    recovery?: SessionRecoveryReason;
  }) => boolean;
  /** Re-registers the checkpoint view and binary channel the unsubscribe released. */
  refreshCapabilities: () => void;
  retireChannels: (sessionId: string) => void;
  dropGraceBuffer: (sessionId: string) => void;
  fence: SessionResubscribeFence;
}

/**
 * Sends unsubscribe, the capability refresh and subscribe for one session. Returns false
 * when the socket is not open, output has its own socket, or a send fails, so the caller
 * falls back to a reconnect.
 */
export function resubscribeSessionOnSocket(
  request: { sessionId: string } & SessionRecoveryReason,
  deps: ResubscribeSocketDeps,
): boolean {
  if (!deps.isOpen() || !deps.sharesOneSocket()) return false;
  const { sessionId, reason, attempt } = request;
  deps.dropGraceBuffer(sessionId);
  deps.retireChannels(sessionId);
  deps.fence.begin(sessionId);
  if (!deps.sendJson({ type: 'unsubscribe', sessionIds: [sessionId], recovery: { reason, attempt } })) {
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
