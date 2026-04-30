import { tokenStorage } from '../services/tokenStorage';
import type {
  InputDebugMetadata,
  InputReliabilityMode,
  TerminalInputTransportOverride,
} from '../types/ws-protocol';
import {
  getInputReliabilityMode,
  isInputReliabilityModeLoaded,
  setLocalInputReliabilityModeForTest,
} from './inputReliabilityMode';

export type TerminalDebugValue = string | number | boolean | null;

export interface TerminalDebugInputPayload {
  details: Record<string, TerminalDebugValue>;
  preview?: string;
}

export interface TerminalInputCaptureState {
  inputReady: boolean;
  transportReady: boolean;
  captureAllowed: boolean;
  captureState: 'open' | 'transient-blocked' | 'closed';
  barrierReason: string;
  closedReason: string;
  serverReady: boolean;
  geometryReady: boolean;
  restorePending: boolean;
  visible: boolean;
  helperDisabled: boolean;
  helperReadOnly: boolean;
  isComposing: boolean;
  imeState?: string;
  compositionSeq?: number | null;
  activeElementIsHelper: boolean;
}

export interface TerminalClientDebugEvent {
  eventId: number;
  recordedAt: string;
  sessionId: string;
  kind: string;
  details?: Record<string, TerminalDebugValue>;
  preview?: string;
}

export type DebugWebSocketSendFailureReason = 'not-open' | 'missing-token' | 'stale-socket';

export interface DebugWebSocketSendFailureOverride {
  reason: DebugWebSocketSendFailureReason;
  count?: number;
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
  getInputReliabilityMode: () => InputReliabilityMode;
  setInputReliabilityMode: (mode: InputReliabilityMode | null) => InputReliabilityMode;
  setInputTransportOverride: (sessionId: string, override: TerminalInputTransportOverride | null) => boolean;
  setNextWebSocketInputSendFailure: (override: DebugWebSocketSendFailureOverride | null) => boolean;
  requestRepairLayout: (sessionId: string, reason?: string) => Promise<boolean>;
  inputTransportOverrideHandlers: Map<string, (override: TerminalInputTransportOverride | null) => void>;
  webSocketSendFailureHandlers: Set<(override: DebugWebSocketSendFailureOverride | null) => void>;
  repairLayoutHandlers: Map<string, (reason: string) => Promise<boolean>>;
}

declare global {
  interface Window {
    __buildergateTerminalDebug?: TerminalDebugStore;
  }
}

const MAX_CLIENT_DEBUG_EVENTS = 400;
const DEBUG_PREVIEW_CHARS = 320;
const HANGUL_RE = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/u;
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;
const CONTROL_NAV_KEYS = new Set([
  'Enter',
  'Backspace',
  'Tab',
  'Escape',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Delete',
  'Insert',
]);
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
            inputReliabilityMode: getInputReliabilityMode(),
            inputReliabilityModeLoaded: isInputReliabilityModeLoaded(),
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
      getInputReliabilityMode() {
        return getInputReliabilityMode();
      },
      setInputReliabilityMode(mode: InputReliabilityMode | null) {
        return setLocalInputReliabilityModeForTest(mode);
      },
      setInputTransportOverride(sessionId: string, override: TerminalInputTransportOverride | null) {
        if (!isLocalTestHost()) {
          return false;
        }
        const handler = this.inputTransportOverrideHandlers.get(sessionId);
        if (!handler) {
          return false;
        }
        handler(override);
        return true;
      },
      setNextWebSocketInputSendFailure(override: DebugWebSocketSendFailureOverride | null) {
        if (!isLocalTestHost()) {
          return false;
        }
        for (const handler of this.webSocketSendFailureHandlers) {
          handler(override);
        }
        return true;
      },
      async requestRepairLayout(sessionId: string, reason = 'debug-repair-layout') {
        if (!isLocalTestHost()) {
          return false;
        }
        const handler = this.repairLayoutHandlers.get(sessionId);
        if (!handler) {
          return false;
        }
        return await handler(reason);
      },
      inputTransportOverrideHandlers: new Map<string, (override: TerminalInputTransportOverride | null) => void>(),
      webSocketSendFailureHandlers: new Set<(override: DebugWebSocketSendFailureOverride | null) => void>(),
      repairLayoutHandlers: new Map<string, (reason: string) => Promise<boolean>>(),
    };
  }

  return window.__buildergateTerminalDebug;
}

