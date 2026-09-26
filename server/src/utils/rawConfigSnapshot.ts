/**
 * The raw, pre-parse configuration object, kept from the moment it was loaded.
 *
 * OPS-BGSTAB-012 AC-1 needs to know which keys the deployment's file DECLARES, and the
 * parsed config cannot answer that: zod fills defaults in, and `realtime` is a
 * `defaultObject`, so a parsed config reports `realtime.wsTransportMode` as present for a
 * file that never mentioned it. Only the pre-parse object distinguishes the two.
 *
 * It is captured at load rather than re-read on demand so that declaration presence and
 * the running server describe the same configuration, not two readings taken at different
 * times that happen to sit in one artifact.
 *
 * @req OPS-BGSTAB-012 AC-1, AC-3
 */

let snapshot: unknown = {};
let capturedAt: string | null = null;

export function recordRawConfigSnapshot(rawConfig: unknown): void {
  snapshot = rawConfig;
  capturedAt = new Date().toISOString();
}

export function getRawConfigSnapshot(): unknown {
  return snapshot;
}

/** Null when no config load has happened, which makes an empty snapshot distinguishable. */
export function getRawConfigSnapshotCapturedAt(): string | null {
  return capturedAt;
}
