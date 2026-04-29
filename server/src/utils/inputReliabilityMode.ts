export type InputReliabilityMode = 'observe' | 'queue' | 'strict';

const ENV_KEY = 'BUILDERGATE_INPUT_RELIABILITY_MODE';
const VALID_MODES = new Set<InputReliabilityMode>(['observe', 'queue', 'strict']);

export function resolveInputReliabilityMode(
  value: string | undefined = process.env[ENV_KEY],
  warn: (message: string) => void = console.warn,
): InputReliabilityMode {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return 'observe';
  }

  if (VALID_MODES.has(normalized as InputReliabilityMode)) {
    return normalized as InputReliabilityMode;
  }

  warn(`[Config] ${ENV_KEY}="${value}" is not supported. Falling back to inputReliabilityMode="observe".`);
  return 'observe';
}

export const inputReliabilityMode = resolveInputReliabilityMode();
