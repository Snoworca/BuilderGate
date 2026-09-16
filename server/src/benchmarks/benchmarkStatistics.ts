export const BENCHMARK_MODES = [
  'NO_RENDER',
  'NO_ANALYZER',
  'NO_NETWORK',
  'ONE_CLIENT_SLOW',
] as const;

export type BenchmarkMode = typeof BENCHMARK_MODES[number];

export interface BenchmarkWorkload {
  sessions: 1 | 8 | 32 | 54;
  clients: 1 | 2 | 8;
  viewMix: {
    active: number;
    hidden: number;
  };
}

export interface BenchmarkMetricSource {
  metricName: string;
  source: string;
  unit: string;
  intervalDelta: boolean;
}

export interface BenchmarkModeDescriptor {
  id: BenchmarkMode;
  disabledLayers: string[];
  replacedLayers: string[];
  retainedLayers: string[];
  controlComparator: string;
  fixture: string;
}

export interface BenchmarkExecutionManifest {
  /**
   * `1` is the sealed Wave-1 shape, which predates PERF-BGSTAB-012 and carries
   * none of `outlierPolicy`, `execution` or `visibilityFactor`. `2` is the shape
   * that carries all three. The version is what decides which of the two is
   * legal: making the new fields required without a version bump would have
   * retroactively invalidated the sealed artifact against its own schema.
   */
  schemaVersion: 1 | 2;
  runId: string;
  randomSeed: number;
  payload: {
    generator: string;
    digest: string;
    size: number;
    unit: 'bytes';
  };
  warmup: {
    kind: 'iterations' | 'duration_ms';
    value: number;
  };
  trials: {
    count: number;
    durationMs: number;
  };
  build: {
    identifier: string;
    commit: string;
  };
  environment: {
    hardware: {
      architecture: string;
      cpuModel: string;
      logicalCores: number;
      memoryBytes: number;
    };
    os: {
      platform: string;
      release: string;
    };
    browser: {
      name: string;
      version: string;
    };
  };
  config: {
    serverDigest: string;
    frontendDigest: string;
  };
  workloadManifestId: string;
  workloads: BenchmarkWorkload[];
  metricSources: BenchmarkMetricSource[];
  modes?: BenchmarkModeDescriptor[];
  sampleInterval?: {
    durationMs: number;
    deltaSemantics: string;
  };
  // @req PERF-BGSTAB-012 AC-1
  outlierPolicy: BenchmarkOutlierPolicy;
  // @req PERF-BGSTAB-012 AC-2
  execution: BenchmarkExecutionRecord;
  // @req PERF-BGSTAB-012 AC-3
  visibilityFactor: BenchmarkVisibilityFactor;
}

/**
 * What the run did about outliers. PERF-BGSTAB-012 AC-1 requires this to be
 * stated rather than implied: a manifest with no policy field is indistinguishable
 * from one whose author never considered the question, and the Wave-1 manifest
 * was exactly that.
 *
 * `retain-all` is a real policy, not a placeholder. This harness aggregates three
 * trials per group, so discarding any of them would leave too few observations to
 * bootstrap a confidence interval from; keeping all three and saying so is the
 * honest answer at this sample size.
 */
export interface BenchmarkOutlierPolicy {
  /** The rule applied, e.g. `retain-all`. */
  rule: string;
  /** Why that rule, in terms a later reader can re-evaluate. */
  rationale: string;
  /** Rule parameters, empty when the rule takes none. */
  parameters: Record<string, number | string>;
  /** Samples the rule removed before aggregation; empty under `retain-all`. */
  excludedSampleIds: string[];
}

/** One unit of measured work, as planned. */
export interface BenchmarkExecutionStep {
  /** Dense, ascending from zero, so a partial record cannot look complete. */
  sequence: number;
  mode: BenchmarkMode;
  /** Index into `manifest.workloads`. */
  workloadIndex: number;
  trialId: string;
}

/**
 * One unit of measured work, as it actually ran.
 *
 * `mode`, `workloadIndex` and `trialId` are the planned values: the runner is a
 * single deterministic loop over `plannedOrder` with no branching, so the arm
 * sequence it walks is the planned sequence by construction. The one field the
 * plan cannot supply is `observedAtMs`, a reading taken when the measurement
 * returned. That is what is genuinely observed here — that each unit completed,
 * and when.
 */
export interface BenchmarkObservedExecutionStep extends BenchmarkExecutionStep {
  /**
   * A monotonic `performance.now()` reading taken when this unit of measurement
   * completed. Strictly increasing across `order`.
   */
  observedAtMs: number;
}

/**
 * PERF-BGSTAB-012 AC-2. The Wave-1 manifest carried an `executionOrder` of
 * `["manifest","raw-samples"]`, which is the order the artifacts were emitted in
 * and says nothing about the order the arms ran in. This records the latter.
 *
 * What it does and does not claim, plainly. The arm sequence in `order` is the
 * sequence in `plannedOrder`: the runner is one deterministic loop over the plan
 * with no branching, so it cannot deviate from it, and comparing the two cannot
 * detect a reordering that the code has no way to produce. What is observed is
 * the per-unit completion timestamp on each entry of `order`. And the interleave
 * guarantee is enforced structurally, by `assertInterleaved` recomputing the
 * longest same-arm run over the arrays themselves — not by trusting any string
 * in this record.
 */
