const DECISIONS = new Set(['confirmed-bug-only', 'architectural migration']);
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const EXACT_ID_PATTERN = /^[A-Z][A-Z0-9-]*[A-Z0-9]$/;
const NON_SEPARATE_AUTHORITY_IDS = new Set([
  'MIG-BGSTAB-001',
  'REL-BGSTAB-006',
  'OBS-BGSTAB-004',
  'PERF-BGSTAB-008',
]);

const PREREQUISITE_CONTRACT = Object.freeze({
  splitDrift: Object.freeze({
    requirementId: 'REL-BGSTAB-006',
    artifactKinds: Object.freeze(['split-characterization']),
  }),
  refreshBoundary: Object.freeze({
    requirementId: 'OBS-BGSTAB-004',
    artifactKinds: Object.freeze(['retained-state-characterization']),
  }),
  benchmark: Object.freeze({
    requirementId: 'PERF-BGSTAB-008',
    artifactKinds: Object.freeze(['benchmark-raw', 'benchmark-summary']),
  }),
});

const AUTHORITY_BOUNDARIES = Object.freeze([
  'configuredRetainedStateRange',
  'browserServerAuthorityRange',
  'retentionEviction',
  'checkpointTransaction',
  'compatibilityBoundary',
]);

const NON_AUTHORIZATIONS = Object.freeze({
  serverAuthorityPromotion: false,
  uiVisualChange: false,
  legacyCodeDeletion: false,
  retainedRowsBudget: false,
  aggregateMemoryBudget: false,
  checkpointChunkOrInflightBudget: false,
});

// @req MIG-BGSTAB-001
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// @req MIG-BGSTAB-001
function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

// @req MIG-BGSTAB-001
function addDenial(denialReasons, code, path, message) {
  denialReasons.push({ code, path, message });
}

// @req MIG-BGSTAB-001
function evaluatePrerequisiteFamily(name, evidence, contract, denialReasons) {
  const missing = [];

  if (!isRecord(evidence)) {
    missing.push('evidence');
  } else {
    if (evidence.requirementId !== contract.requirementId) {
      missing.push('requirementId');
    }
    if (!isNonEmptyString(evidence.runId)) {
      missing.push('runId');
    }
    if (!isNonEmptyString(evidence.buildId)) {
      missing.push('buildId');
    }

    const artifacts = Array.isArray(evidence.artifacts) ? evidence.artifacts : [];
    for (const kind of contract.artifactKinds) {
      const artifact = artifacts.find((candidate) => candidate?.kind === kind);
      if (!isRecord(artifact) || !isNonEmptyString(artifact.reference)) {
        missing.push(`artifacts.${kind}.reference`);
      }
      if (!isRecord(artifact) || !DIGEST_PATTERN.test(artifact.contentDigest ?? '')) {
        missing.push(`artifacts.${kind}.contentDigest`);
      }
    }
  }

  const complete = missing.length === 0;
  if (!complete) {
    addDenial(
      denialReasons,
      'PREREQUISITE_EVIDENCE_INCOMPLETE',
      `prerequisiteEvidence.${name}`,
      `Missing or invalid fields: ${missing.join(', ')}`,
    );
  }

  return {
    requirementId: contract.requirementId,
    complete,
    missing,
  };
}

// @req MIG-BGSTAB-001
function evaluateDecisionRationale(value, denialReasons) {
  const selected = Array.isArray(value?.selectedBranchEvidenceReferences)
    ? value.selectedBranchEvidenceReferences.filter(isNonEmptyString)
    : [];
  const rejected = Array.isArray(value?.rejectedBranchEvidenceReferences)
    ? value.rejectedBranchEvidenceReferences.filter(isNonEmptyString)
    : [];

  if (selected.length === 0 || rejected.length === 0) {
    addDenial(
      denialReasons,
      'DECISION_RATIONALE_INCOMPLETE',
      'decisionRationale',
      'Selected-branch and rejected-branch evidence references are both required.',
    );
  }

  return {
    selectedBranchEvidenceReferences: selected,
    rejectedBranchEvidenceReferences: rejected,
  };
}

// @req MIG-BGSTAB-001
function evaluateLocalFixAuthorizations(value, denialReasons) {
  const authorizations = Array.isArray(value) ? value : [];

  if (authorizations.length > 1) {
    addDenial(
      denialReasons,
      'BUG_ONLY_FIX_LIMIT_EXCEEDED',
      'localFixAuthorizations',
      'confirmed-bug-only permits at most one separately authorized local fix.',
    );
  }

  for (const [index, authorization] of authorizations.entries()) {
    const complete = isRecord(authorization)
      && EXACT_ID_PATTERN.test(authorization.id ?? '')
      && isNonEmptyString(authorization.authorizationEvidenceReference)
      && isNonEmptyString(authorization.reproductionEvidenceReference);
    if (!complete) {
      addDenial(
        denialReasons,
        'LOCAL_FIX_AUTHORIZATION_INCOMPLETE',
        `localFixAuthorizations.${index}`,
        'An exact ID, separate authorization reference, and reproduction evidence are required.',
      );
    }
  }

  return authorizations.length === 1
    && !denialReasons.some(({ code }) => code.startsWith('LOCAL_FIX_') || code === 'BUG_ONLY_FIX_LIMIT_EXCEEDED')
    ? authorizations[0].id
    : null;
}

