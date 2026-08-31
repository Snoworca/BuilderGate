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
  schemaVersion: 1;
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

// @req PERF-BGSTAB-008
export function validateExecutionManifest(value: unknown): asserts value is BenchmarkExecutionManifest {
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
  ], 'manifest');
  requireInteger(manifest.schemaVersion, 'schemaVersion', 1);
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
