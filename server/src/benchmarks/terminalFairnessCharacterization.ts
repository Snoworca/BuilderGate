import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFairTerminalDeliveryScheduler, createWsTransportMessage } from '../ws/wsSendPolicy.js';
import { resolveFairTerminalDeliveryPolicy } from '../services/TerminalResourcePolicy.js';
import type { RuntimeConfigStore } from '../services/RuntimeConfigStore.js';
import { FAIR_SCHEDULER_AUTHORITY_LOGICAL_LOCATOR } from './fairSchedulerAuthorityLocator.js';

// @req PERF-BGSTAB-010 AC-2 AC-3 AC-4
const SCHEMA_VERSION = 'fair-scheduler-decision/v1' as const;
const PRNG = Object.freeze({
  algorithm: 'xorshift32',
  version: 1,
  derivation: 'fnv1a-root-seed/trial/client/lane/fault',
});
const CONTRACT_SOURCE = 'fair-scheduler-contract/v1';
const BENCHMARK_SOURCE = 'terminalFairnessCharacterization/v1';

export interface FairSchedulerBenchmarkInput {
  clients: readonly number[];
  wanLatencyMs: number;
  wanJitterMs: number;
  wanLossPercent: number;
  seed: number;
  repeats: number;
  samples: number;
}

export interface FairSchedulerRuntimePolicyProfile {
  schemaVersion: 'fair-scheduler-runtime-policy-profile/v1';
  authority: 'runtime-config-store/v1';
  policy: ReturnType<typeof resolveFairTerminalDeliveryPolicy>;
  policyHash: string;
  profileHash: string;
}

type FairSchedulerBenchmarkRunInput = FairSchedulerBenchmarkInput & {
  runtimePolicyProfile?: FairSchedulerRuntimePolicyProfile;
};

interface FairSchedulerMetrics {
  enqueueToFirstServiceMs: number;
  enqueueToCompleteMs: number;
  maxNoServiceIntervalMs: number;
  controlLatencyMs: number;
  peakApplicationQueuedBytes: number;
  peakSocketQueuedBytes: number;
  throughputBytesPerSecond: number;
  ackFaultRejectionCount: number;
  creditExhaustionObserved: boolean;
}

interface FairSchedulerRawSample extends FairSchedulerMetrics {
  clientCount: number;
  trial: number;
  sample: number;
  client: number;
  lane: 'flood' | 'normal';
  jitterMs: number;
  ackFault: 'duplicate' | 'stale' | 'out-of-order';
  baseline: FairSchedulerMetrics;
  orcaHoldBypass: FairSchedulerMetrics;
  candidate: FairSchedulerMetrics;
}

interface FairSchedulerRawArtifacts {
  schemaVersion: 'fair-scheduler-raw/v1';
  execution: 'scheduler-execution';
  workload: FairSchedulerBenchmarkInput;
  runtimePolicyProfile: FairSchedulerRuntimePolicyProfile;
  samples: FairSchedulerRawSample[];
  trialSchedules: Array<{
    clientCount: number;
    trial: number;
    seed: number;
    jitterScheduleDigest: string;
    ackFaultScheduleDigest: string;
  }>;
}

type FairSchedulerThreshold = {
  comparator: 'max' | 'min';
  exact: number;
  tolerance: number;
  baselineRegressionTolerance: number;
  regressionToleranceKind: 'absolute' | 'ratio';
  source: string;
};

export interface FairSchedulerDecisionArtifact {
  schemaVersion: typeof SCHEMA_VERSION;
  state: 'complete';
  workload: {
    clients: number[];
    wan: { latencyMs: number; jitterMs: number; lossPercent: number };
    seed: number;
    repeats: number;
    samples: number;
  };
  prng: typeof PRNG & { rootSeed: number };
  workloadSchemaHash: string;
  configHash: string;
  policyHash: string;
  policy: ReturnType<typeof resolveFairTerminalDeliveryPolicy>;
  runtimePolicyProfile: FairSchedulerRuntimePolicyProfile;
  sourceDigest: string;
  rawEvidencePaths: string[];
  rawEvidenceDigest: string;
  rawSampleCount: number;
  baseline: 'fifo';
  baselines: ['fifo', 'orca-hold-bypass'];
  candidate: 'deficit-round-robin';
  sampleCount: number;
  aggregation: {
    laneMetrics: Record<string, Record<string, { p50: number; p95: number; p99: number; max: number }>>;
    baselineLaneMetrics: Record<string, Record<string, { p50: number; p95: number; p99: number; max: number }>>;
    orcaHoldBypassLaneMetrics: Record<string, Record<string, { p50: number; p95: number; p99: number; max: number }>>;
    clientAggregate: Record<string, { p50: number; p95: number; p99: number; max: number }>;
  };
  thresholds: Record<string, FairSchedulerThreshold>;
  allRegisteredThresholdsPassed: boolean;
  hasUnboundedEligibleLaneStarvation: boolean;
  validatorVerdict: 'accept' | 'reject';
  accepted: boolean;
  promotionAllowed: boolean;
  reason: 'all-registered-thresholds-passed' | 'registered-thresholds-failed';
  stagingValidated?: boolean;
  digest?: string;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value)).digest('hex');
}

function requirePositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`);
}

function validateInput(input: FairSchedulerBenchmarkInput): void {
  const expectedClients = [1, 2, 8];
  if (!Array.isArray(input.clients) || input.clients.length !== expectedClients.length
    || input.clients.some((value, index) => value !== expectedClients[index])) {
    throw new Error('clients must be exactly 1,2,8');
  }
  for (const [name, value] of Object.entries({
    wanLatencyMs: input.wanLatencyMs,
    wanJitterMs: input.wanJitterMs,
    seed: input.seed,
    repeats: input.repeats,
    samples: input.samples,
  })) requirePositiveInteger(value, name);
  if (!Number.isFinite(input.wanLossPercent) || input.wanLossPercent !== 0) {
    throw new Error('wanLossPercent must be 0 for the registered profile');
  }
}

function fnv1a(seed: number, path: string): number {
  let value = seed >>> 0;
  for (let index = 0; index < path.length; index += 1) {
    value = Math.imul(value ^ path.charCodeAt(index), 0x01000193) >>> 0;
  }
  return value || 1;
}

function createXorshift32(seed: number): () => number {
  let state = seed >>> 0 || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index];
}

function percentileMatrix(values: readonly number[]): { p50: number; p95: number; p99: number; max: number } {
  return {
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
    max: values.length === 0 ? 0 : Math.max(...values),
  };
}

const FAIR_SCHEDULER_SOURCE_PROVENANCE_SCHEMA_VERSION = 'fair-scheduler-source-provenance/v1' as const;
const FAIR_SCHEDULER_SOURCE_PROVENANCE_INPUTS = [
  'src/benchmarks/terminalFairnessCharacterization.ts',
  'src/benchmarks/fairSchedulerAuthorityLocator.ts',
  'src/ws/wsSendPolicy.ts',
  'src/ws/WsRouter.ts',
  'src/services/TerminalResourcePolicy.ts',
  'src/services/TerminalResourcePolicyCanary.ts',
] as const;

type FairSchedulerSourceProvenance = {
  schemaVersion: typeof FAIR_SCHEDULER_SOURCE_PROVENANCE_SCHEMA_VERSION;
  inputs: Array<{ path: string; sha256: string }>;
  sourceDigest: string;
  manifestDigest: string;
};

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function hasSymbolicLinkAncestor(filePath: string): boolean {
  let candidate = resolve(filePath);
  while (true) {
    if (existsSync(candidate) && lstatSync(candidate).isSymbolicLink()) return true;
    const parent = dirname(candidate);
    if (parent === candidate) return false;
    candidate = parent;
  }
}

export function hasFairSchedulerPublicationGenerationLayout(
  generationId: unknown,
  evidencePaths: readonly unknown[],
): boolean {
  if (!isSha256(generationId)) return false;
  const generationPrefix = `fair-scheduler-publications/${generationId}/`;
  return evidencePaths.every(path => typeof path === 'string' && path.startsWith(generationPrefix));
}

function canonicalSourcePaths(serverRoot: string): readonly string[] {
  return FAIR_SCHEDULER_SOURCE_PROVENANCE_INPUTS.map(path => resolve(serverRoot, path));
}

export function validateFairSchedulerSourceProvenanceManifest(value: unknown):
  | { accepted: true; sourceDigest: string }
  | { accepted: false; reason: 'source-provenance-invalid' } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { accepted: false, reason: 'source-provenance-invalid' };
  }
  const manifest = value as Partial<FairSchedulerSourceProvenance>;
  if (
    manifest.schemaVersion !== FAIR_SCHEDULER_SOURCE_PROVENANCE_SCHEMA_VERSION
    || !Array.isArray(manifest.inputs)
    || !isSha256(manifest.sourceDigest)
    || !isSha256(manifest.manifestDigest)
    || manifest.inputs.length !== FAIR_SCHEDULER_SOURCE_PROVENANCE_INPUTS.length
  ) {
    return { accepted: false, reason: 'source-provenance-invalid' };
  }
  for (const [index, input] of manifest.inputs.entries()) {
    if (
      input === null
      || typeof input !== 'object'
      || Array.isArray(input)
      || (input as { path?: unknown }).path !== FAIR_SCHEDULER_SOURCE_PROVENANCE_INPUTS[index]
      || !isSha256((input as { sha256?: unknown }).sha256)
    ) {
      return { accepted: false, reason: 'source-provenance-invalid' };
    }
  }
  const { manifestDigest: suppliedManifestDigest, ...unsignedManifest } = manifest;
  if (digest(unsignedManifest) !== suppliedManifestDigest) {
    return { accepted: false, reason: 'source-provenance-invalid' };
  }
  return { accepted: true, sourceDigest: manifest.sourceDigest };
}

export function getFairSchedulerBenchmarkSourceDigest(): string {
  const current = fileURLToPath(import.meta.url);
  const serverRoot = resolve(dirname(current), '../..');
  const runtimeRelativePath = relative(serverRoot, current).replace(/\\/gu, '/');
  if (runtimeRelativePath.startsWith('src/')) {
    return digest(canonicalSourcePaths(serverRoot).map(source => readFileSync(source, 'utf8')));
  }
  if (runtimeRelativePath === 'dist/benchmarks/terminalFairnessCharacterization.js') {
    const manifestPath = resolve(dirname(current), 'fair-scheduler-source-provenance.json');
    if (!existsSync(manifestPath) || hasSymbolicLinkAncestor(manifestPath)) {
      throw new Error('fair scheduler source provenance manifest missing');
    }
    const validation = validateFairSchedulerSourceProvenanceManifest(
      JSON.parse(readFileSync(manifestPath, 'utf8')),
    );
    if (!validation.accepted) {
      throw new Error(`fair scheduler source provenance rejected: ${validation.reason}`);
    }
    return validation.sourceDigest;
  }
  throw new Error(`fair scheduler source provenance runtime is unsupported: ${runtimeRelativePath}`);
}

export function resolveFairSchedulerEvidenceRoot(): string {
  const current = fileURLToPath(import.meta.url);
  const serverRoot = resolve(dirname(current), '../..');
  const runtimeRelativePath = relative(serverRoot, current).replace(/\\/gu, '/');
  if (runtimeRelativePath.startsWith('src/')) {
    return resolve(serverRoot, '../docs/analysis/terminal-fairness-authority');
  }
  if (runtimeRelativePath === 'dist/benchmarks/terminalFairnessCharacterization.js') {
    return resolve(dirname(current), 'fair-scheduler-evidence');
  }
  throw new Error(`fair scheduler evidence runtime is unsupported: ${runtimeRelativePath}`);
}

const FAIR_SCHEDULER_CURRENT_AUTHORITY_SCHEMA_VERSION = 'fair-scheduler-current-authority/v1' as const;
const FAIR_SCHEDULER_AUTHORITY_PROVENANCE_SCHEMA_VERSION = 'fair-scheduler-source-provenance/v1' as const;
const FAIR_SCHEDULER_AUTHORITY_RAW_MANIFEST_SCHEMA_VERSION = 'fair-scheduler-raw-manifest/v1' as const;
const FAIR_SCHEDULER_AUTHORITY_ROOT_PATH = 'docs/analysis/terminal-fairness-authority' as const;
const FAIR_SCHEDULER_AUTHORITY_GENERATIONS_PATH = 'generations' as const;
const FAIR_SCHEDULER_AUTHORITY_DECISION_PATH = 'fair-scheduler-decision.json' as const;
const FAIR_SCHEDULER_AUTHORITY_PROVENANCE_PATH = 'provenance.json' as const;
const FAIR_SCHEDULER_AUTHORITY_RAW_ROOT = 'raw/' as const;
const FAIR_SCHEDULER_AUTHORITY_RAW_MANIFEST_PATH = 'raw/manifest.json' as const;

export interface FairSchedulerEvidenceAuthorityLocator {
  authorityRoot: string;
  locatorPath: string;
  logicalLocator: typeof FAIR_SCHEDULER_AUTHORITY_LOGICAL_LOCATOR;
}

export type FairSchedulerEvidenceAuthorityResolution =
  | {
    accepted: true;
    evidenceRoot: string;
    generationId: string;
    locatorPath: string;
    logicalLocator: typeof FAIR_SCHEDULER_AUTHORITY_LOGICAL_LOCATOR;
    publicationGeneration: string;
    reason: 'authority-locator-verified';
  }
  | { accepted: false; reason: string };

export interface FairSchedulerEvidenceAuthorityResolver {
  getLocator(): FairSchedulerEvidenceAuthorityLocator;
  validate(input?: { expectedPolicyDigest?: string }): FairSchedulerEvidenceAuthorityResolution;
}

type FairSchedulerAuthorityManifestEntry = Record<string, unknown> & {
  path: string;
  sha256: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasRequiredFields(record: Record<string, unknown>, fields: readonly string[]): boolean {
  return fields.every(field => Object.prototype.hasOwnProperty.call(record, field));
}

function isContainedPath(root: string, candidate: string): boolean {
  const containedPath = relative(root, candidate);
  return !(
    containedPath.length === 0
    || isAbsolute(containedPath)
    || containedPath === '..'
    || containedPath.startsWith(`..${sep}`)
  );
}

function isSafeAuthorityFileReference(value: unknown): value is string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.includes('\\')
    || value.includes('\0')
    || isAbsolute(value)
    || win32.isAbsolute(value)
    || value.startsWith('./')
  ) return false;
  return value.split('/').every(segment => segment.length > 0 && segment !== '.' && segment !== '..');
}

function isSafeAuthorityDirectoryReference(value: unknown): value is string {
  if (typeof value !== 'string' || !value.endsWith('/')) return false;
  return isSafeAuthorityFileReference(value.slice(0, -1));
}

function resolveAuthorityReference(root: string, declaredPath: string, directory = false): string | undefined {
  const relativePath = directory ? declaredPath.slice(0, -1) : declaredPath;
  const resolvedPath = resolve(root, ...relativePath.split('/'));
  return isContainedPath(root, resolvedPath) ? resolvedPath : undefined;
}

function hasAuthorityLinkOrReparsePoint(path: string): boolean {
  try {
    return hasSymbolicLinkAncestor(path);
  } catch {
    return true;
  }
}

function readAuthorityJson(path: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function readAuthorityText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

function normalizeAuthorityManifestEntries(value: unknown): FairSchedulerAuthorityManifestEntry[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries: FairSchedulerAuthorityManifestEntry[] = [];
  const seenPaths = new Set<string>();
  for (const entry of value) {
    if (!isRecord(entry) || !hasRequiredFields(entry, ['path', 'sha256'])) return undefined;
    if (!isSafeAuthorityFileReference(entry.path) || !entry.path.startsWith(FAIR_SCHEDULER_AUTHORITY_RAW_ROOT)) {
      return undefined;
    }
    if (!isSha256(entry.sha256) || seenPaths.has(entry.path)) return undefined;
    seenPaths.add(entry.path);
    entries.push(entry as FairSchedulerAuthorityManifestEntry);
  }
  return entries;
}

function hasExactAuthorityRawInventory(input: {
  rawRoot: string;
  rawManifestPath: string;
  entries: readonly FairSchedulerAuthorityManifestEntry[];
}): 'accepted' | 'link-or-reparse' | 'missing' | 'sha256-mismatch' | 'unmanifested' {
  const expected = new Set(input.entries.map(entry => entry.path));
  const observed = new Set<string>();
  const visit = (directory: string): 'accepted' | 'link-or-reparse' | 'unmanifested' => {
    let children: string[];
    try {
      children = readdirSync(directory);
    } catch {
      return 'unmanifested';
    }
    for (const child of children) {
      const childPath = resolve(directory, child);
      if (hasAuthorityLinkOrReparsePoint(childPath)) return 'link-or-reparse';
      let childStat: ReturnType<typeof lstatSync>;
      try {
        childStat = lstatSync(childPath);
      } catch {
        return 'unmanifested';
      }
      if (childStat.isDirectory()) {
        const nested = visit(childPath);
        if (nested !== 'accepted') return nested;
        continue;
      }
      if (!childStat.isFile()) return 'unmanifested';
      if (childPath === input.rawManifestPath) continue;
      const rootRelativePath = relative(dirname(input.rawRoot), childPath).replace(/\\/gu, '/');
      observed.add(rootRelativePath);
    }
    return 'accepted';
  };

  for (const entry of input.entries) {
    const entryPath = resolveAuthorityReference(dirname(input.rawRoot), entry.path);
    if (!entryPath || hasAuthorityLinkOrReparsePoint(entryPath)) {
      return hasAuthorityLinkOrReparsePoint(entryPath ?? input.rawRoot) ? 'link-or-reparse' : 'missing';
    }
    if (!existsSync(entryPath)) return 'missing';
    const contents = readAuthorityText(entryPath);
    if (contents === undefined) return 'missing';
    if (digest(contents) !== entry.sha256) return 'sha256-mismatch';
  }

  const visitResult = visit(input.rawRoot);
  if (visitResult !== 'accepted') return visitResult;
  return expected.size === observed.size && [...expected].every(path => observed.has(path))
    ? 'accepted'
    : 'unmanifested';
}

function isAuthorityManifestEntryReference(value: unknown): value is string {
  return isSafeAuthorityFileReference(value) && value.startsWith(FAIR_SCHEDULER_AUTHORITY_RAW_ROOT);
}

// @req PERF-BGSTAB-010 AC-3 AC-4
export function createFairSchedulerEvidenceAuthorityResolver(
  input: { repositoryRoot?: string } = {},
): FairSchedulerEvidenceAuthorityResolver {
  const current = fileURLToPath(import.meta.url);
  const serverRoot = resolve(dirname(current), '../..');
  const runtimeRelativePath = relative(serverRoot, current).replace(/\\/gu, '/');
  const useCompiledAuthority = runtimeRelativePath === 'dist/benchmarks/terminalFairnessCharacterization.js';
  const unsupportedOptions = useCompiledAuthority
    ? Object.keys(input)
    : Object.keys(input).filter(key => key !== 'repositoryRoot');
  if (unsupportedOptions.length > 0) {
    throw new Error('authority resolver root option is unsupported');
  }
  const repositoryRoot = resolve(input.repositoryRoot ?? resolve(serverRoot, '..'));
  const authorityRoot = useCompiledAuthority
    ? resolve(dirname(current), 'fair-scheduler-evidence')
    : resolve(repositoryRoot, ...FAIR_SCHEDULER_AUTHORITY_ROOT_PATH.split('/'));
  const locatorPath = resolve(authorityRoot, 'current.json');
  const getLocator = (): FairSchedulerEvidenceAuthorityLocator => ({
    authorityRoot,
    locatorPath,
    logicalLocator: FAIR_SCHEDULER_AUTHORITY_LOGICAL_LOCATOR,
  });

  return Object.freeze({
    getLocator,
    validate({ expectedPolicyDigest }: { expectedPolicyDigest: string }): FairSchedulerEvidenceAuthorityResolution {
      if (hasAuthorityLinkOrReparsePoint(locatorPath)) {
        return { accepted: false, reason: 'authority-reference-link-or-reparse-point-detected' };
      }
      if (!existsSync(locatorPath)) return { accepted: false, reason: 'authority-pointer-missing' };
      const pointer = readAuthorityJson(locatorPath);
      if (!pointer) return { accepted: false, reason: 'authority-pointer-invalid-json' };
      if (!hasRequiredFields(pointer, [
        'schema_version',
        'generation_id',
        'publication_generation',
        'decision_artifact',
        'decision_sha256',
        'provenance_artifact',
        'provenance_sha256',
        'raw_root',
        'raw_manifest_sha256',
      ])) return { accepted: false, reason: 'authority-pointer-required-field-missing' };
      if (pointer.schema_version !== FAIR_SCHEDULER_CURRENT_AUTHORITY_SCHEMA_VERSION) {
        return { accepted: false, reason: 'authority-pointer-schema-invalid' };
      }
      if (!isSha256(pointer.generation_id)) return { accepted: false, reason: 'authority-generation-id-invalid' };
      if (typeof pointer.publication_generation !== 'string' || pointer.publication_generation.length === 0) {
        return { accepted: false, reason: 'authority-pointer-required-field-missing' };
      }
      if (pointer.publication_generation !== pointer.generation_id) {
        return { accepted: false, reason: 'authority-publication-generation-mismatch' };
      }
      if (!isSafeAuthorityFileReference(pointer.decision_artifact)
        || !isSafeAuthorityFileReference(pointer.provenance_artifact)
        || !isSafeAuthorityDirectoryReference(pointer.raw_root)) {
        return { accepted: false, reason: 'authority-pointer-reference-invalid' };
      }
      if (pointer.decision_artifact !== FAIR_SCHEDULER_AUTHORITY_DECISION_PATH
        || pointer.provenance_artifact !== FAIR_SCHEDULER_AUTHORITY_PROVENANCE_PATH
        || pointer.raw_root !== FAIR_SCHEDULER_AUTHORITY_RAW_ROOT) {
        return { accepted: false, reason: 'authority-pointer-canonical-path-mismatch' };
      }
      if (!isSha256(pointer.decision_sha256)) return { accepted: false, reason: 'authority-decision-sha256-format-invalid' };
      if (!isSha256(pointer.provenance_sha256)) return { accepted: false, reason: 'authority-provenance-sha256-format-invalid' };
      if (!isSha256(pointer.raw_manifest_sha256)) return { accepted: false, reason: 'authority-raw-manifest-sha256-format-invalid' };

      const generationRoot = resolve(authorityRoot, FAIR_SCHEDULER_AUTHORITY_GENERATIONS_PATH, pointer.generation_id);
      if (hasAuthorityLinkOrReparsePoint(generationRoot)) {
        return { accepted: false, reason: 'authority-reference-link-or-reparse-point-detected' };
      }
      if (!existsSync(generationRoot)) return { accepted: false, reason: 'authority-generation-directory-mismatch' };
      try {
        if (!lstatSync(generationRoot).isDirectory()) {
          return { accepted: false, reason: 'authority-generation-directory-mismatch' };
        }
      } catch {
        return { accepted: false, reason: 'authority-generation-directory-mismatch' };
      }

      const decisionPath = resolveAuthorityReference(generationRoot, pointer.decision_artifact);
      const provenancePath = resolveAuthorityReference(generationRoot, pointer.provenance_artifact);
      const rawRoot = resolveAuthorityReference(generationRoot, pointer.raw_root, true);
      const rawManifestPath = resolveAuthorityReference(generationRoot, FAIR_SCHEDULER_AUTHORITY_RAW_MANIFEST_PATH);
      if (!decisionPath || !provenancePath || !rawRoot || !rawManifestPath) {
        return { accepted: false, reason: 'authority-pointer-reference-invalid' };
      }
      if (hasAuthorityLinkOrReparsePoint(decisionPath)) {
        return { accepted: false, reason: 'authority-reference-link-or-reparse-point-detected' };
      }
      if (!existsSync(decisionPath)) return { accepted: false, reason: 'authority-decision-missing' };
      if (hasAuthorityLinkOrReparsePoint(provenancePath)) {
        return { accepted: false, reason: 'authority-reference-link-or-reparse-point-detected' };
      }
      if (!existsSync(provenancePath)) return { accepted: false, reason: 'authority-provenance-missing' };
      if (hasAuthorityLinkOrReparsePoint(rawManifestPath)) {
        return { accepted: false, reason: 'authority-reference-link-or-reparse-point-detected' };
      }
      if (!existsSync(rawManifestPath)) return { accepted: false, reason: 'authority-raw-manifest-missing' };

      const decisionText = readAuthorityText(decisionPath);
      if (decisionText === undefined || digest(decisionText) !== pointer.decision_sha256) {
        return { accepted: false, reason: 'authority-decision-sha256-mismatch' };
      }
      if (!readAuthorityJson(decisionPath)) return { accepted: false, reason: 'authority-decision-invalid-json' };
      const provenanceText = readAuthorityText(provenancePath);
      if (provenanceText === undefined || digest(provenanceText) !== pointer.provenance_sha256) {
        return { accepted: false, reason: 'authority-provenance-sha256-mismatch' };
      }
      const provenance = readAuthorityJson(provenancePath);
      if (!provenance) return { accepted: false, reason: 'authority-provenance-invalid-json' };
      if (!hasRequiredFields(provenance, [
        'schema_version',
        'generation_id',
        'canonical_locator',
        'publication_generation',
        'decision_path',
        'decision_sha256',
        'provenance_path',
        'raw_root',
        'raw_manifest_path',
        'raw_manifest_sha256',
        'policy_digest',
        'trial_inventory',
      ])) return { accepted: false, reason: 'authority-provenance-required-field-missing' };
      if (provenance.schema_version !== FAIR_SCHEDULER_AUTHORITY_PROVENANCE_SCHEMA_VERSION) {
        return { accepted: false, reason: 'authority-provenance-schema-invalid' };
      }
      if (!isSha256(provenance.decision_sha256)) {
        return { accepted: false, reason: 'authority-provenance-sha256-format-invalid' };
      }
      if (!isSha256(provenance.raw_manifest_sha256)) {
        return { accepted: false, reason: 'authority-raw-manifest-sha256-format-invalid' };
      }
      if (!isSha256(provenance.policy_digest)) {
        return { accepted: false, reason: 'authority-policy-digest-format-invalid' };
      }
      if (!isSafeAuthorityFileReference(provenance.decision_path)
        || !isSafeAuthorityFileReference(provenance.provenance_path)
        || !isSafeAuthorityDirectoryReference(provenance.raw_root)
        || !isSafeAuthorityFileReference(provenance.raw_manifest_path)) {
        return { accepted: false, reason: 'authority-provenance-reference-invalid' };
      }
      if (provenance.decision_path !== FAIR_SCHEDULER_AUTHORITY_DECISION_PATH
        || provenance.provenance_path !== FAIR_SCHEDULER_AUTHORITY_PROVENANCE_PATH
        || provenance.raw_root !== FAIR_SCHEDULER_AUTHORITY_RAW_ROOT
        || provenance.raw_manifest_path !== FAIR_SCHEDULER_AUTHORITY_RAW_MANIFEST_PATH) {
        return { accepted: false, reason: 'authority-provenance-canonical-path-mismatch' };
      }
      if (provenance.generation_id !== pointer.generation_id) {
        return { accepted: false, reason: 'authority-provenance-generation-mismatch' };
      }
      if (provenance.publication_generation !== pointer.publication_generation) {
        return { accepted: false, reason: 'authority-provenance-publication-generation-mismatch' };
      }
      if (provenance.canonical_locator !== FAIR_SCHEDULER_AUTHORITY_LOGICAL_LOCATOR) {
        return { accepted: false, reason: 'authority-provenance-canonical-locator-mismatch' };
      }
      if (provenance.decision_sha256 !== pointer.decision_sha256) {
        return { accepted: false, reason: 'authority-decision-sha256-mismatch' };
      }

      const rawManifestText = readAuthorityText(rawManifestPath);
      if (rawManifestText === undefined
        || digest(rawManifestText) !== pointer.raw_manifest_sha256
        || provenance.raw_manifest_sha256 !== pointer.raw_manifest_sha256) {
        return { accepted: false, reason: 'authority-raw-manifest-sha256-mismatch' };
      }
      const rawManifest = readAuthorityJson(rawManifestPath);
      if (!rawManifest) return { accepted: false, reason: 'authority-raw-manifest-invalid-json' };
      if (!hasRequiredFields(rawManifest, ['schema_version', 'generation_id', 'entries'])) {
        return { accepted: false, reason: 'authority-raw-manifest-required-field-missing' };
      }
      if (rawManifest.schema_version !== FAIR_SCHEDULER_AUTHORITY_RAW_MANIFEST_SCHEMA_VERSION) {
        return { accepted: false, reason: 'authority-raw-manifest-schema-invalid' };
      }
      if (rawManifest.generation_id !== pointer.generation_id) {
        return { accepted: false, reason: 'authority-raw-manifest-generation-mismatch' };
      }
      if (!Array.isArray(rawManifest.entries)) {
        return { accepted: false, reason: 'authority-raw-manifest-required-field-missing' };
      }
      for (const entry of rawManifest.entries) {
        if (!isRecord(entry) || !hasRequiredFields(entry, ['path', 'sha256'])) {
          return { accepted: false, reason: 'authority-raw-entry-required-field-missing' };
        }
        if (!isAuthorityManifestEntryReference(entry.path)) {
          return { accepted: false, reason: 'authority-raw-entry-reference-invalid' };
        }
        if (!isSha256(entry.sha256)) return { accepted: false, reason: 'authority-raw-entry-sha256-format-invalid' };
      }
      const rawEntries = normalizeAuthorityManifestEntries(rawManifest.entries);
      if (!rawEntries) return { accepted: false, reason: 'authority-raw-entry-reference-invalid' };
      const trialInventory = normalizeAuthorityManifestEntries(provenance.trial_inventory);
      if (!trialInventory) return { accepted: false, reason: 'authority-provenance-required-field-missing' };
      if (expectedPolicyDigest !== undefined && provenance.policy_digest !== expectedPolicyDigest) {
        return { accepted: false, reason: 'authority-policy-digest-mismatch' };
      }

      const rawInventory = hasExactAuthorityRawInventory({ rawRoot, rawManifestPath, entries: rawEntries });
      if (rawInventory === 'link-or-reparse') {
        return { accepted: false, reason: 'authority-reference-link-or-reparse-point-detected' };
      }
      if (rawInventory === 'missing') return { accepted: false, reason: 'authority-raw-entry-missing' };
      if (rawInventory === 'sha256-mismatch') return { accepted: false, reason: 'authority-raw-entry-sha256-mismatch' };
      if (rawInventory === 'unmanifested') return { accepted: false, reason: 'authority-raw-entry-unmanifested' };

      const rawEntriesDigest = digest(rawEntries);
      const rederivedGenerationId = digest({
        schema_version: pointer.schema_version,
        decision_sha256: pointer.decision_sha256,
        raw_entries_digest: rawEntriesDigest,
        policy_digest: provenance.policy_digest,
        trial_inventory: trialInventory,
      });
      if (rederivedGenerationId !== pointer.generation_id) {
        return { accepted: false, reason: 'authority-generation-id-mismatch' };
      }
      return {
        accepted: true,
        evidenceRoot: generationRoot,
        generationId: pointer.generation_id,
        locatorPath,
        logicalLocator: FAIR_SCHEDULER_AUTHORITY_LOGICAL_LOCATOR,
        publicationGeneration: pointer.publication_generation,
        reason: 'authority-locator-verified',
      };
    },
  });
}

export function validateFairSchedulerEvidenceReference(root: string, declaredPath: string):
  | { accepted: true; resolvedPath: string }
  | { accepted: false; reason: 'evidence-reference-invalid' } {
  if (
    typeof declaredPath !== 'string'
    || declaredPath.length === 0
    || declaredPath.includes('\\')
    || declaredPath.includes('\0')
    || isAbsolute(declaredPath)
    || win32.isAbsolute(declaredPath)
    || declaredPath.startsWith('./')
    || declaredPath.split('/').some(segment => segment.length === 0 || segment === '.' || segment === '..')
  ) return { accepted: false, reason: 'evidence-reference-invalid' };
  const resolvedPath = resolve(root, ...declaredPath.split('/'));
  if (hasSymbolicLinkAncestor(resolvedPath)) {
    return { accepted: false, reason: 'evidence-reference-invalid' };
  }
  const containedPath = relative(root, resolvedPath);
  if (
    containedPath.length === 0
    || isAbsolute(containedPath)
    || containedPath === '..'
    || containedPath.startsWith(`..${sep}`)
  ) return { accepted: false, reason: 'evidence-reference-invalid' };
  if (existsSync(root) && existsSync(resolvedPath)) {
    const realRoot = realpathSync(root);
    const realPath = realpathSync(resolvedPath);
    const realRelativePath = relative(realRoot, realPath);
    if (
      isAbsolute(realRelativePath)
      || realRelativePath === '..'
      || realRelativePath.startsWith(`..${sep}`)
    ) return { accepted: false, reason: 'evidence-reference-invalid' };
  }
  return { accepted: true, resolvedPath };
}

function equalPathSets(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every(path => right.has(path));
}

export function hasExactFairSchedulerEvidenceGenerationInventory(input: {
  artifactRoot: string;
  generationId: unknown;
  evidencePaths: readonly unknown[];
}): boolean {
  if (!hasFairSchedulerPublicationGenerationLayout(input.generationId, input.evidencePaths)) return false;
  const generationDirectory = `fair-scheduler-publications/${input.generationId}`;
  const generationReference = validateFairSchedulerEvidenceReference(input.artifactRoot, generationDirectory);
  if (!generationReference.accepted) return false;
  const generationPrefix = `${generationDirectory}/`;
  const expectedFiles = new Set(input.evidencePaths.map(path => (
    (path as string).slice(generationPrefix.length)
  )));
  const expectedDirectories = new Set<string>();
  for (const filePath of expectedFiles) {
    const segments = filePath.split('/');
    segments.pop();
    while (segments.length > 0) {
      expectedDirectories.add(segments.join('/'));
      segments.pop();
    }
  }
  const observedFiles = new Set<string>();
  const observedDirectories = new Set<string>();
  const visit = (directory: string, directoryRelativePath: string): boolean => {
    let entries: string[];
    try {
      entries = readdirSync(directory);
    } catch {
      return false;
    }
    for (const entry of entries) {
      const childPath = resolve(directory, entry);
      const childRelativePath = directoryRelativePath.length === 0
        ? entry
        : `${directoryRelativePath}/${entry}`;
      let stat: ReturnType<typeof lstatSync>;
      try {
        stat = lstatSync(childPath);
      } catch {
        return false;
      }
      if (stat.isSymbolicLink()) return false;
      if (stat.isDirectory()) {
        observedDirectories.add(childRelativePath);
        if (!visit(childPath, childRelativePath)) return false;
      } else if (stat.isFile()) {
        observedFiles.add(childRelativePath);
      } else {
        return false;
      }
    }
    return true;
  };
  return visit(generationReference.resolvedPath, '')
    && equalPathSets(expectedFiles, observedFiles)
    && equalPathSets(expectedDirectories, observedDirectories);
}

function hasIdenticalFairSchedulerEvidenceGeneration(input: {
  stagedRoot: string;
  outputRoot: string;
  generationId: string;
  evidencePaths: readonly string[];
}): boolean {
  if (!hasExactFairSchedulerEvidenceGenerationInventory({
    artifactRoot: input.stagedRoot,
    generationId: input.generationId,
    evidencePaths: input.evidencePaths,
  }) || !hasExactFairSchedulerEvidenceGenerationInventory({
    artifactRoot: input.outputRoot,
    generationId: input.generationId,
    evidencePaths: input.evidencePaths,
  })) return false;
  for (const evidencePath of input.evidencePaths) {
    const stagedReference = validateFairSchedulerEvidenceReference(input.stagedRoot, evidencePath);
    const outputReference = validateFairSchedulerEvidenceReference(input.outputRoot, evidencePath);
    if (!stagedReference.accepted || !outputReference.accepted
      || !readFileSync(stagedReference.resolvedPath).equals(readFileSync(outputReference.resolvedPath))) {
      return false;
    }
  }
  return true;
}

function hasExpectedFairSchedulerEvidenceGeneration(input: {
  artifactRoot: string;
  generationId: string;
  evidencePaths: readonly string[];
  expectedContents: ReadonlyMap<string, string>;
}): boolean {
  if (input.expectedContents.size !== input.evidencePaths.length
    || !hasExactFairSchedulerEvidenceGenerationInventory({
      artifactRoot: input.artifactRoot,
      generationId: input.generationId,
      evidencePaths: input.evidencePaths,
    })) return false;
  for (const evidencePath of input.evidencePaths) {
    const reference = validateFairSchedulerEvidenceReference(input.artifactRoot, evidencePath);
    if (!reference.accepted || readFileSync(reference.resolvedPath, 'utf8') !== input.expectedContents.get(evidencePath)) {
      return false;
    }
  }
  return true;
}

export const FAIR_SCHEDULER_BENCHMARK_WS_LIMITS = Object.freeze({
  serverBufferedHighWaterBytes: 1_024,
  perClientOutputQueueMaxBytes: 4_096,
  perClientControlQueueMaxBytes: 1_024,
  outputCoalesceWindowMs: 1,
});

function createFairSchedulerRuntimePolicyProfileFromLimits(limits: {
  serverBufferedHighWaterBytes: number;
  perClientOutputQueueMaxBytes: number;
  perClientControlQueueMaxBytes: number;
  outputCoalesceWindowMs: number;
}): FairSchedulerRuntimePolicyProfile {
  const resolvedPolicy = resolveFairTerminalDeliveryPolicy(limits);
  const policy = Object.freeze(Object.fromEntries(
    Object.entries(resolvedPolicy).map(([name, value]) => [name, Object.freeze(structuredClone(value))]),
  )) as ReturnType<typeof resolveFairTerminalDeliveryPolicy>;
  const unsignedProfile = {
    schemaVersion: 'fair-scheduler-runtime-policy-profile/v1' as const,
    authority: 'runtime-config-store/v1' as const,
    policy,
    policyHash: digest(policy),
  };
  return Object.freeze({
    ...unsignedProfile,
    profileHash: digest(unsignedProfile),
  });
}

export function createFairSchedulerRuntimePolicyProfile(
  runtimeConfig: Pick<RuntimeConfigStore, 'getEditableValues'>,
): FairSchedulerRuntimePolicyProfile {
  return createFairSchedulerRuntimePolicyProfileFromLimits(
    runtimeConfig.getEditableValues().resourceLimits.ws,
  );
}

function validateFairSchedulerRuntimePolicyProfile(value: unknown):
  | { accepted: true; profile: FairSchedulerRuntimePolicyProfile }
  | { accepted: false } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { accepted: false };
  const profile = value as Partial<FairSchedulerRuntimePolicyProfile>;
  if (
    profile.schemaVersion !== 'fair-scheduler-runtime-policy-profile/v1'
    || profile.authority !== 'runtime-config-store/v1'
    || profile.policy === undefined
    || !isSha256(profile.policyHash)
    || !isSha256(profile.profileHash)
    || digest(profile.policy) !== profile.policyHash
  ) return { accepted: false };
  const { profileHash: suppliedProfileHash, ...unsignedProfile } = profile;
  if (digest(unsignedProfile) !== suppliedProfileHash) return { accepted: false };
  return { accepted: true, profile: profile as FairSchedulerRuntimePolicyProfile };
}

function getFixtureFairSchedulerRuntimePolicyProfile(): FairSchedulerRuntimePolicyProfile {
  return createFairSchedulerRuntimePolicyProfileFromLimits(FAIR_SCHEDULER_BENCHMARK_WS_LIMITS);
}

function resolveFairSchedulerRuntimePolicyProfile(
  profile?: FairSchedulerRuntimePolicyProfile,
): FairSchedulerRuntimePolicyProfile {
  const validation = validateFairSchedulerRuntimePolicyProfile(
    profile ?? getFixtureFairSchedulerRuntimePolicyProfile(),
  );
  if (!validation.accepted) throw new Error('fair scheduler runtime policy profile is invalid');
  return validation.profile;
}

export function getFairSchedulerBenchmarkPolicy(profile?: FairSchedulerRuntimePolicyProfile) {
  return resolveFairSchedulerRuntimePolicyProfile(profile).policy;
}

function getFairSchedulerThresholds(
  policy: ReturnType<typeof resolveFairTerminalDeliveryPolicy>,
): Record<string, FairSchedulerThreshold> {
  return {
    eligibleLaneServiceMs: {
      comparator: 'max', exact: 250, tolerance: 0,
      baselineRegressionTolerance: 50, regressionToleranceKind: 'absolute', source: CONTRACT_SOURCE,
    },
    eligibleLaneCompleteMs: {
      comparator: 'max', exact: 250, tolerance: 0,
      baselineRegressionTolerance: 50, regressionToleranceKind: 'absolute', source: CONTRACT_SOURCE,
    },
    eligibleLaneMaxNoServiceIntervalMs: {
      comparator: 'max', exact: 50, tolerance: 0,
      baselineRegressionTolerance: 50, regressionToleranceKind: 'absolute', source: CONTRACT_SOURCE,
    },
    controlLatencyMs: {
      comparator: 'max', exact: 30, tolerance: 0,
      baselineRegressionTolerance: 30, regressionToleranceKind: 'absolute', source: CONTRACT_SOURCE,
    },
    peakApplicationQueuedBytes: {
      comparator: 'max',
      exact: policy.queueMaxBytes.value,
      tolerance: 0,
      baselineRegressionTolerance: 0,
      regressionToleranceKind: 'absolute',
      source: policy.queueMaxBytes.source,
    },
    peakSocketQueuedBytes: {
      comparator: 'max',
      exact: policy.creditWindowBytes.value,
      tolerance: 0,
      baselineRegressionTolerance: 0,
      regressionToleranceKind: 'absolute',
      source: policy.creditWindowBytes.source,
    },
    aggregateThroughputBytesPerSecond: {
      comparator: 'min', exact: 1, tolerance: 0,
      baselineRegressionTolerance: 0.3, regressionToleranceKind: 'ratio', source: BENCHMARK_SOURCE,
    },
  };
}

function thresholdPasses(value: number, threshold: FairSchedulerThreshold): boolean {
  return threshold.comparator === 'max'
    ? value <= threshold.exact + threshold.tolerance
    : value >= threshold.exact - threshold.tolerance;
}

function benchmarkWorkload(input: FairSchedulerBenchmarkInput) {
  return {
    clients: [...input.clients],
    wan: { latencyMs: input.wanLatencyMs, jitterMs: input.wanJitterMs, lossPercent: input.wanLossPercent },
    seed: input.seed,
    repeats: input.repeats,
    samples: input.samples,
  };
}

export function getFairSchedulerBenchmarkContract(input: FairSchedulerBenchmarkInput = {
  clients: [1, 2, 8],
  wanLatencyMs: 150,
  wanJitterMs: 20,
  wanLossPercent: 0,
  seed: 20260723,
  repeats: 5,
  samples: 30,
}, runtimePolicyProfile?: FairSchedulerRuntimePolicyProfile) {
  validateInput(input);
  const workload = benchmarkWorkload(input);
  const profile = resolveFairSchedulerRuntimePolicyProfile(runtimePolicyProfile);
  const policy = profile.policy;
  return Object.freeze({
    workload,
    policy,
    runtimePolicyProfile: profile,
    workloadSchemaHash: digest({ schema: 'fair-scheduler-workload/v1', workload }),
    policyHash: digest(policy),
    configHash: digest({ workload, runtimePolicyProfile: profile }),
  });
}

function runCandidateWorkload(input: {
  clientCount: number;
  targetClient: number;
  latencyMs: number;
  ackFault: FairSchedulerRawSample['ackFault'];
  policy: ReturnType<typeof resolveFairTerminalDeliveryPolicy>;
}): FairSchedulerMetrics {
  let now = 0;
  const sent: Array<{ connectionEpoch: string; sessionId: string; deliverySeq: number; encodedBytes: number; kind: string }> = [];
  const { policy } = input;
  const scheduler = createFairTerminalDeliveryScheduler({
    now: () => now,
    policy,
    decisionArtifact: {
      state: 'complete' as const,
      allRegisteredThresholdsPassed: true,
      hasUnboundedEligibleLaneStarvation: false,
    },
    send(delivery) {
      sent.push(delivery);
      now += 1;
    },
    onSemanticStatusChange() {},
  });
  for (let index = 0; index < 3; index += 1) {
    scheduler.enqueue({
      connectionEpoch: 'client-0', sessionId: 'flood', kind: 'output', payload: `flood-${index}-${'x'.repeat(256)}`,
      serviceClass: 'driver', capabilities: { ackCredit: true, legacyFallback: false },
    });
  }
  for (let client = 0; client < input.clientCount; client += 1) {
    const sessionId = client === 0 ? 'flood' : `normal-${client}`;
    for (let index = 0; index < 2; index += 1) {
      scheduler.enqueue({
        connectionEpoch: `client-${client}`, sessionId, kind: 'output', payload: `${sessionId}-${index}-prompt> `,
        serviceClass: client === 0 ? 'driver' : 'visible', capabilities: { ackCredit: true, legacyFallback: false },
      });
    }
    scheduler.enqueue({
      connectionEpoch: `client-${client}`, sessionId, kind: 'control', payload: `${sessionId}-control`,
      serviceClass: client === 0 ? 'driver' : 'visible', capabilities: { ackCredit: true, legacyFallback: false },
    });
  }
  scheduler.drain();
  const measuredSessionId = input.targetClient === 0 ? 'flood' : `normal-${input.targetClient}`;
  const sessionId = 'a';
  const connectionEpoch = `client-${input.targetClient}`;
  const laneKey = `${connectionEpoch}/${sessionId}`;
  const targetDeliveries = () => sent.filter(delivery => (
    delivery.connectionEpoch === connectionEpoch && delivery.sessionId === sessionId
  ));
  const first = targetDeliveries()[0]?.deliverySeq ?? 1;

  // Small frames bypass the soft gate, so this loop fills the actual credit window
  // before exercising an invalid ACK. It stops with an unsent frame only when credit
  // is exhausted; each enqueue is kept below the application queue limit.
  const creditPayload = 'x'.repeat(Math.max(
    policy.smallOutputBypassBytes.value + 1,
    Math.floor(policy.creditWindowBytes.value / 32),
  ));
  const blockedSocketThreshold = Math.max(1, Math.min(
    policy.socketSoftGateBytes.value,
    policy.creditWindowBytes.value,
  ) - creditPayload.length - 1_024);
  let blockedByCredit = false;
  for (let index = 0; index < 64; index += 1) {
    const queued = scheduler.enqueue({
      connectionEpoch,
      sessionId,
      kind: 'output',
      payload: creditPayload,
      serviceClass: input.targetClient === 0 ? 'driver' : 'visible',
      capabilities: { ackCredit: true, legacyFallback: false },
    });
    if (!queued.accepted) {
      const lane = scheduler.snapshot().lanes[laneKey];
      if (lane && lane.queuedBytes > 0
        && lane.socketQueuedBytes >= blockedSocketThreshold) {
        blockedByCredit = true;
        break;
      }
      throw new Error('ACK fault workload unexpectedly overflowed its application queue');
    }
    scheduler.drain();
    const lane = scheduler.snapshot().lanes[laneKey];
    if (lane && lane.queuedBytes > 0
      && lane.socketQueuedBytes >= blockedSocketThreshold) {
      const queuedBehindFault = scheduler.enqueue({
        connectionEpoch,
        sessionId,
        kind: 'output',
        payload: creditPayload,
        serviceClass: input.targetClient === 0 ? 'driver' : 'visible',
        capabilities: { ackCredit: true, legacyFallback: false },
      });
      if (!queuedBehindFault.accepted) throw new Error('ACK fault workload could not retain output behind its blocked frame');
      blockedByCredit = true;
      break;
    }
  }
  if (!blockedByCredit) throw new Error('ACK fault workload did not exhaust the credit window');

  // A valid ACK opens exactly one small-frame credit slot. Draining refills it before
  // the malformed ACK is attempted, so a rejected ACK cannot release queued output.
  scheduler.acknowledge({ connectionEpoch, sessionId, deliverySeq: first });
  scheduler.drain();
  const beforeFault = scheduler.snapshot().lanes[laneKey];
  if (!beforeFault || beforeFault.queuedBytes === 0) {
    throw new Error('ACK fault workload did not remain blocked after its valid refill ACK');
  }
  const last = beforeFault.sentDeliverySeqs.at(-1) ?? first;
  if (input.ackFault === 'duplicate') {
    scheduler.acknowledge({ connectionEpoch, sessionId, deliverySeq: first });
  } else if (input.ackFault === 'stale') {
    scheduler.acknowledge({ connectionEpoch: `${connectionEpoch}-stale`, sessionId, deliverySeq: last });
  } else {
    scheduler.acknowledge({ connectionEpoch, sessionId, deliverySeq: last + 1 });
  }
  const afterFault = scheduler.snapshot().lanes[laneKey];
  const creditExhaustionObserved = blockedByCredit
    && afterFault?.queuedBytes === beforeFault.queuedBytes
    && afterFault.socketQueuedBytes === beforeFault.socketQueuedBytes;
  scheduler.acknowledge({ connectionEpoch, sessionId, deliverySeq: last });
  scheduler.drain();
  const finalSent = scheduler.snapshot().lanes[laneKey]?.sentDeliverySeqs.at(-1);
  if (finalSent !== undefined) scheduler.acknowledge({ connectionEpoch, sessionId, deliverySeq: finalSent });
  const snapshot = scheduler.snapshot();
  const lane = snapshot.metrics.lanes[`${connectionEpoch}/${measuredSessionId}`];
  const totalBytes = sent.reduce((total, delivery) => total + delivery.encodedBytes, 0);
  return {
    enqueueToFirstServiceMs: lane?.enqueueToFirstServiceMs.p95 ?? 0,
    enqueueToCompleteMs: lane?.enqueueToCompleteMs.p95 ?? 0,
    maxNoServiceIntervalMs: lane?.maxNoServiceIntervalMs ?? 0,
    controlLatencyMs: scheduler.snapshot().metrics.controlLatency.p95,
    peakApplicationQueuedBytes: lane?.peakApplicationQueuedBytes ?? 0,
    peakSocketQueuedBytes: lane?.peakSocketQueuedBytes ?? 0,
    throughputBytesPerSecond: totalBytes * 1_000 / Math.max(1, now + input.latencyMs),
    ackFaultRejectionCount: snapshot.protocolErrors.length,
    creditExhaustionObserved,
  };
}

interface BaselineQueueEntry {
  client: number;
  connectionEpoch: string;
  sessionId: string;
  kind: 'output' | 'control';
  bytes: number;
}

function createBaselineQueue(input: {
  clientCount: number;
}): BaselineQueueEntry[] {
  const queue: BaselineQueueEntry[] = [];
  const deliverySequences = new Map<string, number>();
  const append = (client: number, sessionId: string, kind: 'output' | 'control', payload: string) => {
    const connectionEpoch = `client-${client}`;
    const lane = `${connectionEpoch}/${sessionId}`;
    const deliverySeq = (deliverySequences.get(lane) ?? 0) + 1;
    deliverySequences.set(lane, deliverySeq);
    queue.push({
      client,
      connectionEpoch,
      sessionId,
      kind,
      bytes: createWsTransportMessage({
        type: 'output',
        sessionId,
        data: payload,
        connectionEpoch,
        deliverySeq,
        deliveryKind: kind,
      }).byteLength,
    });
  };
  for (let index = 0; index < 3; index += 1) {
    append(0, 'flood', 'output', `flood-${index}-${'x'.repeat(256)}`);
  }
  for (let client = 0; client < input.clientCount; client += 1) {
    const sessionId = client === 0 ? 'flood' : `normal-${client}`;
    append(client, sessionId, 'output', `${sessionId}-0-prompt> `);
    append(client, sessionId, 'output', `${sessionId}-1-prompt> `);
    append(client, sessionId, 'control', `${sessionId}-control`);
  }
  return queue;
}

function executeBaselineAckFault(
  queue: readonly BaselineQueueEntry[],
  input: { targetClient: number; ackFault: FairSchedulerRawSample['ackFault'] },
): number {
  const targetSession = input.targetClient === 0 ? 'flood' : `normal-${input.targetClient}`;
  const target = queue.filter(item => item.client === input.targetClient && item.sessionId === targetSession);
  const lastSequence = target.length;
  const acknowledged = new Set<number>();
  const acknowledge = (connectionEpoch: string, sessionId: string, deliverySeq: number) => {
    const expected = target[deliverySeq - 1];
    if (!expected || expected.connectionEpoch !== connectionEpoch || expected.sessionId !== sessionId
      || acknowledged.has(deliverySeq)) return false;
    acknowledged.add(deliverySeq);
    return true;
  };
  const connectionEpoch = `client-${input.targetClient}`;
  if (input.ackFault === 'duplicate') {
    acknowledge(connectionEpoch, targetSession, lastSequence);
    return acknowledge(connectionEpoch, targetSession, lastSequence) ? 0 : 1;
  }
  if (input.ackFault === 'stale') {
    const rejected = acknowledge(`${connectionEpoch}-stale`, targetSession, lastSequence) ? 0 : 1;
    acknowledge(connectionEpoch, targetSession, lastSequence);
    return rejected;
  }
  const rejected = acknowledge(connectionEpoch, targetSession, lastSequence + 1) ? 0 : 1;
  acknowledge(connectionEpoch, targetSession, lastSequence);
  return rejected;
}

function measureBaselineOrder(
  queue: readonly BaselineQueueEntry[],
  order: readonly BaselineQueueEntry[],
  input: { targetClient: number; latencyMs: number; ackFault: FairSchedulerRawSample['ackFault'] },
): FairSchedulerMetrics {
  const ackFaultRejectionCount = executeBaselineAckFault(queue, input);
  const targetSession = input.targetClient === 0 ? 'flood' : `normal-${input.targetClient}`;
  const firstIndex = order.findIndex(item => item.client === input.targetClient && item.sessionId === targetSession);
  const lastIndex = order.reduce((last, item, index) => (
    item.client === input.targetClient && item.sessionId === targetSession ? index : last
  ), firstIndex);
  const controlIndex = order.findIndex(item => item.kind === 'control');
  const totalBytes = order.reduce((total, item) => total + item.bytes, 0);
  return {
    enqueueToFirstServiceMs: Math.max(0, firstIndex),
    enqueueToCompleteMs: Math.max(0, lastIndex),
    maxNoServiceIntervalMs: Math.max(0, lastIndex - firstIndex),
    controlLatencyMs: Math.max(0, controlIndex),
    peakApplicationQueuedBytes: totalBytes,
    peakSocketQueuedBytes: totalBytes,
    throughputBytesPerSecond: totalBytes * 1_000 / Math.max(1, order.length + input.latencyMs),
    ackFaultRejectionCount,
    creditExhaustionObserved: false,
  };
}

function runFifoBaseline(input: {
  clientCount: number;
  targetClient: number;
  latencyMs: number;
  ackFault: FairSchedulerRawSample['ackFault'];
}): FairSchedulerMetrics {
  const queue = createBaselineQueue(input);
  return measureBaselineOrder(queue, queue, input);
}

function runOrcaHoldBypassBaseline(input: {
  clientCount: number;
  targetClient: number;
  latencyMs: number;
  ackFault: FairSchedulerRawSample['ackFault'];
  policy: ReturnType<typeof resolveFairTerminalDeliveryPolicy>;
}): FairSchedulerMetrics {
  const queue = createBaselineQueue(input);
  const smallOutputBypassBytes = input.policy.smallOutputBypassBytes.value;
  const bypass = queue.filter(item => item.kind === 'control' || item.bytes <= smallOutputBypassBytes);
  const held = queue.filter(item => !bypass.includes(item));
  return measureBaselineOrder(queue, [...bypass, ...held], input);
}

function createRawArtifacts(
  input: FairSchedulerBenchmarkInput,
  runtimePolicyProfile: FairSchedulerRuntimePolicyProfile,
): FairSchedulerRawArtifacts {
  const samples: FairSchedulerRawSample[] = [];
  const trialSchedules: FairSchedulerRawArtifacts['trialSchedules'] = [];
  for (const clientCount of input.clients) {
    for (let trial = 0; trial < input.repeats; trial += 1) {
      const trialSeed = fnv1a(input.seed, `trial/${clientCount}/${trial}`);
      const jitterSchedule: number[] = [];
      const ackFaultSchedule: string[] = [];
      for (let sample = 0; sample < input.samples; sample += 1) {
        for (let client = 0; client < clientCount; client += 1) {
          const lane = client === 0 ? 'flood' as const : 'normal' as const;
          const random = createXorshift32(fnv1a(trialSeed, `client/${client}/lane/${lane}/sample/${sample}/fault/ack`));
          const jitterMs = Math.floor((random() * (input.wanJitterMs * 2 + 1)) - input.wanJitterMs);
          const ackFault = ['duplicate', 'stale', 'out-of-order'][Math.floor(random() * 3)] as FairSchedulerRawSample['ackFault'];
          const workload = { clientCount, targetClient: client, latencyMs: input.wanLatencyMs + jitterMs };
          const candidate = runCandidateWorkload({
            ...workload,
            ackFault,
            policy: runtimePolicyProfile.policy,
          });
          const baseline = runFifoBaseline({ ...workload, ackFault });
          const orcaHoldBypass = runOrcaHoldBypassBaseline({
            ...workload,
            ackFault,
            policy: runtimePolicyProfile.policy,
          });
          samples.push({
            clientCount,
            trial,
            sample,
            client,
            lane,
            jitterMs,
            ackFault,
            ...candidate,
            baseline,
            orcaHoldBypass,
            candidate,
          });
          jitterSchedule.push(jitterMs);
          ackFaultSchedule.push(ackFault);
        }
      }
      trialSchedules.push({
        clientCount,
        trial,
        seed: trialSeed,
        jitterScheduleDigest: digest(jitterSchedule),
        ackFaultScheduleDigest: digest(ackFaultSchedule),
      });
    }
  }
  return {
    schemaVersion: 'fair-scheduler-raw/v1',
    execution: 'scheduler-execution',
    workload: { ...input, clients: [...input.clients] },
    runtimePolicyProfile,
    samples,
    trialSchedules,
  };
}

function aggregate(rawArtifacts: FairSchedulerRawArtifacts): FairSchedulerDecisionArtifact['aggregation'] {
  const metrics = [
    'enqueueToFirstServiceMs',
    'enqueueToCompleteMs',
    'maxNoServiceIntervalMs',
    'controlLatencyMs',
    'peakApplicationQueuedBytes',
    'peakSocketQueuedBytes',
    'throughputBytesPerSecond',
  ] as const;
  const laneMetrics: FairSchedulerDecisionArtifact['aggregation']['laneMetrics'] = {};
  const baselineLaneMetrics: FairSchedulerDecisionArtifact['aggregation']['baselineLaneMetrics'] = {};
  const orcaHoldBypassLaneMetrics: FairSchedulerDecisionArtifact['aggregation']['orcaHoldBypassLaneMetrics'] = {};
  for (const clientCount of rawArtifacts.workload.clients) {
    for (const lane of ['flood', 'normal'] as const) {
      const key = `${clientCount}/${lane}`;
      const source = rawArtifacts.samples.filter(sample => sample.clientCount === clientCount && sample.lane === lane);
      laneMetrics[key] = Object.fromEntries(metrics.map(metric => [metric, percentileMatrix(source.map(sample => sample[metric]))]));
      baselineLaneMetrics[key] = Object.fromEntries(metrics.map(metric => [
        metric,
        percentileMatrix(source.map(sample => sample.baseline[metric])),
      ]));
      orcaHoldBypassLaneMetrics[key] = Object.fromEntries(metrics.map(metric => [
        metric,
        percentileMatrix(source.map(sample => sample.orcaHoldBypass[metric])),
      ]));
    }
  }
  const clientAggregate = Object.fromEntries(rawArtifacts.workload.clients.map(clientCount => [
    String(clientCount),
    percentileMatrix(rawArtifacts.samples
      .filter(sample => sample.clientCount === clientCount)
      .map(sample => sample.enqueueToCompleteMs)),
  ]));
  return { laneMetrics, baselineLaneMetrics, orcaHoldBypassLaneMetrics, clientAggregate };
}

function fairSchedulerThresholdMeasurements(
  laneMetrics: FairSchedulerDecisionArtifact['aggregation']['laneMetrics'],
): Record<string, number> {
  const normalLaneMetrics = Object.entries(laneMetrics)
    .filter(([key]) => key.endsWith('/normal'))
    .map(([, metrics]) => metrics);
  const candidateLaneMetrics = Object.values(laneMetrics);
  const nonZeroThroughputs = candidateLaneMetrics
    .map(metrics => metrics.throughputBytesPerSecond.max)
    .filter(value => value > 0);
  return {
    eligibleLaneServiceMs: Math.max(...normalLaneMetrics.map(metrics => metrics.enqueueToFirstServiceMs.max)),
    eligibleLaneCompleteMs: Math.max(...normalLaneMetrics.map(metrics => metrics.enqueueToCompleteMs.max)),
    eligibleLaneMaxNoServiceIntervalMs: Math.max(...normalLaneMetrics.map(metrics => metrics.maxNoServiceIntervalMs.max)),
    controlLatencyMs: Math.max(...candidateLaneMetrics.map(metrics => metrics.controlLatencyMs.max)),
    peakApplicationQueuedBytes: Math.max(...candidateLaneMetrics.map(metrics => metrics.peakApplicationQueuedBytes.max)),
    peakSocketQueuedBytes: Math.max(...candidateLaneMetrics.map(metrics => metrics.peakSocketQueuedBytes.max)),
    aggregateThroughputBytesPerSecond: nonZeroThroughputs.length === 0
      ? 0
      : Math.min(...nonZeroThroughputs),
  };
}

function evaluateFairSchedulerThresholds(
  aggregation: FairSchedulerDecisionArtifact['aggregation'],
  thresholds: Record<string, FairSchedulerThreshold>,
) {
  const measurements = fairSchedulerThresholdMeasurements(aggregation.laneMetrics);
  const passes = Object.fromEntries(Object.entries(thresholds).map(([name, threshold]) => [
    name,
    thresholdPasses(measurements[name] ?? Number.NaN, threshold),
  ]));
  const baselineMeasurements = [
    fairSchedulerThresholdMeasurements(aggregation.baselineLaneMetrics),
    fairSchedulerThresholdMeasurements(aggregation.orcaHoldBypassLaneMetrics),
  ];
  const regressionPasses = Object.fromEntries(Object.entries(thresholds).map(([name, threshold]) => [
    name,
    baselineMeasurements.every(baseline => {
      const baselineValue = baseline[name] ?? Number.NaN;
      const tolerance = threshold.regressionToleranceKind === 'ratio'
        ? Math.abs(baselineValue) * threshold.baselineRegressionTolerance
        : threshold.baselineRegressionTolerance;
      return threshold.comparator === 'max'
        ? measurements[name] <= baselineValue + tolerance
        : measurements[name] >= baselineValue - tolerance;
    }),
  ]));
  const hasUnboundedEligibleLaneStarvation = !passes.eligibleLaneServiceMs
    || !passes.eligibleLaneCompleteMs
    || !passes.eligibleLaneMaxNoServiceIntervalMs;
  return {
    measurements,
    allRegisteredThresholdsPassed: Object.values(passes).every(Boolean)
      && Object.values(regressionPasses).every(Boolean),
    hasUnboundedEligibleLaneStarvation,
  };
}

function rawEvidencePaths(input: FairSchedulerBenchmarkInput): string[] {
  return input.clients.flatMap(clientCount => Array.from({ length: input.repeats }, (_, trial) => (
    `fair-scheduler-raw/clients-${clientCount}/trial-${trial}.json`
  )));
}

function createExpectedTrialSchedules(input: FairSchedulerBenchmarkInput): FairSchedulerRawArtifacts['trialSchedules'] {
  const schedules: FairSchedulerRawArtifacts['trialSchedules'] = [];
  for (const clientCount of input.clients) {
    for (let trial = 0; trial < input.repeats; trial += 1) {
      const trialSeed = fnv1a(input.seed, `trial/${clientCount}/${trial}`);
      const jitterSchedule: number[] = [];
      const ackFaultSchedule: string[] = [];
      for (let sample = 0; sample < input.samples; sample += 1) {
        for (let client = 0; client < clientCount; client += 1) {
          const lane = client === 0 ? 'flood' : 'normal';
          const random = createXorshift32(fnv1a(trialSeed, `client/${client}/lane/${lane}/sample/${sample}/fault/ack`));
          jitterSchedule.push(Math.floor((random() * (input.wanJitterMs * 2 + 1)) - input.wanJitterMs));
          ackFaultSchedule.push(['duplicate', 'stale', 'out-of-order'][Math.floor(random() * 3)]);
        }
      }
      schedules.push({
        clientCount,
        trial,
        seed: trialSeed,
        jitterScheduleDigest: digest(jitterSchedule),
        ackFaultScheduleDigest: digest(ackFaultSchedule),
      });
    }
  }
  return schedules;
}

function hasExactRawTrialCoverage(rawArtifacts: Partial<FairSchedulerRawArtifacts>): boolean {
  const workload = rawArtifacts.workload;
  const registeredClients = [1, 2, 8];
  if (
    !workload
    || !Array.isArray(workload.clients)
    || workload.clients.length !== registeredClients.length
    || workload.clients.some((clientCount, index) => clientCount !== registeredClients[index])
    || !Number.isSafeInteger(workload.wanLatencyMs) || workload.wanLatencyMs < 1
    || !Number.isSafeInteger(workload.wanJitterMs) || workload.wanJitterMs < 1
    || !Number.isSafeInteger(workload.seed) || workload.seed < 1
    || !Number.isSafeInteger(workload.repeats) || workload.repeats < 1
    || !Number.isSafeInteger(workload.samples) || workload.samples < 1
    || !Number.isFinite(workload.wanLossPercent) || workload.wanLossPercent !== 0
    || !Array.isArray(rawArtifacts.samples)
    || !Array.isArray(rawArtifacts.trialSchedules)
  ) return false;
  validateInput(workload);
  const expectedSchedules = createExpectedTrialSchedules(workload);
  if (canonicalJson(rawArtifacts.trialSchedules) !== canonicalJson(expectedSchedules)) return false;
  const expectedSampleCount = workload.clients.reduce((total, clientCount) => (
    total + clientCount * workload.repeats * workload.samples
  ), 0);
  if (rawArtifacts.samples.length !== expectedSampleCount) return false;
  const observed = new Set<string>();
  for (const sample of rawArtifacts.samples) {
    const clientCount = sample?.clientCount;
    const trial = sample?.trial;
    const sampleIndex = sample?.sample;
    const client = sample?.client;
    if (
      !workload.clients.includes(clientCount)
      || !Number.isSafeInteger(trial) || trial < 0 || trial >= workload.repeats
      || !Number.isSafeInteger(sampleIndex) || sampleIndex < 0 || sampleIndex >= workload.samples
      || !Number.isSafeInteger(client) || client < 0 || client >= clientCount
      || sample.lane !== (client === 0 ? 'flood' : 'normal')
    ) return false;
    const identity = `${clientCount}/${trial}/${sampleIndex}/${client}`;
    if (observed.has(identity)) return false;
    observed.add(identity);
  }
  return observed.size === expectedSampleCount;
}

export function createFairSchedulerTrialArtifacts(rawArtifacts: FairSchedulerRawArtifacts): Array<{
  schemaVersion: 'fair-scheduler-trial/v1';
  clientCount: number;
  trial: number;
  schedule: FairSchedulerRawArtifacts['trialSchedules'][number];
  samples: FairSchedulerRawSample[];
}> {
  return rawArtifacts.trialSchedules.map(schedule => ({
    schemaVersion: 'fair-scheduler-trial/v1' as const,
    clientCount: schedule.clientCount,
    trial: schedule.trial,
    schedule,
    samples: rawArtifacts.samples.filter(sample => (
      sample.clientCount === schedule.clientCount && sample.trial === schedule.trial
    )),
  }));
}

export function validateFairSchedulerTrialArtifacts(input: {
  rawArtifacts: unknown;
  trialArtifacts: readonly unknown[];
}): { accepted: boolean; reason: string } {
  const rawArtifacts = input.rawArtifacts as Partial<FairSchedulerRawArtifacts>;
  if (rawArtifacts.schemaVersion !== 'fair-scheduler-raw/v1'
    || !Array.isArray(rawArtifacts.samples)
    || !Array.isArray(rawArtifacts.trialSchedules)) {
    return { accepted: false, reason: 'trial-evidence-invalid' };
  }
  if (!hasExactRawTrialCoverage(rawArtifacts)) {
    return { accepted: false, reason: 'trial-evidence-coverage-mismatch' };
  }
  const expected = createFairSchedulerTrialArtifacts(rawArtifacts as FairSchedulerRawArtifacts);
  if (input.trialArtifacts.length !== expected.length
    || input.trialArtifacts.some((trialArtifact, index) => (
      canonicalJson(trialArtifact) !== canonicalJson(expected[index])
    ))) {
    return { accepted: false, reason: 'trial-evidence-mismatch' };
  }
  return { accepted: true, reason: 'trial-evidence-verified' };
}

function artifactWithoutDigest(artifact: FairSchedulerDecisionArtifact): Omit<FairSchedulerDecisionArtifact, 'digest'> {
  const { digest: ignored, ...withoutDigest } = artifact;
  return withoutDigest;
}

function hasCompleteAckFaultEvidence(samples: readonly unknown[]): boolean {
  const observedFaults = new Set<string>();
  const hasRejectedFault = (value: unknown): boolean => (
    value !== null
    && typeof value === 'object'
    && Number.isSafeInteger((value as Record<string, unknown>).ackFaultRejectionCount)
    && Number((value as Record<string, unknown>).ackFaultRejectionCount) > 0
  );
  const complete = samples.every(sample => {
    if (sample === null || typeof sample !== 'object') return false;
    const record = sample as Record<string, unknown>;
    if (record.ackFault !== 'duplicate' && record.ackFault !== 'stale' && record.ackFault !== 'out-of-order') {
      return false;
    }
    observedFaults.add(record.ackFault);
    const candidate = record.candidate;
    return hasRejectedFault(candidate)
      && (candidate as Record<string, unknown>).creditExhaustionObserved === true
      && hasRejectedFault(record.baseline)
      && hasRejectedFault(record.orcaHoldBypass);
  });
  return complete
    && observedFaults.has('duplicate')
    && observedFaults.has('stale')
    && observedFaults.has('out-of-order');
}

export function createFairSchedulerDecisionArtifact(
  input: FairSchedulerBenchmarkRunInput,
): { artifact: FairSchedulerDecisionArtifact; rawArtifacts: FairSchedulerRawArtifacts } {
  const { runtimePolicyProfile: requestedProfile, ...benchmarkInput } = input;
  validateInput(benchmarkInput);
  const runtimePolicyProfile = resolveFairSchedulerRuntimePolicyProfile(requestedProfile);
  const rawArtifacts = createRawArtifacts(benchmarkInput, runtimePolicyProfile);
  const sourceDigest = getFairSchedulerBenchmarkSourceDigest();
  const contract = getFairSchedulerBenchmarkContract(benchmarkInput, runtimePolicyProfile);
  const { workload, policy } = contract;
  const thresholds = getFairSchedulerThresholds(policy);
  const aggregation = aggregate(rawArtifacts);
  const thresholdEvaluation = evaluateFairSchedulerThresholds(aggregation, thresholds);
  const artifact: FairSchedulerDecisionArtifact = {
    schemaVersion: SCHEMA_VERSION,
    state: 'complete',
    workload,
    prng: { ...PRNG, rootSeed: input.seed },
    workloadSchemaHash: contract.workloadSchemaHash,
    configHash: contract.configHash,
    policyHash: contract.policyHash,
    policy,
    runtimePolicyProfile,
    sourceDigest,
    rawEvidencePaths: rawEvidencePaths(input),
    rawEvidenceDigest: digest(rawArtifacts),
    rawSampleCount: rawArtifacts.samples.length,
    baseline: 'fifo',
    baselines: ['fifo', 'orca-hold-bypass'],
    candidate: 'deficit-round-robin',
    sampleCount: input.repeats * input.samples,
    aggregation,
    thresholds,
    allRegisteredThresholdsPassed: thresholdEvaluation.allRegisteredThresholdsPassed,
    hasUnboundedEligibleLaneStarvation: thresholdEvaluation.hasUnboundedEligibleLaneStarvation,
    validatorVerdict: thresholdEvaluation.allRegisteredThresholdsPassed ? 'accept' : 'reject',
    accepted: thresholdEvaluation.allRegisteredThresholdsPassed,
    promotionAllowed: thresholdEvaluation.allRegisteredThresholdsPassed,
    reason: thresholdEvaluation.allRegisteredThresholdsPassed
      ? 'all-registered-thresholds-passed'
      : 'registered-thresholds-failed',
  };
  return { artifact, rawArtifacts };
}

export function validateFairSchedulerDecisionArtifact(input: {
  artifact: unknown;
  rawArtifacts: unknown;
  runtimePolicyProfile?: FairSchedulerRuntimePolicyProfile;
}): { accepted: boolean; reason: string } {
  const artifact = input.artifact as Partial<FairSchedulerDecisionArtifact>;
  const rawArtifacts = input.rawArtifacts as Partial<FairSchedulerRawArtifacts>;
  if (artifact?.schemaVersion !== SCHEMA_VERSION || artifact.state !== 'complete') {
    return { accepted: false, reason: 'decision-artifact-incomplete' };
  }
  if (!Array.isArray(rawArtifacts?.samples) || rawArtifacts.samples.length === 0) {
    return { accepted: false, reason: 'raw-samples-missing' };
  }
  if (!hasExactRawTrialCoverage(rawArtifacts)) {
    return { accepted: false, reason: 'raw-trial-coverage-mismatch' };
  }
  if (!hasCompleteAckFaultEvidence(rawArtifacts.samples)) {
    return { accepted: false, reason: 'ack-fault-evidence-missing' };
  }
  if (artifact.rawEvidenceDigest !== digest(rawArtifacts)) {
    return { accepted: false, reason: 'raw-evidence-digest-mismatch' };
  }
  if (artifact.sourceDigest !== getFairSchedulerBenchmarkSourceDigest()) {
    return { accepted: false, reason: 'source-digest-mismatch' };
  }
  const artifactProfile = validateFairSchedulerRuntimePolicyProfile(artifact.runtimePolicyProfile);
  const requestedProfile = validateFairSchedulerRuntimePolicyProfile(
    input.runtimePolicyProfile ?? artifact.runtimePolicyProfile,
  );
  if (!artifactProfile.accepted || !requestedProfile.accepted) {
    return { accepted: false, reason: 'runtime-policy-profile-invalid' };
  }
  if (artifactProfile.profile.profileHash !== requestedProfile.profile.profileHash
    || canonicalJson(rawArtifacts.runtimePolicyProfile) !== canonicalJson(artifactProfile.profile)) {
    return { accepted: false, reason: 'runtime-policy-profile-mismatch' };
  }
  const contract = getFairSchedulerBenchmarkContract(undefined, requestedProfile.profile);
  if (artifact.workloadSchemaHash !== contract.workloadSchemaHash
    || canonicalJson(artifact.workload) !== canonicalJson(contract.workload)) {
    return { accepted: false, reason: 'workload-schema-hash-mismatch' };
  }
  if (artifact.policyHash !== contract.policyHash
    || canonicalJson(artifact.policy) !== canonicalJson(contract.policy)
    || canonicalJson(artifact.runtimePolicyProfile) !== canonicalJson(contract.runtimePolicyProfile)) {
    return { accepted: false, reason: 'policy-hash-mismatch' };
  }
  if (artifact.configHash !== contract.configHash) {
    return { accepted: false, reason: 'config-hash-mismatch' };
  }
  const expectedThresholds = getFairSchedulerThresholds(contract.policy);
  if (canonicalJson(artifact.thresholds) !== canonicalJson(expectedThresholds)) {
    return { accepted: false, reason: 'threshold-contract-mismatch' };
  }
  if (canonicalJson(rawArtifacts.workload) !== canonicalJson({
    clients: contract.workload.clients,
    wanLatencyMs: contract.workload.wan.latencyMs,
    wanJitterMs: contract.workload.wan.jitterMs,
    wanLossPercent: contract.workload.wan.lossPercent,
    seed: contract.workload.seed,
    repeats: contract.workload.repeats,
    samples: contract.workload.samples,
  })) {
    return { accepted: false, reason: 'raw-workload-mismatch' };
  }
  const measuredAggregation = aggregate(rawArtifacts as FairSchedulerRawArtifacts);
  if (canonicalJson(artifact.aggregation) !== canonicalJson(measuredAggregation)) {
    return { accepted: false, reason: 'aggregation-mismatch' };
  }
  const thresholdEvaluation = evaluateFairSchedulerThresholds(measuredAggregation, expectedThresholds);
  if (artifact.allRegisteredThresholdsPassed !== thresholdEvaluation.allRegisteredThresholdsPassed
    || artifact.hasUnboundedEligibleLaneStarvation
      !== thresholdEvaluation.hasUnboundedEligibleLaneStarvation) {
    return { accepted: false, reason: 'threshold-outcome-mismatch' };
  }
  if (artifact.rawSampleCount !== rawArtifacts.samples.length || artifact.sampleCount !== 150) {
    return { accepted: false, reason: 'workload-sample-count-mismatch' };
  }
  const expectedRawEvidencePathCount = rawEvidencePaths({
    clients: [1, 2, 8],
    wanLatencyMs: 150,
    wanJitterMs: 20,
    wanLossPercent: 0,
    seed: 20260723,
    repeats: 5,
    samples: 30,
  }).length;
  if (
    !Array.isArray(artifact.rawEvidencePaths)
    || artifact.rawEvidencePaths.length !== expectedRawEvidencePathCount
    || artifact.rawEvidencePaths.some(path => typeof path !== 'string' || path.length === 0)
    || new Set(artifact.rawEvidencePaths).size !== expectedRawEvidencePathCount
  ) {
    return { accepted: false, reason: 'trial-evidence-path-mismatch' };
  }
  if (canonicalJson(artifact.baselines) !== canonicalJson(['fifo', 'orca-hold-bypass'])) {
    return { accepted: false, reason: 'baseline-strategy-mismatch' };
  }
  if (artifact.validatorVerdict !== 'accept' || artifact.allRegisteredThresholdsPassed !== true
    || artifact.hasUnboundedEligibleLaneStarvation !== false || artifact.accepted !== true
    || artifact.promotionAllowed !== true) {
    return { accepted: false, reason: 'decision-artifact-rejected' };
  }
  return { accepted: true, reason: 'decision-artifact-verified' };
}

function validateFairSchedulerAuthorityPublicationCandidate(input: {
  artifact: FairSchedulerDecisionArtifact;
  rawArtifacts: FairSchedulerRawArtifacts;
}): { accepted: boolean; reason: string } {
  const { artifact, rawArtifacts } = input;
  if (artifact.schemaVersion !== SCHEMA_VERSION || artifact.state !== 'complete') {
    return { accepted: false, reason: 'decision-artifact-incomplete' };
  }
  if (!hasExactRawTrialCoverage(rawArtifacts)) {
    return { accepted: false, reason: 'raw-trial-coverage-mismatch' };
  }
  if (!hasCompleteAckFaultEvidence(rawArtifacts.samples)) {
    return { accepted: false, reason: 'ack-fault-evidence-missing' };
  }
  const thresholdEvaluation = evaluateFairSchedulerThresholds(
    aggregate(rawArtifacts),
    getFairSchedulerThresholds(artifact.policy),
  );
  if (!thresholdEvaluation.allRegisteredThresholdsPassed) {
    return { accepted: false, reason: 'registered-thresholds-failed' };
  }
  if (thresholdEvaluation.hasUnboundedEligibleLaneStarvation) {
    return { accepted: false, reason: 'eligible-lane-starvation-detected' };
  }
  if (artifact.allRegisteredThresholdsPassed !== true
    || artifact.hasUnboundedEligibleLaneStarvation !== false
    || artifact.accepted !== true
    || artifact.promotionAllowed !== true
    || artifact.validatorVerdict !== 'accept') {
    return { accepted: false, reason: 'decision-artifact-rejected' };
  }
  return { accepted: true, reason: 'decision-artifact-verified' };
}

export function validateFairSchedulerPublicationDirectory(input: {
  artifactRoot: string;
  requireStagingValidated?: boolean;
}): { accepted: boolean; reason: string } {
  const publicationName = 'fair-scheduler-decision.json.publication.json';
  const publicationPath = resolve(input.artifactRoot, publicationName);
  if (!existsSync(publicationPath)) return { accepted: false, reason: 'publication-missing' };
  const publicationReference = validateFairSchedulerEvidenceReference(input.artifactRoot, publicationName);
  if (!publicationReference.accepted) return { accepted: false, reason: 'publication-reference-invalid' };
  try {
    const publication = JSON.parse(readFileSync(publicationReference.resolvedPath, 'utf8')) as Record<string, unknown>;
    if (
      publication.schemaVersion !== 'fair-scheduler-publication/v1'
      || typeof publication.generationId !== 'string'
      || typeof publication.digest !== 'string'
      || typeof publication.artifactPath !== 'string'
      || typeof publication.rawPath !== 'string'
    ) return { accepted: false, reason: 'publication-invalid' };
    if (!hasFairSchedulerPublicationGenerationLayout(publication.generationId, [
      publication.artifactPath,
      publication.rawPath,
    ])) return { accepted: false, reason: 'publication-generation-mismatch' };
    const artifactReference = validateFairSchedulerEvidenceReference(input.artifactRoot, publication.artifactPath);
    const rawReference = validateFairSchedulerEvidenceReference(input.artifactRoot, publication.rawPath);
    if (!artifactReference.accepted || !rawReference.accepted
      || !existsSync(artifactReference.resolvedPath) || !existsSync(rawReference.resolvedPath)) {
      return { accepted: false, reason: 'publication-reference-invalid' };
    }
    const artifact = JSON.parse(readFileSync(artifactReference.resolvedPath, 'utf8')) as Record<string, unknown>;
    const rawArtifacts = JSON.parse(readFileSync(rawReference.resolvedPath, 'utf8')) as Record<string, unknown>;
    if (input.requireStagingValidated !== false && artifact.stagingValidated !== true) {
      return { accepted: false, reason: 'publication-staging-validation-missing' };
    }
    const { digest: suppliedDigest, ...unsignedArtifact } = artifact;
    if (typeof suppliedDigest !== 'string' || suppliedDigest !== digest(unsignedArtifact)) {
      return { accepted: false, reason: 'artifact-digest-mismatch' };
    }
    if (publication.digest !== suppliedDigest) return { accepted: false, reason: 'publication-digest-mismatch' };
    if (artifact.rawEvidenceDigest !== digest(rawArtifacts)) {
      return { accepted: false, reason: 'raw-evidence-digest-mismatch' };
    }
    const validation = validateFairSchedulerDecisionArtifact({ artifact, rawArtifacts });
    if (!validation.accepted) return { accepted: false, reason: validation.reason };
    if (!Array.isArray(artifact.rawEvidencePaths)) return { accepted: false, reason: 'trial-evidence-path-mismatch' };
    if (!hasFairSchedulerPublicationGenerationLayout(publication.generationId, artifact.rawEvidencePaths)) {
      return { accepted: false, reason: 'publication-generation-mismatch' };
    }
    if (!hasExactFairSchedulerEvidenceGenerationInventory({
      artifactRoot: input.artifactRoot,
      generationId: publication.generationId,
      evidencePaths: [publication.artifactPath, publication.rawPath, ...artifact.rawEvidencePaths],
    })) return { accepted: false, reason: 'publication-generation-inventory-mismatch' };
    const trialArtifacts: unknown[] = [];
    for (const evidencePath of artifact.rawEvidencePaths) {
      const reference = validateFairSchedulerEvidenceReference(input.artifactRoot, evidencePath);
      if (!reference.accepted || !existsSync(reference.resolvedPath)) {
        return { accepted: false, reason: 'trial-evidence-path-mismatch' };
      }
      trialArtifacts.push(JSON.parse(readFileSync(reference.resolvedPath, 'utf8')));
    }
    const trialValidation = validateFairSchedulerTrialArtifacts({ rawArtifacts, trialArtifacts });
    if (!trialValidation.accepted) return { accepted: false, reason: trialValidation.reason };
    return { accepted: true, reason: 'fair-scheduler-publication-verified' };
  } catch {
    return { accepted: false, reason: 'publication-invalid' };
  }
}

type FairSchedulerDecisionArtifactWriteInput = FairSchedulerBenchmarkRunInput & {
  outputPath: string;
  afterPublicationLockAcquired?: () => Promise<void>;
  beforeStagedValidation?: (input: { stagingRoot: string }) => Promise<void>;
  beforeCanonicalPointerPromotion?: (input: {
    artifactRoot: string;
    evidencePaths: string[];
  }) => Promise<void>;
};

type FairSchedulerDecisionPublicationLock = {
  handle: Awaited<ReturnType<typeof open>>;
  lockPath: string;
  token: string;
  outputDirectory: string;
  outputDirectoryIdentity: FairSchedulerPublicationDirectoryIdentity;
};

type FairSchedulerPublicationDirectoryIdentity = {
  dev: bigint;
  ino: bigint;
};

function assertFairSchedulerDecisionPublicationPaths(paths: readonly string[]): void {
  // The output root and its parent are deployment-owned: only the official publisher may modify them.
  if (paths.some(hasSymbolicLinkAncestor)) {
    throw new Error('Cannot publish fair scheduler artifact: publication-reference-invalid');
  }
}

function readFairSchedulerPublicationDirectoryIdentity(
  directory: string,
): FairSchedulerPublicationDirectoryIdentity {
  const stat = statSync(directory, { bigint: true });
  if (!stat.isDirectory() || stat.dev === 0n || stat.ino === 0n) {
    throw new Error('Cannot publish fair scheduler artifact: publication-root-identity-unavailable');
  }
  return { dev: stat.dev, ino: stat.ino };
}

function assertCurrentFairSchedulerPublicationDirectory(
  outputDirectory: string,
  expectedIdentity: FairSchedulerPublicationDirectoryIdentity,
  paths: readonly string[] = [],
): void {
  assertFairSchedulerDecisionPublicationPaths([outputDirectory, ...paths]);
  const actualIdentity = readFairSchedulerPublicationDirectoryIdentity(outputDirectory);
  if (actualIdentity.dev !== expectedIdentity.dev || actualIdentity.ino !== expectedIdentity.ino) {
    throw new Error('Cannot publish fair scheduler artifact: publication-root-identity-changed');
  }
}

function isCurrentFairSchedulerPublicationDirectory(
  outputDirectory: string,
  expectedIdentity: FairSchedulerPublicationDirectoryIdentity,
  paths: readonly string[] = [],
): boolean {
  try {
    assertCurrentFairSchedulerPublicationDirectory(outputDirectory, expectedIdentity, paths);
    return true;
  } catch {
    return false;
  }
}

async function acquireFairSchedulerDecisionPublicationLock(
  outputDirectory: string,
  outputDirectoryIdentity: FairSchedulerPublicationDirectoryIdentity,
): Promise<FairSchedulerDecisionPublicationLock> {
  const lockPath = join(outputDirectory, '.fair-scheduler-publication.publish.lock');
  assertCurrentFairSchedulerPublicationDirectory(outputDirectory, outputDirectoryIdentity, [lockPath]);
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(lockPath, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error('Cannot publish fair scheduler artifact: publication lock exists');
    }
    throw error;
  }
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    await handle.writeFile(`${token}\n`, 'utf8');
    assertCurrentFairSchedulerPublicationDirectory(outputDirectory, outputDirectoryIdentity, [lockPath]);
    return { handle, lockPath, token, outputDirectory, outputDirectoryIdentity };
  } catch (error) {
    await handle.close();
    if (isCurrentFairSchedulerPublicationDirectory(outputDirectory, outputDirectoryIdentity, [lockPath])) {
      await rm(lockPath, { force: true });
    }
    throw error;
  }
}

async function releaseFairSchedulerDecisionPublicationLock(
  lock: FairSchedulerDecisionPublicationLock,
): Promise<void> {
  await lock.handle.close();
  if (!isCurrentFairSchedulerPublicationDirectory(
    lock.outputDirectory,
    lock.outputDirectoryIdentity,
    [lock.lockPath],
  )) return;
  if (!existsSync(lock.lockPath) || lstatSync(lock.lockPath).isSymbolicLink()) return;
  if (await readFile(lock.lockPath, 'utf8') === `${lock.token}\n`) {
    await rm(lock.lockPath);
  }
}

export async function writeFairSchedulerDecisionArtifact(
  input: FairSchedulerDecisionArtifactWriteInput,
): Promise<{ artifactPath: string; digest: string }> {
  const {
    outputPath: requestedOutputPath,
    afterPublicationLockAcquired,
    beforeStagedValidation,
    beforeCanonicalPointerPromotion,
    ...benchmarkRun
  } = input;
  const outputPath = resolve(requestedOutputPath);
  const generated = createFairSchedulerDecisionArtifact(benchmarkRun);
  const validation = validateFairSchedulerDecisionArtifact(generated);
  if (!validation.accepted) throw new Error(`Cannot publish fair scheduler artifact: ${validation.reason}`);
  const outputDirectory = dirname(outputPath);
  const rawPath = `${outputPath}.raw.json`;
  const publicationPath = `${outputPath}.publication.json`;
  const generationId = digest({
    sourceDigest: generated.artifact.sourceDigest,
    policyHash: generated.artifact.policyHash,
    configHash: generated.artifact.configHash,
    rawEvidenceDigest: generated.artifact.rawEvidenceDigest,
  });
  const publicationDirectoryName = `fair-scheduler-publications/${generationId}`;
  const rawRunDirectoryName = `${publicationDirectoryName}/fair-scheduler-runs/${generated.artifact.rawEvidenceDigest}`;
  const publishedRawEvidencePaths = generated.artifact.rawEvidencePaths.map(path => (
    `${rawRunDirectoryName}/${path.replace(/^fair-scheduler-raw\//u, '')}`
  ));
  const trialArtifacts = createFairSchedulerTrialArtifacts(generated.rawArtifacts);
  const publishedPublicationDirectory = resolve(outputDirectory, publicationDirectoryName);
  assertFairSchedulerDecisionPublicationPaths([
    dirname(outputDirectory),
    outputDirectory,
    outputPath,
    rawPath,
    publicationPath,
    dirname(publishedPublicationDirectory),
    publishedPublicationDirectory,
  ]);
  await mkdir(outputDirectory, { recursive: true });
  assertFairSchedulerDecisionPublicationPaths([
    dirname(outputDirectory),
    outputDirectory,
    outputPath,
    rawPath,
    publicationPath,
    dirname(publishedPublicationDirectory),
    publishedPublicationDirectory,
  ]);
  const outputDirectoryIdentity = readFairSchedulerPublicationDirectoryIdentity(outputDirectory);
  const publicationLock = await acquireFairSchedulerDecisionPublicationLock(outputDirectory, outputDirectoryIdentity);
  let stagingDirectory: string | undefined;
  try {
    await afterPublicationLockAcquired?.();
    assertCurrentFairSchedulerPublicationDirectory(outputDirectory, outputDirectoryIdentity);
    stagingDirectory = await mkdtemp(join(outputDirectory, '.fair-scheduler-publication.staging-'));
    assertCurrentFairSchedulerPublicationDirectory(outputDirectory, outputDirectoryIdentity, [stagingDirectory]);
    const stagedRoot = resolve(stagingDirectory, 'root');
    const stagedPublicationDirectory = resolve(stagedRoot, publicationDirectoryName);
    const stagedOutputPath = resolve(stagedPublicationDirectory, 'fair-scheduler-decision.json');
    const stagedRawPath = resolve(stagedPublicationDirectory, 'fair-scheduler-decision.raw.json');
    const stagedManifestPath = resolve(stagedRoot, 'fair-scheduler-decision.json.publication.json');
    assertCurrentFairSchedulerPublicationDirectory(outputDirectory, outputDirectoryIdentity, [stagingDirectory]);
    await mkdir(stagedRoot, { recursive: true });
    await mkdir(stagedPublicationDirectory, { recursive: true });
    await writeFile(stagedRawPath, `${canonicalJson(generated.rawArtifacts)}\n`, 'utf8');
    for (const [index, path] of publishedRawEvidencePaths.entries()) {
      const trialArtifact = trialArtifacts[index];
      const stagedTrialPath = resolve(stagedRoot, ...path.split('/'));
      assertCurrentFairSchedulerPublicationDirectory(outputDirectory, outputDirectoryIdentity, [stagingDirectory]);
      await mkdir(dirname(stagedTrialPath), { recursive: true });
      await writeFile(stagedTrialPath, `${canonicalJson(trialArtifact)}\n`, 'utf8');
    }
    const unmarkedPublishBase: FairSchedulerDecisionArtifact = {
      ...generated.artifact,
      rawEvidencePaths: publishedRawEvidencePaths,
    };
    const unmarkedDigest = digest(artifactWithoutDigest(unmarkedPublishBase));
    const unmarkedPublishArtifact = { ...unmarkedPublishBase, digest: unmarkedDigest };
    const unmarkedManifest = {
      schemaVersion: 'fair-scheduler-publication/v1',
      digest: unmarkedDigest,
      generationId,
      artifactPath: `${publicationDirectoryName}/fair-scheduler-decision.json`,
      rawPath: `${publicationDirectoryName}/fair-scheduler-decision.raw.json`,
    };
    assertCurrentFairSchedulerPublicationDirectory(outputDirectory, outputDirectoryIdentity, [stagingDirectory]);
    await writeFile(stagedOutputPath, `${canonicalJson(unmarkedPublishArtifact)}\n`, 'utf8');
    await writeFile(stagedManifestPath, `${canonicalJson(unmarkedManifest)}\n`, 'utf8');
    await writeFile(resolve(stagedRoot, 'fair-scheduler-decision.json'), `${canonicalJson(unmarkedPublishArtifact)}\n`, 'utf8');
    await writeFile(resolve(stagedRoot, 'fair-scheduler-decision.json.raw.json'), `${canonicalJson(generated.rawArtifacts)}\n`, 'utf8');
    await beforeStagedValidation?.({ stagingRoot: stagedRoot });
    const unmarkedReadback = validateFairSchedulerPublicationDirectory({
      artifactRoot: stagedRoot,
      requireStagingValidated: false,
    });
    if (!unmarkedReadback.accepted) {
      throw new Error(`Cannot publish fair scheduler artifact: ${unmarkedReadback.reason}`);
    }
    const publishBase: FairSchedulerDecisionArtifact = { ...unmarkedPublishBase, stagingValidated: true };
    const digestValue = digest(artifactWithoutDigest(publishBase));
    const publishArtifact = { ...publishBase, digest: digestValue };
    const manifest = { ...unmarkedManifest, digest: digestValue };
    const finalEvidencePaths = [manifest.artifactPath, manifest.rawPath, ...publishArtifact.rawEvidencePaths];
    const expectedEvidenceContents = new Map<string, string>([
      [manifest.artifactPath, `${canonicalJson(publishArtifact)}\n`],
      [manifest.rawPath, `${canonicalJson(generated.rawArtifacts)}\n`],
      ...publishArtifact.rawEvidencePaths.map((path, index) => [path, `${canonicalJson(trialArtifacts[index])}\n`] as const),
    ]);
    assertCurrentFairSchedulerPublicationDirectory(outputDirectory, outputDirectoryIdentity, [stagingDirectory]);
    await writeFile(stagedOutputPath, `${canonicalJson(publishArtifact)}\n`, 'utf8');
    await writeFile(stagedManifestPath, `${canonicalJson(manifest)}\n`, 'utf8');
    await writeFile(resolve(stagedRoot, 'fair-scheduler-decision.json'), `${canonicalJson(publishArtifact)}\n`, 'utf8');
    const stagedValidation = validateFairSchedulerPublicationDirectory({ artifactRoot: stagedRoot });
    if (!stagedValidation.accepted) {
      throw new Error(`Cannot publish fair scheduler artifact: ${stagedValidation.reason}`);
    }
    assertCurrentFairSchedulerPublicationDirectory(outputDirectory, outputDirectoryIdentity, [
      dirname(publishedPublicationDirectory),
      publishedPublicationDirectory,
    ]);
    if (!existsSync(publishedPublicationDirectory)) {
      assertCurrentFairSchedulerPublicationDirectory(outputDirectory, outputDirectoryIdentity, [
        dirname(publishedPublicationDirectory),
        publishedPublicationDirectory,
      ]);
      await mkdir(dirname(publishedPublicationDirectory), { recursive: true });
      await rename(stagedPublicationDirectory, publishedPublicationDirectory);
    } else {
      if (existsSync(publicationPath)
        && !validateFairSchedulerPublicationDirectory({ artifactRoot: outputDirectory }).accepted) {
        throw new Error('Cannot publish fair scheduler artifact: existing fair scheduler generation is invalid');
      }
      if (!hasIdenticalFairSchedulerEvidenceGeneration({
        stagedRoot,
        outputRoot: outputDirectory,
        generationId,
        evidencePaths: finalEvidencePaths,
      })) {
        throw new Error('Cannot publish fair scheduler artifact: existing fair scheduler generation is invalid');
      }
    }
    await beforeCanonicalPointerPromotion?.({ artifactRoot: outputDirectory, evidencePaths: [...finalEvidencePaths] });
    assertCurrentFairSchedulerPublicationDirectory(outputDirectory, outputDirectoryIdentity, [
      publishedPublicationDirectory,
      outputPath,
      rawPath,
      publicationPath,
    ]);
    if (!hasExpectedFairSchedulerEvidenceGeneration({
      artifactRoot: outputDirectory,
      generationId,
      evidencePaths: finalEvidencePaths,
      expectedContents: expectedEvidenceContents,
    })) {
      throw new Error('Cannot publish fair scheduler artifact: published fair scheduler generation is invalid');
    }
    assertCurrentFairSchedulerPublicationDirectory(outputDirectory, outputDirectoryIdentity, [outputPath, rawPath, publicationPath]);
    await rename(stagedManifestPath, publicationPath);
    await rename(resolve(stagedRoot, 'fair-scheduler-decision.json.raw.json'), rawPath);
    await rename(resolve(stagedRoot, 'fair-scheduler-decision.json'), outputPath);
    return { artifactPath: outputPath, digest: digestValue };
  } finally {
    if (stagingDirectory && isCurrentFairSchedulerPublicationDirectory(
      outputDirectory,
      outputDirectoryIdentity,
      [stagingDirectory],
    )) await rm(stagingDirectory, { recursive: true, force: true });
    await releaseFairSchedulerDecisionPublicationLock(publicationLock);
  }
}

