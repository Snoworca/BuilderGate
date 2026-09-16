import { createHash } from 'node:crypto';

import type { HeadlessTerminalState, RetainedHeadlessBufferProjection } from '../utils/headlessTerminal.js';
import {
  createHeadlessTerminalState,
  disposeHeadlessTerminal,
  readRetainedHeadlessBufferMetrics,
  serializeHeadlessTerminal,
  serializeRetainedHeadlessCheckpoint,
  writeHeadlessTerminal,
} from '../utils/headlessTerminal.js';

/**
 * Deterministic reproduction of the refresh retained-state truncation that
 * issue #23 reports, plus the machine-readable firing boundary.
 *
 * The refresh path under characterization is the legacy viewport-only server
 * snapshot (`serializeHeadlessTerminal` with `VIEWPORT_ONLY_SERIALIZE_OPTIONS`),
 * which is what `SessionManager.getScreenSnapshot` and
 * `SessionManager.getAtomicRestoreSnapshot` hand a reattaching browser. The
 * authority comparison point is `serializeRetainedHeadlessCheckpoint`, which
 * projects the full retained model.
 *
 * This module characterizes current behaviour only. It sets no product retained
 * row count, no aggregate memory budget, no checkpoint chunk size, no
 * checkpoint in-flight budget and no recovery SLO.
 */

export const REFRESH_TRUNCATION_EVIDENCE_SCHEMA_VERSION = '1.0.0';

/** Legacy compatibility byte cap; not an authority cap (REL-BGSTAB-007 AC-6). */
const LEGACY_MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;

export type RetainedParityAxis = 'match' | 'mismatch';

export interface RetainedCheckpointParity {
  restoreSource: 'retained-checkpoint';
  logicalLines: RetainedParityAxis;
  cells: RetainedParityAxis;
  attributes: RetainedParityAxis;
}

export interface RefreshRetainedStateBoundaryMeasurement {
  refreshPath: 'legacy-viewport-only-snapshot';
  cols: number;
  rows: number;
  scrollbackLines: number;
  /** Lines the fixture emitted into the PTY stream. */
  producedLogicalLineCount: number;
  /** Lines the authoritative retained model still holds. */
  retainedLogicalLineCount: number;
  /** Lines a browser recovers through the refresh path. */
  refreshDeliveredLogicalLineCount: number;
  /** Produced lines already outside configured retention. */
  expectedEvictionLogicalLines: number;
  /** Lines inside configured retention that refresh nonetheless drops. */
  observedLossLogicalLines: number;
  /**
   * Whether this seed lost any line that was inside configured retention.
   * This is a per-seed observation. It does NOT locate where loss begins --
   * that is measured separately by `measureRefreshTruncationFiringBoundary`.
   */
  observedLossPresent: boolean;
  preRefreshLogicalLineHash: string;
  postRefreshLogicalLineHash: string;
  preRefreshCellHash: string;
  postRefreshCellHash: string;
  retainedCheckpointParity: RetainedCheckpointParity;
  snapshotTruncated: boolean;
  oldestRetainedSeq: string | null;
  completeLogicalRowBoundary: boolean;
}

export interface RefreshTruncationBoundarySeed extends RefreshRetainedStateBoundaryMeasurement {
  seedKind: 'characterization-corpus';
}

export interface RefreshTruncationBoundaryEvidence {
  schemaVersion: typeof REFRESH_TRUNCATION_EVIDENCE_SCHEMA_VERSION;
  requirementId: 'OBS-BGSTAB-009';
  evidenceKind: 'refresh_retained_state_truncation_boundary';
  source: {
    refreshProducer: 'server/src/utils/headlessTerminal.ts#serializeHeadlessTerminal';
    authorityProducer: 'server/src/utils/headlessTerminal.ts#serializeRetainedHeadlessCheckpoint';
    legacyMaxSnapshotBytes: number;
  };
  rawPayloadOmitted: true;
  setsProductRetainedRows: false;
  seeds: RefreshTruncationBoundarySeed[];
  /** Independently probed firing boundaries; not derived from `seeds`. */
  firingBoundaries: RefreshTruncationFiringBoundary[];
  /**
   * The legacy 2 MiB serializer cap is recorded as context only. The
   * viewport-only refresh path never reaches it, so no seed in this corpus
   * exercises that boundary; `snapshotTruncated` is false throughout. The
   * 2 MiB boundary itself is characterized by OBS-BGSTAB-004 through
   * `server/src/benchmarks/retainedStateLegacyBoundary.ts`.
   */
  legacyByteBoundaryExercised: false;
  /**
   * Axes this corpus does NOT vary: text (ASCII only), terminal buffer
   * (normal only), view active/hidden, local cache state, ANSI split.
   */
  unexercisedAxes: readonly string[];
  contentDigest: { algorithm: 'sha256'; value: string };
}

// @req OBS-BGSTAB-009
function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

// @req OBS-BGSTAB-009
function contentLines(projection: RetainedHeadlessBufferProjection): readonly string[] {
  return projection.logicalLines.filter((line) => line.trim().length > 0);
}