export interface BenchmarkExecutionRecord {
  /**
   * Names exactly what `order` is: the planned arm sequence, carrying a
   * completion timestamp measured per unit. Not a claim that the sequence itself
   * was discovered by watching the run.
   */
  derivedFrom: 'planned-sequence-with-observed-completions';
  /** Whether arms alternate rather than running as contiguous blocks. */
  interleaved: boolean;
  /** How the interleave was produced, for a reader reproducing the run. */
  strategy: string;
  /** The order the runner intended to walk. Declared before the run. */
  plannedOrder: BenchmarkExecutionStep[];
  /**
   * The order the runner actually walked, each entry timestamped on completion.
   * Empty only in a manifest that has not been run yet.
   */
  order: BenchmarkObservedExecutionStep[];
  /**
   * How many `observedAtMs` readings were not measured but derived, because the
   * clock had not advanced since the previous unit and the value had to be
   * nudged to the next representable double to keep `order` a total order.
   *
   * On a coarse-clock host this can reach the length of `order`, at which point
   * the strictly-increasing check passes on wholly synthetic timings. Recording
   * the count makes that visible instead of silent; zero is the healthy case.
   */
  tieBrokenCount: number;
}

/** A cell whose second visibility level cannot exist. */
export interface BenchmarkVisibilityExclusion {
  sessions: number;
  clients: number;
  reason: string;
}

/**
 * PERF-BGSTAB-012 AC-3. Visibility used to be derived from the session count, so
 * half the matrix never existed and nothing said so. This records both the levels
 * that were varied and the cells where a second level is impossible.
 */
export interface BenchmarkVisibilityFactor {
  /** The named levels the corpus varies, e.g. `single-active` and `all-active`. */
  levels: string[];
  structurallyUnreachable: BenchmarkVisibilityExclusion[];
}

export interface BenchmarkRawSample {
  sampleId: string;
  workloadManifestRef: string;
  mode: BenchmarkMode;
  sessionCount: number;
  clientCount: number;
  viewMix: {
    active: number;
    hidden: number;
  };
  trialId: string;
  metricName: string;
  value: number;
  unit: string;
  timingPhase: 'warmup' | 'measurement';
  comparator?: {
    clientId?: string;
    clientRole: 'pressure-baseline' | 'slow' | 'normal';
    isolationEvidence: boolean;
    peerClientId?: string;
  };
  workloadExecutionRef?: string;
  fixtureEvidenceRef?: {
    fixtureExecutionId: string;
    fixtureResultDigest: string;
  };
  metricSource?: string;
  interval?: {
    sequenceStart: number;
    sequenceEnd: number;
    deltaValue: number;
    unit: string;
    durationMs?: number;
    valueSemantics?: string;
  };
}

export interface BenchmarkSummary {
  mode: BenchmarkMode;
  workloadManifestRef: string;
  sessionCount: number;
  clientCount: number;
  viewMix: {
    active: number;
    hidden: number;
  };
  metricName: string;
  unit: string;
  timingPhase: 'measurement';
  comparator?: BenchmarkRawSample['comparator'];
  fixtureEvidenceRef?: BenchmarkRawSample['fixtureEvidenceRef'];
  percentiles: {
    p50: number;
    p95: number;
    p99: number;
  };
  confidenceInterval: {
    lower: number;
    upper: number;
    confidenceLevel: number;
    method: 'seeded-bootstrap-median-percentile';
    calculationSeed: number;
  };
  sourceSampleIds: string[];
}

const FORBIDDEN_PROMOTION_KEYS = new Set([
  'threshold',
  'productthreshold',
  'productdefault',
  'slo',
  'passfail',
  'default',
  'retainedrows',
  'aggregatememory',
  'aggregatememorybytes',
  'checkpointchunk',
  'checkpointchunkbytes',
  'inflightbudget',
]);

// @req PERF-BGSTAB-008
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

/** Options for {@link validateExecutionManifest}. */
export interface ValidateExecutionManifestOptions {
  /**
   * Whether `execution.order` must be a non-empty, timestamped observation.
   *
   * Defaults to true, which is the contract every persisted artifact must meet.
   * The builder passes false because it cannot know the observed order: it emits
   * `plannedOrder` and an empty `order`, and the runner fills the latter in and
   * revalidates with the default before anything is written.
   */
  requireObservedOrder?: boolean;
}