// @req MIG-BGSTAB-001
function evaluateAuthorityRequirement(value, denialReasons) {
  const identityComplete = isRecord(value)
    && EXACT_ID_PATTERN.test(value.requirementId ?? '')
    && !NON_SEPARATE_AUTHORITY_IDS.has(value.requirementId)
    && value.stability === 'stable'
    && isNonEmptyString(value.authorizationEvidenceReference);

  if (!identityComplete) {
    addDenial(
      denialReasons,
      'STABLE_AUTHORITY_REQUIREMENT_REQUIRED',
      'authorityRequirement',
      'A separately authorized exact Requirement with Stability=stable is required.',
    );
  }

  const boundariesComplete = isRecord(value?.boundaries)
    && AUTHORITY_BOUNDARIES.every((key) => value.boundaries[key] === true);
  if (identityComplete && !boundariesComplete) {
    addDenial(
      denialReasons,
      'AUTHORITY_REQUIREMENT_BOUNDARIES_INCOMPLETE',
      'authorityRequirement.boundaries',
      `All authority boundaries are required: ${AUTHORITY_BOUNDARIES.join(', ')}.`,
    );
  }

  return identityComplete && boundariesComplete ? value.requirementId : null;
}

// @req MIG-BGSTAB-001
function evaluateImplicitAuthorizationRequests(value, denialReasons) {
  const requestedKeys = isRecord(value)
    ? Object.entries(value)
      .filter(([key, requested]) => key in NON_AUTHORIZATIONS && requested === true)
      .map(([key]) => key)
    : [];

  if (requestedKeys.length > 0) {
    addDenial(
      denialReasons,
      'IMPLICIT_AUTHORIZATION_FORBIDDEN',
      'requestedImplicitAuthorizations',
      `G1 does not authorize: ${requestedKeys.join(', ')}.`,
    );
  }
}

// @req MIG-BGSTAB-001
function buildGitHubIssueStates(state) {
  return Object.fromEntries(
    Array.from({ length: 19 }, (_, index) => [`#${index + 4}`, state]),
  );
}

// @req MIG-BGSTAB-001
function evaluateActivationLifecycle(decision, evaluationStage, value) {
  if (decision !== 'architectural migration') {
    return {
      applicable: false,
      ready: false,
      status: 'not-applicable',
      checks: {},
      pendingReasons: [],
    };
  }

  const evidence = evaluationStage === 'activation-reevaluation' && isRecord(value)
    ? value
    : {};
  const phaseReviewComplete = evidence.phaseReview?.taskId === 'T-PH004-05'
    && evidence.phaseReview?.verdict === 'No findings'
    && isNonEmptyString(evidence.phaseReview?.evidenceReference);
  const migrationRequirementComplete = evidence.migrationRequirement?.requirementId
      === 'MIG-BGSTAB-001'
    && evidence.migrationRequirement?.status === 'implemented'
    && isNonEmptyString(evidence.migrationRequirement?.evidenceReference);
  const wave1ClosureComplete = evidence.wave1Closure?.target === 'wave-1'
    && evidence.wave1Closure?.status === 'completed'
    && isNonEmptyString(evidence.wave1Closure?.completionEventReference);

  const pendingReasons = [];
  if (!phaseReviewComplete) {
    addDenial(
      pendingReasons,
      'PHASE_REVIEW_NOT_COMPLETE',
      'activationLifecycleEvidence.phaseReview',
      'T-PH004-05 must have an external No findings review evidence reference.',
    );
  }
  if (!migrationRequirementComplete) {
    addDenial(
      pendingReasons,
      'MIGRATION_REQUIREMENT_NOT_IMPLEMENTED',
      'activationLifecycleEvidence.migrationRequirement',
      'MIG-BGSTAB-001 must have external Status=implemented evidence.',
    );
  }
  if (!wave1ClosureComplete) {
    addDenial(
      pendingReasons,
      'WAVE1_NOT_CLOSED',
      'activationLifecycleEvidence.wave1Closure',
      'Wave 1 must have an external completed event reference.',
    );
  }

  const ready = pendingReasons.length === 0;
  return {
    applicable: true,
    ready,
    status: ready ? 'wave1-closed' : 'pending-wave1-closure',
    checks: {
      phaseReview: {
        complete: phaseReviewComplete,
        taskId: 'T-PH004-05',
        requiredVerdict: 'No findings',
        evidenceReference: phaseReviewComplete ? evidence.phaseReview.evidenceReference : null,
      },
      migrationRequirement: {
        complete: migrationRequirementComplete,
        requirementId: 'MIG-BGSTAB-001',
        requiredStatus: 'implemented',
        evidenceReference: migrationRequirementComplete
          ? evidence.migrationRequirement.evidenceReference
          : null,
      },
      wave1Closure: {
        complete: wave1ClosureComplete,
        target: 'wave-1',
        requiredStatus: 'completed',
        completionEventReference: wave1ClosureComplete
          ? evidence.wave1Closure.completionEventReference
          : null,
      },
    },
    pendingReasons,
  };
}