/**
 * Splits produced lines into the three disjoint classes issue #23 requires to
 * be distinguishable: expected eviction outside retention, observed loss inside
 * retention, and lines the refresh path actually preserved.
 */
// @req OBS-BGSTAB-009
export function classifyRefreshRetainedLineLoss(input: {
  producedLogicalLines: number;
  retainedLogicalLines: number;
  refreshDeliveredLogicalLines: number;
}): {
  expectedEvictionLogicalLines: number;
  observedLossLogicalLines: number;
  preservedLogicalLines: number;
} {
  const preserved = Math.min(input.refreshDeliveredLogicalLines, input.retainedLogicalLines);
  return {
    expectedEvictionLogicalLines: Math.max(0, input.producedLogicalLines - input.retainedLogicalLines),
    observedLossLogicalLines: Math.max(0, input.retainedLogicalLines - preserved),
    preservedLogicalLines: preserved,
  };
}

// @req OBS-BGSTAB-009
async function seedTerminal(options: {
  cols: number;
  rows: number;
  scrollbackLines: number;
  logicalLines: number;
}): Promise<HeadlessTerminalState> {
  const state = createHeadlessTerminalState({
    cols: options.cols,
    rows: options.rows,
    scrollbackLines: options.scrollbackLines,
  });
  // No trailing newline: the produced logical-line count stays exact.
  const payload = Array.from({ length: options.logicalLines }, (_unused, index) =>
    `line-${String(index + 1).padStart(6, '0')}`).join('\r\n');
  await writeHeadlessTerminal(state, payload);
  return state;
}

// @req OBS-BGSTAB-009
async function rehydrate(options: {
  cols: number;
  rows: number;
  scrollbackLines: number;
  ansi: string;
}): Promise<{ projection: RetainedHeadlessBufferProjection; dispose: () => void }> {
  const state = createHeadlessTerminalState({
    cols: options.cols,
    rows: options.rows,
    scrollbackLines: options.scrollbackLines,
  });
  await writeHeadlessTerminal(state, options.ansi);
  const projection = serializeRetainedHeadlessCheckpoint(state).normal;
  return { projection, dispose: () => disposeHeadlessTerminal(state) };
}

/**
 * Reproduces one refresh cycle end to end and returns the boundary record.
 */
// @req OBS-BGSTAB-009
export async function measureRefreshRetainedStateBoundary(options: {
  cols: number;
  rows: number;
  scrollbackLines: number;
  logicalLines: number;
}): Promise<RefreshRetainedStateBoundaryMeasurement> {
  const source = await seedTerminal(options);
  try {
    const authoritative = serializeRetainedHeadlessCheckpoint(source);
    const metrics = readRetainedHeadlessBufferMetrics(source);
    const preLines = contentLines(authoritative.normal);

    const refreshSnapshot = serializeHeadlessTerminal(source, LEGACY_MAX_SNAPSHOT_BYTES);
    const refreshed = await rehydrate({ ...options, ansi: refreshSnapshot.data });
    const postLines = contentLines(refreshed.projection);

    const restored = await rehydrate({ ...options, ansi: authoritative.rehydrateAnsi });
    const restoredLines = contentLines(restored.projection);

    const classification = classifyRefreshRetainedLineLoss({
      producedLogicalLines: options.logicalLines,
      retainedLogicalLines: preLines.length,
      refreshDeliveredLogicalLines: postLines.length,
    });

    try {
      return {
        refreshPath: 'legacy-viewport-only-snapshot',
        cols: options.cols,
        rows: options.rows,
        scrollbackLines: options.scrollbackLines,
        producedLogicalLineCount: options.logicalLines,
        retainedLogicalLineCount: preLines.length,
        refreshDeliveredLogicalLineCount: classification.preservedLogicalLines,
        expectedEvictionLogicalLines: classification.expectedEvictionLogicalLines,
        observedLossLogicalLines: classification.observedLossLogicalLines,
        observedLossPresent: classification.observedLossLogicalLines > 0,
        preRefreshLogicalLineHash: sha256(JSON.stringify(preLines)),
        postRefreshLogicalLineHash: sha256(JSON.stringify(postLines)),
        preRefreshCellHash: authoritative.normal.cellHash,
        postRefreshCellHash: refreshed.projection.cellHash,
        retainedCheckpointParity: {
          restoreSource: 'retained-checkpoint',
          logicalLines:
            sha256(JSON.stringify(restoredLines)) === sha256(JSON.stringify(preLines))
              ? 'match'
              : 'mismatch',
          cells: restored.projection.cellHash === authoritative.normal.cellHash ? 'match' : 'mismatch',
          attributes:
            restored.projection.attributeHash === authoritative.normal.attributeHash
              ? 'match'
              : 'mismatch',
        },
        snapshotTruncated: refreshSnapshot.truncated,
        oldestRetainedSeq: metrics.oldestRetainedSeq,
        completeLogicalRowBoundary: metrics.completeLogicalRowBoundary,
      };
    } finally {
      refreshed.dispose();
      restored.dispose();
    }
  } finally {
    disposeHeadlessTerminal(source);
  }
}