// @req PERF-BGSTAB-008
export function validateExecutionManifest(
  value: unknown,
  options: ValidateExecutionManifestOptions = {},
): asserts value is BenchmarkExecutionManifest {
  const requireObservedOrder = options.requireObservedOrder ?? true;
  assertNoPromotionFields(value, '$');
  const manifest = requireRecord(value, 'manifest');
  assertAllowedKeys(manifest, [
    'schemaVersion',
    'runId',
    'randomSeed',
    'payload',
    'warmup',
    'trials',
    'build',
    'environment',
    'config',
    'workloadManifestId',
    'workloads',
    'metricSources',
    'modes',
    'sampleInterval',
    'outlierPolicy',
    'execution',
    'visibilityFactor',
  ], 'manifest');
  requireInteger(manifest.schemaVersion, 'schemaVersion');
  if (manifest.schemaVersion !== 1 && manifest.schemaVersion !== 2) {
    throw new Error('schemaVersion must be 1 (sealed Wave-1 shape) or 2 (PERF-BGSTAB-012 shape)');
  }
  const schemaVersion = manifest.schemaVersion as 1 | 2;
  requireNonEmptyString(manifest.runId, 'runId');
  requireInteger(manifest.randomSeed, 'randomSeed');

  const payload = requireRecord(manifest.payload, 'payload');
  assertAllowedKeys(payload, ['generator', 'digest', 'size', 'unit'], 'payload');
  requireNonEmptyString(payload.generator, 'payload.generator');
  requireNonEmptyString(payload.digest, 'payload.digest');
  requirePositiveNumber(payload.size, 'payload.size');
  if (payload.unit !== 'bytes') {
    throw new Error('payload.unit must be bytes');
  }

  const warmup = requireRecord(manifest.warmup, 'warmup');
  assertAllowedKeys(warmup, ['kind', 'value'], 'warmup');
  if (warmup.kind !== 'iterations' && warmup.kind !== 'duration_ms') {
    throw new Error('warmup.kind must be iterations or duration_ms');
  }
  requireNonNegativeNumber(warmup.value, 'warmup.value');

  const trials = requireRecord(manifest.trials, 'trials');
  assertAllowedKeys(trials, ['count', 'durationMs'], 'trials');
  requirePositiveInteger(trials.count, 'trials.count');
  requirePositiveNumber(trials.durationMs, 'trials.durationMs');

  const build = requireRecord(manifest.build, 'build');
  assertAllowedKeys(build, ['identifier', 'commit'], 'build');
  requireNonEmptyString(build.identifier, 'build.identifier');
  requireNonEmptyString(build.commit, 'build.commit');

  const environment = requireRecord(manifest.environment, 'environment');
  assertAllowedKeys(environment, ['hardware', 'os', 'browser'], 'environment');
  const hardware = requireRecord(environment.hardware, 'environment.hardware');
  assertAllowedKeys(hardware, [
    'architecture',
    'cpuModel',
    'logicalCores',
    'memoryBytes',
  ], 'environment.hardware');
  requireNonEmptyString(hardware.architecture, 'environment.hardware.architecture');
  requireNonEmptyString(hardware.cpuModel, 'environment.hardware.cpuModel');
  requirePositiveInteger(hardware.logicalCores, 'environment.hardware.logicalCores');
  requirePositiveNumber(hardware.memoryBytes, 'environment.hardware.memoryBytes');
  const os = requireRecord(environment.os, 'environment.os');
  assertAllowedKeys(os, ['platform', 'release'], 'environment.os');
  requireNonEmptyString(os.platform, 'environment.os.platform');
  requireNonEmptyString(os.release, 'environment.os.release');
  const browser = requireRecord(environment.browser, 'environment.browser');
  assertAllowedKeys(browser, ['name', 'version'], 'environment.browser');
  requireNonEmptyString(browser.name, 'environment.browser.name');
  requireNonEmptyString(browser.version, 'environment.browser.version');

  const config = requireRecord(manifest.config, 'config');
  assertAllowedKeys(config, ['serverDigest', 'frontendDigest'], 'config');
  requireNonEmptyString(config.serverDigest, 'config.serverDigest');
  requireNonEmptyString(config.frontendDigest, 'config.frontendDigest');
  requireNonEmptyString(manifest.workloadManifestId, 'workloadManifestId');

  if (!Array.isArray(manifest.workloads) || manifest.workloads.length === 0) {
    throw new Error('workloads must contain at least one workload');
  }
  for (const [index, workload] of manifest.workloads.entries()) {
    validateWorkload(workload, `workloads[${index}]`);
  }
  if (!Array.isArray(manifest.metricSources) || manifest.metricSources.length === 0) {
    throw new Error('metricSources must contain at least one source');
  }
  for (const [index, sourceValue] of manifest.metricSources.entries()) {
    const source = requireRecord(sourceValue, `metricSources[${index}]`);
    assertAllowedKeys(source, [
      'metricName',
      'source',
      'unit',
      'intervalDelta',
    ], `metricSources[${index}]`);
    requireNonEmptyString(source.metricName, `metricSources[${index}].metricName`);
    requireNonEmptyString(source.source, `metricSources[${index}].source`);
    requireNonEmptyString(source.unit, `metricSources[${index}].unit`);
    if (typeof source.intervalDelta !== 'boolean') {
      throw new Error(`metricSources[${index}].intervalDelta must be boolean`);
    }
  }
  if (manifest.modes !== undefined) {
    if (!Array.isArray(manifest.modes) || manifest.modes.length === 0) {
      throw new Error('modes must be a non-empty array when provided');
    }
    for (const [index, modeValue] of manifest.modes.entries()) {
      const mode = requireRecord(modeValue, `modes[${index}]`);
      assertAllowedKeys(mode, [
        'id',
        'disabledLayers',
        'replacedLayers',
        'retainedLayers',
        'controlComparator',
        'fixture',
      ], `modes[${index}]`);
      if (!BENCHMARK_MODES.includes(mode.id as BenchmarkMode)) {
        throw new Error(`modes[${index}].id is unsupported`);
      }
      requireStringArray(mode.disabledLayers, `modes[${index}].disabledLayers`);
      requireStringArray(mode.replacedLayers, `modes[${index}].replacedLayers`);
      requireStringArray(mode.retainedLayers, `modes[${index}].retainedLayers`);
      requireNonEmptyString(mode.controlComparator, `modes[${index}].controlComparator`);
      requireNonEmptyString(mode.fixture, `modes[${index}].fixture`);
    }
  }
  if (manifest.sampleInterval !== undefined) {
    const interval = requireRecord(manifest.sampleInterval, 'sampleInterval');
    assertAllowedKeys(interval, ['durationMs', 'deltaSemantics'], 'sampleInterval');
    requirePositiveNumber(interval.durationMs, 'sampleInterval.durationMs');
    requireNonEmptyString(interval.deltaSemantics, 'sampleInterval.deltaSemantics');
  }

  // @req PERF-BGSTAB-012
  // The three PERF-BGSTAB-012 fields belong to schemaVersion 2 and only to it.
  // A v1 manifest that carried them would be claiming a contract its version
  // does not describe, so they are rejected there rather than merely ignored.
  if (schemaVersion === 1) {
    for (const key of ['outlierPolicy', 'execution', 'visibilityFactor'] as const) {
      if (manifest[key] !== undefined) {
        throw new Error(
          `${key} requires schemaVersion 2; a schemaVersion 1 manifest predates PERF-BGSTAB-012`,
        );
      }
    }
    return;
  }

  // @req PERF-BGSTAB-012 AC-1
  // Required, not optional. An optional outlier policy would leave the Wave-1
  // shape valid, and the whole point of AC-1 is that that shape is not.
  const outlierPolicy = requireRecord(manifest.outlierPolicy, 'outlierPolicy');
  assertAllowedKeys(
    outlierPolicy,
    ['rule', 'rationale', 'parameters', 'excludedSampleIds'],
    'outlierPolicy',
  );
  requireNonEmptyString(outlierPolicy.rule, 'outlierPolicy.rule');
  requireNonEmptyString(outlierPolicy.rationale, 'outlierPolicy.rationale');
  requireRecord(outlierPolicy.parameters, 'outlierPolicy.parameters');
  requireStringArray(outlierPolicy.excludedSampleIds, 'outlierPolicy.excludedSampleIds');
  if (outlierPolicy.rule === 'retain-all'
    && (outlierPolicy.excludedSampleIds as string[]).length > 0) {
    throw new Error('outlierPolicy.rule retain-all cannot exclude samples');
  }

  // @req PERF-BGSTAB-012 AC-2
  const execution = requireRecord(manifest.execution, 'execution');
  assertAllowedKeys(
    execution,
    ['derivedFrom', 'interleaved', 'strategy', 'plannedOrder', 'order', 'tieBrokenCount'],
    'execution',
  );
  // `derivedFrom` is a string a producer can simply write, so it is required to
  // be the one value that honestly describes what `order` holds: the planned arm
  // sequence with a measured completion timestamp per unit. It is a label, not
  // evidence. The checkable parts are `observedAtMs` on every entry, the
  // strictly-increasing check below, `tieBrokenCount` for how many of those
  // readings were derived rather than measured, and `assertInterleaved`.
  if (execution.derivedFrom !== 'planned-sequence-with-observed-completions') {
    throw new Error(
      'execution.derivedFrom must be planned-sequence-with-observed-completions; the arm sequence is the planned one and only the completion timestamps are observed',
    );
  }
  requireNonNegativeInteger(execution.tieBrokenCount, 'execution.tieBrokenCount');
  if (typeof execution.interleaved !== 'boolean') {
    throw new Error('execution.interleaved must be boolean');
  }
  requireNonEmptyString(execution.strategy, 'execution.strategy');

  if (!Array.isArray(execution.plannedOrder) || execution.plannedOrder.length === 0) {
    throw new Error('execution.plannedOrder must contain at least one step');
  }
  for (const [index, stepValue] of execution.plannedOrder.entries()) {
    validateExecutionStep(stepValue, `execution.plannedOrder[${index}]`, index, manifest, false);
  }

  if (!Array.isArray(execution.order)) {
    throw new Error('execution.order must be an array');
  }
  if (requireObservedOrder && execution.order.length === 0) {
    throw new Error('execution.order must contain at least one observed step');
  }
  for (const [index, stepValue] of execution.order.entries()) {
    validateExecutionStep(stepValue, `execution.order[${index}]`, index, manifest, true);
  }
  for (let index = 1; index < execution.order.length; index += 1) {
    const previous = (execution.order[index - 1] as Record<string, unknown>).observedAtMs as number;
    const current = (execution.order[index] as Record<string, unknown>).observedAtMs as number;
    if (!(current > previous)) {
      throw new Error(
        `execution.order[${index}].observedAtMs must be greater than the previous step's; an order that does not advance in time was not observed`,
      );
    }
  }

  // @req PERF-BGSTAB-012 AC-2
  // `interleaved` is a producer literal, so it is recomputed rather than
  // believed. A claim of interleaving means consecutive units differ in mode,
  // which no contiguous block of an arm can satisfy at any length.
  if (execution.interleaved === true) {
    assertInterleaved(execution.plannedOrder as Array<Record<string, unknown>>, 'execution.plannedOrder');
    if (execution.order.length > 0) {
      assertInterleaved(execution.order as Array<Record<string, unknown>>, 'execution.order');
    }
  }

  // @req PERF-BGSTAB-012 AC-3
  const visibilityFactor = requireRecord(manifest.visibilityFactor, 'visibilityFactor');
  assertAllowedKeys(visibilityFactor, ['levels', 'structurallyUnreachable'], 'visibilityFactor');
  requireStringArray(visibilityFactor.levels, 'visibilityFactor.levels');
  if ((visibilityFactor.levels as string[]).length < 2) {
    throw new Error('visibilityFactor.levels must name at least two levels to be a varied factor');
  }
  if (!Array.isArray(visibilityFactor.structurallyUnreachable)) {
    throw new Error('visibilityFactor.structurallyUnreachable must be an array');
  }
  for (const [index, exclusionValue] of visibilityFactor.structurallyUnreachable.entries()) {
    const exclusion = requireRecord(exclusionValue, `visibilityFactor.structurallyUnreachable[${index}]`);
    assertAllowedKeys(
      exclusion,
      ['sessions', 'clients', 'reason'],
      `visibilityFactor.structurallyUnreachable[${index}]`,
    );
    requirePositiveInteger(exclusion.sessions, `visibilityFactor.structurallyUnreachable[${index}].sessions`);
    requirePositiveInteger(exclusion.clients, `visibilityFactor.structurallyUnreachable[${index}].clients`);
    requireNonEmptyString(exclusion.reason, `visibilityFactor.structurallyUnreachable[${index}].reason`);
  }
}

