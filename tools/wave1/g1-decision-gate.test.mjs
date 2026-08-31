import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';

const GATE_MODULE_URL = new URL('./g1-decision-gate.mjs', import.meta.url);
const SHA_A = `sha256:${'a'.repeat(64)}`;
const SHA_B = `sha256:${'b'.repeat(64)}`;
const SHA_C = `sha256:${'c'.repeat(64)}`;
const SHA_D = `sha256:${'d'.repeat(64)}`;

async function loadEvaluator(failureSignature) {
  return (await loadGateModule(failureSignature)).evaluateG1Decision;
}

async function loadGateModule(failureSignature) {
  try {
    return await import(GATE_MODULE_URL.href);
  } catch (error) {
    if (
      error?.code === 'ERR_MODULE_NOT_FOUND'
      && String(error.message).includes('g1-decision-gate.mjs')
    ) {
      assert.fail(failureSignature);
    }
    throw error;
  }
}

function prerequisiteEvidence() {
  return {
    splitDrift: {
      requirementId: 'REL-BGSTAB-006',
      runId: '2026-07-15.projectmaster.wave1-baseline',
      buildId: 'buildergate-wave1-local',
      artifacts: [
        {
          kind: 'split-characterization',
          reference: 'docs/analysis/split-characterization.json',
          contentDigest: SHA_A,
        },
      ],
    },
    refreshBoundary: {
      requirementId: 'OBS-BGSTAB-004',
      runId: '2026-07-15.projectmaster.wave1-baseline',
      buildId: 'buildergate-wave1-local',
      artifacts: [
        {
          kind: 'retained-state-characterization',
          reference: 'docs/analysis/retained-state-characterization.json',
          contentDigest: SHA_B,
        },
      ],
    },
    benchmark: {
      requirementId: 'PERF-BGSTAB-008',
      runId: '2026-07-15.projectmaster.wave1-baseline',
      buildId: 'buildergate-wave1-local',
      artifacts: [
        {
          kind: 'benchmark-raw',
          reference: 'docs/analysis/benchmark-raw-samples.json',
          contentDigest: SHA_C,
        },
        {
          kind: 'benchmark-summary',
          reference: 'docs/analysis/benchmark-summary.json',
          contentDigest: SHA_D,
        },
      ],
    },
  };
}

function decisionRationale() {
  return {
    selectedBranchEvidenceReferences: ['docs/analysis/selected-branch-evidence.json'],
    rejectedBranchEvidenceReferences: ['docs/analysis/rejected-branch-evidence.json'],
  };
}

function localFixAuthorization(id = 'BUG-BGSTAB-REFRESH-001') {
  return {
    id,
    authorizationEvidenceReference: `github://issues/${id}`,
    reproductionEvidenceReference: 'docs/analysis/retained-state-characterization.json',
  };
}

function stableAuthorityRequirement() {
  return {
    requirementId: 'AUTH-BGSTAB-001',
    stability: 'stable',
    authorizationEvidenceReference: 'docs/spec/30.buildergate-stability.srs.md#AUTH-BGSTAB-001',
    boundaries: {
      configuredRetainedStateRange: true,
      browserServerAuthorityRange: true,
      retentionEviction: true,
      checkpointTransaction: true,
      compatibilityBoundary: true,
    },
  };
}

function validInput(decision) {
  return {
    decision,
    prerequisiteEvidence: prerequisiteEvidence(),
    decisionRationale: decisionRationale(),
    localFixAuthorizations:
      decision === 'confirmed-bug-only' ? [localFixAuthorization()] : [],
    authorityRequirement:
      decision === 'architectural migration' ? stableAuthorityRequirement() : null,
  };
}

function completedActivationLifecycleEvidence() {
  return {
    phaseReview: {
      taskId: 'T-PH004-05',
      verdict: 'No findings',
      evidenceReference: 'docs/analysis/ph004-completion-review.ko.md',
    },
    migrationRequirement: {
      requirementId: 'MIG-BGSTAB-001',
      status: 'implemented',
      evidenceReference: 'docs/spec/30.buildergate-stability.srs.md#MIG-BGSTAB-001',
    },
    wave1Closure: {
      target: 'wave-1',
      status: 'completed',
      completionEventReference: 'workflow://wave-1/completed',
    },
  };
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}

async function digestFile(path) {
  const bytes = await readFile(path);
  return createHash('sha256').update(bytes).digest('hex');
}

describe('MIG-BGSTAB-001 AC-1 RED contract', () => {
  test('MIG-BGSTAB-001 AC-1 GREEN contract', async () => {
    const evaluate = await loadEvaluator('MIG-BGSTAB-001 AC-1 contract not implemented');
    const incomplete = validInput('confirmed-bug-only');
    delete incomplete.prerequisiteEvidence.benchmark.artifacts[1].contentDigest;

    const denied = evaluate(incomplete);
    assert.equal(denied.result, 'deny');
    assert.equal(denied.prerequisiteEvidenceComplete, false);
    assert.ok(denied.denialReasons.some(({ code }) => code === 'PREREQUISITE_EVIDENCE_INCOMPLETE'));

    const allowed = evaluate(validInput('confirmed-bug-only'));
    assert.equal(allowed.prerequisiteEvidenceComplete, true);
    assert.equal(allowed.result, 'allow');
  });
});

