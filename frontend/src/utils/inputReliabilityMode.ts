import type { InputReliabilityMode } from '../types/ws-protocol';

const STORAGE_KEY = 'buildergate.inputReliabilityMode';
const SNAPSHOT_REMOVAL_KEY_PREFIX = 'terminal_snapshot_remove_';
const VALID_MODES = new Set<InputReliabilityMode>(['observe', 'queue', 'strict']);
const VALID_WS_TRANSPORT_MODES = new Set<WsTransportMode>(['unified', 'split-shadow', 'split']);

export type WsTransportMode = 'unified' | 'split-shadow' | 'split';
export type FrontendRuntimeResidencyMode = 'legacy' | 'bounded' | 'off';
export type HiddenOutputPolicy = 'write-hidden' | 'snapshot-restore' | 'debug-tail';

export interface ClientWsResourceLimitsRuntimeConfig {
  inputBackpressureBytes: number;
  hardReconnectBytes: number;
}

export interface TerminalResourceLimitsRuntimeConfig {
  visibleOutputQueueMaxBytes: number;
  visibleOutputMaxChunks: number;
  visibleFlushBudgetBytes: number;
  hiddenOutputPolicy: HiddenOutputPolicy;
  hiddenOutputTailBytes: number;
  inputQueueMaxBytes: number;
  inputQueueTtlMs: number;
  transportOutboxMaxBytes: number;
  transportOutboxTtlMs: number;
  scrollbackLines: number;
}

export interface SnapshotResourceLimitsRuntimeConfig {
  perSnapshotMaxChars: number;
  totalStorageBudgetChars: number;
  maxEntries: number;
  tombstoneTtlMs: number;
}

export interface WorkspaceRuntimeResourceLimitsRuntimeConfig {
  maxLiveWorkspaces: number;
  maxLiveTerminals: number;
  hiddenRuntimeTtlMs: number;
}

interface BrowserResourceLimitsRuntimeConfig {
  clientWs: ClientWsResourceLimitsRuntimeConfig;
  terminal: TerminalResourceLimitsRuntimeConfig;
  snapshots: SnapshotResourceLimitsRuntimeConfig;
  workspaceRuntime: WorkspaceRuntimeResourceLimitsRuntimeConfig;
}

interface RuntimeConfigPayload {
  inputReliabilityMode?: unknown;
  wsTransportMode?: unknown;
  stabilityModes?: {
    frontendRuntimeResidency?: unknown;
  };
  resourceLimits?: {
    clientWs?: unknown;
    terminal?: unknown;
    snapshots?: unknown;
    workspaceRuntime?: unknown;
  };
}

const DEFAULT_CLIENT_WS_LIMITS: ClientWsResourceLimitsRuntimeConfig = {
  inputBackpressureBytes: 1_048_576,
  hardReconnectBytes: 4_194_304,
};

const DEFAULT_TERMINAL_LIMITS: TerminalResourceLimitsRuntimeConfig = {
  visibleOutputQueueMaxBytes: 4_194_304,
  visibleOutputMaxChunks: 512,
  visibleFlushBudgetBytes: 262_144,
  hiddenOutputPolicy: 'snapshot-restore',
  hiddenOutputTailBytes: 262_144,
  inputQueueMaxBytes: 65_536,
  inputQueueTtlMs: 1500,
  transportOutboxMaxBytes: 65_536,
  transportOutboxTtlMs: 1500,
  scrollbackLines: 10_000,
};

const DEFAULT_SNAPSHOT_LIMITS: SnapshotResourceLimitsRuntimeConfig = {
  perSnapshotMaxChars: 2_000_000,
  totalStorageBudgetChars: 3_000_000,
  maxEntries: 16,
  tombstoneTtlMs: 86_400_000,
};

const DEFAULT_WORKSPACE_RUNTIME_LIMITS: WorkspaceRuntimeResourceLimitsRuntimeConfig = {
  maxLiveWorkspaces: 10,
  maxLiveTerminals: 32,
  hiddenRuntimeTtlMs: 600_000,
};