type FairSchedulerAuthorityPublicationInput = FairSchedulerBenchmarkInput & {
  authorityRoot: string;
  beforeCurrentPointerPromotion?: () => Promise<void>;
};

type FairSchedulerAuthorityGenerationContents = {
  decisionBytes: string;
  provenanceBytes: string;
  rawManifestBytes: string;
  rawFiles: ReadonlyMap<string, string>;
  rawEntries: readonly FairSchedulerAuthorityManifestEntry[];
};

async function hasExpectedFairSchedulerAuthorityGeneration(input: {
  generationRoot: string;
  contents: FairSchedulerAuthorityGenerationContents;
}): Promise<boolean> {
  if (hasAuthorityLinkOrReparsePoint(input.generationRoot)) return false;
  try {
    if (!lstatSync(input.generationRoot).isDirectory()) return false;
    const expectedFiles = new Map<string, string>([
      [FAIR_SCHEDULER_AUTHORITY_DECISION_PATH, input.contents.decisionBytes],
      [FAIR_SCHEDULER_AUTHORITY_PROVENANCE_PATH, input.contents.provenanceBytes],
      [FAIR_SCHEDULER_AUTHORITY_RAW_MANIFEST_PATH, input.contents.rawManifestBytes],
      ...input.contents.rawFiles,
    ]);
    for (const [relativePath, expectedBytes] of expectedFiles) {
      const filePath = resolveAuthorityReference(input.generationRoot, relativePath);
      if (!filePath || hasAuthorityLinkOrReparsePoint(filePath)) return false;
      if (await readFile(filePath, 'utf8') !== expectedBytes) return false;
    }
    const rawRoot = resolveAuthorityReference(
      input.generationRoot,
      FAIR_SCHEDULER_AUTHORITY_RAW_ROOT,
      true,
    );
    const rawManifestPath = resolveAuthorityReference(
      input.generationRoot,
      FAIR_SCHEDULER_AUTHORITY_RAW_MANIFEST_PATH,
    );
    return rawRoot !== undefined
      && rawManifestPath !== undefined
      && hasExactAuthorityRawInventory({
        rawRoot,
        rawManifestPath,
        entries: input.contents.rawEntries,
      }) === 'accepted';
  } catch {
    return false;
  }
}

