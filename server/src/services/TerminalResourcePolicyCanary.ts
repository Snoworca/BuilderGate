import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createFairSchedulerEvidenceAuthorityResolver,
  getFairSchedulerBenchmarkContract,
  getFairSchedulerBenchmarkSourceDigest,
  hasExactFairSchedulerEvidenceGenerationInventory,
  hasFairSchedulerPublicationGenerationLayout,
  resolveFairSchedulerEvidenceRoot,
  validateFairSchedulerEvidenceReference,
  validateFairSchedulerDecisionArtifact,
  validateFairSchedulerTrialArtifacts,
} from '../benchmarks/terminalFairnessCharacterization.js';
import type { FairSchedulerEvidenceAuthorityResolver } from '../benchmarks/terminalFairnessCharacterization.js';

export {
  createFairSchedulerEvidenceAuthorityResolver,
  resolveFairSchedulerEvidenceRoot,
  validateFairSchedulerEvidenceReference,
};

// @req REL-BGSTAB-010
export const TERMINAL_RESOURCE_POLICY_CANARY_SCHEMA_VERSION = 'terminal-resource-policy/v1' as const;

export const TERMINAL_RESOURCE_POLICY_CANARY_PROFILE_VERSION = '1.0.0' as const;

export const TERMINAL_RESOURCE_POLICY_CANARY_POLICY_ID = 'test-only-wave3-reviewed' as const;

export const TERMINAL_RESOURCE_POLICY_CANARY_CAPABILITY_VERSION = 7 as const;

export type TerminalResourcePolicyCanaryResource =
  | 'resourceLimits.ws.perClientOutputQueueMaxBytes'
  | 'resourceLimits.headless.pendingOutputMaxBytes';

export type TerminalResourcePolicyCanaryConsumer =
  | 'server.ws.router'
  | 'server.pty.headless-model';

export type TerminalResourcePolicyCanaryTarget = Readonly<{
  kind: 'ws';
  connectionId: string;
  clientId: string;
  channel: 'output';
  reconnectGeneration: number;
} | {
  kind: 'headless';
  sessionId: string;
}>;

export interface TerminalResourcePolicyCanaryContract {
  contractId: string;
  policyId: string;
  profileVersion: string;
  schemaVersion: string;
  stability: 'draft' | 'evolving' | 'stable';
  requiredCapabilities: Partial<Record<TerminalResourcePolicyCanaryConsumer, number>>;
  resources: Partial<Record<TerminalResourcePolicyCanaryResource, number>>;
}

export interface TerminalResourcePolicyLease {
  readonly leaseId: string;
  readonly policyId: string;
  readonly profileVersion: string;
  readonly schemaVersion: typeof TERMINAL_RESOURCE_POLICY_CANARY_SCHEMA_VERSION;
  readonly resource: TerminalResourcePolicyCanaryResource;
  readonly consumer: TerminalResourcePolicyCanaryConsumer;
  readonly target: TerminalResourcePolicyCanaryTarget;
}

export interface TerminalResourcePolicyLeaseMetadata {
  readonly issuanceSequence: number;
  readonly targetEpoch: number;
}

export interface TerminalResourcePolicyLeaseGrant {
  readonly lease: TerminalResourcePolicyLease;
  readonly decision: number;
  readonly metadata: TerminalResourcePolicyLeaseMetadata;
  readonly currentTargetEpoch: number;
}

export interface TerminalResourcePolicyLeaseAuthority {
  issue(input: {
    contractId: string;
    target: TerminalResourcePolicyCanaryTarget;
    selectedTarget: TerminalResourcePolicyCanaryTarget;
    resource: TerminalResourcePolicyCanaryResource;
    consumer: TerminalResourcePolicyCanaryConsumer;
    capability?: { version: number; compilerSchemaVersion: string };
  }): {
    mode: 'candidate' | 'legacy';
    reason: string;
    lease?: TerminalResourcePolicyLease;
  };
  validate(value: unknown): value is TerminalResourcePolicyLease;
  getLeaseMetadata(value: unknown): TerminalResourcePolicyLeaseMetadata | undefined;
  resolve(value: unknown): TerminalResourcePolicyLeaseGrant | undefined;
  revokeTarget(target: TerminalResourcePolicyCanaryTarget): number;
}