let runtimeMode: InputReliabilityMode = 'observe';
let runtimeModeLoaded = false;
let runtimeConfigVersion = 0;
let wsTransportMode: WsTransportMode = 'unified';
let frontendRuntimeResidency: FrontendRuntimeResidencyMode = 'bounded';
let resourceLimits: BrowserResourceLimitsRuntimeConfig = createDefaultResourceLimits();
const runtimeConfigSubscribers = new Set<() => void>();

export function getInputReliabilityMode(): InputReliabilityMode {
  return getLocalOverride() ?? runtimeMode;
}

export async function initializeInputReliabilityMode(): Promise<InputReliabilityMode> {
  try {
    const response = await fetch('/api/runtime-config', { cache: 'no-store' });
    if (!response.ok) {
      console.warn(`[RuntimeConfig] Failed to load input reliability mode: HTTP ${response.status}`);
      return getInputReliabilityMode();
    }

    const payload = await response.json() as RuntimeConfigPayload;
    const mode = parseInputReliabilityMode(payload.inputReliabilityMode);
    if (!mode) {
      console.warn('[RuntimeConfig] Server returned an unsupported inputReliabilityMode. Falling back to observe.');
      runtimeMode = 'observe';
    } else {
      runtimeMode = mode;
    }

    wsTransportMode = parseWsTransportMode(payload.wsTransportMode);
    frontendRuntimeResidency = parseFrontendRuntimeResidency(payload.stabilityModes?.frontendRuntimeResidency);
    resourceLimits = parseResourceLimits(payload.resourceLimits);
    cleanupTerminalSnapshotTombstonesFromRuntimeConfig();
    runtimeModeLoaded = true;
    publishRuntimeConfigChange();
  } catch (error) {
    console.warn('[RuntimeConfig] Failed to initialize input reliability mode:', error);
  }

  return getInputReliabilityMode();
}

export async function reloadRuntimeConfig(): Promise<InputReliabilityMode> {
  return initializeInputReliabilityMode();
}

export function setLocalInputReliabilityModeForTest(mode: InputReliabilityMode | null): InputReliabilityMode {
  if (!isLocalDebugHost()) {
    console.warn('[RuntimeConfig] Local input reliability mode override is allowed only on localhost.');
    return getInputReliabilityMode();
  }

  if (mode === null) {
    localStorage.removeItem(STORAGE_KEY);
    return getInputReliabilityMode();
  }

  localStorage.setItem(STORAGE_KEY, mode);
  return getInputReliabilityMode();
}

export function isInputReliabilityModeLoaded(): boolean {
  return runtimeModeLoaded;
}

export function getRuntimeConfigVersion(): number {
  return runtimeConfigVersion;
}

export function subscribeRuntimeConfigChanges(callback: () => void): () => void {
  runtimeConfigSubscribers.add(callback);
  return () => {
    runtimeConfigSubscribers.delete(callback);
  };
}

export function getWsTransportMode(): WsTransportMode {
  return wsTransportMode;
}

export function getFrontendRuntimeResidencyMode(): FrontendRuntimeResidencyMode {
  return frontendRuntimeResidency;
}

export function getClientWsResourceLimits(): ClientWsResourceLimitsRuntimeConfig {
  return { ...resourceLimits.clientWs };
}

export function getTerminalResourceLimits(): TerminalResourceLimitsRuntimeConfig {
  return { ...resourceLimits.terminal };
}

export function getSnapshotResourceLimits(): SnapshotResourceLimitsRuntimeConfig {
  return { ...resourceLimits.snapshots };
}

export function getWorkspaceRuntimeResourceLimits(): WorkspaceRuntimeResourceLimitsRuntimeConfig {
  return { ...resourceLimits.workspaceRuntime };
}

function publishRuntimeConfigChange(): void {
  runtimeConfigVersion += 1;
  for (const callback of runtimeConfigSubscribers) {
    callback();
  }
}