// @req PERF-BGSTAB-012 AC-2
function validateExecutionStep(
  stepValue: unknown,
  path: string,
  index: number,
  manifest: Record<string, unknown>,
  observed: boolean,
): void {
  const step = requireRecord(stepValue, path);
  assertAllowedKeys(
    step,
    observed
      ? ['sequence', 'mode', 'workloadIndex', 'trialId', 'observedAtMs']
      : ['sequence', 'mode', 'workloadIndex', 'trialId'],
    path,
  );
  if (step.sequence !== index) {
    throw new Error(`${path}.sequence must equal ${index}`);
  }
  if (!BENCHMARK_MODES.includes(step.mode as BenchmarkMode)) {
    throw new Error(`${path}.mode is unsupported`);
  }
  requireInteger(step.workloadIndex, `${path}.workloadIndex`);
  requireNonNegativeNumber(step.workloadIndex, `${path}.workloadIndex`);
  // Bounding against the declared workloads is what makes the index mean
  // something; an unbounded integer would let a step point at nothing.
  if ((step.workloadIndex as number) >= (manifest.workloads as unknown[]).length) {
    throw new Error(`${path}.workloadIndex is outside the declared workloads`);
  }
  requireNonEmptyString(step.trialId, `${path}.trialId`);
  if (observed) {
    requireFiniteNumber(step.observedAtMs, `${path}.observedAtMs`);
    requireNonNegativeNumber(step.observedAtMs, `${path}.observedAtMs`);
  }
}

