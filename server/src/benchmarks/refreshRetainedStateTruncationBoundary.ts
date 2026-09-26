import { createHash } from 'node:crypto';

import type { HeadlessTerminalState, RetainedHeadlessBufferProjection } from '../utils/headlessTerminal.js';
import { TERMINAL_CHECKPOINT_CHUNK_BYTES } from '../services/TerminalAuthorityProductionAdapter.js';
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
  baselineSample: BaselineRawSample;
  /**
   * Wall-clock serializer cost. Deliberately NOT part of `baselineSample`, and
   * never written to the sealed artifact -- see `serializeLatency` in
   * `BASELINE_FIELD_COVERAGE`.
   */
  serializeLatency: { retainedSerializeMs: number; legacySerializeMs: number };
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

/** A seed as written to the sealed artifact: no wall-clock, so it stays byte-stable. */
export interface RefreshTruncationBoundarySeed
  extends Omit<RefreshRetainedStateBoundaryMeasurement, 'serializeLatency'> {
  seedKind: 'characterization-corpus';
}

/**
 * The per-seed half of issue #23's "baseline raw sample" acceptance criterion.
 * Only the fields this harness can actually observe are present; see
 * `BASELINE_FIELD_COVERAGE` for the machine-readable account of the rest.
 */
export interface BaselineRawSample {
  /** Rows the authoritative model still holds, physical and logical. */
  retainedPhysicalRows: number;
  retainedLogicalRows: number;
  retainedUtf8Bytes: number;
  evictedPhysicalRows: number;
  evictedLogicalRows: number;
  evictedUtf8Bytes: number;
  /** Chunks the production encoder would split this checkpoint into. */
  checkpointEncodedBytes: number;
  checkpointChunkCount: number;
  checkpointChunkBytes: number;
  /** Why refresh output differs from the authoritative model, if it does. */
  mismatchReasons: readonly string[];
}

export type BaselineFieldStatus = 'present' | 'gated' | 'absent';

export interface BaselineFieldCoverage {
  status: BaselineFieldStatus;
  /** Where the field lives in each seed's `baselineSample`, when present. */
  sampleKeys?: readonly string[];
  /** Issue that will supply a gated field. */
  gatedTo?: string;
  reason: string;
}

/**
 * Issue #23 AC-12 asks the baseline raw sample to carry six things. This is the
 * machine-readable account of which of them this artifact actually carries, so
 * a reader does not have to infer coverage from prose.
 *
 * AC-12 is NOT satisfied by this artifact and must not be recorded as such.
 */