function cleanupTerminalSnapshotTombstonesFromRuntimeConfig(): void {
  if (typeof localStorage === 'undefined') {
    return;
  }

  try {
    const nowMs = Date.now();
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith(SNAPSHOT_REMOVAL_KEY_PREFIX)) {
        continue;
      }

      const raw = localStorage.getItem(key);
      let savedAtMs = 0;
      try {
        const parsed = JSON.parse(raw ?? '') as { savedAt?: unknown };
        savedAtMs = typeof parsed.savedAt === 'string' ? Date.parse(parsed.savedAt) : 0;
      } catch {
        savedAtMs = 0;
      }

      if (!Number.isFinite(savedAtMs) || savedAtMs <= 0 || nowMs - savedAtMs > resourceLimits.snapshots.tombstoneTtlMs) {
        localStorage.removeItem(key);
      }
    }
  } catch {
    // Runtime config reload should not fail because best-effort local cache cleanup failed.
  }
}

function createDefaultResourceLimits(): BrowserResourceLimitsRuntimeConfig {
  return {
    clientWs: { ...DEFAULT_CLIENT_WS_LIMITS },
    terminal: { ...DEFAULT_TERMINAL_LIMITS },
    snapshots: { ...DEFAULT_SNAPSHOT_LIMITS },
    workspaceRuntime: { ...DEFAULT_WORKSPACE_RUNTIME_LIMITS },
  };
}

function parseResourceLimits(value: unknown): BrowserResourceLimitsRuntimeConfig {
  const source = isPlainObject(value) ? value : {};
  return {
    clientWs: parseClientWsLimits(source.clientWs),
    terminal: parseTerminalLimits(source.terminal),
    snapshots: parseSnapshotLimits(source.snapshots),
    workspaceRuntime: parseWorkspaceRuntimeLimits(source.workspaceRuntime),
  };
}

function parseClientWsLimits(value: unknown): ClientWsResourceLimitsRuntimeConfig {
  const parsed = parseIntegerFields(value, DEFAULT_CLIENT_WS_LIMITS, {
    inputBackpressureBytes: [1024, 268_435_456],
    hardReconnectBytes: [1024, 536_870_912],
  });
  if (!parsed || parsed.hardReconnectBytes <= parsed.inputBackpressureBytes) {
    return { ...DEFAULT_CLIENT_WS_LIMITS };
  }
  return parsed;
}

function parseTerminalLimits(value: unknown): TerminalResourceLimitsRuntimeConfig {
  if (!isPlainObject(value)) {
    return { ...DEFAULT_TERMINAL_LIMITS };
  }

  const parsedNumbers = parseIntegerFields(value, {
    visibleOutputQueueMaxBytes: DEFAULT_TERMINAL_LIMITS.visibleOutputQueueMaxBytes,
    visibleOutputMaxChunks: DEFAULT_TERMINAL_LIMITS.visibleOutputMaxChunks,
    visibleFlushBudgetBytes: DEFAULT_TERMINAL_LIMITS.visibleFlushBudgetBytes,
    hiddenOutputTailBytes: DEFAULT_TERMINAL_LIMITS.hiddenOutputTailBytes,
    inputQueueMaxBytes: DEFAULT_TERMINAL_LIMITS.inputQueueMaxBytes,
    inputQueueTtlMs: DEFAULT_TERMINAL_LIMITS.inputQueueTtlMs,
    transportOutboxMaxBytes: DEFAULT_TERMINAL_LIMITS.transportOutboxMaxBytes,
    transportOutboxTtlMs: DEFAULT_TERMINAL_LIMITS.transportOutboxTtlMs,
    scrollbackLines: DEFAULT_TERMINAL_LIMITS.scrollbackLines,
  }, {
    visibleOutputQueueMaxBytes: [1024, 268_435_456],
    visibleOutputMaxChunks: [1, 65_536],
    visibleFlushBudgetBytes: [1024, 16_777_216],
    hiddenOutputTailBytes: [0, 16_777_216],
    inputQueueMaxBytes: [1024, 16_777_216],
    inputQueueTtlMs: [1, 60_000],
    transportOutboxMaxBytes: [1024, 16_777_216],
    transportOutboxTtlMs: [1, 60_000],
    scrollbackLines: [0, 50_000],
  });
  if (!parsedNumbers) {
    return { ...DEFAULT_TERMINAL_LIMITS };
  }

  const hiddenOutputPolicy = value.hiddenOutputPolicy === undefined
    ? DEFAULT_TERMINAL_LIMITS.hiddenOutputPolicy
    : parseHiddenOutputPolicy(value.hiddenOutputPolicy);
  if (!hiddenOutputPolicy) {
    return { ...DEFAULT_TERMINAL_LIMITS };
  }

  return {
    ...parsedNumbers,
    hiddenOutputPolicy,
  };
}

