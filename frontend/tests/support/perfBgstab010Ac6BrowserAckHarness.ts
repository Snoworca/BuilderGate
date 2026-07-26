import type { Page } from '@playwright/test';

const AC6_SOCKET_ORIGIN = 'wss://localhost:2222/ws';
const AC6_PROBE_STORE_KEY = '__perfBgstab010Ac6BrowserAckProbes';
const ACK_TIMEOUT_MS = 10_000;

export interface AckRejectedFrame {
  type: 'terminal-delivery:ack-rejected';
  sessionId: string;
  connectionEpoch: string;
  deliverySeq: number;
  reason: 'ACK_UNKNOWN_LANE';
}

export interface Ac6Probe {
  sessionId: string;
  connectionEpoch: string;
  deliverySeq: number;
  sendUnknownLaneAck(): Promise<AckRejectedFrame>;
  close(): Promise<void>;
}

interface CapabilityAdmission {
  sessionId: string;
  connectionEpoch: string;
  deliverySeq: number;
}

export async function openAc6BrowserAckProbe(page: Page): Promise<Ac6Probe> {
  const token = await page.evaluate(() => localStorage.getItem('cws_auth_token'));
  if (!token) throw new Error('AC-6 probe requires the authenticated browser token');

  const probeId = crypto.randomUUID();
  const admission = await page.evaluate(async ({ probeId: id, authToken, socketOrigin, storeKey, timeoutMs }) => {
    type Frame = Record<string, unknown>;
    type StoredProbe = {
      socket: WebSocket;
      sessionId: string;
      connectionEpoch: string;
      deliverySeq: number;
    };
    type ProbeStore = Record<string, StoredProbe>;

    const parse = (raw: unknown): Frame | null => {
      if (typeof raw !== 'string') return null;
      try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed as Frame : null;
      } catch {
        return null;
      }
    };
    const stores = window as typeof window & Record<string, ProbeStore | undefined>;
    const store = stores[storeKey] ?? {};
    stores[storeKey] = store;
    const sessionId = `ac6-probe-${crypto.randomUUID()}`;
    const deliverySeq = 1;
    const socket = new WebSocket(`${socketOrigin}?token=${encodeURIComponent(authToken)}`);

    return await new Promise<CapabilityAdmission>((resolve, reject) => {
      const timeout = window.setTimeout(() => fail('capability admission timed out'), timeoutMs);
      const cleanup = () => {
        window.clearTimeout(timeout);
        socket.removeEventListener('message', onMessage);
        socket.removeEventListener('error', onError);
        socket.removeEventListener('close', onClose);
      };
      const fail = (reason: string) => {
        cleanup();
        socket.close();
        reject(new Error(`AC-6 browser probe ${reason}`));
      };
      const onError = () => fail('socket error before capability admission');
      const onClose = () => fail('socket closed before capability admission');
      const onMessage = (event: MessageEvent) => {
        const frame = parse(event.data);
        if (frame?.type !== 'terminal-delivery:capability') return;
        if (frame.accepted !== true) {
          fail(`capability rejected: ${typeof frame.reason === 'string' ? frame.reason : 'unknown-reason'}`);
          return;
        }
        if (typeof frame.connectionEpoch !== 'string' || frame.connectionEpoch.length === 0) {
          fail('capability acceptance had no connection epoch');
          return;
        }
        store[id] = {
          socket,
          sessionId,
          connectionEpoch: frame.connectionEpoch,
          deliverySeq,
        };
        cleanup();
        resolve({ sessionId, connectionEpoch: frame.connectionEpoch, deliverySeq });
      };
      socket.addEventListener('message', onMessage);
      socket.addEventListener('error', onError);
      socket.addEventListener('close', onClose);
      socket.addEventListener('open', () => {
        socket.send(JSON.stringify({
          type: 'terminal-delivery:capability',
          protocolVersion: 1,
          supportsHiddenDataGapRecovery: true,
        }));
      }, { once: true });
    });
  }, {
    probeId,
    authToken: token,
    socketOrigin: AC6_SOCKET_ORIGIN,
    storeKey: AC6_PROBE_STORE_KEY,
    timeoutMs: ACK_TIMEOUT_MS,
  });

  return {
    ...admission,
    async sendUnknownLaneAck(): Promise<AckRejectedFrame> {
      return await page.evaluate(async ({ id, storeKey, timeoutMs }) => {
        type Frame = Record<string, unknown>;
        type StoredProbe = {
          socket: WebSocket;
          sessionId: string;
          connectionEpoch: string;
          deliverySeq: number;
        };
        const store = (window as typeof window & Record<string, Record<string, StoredProbe> | undefined>)[storeKey];
        const probe = store?.[id];
        if (!probe) throw new Error('AC-6 browser probe state is unavailable');
        const parse = (raw: unknown): Frame | null => {
          if (typeof raw !== 'string') return null;
          try {
            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === 'object' ? parsed as Frame : null;
          } catch {
            return null;
          }
        };

        return await new Promise<AckRejectedFrame>((resolve, reject) => {
          const timeout = window.setTimeout(() => fail('ACK rejection timed out'), timeoutMs);
          const cleanup = () => {
            window.clearTimeout(timeout);
            probe.socket.removeEventListener('message', onMessage);
            probe.socket.removeEventListener('error', onError);
            probe.socket.removeEventListener('close', onClose);
          };
          const fail = (reason: string) => {
            cleanup();
            reject(new Error(`AC-6 browser probe ${reason}`));
          };
          const onError = () => fail('socket error while awaiting ACK rejection');
          const onClose = () => fail('socket closed while awaiting ACK rejection');
          const onMessage = (event: MessageEvent) => {
            const frame = parse(event.data);
            if (frame?.type !== 'terminal-delivery:ack-rejected') return;
            if (
              frame.sessionId !== probe.sessionId
              || frame.connectionEpoch !== probe.connectionEpoch
              || frame.deliverySeq !== probe.deliverySeq
              || frame.reason !== 'ACK_UNKNOWN_LANE'
            ) {
              fail('ACK rejection identity did not match the probe frame');
              return;
            }
            cleanup();
            resolve(frame as AckRejectedFrame);
          };
          probe.socket.addEventListener('message', onMessage);
          probe.socket.addEventListener('error', onError);
          probe.socket.addEventListener('close', onClose);
          probe.socket.send(JSON.stringify({
            type: 'terminal-delivery:ack',
            sessionId: probe.sessionId,
            connectionEpoch: probe.connectionEpoch,
            deliverySeq: probe.deliverySeq,
          }));
        });
      }, { id: probeId, storeKey: AC6_PROBE_STORE_KEY, timeoutMs: ACK_TIMEOUT_MS });
    },
    async close(): Promise<void> {
      await page.evaluate(async ({ id, storeKey, timeoutMs }) => {
        type Frame = Record<string, unknown>;
        type StoredProbe = {
          socket: WebSocket;
          connectionEpoch: string;
        };
        const stores = window as typeof window & Record<string, Record<string, StoredProbe> | undefined>;
        const store = stores[storeKey];
        const probe = store?.[id];
        if (!probe) return;
        const parse = (raw: unknown): Frame | null => {
          if (typeof raw !== 'string') return null;
          try {
            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === 'object' ? parsed as Frame : null;
          } catch {
            return null;
          }
        };

        await new Promise<void>((resolve, reject) => {
          const timeout = window.setTimeout(() => fail('capability withdrawal timed out'), timeoutMs);
          const cleanup = () => {
            window.clearTimeout(timeout);
            probe.socket.removeEventListener('message', onMessage);
            probe.socket.removeEventListener('error', onError);
            probe.socket.removeEventListener('close', onClose);
          };
          const fail = (reason: string) => {
            cleanup();
            reject(new Error(`AC-6 browser probe ${reason}`));
          };
          const onError = () => fail('socket error during capability withdrawal');
          const onClose = () => fail('socket closed before capability withdrawal');
          const onMessage = (event: MessageEvent) => {
            const frame = parse(event.data);
            if (frame?.type !== 'terminal-delivery:capability') return;
            if (
              frame.accepted !== false
              || frame.connectionEpoch !== probe.connectionEpoch
              || frame.reason !== 'client-withdrew'
            ) {
              fail('capability withdrawal response did not match the probe connection');
              return;
            }
            cleanup();
            probe.socket.close();
            resolve();
          };
          probe.socket.addEventListener('message', onMessage);
          probe.socket.addEventListener('error', onError);
          probe.socket.addEventListener('close', onClose);
          probe.socket.send(JSON.stringify({
            type: 'terminal-delivery:capability',
            protocolVersion: 1,
            enabled: false,
          }));
        });
        delete store[id];
      }, { id: probeId, storeKey: AC6_PROBE_STORE_KEY, timeoutMs: ACK_TIMEOUT_MS });
    },
  };
}