export const BASELINE_FIELD_COVERAGE: Readonly<Record<string, BaselineFieldCoverage>> = {
  retainedRowsAndBytes: {
    status: 'present',
    sampleKeys: [
      'retainedPhysicalRows', 'retainedLogicalRows', 'retainedUtf8Bytes',
      'evictedPhysicalRows', 'evictedLogicalRows', 'evictedUtf8Bytes',
    ],
    reason: 'Observed on the server model via readRetainedHeadlessBufferMetrics.',
  },
  checkpointChunks: {
    status: 'present',
    sampleKeys: ['checkpointEncodedBytes', 'checkpointChunkCount', 'checkpointChunkBytes'],
    reason:
      'Derived from the retained checkpoint payload and the production chunk size '
      + 'TERMINAL_CHECKPOINT_CHUNK_BYTES, imported so the two cannot drift apart.',
  },
  serializeLatency: {
    status: 'present',
    sampleKeys: ['retainedSerializeMs', 'legacySerializeMs'],
    reason:
      'Wall-clock around each serializer, single-shot and unwarmed. Emitted to the SEPARATE '
      + 'artifact baseline-latency-samples.json, not to this one: this artifact is digest-sealed '
      + 'and byte-compared against a fresh producer run, and wall-clock cannot satisfy that. '
      + 'Treat the numbers as order-of-magnitude, not as a budget or an SLO.',
  },
  mismatchReason: {
    status: 'present',
    sampleKeys: ['mismatchReasons'],
    reason: 'The reasons this module can see: logical-line and cell divergence on the refresh path.',
  },
  applyLatency: {
    status: 'gated',
    gatedTo: 'https://github.com/Snoworca/BuilderGate/issues/10',
    reason:
      'Apply happens in the browser. This harness drives a headless node terminal model and has '
      + 'no applier, so the field is unobservable here rather than merely unmeasured. Issue #10 '
      + 'builds the browser TerminalWriteCoordinator and is the first place it can be sampled.',
  },
  browserLongTask: {
    status: 'gated',
    gatedTo: 'https://github.com/Snoworca/BuilderGate/issues/10',
    reason: 'Requires a browser main thread. Same harness limitation and same gate as applyLatency.',
  },
  queueMaxima: {
    status: 'absent',
    reason:
      'This harness has no delivery queue at all -- no WebSocket, no per-client output queue, no '
      + 'hold queue. The server-side queue budgets exist in SessionManager, but nothing in this '
      + 'reproduction exercises them, so there is no maximum to record. Not gated to a later '
      + 'issue because the server side is observable today; it simply is not observed here.',
  },
};

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
  /** Machine-readable account of issue #23 AC-12 coverage. AC-12 is NOT satisfied. */
  baselineFieldCoverage: Readonly<Record<string, BaselineFieldCoverage>>;
  baselineAcceptanceCriterion: {
    source: 'github-issue-23 AC-12';
    satisfied: false;
    presentFields: readonly string[];
    gatedFields: readonly string[];
    absentFields: readonly string[];
  };
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
   * Axes that exist in the product but this corpus does not vary: text
   * (ASCII only), terminal buffer (normal only), local cache state, split
   * ANSI escape tail, and the legacy 2 MiB serialized-payload boundary.
   */
  unexercisedAxes: readonly string[];
  /**
   * Axes that do not exist in this harness at all. The reproduction runs
   * against a headless node terminal model, so there is no browser view to
   * be active or hidden. These are not "not yet measured" -- they are
   * unmeasurable here and must be covered by a browser-level suite.
   */
  inapplicableAxes: readonly string[];
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
    const retainedStartedAt = performance.now();
    const authoritative = serializeRetainedHeadlessCheckpoint(source);
    const retainedSerializeMs = performance.now() - retainedStartedAt;
    const metrics = readRetainedHeadlessBufferMetrics(source);
    const preLines = contentLines(authoritative.normal);

    const legacyStartedAt = performance.now();
    const refreshSnapshot = serializeHeadlessTerminal(source, LEGACY_MAX_SNAPSHOT_BYTES);
    const legacySerializeMs = performance.now() - legacyStartedAt;
    const refreshed = await rehydrate({ ...options, ansi: refreshSnapshot.data });
    const postLines = contentLines(refreshed.projection);

    const restored = await rehydrate({ ...options, ansi: authoritative.rehydrateAnsi });
    const restoredLines = contentLines(restored.projection);

    const classification = classifyRefreshRetainedLineLoss({
      producedLogicalLines: options.logicalLines,
      retainedLogicalLines: preLines.length,
      refreshDeliveredLogicalLines: postLines.length,
    });

    const preLineHash = sha256(JSON.stringify(preLines));
    const postLineHash = sha256(JSON.stringify(postLines));
    const mismatchReasons: string[] = [];
    if (preLineHash !== postLineHash) mismatchReasons.push('logical-line-hash-divergence');
    if (authoritative.normal.cellHash !== refreshed.projection.cellHash) {
      mismatchReasons.push('cell-hash-divergence');
    }
    if (classification.observedLossLogicalLines > 0) {
      mismatchReasons.push('retained-lines-absent-after-refresh');
    }

    const checkpointEncodedBytes = Buffer.byteLength(authoritative.serializedData, 'utf8');

    try {
      return {
        baselineSample: {
          retainedPhysicalRows: metrics.currentPhysicalRows,
          retainedLogicalRows: metrics.currentLogicalRows,
          retainedUtf8Bytes: metrics.currentUtf8Bytes,
          evictedPhysicalRows: metrics.evictedPhysicalRows,
          evictedLogicalRows: metrics.evictedLogicalRows,
          evictedUtf8Bytes: metrics.evictedUtf8Bytes,
          checkpointEncodedBytes,
          checkpointChunkCount: Math.ceil(checkpointEncodedBytes / TERMINAL_CHECKPOINT_CHUNK_BYTES),
          checkpointChunkBytes: TERMINAL_CHECKPOINT_CHUNK_BYTES,
          mismatchReasons,
        },
        serializeLatency: { retainedSerializeMs, legacySerializeMs },
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
        preRefreshLogicalLineHash: preLineHash,
        postRefreshLogicalLineHash: postLineHash,
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
  /**
   * Every logical-line count the probe evaluated, in order, with the loss it
   * observed there.
   *
   * Descriptive metadata only. It is NOT evidence that a search happened and
   * cannot be used as one: the trail is fully determined by the boundary
   * (`[0, ..., 0, 1]` of length `boundary`, because the probe stops at the
   * first losing count and loss there is always exactly 1). Any producer that
   * knows the boundary can emit a byte-identical trail. Non-derivation is
   * checked instead by two seam-free tests: the wrapped-geometry probes, where
   * `rows + 1` is the wrong answer, and the unpinned-geometry test, which
   * supplies no expected value and confirms the reported boundary by direct
   * measurement.
   *
   * Neither is airtight, and the requirement says so: the wrapped probes pin
   * two geometries (8x24, 8x10) and the artifact pins four distinct
   * (cols, rows) pairs in all, so a four-entry table defeats every pinned
   * assertion; the unpinned draw only enlarges the table needed (162 points). A producer correct at every
   * geometry cannot be told apart from one that measures -- and does not need
   * to be. See OBS-BGSTAB-009 Implementation Notes.
   */
  probeObservations: readonly { logicalLines: number; observedLossLogicalLines: number }[];
  /** Upper bound the probe was allowed to reach. */
  probeCapLogicalLines: number;
  /** Highest logical-line count actually evaluated (the probe stops at the boundary). */
  probedThroughLogicalLines: number;
  /**
   * Descriptive label, not a verified claim. AC-2 deliberately does not
   * prescribe a search algorithm, so nothing checks that the search was in
   * fact ascending and linear -- an implementation that computes the boundary
   * some other way and reports the same label is conformant.
   */
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
  /** Injectable for tests that need to observe that a real search happened. */
  measure?: typeof measureRefreshRetainedStateBoundary;
}): Promise<RefreshTruncationFiringBoundary> {
  const measure = options.measure ?? measureRefreshRetainedStateBoundary;
  const observations: { logicalLines: number; observedLossLogicalLines: number }[] = [];
  let largestLossless = 0;
  let boundary: number | null = null;
  let probedThrough = 0;
  for (let lines = 1; lines <= options.maxProbeLogicalLines; lines += 1) {
    probedThrough = lines;
    const measurement = await measure({
      cols: options.cols,
      rows: options.rows,
      scrollbackLines: options.scrollbackLines,
      logicalLines: lines,
    });
    observations.push({
      logicalLines: lines,
      observedLossLogicalLines: measurement.observedLossLogicalLines,
    });
    if (measurement.observedLossLogicalLines > 0) {
      boundary = lines;
      break;
    }
    largestLossless = lines;
  }
  return {
    probeObservations: observations,
    cols: options.cols,
    rows: options.rows,
    scrollbackLines: options.scrollbackLines,
    measuredFiringBoundaryLogicalLines: boundary,
    largestLosslessLogicalLines: largestLossless,
    probeCapLogicalLines: options.maxProbeLogicalLines,
    probedThroughLogicalLines: probedThrough,
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
  // Narrow geometries wrap each fixture line across several physical rows, so
  // the real boundary is NOT `rows + 1`. These two exist so the committed
  // artifact itself refutes a producer that derives the boundary from `rows`,
  // on the un-injected production path.
  { cols: 8, rows: 24, scrollbackLines: 100, maxProbeLogicalLines: 40 },
  { cols: 8, rows: 10, scrollbackLines: 1000, maxProbeLogicalLines: 40 },
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

export interface BaselineLatencySample {
  cols: number;
  rows: number;
  scrollbackLines: number;
  logicalLines: number;
  retainedSerializeMs: number;
  legacySerializeMs: number;
}

export interface BaselineLatencySamples {
  schemaVersion: '1.0.0';
  requirementId: 'OBS-BGSTAB-009';
  evidenceKind: 'baseline_serialize_latency_samples';
  /**
   * Deliberately NOT digest-sealed and NOT byte-compared. Wall-clock varies run
   * to run, so sealing it would either fail constantly or force a tolerance that
   * hides drift. The sealed artifact next to this one carries everything that
   * must be reproducible.
   */
  sealed: false;
  method: 'single-shot, unwarmed, one measurement per seed';
  setsPerformanceBudget: false;
  samples: BaselineLatencySample[];
}

/**
 * Serialize-latency half of issue #23 AC-12. Separate artifact by design --
 * see `sealed` above.
 */
// @req OBS-BGSTAB-009
export async function produceBaselineLatencySamples(): Promise<BaselineLatencySamples> {
  const samples: BaselineLatencySample[] = [];
  for (const entry of CORPUS) {
    const measurement = await measureRefreshRetainedStateBoundary(entry);
    samples.push({
      cols: entry.cols,
      rows: entry.rows,
      scrollbackLines: entry.scrollbackLines,
      logicalLines: entry.logicalLines,
      retainedSerializeMs: measurement.serializeLatency.retainedSerializeMs,
      legacySerializeMs: measurement.serializeLatency.legacySerializeMs,
    });
  }
  return {
    schemaVersion: '1.0.0',
    requirementId: 'OBS-BGSTAB-009',
    evidenceKind: 'baseline_serialize_latency_samples',
    sealed: false,
    method: 'single-shot, unwarmed, one measurement per seed',
    setsPerformanceBudget: false,
    samples,
  };
}

// @req OBS-BGSTAB-009
export async function produceRefreshTruncationBoundaryEvidence(): Promise<RefreshTruncationBoundaryEvidence> {
  const seeds: RefreshTruncationBoundarySeed[] = [];
  for (const entry of CORPUS) {
    const measurement = await measureRefreshRetainedStateBoundary(entry);
    const { serializeLatency: _latency, ...deterministic } = measurement;
    seeds.push({ ...deterministic, seedKind: 'characterization-corpus' });
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
    baselineFieldCoverage: BASELINE_FIELD_COVERAGE,
    baselineAcceptanceCriterion: {
      source: 'github-issue-23 AC-12',
      satisfied: false,
      presentFields: Object.entries(BASELINE_FIELD_COVERAGE)
        .filter(([, field]) => field.status === 'present').map(([name]) => name),
      gatedFields: Object.entries(BASELINE_FIELD_COVERAGE)
        .filter(([, field]) => field.status === 'gated').map(([name]) => name),
      absentFields: Object.entries(BASELINE_FIELD_COVERAGE)
        .filter(([, field]) => field.status === 'absent').map(([name]) => name),
    },
    unexercisedAxes: [
      'text:CJK-wide|combining|emoji',
      'terminalBuffer:alternate',
      'localCache:valid|absent|poisoned|oversized',
      'ansi:split-escape-tail',
      'legacy-2MiB-serialized-payload',
    ],
    inapplicableAxes: ['view:active|hidden'],
  } as const;

  return {
    ...body,
    contentDigest: { algorithm: 'sha256', value: sha256(JSON.stringify(body)) },
  };
}