// @req PERF-BGSTAB-012 AC-2
/**
 * The rule `execution.strategy` actually claims: consecutive units differ in
 * mode.
 *
 * The earlier formulation compared the longest same-arm run against
 * `length / distinctModes` — the arm's fair share of the run — and was wrong at
 * both ends. Too weak, because a 252-step order of
 * `[125×NO_ANALYZER, NO_RENDER, 125×NO_ANALYZER, NO_RENDER]` has a longest run
 * of 125 against a fair share of 126 and was accepted, which is exactly the
 * block concentration the check exists to reject: all the machine drift over 125
 * consecutive units lands on one arm. Too strict, because a perfectly
 * interleaved `[A, B]` has a longest run of 1 against a fair share of 1 and was
 * rejected, so a legitimately alternating two-step order could not be expressed.
 *
 * Requiring the longest same-arm run to be exactly 1 has neither pathology: no
 * block order can satisfy it at any length, and there is no minimum length below
 * which a true interleave fails.
 */
function assertInterleaved(order: Array<Record<string, unknown>>, path: string): void {
  const distinctModes = new Set(order.map(step => step.mode as string));
  if (distinctModes.size < 2) {
    throw new Error(`${path} claims interleaving but names only one arm`);
  }
  for (let index = 1; index < order.length; index += 1) {
    const previousMode = order[index - 1].mode as string;
    const currentMode = order[index].mode as string;
    if (previousMode === currentMode) {
      throw new Error(
        `${path} is not interleaved: step ${index - 1} ran ${previousMode} and step ${index} ran ${currentMode}, so consecutive units did not alternate arms`,
      );
    }
  }
}