export function registerInputTransportOverrideHandler(
  sessionId: string,
  handler: (override: TerminalInputTransportOverride | null) => void,
): () => void {
  const store = getStore();
  if (!store) {
    return () => {};
  }

  store.inputTransportOverrideHandlers.set(sessionId, handler);
  return () => {
    const current = store.inputTransportOverrideHandlers.get(sessionId);
    if (current === handler) {
      store.inputTransportOverrideHandlers.delete(sessionId);
    }
  };
}

export function registerWebSocketSendFailureHandler(
  handler: (override: DebugWebSocketSendFailureOverride | null) => void,
): () => void {
  const store = getStore();
  if (!store) {
    return () => {};
  }

  store.webSocketSendFailureHandlers.add(handler);
  return () => {
    store.webSocketSendFailureHandlers.delete(handler);
  };
}

export function registerTerminalRepairLayoutHandler(
  sessionId: string,
  handler: (reason: string) => Promise<boolean>,
): () => void {
  const store = getStore();
  if (!store) {
    return () => {};
  }

  store.repairLayoutHandlers.set(sessionId, handler);
  return () => {
    const current = store.repairLayoutHandlers.get(sessionId);
    if (current === handler) {
      store.repairLayoutHandlers.delete(sessionId);
    }
  };
}

