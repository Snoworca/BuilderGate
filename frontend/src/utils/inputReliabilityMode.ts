import type { InputReliabilityMode } from '../types/ws-protocol';

const STORAGE_KEY = 'buildergate.inputReliabilityMode';
const VALID_MODES = new Set<InputReliabilityMode>(['observe', 'queue', 'strict']);

let runtimeMode: InputReliabilityMode = 'observe';
let runtimeModeLoaded = false;

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

    const payload = await response.json() as { inputReliabilityMode?: unknown };
    const mode = parseInputReliabilityMode(payload.inputReliabilityMode);
    if (!mode) {
      console.warn('[RuntimeConfig] Server returned an unsupported inputReliabilityMode. Falling back to observe.');
      runtimeMode = 'observe';
    } else {
      runtimeMode = mode;
    }
    runtimeModeLoaded = true;
  } catch (error) {
    console.warn('[RuntimeConfig] Failed to initialize input reliability mode:', error);
  }

  return getInputReliabilityMode();
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

function isLocalDebugHost(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  return window.location.hostname === 'localhost'
    || window.location.hostname === '127.0.0.1'
    || window.location.hostname === '::1'
    || window.location.hostname === '[::1]';
}
