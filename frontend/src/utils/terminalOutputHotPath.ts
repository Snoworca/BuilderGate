import {
  getRuntimeConfigVersion,
  getTerminalResourceLimits,
  type TerminalResourceLimitsRuntimeConfig,
} from './inputReliabilityMode.ts';

const outputTextEncoder = new TextEncoder();
let cachedTerminalLimitsVersion = -1;
let cachedTerminalLimits: TerminalResourceLimitsRuntimeConfig | null = null;

export function getOutputUtf8ByteLength(raw: string): number {
  return outputTextEncoder.encode(raw).length;
}

export function getCachedTerminalOutputResourceLimits(): TerminalResourceLimitsRuntimeConfig {
  const version = getRuntimeConfigVersion();
  if (cachedTerminalLimits && cachedTerminalLimitsVersion === version) {
    return cachedTerminalLimits;
  }
  cachedTerminalLimits = getTerminalResourceLimits();
  cachedTerminalLimitsVersion = version;
  return cachedTerminalLimits;
}

export function resetTerminalOutputHotPathCacheForTest(): void {
  cachedTerminalLimits = null;
  cachedTerminalLimitsVersion = -1;
}

export function getTerminalOutputTextEncoderForTest(): TextEncoder {
  return outputTextEncoder;
}