async function writeFairSchedulerAuthorityGenerationContents(input: {
  generationRoot: string;
  contents: FairSchedulerAuthorityGenerationContents;
}): Promise<void> {
  const rawRoot = resolveAuthorityReference(input.generationRoot, FAIR_SCHEDULER_AUTHORITY_RAW_ROOT, true);
  if (!rawRoot) throw new Error('Cannot publish fair scheduler authority: raw-root-invalid');
  await mkdir(rawRoot, { recursive: true });
  for (const [relativePath, bytes] of input.contents.rawFiles) {
    const path = resolveAuthorityReference(input.generationRoot, relativePath);
    if (!path) throw new Error('Cannot publish fair scheduler authority: raw-path-invalid');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes, 'utf8');
  }
  await writeFile(
    resolve(input.generationRoot, FAIR_SCHEDULER_AUTHORITY_DECISION_PATH),
    input.contents.decisionBytes,
    'utf8',
  );
  await writeFile(
    resolve(input.generationRoot, FAIR_SCHEDULER_AUTHORITY_PROVENANCE_PATH),
    input.contents.provenanceBytes,
    'utf8',
  );
  await writeFile(
    resolve(input.generationRoot, FAIR_SCHEDULER_AUTHORITY_RAW_MANIFEST_PATH),
    input.contents.rawManifestBytes,
    'utf8',
  );
}