// @req PERF-BGSTAB-010 AC-3 AC-4
export function validateFairDeliveryCandidateArtifact(input: {
  policyHash: string;
  workloadSchemaHash: string;
  artifact: {
    state: 'missing' | 'incomplete' | 'complete';
    policyHash?: string;
    workloadSchemaHash?: string;
    validatorVerdict?: 'accept' | 'reject';
  };
}): { accepted: boolean; reason: string } {
  if (input.artifact.state === 'missing') {
    return { accepted: false, reason: 'decision-artifact-missing' };
  }
  if (input.artifact.state !== 'complete') {
    return { accepted: false, reason: 'decision-artifact-incomplete' };
  }
  if (input.artifact.policyHash !== input.policyHash) {
    return { accepted: false, reason: 'decision-artifact-policy-hash-mismatch' };
  }
  if (input.artifact.workloadSchemaHash !== input.workloadSchemaHash) {
    return { accepted: false, reason: 'decision-artifact-workload-schema-hash-mismatch' };
  }
  if (input.artifact.validatorVerdict !== 'accept') {
    return { accepted: false, reason: 'decision-artifact-validator-rejected' };
  }
  return { accepted: true, reason: 'decision-artifact-verified' };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: unknown): string {
  return createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value)).digest('hex');
}

// @req PERF-BGSTAB-010 AC-3 AC-4
function validateFairDeliveryCandidateArtifactAtEvidenceRoot(input: {
  runtimePolicy?: unknown;
}, evidenceRoot: string): { accepted: boolean; reason: string } {
  const publicationName = 'fair-scheduler-decision.json.publication.json';
  const publicationPath = resolve(evidenceRoot, publicationName);
  if (!existsSync(publicationPath)) {
    return { accepted: false, reason: 'decision-artifact-publication-missing' };
  }
  const publicationReference = validateFairSchedulerEvidenceReference(evidenceRoot, publicationName);
  if (!publicationReference.accepted) {
    return { accepted: false, reason: 'decision-artifact-publication-invalid' };
  }
  try {
    const publication = JSON.parse(readFileSync(publicationReference.resolvedPath, 'utf8')) as Record<string, unknown>;
    if (publication.schemaVersion !== 'fair-scheduler-publication/v1'
      || typeof publication.generationId !== 'string'
      || typeof publication.digest !== 'string'
      || typeof publication.artifactPath !== 'string'
      || typeof publication.rawPath !== 'string') {
      return { accepted: false, reason: 'decision-artifact-publication-invalid' };
    }
    if (!hasFairSchedulerPublicationGenerationLayout(publication.generationId, [
      publication.artifactPath,
      publication.rawPath,
    ])) {
      return { accepted: false, reason: 'decision-artifact-publication-generation-mismatch' };
    }
    const artifactReference = validateFairSchedulerEvidenceReference(evidenceRoot, publication.artifactPath);
    const rawReference = validateFairSchedulerEvidenceReference(evidenceRoot, publication.rawPath);
    if (!artifactReference.accepted || !rawReference.accepted
      || !existsSync(artifactReference.resolvedPath) || !existsSync(rawReference.resolvedPath)) {
      return { accepted: false, reason: 'decision-artifact-publication-missing' };
    }
    const artifact = JSON.parse(readFileSync(artifactReference.resolvedPath, 'utf8')) as Record<string, unknown>;
    const raw = JSON.parse(readFileSync(rawReference.resolvedPath, 'utf8')) as Record<string, unknown>;
    const { digest: suppliedDigest, ...unsignedArtifact } = artifact;
    if (artifact.schemaVersion !== 'fair-scheduler-decision/v1' || artifact.state !== 'complete') {
      return { accepted: false, reason: 'decision-artifact-incomplete' };
    }
    if (artifact.stagingValidated !== true) {
      return { accepted: false, reason: 'decision-artifact-staging-validation-missing' };
    }
    if (typeof suppliedDigest !== 'string' || suppliedDigest !== sha256(unsignedArtifact)) {
      return { accepted: false, reason: 'decision-artifact-digest-mismatch' };
    }
    if (publication.digest !== suppliedDigest) {
      return { accepted: false, reason: 'decision-artifact-publication-digest-mismatch' };
    }
    if (artifact.rawEvidenceDigest !== sha256(raw)) {
      return { accepted: false, reason: 'decision-artifact-raw-evidence-mismatch' };
    }
    if (artifact.sourceDigest !== getFairSchedulerBenchmarkSourceDigest()) {
      return { accepted: false, reason: 'decision-artifact-source-digest-mismatch' };
    }
    const benchmarkValidation = validateFairSchedulerDecisionArtifact({ artifact, rawArtifacts: raw });
    if (!benchmarkValidation.accepted) {
      return { accepted: false, reason: `decision-artifact-${benchmarkValidation.reason}` };
    }
    const contract = getFairSchedulerBenchmarkContract();
    const runtimePolicyHash = input.runtimePolicy === undefined
      ? contract.policyHash
      : sha256(input.runtimePolicy);
    const contractValidation = validateFairDeliveryCandidateArtifact({
      policyHash: runtimePolicyHash,
      workloadSchemaHash: contract.workloadSchemaHash,
      artifact: {
        state: artifact.state as 'missing' | 'incomplete' | 'complete',
        policyHash: artifact.policyHash as string | undefined,
        workloadSchemaHash: artifact.workloadSchemaHash as string | undefined,
        validatorVerdict: artifact.validatorVerdict as 'accept' | 'reject' | undefined,
      },
    });
    if (!contractValidation.accepted) {
      return {
        accepted: false,
        reason: input.runtimePolicy === undefined
          ? contractValidation.reason
          : 'decision-artifact-runtime-policy-hash-mismatch',
      };
    }
    if (raw.schemaVersion !== 'fair-scheduler-raw/v1' || raw.execution !== 'scheduler-execution'
      || !Array.isArray(raw.samples) || raw.samples.length === 0) {
      return { accepted: false, reason: 'decision-artifact-raw-evidence-invalid' };
    }
    if (!Array.isArray(artifact.rawEvidencePaths) || artifact.rawEvidencePaths.length === 0) {
      return { accepted: false, reason: 'decision-artifact-trial-evidence-missing' };
    }
    if (!hasFairSchedulerPublicationGenerationLayout(publication.generationId, artifact.rawEvidencePaths)) {
      return { accepted: false, reason: 'decision-artifact-publication-generation-mismatch' };
    }
    if (!hasExactFairSchedulerEvidenceGenerationInventory({
      artifactRoot: evidenceRoot,
      generationId: publication.generationId,
      evidencePaths: [publication.artifactPath, publication.rawPath, ...artifact.rawEvidencePaths],
    })) {
      return { accepted: false, reason: 'decision-artifact-generation-inventory-mismatch' };
    }
    const trialArtifacts: unknown[] = [];
    for (const evidencePath of artifact.rawEvidencePaths) {
      if (typeof evidencePath !== 'string' || evidencePath.length === 0) {
        return { accepted: false, reason: 'decision-artifact-trial-evidence-invalid' };
      }
      const evidenceReference = validateFairSchedulerEvidenceReference(evidenceRoot, evidencePath);
      if (!evidenceReference.accepted || !existsSync(evidenceReference.resolvedPath)) {
        return { accepted: false, reason: 'decision-artifact-trial-evidence-missing' };
      }
      trialArtifacts.push(JSON.parse(readFileSync(evidenceReference.resolvedPath, 'utf8')));
    }
    const trialValidation = validateFairSchedulerTrialArtifacts({ rawArtifacts: raw, trialArtifacts });
    if (!trialValidation.accepted) {
      return { accepted: false, reason: `decision-artifact-${trialValidation.reason}` };
    }
    if (artifact.validatorVerdict !== 'accept' || artifact.accepted !== true || artifact.promotionAllowed !== true
      || artifact.allRegisteredThresholdsPassed !== true || artifact.hasUnboundedEligibleLaneStarvation !== false) {
      return { accepted: false, reason: 'decision-artifact-rejected' };
    }
    return { accepted: true, reason: 'decision-artifact-verified' };
  } catch {
    return { accepted: false, reason: 'decision-artifact-invalid-json' };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// @req PERF-BGSTAB-010 AC-3 AC-4
function readCanonicalAuthorityJson(evidenceRoot: string, declaredPath: string): unknown | undefined {
  const reference = validateFairSchedulerEvidenceReference(evidenceRoot, declaredPath);
  if (!reference.accepted || !existsSync(reference.resolvedPath)) return undefined;
  return JSON.parse(readFileSync(reference.resolvedPath, 'utf8'));
}

// @req PERF-BGSTAB-010 AC-3 AC-4
function validateFairDeliveryCandidateArtifactAtCanonicalAuthority(input: {
  runtimePolicy?: unknown;
}, evidenceRoot: string): { accepted: boolean; reason: string } {
  try {
    const artifact = readCanonicalAuthorityJson(evidenceRoot, 'fair-scheduler-decision.json');
    if (!isRecord(artifact)) return { accepted: false, reason: 'decision-artifact-missing' };

    const provenance = readCanonicalAuthorityJson(evidenceRoot, 'provenance.json');
    if (!isRecord(provenance)) return { accepted: false, reason: 'decision-artifact-provenance-missing' };

    const rawManifest = readCanonicalAuthorityJson(evidenceRoot, 'raw/manifest.json');
    if (!isRecord(rawManifest) || !Array.isArray(rawManifest.entries)) {
      return { accepted: false, reason: 'decision-artifact-raw-manifest-invalid' };
    }
    const manifestPaths = new Set<string>();
    for (const entry of rawManifest.entries) {
      if (!isRecord(entry) || typeof entry.path !== 'string' || typeof entry.sha256 !== 'string') {
        return { accepted: false, reason: 'decision-artifact-raw-manifest-invalid' };
      }
      const reference = validateFairSchedulerEvidenceReference(evidenceRoot, entry.path);
      if (!reference.accepted || !entry.path.startsWith('raw/')) {
        return { accepted: false, reason: 'decision-artifact-raw-manifest-invalid' };
      }
      manifestPaths.add(entry.path);
    }

    if (!Array.isArray(artifact.rawEvidencePaths) || artifact.rawEvidencePaths.length === 0) {
      return { accepted: false, reason: 'decision-artifact-trial-evidence-missing' };
    }
    const trialArtifacts: unknown[] = [];
    const samples: unknown[] = [];
    const trialSchedules: unknown[] = [];
    for (const evidencePath of artifact.rawEvidencePaths) {
      if (typeof evidencePath !== 'string' || evidencePath.length === 0) {
        return { accepted: false, reason: 'decision-artifact-trial-evidence-invalid' };
      }
      const directRawPath = `raw/${evidencePath}`;
      if (!manifestPaths.has(directRawPath)) {
        return { accepted: false, reason: 'decision-artifact-trial-evidence-missing' };
      }
      const trialArtifact = readCanonicalAuthorityJson(evidenceRoot, directRawPath);
      if (!isRecord(trialArtifact) || !Array.isArray(trialArtifact.samples)) {
        return { accepted: false, reason: 'decision-artifact-trial-evidence-invalid' };
      }
      trialArtifacts.push(trialArtifact);
      samples.push(...trialArtifact.samples);
      trialSchedules.push(trialArtifact.schedule);
    }

    const workload = isRecord(artifact.workload) ? artifact.workload : {};
    const wan = isRecord(workload.wan) ? workload.wan : {};
    const rawArtifacts = {
      schemaVersion: 'fair-scheduler-raw/v1',
      execution: 'scheduler-execution',
      workload: {
        clients: workload.clients,
        wanLatencyMs: wan.latencyMs,
        wanJitterMs: wan.jitterMs,
        wanLossPercent: wan.lossPercent,
        seed: workload.seed,
        repeats: workload.repeats,
        samples: workload.samples,
      },
      runtimePolicyProfile: artifact.runtimePolicyProfile,
      samples,
      trialSchedules,
    };
    const benchmarkValidation = validateFairSchedulerDecisionArtifact({ artifact, rawArtifacts });
    if (!benchmarkValidation.accepted) {
      return { accepted: false, reason: `decision-artifact-${benchmarkValidation.reason}` };
    }
    const trialValidation = validateFairSchedulerTrialArtifacts({ rawArtifacts, trialArtifacts });
    if (!trialValidation.accepted) {
      return { accepted: false, reason: `decision-artifact-${trialValidation.reason}` };
    }
    if (input.runtimePolicy === undefined) {
      return provenance.policy_digest === artifact.policyHash
        ? { accepted: true, reason: 'decision-artifact-verified' }
        : { accepted: false, reason: 'decision-artifact-authority-policy-identity-mismatch' };
    }
    const contract = getFairSchedulerBenchmarkContract();
    const runtimePolicyHash = sha256(input.runtimePolicy);
    const contractValidation = validateFairDeliveryCandidateArtifact({
      policyHash: runtimePolicyHash,
      workloadSchemaHash: contract.workloadSchemaHash,
      artifact: {
        state: artifact.state as 'missing' | 'incomplete' | 'complete',
        policyHash: artifact.policyHash as string | undefined,
        workloadSchemaHash: artifact.workloadSchemaHash as string | undefined,
        validatorVerdict: artifact.validatorVerdict as 'accept' | 'reject' | undefined,
      },
    });
    if (!contractValidation.accepted) {
      return {
        accepted: false,
        reason: input.runtimePolicy === undefined
          ? contractValidation.reason
          : 'decision-artifact-runtime-policy-hash-mismatch',
      };
    }
    return { accepted: true, reason: 'decision-artifact-verified' };
  } catch {
    return { accepted: false, reason: 'decision-artifact-invalid-json' };
  }
}

// @req PERF-BGSTAB-010 AC-3 AC-4
export function createPublishedFairDeliveryCandidateArtifactValidator(
  resolver?: FairSchedulerEvidenceAuthorityResolver,
): (input?: { runtimePolicy?: unknown }) => { accepted: boolean; reason: string } {
  const authorityResolver = resolver ?? createFairSchedulerEvidenceAuthorityResolver();
  return (input = {}) => {
    const expectedPolicyDigest = input.runtimePolicy === undefined ? undefined : sha256(input.runtimePolicy);
    const authority = authorityResolver.validate(
      expectedPolicyDigest === undefined ? {} : { expectedPolicyDigest },
    );
    if (!authority.accepted) {
      return {
        accepted: false,
        reason: input.runtimePolicy === undefined || authority.reason !== 'authority-policy-digest-mismatch'
          ? authority.reason
          : 'decision-artifact-runtime-policy-hash-mismatch',
      };
    }
    return validateFairDeliveryCandidateArtifactAtCanonicalAuthority(input, authority.evidenceRoot);
  };
}

const validateDefaultPublishedFairDeliveryCandidateArtifact = createPublishedFairDeliveryCandidateArtifactValidator();

export function validateStagedFairDeliveryCandidateArtifact(input: {
  artifactRoot: string;
  runtimePolicy?: unknown;
}): { accepted: boolean; reason: string } {
  return validateFairDeliveryCandidateArtifactAtEvidenceRoot(input, input.artifactRoot);
}

const TRUSTED_REQUIREMENT_ID = 'OBS-BGSTAB-005';
const TRUSTED_STATUS = 'implemented';
const TRUSTED_MANIFEST_SHA256 = '2dfec602f8e22db0569e5ff67f75bceada37d1959af38ecdb52441ebca7b3b57';

const RESOURCE_CONSUMERS: Record<TerminalResourcePolicyCanaryResource, TerminalResourcePolicyCanaryConsumer> = {
  'resourceLimits.ws.perClientOutputQueueMaxBytes': 'server.ws.router',
  'resourceLimits.headless.pendingOutputMaxBytes': 'server.pty.headless-model',
};

function freezeTarget(target: TerminalResourcePolicyCanaryTarget): TerminalResourcePolicyCanaryTarget {
  return Object.freeze(structuredClone(target));
}

function targetKey(target: TerminalResourcePolicyCanaryTarget): string {
  return target.kind === 'ws'
    ? JSON.stringify([
        'ws', target.connectionId, target.clientId, target.channel, target.reconnectGeneration,
      ])
    : JSON.stringify(['headless', target.sessionId]);
}

function sameTarget(
  left: TerminalResourcePolicyCanaryTarget,
  right: TerminalResourcePolicyCanaryTarget,
): boolean {
  return targetKey(left) === targetKey(right);
}

function isTrustedEvidence(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const evidence = value as Record<string, unknown>;
  return evidence.requirementId === TRUSTED_REQUIREMENT_ID
    && evidence.status === TRUSTED_STATUS
    && evidence.manifestSha256 === TRUSTED_MANIFEST_SHA256;
}

function isValidDecision(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0;
}

function isValidContract(contract: TerminalResourcePolicyCanaryContract): boolean {
  if (
    contract.stability !== 'stable'
    || contract.policyId !== TERMINAL_RESOURCE_POLICY_CANARY_POLICY_ID
    || contract.profileVersion !== TERMINAL_RESOURCE_POLICY_CANARY_PROFILE_VERSION
    || contract.schemaVersion !== TERMINAL_RESOURCE_POLICY_CANARY_SCHEMA_VERSION
  ) {
    return false;
  }
  const resources = Object.entries(contract.resources) as Array<[
    TerminalResourcePolicyCanaryResource,
    unknown,
  ]>;
  if (resources.length === 0) return false;
  return resources.every(([resource, decision]) => (
    RESOURCE_CONSUMERS[resource] !== undefined
    && isValidDecision(decision)
    && contract.requiredCapabilities[RESOURCE_CONSUMERS[resource]]
      === TERMINAL_RESOURCE_POLICY_CANARY_CAPABILITY_VERSION
  ));
}

function cloneContract(contract: TerminalResourcePolicyCanaryContract): TerminalResourcePolicyCanaryContract {
  return Object.freeze({
    ...structuredClone(contract),
    requiredCapabilities: Object.freeze(structuredClone(contract.requiredCapabilities)),
    resources: Object.freeze(structuredClone(contract.resources)),
  });
}

// @req REL-BGSTAB-010
export function createTerminalResourcePolicyLeaseIssuer(options: {
  trustedEvidence?: { requirementId: string; status: string; manifestSha256: string };
  contracts?: readonly TerminalResourcePolicyCanaryContract[];
}): TerminalResourcePolicyLeaseAuthority {
  const suppliedContracts = options.contracts ?? [];
  const contractsAreTrusted = isTrustedEvidence(options.trustedEvidence)
    && suppliedContracts.every(isValidContract);
  const contracts = new Map<string, TerminalResourcePolicyCanaryContract>(
    suppliedContracts.map(contract => [contract.contractId, cloneContract(contract)]),
  );
  const grants = new WeakMap<object, Omit<TerminalResourcePolicyLeaseGrant, 'currentTargetEpoch'>>();
  const targetEpochs = new Map<string, number>();
  let issuanceSequence = 0;

  const readGrant = (value: unknown): Omit<TerminalResourcePolicyLeaseGrant, 'currentTargetEpoch'> | undefined => (
    typeof value === 'object' && value !== null ? grants.get(value) : undefined
  );

  const authority: TerminalResourcePolicyLeaseAuthority = {
    issue(input) {
      if (!isTrustedEvidence(options.trustedEvidence) || !contractsAreTrusted) {
        return { mode: 'legacy' as const, reason: 'candidate-not-trusted' };
      }
      const contract = contracts.get(input.contractId);
      if (!contract) {
        return { mode: 'legacy' as const, reason: 'candidate-unavailable' };
      }
      if (RESOURCE_CONSUMERS[input.resource] !== input.consumer) {
        return { mode: 'legacy' as const, reason: 'resource-consumer-mismatch' };
      }
      if (
        (input.resource === 'resourceLimits.ws.perClientOutputQueueMaxBytes'
          && input.target.kind !== 'ws')
        || (input.resource === 'resourceLimits.headless.pendingOutputMaxBytes'
          && input.target.kind !== 'headless')
      ) {
        return { mode: 'legacy' as const, reason: 'resource-target-mismatch' };
      }
      const decision = contract.resources[input.resource];
      if (!isValidDecision(decision)) {
        return { mode: 'legacy' as const, reason: 'candidate-unavailable' };
      }
      if (!input.capability) {
        return { mode: 'legacy' as const, reason: 'capability-missing' };
      }
      if (input.capability.compilerSchemaVersion !== contract.schemaVersion) {
        return { mode: 'legacy' as const, reason: 'compiler-schema-mismatch' };
      }
      if (input.capability.version !== contract.requiredCapabilities[input.consumer]) {
        return { mode: 'legacy' as const, reason: 'capability-version-mismatch' };
      }
      if (!sameTarget(input.target, input.selectedTarget)) {
        return { mode: 'legacy' as const, reason: 'target-not-selected' };
      }
      const frozenTarget = freezeTarget(input.target);
      const epoch = targetEpochs.get(targetKey(frozenTarget)) ?? 0;
      const sequence = ++issuanceSequence;
      const lease: TerminalResourcePolicyLease = Object.freeze({
        leaseId: `trp-${sequence.toString(36)}`,
        policyId: contract.policyId,
        profileVersion: contract.profileVersion,
        schemaVersion: TERMINAL_RESOURCE_POLICY_CANARY_SCHEMA_VERSION,
        resource: input.resource,
        consumer: input.consumer,
        target: frozenTarget,
      });
      const metadata = Object.freeze({ issuanceSequence: sequence, targetEpoch: epoch });
      grants.set(lease, Object.freeze({ lease, decision, metadata }));
      return { mode: 'candidate' as const, reason: 'candidate-selected', lease };
    },
    validate(value): value is TerminalResourcePolicyLease {
      return readGrant(value) !== undefined;
    },
    getLeaseMetadata(value) {
      return readGrant(value)?.metadata;
    },
    resolve(value) {
      const grant = readGrant(value);
      if (!grant) return undefined;
      return Object.freeze({
        ...grant,
        currentTargetEpoch: targetEpochs.get(targetKey(grant.lease.target)) ?? 0,
      });
    },
    revokeTarget(target) {
      const key = targetKey(target);
      const nextEpoch = (targetEpochs.get(key) ?? 0) + 1;
      targetEpochs.set(key, nextEpoch);
      return nextEpoch;
    },
  };
  return Object.freeze(authority);
}

// @req PERF-BGSTAB-010 AC-3 AC-4
export function validatePublishedFairDeliveryCandidateArtifact(input: {
  runtimePolicy?: unknown;
} = {}): { accepted: boolean; reason: string } {
  return input.runtimePolicy === undefined
    ? validateDefaultPublishedFairDeliveryCandidateArtifact()
    : validateDefaultPublishedFairDeliveryCandidateArtifact(input);
}