function parseSnapshotLimits(value: unknown): SnapshotResourceLimitsRuntimeConfig {
  const parsed = parseIntegerFields(value, DEFAULT_SNAPSHOT_LIMITS, {
    perSnapshotMaxChars: [1024, 50_000_000],
    totalStorageBudgetChars: [1024, 200_000_000],
    maxEntries: [1, 1024],
    tombstoneTtlMs: [1000, 604_800_000],
  });
  if (!parsed || parsed.totalStorageBudgetChars < parsed.perSnapshotMaxChars) {
    return { ...DEFAULT_SNAPSHOT_LIMITS };
  }
  return parsed;
}

function parseWorkspaceRuntimeLimits(value: unknown): WorkspaceRuntimeResourceLimitsRuntimeConfig {
  return parseIntegerFields(value, DEFAULT_WORKSPACE_RUNTIME_LIMITS, {
    maxLiveWorkspaces: [1, 10],
    maxLiveTerminals: [1, 128],
    hiddenRuntimeTtlMs: [1000, 3_600_000],
  }) ?? { ...DEFAULT_WORKSPACE_RUNTIME_LIMITS };
}

function parseIntegerFields<T extends { [K in keyof T]: number }>(
  value: unknown,
  defaults: T,
  ranges: { [K in keyof T]: [number, number] },
): T | null {
  if (!isPlainObject(value)) {
    return { ...defaults };
  }

  const next = { ...defaults };
  for (const key of Object.keys(ranges) as Array<keyof T>) {
    if (!(key in value)) {
      continue;
    }

    const parsed = parseInteger(value[String(key)], ranges[key][0], ranges[key][1]);
    if (parsed === null) {
      return null;
    }
    next[key] = parsed as T[keyof T];
  }

  return next;
}

function parseInteger(value: unknown, min: number, max: number): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    return null;
  }
  return value;
}

function getLocalOverride(): InputReliabilityMode | null {
  if (typeof window === 'undefined' || !isLocalDebugHost()) {
    return null;
  }

  const stored = localStorage.getItem(STORAGE_KEY);
  const mode = parseInputReliabilityMode(stored);
  if (stored && !mode) {
    console.warn(`[RuntimeConfig] Ignoring unsupported local input reliability mode override: ${stored}`);
  }
  return mode;
}

function parseInputReliabilityMode(value: unknown): InputReliabilityMode | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return VALID_MODES.has(normalized as InputReliabilityMode)
    ? normalized as InputReliabilityMode
    : null;
}

function parseWsTransportMode(value: unknown): WsTransportMode {
  if (typeof value !== 'string') {
    return 'unified';
  }

  const normalized = value.trim().toLowerCase();
  return VALID_WS_TRANSPORT_MODES.has(normalized as WsTransportMode)
    ? normalized as WsTransportMode
    : 'unified';
}

function parseHiddenOutputPolicy(value: unknown): HiddenOutputPolicy | null {
  return value === 'write-hidden' || value === 'snapshot-restore' || value === 'debug-tail' ? value : null;
}

function parseFrontendRuntimeResidency(value: unknown): FrontendRuntimeResidencyMode {
  if (value === 'legacy' || value === 'off') {
    return value;
  }
  return 'bounded';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLocalDebugHost(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  return window.location.hostname === 'localhost'
    || window.location.hostname === '127.0.0.1'
    || window.location.hostname === '::1'
    || window.location.hostname === '[::1]';
}
