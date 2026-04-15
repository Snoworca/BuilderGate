import { tokenStorage } from '../services/tokenStorage';

type TerminalDebugValue = string | number | boolean | null;

export interface TerminalClientDebugEvent {
  eventId: number;
  recordedAt: string;
  sessionId: string;
  kind: string;
  details?: Record<string, TerminalDebugValue>;
  preview?: string;
}

interface TerminalDebugStore {
  events: TerminalClientDebugEvent[];
  enabledAll: boolean;
  enabledSessions: Set<string>;
  enable: (sessionId?: string) => void;
  disable: (sessionId?: string) => void;
  isEnabled: (sessionId: string) => boolean;
  start: (sessionId: string) => Promise<void>;
  stop: (sessionId: string) => Promise<void>;
  getEvents: (sessionId?: string) => TerminalClientDebugEvent[];
  clear: (sessionId?: string) => void;
}

declare global {
  interface Window {
    __buildergateTerminalDebug?: TerminalDebugStore;
  }
}

const MAX_CLIENT_DEBUG_EVENTS = 400;
const DEBUG_PREVIEW_CHARS = 320;
let clientDebugEventCounter = 0;

function getStore(): TerminalDebugStore | null {
  if (typeof window === 'undefined') {
    return null;
  }

  if (!window.__buildergateTerminalDebug) {
    window.__buildergateTerminalDebug = {
      events: [],
      enabledAll: false,
      enabledSessions: new Set<string>(),
      enable(sessionId?: string) {
        if (!sessionId) {
          this.enabledAll = true;
          return;
        }
        this.enabledSessions.add(sessionId);
      },
      disable(sessionId?: string) {
        if (!sessionId) {
          this.enabledAll = false;
          this.enabledSessions.clear();
          return;
        }
        this.enabledSessions.delete(sessionId);
      },
      isEnabled(sessionId: string) {
        return this.enabledAll || this.enabledSessions.has(sessionId);
      },
      async start(sessionId: string) {
        await postDebugCaptureToggle(sessionId, 'POST');
        this.clear(sessionId);
        this.enable(sessionId);
      },
      async stop(sessionId: string) {
        await postDebugCaptureToggle(sessionId, 'DELETE');
        this.disable(sessionId);
        this.clear(sessionId);
      },
      getEvents(sessionId?: string) {
        if (!sessionId) {
          return [...this.events];
        }
        return this.events.filter((event) => event.sessionId === sessionId);
      },
      clear(sessionId?: string) {
        if (!sessionId) {
          this.events = [];
          return;
        }
        this.events = this.events.filter((event) => event.sessionId !== sessionId);
      },
    };
  }

  return window.__buildergateTerminalDebug;
}

export function recordTerminalDebugEvent(
  sessionId: string,
  kind: string,
  details?: Record<string, TerminalDebugValue>,
  rawPreview?: string,
): void {
  const store = getStore();
  if (!store || !store.isEnabled(sessionId)) {
    return;
  }

  const event: TerminalClientDebugEvent = {
    eventId: ++clientDebugEventCounter,
    recordedAt: new Date().toISOString(),
    sessionId,
    kind,
    details,
    preview: rawPreview ? formatPreview(rawPreview) : undefined,
  };

  store.events.push(event);
  if (store.events.length > MAX_CLIENT_DEBUG_EVENTS) {
    store.events.splice(0, store.events.length - MAX_CLIENT_DEBUG_EVENTS);
  }
}

async function postDebugCaptureToggle(sessionId: string, method: 'POST' | 'DELETE'): Promise<void> {
  const token = tokenStorage.getToken();
  const response = await fetch(
    method === 'POST'
      ? `/api/sessions/debug-capture/${encodeURIComponent(sessionId)}/enable`
      : `/api/sessions/debug-capture/${encodeURIComponent(sessionId)}`,
    {
      method,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    },
  );

  if (!response.ok) {
    throw new Error(`debug capture toggle failed: ${response.status}`);
  }
}

function formatPreview(raw: string): string {
  return raw
    .slice(0, DEBUG_PREVIEW_CHARS)
    .replace(/\x1b/g, '\\x1b')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t');
}

getStore();
