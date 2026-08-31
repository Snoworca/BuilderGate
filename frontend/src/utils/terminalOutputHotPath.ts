import {
  getRuntimeConfigVersion,
  getTerminalResourceLimits,
  type TerminalResourceLimitsRuntimeConfig,
} from './inputReliabilityMode.ts';

const outputTextEncoder = new TextEncoder();
let cachedTerminalLimitsVersion = -1;
let cachedTerminalLimits: TerminalResourceLimitsRuntimeConfig | null = null;

/**
 * The union is spelled inline rather than imported as `TerminalOutputWriteData`
 * to keep this hot-path module free of a dependency on the scheduler.
 *
 * A byte view is already measured, so encoding it would be both wasteful and
 * wrong: `TextEncoder.encode` stringifies it, and `Uint8Array([200, 201])` —
 * 2 bytes — would be reported as the 7 bytes of `"200,201"`.
 */
export function getOutputUtf8ByteLength(raw: string | Uint8Array): number {
  return typeof raw === 'string' ? outputTextEncoder.encode(raw).length : raw.byteLength;
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
