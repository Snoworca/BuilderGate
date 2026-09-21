import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { TerminalWireFormat } from './terminalWireFormat.js';

/**
 * Resolves the data-plane default from the published evidence (MIG-BGSTAB-004).
 *
 * The default is not a constant because the requirement does not let it be one:
 * AC-1 makes the binary default valid only while the binary-generation artifact
 * is accepted, and fail-closed otherwise. Encoding that as `.default('binary')`
 * in the schema would flip the default on a deployment whose artifact is
 * missing, truncated or tampered with — which is the state the gate exists for.
 *
 * The gate is substantive rather than ceremonial. `smallOutputBypassBytes`
 * classifies a delivery by its wire `byteLength`, and the same body measures
 * 10356 bytes as a JSON envelope against 6599 as a binary frame (2026-09-21, one
 * TUI redraw). A payload can sit above the bypass threshold under one codec and
 * below it under the other, so the scheduler's registered thresholds have to be
 * re-measured under the codec that is actually going to run.
 */

const JSON_DEFAULT: TerminalWireFormat = 'json';
const BINARY_DEFAULT: TerminalWireFormat = 'binary';

function readBoolean(source: Record<string, unknown>, key: string): boolean | undefined {
  try {
    const value = source[key];
    return typeof value === 'boolean' ? value : undefined;
  } catch {
    // The artifact is a file someone else wrote. A getter that throws is a
    // tampered artifact, which is exactly a fail-closed case.
    return undefined;
  }
}

function readWorkloadCodec(artifact: Record<string, unknown>): string | undefined {
  try {
    const workload = artifact.workload;
    if (typeof workload !== 'object' || workload === null) return undefined;
    const codec = (workload as Record<string, unknown>).codec;
    return typeof codec === 'string' ? codec : undefined;
  } catch {
    return undefined;
  }
}

export interface TerminalWireFormatDefaultInput {
  /** The published decision artifact, however it was loaded. */
  readonly artifact?: unknown;
  /** `realtime.terminalWireFormat` when the operator set one. */
  readonly configured?: TerminalWireFormat;
}

export function resolveDefaultTerminalWireFormat(
  input: TerminalWireFormatDefaultInput,
): TerminalWireFormat {
  // AC-2: rollback is "put json in the config file", so a configured value is
  // never overridden — in either direction.
  if (input.configured !== undefined) return input.configured;

  const artifact = input.artifact;
  if (typeof artifact !== 'object' || artifact === null || Array.isArray(artifact)) {
    return JSON_DEFAULT;
  }
  const record = artifact as Record<string, unknown>;

  if (readWorkloadCodec(record) !== 'binary') return JSON_DEFAULT;
  if (readBoolean(record, 'accepted') !== true) return JSON_DEFAULT;
  if (readBoolean(record, 'allRegisteredThresholdsPassed') !== true) return JSON_DEFAULT;
  // Absent is not false: an artifact that never recorded the check has not
  // passed it (PERF-BGSTAB-011 AC-6).
  if (readBoolean(record, 'hasUnboundedEligibleLaneStarvation') !== false) return JSON_DEFAULT;

  return BINARY_DEFAULT;
}

/**
 * Reads the decision artifact the build shipped, or nothing.
 *
 * Everything here degrades to `undefined` rather than throwing. The artifact is
 * a file on disk that a packaging mistake can truncate, and a server that
 * refuses to boot is a worse outcome than a server on json — which is what
 * `resolveDefaultTerminalWireFormat` answers when this returns nothing.
 */
export function loadPublishedDecisionArtifact(evidenceRoot?: string): unknown {
  try {
    const root = evidenceRoot ?? resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../benchmarks/fair-scheduler-evidence',
    );
    const pointerPath = resolve(root, 'current.json');
    if (!existsSync(pointerPath)) return undefined;
    const pointer: unknown = JSON.parse(readFileSync(pointerPath, 'utf8'));
    if (typeof pointer !== 'object' || pointer === null) return undefined;
    const generationId = (pointer as Record<string, unknown>).generation_id;
    if (typeof generationId !== 'string' || generationId.length === 0) return undefined;
    // Containment: the id comes from a file, so it must not be able to walk out
    // of the evidence root.
    const generationRoot = resolve(root, 'generations', generationId);
    if (!generationRoot.startsWith(resolve(root, 'generations'))) return undefined;
    const artifactPath = resolve(generationRoot, 'fair-scheduler-decision.json');
    if (!existsSync(artifactPath)) return undefined;
    return JSON.parse(readFileSync(artifactPath, 'utf8'));
  } catch {
    return undefined;
  }
}

let cached: TerminalWireFormat | undefined;

/**
 * The resolved data-plane default for this build (MIG-BGSTAB-004 AC-1).
 *
 * Memoised because the artifact cannot change without a redeploy, and because a
 * per-connection file read on the hot path would be a cost paid to re-answer a
 * question whose inputs are frozen.
 */
export function getDefaultTerminalWireFormat(): TerminalWireFormat {
  cached ??= resolveDefaultTerminalWireFormat({ artifact: loadPublishedDecisionArtifact() });
  return cached;
}

/** Test seam: forgets the memoised answer. */
export function resetDefaultTerminalWireFormatCache(): void {
  cached = undefined;
}