// @req PERF-BGSTAB-008
export function aggregateBenchmarkSamples(
  manifestValue: unknown,
  sampleValues: unknown[],
): BenchmarkSummary[] {
  validateExecutionManifest(manifestValue);
  if (!Array.isArray(sampleValues) || sampleValues.length === 0) {
    throw new Error('At least one raw sample is required before summary aggregation');
  }

  const samples = sampleValues.map((sample, index) => validateRawSample(
    sample,
    manifestValue,
    `samples[${index}]`,
  ));
  const sampleIds = new Set<string>();
  for (const sample of samples) {
    if (sampleIds.has(sample.sampleId)) {
      throw new Error(`Duplicate raw sample ID: ${sample.sampleId}`);
    }
    sampleIds.add(sample.sampleId);
  }
  const measurementSamples = samples.filter(sample => sample.timingPhase === 'measurement');
  if (measurementSamples.length === 0) {
    throw new Error('At least one measurement-phase raw sample is required before summary aggregation');
  }

  const groups = new Map<string, BenchmarkRawSample[]>();
  for (const sample of measurementSamples) {
    const groupIdentity = {
      mode: sample.mode,
      workloadManifestRef: sample.workloadManifestRef,
      sessionCount: sample.sessionCount,
      clientCount: sample.clientCount,
      viewMix: sample.viewMix,
      metricName: sample.metricName,
      unit: sample.unit,
      ...(sample.comparator ? { comparator: sample.comparator } : {}),
      ...(sample.fixtureEvidenceRef ? { fixtureEvidenceRef: sample.fixtureEvidenceRef } : {}),
    };
    const key = canonicalJson(groupIdentity);
    const group = groups.get(key) ?? [];
    group.push(sample);
    groups.set(key, group);
  }

  return [...groups.entries()]
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([key, group]) => summarizeGroup(manifestValue.randomSeed, key, group));
}

// @req PERF-BGSTAB-008
function summarizeGroup(baseSeed: number, groupKey: string, group: BenchmarkRawSample[]): BenchmarkSummary {
  const sortedGroup = [...group].sort((left, right) => compareCodeUnits(left.sampleId, right.sampleId));
  const values = sortedGroup.map(sample => sample.value).sort((left, right) => left - right);
  const calculationSeed = mixSeed(baseSeed, groupKey);
  const interval = bootstrapMedianInterval(values, calculationSeed, 0.95, 512);
  const first = sortedGroup[0];
  return {
    mode: first.mode,
    workloadManifestRef: first.workloadManifestRef,
    sessionCount: first.sessionCount,
    clientCount: first.clientCount,
    viewMix: { ...first.viewMix },
    metricName: first.metricName,
    unit: first.unit,
    timingPhase: 'measurement',
    ...(first.comparator ? { comparator: { ...first.comparator } } : {}),
    ...(first.fixtureEvidenceRef ? { fixtureEvidenceRef: { ...first.fixtureEvidenceRef } } : {}),
    percentiles: {
      p50: percentile(values, 0.5),
      p95: percentile(values, 0.95),
      p99: percentile(values, 0.99),
    },
    confidenceInterval: {
      lower: interval.lower,
      upper: interval.upper,
      confidenceLevel: 0.95,
      method: 'seeded-bootstrap-median-percentile',
      calculationSeed,
    },
    sourceSampleIds: sortedGroup.map(sample => sample.sampleId),
  };
}