// @req MIG-BGSTAB-001
function buildActivationState(result, decision, hasLocalFix, activationReadiness) {
  if (result === 'deny') {
    return {
      waves: {
        'wave-1': 'g1-denied',
        'wave-2': 'inactive',
        'wave-3': 'inactive',
        'wave-4': 'inactive',
        'wave-5': 'inactive',
      },
      githubIssues: buildGitHubIssueStates('inactive'),
    };
  }

  if (decision === 'confirmed-bug-only') {
    return {
      waves: {
        'wave-1': hasLocalFix ? 'local-fix-only' : 'no-local-fix',
        'wave-2': 'inactive',
        'wave-3': 'inactive',
        'wave-4': 'inactive',
        'wave-5': 'inactive',
      },
      githubIssues: buildGitHubIssueStates('inactive'),
    };
  }

  if (!activationReadiness.ready) {
    return {
      waves: {
        'wave-1': 'pending-wave1-closure',
        'wave-2': 'eligible-after-wave1-closure',
        'wave-3': 'deferred',
        'wave-4': 'deferred',
        'wave-5': 'deferred',
      },
      githubIssues: buildGitHubIssueStates('deferred'),
    };
  }

  return {
    waves: {
      'wave-1': 'completed',
      'wave-2': 'eligible',
      'wave-3': 'deferred',
      'wave-4': 'deferred',
      'wave-5': 'deferred',
    },
    githubIssues: buildGitHubIssueStates('deferred'),
  };
}

// @req MIG-BGSTAB-001
function evaluateG1DecisionAtStage(input, evaluationStage) {
  const source = isRecord(input) ? input : {};
  const denialReasons = [];
  const selectedDecision = DECISIONS.has(source.decision) ? source.decision : null;

  if (selectedDecision === null) {
    addDenial(
      denialReasons,
      'INVALID_OR_MISSING_DECISION',
      'decision',
      'Decision must be exactly confirmed-bug-only or architectural migration.',
    );
  }

  const prerequisiteEvidence = Object.fromEntries(
    Object.entries(PREREQUISITE_CONTRACT).map(([name, contract]) => [
      name,
      evaluatePrerequisiteFamily(
        name,
        source.prerequisiteEvidence?.[name],
        contract,
        denialReasons,
      ),
    ]),
  );
  const prerequisiteEvidenceComplete = Object.values(prerequisiteEvidence)
    .every(({ complete }) => complete);
  const rationale = evaluateDecisionRationale(source.decisionRationale, denialReasons);

  let authorizedLocalFixId = null;
  let stableAuthorityRequirementId = null;
  if (selectedDecision === 'confirmed-bug-only') {
    authorizedLocalFixId = evaluateLocalFixAuthorizations(
      source.localFixAuthorizations,
      denialReasons,
    );
  } else if (selectedDecision === 'architectural migration') {
    if (Array.isArray(source.localFixAuthorizations) && source.localFixAuthorizations.length > 0) {
      addDenial(
        denialReasons,
        'LOCAL_FIX_NOT_ALLOWED_FOR_MIGRATION',
        'localFixAuthorizations',
        'The architectural migration branch cannot activate a Wave-1 local fix.',
      );
    }
    stableAuthorityRequirementId = evaluateAuthorityRequirement(
      source.authorityRequirement,
      denialReasons,
    );
  }

  evaluateImplicitAuthorizationRequests(source.requestedImplicitAuthorizations, denialReasons);

  const result = denialReasons.length === 0 ? 'allow' : 'deny';
  const activationReadiness = evaluateActivationLifecycle(
    selectedDecision,
    evaluationStage,
    source.activationLifecycleEvidence,
  );
  return {
    schemaVersion: '1.0.0',
    evaluationStage,
    selectedDecision,
    result,
    prerequisiteEvidenceComplete,
    prerequisiteEvidence,
    decisionRationale: rationale,
    authorizedLocalFixId: result === 'allow' ? authorizedLocalFixId : null,
    stableAuthorityRequirementId: result === 'allow' ? stableAuthorityRequirementId : null,
    activationState: buildActivationState(
      result,
      selectedDecision,
      authorizedLocalFixId !== null,
      activationReadiness,
    ),
    activationReadiness,
    authorizations: { ...NON_AUTHORIZATIONS },
    denialReasons,
  };
}

// @req MIG-BGSTAB-001
export function evaluateG1Decision(input) {
  return evaluateG1DecisionAtStage(input, 'decision');
}

// @req MIG-BGSTAB-001
export function evaluateG1Activation(input) {
  return evaluateG1DecisionAtStage(input, 'activation-reevaluation');
}