export function isTerminalDebugCaptureEnabled(sessionId: string): boolean {
  const store = getStore();
  return Boolean(store?.isEnabled(sessionId));
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
    details: {
      inputReliabilityMode: getInputReliabilityMode(),
      ...(details ?? {}),
    },
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

export function buildTerminalInputDebugPayload(
  raw: string,
  metadata: Pick<InputDebugMetadata, 'captureSeq' | 'compositionSeq'> = {},
): TerminalDebugInputPayload {
  const safePreview = formatSafeInputPreview(raw);
  const spaceCount = (raw.match(/ /g) ?? []).length;
  const backspaceCount = (raw.match(/\x7f/g) ?? []).length;
  const enterCount = (raw.match(/[\r\n]/g) ?? []).length;
  const escapeCount = (raw.match(/\x1b/g) ?? []).length;
  const controlCount = (raw.match(/[\x00-\x1f\x7f]/g) ?? []).length;
  const codePointCount = Array.from(raw).length;
  const printableCount = Math.max(0, codePointCount - controlCount);
  const grapheme = countGraphemes(raw);
  const details: Record<string, TerminalDebugValue> = {
    ...buildSequenceDetails(metadata),
    byteLength: utf8ByteLength(raw),
    codePointCount,
    graphemeCount: grapheme.count,
    graphemeApproximate: grapheme.approximate,
    hasHangul: HANGUL_RE.test(raw),
    hasCjk: CJK_RE.test(raw),
    hasEnter: enterCount > 0,
    spaceCount,
    backspaceCount,
    enterCount,
    escapeCount,
    controlCount,
    printableCount,
    inputClass: classifyInput(safePreview !== undefined, controlCount, printableCount),
    containsPrintable: printableCount > 0,
    safePreview: safePreview !== undefined,
  };

  return safePreview === undefined
    ? { details }
    : { details, preview: safePreview };
}

export function buildClientInputDebugMetadata(
  details: Record<string, TerminalDebugValue>,
): InputDebugMetadata {
  const metadata: InputDebugMetadata = {};
  copySafeNumber(details.captureSeq, (value) => { metadata.captureSeq = value; });
  copySafeNumber(details.compositionSeq, (value) => { metadata.compositionSeq = value; });
  copySafeNumber(details.byteLength, (value) => { metadata.clientObservedByteLength = value; });
  copySafeNumber(details.codePointCount, (value) => { metadata.clientObservedCodePointCount = value; });
  copySafeNumber(details.graphemeCount, (value) => { metadata.clientObservedGraphemeCount = value; });
  copyBoolean(details.graphemeApproximate, (value) => { metadata.clientObservedGraphemeApproximate = value; });
  copyBoolean(details.hasHangul, (value) => { metadata.clientObservedHasHangul = value; });
  copyBoolean(details.hasCjk, (value) => { metadata.clientObservedHasCjk = value; });
  copyBoolean(details.hasEnter, (value) => { metadata.clientObservedHasEnter = value; });
  return metadata;
}

export function shouldRecordTerminalInputDebug(_payload: TerminalDebugInputPayload): boolean {
  return true;
}

export function buildTerminalEventTapeDetails(
  event: KeyboardEvent | InputEvent | CompositionEvent,
  sequence: { captureSeq?: number; compositionSeq?: number },
  state: TerminalInputCaptureState,
): Record<string, TerminalDebugValue> {
  const details: Record<string, TerminalDebugValue> = {
    ...buildSequenceDetails(sequence),
    eventType: event.type,
    inputReady: state.inputReady,
    transportReady: state.transportReady,
    captureAllowed: state.captureAllowed,
    captureState: state.captureState,
    barrierReason: state.barrierReason,
    closedReason: state.closedReason,
    serverReady: state.serverReady,
    geometryReady: state.geometryReady,
    restorePending: state.restorePending,
    visible: state.visible,
    helperDisabled: state.helperDisabled,
    helperReadOnly: state.helperReadOnly,
    isComposingRef: state.isComposing,
    imeState: state.imeState ?? null,
    activeCompositionSeq: state.compositionSeq ?? null,
    activeElementIsHelper: state.activeElementIsHelper,
  };

  if (event instanceof KeyboardEvent) {
    addKeyboardEventDetails(details, event);
    return details;
  }

  if (event instanceof InputEvent) {
    details.inputType = event.inputType;
    addEventDataDetails(details, event.data ?? '');
    return details;
  }

  addEventDataDetails(details, event.data ?? '');
  return details;
}

function addKeyboardEventDetails(details: Record<string, TerminalDebugValue>, event: KeyboardEvent): void {
  const safeKeyName = getSafeKeyName(event.key);
  if (safeKeyName) {
    details.safeKeyName = safeKeyName;
  }
  if (event.keyCode === 229) {
    details.keyCode = 229;
  }

  details.keyCategory = classifyKey(event.key, safeKeyName);
  if (!safeKeyName && event.key.length > 0) {
    details.keyUtf8ByteLength = utf8ByteLength(event.key);
    details.keyHasHangul = HANGUL_RE.test(event.key);
    details.keyHasCjk = CJK_RE.test(event.key);
  }
}

function addEventDataDetails(details: Record<string, TerminalDebugValue>, data: string): void {
  details.dataLength = Array.from(data).length;
  details.dataByteLength = utf8ByteLength(data);
  details.hasHangul = HANGUL_RE.test(data);
  details.hasCjk = CJK_RE.test(data);
}

function getSafeKeyName(key: string): string | null {
  return CONTROL_NAV_KEYS.has(key) ? key : null;
}

function classifyKey(key: string, safeKeyName: string | null): string {
  if (safeKeyName) {
    return 'control-navigation';
  }
  if (key === ' ' || key === 'Spacebar') {
    return 'space';
  }
  if (key.length === 1) {
    return 'printable';
  }
  return 'other';
}

function classifyInput(hasSafePreview: boolean, controlCount: number, printableCount: number): string {
  if (hasSafePreview) {
    return 'safe-control';
  }
  if (controlCount > 0 && printableCount > 0) {
    return 'mixed-printable-control';
  }
  if (controlCount > 0) {
    return 'control';
  }
  return 'printable';
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

function buildSequenceDetails(
  metadata: Pick<InputDebugMetadata, 'captureSeq' | 'compositionSeq'>,
): Record<string, TerminalDebugValue> {
  const details: Record<string, TerminalDebugValue> = {};
  if (typeof metadata.captureSeq === 'number' && Number.isSafeInteger(metadata.captureSeq)) {
    details.captureSeq = metadata.captureSeq;
  }
  if (typeof metadata.compositionSeq === 'number' && Number.isSafeInteger(metadata.compositionSeq)) {
    details.compositionSeq = metadata.compositionSeq;
  }
  return details;
}

function utf8ByteLength(raw: string): number {
  return new TextEncoder().encode(raw).length;
}

function countGraphemes(raw: string): { count: number; approximate: boolean } {
  const segmenterCtor = (Intl as unknown as {
    Segmenter?: new (
      locale?: string,
      options?: { granularity?: 'grapheme' },
    ) => { segment(input: string): Iterable<unknown> };
  }).Segmenter;

  if (!segmenterCtor) {
    return { count: Array.from(raw).length, approximate: true };
  }

  const segmenter = new segmenterCtor(undefined, { granularity: 'grapheme' });
  return { count: Array.from(segmenter.segment(raw)).length, approximate: false };
}

function copySafeNumber(value: TerminalDebugValue | undefined, assign: (value: number) => void): void {
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    assign(value);
  }
}

function copyBoolean(value: TerminalDebugValue | undefined, assign: (value: boolean) => void): void {
  if (typeof value === 'boolean') {
    assign(value);
  }
}

function isLocalTestHost(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  return ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname);
}

function pushDebugEvent(store: TerminalDebugStore, event: TerminalClientDebugEvent): void {
  store.events.push(event);
  if (store.events.length > MAX_CLIENT_DEBUG_EVENTS) {
    store.events.splice(0, store.events.length - MAX_CLIENT_DEBUG_EVENTS);
  }
}

getStore();