// @req PERF-BGSTAB-008
function validateRawSample(
  value: unknown,
  manifest: BenchmarkExecutionManifest,
  path: string,
): BenchmarkRawSample {
  assertNoPromotionFields(value, path);
  const sample = requireRecord(value, path);
  assertAllowedKeys(sample, [
    'sampleId',
    'workloadManifestRef',
    'mode',
    'sessionCount',
    'clientCount',
    'viewMix',
    'trialId',
    'metricName',
    'value',
    'unit',
    'timingPhase',
    'comparator',
    'workloadExecutionRef',
    'fixtureEvidenceRef',
    'metricSource',
    'interval',
  ], path);
  requireNonEmptyString(sample.sampleId, `${path}.sampleId`);
  if (sample.workloadManifestRef !== manifest.workloadManifestId) {
    throw new Error(`${path}.workloadManifestRef must reference ${manifest.workloadManifestId}`);
  }
  if (!BENCHMARK_MODES.includes(sample.mode as BenchmarkMode)) {
    throw new Error(`${path}.mode is unsupported`);
  }
  requirePositiveInteger(sample.sessionCount, `${path}.sessionCount`);
  requirePositiveInteger(sample.clientCount, `${path}.clientCount`);
  const viewMix = validateViewMix(sample.viewMix, `${path}.viewMix`);
  if (viewMix.active + viewMix.hidden !== sample.sessionCount) {
    throw new Error(`${path}.viewMix must total sessionCount`);
  }
  requireNonEmptyString(sample.trialId, `${path}.trialId`);
  requireNonEmptyString(sample.metricName, `${path}.metricName`);
  requireFiniteNumber(sample.value, `${path}.value`);
  requireNonEmptyString(sample.unit, `${path}.unit`);
  if (sample.timingPhase !== 'warmup' && sample.timingPhase !== 'measurement') {
    throw new Error(`${path}.timingPhase is unsupported`);
  }

  let comparator: BenchmarkRawSample['comparator'];
  if (sample.comparator !== undefined) {
    const valueComparator = requireRecord(sample.comparator, `${path}.comparator`);
    assertAllowedKeys(valueComparator, [
      'clientRole',
      'clientId',
      'isolationEvidence',
      'peerClientId',
    ], `${path}.comparator`);
    if (!['pressure-baseline', 'slow', 'normal'].includes(String(valueComparator.clientRole))) {
      throw new Error(`${path}.comparator.clientRole is unsupported`);
    }
    if (valueComparator.clientId !== undefined) {
      requireNonEmptyString(valueComparator.clientId, `${path}.comparator.clientId`);
    }
    if (typeof valueComparator.isolationEvidence !== 'boolean') {
      throw new Error(`${path}.comparator.isolationEvidence must be boolean`);
    }
    if (valueComparator.peerClientId !== undefined) {
      requireNonEmptyString(valueComparator.peerClientId, `${path}.comparator.peerClientId`);
    }
    comparator = {
      ...(typeof valueComparator.clientId === 'string'
        ? { clientId: valueComparator.clientId }
        : {}),
      clientRole: valueComparator.clientRole as 'pressure-baseline' | 'slow' | 'normal',
      isolationEvidence: valueComparator.isolationEvidence,
      ...(typeof valueComparator.peerClientId === 'string'
        ? { peerClientId: valueComparator.peerClientId }
        : {}),
    };
  }

  let fixtureEvidenceRef: BenchmarkRawSample['fixtureEvidenceRef'];
  if (sample.fixtureEvidenceRef !== undefined) {
    const valueFixture = requireRecord(sample.fixtureEvidenceRef, `${path}.fixtureEvidenceRef`);
    assertAllowedKeys(valueFixture, ['fixtureExecutionId', 'fixtureResultDigest'], `${path}.fixtureEvidenceRef`);
    requireNonEmptyString(valueFixture.fixtureExecutionId, `${path}.fixtureEvidenceRef.fixtureExecutionId`);
    requireNonEmptyString(valueFixture.fixtureResultDigest, `${path}.fixtureEvidenceRef.fixtureResultDigest`);
    fixtureEvidenceRef = {
      fixtureExecutionId: valueFixture.fixtureExecutionId as string,
      fixtureResultDigest: valueFixture.fixtureResultDigest as string,
    };
  }
  if (sample.workloadExecutionRef !== undefined) {
    requireNonEmptyString(sample.workloadExecutionRef, `${path}.workloadExecutionRef`);
  }

  let interval: BenchmarkRawSample['interval'];
  if (sample.interval !== undefined) {
    const valueInterval = requireRecord(sample.interval, `${path}.interval`);
    assertAllowedKeys(valueInterval, [
      'sequenceStart',
      'sequenceEnd',
      'deltaValue',
      'unit',
      'durationMs',
      'valueSemantics',
    ], `${path}.interval`);
    requireNonNegativeInteger(valueInterval.sequenceStart, `${path}.interval.sequenceStart`);
    requirePositiveInteger(valueInterval.sequenceEnd, `${path}.interval.sequenceEnd`);
    if ((valueInterval.sequenceEnd as number) <= (valueInterval.sequenceStart as number)) {
      throw new Error(`${path}.interval.sequenceEnd must be greater than sequenceStart`);
    }
    requireFiniteNumber(valueInterval.deltaValue, `${path}.interval.deltaValue`);
    requireNonEmptyString(valueInterval.unit, `${path}.interval.unit`);
    if (valueInterval.unit !== sample.unit) {
      throw new Error(`${path}.interval.unit must match sample unit`);
    }
    if (valueInterval.durationMs !== undefined) {
      requirePositiveNumber(valueInterval.durationMs, `${path}.interval.durationMs`);
    }
    if (valueInterval.valueSemantics !== undefined) {
      requireNonEmptyString(valueInterval.valueSemantics, `${path}.interval.valueSemantics`);
    }
    interval = {
      sequenceStart: valueInterval.sequenceStart as number,
      sequenceEnd: valueInterval.sequenceEnd as number,
      deltaValue: valueInterval.deltaValue as number,
      unit: valueInterval.unit as string,
      ...(typeof valueInterval.durationMs === 'number' ? { durationMs: valueInterval.durationMs } : {}),
      ...(typeof valueInterval.valueSemantics === 'string'
        ? { valueSemantics: valueInterval.valueSemantics }
        : {}),
    };
  }
  if (sample.metricSource !== undefined) {
    requireNonEmptyString(sample.metricSource, `${path}.metricSource`);
  }

  return {
    sampleId: sample.sampleId as string,
    workloadManifestRef: sample.workloadManifestRef as string,
    mode: sample.mode as BenchmarkMode,
    sessionCount: sample.sessionCount as number,
    clientCount: sample.clientCount as number,
    viewMix,
    trialId: sample.trialId as string,
    metricName: sample.metricName as string,
    value: sample.value as number,
    unit: sample.unit as string,
    timingPhase: sample.timingPhase as BenchmarkRawSample['timingPhase'],
    ...(comparator ? { comparator } : {}),
    ...(typeof sample.workloadExecutionRef === 'string'
      ? { workloadExecutionRef: sample.workloadExecutionRef }
      : {}),
    ...(fixtureEvidenceRef ? { fixtureEvidenceRef } : {}),
    ...(typeof sample.metricSource === 'string' ? { metricSource: sample.metricSource } : {}),
    ...(interval ? { interval } : {}),
  };
}

