export type InputReliabilityMode = 'observe' | 'queue' | 'strict';

const ENV_KEY = 'BUILDERGATE_INPUT_RELIABILITY_MODE';
const VALID_MODES = new Set<InputReliabilityMode>(['observe', 'queue', 'strict']);

export function resolveInputReliabilityMode(
  value: string | undefined = process.env[ENV_KEY],
  warn: (message: string) => void = console.warn,
): InputReliabilityMode {
  const normalized = value?.trim().toLowerCase();
  // REL-BGSTAB-032: the default buffers input while the capture gate is transiently blocked
  // (queue). observe discards it, which under Codex's constant redraws lost nearly every key.
  if (!normalized) {
    return 'queue';
  }

  if (VALID_MODES.has(normalized as InputReliabilityMode)) {
    return normalized as InputReliabilityMode;
  }

  warn(`[Config] ${ENV_KEY}="${value}" is not supported. Falling back to inputReliabilityMode="queue".`);
  return 'queue';
}

export const inputReliabilityMode = resolveInputReliabilityMode();