// @req PERF-BGSTAB-010 AC-3 AC-4
export async function publishFairSchedulerAuthorityGeneration(
  input: FairSchedulerAuthorityPublicationInput,
): Promise<{ generationId: string; generationRoot: string; currentPointerPath: string }> {
  const {
    authorityRoot: requestedAuthorityRoot,
    beforeCurrentPointerPromotion,
    ...benchmarkInput
  } = input;
  const authorityRoot = resolve(requestedAuthorityRoot);
  const [runtimeConfigModule, configModule] = await Promise.all([
    import('../services/RuntimeConfigStore.js'),
    import('../utils/config.js'),
  ]);
  const generated = createFairSchedulerDecisionArtifact({
    ...benchmarkInput,
    runtimePolicyProfile: createFairSchedulerRuntimePolicyProfile(
      new runtimeConfigModule.RuntimeConfigStore(configModule.config),
    ),
  });
  const decisionValidation = validateFairSchedulerAuthorityPublicationCandidate(generated);
  if (!decisionValidation.accepted) {
    throw new Error(`Cannot publish fair scheduler authority: ${decisionValidation.reason}`);
  }

  const decisionBytes = `${canonicalJson(generated.artifact)}\n`;
  const trialArtifacts = createFairSchedulerTrialArtifacts(generated.rawArtifacts);
  if (trialArtifacts.length !== generated.artifact.rawEvidencePaths.length) {
    throw new Error('Cannot publish fair scheduler authority: trial-inventory-invalid');
  }
  const rawFiles = new Map<string, string>(generated.artifact.rawEvidencePaths.map((path, index) => [
    `${FAIR_SCHEDULER_AUTHORITY_RAW_ROOT}${path}`,
    `${canonicalJson(trialArtifacts[index])}\n`,
  ] as const));
  const rawEntries: FairSchedulerAuthorityManifestEntry[] = [...rawFiles].map(([path, bytes]) => ({
    path,
    sha256: digest(bytes),
  }));
  const trialInventory = rawEntries.map(entry => ({ ...entry }));
  const policyDigest = generated.artifact.policyHash;
  const generationId = digest({
    schema_version: FAIR_SCHEDULER_CURRENT_AUTHORITY_SCHEMA_VERSION,
    decision_sha256: digest(decisionBytes),
    raw_entries_digest: digest(rawEntries),
    policy_digest: policyDigest,
    trial_inventory: trialInventory,
  });
  const publicationGeneration = generationId;
  const rawManifestBytes = `${canonicalJson({
    schema_version: FAIR_SCHEDULER_AUTHORITY_RAW_MANIFEST_SCHEMA_VERSION,
    generation_id: generationId,
    entries: rawEntries,
  })}\n`;
  const provenanceBytes = `${canonicalJson({
    schema_version: FAIR_SCHEDULER_AUTHORITY_PROVENANCE_SCHEMA_VERSION,
    generation_id: generationId,
    canonical_locator: FAIR_SCHEDULER_AUTHORITY_LOGICAL_LOCATOR,
    publication_generation: publicationGeneration,
    decision_path: FAIR_SCHEDULER_AUTHORITY_DECISION_PATH,
    decision_sha256: digest(decisionBytes),
    provenance_path: FAIR_SCHEDULER_AUTHORITY_PROVENANCE_PATH,
    raw_root: FAIR_SCHEDULER_AUTHORITY_RAW_ROOT,
    raw_manifest_path: FAIR_SCHEDULER_AUTHORITY_RAW_MANIFEST_PATH,
    raw_manifest_sha256: digest(rawManifestBytes),
    policy_digest: policyDigest,
    trial_inventory: trialInventory,
  })}\n`;
  const pointerBytes = `${canonicalJson({
    schema_version: FAIR_SCHEDULER_CURRENT_AUTHORITY_SCHEMA_VERSION,
    generation_id: generationId,
    publication_generation: publicationGeneration,
    decision_artifact: FAIR_SCHEDULER_AUTHORITY_DECISION_PATH,
    decision_sha256: digest(decisionBytes),
    provenance_artifact: FAIR_SCHEDULER_AUTHORITY_PROVENANCE_PATH,
    provenance_sha256: digest(provenanceBytes),
    raw_root: FAIR_SCHEDULER_AUTHORITY_RAW_ROOT,
    raw_manifest_sha256: digest(rawManifestBytes),
  })}\n`;
  const contents: FairSchedulerAuthorityGenerationContents = {
    decisionBytes,
    provenanceBytes,
    rawManifestBytes,
    rawFiles,
    rawEntries,
  };

  if (hasAuthorityLinkOrReparsePoint(authorityRoot)) {
    throw new Error('Cannot publish fair scheduler authority: authority-reference-link-or-reparse-point-detected');
  }
  await mkdir(authorityRoot, { recursive: true });
  if (hasAuthorityLinkOrReparsePoint(authorityRoot)) {
    throw new Error('Cannot publish fair scheduler authority: authority-reference-link-or-reparse-point-detected');
  }
  const generationsRoot = resolve(authorityRoot, FAIR_SCHEDULER_AUTHORITY_GENERATIONS_PATH);
  const generationRoot = resolve(generationsRoot, generationId);
  if (!isContainedPath(generationsRoot, generationRoot)) {
    throw new Error('Cannot publish fair scheduler authority: generation-path-invalid');
  }
  await mkdir(generationsRoot, { recursive: true });
  if (hasAuthorityLinkOrReparsePoint(generationsRoot)) {
    throw new Error('Cannot publish fair scheduler authority: authority-reference-link-or-reparse-point-detected');
  }

  let stagingDirectory: string | undefined;
  try {
    if (existsSync(generationRoot)) {
      if (!await hasExpectedFairSchedulerAuthorityGeneration({ generationRoot, contents })) {
        throw new Error('Cannot publish fair scheduler authority: existing immutable generation differs');
      }
    } else {
      stagingDirectory = await mkdtemp(join(generationsRoot, '.fair-scheduler-authority.staging-'));
      if (hasAuthorityLinkOrReparsePoint(stagingDirectory)) {
        throw new Error('Cannot publish fair scheduler authority: authority-reference-link-or-reparse-point-detected');
      }
      await writeFairSchedulerAuthorityGenerationContents({ generationRoot: stagingDirectory, contents });
      if (!await hasExpectedFairSchedulerAuthorityGeneration({ generationRoot: stagingDirectory, contents })) {
        throw new Error('Cannot publish fair scheduler authority: staged generation invalid');
      }
      try {
        await rename(stagingDirectory, generationRoot);
        stagingDirectory = undefined;
      } catch (error) {
        if (!existsSync(generationRoot)) throw error;
        if (!await hasExpectedFairSchedulerAuthorityGeneration({ generationRoot, contents })) {
          throw new Error('Cannot publish fair scheduler authority: existing immutable generation differs');
        }
      }
    }
    if (!await hasExpectedFairSchedulerAuthorityGeneration({ generationRoot, contents })) {
      throw new Error('Cannot publish fair scheduler authority: immutable generation invalid');
    }

    await beforeCurrentPointerPromotion?.();
    const currentPointerPath = resolve(authorityRoot, 'current.json');
    if (hasAuthorityLinkOrReparsePoint(currentPointerPath)) {
      throw new Error('Cannot publish fair scheduler authority: authority-reference-link-or-reparse-point-detected');
    }
    const pointerStagingDirectory = await mkdtemp(join(authorityRoot, '.fair-scheduler-authority-pointer-'));
    try {
      const stagedPointerPath = resolve(pointerStagingDirectory, 'current.json');
      await writeFile(stagedPointerPath, pointerBytes, 'utf8');
      if (hasAuthorityLinkOrReparsePoint(currentPointerPath)) {
        throw new Error('Cannot publish fair scheduler authority: authority-reference-link-or-reparse-point-detected');
      }
      await rename(stagedPointerPath, currentPointerPath);
    } finally {
      await rm(pointerStagingDirectory, { recursive: true, force: true });
    }
    return { generationId, generationRoot, currentPointerPath };
  } finally {
    if (stagingDirectory) await rm(stagingDirectory, { recursive: true, force: true });
  }
}