export interface RefreshTruncationFiringBoundary {
  cols: number;
  rows: number;
  scrollbackLines: number;
  /**
   * Smallest produced logical-line count at which a line inside configured
   * retention is lost. Found by ascending linear probe, not assumed.
   */
  measuredFiringBoundaryLogicalLines: number | null;
  /** Largest probed count that still lost nothing. */
  largestLosslessLogicalLines: number;
  probedRange: { from: number; to: number };
  probeMethod: 'ascending-linear-probe';
}

/**
 * Locates the firing boundary empirically rather than deriving it. Probes
 * upward from a single produced line until the first seed that loses a line
 * inside configured retention.
 */
// @req OBS-BGSTAB-009
export async function measureRefreshTruncationFiringBoundary(options: {
  cols: number;
  rows: number;
  scrollbackLines: number;
  maxProbeLogicalLines: number;
}): Promise<RefreshTruncationFiringBoundary> {
  let largestLossless = 0;
  let boundary: number | null = null;
  for (let lines = 1; lines <= options.maxProbeLogicalLines; lines += 1) {
    const measurement = await measureRefreshRetainedStateBoundary({
      cols: options.cols,
      rows: options.rows,
      scrollbackLines: options.scrollbackLines,
      logicalLines: lines,
    });
    if (measurement.observedLossLogicalLines > 0) {
      boundary = lines;
      break;
    }
    largestLossless = lines;
  }
  return {
    cols: options.cols,
    rows: options.rows,
    scrollbackLines: options.scrollbackLines,
    measuredFiringBoundaryLogicalLines: boundary,
    largestLosslessLogicalLines: largestLossless,
    probedRange: { from: 1, to: options.maxProbeLogicalLines },
    probeMethod: 'ascending-linear-probe',
  };
}

/** Geometries whose firing boundary is measured rather than assumed. */
const FIRING_BOUNDARY_PROBES: readonly {
  cols: number; rows: number; scrollbackLines: number; maxProbeLogicalLines: number;
}[] = [
  { cols: 80, rows: 24, scrollbackLines: 100, maxProbeLogicalLines: 40 },
  { cols: 80, rows: 24, scrollbackLines: 10000, maxProbeLogicalLines: 40 },
  { cols: 80, rows: 10, scrollbackLines: 1000, maxProbeLogicalLines: 40 },
];

/** Characterization corpus. These numbers reproduce current behaviour; they are
 * not a proposed product retained-history value. */
const CORPUS: readonly { cols: number; rows: number; scrollbackLines: number; logicalLines: number }[] = [
  { cols: 80, rows: 24, scrollbackLines: 100, logicalLines: 24 },
  { cols: 80, rows: 24, scrollbackLines: 100, logicalLines: 25 },
  { cols: 80, rows: 24, scrollbackLines: 1000, logicalLines: 999 },
  { cols: 80, rows: 24, scrollbackLines: 1000, logicalLines: 1000 },
  { cols: 80, rows: 24, scrollbackLines: 1000, logicalLines: 1001 },
  { cols: 80, rows: 24, scrollbackLines: 10000, logicalLines: 9999 },
  { cols: 80, rows: 24, scrollbackLines: 10000, logicalLines: 10000 },
  { cols: 80, rows: 24, scrollbackLines: 10000, logicalLines: 10001 },
];

// @req OBS-BGSTAB-009
export async function produceRefreshTruncationBoundaryEvidence(): Promise<RefreshTruncationBoundaryEvidence> {
  const seeds: RefreshTruncationBoundarySeed[] = [];
  for (const entry of CORPUS) {
    const measurement = await measureRefreshRetainedStateBoundary(entry);
    seeds.push({ ...measurement, seedKind: 'characterization-corpus' });
  }

  const firingBoundaries: RefreshTruncationFiringBoundary[] = [];
  for (const probe of FIRING_BOUNDARY_PROBES) {
    firingBoundaries.push(await measureRefreshTruncationFiringBoundary(probe));
  }

  const body = {
    schemaVersion: REFRESH_TRUNCATION_EVIDENCE_SCHEMA_VERSION,
    requirementId: 'OBS-BGSTAB-009',
    evidenceKind: 'refresh_retained_state_truncation_boundary',
    source: {
      refreshProducer: 'server/src/utils/headlessTerminal.ts#serializeHeadlessTerminal',
      authorityProducer: 'server/src/utils/headlessTerminal.ts#serializeRetainedHeadlessCheckpoint',
      legacyMaxSnapshotBytes: LEGACY_MAX_SNAPSHOT_BYTES,
    },
    rawPayloadOmitted: true,
    setsProductRetainedRows: false,
    seeds,
    firingBoundaries,
    legacyByteBoundaryExercised: false,
    unexercisedAxes: [
      'text:CJK-wide|combining|emoji',
      'terminalBuffer:alternate',
      'view:active|hidden',
      'localCache:valid|absent|poisoned|oversized',
      'ansi:split-escape-tail',
      'legacy-2MiB-serialized-payload',
    ],
  } as const;

  return {
    ...body,
    contentDigest: { algorithm: 'sha256', value: sha256(JSON.stringify(body)) },
  };
}