describe('MIG-BGSTAB-001 AC-2 RED contract', () => {
  test('MIG-BGSTAB-001 AC-2 GREEN contract', async () => {
    const evaluate = await loadEvaluator('MIG-BGSTAB-001 AC-2 contract not implemented');

    for (const decision of [undefined, null, '', 'migration', 'confirmed_bug_only']) {
      const input = validInput('confirmed-bug-only');
      input.decision = decision;
      const denied = evaluate(input);
      assert.equal(denied.result, 'deny');
      assert.ok(denied.denialReasons.some(({ code }) => code === 'INVALID_OR_MISSING_DECISION'));
    }

    for (const decision of ['confirmed-bug-only', 'architectural migration']) {
      const allowed = evaluate(validInput(decision));
      assert.equal(allowed.selectedDecision, decision);
      assert.equal(allowed.result, 'allow');
      assert.deepEqual(allowed.decisionRationale, decisionRationale());
    }
  });
});

describe('MIG-BGSTAB-001 AC-3 RED contract', () => {
  test('MIG-BGSTAB-001 AC-3 GREEN contract', async () => {
    const evaluate = await loadEvaluator('MIG-BGSTAB-001 AC-3 contract not implemented');
    const twoFixes = validInput('confirmed-bug-only');
    twoFixes.localFixAuthorizations.push(localFixAuthorization('BUG-BGSTAB-REFRESH-002'));
    assert.ok(
      evaluate(twoFixes).denialReasons.some(({ code }) => code === 'BUG_ONLY_FIX_LIMIT_EXCEEDED'),
    );

    const unauthorized = validInput('confirmed-bug-only');
    delete unauthorized.localFixAuthorizations[0].authorizationEvidenceReference;
    assert.ok(
      evaluate(unauthorized).denialReasons.some(({ code }) => code === 'LOCAL_FIX_AUTHORIZATION_INCOMPLETE'),
    );

    const allowed = evaluate(validInput('confirmed-bug-only'));
    assert.equal(allowed.result, 'allow');
    assert.equal(allowed.authorizedLocalFixId, 'BUG-BGSTAB-REFRESH-001');
    assert.deepEqual(allowed.activationState.waves, {
      'wave-1': 'local-fix-only',
      'wave-2': 'inactive',
      'wave-3': 'inactive',
      'wave-4': 'inactive',
      'wave-5': 'inactive',
    });
    assert.equal(Object.keys(allowed.activationState.githubIssues).length, 19);
    assert.ok(Object.values(allowed.activationState.githubIssues).every((state) => state === 'inactive'));
  });
});

describe('MIG-BGSTAB-001 AC-4 RED contract', () => {
  test('MIG-BGSTAB-001 AC-4 GREEN contract', async () => {
    const evaluate = await loadEvaluator('MIG-BGSTAB-001 AC-4 contract not implemented');
    const missing = validInput('architectural migration');
    missing.authorityRequirement = null;
    assert.ok(
      evaluate(missing).denialReasons.some(({ code }) => code === 'STABLE_AUTHORITY_REQUIREMENT_REQUIRED'),
    );

    const unstable = validInput('architectural migration');
    unstable.authorityRequirement.stability = 'evolving';
    assert.ok(
      evaluate(unstable).denialReasons.some(({ code }) => code === 'STABLE_AUTHORITY_REQUIREMENT_REQUIRED'),
    );

    const notSeparate = validInput('architectural migration');
    notSeparate.authorityRequirement.requirementId = 'MIG-BGSTAB-001';
    assert.ok(
      evaluate(notSeparate).denialReasons.some(({ code }) => code === 'STABLE_AUTHORITY_REQUIREMENT_REQUIRED'),
    );

    const incompleteBoundary = validInput('architectural migration');
    incompleteBoundary.authorityRequirement.boundaries.checkpointTransaction = false;
    assert.ok(
      evaluate(incompleteBoundary).denialReasons.some(
        ({ code }) => code === 'AUTHORITY_REQUIREMENT_BOUNDARIES_INCOMPLETE',
      ),
    );

    const allowed = evaluate(validInput('architectural migration'));
    assert.equal(allowed.result, 'allow');
    assert.equal(allowed.stableAuthorityRequirementId, 'AUTH-BGSTAB-001');
    assert.equal(allowed.activationState.waves['wave-1'], 'pending-wave1-closure');
    assert.equal(allowed.activationState.waves['wave-2'], 'eligible-after-wave1-closure');
    assert.equal(allowed.activationState.waves['wave-3'], 'deferred');
  });
});