function readOption(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function parseProfileFromCli(): FairSchedulerBenchmarkInput & { outputPath: string } {
  const outputPath = readOption('--output');
  if (!outputPath) throw new Error('--output is required');
  const clients = readOption('--clients')?.split(',').map(value => Number.parseInt(value, 10));
  return {
    outputPath: resolve(outputPath),
    clients: clients ?? [],
    wanLatencyMs: Number.parseInt(readOption('--wan-latency-ms') ?? '', 10),
    wanJitterMs: Number.parseInt(readOption('--wan-jitter-ms') ?? '', 10),
    wanLossPercent: Number.parseInt(readOption('--wan-loss-percent') ?? '', 10),
    seed: Number.parseInt(readOption('--seed') ?? '', 10),
    repeats: Number.parseInt(readOption('--repeats') ?? '', 10),
    samples: Number.parseInt(readOption('--samples') ?? '', 10),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void Promise.all([
    import('../services/RuntimeConfigStore.js'),
    import('../utils/config.js'),
  ]).then(([runtimeConfigModule, configModule]) => writeFairSchedulerDecisionArtifact({
    ...parseProfileFromCli(),
    runtimePolicyProfile: createFairSchedulerRuntimePolicyProfile(
      new runtimeConfigModule.RuntimeConfigStore(configModule.config),
    ),
  })).then(result => {
    process.stdout.write(`${JSON.stringify({ ...result, relativeArtifactPath: relative(process.cwd(), result.artifactPath) })}\n`);
  });
}