// @req PERF-BGSTAB-008
function validateWorkload(value: unknown, path: string): void {
  const workload = requireRecord(value, path);
  assertAllowedKeys(workload, ['sessions', 'clients', 'viewMix'], path);
  if (![1, 8, 32, 54].includes(workload.sessions as number)) {
    throw new Error(`${path}.sessions is unsupported`);
  }
  if (![1, 2, 8].includes(workload.clients as number)) {
    throw new Error(`${path}.clients is unsupported`);
  }
  const viewMix = validateViewMix(workload.viewMix, `${path}.viewMix`);
  if (viewMix.active + viewMix.hidden !== workload.sessions) {
    throw new Error(`${path}.viewMix must total sessions`);
  }
}

// @req PERF-BGSTAB-008
function validateViewMix(value: unknown, path: string): { active: number; hidden: number } {
  const viewMix = requireRecord(value, path);
  assertAllowedKeys(viewMix, ['active', 'hidden'], path);
  requireNonNegativeInteger(viewMix.active, `${path}.active`);
  requireNonNegativeInteger(viewMix.hidden, `${path}.hidden`);
  return { active: viewMix.active as number, hidden: viewMix.hidden as number };
}

// @req PERF-BGSTAB-008
function bootstrapMedianInterval(
  sortedValues: number[],
  seed: number,
  confidenceLevel: number,
  iterations: number,
): { lower: number; upper: number } {
  if (sortedValues.length === 1) {
    return { lower: sortedValues[0], upper: sortedValues[0] };
  }
  const random = createSeededRandom(seed);
  const bootstrapMedians: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const resample: number[] = [];
    for (let index = 0; index < sortedValues.length; index += 1) {
      resample.push(sortedValues[Math.floor(random() * sortedValues.length)]);
    }
    resample.sort((left, right) => left - right);
    bootstrapMedians.push(percentile(resample, 0.5));
  }
  bootstrapMedians.sort((left, right) => left - right);
  const tail = (1 - confidenceLevel) / 2;
  return {
    lower: percentile(bootstrapMedians, tail),
    upper: percentile(bootstrapMedians, 1 - tail),
  };
}

// @req PERF-BGSTAB-008
function percentile(sortedValues: number[], fraction: number): number {
  if (sortedValues.length === 0) {
    throw new Error('Cannot calculate a percentile without values');
  }
  const index = (sortedValues.length - 1) * fraction;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) {
    return sortedValues[lower];
  }
  const weight = index - lower;
  return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
}

// @req PERF-BGSTAB-008
function createSeededRandom(seed: number): () => number {
  let state = (seed >>> 0) || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

// @req PERF-BGSTAB-008
function mixSeed(seed: number, value: string): number {
  let mixed = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    mixed = Math.imul(mixed ^ value.charCodeAt(index), 0x01000193) >>> 0;
  }
  return mixed || 1;
}

// @req PERF-BGSTAB-008
function assertNoPromotionFields(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      assertNoPromotionFields(item, `${path}[${index}]`);
    }
    return;
  }
  if (value === null || typeof value !== 'object') {
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
    if (FORBIDDEN_PROMOTION_KEYS.has(normalized)) {
      throw new Error(`Forbidden product threshold/SLO promotion field at ${path}.${key}`);
    }
    assertNoPromotionFields(child, `${path}.${key}`);
  }
}

// @req PERF-BGSTAB-008
function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => compareCodeUnits(left, right))
        .map(([key, child]) => [key, sortJsonValue(child)]),
    );
  }
  return value;
}

// @req PERF-BGSTAB-008
function compareCodeUnits(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

// @req PERF-BGSTAB-008
function assertAllowedKeys(record: Record<string, unknown>, allowed: string[], path: string): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`Forbidden or unknown field at ${path}.${key}`);
    }
  }
}

// @req PERF-BGSTAB-008
function requireStringArray(value: unknown, path: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.length === 0)) {
    throw new Error(`${path} must be an array of non-empty strings`);
  }
}

// @req PERF-BGSTAB-008
function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

// @req PERF-BGSTAB-008
function requireNonEmptyString(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
}

// @req PERF-BGSTAB-008
function requireFiniteNumber(value: unknown, path: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${path} must be a finite number`);
  }
}

// @req PERF-BGSTAB-008
function requireNonNegativeNumber(value: unknown, path: string): void {
  requireFiniteNumber(value, path);
  if (value < 0) {
    throw new Error(`${path} must be non-negative`);
  }
}

// @req PERF-BGSTAB-008
function requirePositiveNumber(value: unknown, path: string): void {
  requireFiniteNumber(value, path);
  if (value <= 0) {
    throw new Error(`${path} must be positive`);
  }
}

// @req PERF-BGSTAB-008
function requireInteger(value: unknown, path: string, expected?: number): void {
  requireFiniteNumber(value, path);
  if (!Number.isInteger(value) || (expected !== undefined && value !== expected)) {
    throw new Error(`${path} must be ${expected ?? 'an integer'}`);
  }
}

// @req PERF-BGSTAB-008
function requirePositiveInteger(value: unknown, path: string): void {
  requireInteger(value, path);
  if ((value as number) <= 0) {
    throw new Error(`${path} must be a positive integer`);
  }
}

// @req PERF-BGSTAB-008
function requireNonNegativeInteger(value: unknown, path: string): void {
  requireInteger(value, path);
  if ((value as number) < 0) {
    throw new Error(`${path} must be a non-negative integer`);
  }
}