test('FND-PH004-001 separates decision validity from final activation readiness', async () => {
  const gate = await loadGateModule('FND-PH004-001 closure contract not implemented');
  const input = validInput('architectural migration');
  input.activationLifecycleEvidence = completedActivationLifecycleEvidence();

  const decisionOnly = gate.evaluateG1Decision(deepFreeze(input));
  assert.equal(decisionOnly.result, 'allow');
  assert.deepEqual(decisionOnly.denialReasons, []);
  assert.equal(decisionOnly.evaluationStage, 'decision');
  assert.deepEqual(
    decisionOnly.activationState.waves,
    {
      'wave-1': 'pending-wave1-closure',
      'wave-2': 'eligible-after-wave1-closure',
      'wave-3': 'deferred',
      'wave-4': 'deferred',
      'wave-5': 'deferred',
    },
    'FND-PH004-001 closure contract not implemented',
  );
  assert.equal(decisionOnly.activationReadiness.ready, false);
  assert.equal(decisionOnly.activationReadiness.status, 'pending-wave1-closure');

  const incompleteFinalInput = validInput('architectural migration');
  incompleteFinalInput.activationLifecycleEvidence = completedActivationLifecycleEvidence();
  incompleteFinalInput.activationLifecycleEvidence.phaseReview.verdict = 'Findings';
  const incompleteFinal = gate.evaluateG1Activation(incompleteFinalInput);
  assert.equal(incompleteFinal.result, 'allow');
  assert.equal(incompleteFinal.evaluationStage, 'activation-reevaluation');
  assert.equal(incompleteFinal.activationReadiness.ready, false);
  assert.equal(incompleteFinal.activationState.waves['wave-2'], 'eligible-after-wave1-closure');
  assert.ok(
    incompleteFinal.activationReadiness.pendingReasons.some(
      ({ code }) => code === 'PHASE_REVIEW_NOT_COMPLETE',
    ),
  );

  const completeFinalInput = validInput('architectural migration');
  completeFinalInput.activationLifecycleEvidence = completedActivationLifecycleEvidence();
  const finalActivation = gate.evaluateG1Activation(deepFreeze(completeFinalInput));
  assert.equal(finalActivation.result, 'allow');
  assert.equal(finalActivation.evaluationStage, 'activation-reevaluation');
  assert.equal(finalActivation.activationReadiness.ready, true);
  assert.equal(finalActivation.activationReadiness.status, 'wave1-closed');
  assert.deepEqual(finalActivation.activationReadiness.pendingReasons, []);
  assert.deepEqual(finalActivation.activationState.waves, {
    'wave-1': 'completed',
    'wave-2': 'eligible',
    'wave-3': 'deferred',
    'wave-4': 'deferred',
    'wave-5': 'deferred',
  });
});

describe('MIG-BGSTAB-001 AC-5 RED contract', () => {
  test('MIG-BGSTAB-001 AC-5 GREEN contract', async () => {
    const evaluate = await loadEvaluator('MIG-BGSTAB-001 AC-5 contract not implemented');
    const wavesPath = 'kiwi/waves.jsonl';
    const srsPath = 'docs/spec/30.buildergate-stability.srs.md';
    const before = {
      waves: await digestFile(wavesPath),
      srs: await digestFile(srsPath),
    };
    const mutableInput = validInput('architectural migration');
    mutableInput.requestedImplicitAuthorizations = {
      serverAuthorityPromotion: true,
      uiVisualChange: true,
      legacyCodeDeletion: true,
      retainedRowsBudget: true,
      aggregateMemoryBudget: true,
      checkpointChunkOrInflightBudget: true,
    };
    const immutableInput = deepFreeze(mutableInput);
    const denied = evaluate(immutableInput);
    assert.equal(denied.result, 'deny');
    assert.ok(denied.denialReasons.some(({ code }) => code === 'IMPLICIT_AUTHORIZATION_FORBIDDEN'));
    assert.ok(Object.values(denied.authorizations).every((authorized) => authorized === false));
    assert.deepEqual(
      { waves: await digestFile(wavesPath), srs: await digestFile(srsPath) },
      before,
    );
  });
});

describe('MIG-BGSTAB-001 AC-6 RED contract', () => {
  test('MIG-BGSTAB-001 AC-6 GREEN contract', async () => {
    const evaluate = await loadEvaluator('MIG-BGSTAB-001 AC-6 contract not implemented');
    const deniedInput = validInput('architectural migration');
    deniedInput.authorityRequirement = null;
    const denied = evaluate(deniedInput);

    assert.equal(denied.schemaVersion, '1.0.0');
    assert.equal(denied.selectedDecision, 'architectural migration');
    assert.equal(denied.result, 'deny');
    assert.equal(typeof denied.prerequisiteEvidenceComplete, 'boolean');
    assert.equal(denied.authorizedLocalFixId, null);
    assert.equal(denied.stableAuthorityRequirementId, null);
    assert.equal(typeof denied.activationState.waves['wave-2'], 'string');
    assert.ok(denied.denialReasons.length > 0);
    assert.ok(denied.denialReasons.every(({ code, path, message }) => code && path && message));

    const allowed = evaluate(validInput('architectural migration'));
    assert.equal(allowed.result, 'allow');
    assert.deepEqual(allowed.denialReasons, []);
    assert.equal(allowed.stableAuthorityRequirementId, 'AUTH-BGSTAB-001');
  });
});
