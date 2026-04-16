import { tokenStorage } from '../services/tokenStorage';

type TerminalDebugValue = string | number | boolean | null;

interface TerminalDebugInputPayload {
  details: Record<string, TerminalDebugValue>;
  preview?: string;
}

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
        pushDebugEvent(this, {
          eventId: ++clientDebugEventCounter,
          recordedAt: new Date().toISOString(),
          sessionId,
          kind: 'capture_started',
          details: {
            enabledAll: this.enabledAll,
          },
        });
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

  pushDebugEvent(store, event);
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

export function buildTerminalInputDebugPayload(raw: string): TerminalDebugInputPayload {
  const byteLength = new TextEncoder().encode(raw).length;
  const spaceCount = (raw.match(/ /g) ?? []).length;
  const backspaceCount = (raw.match(/\x7f/g) ?? []).length;
  const enterCount = (raw.match(/[\r\n]/g) ?? []).length;
  const escapeCount = (raw.match(/\x1b/g) ?? []).length;
  const controlCount = (raw.match(/[\x00-\x1f\x7f]/g) ?? []).length;
  const printableCount = Math.max(0, raw.length - controlCount);
  const preview = formatSafeInputPreview(raw);

  if (preview === undefined) {
    return {
      details: {
        hasEnter: enterCount > 0,
        inputClass: controlCount > 0 ? 'mixed-printable-control' : 'printable',
        containsPrintable: printableCount > 0,
        safePreview: false,
      },
    };
  }

  return {
    details: {
      byteLength,
      hasEnter: enterCount > 0,
      spaceCount,
      backspaceCount,
      enterCount,
      escapeCount,
      controlCount,
      printableCount,
      safePreview: true,
    },
    preview,
  };
}

export function shouldRecordTerminalInputDebug(payload: TerminalDebugInputPayload): boolean {
  return payload.preview !== undefined || payload.details.hasEnter === true;
}

function formatSafeInputPreview(raw: string): string | undefined {
  if (!/^[\x00-\x20\x7f]*$/.test(raw)) {
    return undefined;
  }

  return raw
    .slice(0, DEBUG_PREVIEW_CHARS)
    .replace(/ /g, '␠')
    .replace(/\x7f/g, '\\x7f')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, (match) => `\\x${match.charCodeAt(0).toString(16).padStart(2, '0')}`)
    .replace(/\x1b/g, '\\x1b');
}

function pushDebugEvent(store: TerminalDebugStore, event: TerminalClientDebugEvent): void {
  store.events.push(event);
  if (store.events.length > MAX_CLIENT_DEBUG_EVENTS) {
    store.events.splice(0, store.events.length - MAX_CLIENT_DEBUG_EVENTS);
  }
}

getStore();
