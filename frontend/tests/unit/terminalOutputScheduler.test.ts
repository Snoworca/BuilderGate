import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as terminalOutputSchedulerModule from '../../src/utils/terminalOutputScheduler.ts';

const {
  DEFAULT_VISIBLE_FLUSH_FRAME_BUDGET_MS,
  createTerminalOutputPolicyLeaseIssuer,
  createTerminalOutputScheduler,
} = terminalOutputSchedulerModule;

const REVIEWED_FRONTEND_POLICY_PROFILE = Object.freeze({
  policyId: 'test-only-wave3-reviewed',
  profileVersion: '1.0.0',
  schemaVersion: 'terminal-resource-policy/v1',
  stability: 'stable' as const,
  requiredCapabilityVersion: 7,
  selectionId: 'frontend-output-policy-reviewed',
  approvedResourceDecision: Object.freeze({
    candidateQueueMaxBytes: 200,
    legacyQueueMaxBytes: 100,
  }),
});

const REVIEWED_FRONTEND_POLICY_EVIDENCE = Object.freeze({
  requirementId: 'OBS-BGSTAB-005',
  status: 'implemented',
  manifestSha256: '2dfec602f8e22db0569e5ff67f75bceada37d1959af38ecdb52441ebca7b3b57',
});

const REVIEWED_FRONTEND_POLICY_CAPABILITY = Object.freeze({
  consumer: 'frontend.output-scheduler' as const,
  version: 7,
  compilerSchemaVersion: 'terminal-resource-policy/v1',
});

function createReviewedFrontendPolicyIssuer() {
  return createTerminalOutputPolicyLeaseIssuer({
    trustedEvidence: REVIEWED_FRONTEND_POLICY_EVIDENCE,
    profile: REVIEWED_FRONTEND_POLICY_PROFILE,
    capability: REVIEWED_FRONTEND_POLICY_CAPABILITY,
  });
}

test('terminal output scheduler writes queued output within the flush budget', async () => {
  const writes: SchedulerWriteChunk[] = [];
  const scheduler = createTerminalOutputScheduler({
    visibleOutputQueueMaxBytes: 1024,
    visibleOutputMaxChunks: 16,
    visibleFlushBudgetBytes: 4,
    write: (data, onWritten) => {
      writes.push(data);
      onWritten();
    },
    schedule: (drain) => drain(),
  });

  scheduler.enqueue('abcdef');

  assert.deepEqual(writes.map(decodeWriteChunk), ['abcd', 'ef']);
  assert.equal(scheduler.isIdle(), true);
});

test('terminal output scheduler does not split multibyte code points', async () => {
  const writes: SchedulerWriteChunk[] = [];
  const scheduler = createTerminalOutputScheduler({
    visibleOutputQueueMaxBytes: 1024,
    visibleOutputMaxChunks: 16,
    visibleFlushBudgetBytes: 4,
    write: (data, onWritten) => {
      writes.push(data);
      onWritten();
    },
    schedule: (drain) => drain(),
  });

  scheduler.enqueue('한글');

  assert.deepEqual(writes.map(decodeWriteChunk), ['한', '글']);
});

test('terminal output scheduler preserves callback ordering after full chunk writes', async () => {
  const callbacks: string[] = [];
  const scheduler = createTerminalOutputScheduler({
    visibleOutputQueueMaxBytes: 1024,
    visibleOutputMaxChunks: 16,
    visibleFlushBudgetBytes: 3,
    write: (_data, onWritten) => onWritten(),
    schedule: (drain) => drain(),
  });

  scheduler.enqueue('abcd', () => callbacks.push('first'));
  scheduler.enqueue('ef', () => callbacks.push('second'));

  assert.deepEqual(callbacks, ['first', 'second']);
});

test('terminal output scheduler reports overflow instead of accumulating unbounded output', async () => {
  const writes: SchedulerWriteChunk[] = [];
  const scheduler = createTerminalOutputScheduler({
    visibleOutputQueueMaxBytes: 5,
    visibleOutputMaxChunks: 16,
    visibleFlushBudgetBytes: 4,
    write: (data, onWritten) => {
      writes.push(data);
      onWritten();
    },
    schedule: () => {},
  });

  const decision = scheduler.enqueue('abcdef');

  assert.equal(decision.ok, false);
  assert.equal(decision.reason, 'visible-output-overflow');
  assert.equal(decision.droppedBytes, 6);
  assert.deepEqual(writes, []);
  assert.equal(scheduler.isStale(), true);
});

test('terminal output scheduler overflow includes already queued bytes in dropped count', async () => {
  const scheduler = createTerminalOutputScheduler({
    visibleOutputQueueMaxBytes: 8,
    visibleOutputMaxChunks: 16,
    visibleFlushBudgetBytes: 4,
    write: (_data, onWritten) => onWritten(),
    schedule: () => {},
  });

  assert.deepEqual(scheduler.enqueue('abcd'), { ok: true });
  const decision = scheduler.enqueue('efghi');

  assert.equal(decision.ok, false);
  assert.equal(decision.reason, 'visible-output-overflow');
  assert.equal(decision.droppedBytes, 9);
  assert.equal(scheduler.pendingBytes(), 0);
  assert.equal(scheduler.isStale(), true);
});

test('terminal output scheduler reset cancels queued callbacks', async () => {
  let called = false;
  const scheduler = createTerminalOutputScheduler({
    visibleOutputQueueMaxBytes: 1024,
    visibleOutputMaxChunks: 16,
    visibleFlushBudgetBytes: 4,
    write: (_data, onWritten) => onWritten(),
    schedule: () => {},
  });

  scheduler.enqueue('abc', () => { called = true; });
  scheduler.reset();
  scheduler.flush();

  assert.equal(called, false);
  assert.equal(scheduler.isIdle(), true);
  assert.equal(scheduler.isStale(), false);
});

test('terminal output scheduler can update queue limits without recreating the instance', async () => {
  const scheduler = createTerminalOutputScheduler({
    visibleOutputQueueMaxBytes: 10,
    visibleOutputMaxChunks: 16,
    visibleFlushBudgetBytes: 4,
    write: (_data, onWritten) => onWritten(),
    schedule: () => {},
  });

  assert.deepEqual(scheduler.enqueue('abcd'), { ok: true });
  scheduler.configure({ visibleOutputQueueMaxBytes: 5 });
  const decision = scheduler.enqueue('ef');

  assert.equal(decision.ok, false);
  assert.equal(decision.reason, 'visible-output-overflow');
  assert.equal(decision.droppedBytes, 6);
});

// @req REL-BGSTAB-010
test('REL-BGSTAB-010 AC-3 RED — explicit canary transition preserves below/at/above-cap retained FIFO', () => {
  const signature = 'REL-BGSTAB-010 AC-3 explicit frontend canary transition 계약 부재 때문에 실패';
  type FrontendTarget = { viewId: string; connectionId: string; reconnectGeneration: number };
  type FrontendPolicyLease = Readonly<{
    leaseId: string;
    target: FrontendTarget;
    decision: Readonly<{
      candidateQueueMaxBytes: number;
      legacyQueueMaxBytes: number;
      policyGeneration: number;
    }>;
  }>;
  type FrontendLeaseDecision =
    | { mode: 'candidate'; reason: 'candidate-selected'; lease: FrontendPolicyLease }
    | { mode: 'legacy'; reason: string; lease?: undefined };
  type FrontendIssuer = {
    issue(input: { target: FrontendTarget; decision: FrontendPolicyLease['decision'] }): FrontendLeaseDecision;
    validate(value: unknown): value is FrontendPolicyLease;
  };
  type FrontendPolicyModule = {
    createTerminalOutputPolicyLeaseIssuer(options: {
      trustedEvidence: { requirementId: string; status: string; manifestSha256: string };
      profile: {
        policyId: string; profileVersion: string; schemaVersion: string; stability: 'draft' | 'evolving' | 'stable';
        requiredCapabilityVersion: number;
      };
      capability?: { consumer: 'frontend.output-scheduler'; version: number; compilerSchemaVersion: string };
    }): FrontendIssuer;
  };
  const policyModule = terminalOutputSchedulerModule as unknown as Partial<FrontendPolicyModule>;
  assert.equal(typeof policyModule.createTerminalOutputPolicyLeaseIssuer, 'function', signature);
  const trustedIssuerOptions = {
    trustedEvidence: {
      requirementId: 'OBS-BGSTAB-005', status: 'implemented',
      manifestSha256: '2dfec602f8e22db0569e5ff67f75bceada37d1959af38ecdb52441ebca7b3b57',
    },
    profile: {
      policyId: 'test-only-wave3-reviewed', profileVersion: '1.0.0',
      schemaVersion: 'terminal-resource-policy/v1', stability: 'stable' as const,
      requiredCapabilityVersion: 7,
      selectionId: 'frontend-output-policy-reviewed',
      approvedResourceDecision: {
        candidateQueueMaxBytes: 8,
        legacyQueueMaxBytes: 16,
      },
    },
    capability: {
      consumer: 'frontend.output-scheduler' as const, version: 7,
      compilerSchemaVersion: 'terminal-resource-policy/v1',
    },
  };
  const currentTarget: FrontendTarget = {
    viewId: 'view-a', connectionId: 'connection-a', reconnectGeneration: 4,
  };
  const decision = {
    candidateQueueMaxBytes: 8,
    legacyQueueMaxBytes: 16,
    policyGeneration: 41,
  } as const;
  const missingCapabilityIssuer = policyModule.createTerminalOutputPolicyLeaseIssuer!({
    ...trustedIssuerOptions,
    capability: undefined,
  });
  const missingCapabilityDecision = missingCapabilityIssuer.issue({ target: currentTarget, decision });
  assert.deepEqual(missingCapabilityDecision, {
    mode: 'legacy', reason: 'candidate-not-trusted',
  }, 'runtime-missing capability cannot issue a lease');
  for (const invalidOptions of [
    { ...trustedIssuerOptions, trustedEvidence: { ...trustedIssuerOptions.trustedEvidence, status: 'planned' } },
    { ...trustedIssuerOptions, trustedEvidence: { ...trustedIssuerOptions.trustedEvidence, requirementId: 'WRONG-REQUIREMENT' } },
    { ...trustedIssuerOptions, trustedEvidence: { ...trustedIssuerOptions.trustedEvidence, manifestSha256: '0'.repeat(64) } },
    { ...trustedIssuerOptions, profile: { ...trustedIssuerOptions.profile, stability: 'evolving' as const } },
    { ...trustedIssuerOptions, profile: { ...trustedIssuerOptions.profile, policyId: 'unsupported-policy' } },
    { ...trustedIssuerOptions, profile: { ...trustedIssuerOptions.profile, profileVersion: '2.0.0' } },
    { ...trustedIssuerOptions, profile: { ...trustedIssuerOptions.profile, schemaVersion: 'terminal-resource-policy/stale' } },
    { ...trustedIssuerOptions, profile: { ...trustedIssuerOptions.profile, requiredCapabilityVersion: 6 } },
    { ...trustedIssuerOptions, capability: { ...trustedIssuerOptions.capability, version: 6 } },
    { ...trustedIssuerOptions, capability: { ...trustedIssuerOptions.capability, version: 8 } },
    { ...trustedIssuerOptions, capability: { ...trustedIssuerOptions.capability, compilerSchemaVersion: 'stale' } },
  ]) {
    const unavailableIssuer = policyModule.createTerminalOutputPolicyLeaseIssuer!(invalidOptions);
    assert.deepEqual(unavailableIssuer.issue({ target: currentTarget, decision }), {
      mode: 'legacy', reason: 'candidate-not-trusted',
    });
  }
  const issuer = policyModule.createTerminalOutputPolicyLeaseIssuer!(trustedIssuerOptions);
  const issuance = issuer.issue({ target: currentTarget, decision });
  assert.equal(issuance.mode, 'candidate');
  assert.ok(issuance.lease);
  const validLease = issuance.lease;
  assert.equal(issuer.validate(validLease), true);
  assert.equal(Object.isFrozen(validLease), true);
  assert.equal(Object.isFrozen(validLease.target), true);
  assert.equal(Object.isFrozen(validLease.decision), true);
  const forgedLease = { ...validLease } as FrontendPolicyLease;
  assert.equal(issuer.validate(forgedLease), false, 'structural clones are not validated leases');
  const rogueIssuer = policyModule.createTerminalOutputPolicyLeaseIssuer!(trustedIssuerOptions);
  const rogueIssuance = rogueIssuer.issue({ target: currentTarget, decision });
  assert.equal(rogueIssuance.mode, 'candidate');
  assert.ok(rogueIssuance.lease);
  const rogueLease = rogueIssuance.lease;
  assert.equal(rogueIssuer.validate(rogueLease), true);
  assert.equal(issuer.validate(rogueLease), false,
    'identically configured frontend issuers have disjoint runtime provenance');
  for (const oldBytes of [7, 8, 9]) {
    const scheduled: Array<() => void> = [];
    const writes: Uint8Array[] = [];
    const scheduler = createTerminalOutputScheduler({
      visibleOutputQueueMaxBytes: 16,
      visibleOutputMaxChunks: 16,
      visibleFlushBudgetBytes: 16,
      write: (data, onWritten) => {
        writes.push(typeof data === 'string' ? new TextEncoder().encode(data) : data.slice());
        onWritten();
      },
      schedule: drain => scheduled.push(drain),
      canaryTarget: currentTarget,
      validateCanaryPolicyLease: issuer.validate,
    } as Parameters<typeof createTerminalOutputScheduler>[0] & {
      canaryTarget: FrontendTarget;
      validateCanaryPolicyLease: FrontendIssuer['validate'];
    });
    type CanaryScheduler = {
      configureCanaryTransition(lease: FrontendPolicyLease): { mode: 'candidate' | 'legacy'; reason: string; policyGeneration: number };
      getCanaryTransitionSnapshot(): { mode: 'candidate' | 'legacy'; reason: string; policyGeneration: number };
    };
    const canaryScheduler = scheduler as unknown as Partial<CanaryScheduler>;
    const old = 'o'.repeat(oldBytes);
    assert.deepEqual(scheduler.enqueue(old), { ok: true });
    assert.equal(typeof canaryScheduler.configureCanaryTransition, 'function', signature);
    assert.equal(typeof canaryScheduler.getCanaryTransitionSnapshot, 'function', signature);
    const beforeForged = {
      pendingBytes: scheduler.pendingBytes(),
      stale: scheduler.isStale(),
      snapshot: canaryScheduler.getCanaryTransitionSnapshot!(),
      scheduled: scheduled.length,
    };
    assert.deepEqual(canaryScheduler.configureCanaryTransition!(
      missingCapabilityDecision.lease as unknown as FrontendPolicyLease,
    ), {
      mode: 'legacy', reason: 'invalid-policy-lease', policyGeneration: 0,
    });
    assert.deepEqual({
      pendingBytes: scheduler.pendingBytes(),
      stale: scheduler.isStale(),
      snapshot: canaryScheduler.getCanaryTransitionSnapshot!(),
      scheduled: scheduled.length,
    }, beforeForged, 'missing-capability rejection must not mutate queue or active configuration');
    assert.deepEqual(canaryScheduler.configureCanaryTransition!(rogueLease), {
      mode: 'legacy', reason: 'invalid-policy-lease', policyGeneration: 0,
    });
    assert.deepEqual({
      pendingBytes: scheduler.pendingBytes(),
      stale: scheduler.isStale(),
      snapshot: canaryScheduler.getCanaryTransitionSnapshot!(),
      scheduled: scheduled.length,
    }, beforeForged, 'rogue issuer rejection must not mutate queue or active configuration');
    assert.deepEqual(canaryScheduler.configureCanaryTransition!(forgedLease), {
      mode: 'legacy', reason: 'invalid-policy-lease', policyGeneration: 0,
    });
    assert.deepEqual({
      pendingBytes: scheduler.pendingBytes(),
      stale: scheduler.isStale(),
      snapshot: canaryScheduler.getCanaryTransitionSnapshot!(),
      scheduled: scheduled.length,
    }, beforeForged, 'forged lease rejection must not mutate queue or active configuration');
    const transition = canaryScheduler.configureCanaryTransition!(validLease);
    assert.deepEqual(transition, oldBytes <= 8
      ? { mode: 'candidate', reason: 'candidate-selected', policyGeneration: 41 }
      : { mode: 'legacy', reason: 'retained-entry-exceeds-candidate', policyGeneration: 41 });

    assert.deepEqual(scheduler.enqueue('n'), { ok: true });
    assert.deepEqual(canaryScheduler.getCanaryTransitionSnapshot!(), oldBytes + 1 <= 8
      ? { mode: 'candidate', reason: 'candidate-selected', policyGeneration: 41 }
      : { mode: 'legacy', reason: 'candidate-cap-exceeded-fallback', policyGeneration: 41 });
    assert.equal(scheduler.isStale(), false, signature);
    assert.equal(scheduler.pendingBytes(), oldBytes + 1, signature);
    assert.equal(scheduled.length, 1);
    scheduled.shift()?.();
    assert.equal(writes.map(chunk => new TextDecoder().decode(chunk)).join(''), `${old}n`, signature);
    assert.equal(scheduler.isIdle(), true, signature);
    assert.equal(scheduler.isStale(), false, signature);
    for (const staleTarget of [
      { ...currentTarget, viewId: 'stale-view' },
      { ...currentTarget, connectionId: 'stale-connection' },
      { ...currentTarget, reconnectGeneration: 3 },
    ]) {
      const staleIssuance = issuer.issue({ target: staleTarget, decision });
      assert.equal(staleIssuance.mode, 'candidate');
      assert.ok(staleIssuance.lease);
      const staleLease = staleIssuance.lease;
      assert.equal(issuer.validate(staleLease), true, 'stale target check is separate from issuer authenticity');
      const beforeStale = {
        pendingBytes: scheduler.pendingBytes(),
        stale: scheduler.isStale(),
        snapshot: canaryScheduler.getCanaryTransitionSnapshot!(),
      };
      assert.deepEqual(canaryScheduler.configureCanaryTransition!(staleLease), {
        mode: 'legacy', reason: 'stale-target-lease', policyGeneration: 41,
      });
      assert.deepEqual({
        pendingBytes: scheduler.pendingBytes(),
        stale: scheduler.isStale(),
        snapshot: canaryScheduler.getCanaryTransitionSnapshot!(),
      }, beforeStale, 'stale authentic lease rejection must not mutate queue or active configuration');
    }
  }
});

test('REL-BGSTAB-010 frontend canary rejects stale and duplicate policy generations state-preservingly', () => {
  const issuer = createReviewedFrontendPolicyIssuer();
  const target = { viewId: 'view-generation', connectionId: 'connection-generation', reconnectGeneration: 1 };
  const scheduler = createTerminalOutputScheduler({
    visibleOutputQueueMaxBytes: 100,
    visibleOutputMaxChunks: 16,
    visibleFlushBudgetBytes: 100,
    write: (_data, onWritten) => onWritten(),
    canaryTarget: target,
    validateCanaryPolicyLease: issuer.validate,
  });
  const lease = (policyGeneration: number) => {
    const decision = issuer.issue({
      target,
      decision: { candidateQueueMaxBytes: 200, legacyQueueMaxBytes: 100, policyGeneration },
    });
    assert.equal(decision.mode, 'candidate');
    assert.ok(decision.lease);
    return decision.lease;
  };
  const lease41 = lease(41);
  const lease42 = lease(42);
  const duplicate42 = lease(42);

  assert.equal(scheduler.configureCanaryTransition(lease41).policyGeneration, 41);
  assert.equal(scheduler.configureCanaryTransition(lease42).policyGeneration, 42);
  const stateAt42 = scheduler.getCanaryTransitionSnapshot();
  assert.deepEqual(scheduler.configureCanaryTransition(lease41), {
    mode: 'legacy', reason: 'stale-policy-generation', policyGeneration: 41,
  });
  assert.deepEqual(scheduler.getCanaryTransitionSnapshot(), stateAt42,
    '41 after 42 cannot rewind the active policy state');
  assert.deepEqual(scheduler.configureCanaryTransition(duplicate42), {
    mode: 'legacy', reason: 'stale-policy-generation', policyGeneration: 42,
  });
  assert.deepEqual(scheduler.getCanaryTransitionSnapshot(), stateAt42,
    'a duplicate generation is rejected without changing active state');
});

test('REL-BGSTAB-010 frontend canary fallback preserves retained FIFO and uses a separate new-admission budget', () => {
  const issuer = createReviewedFrontendPolicyIssuer();
  const target = { viewId: 'view-backlog', connectionId: 'connection-backlog', reconnectGeneration: 1 };
  const scheduled: Array<() => void> = [];
  const writes: SchedulerWriteChunk[] = [];
  const scheduler = createTerminalOutputScheduler({
    visibleOutputQueueMaxBytes: 200,
    visibleOutputMaxChunks: 16,
    visibleFlushBudgetBytes: 200,
    write: (data, onWritten) => { writes.push(data); onWritten(); },
    schedule: drain => scheduled.push(drain),
    canaryTarget: target,
    validateCanaryPolicyLease: issuer.validate,
  });
  assert.deepEqual(scheduler.enqueue('a'.repeat(150)), { ok: true });
  const issuance = issuer.issue({
    target,
    decision: { candidateQueueMaxBytes: 200, legacyQueueMaxBytes: 100, policyGeneration: 41 },
  });
  assert.equal(issuance.mode, 'candidate');
  assert.ok(issuance.lease);
  assert.equal(scheduler.configureCanaryTransition(issuance.lease).mode, 'candidate');

  assert.deepEqual(scheduler.enqueue('b'.repeat(51)), { ok: true });
  assert.equal(scheduler.pendingBytes(), 201, 'the retained 150-byte FIFO is grandfathered from the new 100-byte budget');
  assert.equal(scheduler.isStale(), false, 'a canary fallback cannot stale the scheduler');
  assert.deepEqual(scheduler.getCanaryTransitionSnapshot(), {
    mode: 'legacy', reason: 'candidate-cap-exceeded-fallback', policyGeneration: 41,
  });
  scheduled.shift()?.();
  assert.equal(writes.map(decodeWriteChunk).join(''), `${'a'.repeat(150)}${'b'.repeat(51)}`,
    'the pre-transition FIFO and accepted new admission drain byte-for-byte');
});

test('REL-BGSTAB-010 frontend canary rollback fences admissions and closes at the pre-boundary FIFO', () => {
  const issuer = createReviewedFrontendPolicyIssuer();
  const target = { viewId: 'view-rollback', connectionId: 'connection-rollback', reconnectGeneration: 1 };
  const scheduled: Array<() => void> = [];
  const writes: Array<{ data: SchedulerWriteChunk; settle: () => void }> = [];
  const completions: string[] = [];
  const scheduler = createTerminalOutputScheduler({
    visibleOutputQueueMaxBytes: 100,
    visibleOutputMaxChunks: 16,
    visibleFlushBudgetBytes: 80,
    write: (data, onWritten) => writes.push({ data, settle: onWritten }),
    schedule: drain => scheduled.push(drain),
    canaryTarget: target,
    validateCanaryPolicyLease: issuer.validate,
  });
  const issuance = issuer.issue({
    target,
    decision: { candidateQueueMaxBytes: 200, legacyQueueMaxBytes: 100, policyGeneration: 42 },
  });
  assert.equal(issuance.mode, 'candidate');
  assert.ok(issuance.lease);
  const lease = issuance.lease;
  const lateIssuance = issuer.issue({ target, decision: lease.decision });
  assert.equal(lateIssuance.mode, 'candidate');
  assert.ok(lateIssuance.lease);
  scheduler.configureCanaryTransition(lease);
  assert.deepEqual(scheduler.enqueue('A'.repeat(80), () => completions.push('pre')), { ok: true });

  const rollbackApi = scheduler as typeof scheduler & {
    rollbackCanaryTransition(lease: typeof lease): { state: 'draining' | 'closed'; reason: string };
    getCanaryCleanupSnapshot(): { targetHandles: number; listeners: number; timers: number; retainedEntries: number };
  };
  assert.deepEqual(rollbackApi.rollbackCanaryTransition(lease), {
    state: 'draining', reason: 'rollback-draining',
  });
  assert.deepEqual(scheduler.enqueue('B'.repeat(10), () => completions.push('post')), { ok: true });
  assert.deepEqual(scheduler.configureCanaryTransition(lateIssuance.lease), {
    mode: 'legacy', reason: 'stale-policy-generation', policyGeneration: 42,
  });
  assert.deepEqual(rollbackApi.getCanaryCleanupSnapshot(), {
    targetHandles: 1, listeners: 1, timers: 0, retainedEntries: 1,
  });

  scheduled.shift()?.();
  assert.equal(decodeWriteChunk(writes[0].data), 'A'.repeat(80));
  writes[0].settle();
  assert.equal(scheduler.getCanaryTransitionSnapshot().reason, 'rollback-closed',
    'post-boundary output cannot starve rollback closure');
  assert.equal(decodeWriteChunk(writes[1].data), 'B'.repeat(10));
  writes[1].settle();
  assert.deepEqual(completions, ['pre', 'post']);
  assert.deepEqual(writes.map(entry => decodeWriteChunk(entry.data)), ['A'.repeat(80), 'B'.repeat(10)]);
  assert.deepEqual(rollbackApi.getCanaryCleanupSnapshot(), {
    targetHandles: 0, listeners: 0, timers: 0, retainedEntries: 1,
  });
});

test('REL-BGSTAB-010 frontend canary ledger is bounded immutable and records exact transition decisions', () => {
  const issuer = createReviewedFrontendPolicyIssuer();
  const target = { viewId: 'view-ledger', connectionId: 'connection-ledger', reconnectGeneration: 1 };
  const scheduler = createTerminalOutputScheduler({
    visibleOutputQueueMaxBytes: 100,
    visibleOutputMaxChunks: 16,
    visibleFlushBudgetBytes: 100,
    write: (_data, onWritten) => onWritten(),
    canaryTarget: target,
    validateCanaryPolicyLease: issuer.validate,
    canaryLedgerCapacity: 4,
  } as Parameters<typeof createTerminalOutputScheduler>[0] & { canaryLedgerCapacity: number });
  const issue = (policyGeneration: number) => {
    const result = issuer.issue({
      target,
      decision: { candidateQueueMaxBytes: 200, legacyQueueMaxBytes: 100, policyGeneration },
    });
    assert.equal(result.mode, 'candidate');
    assert.ok(result.lease);
    return result.lease;
  };
  const active = issue(10);
  scheduler.configureCanaryTransition(active);
  for (let index = 0; index < 6; index += 1) {
    scheduler.configureCanaryTransition(issue(9));
  }
  const ledgerApi = scheduler as typeof scheduler & {
    rollbackCanaryTransition(lease: typeof active): { state: 'draining' | 'closed'; reason: string };
    getCanaryLedgerSnapshot(): {
      capacity: number; totalEvents: number; droppedEntries: number;
      entries: readonly Array<Record<string, unknown>>;
    };
  };
  assert.deepEqual(ledgerApi.rollbackCanaryTransition(active), {
    state: 'closed', reason: 'rollback-closed',
  });
  const ledger = ledgerApi.getCanaryLedgerSnapshot();
  assert.equal(ledger.capacity, 4);
  assert.ok(ledger.totalEvents >= ledger.capacity + 3, 'capacity + K events are generated');
  assert.equal(ledger.entries.length, ledger.capacity);
  assert.equal(ledger.droppedEntries, ledger.totalEvents - ledger.capacity);
  assert.deepEqual(ledger.entries.map(entry => entry.sequence),
    Array.from({ length: ledger.capacity }, (_, index) => ledger.totalEvents - ledger.capacity + index + 1));
  assert.equal(ledger.entries.at(-1)?.event, 'rollback-closed');
  assert.equal(ledger.entries.at(-1)?.rollbackResult, 'closed');
  assert.equal(ledger.entries.every(entry => entry.policyId === 'test-only-wave3-reviewed'), true);
  assert.equal(ledger.entries.every(entry => entry.profileVersion === '1.0.0'), true);
  assert.equal(ledger.entries.every(entry => typeof entry.previousEffectiveDecision === 'number'), true);
  assert.equal(ledger.entries.every(entry => typeof entry.nextEffectiveDecision === 'number'), true);
  assert.equal(Object.isFrozen(ledger), true);
  assert.equal(Object.isFrozen(ledger.entries), true);
  assert.equal(ledger.entries.every(entry => Object.isFrozen(entry)), true);
  assert.throws(() => { (ledger.entries[0] as { reason: string }).reason = 'mutated'; }, TypeError);
});

test('REL-BGSTAB-010 production scheduler wires an inactive runtime and supports future stable injection', () => {
  type RuntimeFactory = (options: {
    target: { viewId: string; connectionId: string; reconnectGeneration: number };
    selection: {
      selectionId: string;
      policyGeneration: number;
      profiles: readonly typeof REVIEWED_FRONTEND_POLICY_PROFILE[];
    };
  }) => {
    target: { viewId: string; connectionId: string; reconnectGeneration: number };
    validate(value: unknown): boolean;
    issue(): {
      mode: 'candidate' | 'legacy'; reason: string; lease?: unknown;
    };
    getSnapshot(): {
      stableProfileCount: number; selectedProfileCount: number; mode: 'candidate' | 'legacy'; reason: string;
    };
  };
  const createRuntime = (terminalOutputSchedulerModule as unknown as {
    createTerminalOutputPolicyRuntime?: RuntimeFactory;
  }).createTerminalOutputPolicyRuntime;
  assert.equal(typeof createRuntime, 'function');
  const target = { viewId: 'session-production', connectionId: 'session-production', reconnectGeneration: 0 };
  const selection = {
    selectionId: REVIEWED_FRONTEND_POLICY_PROFILE.selectionId,
    policyGeneration: 1,
    target,
    profiles: [] as readonly typeof REVIEWED_FRONTEND_POLICY_PROFILE[],
  };
  const inactive = createRuntime!({ target, selection });
  assert.deepEqual(inactive.getSnapshot(), {
    stableProfileCount: 0, selectedProfileCount: 0, mode: 'legacy', reason: 'candidate-unavailable',
  });
  assert.deepEqual(inactive.target, target);
  assert.deepEqual(inactive.issue(), {
    mode: 'legacy', reason: 'candidate-unavailable',
  });
  assert.equal(inactive.validate(Object.freeze({})), false);

  const future = createRuntime!({
    target,
    selection: { ...selection, profiles: [REVIEWED_FRONTEND_POLICY_PROFILE] },
  });
  const issuance = future.issue();
  assert.equal(issuance.mode, 'candidate');
  assert.ok(issuance.lease);
  assert.equal(future.validate(issuance.lease), true);
  assert.deepEqual(future.getSnapshot(), {
    stableProfileCount: 1, selectedProfileCount: 1, mode: 'candidate', reason: 'candidate-available',
  });

  const terminalViewSource = readFileSync(
    new URL('../../src/components/Terminal/TerminalView.tsx', import.meta.url),
    'utf8',
  );
  assert.match(terminalViewSource, /createTerminalOutputPolicyRuntime\(\{/u);
  assert.match(terminalViewSource, /canaryTarget:\s*outputPolicyRuntime\.target/u);
  assert.match(terminalViewSource, /validateCanaryPolicyLease:\s*outputPolicyRuntime\.validate/u);
  assert.match(terminalViewSource, /bindTerminalOutputPolicyRuntime\(outputPolicyRuntime,\s*outputScheduler\)/u);
});

test('REL-BGSTAB-010 rejected compaction does not leave a rollback sequence hole', () => {
  const issuer = createTerminalOutputPolicyLeaseIssuer({
    trustedEvidence: REVIEWED_FRONTEND_POLICY_EVIDENCE,
    profile: {
      ...REVIEWED_FRONTEND_POLICY_PROFILE,
      approvedResourceDecision: { candidateQueueMaxBytes: 32, legacyQueueMaxBytes: 16 },
    },
    capability: REVIEWED_FRONTEND_POLICY_CAPABILITY,
  });
  const target = { viewId: 'view-sequence-hole', connectionId: 'connection-sequence-hole', reconnectGeneration: 3 };
  const scheduled: Array<() => void> = [];
  const writes: Array<() => void> = [];
  const scheduler = createTerminalOutputScheduler({
    visibleOutputQueueMaxBytes: 16,
    visibleOutputMaxChunks: 1,
    visibleFlushBudgetBytes: 8,
    write: (_data, onWritten) => writes.push(onWritten),
    schedule: drain => scheduled.push(drain),
    canaryTarget: target,
    validateCanaryPolicyLease: issuer.validate,
  });
  const issuance = issuer.issue({
    target,
    decision: { candidateQueueMaxBytes: 32, legacyQueueMaxBytes: 16, policyGeneration: 51 },
  });
  assert.equal(issuance.mode, 'candidate');
  assert.ok(issuance.lease);
  scheduler.configureCanaryTransition(issuance.lease);

  assert.deepEqual(scheduler.enqueue('A'.repeat(8)), { ok: true });
  assert.deepEqual(scheduler.enqueue('B'.repeat(8)), {
    ok: false, reason: 'canary-admission-rejected', rejectedBytes: 8,
  });
  assert.deepEqual(scheduler.rollbackCanaryTransition(issuance.lease), {
    state: 'draining', reason: 'rollback-draining',
  });
  scheduled.shift()?.();
  writes.shift()?.();

  assert.equal(scheduler.getCanaryTransitionSnapshot().reason, 'rollback-closed',
    'a rejected provisional segment cannot leave the rollback waiting on a nonexistent sequence');
});

test('REL-BGSTAB-010 compaction preserves the rollback pre-boundary completion', () => {
  const issuer = createReviewedFrontendPolicyIssuer();
  const target = { viewId: 'view-boundary-merge', connectionId: 'connection-boundary-merge', reconnectGeneration: 4 };
  const scheduled: Array<() => void> = [];
  const writes: Array<{ data: SchedulerWriteChunk; settle: () => void }> = [];
  const callbacks: string[] = [];
  const scheduler = createTerminalOutputScheduler({
    visibleOutputQueueMaxBytes: 100,
    visibleOutputMaxChunks: 1,
    visibleFlushBudgetBytes: 100,
    write: (data, onWritten) => writes.push({ data, settle: onWritten }),
    schedule: drain => scheduled.push(drain),
    canaryTarget: target,
    validateCanaryPolicyLease: issuer.validate,
  });
  const issuance = issuer.issue({
    target,
    decision: { candidateQueueMaxBytes: 200, legacyQueueMaxBytes: 100, policyGeneration: 52 },
  });
  assert.equal(issuance.mode, 'candidate');
  assert.ok(issuance.lease);
  scheduler.configureCanaryTransition(issuance.lease);
  scheduler.enqueue('A'.repeat(60), () => callbacks.push('pre'));
  scheduler.rollbackCanaryTransition(issuance.lease);
  assert.deepEqual(scheduler.enqueue('B'.repeat(40), () => callbacks.push('post')), { ok: true });

  scheduled.shift()?.();
  assert.equal(decodeWriteChunk(writes[0].data), 'A'.repeat(60));
  writes[0].settle();
  assert.equal(scheduler.getCanaryTransitionSnapshot().reason, 'rollback-closed',
    'settling the compacted pre-boundary slice must close rollback before post-boundary output');
  assert.deepEqual(callbacks, ['pre']);
  assert.equal(decodeWriteChunk(writes[1].data), 'B'.repeat(40));
  writes[1].settle();
  assert.deepEqual(callbacks, ['pre', 'post']);
});

test('REL-BGSTAB-010 rollback ledger records the actual fallback decision through closure', () => {
  const issuer = createReviewedFrontendPolicyIssuer();
  const target = { viewId: 'view-ledger-fallback', connectionId: 'connection-ledger-fallback', reconnectGeneration: 5 };
  const scheduled: Array<() => void> = [];
  const writes: Array<() => void> = [];
  const scheduler = createTerminalOutputScheduler({
    visibleOutputQueueMaxBytes: 200,
    visibleOutputMaxChunks: 4,
    visibleFlushBudgetBytes: 200,
    write: (_data, onWritten) => writes.push(onWritten),
    schedule: drain => scheduled.push(drain),
    canaryTarget: target,
    validateCanaryPolicyLease: issuer.validate,
  });
  scheduler.enqueue('A'.repeat(150));
  const issuance = issuer.issue({
    target,
    decision: { candidateQueueMaxBytes: 200, legacyQueueMaxBytes: 100, policyGeneration: 53 },
  });
  assert.equal(issuance.mode, 'candidate');
  assert.ok(issuance.lease);
  scheduler.configureCanaryTransition(issuance.lease);
  assert.equal(scheduler.enqueue('B'.repeat(51)).ok, true);
  scheduler.rollbackCanaryTransition(issuance.lease);

  let rollbackEntries = scheduler.getCanaryLedgerSnapshot().entries.filter(entry => entry.event.startsWith('rollback-'));
  assert.deepEqual(rollbackEntries.map(entry => [entry.event, entry.previousEffectiveDecision]), [
    ['rollback-requested', 100],
    ['rollback-draining', 100],
  ]);
  scheduled.shift()?.();
  writes.shift()?.();
  writes.shift()?.();
  rollbackEntries = scheduler.getCanaryLedgerSnapshot().entries.filter(entry => entry.event.startsWith('rollback-'));
  assert.deepEqual(rollbackEntries.map(entry => [entry.event, entry.previousEffectiveDecision]), [
    ['rollback-requested', 100],
    ['rollback-draining', 100],
    ['rollback-closed', 100],
  ]);
});

test('REL-BGSTAB-010 production binding uses real connection identity and the same selected-profile path', () => {
  type PolicyModule = typeof terminalOutputSchedulerModule & {
    createTerminalOutputPolicySelectionCoordinator(options?: {
      profiles?: readonly typeof REVIEWED_FRONTEND_POLICY_PROFILE[];
      selectTarget?: (target: { viewId: string; connectionId: string; reconnectGeneration: number }) => boolean;
    }): {
      select(input: {
        selectionId: string;
        policyGeneration: number;
        target: { viewId: string; connectionId: string; reconnectGeneration: number };
      }): unknown;
    };
    bindTerminalOutputPolicyRuntime(runtime: unknown, scheduler: unknown): unknown;
  };
  const policyModule = terminalOutputSchedulerModule as PolicyModule;
  assert.equal(typeof policyModule.createTerminalOutputPolicySelectionCoordinator, 'function');
  assert.equal(typeof policyModule.bindTerminalOutputPolicyRuntime, 'function');

  const containerSource = readFileSync(
    new URL('../../src/components/Terminal/TerminalContainer.tsx', import.meta.url),
    'utf8',
  );
  const viewSource = readFileSync(
    new URL('../../src/components/Terminal/TerminalView.tsx', import.meta.url),
    'utf8',
  );
  assert.match(containerSource, /outputPolicyConnectionId=\{wsClientId\s*\?\?/u);
  assert.match(containerSource, /outputPolicyReconnectGeneration=\{wsConnectionGenerationRef\.current\}/u);
  assert.match(viewSource, /connectionId:\s*outputPolicyConnectionId/u);
  assert.match(viewSource, /reconnectGeneration:\s*outputPolicyReconnectGeneration/u);
  assert.match(viewSource, /bindTerminalOutputPolicyRuntime\(outputPolicyRuntime,\s*outputScheduler/u);

  const selectedTarget = { viewId: 'production-view', connectionId: 'ws-client-2', reconnectGeneration: 10 };
  const selectionInput = {
    selectionId: REVIEWED_FRONTEND_POLICY_PROFILE.selectionId,
    policyGeneration: 61,
    target: selectedTarget,
  };
  const inactiveCoordinator = policyModule.createTerminalOutputPolicySelectionCoordinator();
  const inactiveRuntime = terminalOutputSchedulerModule.createTerminalOutputPolicyRuntime({
    target: { viewId: 'production-view', connectionId: 'ws-client-1', reconnectGeneration: 9 },
    selection: inactiveCoordinator.select(selectionInput),
  } as never);
  const inactiveScheduler = createTerminalOutputScheduler({
    visibleOutputQueueMaxBytes: 100,
    visibleOutputMaxChunks: 4,
    visibleFlushBudgetBytes: 100,
    write: (_data, onWritten) => onWritten(),
    canaryTarget: inactiveRuntime.target,
    validateCanaryPolicyLease: inactiveRuntime.validate,
  });
  assert.deepEqual(policyModule.bindTerminalOutputPolicyRuntime(inactiveRuntime, inactiveScheduler), {
    mode: 'legacy', reason: 'candidate-unavailable', policyGeneration: 61,
  });

  const injectedCoordinator = policyModule.createTerminalOutputPolicySelectionCoordinator({
    profiles: [REVIEWED_FRONTEND_POLICY_PROFILE],
    selectTarget: target => target.viewId === selectedTarget.viewId
      && target.connectionId === selectedTarget.connectionId
      && target.reconnectGeneration === selectedTarget.reconnectGeneration,
  });
  const injectedRuntime = terminalOutputSchedulerModule.createTerminalOutputPolicyRuntime({
    target: selectedTarget,
    selection: injectedCoordinator.select(selectionInput),
  } as never);
  const injectedScheduler = createTerminalOutputScheduler({
    visibleOutputQueueMaxBytes: 100,
    visibleOutputMaxChunks: 4,
    visibleFlushBudgetBytes: 100,
    write: (_data, onWritten) => onWritten(),
    canaryTarget: injectedRuntime.target,
    validateCanaryPolicyLease: injectedRuntime.validate,
  });
  assert.deepEqual(policyModule.bindTerminalOutputPolicyRuntime(injectedRuntime, injectedScheduler), {
    mode: 'candidate', reason: 'candidate-selected', policyGeneration: 61,
  });
  const nonselectedTarget = { ...selectedTarget, viewId: 'production-view-other' };
  const nonselectedRuntime = terminalOutputSchedulerModule.createTerminalOutputPolicyRuntime({
    target: nonselectedTarget,
    selection: injectedCoordinator.select({ ...selectionInput, target: nonselectedTarget }),
  } as never);
  assert.deepEqual(nonselectedRuntime.getSnapshot(), {
    stableProfileCount: 0,
    selectedProfileCount: 0,
    mode: 'legacy',
    reason: 'candidate-unavailable',
  }, 'one shared coordinator must fail closed for every nonselected view target');

  const throwingTarget = { ...selectedTarget, viewId: 'production-view-throwing' };
  const isolatedCoordinator = policyModule.createTerminalOutputPolicySelectionCoordinator({
    profiles: [REVIEWED_FRONTEND_POLICY_PROFILE],
    selectTarget: target => {
      if (target.viewId === throwingTarget.viewId) throw new Error('selector fault');
      return target.viewId === selectedTarget.viewId;
    },
  });
  const throwingSelection = isolatedCoordinator.select({ ...selectionInput, target: throwingTarget }) as {
    profiles: readonly unknown[];
  };
  assert.deepEqual(throwingSelection.profiles, [], 'a target-local selector fault must fail closed without escaping');
  const unaffectedRuntime = terminalOutputSchedulerModule.createTerminalOutputPolicyRuntime({
    target: selectedTarget,
    selection: isolatedCoordinator.select(selectionInput),
  } as never);
  assert.equal(unaffectedRuntime.getSnapshot().mode, 'candidate',
    'one target selector fault cannot poison later views or shared coordinator state');
});

test('REL-BGSTAB-010 selected profiles bind approved decisions and fail closed on ambiguity', () => {
  const exactIssuer = createReviewedFrontendPolicyIssuer();
  const target = { viewId: 'view-approved-decision', connectionId: 'connection-approved-decision', reconnectGeneration: 6 };
  assert.deepEqual(exactIssuer.issue({
    target,
    decision: { candidateQueueMaxBytes: 201, legacyQueueMaxBytes: 100, policyGeneration: 62 },
  }), { mode: 'legacy', reason: 'candidate-decision-mismatch' });

  const runtimeFactory = terminalOutputSchedulerModule.createTerminalOutputPolicyRuntime as unknown as (options: {
    target: typeof target;
    selection: {
      selectionId: string;
      policyGeneration: number;
      target: typeof target;
      profiles: readonly typeof REVIEWED_FRONTEND_POLICY_PROFILE[];
    };
  }) => { issue(): { mode: string; reason: string }; getSnapshot(): { mode: string; reason: string } };
  const duplicateProfiles = [
    REVIEWED_FRONTEND_POLICY_PROFILE,
    Object.freeze({ ...REVIEWED_FRONTEND_POLICY_PROFILE }),
  ];
  const ambiguous = runtimeFactory({
    target,
    selection: {
      selectionId: REVIEWED_FRONTEND_POLICY_PROFILE.selectionId,
      policyGeneration: 62,
      target,
      profiles: duplicateProfiles,
    },
  });
  assert.deepEqual(ambiguous.getSnapshot(), {
    stableProfileCount: 2,
    selectedProfileCount: 2,
    mode: 'legacy',
    reason: 'candidate-ambiguous',
  });
  assert.deepEqual(ambiguous.issue(), { mode: 'legacy', reason: 'candidate-ambiguous' });
});

test('REL-BGSTAB-010 reset and repair explicitly abort active and draining canaries', () => {
  const issuer = createReviewedFrontendPolicyIssuer();
  const target = { viewId: 'view-reset-abort', connectionId: 'connection-reset-abort', reconnectGeneration: 7 };
  const scheduler = createTerminalOutputScheduler({
    visibleOutputQueueMaxBytes: 100,
    visibleOutputMaxChunks: 4,
    visibleFlushBudgetBytes: 100,
    write: (_data, onWritten) => onWritten(),
    schedule: () => {},
    canaryTarget: target,
    validateCanaryPolicyLease: issuer.validate,
  });
  const issuance = issuer.issue({
    target,
    decision: { candidateQueueMaxBytes: 200, legacyQueueMaxBytes: 100, policyGeneration: 63 },
  });
  assert.equal(issuance.mode, 'candidate');
  assert.ok(issuance.lease);
  scheduler.configureCanaryTransition(issuance.lease);
  scheduler.enqueue('queued-before-repair');
  scheduler.rollbackCanaryTransition(issuance.lease);
  scheduler.reset('visible-output-recovery' as never);

  const ledger = scheduler.getCanaryLedgerSnapshot();
  assert.deepEqual(ledger.entries.at(-1), {
    sequence: ledger.totalEvents,
    event: 'transition-aborted',
    policyId: 'test-only-wave3-reviewed',
    profileVersion: '1.0.0',
    target,
    previousEffectiveDecision: 100,
    nextEffectiveDecision: 100,
    policyGeneration: 63,
    accepted: true,
    reason: 'visible-output-recovery',
    rollbackResult: 'aborted',
  });
  assert.deepEqual(scheduler.getCanaryCleanupSnapshot(), {
    targetHandles: 0, listeners: 0, timers: 0, retainedEntries: 1,
  });
});

test('REL-BGSTAB-010 fallback gives grandfathered backlog a separate new-admission budget', () => {
  const issuer = createReviewedFrontendPolicyIssuer();
  const target = { viewId: 'view-nonloss-fallback', connectionId: 'connection-nonloss-fallback', reconnectGeneration: 8 };
  const scheduled: Array<() => void> = [];
  const writes: Array<{ data: SchedulerWriteChunk; settle: () => void }> = [];
  const callbacks: string[] = [];
  const scheduler = createTerminalOutputScheduler({
    visibleOutputQueueMaxBytes: 200,
    visibleOutputMaxChunks: 4,
    visibleFlushBudgetBytes: 200,
    write: (data, onWritten) => writes.push({ data, settle: onWritten }),
    schedule: drain => scheduled.push(drain),
    canaryTarget: target,
    validateCanaryPolicyLease: issuer.validate,
  });
  assert.deepEqual(scheduler.enqueue('A'.repeat(150), () => callbacks.push('grandfathered')), { ok: true });
  const issuance = issuer.issue({
    target,
    decision: { candidateQueueMaxBytes: 200, legacyQueueMaxBytes: 100, policyGeneration: 64 },
  });
  assert.equal(issuance.mode, 'candidate');
  assert.ok(issuance.lease);
  scheduler.configureCanaryTransition(issuance.lease);

  assert.deepEqual(scheduler.enqueue('B'.repeat(60), () => callbacks.push('new-admission')), { ok: true });
  assert.equal(scheduler.pendingBytes(), 210);
  assert.deepEqual(scheduler.getCanaryTransitionSnapshot(), {
    mode: 'legacy', reason: 'candidate-cap-exceeded-fallback', policyGeneration: 64,
  });
  scheduled.shift()?.();
  assert.equal(decodeWriteChunk(writes[0].data), 'A'.repeat(150));
  writes[0].settle();
  assert.equal(decodeWriteChunk(writes[1].data), 'B'.repeat(60));
  writes[1].settle();
  assert.deepEqual(callbacks, ['grandfathered', 'new-admission'],
    'reliable ingress callbacks complete exactly once in FIFO order');
  const terminalViewSource = readFileSync(
    new URL('../../src/components/Terminal/TerminalView.tsx', import.meta.url),
    'utf8',
  );
  assert.match(
    terminalViewSource,
    /decision\.reason === 'canary-admission-rejected'[\s\S]{0,1200}deferRetry\(decision\.rejectedBytes\)/u,
    'a transient canary fence must use the bounded shared retry queue instead of stalling buffered flush',
  );
});

test('REL-BGSTAB-010 production component tree carries the zero or injected selection coordinator to TerminalView', () => {
  const contextSource = readFileSync(
    new URL('../../src/components/Terminal/TerminalRuntimeContext.tsx', import.meta.url),
    'utf8',
  );
  const layerSource = readFileSync(
    new URL('../../src/components/Terminal/TerminalRuntimeLayer.tsx', import.meta.url),
    'utf8',
  );
  const containerSource = readFileSync(
    new URL('../../src/components/Terminal/TerminalContainer.tsx', import.meta.url),
    'utf8',
  );
  assert.match(contextSource, /outputPolicySelectionCoordinator\?:\s*TerminalOutputPolicySelectionCoordinator/u);
  assert.match(contextSource, /createTerminalOutputPolicySelectionCoordinator\(\)/u,
    'the production provider owns an explicit zero-profile inactive default');
  assert.match(contextSource, /outputPolicySelectionCoordinator:\s*activeOutputPolicySelectionCoordinator/u);
  assert.match(layerSource, /outputPolicySelectionCoordinator=\{outputPolicySelectionCoordinator\}/u);
  assert.match(containerSource, /outputPolicySelectionCoordinator=\{outputPolicySelectionCoordinator\}/u);
});

test('REL-BGSTAB-010 duplicate rollback is idempotent and cannot move the drain boundary', () => {
  const issuer = createReviewedFrontendPolicyIssuer();
  const target = { viewId: 'view-idempotent-rollback', connectionId: 'connection-idempotent-rollback', reconnectGeneration: 9 };
  const scheduled: Array<() => void> = [];
  const writes: Array<{ data: SchedulerWriteChunk; settle: () => void }> = [];
  const scheduler = createTerminalOutputScheduler({
    visibleOutputQueueMaxBytes: 100,
    visibleOutputMaxChunks: 4,
    visibleFlushBudgetBytes: 60,
    write: (data, onWritten) => writes.push({ data, settle: onWritten }),
    schedule: drain => scheduled.push(drain),
    canaryTarget: target,
    validateCanaryPolicyLease: issuer.validate,
  });
  const issuance = issuer.issue({
    target,
    decision: { candidateQueueMaxBytes: 200, legacyQueueMaxBytes: 100, policyGeneration: 65 },
  });
  assert.equal(issuance.mode, 'candidate');
  assert.ok(issuance.lease);
  scheduler.configureCanaryTransition(issuance.lease);
  scheduler.enqueue('A'.repeat(60));
  assert.deepEqual(scheduler.rollbackCanaryTransition(issuance.lease), {
    state: 'draining', reason: 'rollback-draining',
  });
  scheduler.enqueue('B'.repeat(40));
  const ledgerBeforeDuplicate = scheduler.getCanaryLedgerSnapshot().totalEvents;
  assert.deepEqual(scheduler.rollbackCanaryTransition(issuance.lease), {
    state: 'draining', reason: 'rollback-draining',
  });
  assert.equal(scheduler.getCanaryLedgerSnapshot().totalEvents, ledgerBeforeDuplicate,
    'an idempotent rollback request cannot append duplicate lifecycle events');

  scheduled.shift()?.();
  assert.equal(decodeWriteChunk(writes[0].data), 'A'.repeat(60));
  writes[0].settle();
  assert.equal(scheduler.getCanaryTransitionSnapshot().reason, 'rollback-closed',
    'the original seq1 boundary closes even though seq2 was admitted before the duplicate request');
});

test('REL-BGSTAB-010 bounded ingress retry queue drains two fenced outputs with one FIFO barrier', () => {
  type RetryFactory = (options: {
    maxBytes: number;
    maxChunks: number;
    attempt: (data: string, onWritten: () => void) => 'accepted' | 'retryable' | 'failed';
    isIdle: () => boolean;
    armBarrier: (onReady: () => void) => boolean;
    onAuthorityRecoveryRequired: (info: { reason: string; bytes: number; chunks: number }) => void;
  }) => {
    defer(entry: { data: string; onWritten: () => void; onRejected: () => void }): boolean;
    getSnapshot(): { queuedBytes: number; queuedChunks: number; barrierArmed: boolean };
  };
  const createRetryQueue = (terminalOutputSchedulerModule as unknown as {
    createTerminalOutputIngressRetryQueue?: RetryFactory;
  }).createTerminalOutputIngressRetryQueue;
  assert.equal(typeof createRetryQueue, 'function');
  const barriers: Array<() => void> = [];
  const completions: Array<() => void> = [];
  const events: string[] = [];
  const recovery: unknown[] = [];
  let idle = false;
  const retryQueue = createRetryQueue!({
    maxBytes: 8,
    maxChunks: 2,
    attempt: (data, onWritten) => { events.push(`write:${data}`); completions.push(onWritten); return 'accepted'; },
    isIdle: () => idle,
    armBarrier: onReady => { barriers.push(onReady); return true; },
    onAuthorityRecoveryRequired: info => recovery.push(info),
  });
  assert.equal(retryQueue.defer({ data: 'aa', onWritten: () => events.push('done:aa'), onRejected: () => events.push('reject:aa') }), true);
  assert.equal(retryQueue.defer({ data: 'bb', onWritten: () => events.push('done:bb'), onRejected: () => events.push('reject:bb') }), true);
  assert.equal(barriers.length, 1, 'a burst owns one shared FIFO retry barrier');
  barriers.shift()?.();
  completions.shift()?.();
  completions.shift()?.();
  idle = true;
  assert.deepEqual(events, ['write:aa', 'done:aa', 'write:bb', 'done:bb']);
  assert.deepEqual(recovery, []);
  assert.deepEqual(retryQueue.getSnapshot(), { queuedBytes: 0, queuedChunks: 0, barrierArmed: false });
});

test('REL-BGSTAB-010 oversized or saturated canary ingress settles to bounded target-local legacy without recovery', () => {
  const createRetryQueue = (terminalOutputSchedulerModule as unknown as {
    createTerminalOutputIngressRetryQueue?: (options: Record<string, unknown>) => {
      defer(entry: { data: string; onWritten: () => void; onRejected: () => void }): boolean;
      getSnapshot(): { queuedBytes: number; queuedChunks: number; barrierArmed: boolean };
    };
  }).createTerminalOutputIngressRetryQueue;
  assert.equal(typeof createRetryQueue, 'function');
  const events: string[] = [];
  const legacyFallbacks: unknown[] = [];
  const legacyCompletions: Array<() => void> = [];
  const retryQueue = createRetryQueue!({
    maxBytes: 4,
    maxChunks: 1,
    maxSingleIngressBytes: 8,
    attempt: () => 'retryable',
    attemptLegacy: (data: string, onWritten: () => void) => {
      events.push(`legacy:${data}`);
      legacyCompletions.push(onWritten);
      return 'accepted';
    },
    isIdle: () => true,
    armBarrier: () => false,
    onLegacyFallback: (info: unknown) => legacyFallbacks.push(info),
  });
  assert.equal(retryQueue.defer({ data: '12345', onWritten: () => events.push('written'), onRejected: () => events.push('rejected') }), true);
  assert.deepEqual(events, ['legacy:12345']);
  legacyCompletions.shift()?.();
  assert.deepEqual(events, ['legacy:12345', 'written']);
  assert.deepEqual(legacyFallbacks, [{ reason: 'retry-cap-exceeded', bytes: 5, chunks: 1 }]);
  assert.deepEqual(retryQueue.getSnapshot(), { queuedBytes: 0, queuedChunks: 0, barrierArmed: false });

  const burstEvents: string[] = [];
  const burstBarriers: Array<() => void> = [];
  const burstLegacyCompletions: Array<() => void> = [];
  const burstFallbacks: unknown[] = [];
  const burstQueue = createRetryQueue!({
    maxBytes: 4,
    maxChunks: 1,
    maxSingleIngressBytes: 8,
    attempt: () => 'retryable',
    attemptLegacy: (data: string, onWritten: () => void) => {
      burstEvents.push(`legacy:${data}`);
      burstLegacyCompletions.push(onWritten);
      return 'accepted';
    },
    isIdle: () => false,
    armBarrier: (onReady: () => void) => { burstBarriers.push(onReady); return true; },
    armLegacyBarrier: () => false,
    onLegacyFallback: (info: unknown) => burstFallbacks.push(info),
  });
  assert.equal(burstQueue.defer({ data: 'aa', onWritten: () => burstEvents.push('done:aa'), onRejected: () => burstEvents.push('reject:aa') }), true);
  assert.equal(burstQueue.defer({ data: 'bbbb', onWritten: () => burstEvents.push('done:bbbb'), onRejected: () => burstEvents.push('reject:bbbb') }), true);
  assert.deepEqual(burstQueue.getSnapshot(), { queuedBytes: 4, queuedChunks: 1, barrierArmed: false },
    'the scheduler-owned active chunk is transferred out of the bounded retry hold');
  burstBarriers.shift()?.();
  burstLegacyCompletions.shift()?.();
  burstLegacyCompletions.shift()?.();
  assert.deepEqual(burstEvents, ['legacy:aa', 'done:aa', 'legacy:bbbb', 'done:bbbb']);
  assert.deepEqual(burstFallbacks, [{ reason: 'retry-cap-exceeded', bytes: 6, chunks: 2 }]);
  assert.deepEqual(burstQueue.getSnapshot(), { queuedBytes: 0, queuedChunks: 0, barrierArmed: false });

  const issuer = createReviewedFrontendPolicyIssuer();
  const target = { viewId: 'legacy-fallback-view', connectionId: 'legacy-fallback-connection', reconnectGeneration: 1 };
  const scheduled: Array<() => void> = [];
  const writes: Array<{ data: SchedulerWriteChunk; settle: () => void }> = [];
  const schedulerEvents: string[] = [];
  const scheduler = createTerminalOutputScheduler({
    visibleOutputQueueMaxBytes: 100,
    visibleOutputMaxChunks: 1,
    visibleFlushBudgetBytes: 2,
    write: (data, onWritten) => writes.push({ data, settle: onWritten }),
    schedule: drain => scheduled.push(drain),
    canaryTarget: target,
    validateCanaryPolicyLease: issuer.validate,
  });
  const issuance = issuer.issue({
    target,
    decision: { candidateQueueMaxBytes: 200, legacyQueueMaxBytes: 100, policyGeneration: 70 },
  });
  assert.equal(issuance.mode, 'candidate');
  assert.ok(issuance.lease);
  scheduler.configureCanaryTransition(issuance.lease);
  assert.deepEqual(scheduler.enqueue('aa', () => schedulerEvents.push('done:aa')), { ok: true });
  assert.deepEqual(scheduler.enqueueBarrier(() => schedulerEvents.push('ordinary-barrier')), { ok: true });
  const rejected = scheduler.enqueue('bb', () => schedulerEvents.push('unexpected-direct'));
  assert.equal(rejected.ok, false);
  assert.equal(rejected.ok ? '' : rejected.reason, 'canary-admission-rejected');
  let productionFallbackCount = 0;
  const productionQueue = createRetryQueue!({
    maxBytes: 100,
    maxChunks: 1,
    maxSingleIngressBytes: 100,
    attempt: (data: string, onWritten: () => void) => {
      const decision = scheduler.enqueue(data, onWritten);
      return decision.ok ? 'accepted' : decision.reason === 'canary-admission-rejected' ? 'retryable' : 'failed';
    },
    attemptLegacy: (data: string, onWritten: () => void) => {
      const decision = scheduler.enqueueLegacy(data, onWritten);
      return decision.ok ? 'accepted' : decision.reason === 'canary-admission-rejected' ? 'retryable' : 'failed';
    },
    isIdle: scheduler.isIdle,
    armBarrier: (onReady: () => void) => scheduler.enqueueBarrier(onReady).ok,
    armLegacyBarrier: (onReady: () => void) => scheduler.enqueueReliableBarrier(onReady).ok,
    onLegacyFallback: () => { productionFallbackCount += 1; },
  });
  assert.equal(productionQueue.defer({
    data: 'bb',
    onWritten: () => schedulerEvents.push('done:bb'),
    onRejected: () => schedulerEvents.push('reject:bb'),
  }), true);
  scheduled.shift()?.();
  assert.equal(decodeWriteChunk(writes[0].data), 'aa');
  writes.shift()?.settle();
  assert.equal(decodeWriteChunk(writes[0].data), 'bb');
  writes.shift()?.settle();
  assert.deepEqual(schedulerEvents, ['done:aa', 'ordinary-barrier', 'done:bb']);
  assert.equal(productionFallbackCount, 1);
  assert.equal(scheduler.isStale(), false);
  assert.equal(scheduler.getCanaryTransitionSnapshot().reason, 'target-local-legacy-fallback');

  const terminalViewSource = readFileSync(
    new URL('../../src/components/Terminal/TerminalView.tsx', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(
    terminalViewSource,
    /onAuthorityRecoveryRequired:[\s\S]{0,800}onVisibleOutputOverflow/u,
    'canary retry fallback must never mark the view stale or request screen recovery',
  );
});

test('REL-BGSTAB-010 legacy handoff bounds active plus 2L+1/N+2 burst without false written settlement', () => {
  const createRetryQueue = terminalOutputSchedulerModule.createTerminalOutputIngressRetryQueue;
  const completions: Array<() => void> = [];
  const events: string[] = [];
  const retryQueue = createRetryQueue({
    maxBytes: 4,
    maxChunks: 1,
    maxSingleIngressBytes: 4,
    attempt: () => 'retryable',
    attemptLegacy: (data, onWritten) => {
      events.push(`write:${data}`);
      completions.push(onWritten);
      return 'accepted';
    },
    isIdle: () => true,
    armBarrier: () => false,
    armLegacyBarrier: () => false,
  });
  assert.equal(retryQueue.defer({ data: 'aaaa', onWritten: () => events.push('done:aaaa'), onRejected: () => events.push('reject:aaaa') }), true);
  assert.equal(retryQueue.defer({ data: 'bbbb', onWritten: () => events.push('done:bbbb'), onRejected: () => events.push('reject:bbbb') }), true);
  assert.equal(retryQueue.defer({ data: 'c', onWritten: () => events.push('done:c'), onRejected: () => events.push('reject:c') }), true);
  assert.deepEqual(events, ['write:aaaa'], 'accepted handoff is not reported written before its real callback');
  assert.deepEqual(retryQueue.getSnapshot(), { queuedBytes: 5, queuedChunks: 2, barrierArmed: false },
    'one scheduler-owned active ingress plus L+1 bytes/N+1 chunks is the explicit bounded hold');
  assert.equal(retryQueue.defer({ data: 'd', onWritten: () => events.push('done:d'), onRejected: () => events.push('reject:d') }), false);
  assert.deepEqual(retryQueue.getSnapshot(), { queuedBytes: 5, queuedChunks: 2, barrierArmed: false },
    'a beyond-contract ingress is explicitly rejected without clearing already held data');
  completions.shift()?.();
  completions.shift()?.();
  completions.shift()?.();
  assert.deepEqual(events, [
    'write:aaaa', 'reject:d', 'done:aaaa',
    'write:bbbb', 'done:bbbb',
    'write:c', 'done:c',
  ]);
  assert.deepEqual(retryQueue.getSnapshot(), { queuedBytes: 0, queuedChunks: 0, barrierArmed: false });
});

test('REL-BGSTAB-010 legacy retry during rollback preserves boundary through rollback-closed', () => {
  const issuer = createReviewedFrontendPolicyIssuer();
  const target = { viewId: 'rollback-fallback-view', connectionId: 'rollback-fallback-connection', reconnectGeneration: 2 };
  const scheduled: Array<() => void> = [];
  const writes: Array<{ data: SchedulerWriteChunk; settle: () => void }> = [];
  const callbacks: string[] = [];
  const scheduler = createTerminalOutputScheduler({
    visibleOutputQueueMaxBytes: 100,
    visibleOutputMaxChunks: 4,
    visibleFlushBudgetBytes: 60,
    write: (data, onWritten) => writes.push({ data, settle: onWritten }),
    schedule: drain => scheduled.push(drain),
    canaryTarget: target,
    validateCanaryPolicyLease: issuer.validate,
  });
  const issuance = issuer.issue({
    target,
    decision: { candidateQueueMaxBytes: 200, legacyQueueMaxBytes: 100, policyGeneration: 71 },
  });
  assert.equal(issuance.mode, 'candidate');
  assert.ok(issuance.lease);
  scheduler.configureCanaryTransition(issuance.lease);
  scheduler.enqueue('A'.repeat(60), () => callbacks.push('pre-boundary'));
  assert.deepEqual(scheduler.rollbackCanaryTransition(issuance.lease), {
    state: 'draining', reason: 'rollback-draining',
  });
  assert.deepEqual(scheduler.enqueueLegacy('B'.repeat(40), () => callbacks.push('post-boundary')), { ok: true });
  assert.equal(scheduler.getCanaryTransitionSnapshot().reason, 'rollback-draining');
  assert.equal(scheduler.getCanaryLedgerSnapshot().entries.some(entry => entry.event === 'transition-aborted'), false);
  scheduled.shift()?.();
  assert.equal(decodeWriteChunk(writes[0].data), 'A'.repeat(60));
  writes.shift()?.settle();
  assert.equal(scheduler.getCanaryTransitionSnapshot().reason, 'rollback-closed');
  assert.equal(decodeWriteChunk(writes[0].data), 'B'.repeat(40));
  writes.shift()?.settle();
  assert.deepEqual(callbacks, ['pre-boundary', 'post-boundary']);
  assert.deepEqual(
    scheduler.getCanaryLedgerSnapshot().entries.filter(entry => entry.event.startsWith('rollback-')).map(entry => entry.event),
    ['rollback-requested', 'rollback-draining', 'rollback-closed'],
  );
});

test('REL-BGSTAB-010 restore-buffer flush retains ownership until write or observable rejection settlement', () => {
  const flushNext = (terminalOutputSchedulerModule as unknown as {
    flushNextTerminalRestoreBufferedOutput?: (options: {
      peek: () => string | undefined;
      commit: (expected: string) => boolean;
      write: (data: string, onWritten: () => void, onRejected: () => void) => boolean;
      onWritten: () => void;
      onSettled: (success: boolean) => void;
    }) => boolean;
  }).flushNextTerminalRestoreBufferedOutput;
  assert.equal(typeof flushNext, 'function');
  const retained = ['restore-next'];
  let retainedBytes = new TextEncoder().encode(retained[0]).byteLength;
  let restoreBufferOwned = true;
  let restoreResult: boolean | null = null;
  let writtenCount = 0;
  let rejectedCount = 0;
  const accepted = flushNext!({
    peek: () => retained[0],
    commit: (expected) => {
      if (retained[0] !== expected) return false;
      retained.shift();
      retainedBytes = 0;
      return true;
    },
    write: (_data, _onWritten, onRejected) => {
      onRejected();
      return false;
    },
    onWritten: () => { writtenCount += 1; },
    onSettled: (success) => {
      rejectedCount += success ? 0 : 1;
      restoreResult = success;
      if (success) restoreBufferOwned = false;
    },
  });
  assert.equal(accepted, false);
  assert.equal(restoreResult, false);
  assert.equal(restoreBufferOwned, true, 'failed admission retains the chunk for the explicit Container recovery handoff');
  assert.deepEqual(retained, ['restore-next']);
  assert.equal(retainedBytes, 12);
  assert.equal(writtenCount, 0);
  assert.equal(rejectedCount, 1);

  const terminalViewSource = readFileSync(
    new URL('../../src/components/Terminal/TerminalView.tsx', import.meta.url),
    'utf8',
  );
  const flushStart = terminalViewSource.indexOf('const flushBufferedOutput = useCallback');
  const flushEnd = terminalViewSource.indexOf('const releaseRestorePending = useCallback', flushStart);
  assert.ok(flushStart >= 0 && flushEnd > flushStart);
  const flushSource = terminalViewSource.slice(flushStart, flushEnd);
  assert.match(flushSource, /const pending = bufferedOutputRef\.current\[0\]/u,
    'the restore chunk must remain owned by the buffer until actual write settlement');
  assert.match(flushSource, /flushNextTerminalRestoreBufferedOutput\(\{/u,
    'TerminalView must use the production-tested ownership helper');
  assert.match(flushSource, /onSettled\?\.\(false\)/u,
    'a hard-bound rejection must propagate an explicit false result');
  assert.doesNotMatch(flushSource, /clearBufferedOutput\(/u,
    'a failed admission must not silently discard the restore buffer');
});

test('REL-BGSTAB-010 restore-buffer ownership helper commits once and fails closed on identity mismatch', () => {
  const flushNext = (terminalOutputSchedulerModule as unknown as {
    flushNextTerminalRestoreBufferedOutput: (options: {
      peek: () => string | undefined;
      commit: (expected: string) => boolean;
      write: (data: string, onWritten: () => void, onRejected: () => void) => boolean;
      onWritten: () => void;
      onSettled: (success: boolean) => void;
    }) => boolean;
  }).flushNextTerminalRestoreBufferedOutput;
  const retained = ['first', 'second'];
  const settlements: boolean[] = [];
  let written = 0;
  let lateReject: (() => void) | null = null;

  assert.equal(flushNext({
    peek: () => retained[0],
    commit: expected => retained[0] === expected && retained.shift() === expected,
    write: (_data, onWritten, onRejected) => {
      lateReject = onRejected;
      onWritten();
      return true;
    },
    onWritten: () => { written += 1; },
    onSettled: success => settlements.push(success),
  }), true);
  lateReject?.();
  assert.deepEqual({ retained, written, settlements }, {
    retained: ['second'],
    written: 1,
    settlements: [true],
  });

  assert.equal(flushNext({
    peek: () => retained[0],
    commit: () => false,
    write: (_data, onWritten) => {
      onWritten();
      return true;
    },
    onWritten: () => { written += 1; },
    onSettled: success => settlements.push(success),
  }), false, 'a synchronous commit mismatch must not be returned as accepted');
  assert.deepEqual({ retained, written, settlements }, {
    retained: ['second'],
    written: 1,
    settlements: [true, false],
  });
});

test('REL-BGSTAB-010 restore-buffer helper waits for actual legacy callback and rejects contradictory sync admission', () => {
  const flushNext = terminalOutputSchedulerModule.flushNextTerminalRestoreBufferedOutput;
  const retained = [{ id: 1, data: 'candidate-to-legacy' }];
  let actualLegacyWritten: (() => void) | null = null;
  const settlements: boolean[] = [];

  assert.equal(flushNext({
    peek: () => retained[0],
    getData: entry => entry.data,
    commit: expected => retained[0] === expected && retained.shift() === expected,
    write: (_data, onWritten) => {
      actualLegacyWritten = onWritten;
      return true;
    },
    onWritten: () => {},
    onSettled: success => settlements.push(success),
  }), true);
  assert.equal(retained.length, 1, 'candidate-to-legacy admission alone must not commit the restore entry');
  actualLegacyWritten?.();
  assert.deepEqual({ retained, settlements }, { retained: [], settlements: [true] });

  const rejected = [{ id: 2, data: 'contradictory' }];
  assert.equal(flushNext({
    peek: () => rejected[0],
    getData: entry => entry.data,
    commit: expected => rejected[0] === expected && rejected.shift() === expected,
    write: (_data, _onWritten, onRejected) => {
      onRejected();
      return true;
    },
    onWritten: () => assert.fail('sync rejection must not report written'),
    onSettled: success => settlements.push(success),
  }), false);
  assert.deepEqual(rejected, [{ id: 2, data: 'contradictory' }]);
  assert.deepEqual(settlements, [true, false]);
});

test('REL-BGSTAB-010 restore attempt identity fences a superseded identical-string callback', () => {
  const flushNext = terminalOutputSchedulerModule.flushNextTerminalRestoreBufferedOutput;
  const oldEntry = { id: 1, data: 'same' };
  const newEntry = { id: 2, data: 'same' };
  let retained = [oldEntry];
  let attemptEpoch = 1;
  let oldWritten: (() => void) | null = null;
  const settlements: string[] = [];

  flushNext({
    peek: () => retained[0],
    getData: entry => entry.data,
    commit: expected => retained[0] === expected && retained.shift() === expected,
    isCurrent: () => attemptEpoch === 1,
    write: (_data, onWritten) => {
      oldWritten = onWritten;
      return true;
    },
    onWritten: () => settlements.push('old-written'),
    onSettled: success => settlements.push(`old:${success}`),
  });

  attemptEpoch = 2;
  retained = [newEntry];
  oldWritten?.();
  assert.deepEqual(retained, [newEntry], 'late old callback must not commit a new entry with equal text');
  assert.deepEqual(settlements, []);
});

test('REL-BGSTAB-010 restore release is single-flight per attempt and supersedes exactly once', async () => {
  const gate = terminalOutputSchedulerModule.createTerminalRestoreReleaseSingleFlight();
  let starts = 0;
  let settleEpochOne: ((success: boolean) => void) | null = null;
  const first = gate.run(1, settle => {
    starts += 1;
    settleEpochOne = settle;
  });
  const duplicate = gate.run(1, () => {
    starts += 1;
  });
  assert.equal(first, duplicate);
  assert.equal(starts, 1);
  assert.equal(gate.getActiveEpoch(), 1);

  let settleEpochTwo: ((success: boolean) => void) | null = null;
  const second = gate.run(2, settle => {
    starts += 1;
    settleEpochTwo = settle;
  });
  assert.equal(await first, false);
  settleEpochOne?.(true);
  assert.equal(gate.getActiveEpoch(), 2);
  settleEpochTwo?.(true);
  assert.equal(await second, true);
  assert.equal(gate.getActiveEpoch(), null);
  assert.equal(starts, 2);
});

test('REL-BGSTAB-010 authoritative coverage proves sequence, replay token, and failed-attempt ownership', () => {
  const createTransaction = terminalOutputSchedulerModule.createTerminalRestoreHeldOutputCoverageTransaction;
  const entries = [
    { id: 1, data: 'covered', screenSeq: 10, replayToken: 'replay-a', connectionGeneration: 1, attemptEpoch: 7 },
    { id: 2, data: 'after-snapshot', screenSeq: 11, replayToken: 'replay-a', connectionGeneration: 1, attemptEpoch: 7 },
    { id: 3, data: 'new-attempt', screenSeq: 10, replayToken: 'replay-a', connectionGeneration: 1, attemptEpoch: 8 },
  ];
  const transaction = createTransaction({
    entries,
    failedAttemptEpochs: [7],
    snapshotSeq: 10,
    coversThroughSeq: 10,
    replayToken: 'replay-a',
    connectionGeneration: 1,
  });

  assert.deepEqual(transaction.covered, [entries[0]]);
  assert.deepEqual(
    transaction.remaining,
    [entries[1]],
    'only a matching-token seq 11 entry is provably after a seq 10 checkpoint',
  );
  assert.deepEqual(transaction.unproven, [entries[2]], 'another attempt epoch cannot be covered by failed-epoch proof');

  const tokenMismatch = createTransaction({
    entries: [entries[0]],
    failedAttemptEpochs: [7],
    snapshotSeq: 10,
    coversThroughSeq: 10,
    replayToken: 'replay-b',
    connectionGeneration: 1,
  });
  assert.deepEqual(tokenMismatch.covered, []);
  assert.deepEqual(tokenMismatch.remaining, []);
  assert.deepEqual(tokenMismatch.unproven, [entries[0]]);

  const missingIdentity = createTransaction({
    entries: [{ id: 4, data: 'unknown-token', screenSeq: 9, attemptEpoch: 7 }],
    failedAttemptEpochs: [7],
    snapshotSeq: 10,
    coversThroughSeq: 10,
    replayToken: 'replay-a',
    connectionGeneration: 1,
  });
  assert.deepEqual(missingIdentity.covered, []);
  assert.deepEqual(missingIdentity.remaining, []);
  assert.equal(missingIdentity.unproven.length, 1, 'unknown replay identity is neither covered nor provably post-checkpoint');
});

test('REL-BGSTAB-010 stable server authority covers tokenless normal live output across replacement connections', () => {
  const live = {
    id: 1,
    data: 'normal-live',
    screenSeq: 10,
    authorityEpoch: 'authority-a',
    authorityRevision: 10,
    connectionGeneration: 1,
    attemptEpoch: 7,
  };
  const transaction = terminalOutputSchedulerModule.createTerminalRestoreHeldOutputCoverageTransaction({
    entries: [live],
    failedAttemptEpochs: [7],
    snapshotSeq: 10,
    coversThroughSeq: 10,
    replayToken: 'R2',
    authorityEpoch: 'authority-a',
    authorityRevision: 10,
    connectionGeneration: 2,
  });

  assert.deepEqual(transaction.covered, [live]);
  assert.deepEqual(transaction.remaining, []);
  assert.deepEqual(transaction.unproven, []);

  const mismatchedFutureConnection = terminalOutputSchedulerModule.createTerminalRestoreHeldOutputCoverageTransaction({
    entries: [{ ...live, connectionGeneration: 3 }],
    failedAttemptEpochs: [7],
    snapshotSeq: 10,
    coversThroughSeq: 10,
    replayToken: 'R2',
    authorityEpoch: 'authority-a',
    authorityRevision: 10,
    connectionGeneration: 2,
  });
  assert.equal(mismatchedFutureConnection.unproven.length, 1);

  const staleCheckpoint = terminalOutputSchedulerModule.createTerminalRestoreHeldOutputCoverageTransaction({
    entries: [live],
    failedAttemptEpochs: [7],
    snapshotSeq: 10,
    coversThroughSeq: 10,
    minimumSnapshotSeq: 11,
    replayToken: 'R2',
    authorityEpoch: 'authority-a',
    authorityRevision: 10,
    connectionGeneration: 2,
  });
  assert.deepEqual(staleCheckpoint.unproven, [live]);

  const mismatchedAuthority = terminalOutputSchedulerModule.createTerminalRestoreHeldOutputCoverageTransaction({
    entries: [live],
    failedAttemptEpochs: [7],
    snapshotSeq: 10,
    coversThroughSeq: 10,
    replayToken: 'R2',
    authorityEpoch: 'authority-b',
    authorityRevision: 10,
    connectionGeneration: 2,
  });
  assert.deepEqual(mismatchedAuthority.unproven, [live]);

  const lowerAuthorityRevision = terminalOutputSchedulerModule.createTerminalRestoreHeldOutputCoverageTransaction({
    entries: [live],
    failedAttemptEpochs: [7],
    snapshotSeq: 10,
    coversThroughSeq: 10,
    replayToken: 'R2',
    authorityEpoch: 'authority-a',
    authorityRevision: 9,
    connectionGeneration: 2,
  });
  assert.deepEqual(lowerAuthorityRevision.unproven, [live]);
});

test('REL-BGSTAB-010 authoritative coverage rollback restores exact ownership after partial drain', () => {
  const createTransaction = terminalOutputSchedulerModule.createTerminalRestoreHeldOutputCoverageTransaction;
  const covered = { id: 1, data: 'same', screenSeq: 10, replayToken: 'replay-a', connectionGeneration: 1, attemptEpoch: 7 };
  const retained = { id: 2, data: 'same', screenSeq: 11, replayToken: 'replay-a', connectionGeneration: 1, attemptEpoch: 7 };
  const appended = { id: 3, data: 'later', screenSeq: 12, replayToken: 'replay-a', connectionGeneration: 1, attemptEpoch: 8 };
  const transaction = createTransaction({
    entries: [covered, retained],
    failedAttemptEpochs: [7],
    snapshotSeq: 10,
    coversThroughSeq: 10,
    replayToken: 'replay-a',
    connectionGeneration: 1,
  });

  transaction.recordDrained(retained);
  assert.deepEqual(
    transaction.rollback([appended]),
    [covered, retained, appended],
    'a reset/probe/release failure must restore original and concurrently appended entry identities exactly once',
  );
});

test('REL-BGSTAB-010 rollback provenance allows a fresh checkpoint to complete and ACK', async () => {
  const entryA = { id: 1, data: 'A', screenSeq: 10, replayToken: 'R1', connectionGeneration: 1, attemptEpoch: 7 };
  const entryB = { id: 2, data: 'B', screenSeq: 11, replayToken: 'R1', connectionGeneration: 1, attemptEpoch: 8 };
  const first = terminalOutputSchedulerModule.createTerminalRestoreHeldOutputCoverageTransaction({
    entries: [entryA, entryB],
    failedAttemptEpochs: [7],
    snapshotSeq: 10,
    coversThroughSeq: 10,
    replayToken: 'R1',
    connectionGeneration: 1,
  });
  let held = [...first.remaining];
  let firstSettled: boolean | null = null;
  terminalOutputSchedulerModule.flushNextTerminalRestoreBufferedOutput({
    peek: () => held[0],
    getData: entry => entry.data,
    commit: expected => held[0] === expected && held.shift() === expected,
    write: (_data, _onWritten, onRejected) => {
      onRejected();
      return false;
    },
    onWritten: () => assert.fail('partial drain B is rejected'),
    onSettled: success => { firstSettled = success; },
  });
  assert.equal(firstSettled, false);
  held = [...first.rollback(held)];

  const retryProvenance = [...new Set(held.map(entry => entry.attemptEpoch))];
  const retry = terminalOutputSchedulerModule.createTerminalRestoreHeldOutputCoverageTransaction({
    entries: held,
    failedAttemptEpochs: retryProvenance,
    snapshotSeq: 11,
    coversThroughSeq: 11,
    replayToken: 'R2',
    supersedesReplayToken: 'R1',
    connectionGeneration: 1,
  });
  assert.deepEqual(retry.unproven, []);
  assert.deepEqual(retry.remaining, []);
  assert.deepEqual(retry.covered, [entryA, entryB]);

  let acked = false;
  const release = terminalOutputSchedulerModule.createTerminalRestoreReleaseSingleFlight();
  const completed = release.run(9, settle => {
    terminalOutputSchedulerModule.flushNextTerminalRestoreBufferedOutput({
      peek: () => retry.remaining[0],
      getData: entry => entry.data,
      commit: () => false,
      write: () => false,
      onWritten: () => assert.fail('fresh seq 11 checkpoint covers both held entries'),
      onSettled: success => {
        if (success) {
          retry.commit();
          acked = true;
        }
        settle(success);
      },
    });
  });
  assert.equal(await completed, true);
  assert.equal(acked, true);
});

test('REL-BGSTAB-010 delayed same-data restore A cannot release or drain restore B', async () => {
  const term = {};
  const attemptA = { attemptEpoch: 1, term };
  const attemptB = { attemptEpoch: 2, term };
  let current = {
    attemptEpoch: 1,
    term,
    restorePending: true,
    disposed: false,
  };
  const entryA = { id: 1, data: 'same' };
  const entryB = { id: 2, data: 'same' };
  let retained = [entryA];
  const writes: number[] = [];
  const release = terminalOutputSchedulerModule.createTerminalRestoreReleaseSingleFlight();

  const completeReplay = (
    attempt: typeof attemptA,
    entry: typeof entryA,
  ): Promise<boolean> => {
    if (!terminalOutputSchedulerModule.isTerminalRestoreAttemptCurrent(attempt, current)) {
      return Promise.resolve(false);
    }
    return release.run(attempt.attemptEpoch, settle => {
      terminalOutputSchedulerModule.flushNextTerminalRestoreBufferedOutput({
        peek: () => retained[0],
        getData: pending => pending.data,
        commit: expected => retained[0] === expected && retained.shift() === expected,
        isCurrent: () => terminalOutputSchedulerModule.isTerminalRestoreAttemptCurrent(attempt, current),
        write: (_data, onWritten) => {
          writes.push(entry.id);
          onWritten();
          return true;
        },
        onWritten: () => {},
        onSettled: settle,
      });
    });
  };

  current = { ...current, attemptEpoch: 2 };
  retained = [entryB];
  assert.equal(await completeReplay(attemptA, entryA), false);
  assert.deepEqual(retained, [entryB]);
  assert.deepEqual(writes, []);

  assert.equal(await completeReplay(attemptB, entryB), true);
  assert.deepEqual(retained, []);
  assert.deepEqual(writes, [2]);
});

test('terminal output scheduler reset fences a queued animation-frame callback before remount', () => {
  const scheduled: Array<() => void> = [];
  const writes: string[] = [];
  const scheduler = createTerminalOutputScheduler({
    visibleOutputQueueMaxBytes: 1024,
    visibleOutputMaxChunks: 16,
    visibleFlushBudgetBytes: 64,
    write: data => writes.push(typeof data === 'string' ? data : new TextDecoder().decode(data)),
    schedule: drain => scheduled.push(drain),
  });

  scheduler.enqueue('disposed-terminal');
  const staleFrame = scheduled.shift();
  scheduler.reset('terminal-disposed');
  staleFrame?.();

  assert.deepEqual(writes, [], 'a queued frame must not write into the disposed xterm instance');
  assert.equal(scheduler.isIdle(), true);
});

test('terminal output scheduler yields a flush turn while browser input is pending', async () => {
  const writes: SchedulerWriteChunk[] = [];
  const scheduled: Array<() => void> = [];
  let inputPending = true;
  const scheduler = createTerminalOutputScheduler({
    visibleOutputQueueMaxBytes: 1024,
    visibleOutputMaxChunks: 16,
    visibleFlushBudgetBytes: 4,
    write: (data, onWritten) => {
      writes.push(data);
      onWritten();
    },
    schedule: (drain) => {
      scheduled.push(drain);
    },
    shouldYield: () => inputPending,
  });

  scheduler.enqueue('abcd');
  scheduled.shift()?.();

  assert.deepEqual(writes, []);
  assert.equal(scheduler.isIdle(), false);

  inputPending = false;
  scheduled.shift()?.();

  assert.deepEqual(writes.map(decodeWriteChunk), ['abcd']);
  assert.equal(scheduler.isIdle(), true);
});

test('terminal output scheduler still makes progress when browser input stays pending', async () => {
  const writes: SchedulerWriteChunk[] = [];
  const scheduled: Array<() => void> = [];
  const scheduler = createTerminalOutputScheduler({
    visibleOutputQueueMaxBytes: 1024,
    visibleOutputMaxChunks: 16,
    visibleFlushBudgetBytes: 4,
    write: (data, onWritten) => {
      writes.push(data);
      onWritten();
    },
    schedule: (drain) => {
      scheduled.push(drain);
    },
    shouldYield: () => true,
  });

  scheduler.enqueue('abcdefgh');
  scheduled.shift()?.();
  assert.deepEqual(writes, []);

  scheduled.shift()?.();
  assert.deepEqual(writes.map(decodeWriteChunk), ['abcd']);

  scheduled.shift()?.();
  assert.deepEqual(writes.map(decodeWriteChunk), ['abcd']);

  scheduled.shift()?.();
  assert.deepEqual(writes.map(decodeWriteChunk), ['abcd', 'efgh']);
  assert.equal(scheduler.isIdle(), true);
});

test('terminal output scheduler drains multiple chunks in one frame until the frame time budget is reached', async () => {
  const writes: SchedulerWriteChunk[] = [];
  const scheduled: Array<() => void> = [];
  let now = 0;
  const scheduler = createTerminalOutputScheduler({
    visibleOutputQueueMaxBytes: 1024,
    visibleOutputMaxChunks: 16,
    visibleFlushBudgetBytes: 4,
    visibleFlushFrameBudgetMs: 7,
    write: (data, onWritten) => {
      writes.push(data);
      now += 3;
      onWritten();
    },
    schedule: (drain) => {
      scheduled.push(drain);
    },
    now: () => now,
  });

  scheduler.enqueue('abcd');
  scheduler.enqueue('efgh');
  scheduler.enqueue('ijkl');
  scheduler.enqueue('mnop');
  scheduled.shift()?.();

  assert.deepEqual(writes.map(decodeWriteChunk), ['abcd', 'efgh', 'ijkl']);
  assert.equal(scheduler.isIdle(), false);

  scheduled.shift()?.();

  assert.deepEqual(writes.map(decodeWriteChunk), ['abcd', 'efgh', 'ijkl', 'mnop']);
  assert.equal(scheduler.isIdle(), true);
});

test('terminal output scheduler yields the current frame when input becomes pending during a multi-chunk drain', async () => {
  const writes: SchedulerWriteChunk[] = [];
  const scheduled: Array<() => void> = [];
  let inputPending = false;
  const scheduler = createTerminalOutputScheduler({
    visibleOutputQueueMaxBytes: 1024,
    visibleOutputMaxChunks: 16,
    visibleFlushBudgetBytes: 4,
    visibleFlushFrameBudgetMs: 7,
    write: (data, onWritten) => {
      writes.push(data);
      inputPending = true;
      onWritten();
    },
    schedule: (drain) => {
      scheduled.push(drain);
    },
    shouldYield: () => inputPending,
  });

  scheduler.enqueue('abcd');
  scheduler.enqueue('efgh');
  scheduled.shift()?.();

  assert.deepEqual(writes.map(decodeWriteChunk), ['abcd']);
  assert.equal(scheduler.isIdle(), false);

  inputPending = false;
  scheduled.shift()?.();

  assert.deepEqual(writes.map(decodeWriteChunk), ['abcd', 'efgh']);
  assert.equal(scheduler.isIdle(), true);
});

test('terminal output scheduler exposes a default frame time budget in the 6-8ms range', () => {
  assert.equal(DEFAULT_VISIBLE_FLUSH_FRAME_BUDGET_MS >= 6, true);
  assert.equal(DEFAULT_VISIBLE_FLUSH_FRAME_BUDGET_MS <= 8, true);
});

test('terminal output scheduler retires a lost in-flight write only after FIFO proof', () => {
  const scheduled: Array<() => void> = [];
  const completions: Array<() => void> = [];
  const writes: SchedulerWriteChunk[] = [];
  const callbacks: string[] = [];
  const scheduler = createTerminalOutputScheduler({
    visibleOutputQueueMaxBytes: 1024,
    visibleOutputMaxChunks: 16,
    visibleFlushBudgetBytes: 64,
    write: (data, onWritten) => {
      writes.push(data);
      completions.push(onWritten);
    },
    schedule: drain => scheduled.push(drain),
  });

  scheduler.enqueue('stuck', () => callbacks.push('stuck'));
  scheduled.shift()?.();
  assert.equal(scheduler.isIdle(), false);
  scheduler.enqueue('queued', () => callbacks.push('queued'));
  scheduled.shift()?.();

  const probeIdentity = scheduler.captureFifoProbeIdentity();
  assert.notEqual(probeIdentity, null);
  assert.equal(scheduler.settleFifoProbe(probeIdentity!), 'retired');
  scheduled.shift()?.();
  completions[1]?.();
  scheduler.enqueue('fresh', () => callbacks.push('fresh'));
  scheduled.shift()?.();
  completions[2]?.();
  completions[0]?.();

  assert.deepEqual(writes.map(decodeWriteChunk), ['stuck', 'queued', 'fresh']);
  assert.deepEqual(callbacks, ['stuck', 'queued', 'fresh']);
  assert.equal(scheduler.isIdle(), true);
});

test('terminal output FIFO proof never retires a newer active write', () => {
  const scheduled: Array<() => void> = [];
  const completions: Array<() => void> = [];
  const writes: SchedulerWriteChunk[] = [];
  const callbacks: string[] = [];
  const scheduler = createTerminalOutputScheduler({
    visibleOutputQueueMaxBytes: 1024,
    visibleOutputMaxChunks: 16,
    visibleFlushBudgetBytes: 64,
    write: (data, onWritten) => {
      writes.push(data);
      completions.push(onWritten);
    },
    schedule: drain => scheduled.push(drain),
  });

  scheduler.enqueue('A', () => callbacks.push('A'));
  scheduled.shift()?.();
  scheduler.enqueue('B', () => callbacks.push('B'));
  scheduled.shift()?.();
  const probeIdentity = scheduler.captureFifoProbeIdentity();
  assert.notEqual(probeIdentity, null);

  completions[0]?.();
  assert.deepEqual(writes.map(decodeWriteChunk), ['A', 'B']);
  assert.deepEqual(callbacks, ['A']);
  assert.equal(scheduler.settleFifoProbe(probeIdentity!), 'advanced');
  assert.deepEqual(callbacks, ['A']);
  assert.equal(scheduler.isIdle(), false);

  completions[1]?.();
  assert.deepEqual(callbacks, ['A', 'B']);
  assert.equal(scheduler.isIdle(), true);
});

const noRenderFixtureModuleUrl = new URL('../benchmarks/terminalNoRenderFixture.ts', import.meta.url);

interface NoRenderFixtureContract {
  runNoRenderFixture(input: { ingress: string[] }): Promise<{
    mode: {
      id: string;
      disabledLayers: string[];
      replacedLayers: string[];
      retainedLayers: string[];
      controlComparator: string;
      fixture: string;
    };
    ingressDigest: string;
    control: {
      ingressDigest: string;
      rendererWriteCount: number;
      writeConsumerInvocationCount: number;
      output: string;
    };
    observation: {
      ingressDigest: string;
      rendererWriteCount: number;
      accountingConsumerInvocationCount: number;
      consumedBytes: number;
    };
  }>;
}

async function loadNoRenderFixture(failureSignature: string): Promise<NoRenderFixtureContract> {
  try {
    return await import(noRenderFixtureModuleUrl.href) as NoRenderFixtureContract;
  } catch (error) {
    throw new Error(failureSignature, { cause: error });
  }
}

async function assertNoRenderModeDescriptor(contract: NoRenderFixtureContract): Promise<void> {
  const result = await contract.runNoRenderFixture({ ingress: ['prompt> ', '한글', 'e\u0301', '🙂'] });
  assert.equal(result.mode.id, 'NO_RENDER');
  assert.deepEqual(result.mode.disabledLayers, ['terminal-renderer']);
  assert.deepEqual(result.mode.replacedLayers, ['terminal-write-consumer->benchmark-accounting-sink']);
  assert.deepEqual(result.mode.retainedLayers, ['utf8-ingress', 'terminal-output-scheduler', 'queue-accounting']);
  assert.equal(result.mode.controlComparator, 'CONTROL_RENDER');
  assert.equal(result.mode.fixture, 'injected-terminal-write-consumer-v1');
}

async function assertNoRenderIngressParity(contract: NoRenderFixtureContract): Promise<void> {
  const result = await contract.runNoRenderFixture({ ingress: ['alpha', '한글', '\u001b[31mred\u001b[0m'] });
  assert.equal(result.control.ingressDigest, result.ingressDigest);
  assert.equal(result.observation.ingressDigest, result.ingressDigest);
  assert.equal(result.control.ingressDigest, result.observation.ingressDigest);
  assert.equal(result.control.rendererWriteCount > 0, true);
  assert.equal(result.control.writeConsumerInvocationCount, result.control.rendererWriteCount);
  assert.equal(result.observation.rendererWriteCount, 0);
  assert.equal(result.observation.accountingConsumerInvocationCount > 0, true);
  assert.equal(result.observation.consumedBytes, Buffer.byteLength(result.control.output, 'utf8'));
}

async function assertNoRenderBoundaryCases(contract: NoRenderFixtureContract): Promise<void> {
  await assert.rejects(() => contract.runNoRenderFixture({ ingress: [] }), /at least one UTF-8 byte/i);
  await assert.rejects(() => contract.runNoRenderFixture({ ingress: ['', ''] }), /each contain at least one UTF-8 byte/i);
  await assert.rejects(() => contract.runNoRenderFixture({ ingress: ['', 'a'] }), /each contain at least one UTF-8 byte/i);
  await assert.rejects(() => contract.runNoRenderFixture({ ingress: ['a', ''] }), /each contain at least one UTF-8 byte/i);
  const boundary = await contract.runNoRenderFixture({
    ingress: [`${'a'.repeat(64 * 1024 - 1)}한🙂`],
  });
  assert.equal(boundary.control.ingressDigest, boundary.ingressDigest);
  assert.equal(boundary.observation.ingressDigest, boundary.ingressDigest);
  assert.equal(boundary.observation.rendererWriteCount, 0);
  assert.equal(boundary.observation.consumedBytes, 64 * 1024 - 1 + 3 + 4);
  assert.equal(boundary.control.writeConsumerInvocationCount, 2);
  assert.equal(boundary.observation.accountingConsumerInvocationCount, 2);
}

test('PERF-BGSTAB-008 AC-1 RED contract', async () => {
  const fixture = await loadNoRenderFixture('PERF-BGSTAB-008 AC-1 contract not implemented');
  await assertNoRenderModeDescriptor(fixture);
});

test('PERF-BGSTAB-008 AC-2 RED contract', async () => {
  const fixture = await loadNoRenderFixture('PERF-BGSTAB-008 AC-2 contract not implemented');
  await assertNoRenderIngressParity(fixture);
});

test('PERF-BGSTAB-008 AC-1 GREEN contract', async () => {
  const fixture = await loadNoRenderFixture('PERF-BGSTAB-008 AC-1 contract not implemented');
  await assertNoRenderModeDescriptor(fixture);
});

test('PERF-BGSTAB-008 AC-2 GREEN contract', async () => {
  const fixture = await loadNoRenderFixture('PERF-BGSTAB-008 AC-2 contract not implemented');
  await assertNoRenderIngressParity(fixture);
  await assertNoRenderBoundaryCases(fixture);
});

type SchedulerWriteChunk = string | Uint8Array;

type SchedulerOptionsWithEncoder = Parameters<typeof createTerminalOutputScheduler>[0] & {
  textEncoder: Pick<TextEncoder, 'encode'>;
};

function encodeWriteChunk(chunk: SchedulerWriteChunk): Uint8Array {
  return typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk;
}

function decodeWriteChunk(chunk: SchedulerWriteChunk): string {
  return typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
}

function concatenateWriteBytes(chunks: SchedulerWriteChunk[]): Uint8Array {
  const encoded = chunks.map(encodeWriteChunk);
  const byteLength = encoded.reduce((total, chunk) => total + chunk.byteLength, 0);
  const result = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of encoded) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function assertDeliveredBytes(chunks: SchedulerWriteChunk[], ingress: string[]): void {
  const expected = concatenateWriteBytes(ingress);
  assert.deepEqual(concatenateWriteBytes(chunks), expected);
}

interface TerminalParserSnapshot {
  lines: Array<{
    text: string;
    isWrapped: boolean;
    cells: Array<{
      chars: string;
      width: number;
      code: number;
      fgColorMode: number;
      bgColorMode: number;
      fgColor: number;
      bgColor: number;
      bold: number;
      italic: number;
      dim: number;
      underline: number;
      blink: number;
      inverse: number;
      invisible: number;
      strikethrough: number;
      overline: number;
    } | null>;
  }>;
  cursorX: number;
  cursorY: number;
  baseY: number;
  viewportY: number;
  length: number;
  titleEvents: string[];
  finalTitle: string | null;
}

async function writeTerminalChunk(
  terminal: import('@xterm/xterm').Terminal,
  data: SchedulerWriteChunk,
): Promise<void> {
  await new Promise<void>((resolve) => terminal.write(data, resolve));
}

function captureTerminalParserSnapshot(
  terminal: import('@xterm/xterm').Terminal,
  titleEvents: string[],
): TerminalParserSnapshot {
  const buffer = terminal.buffer.active;
  const lines: TerminalParserSnapshot['lines'] = [];
  for (let index = 0; index < buffer.length; index += 1) {
    const line = buffer.getLine(index);
    const cells: TerminalParserSnapshot['lines'][number]['cells'] = [];
    for (let column = 0; column < terminal.cols; column += 1) {
      const cell = line?.getCell(column);
      cells.push(cell
        ? {
            chars: cell.getChars(),
            width: cell.getWidth(),
            code: cell.getCode(),
            fgColorMode: cell.getFgColorMode(),
            bgColorMode: cell.getBgColorMode(),
            fgColor: cell.getFgColor(),
            bgColor: cell.getBgColor(),
            bold: cell.isBold(),
            italic: cell.isItalic(),
            dim: cell.isDim(),
            underline: cell.isUnderline(),
            blink: cell.isBlink(),
            inverse: cell.isInverse(),
            invisible: cell.isInvisible(),
            strikethrough: cell.isStrikethrough(),
            overline: cell.isOverline(),
          }
        : null);
    }
    lines.push({
      text: line?.translateToString(false) ?? '',
      isWrapped: line?.isWrapped ?? false,
      cells,
    });
  }
  return {
    lines,
    cursorX: buffer.cursorX,
    cursorY: buffer.cursorY,
    baseY: buffer.baseY,
    viewportY: buffer.viewportY,
    length: buffer.length,
    titleEvents: [...titleEvents],
    finalTitle: titleEvents.at(-1) ?? null,
  };
}

test('UTF-8 segmented queue RED 계약 — AC-1', () => {
  const encodeInputs: string[] = [];
  const nativeEncoder = new TextEncoder();
  const options: SchedulerOptionsWithEncoder = {
    visibleOutputQueueMaxBytes: 1024,
    visibleOutputMaxChunks: 16,
    visibleFlushBudgetBytes: 4,
    textEncoder: {
      encode(value = '') {
        encodeInputs.push(value);
        return nativeEncoder.encode(value);
      },
    },
    write: (_data, onWritten) => onWritten(),
    schedule: (drain) => drain(),
  };
  const scheduler = createTerminalOutputScheduler(options);

  scheduler.enqueue('A한🙂Z');

  assert.deepEqual(
    encodeInputs,
    ['A한🙂Z'],
    'UTF-8 segmented queue RED AC-1: accepted ingress encode must be exactly once and prefix-loop encode must be zero',
  );
});

test('UTF-8 segmented queue RED 계약 — AC-2', async () => {
  const corpus = [
    'ASCII',
    '한글',
    'e\u0301',
    '가\u200d🙂',
    '\u001b[31mred\u001b[0m',
    '\ud83d',
    '\ude42',
  ];
  const writes: SchedulerWriteChunk[] = [];
  const scheduler = createTerminalOutputScheduler({
    visibleOutputQueueMaxBytes: 4096,
    visibleOutputMaxChunks: 32,
    visibleFlushBudgetBytes: 5,
    write: (data, onWritten) => {
      writes.push(data);
      onWritten();
    },
    schedule: (drain) => drain(),
  });

  for (const chunk of corpus) {
    assert.deepEqual(scheduler.enqueue(chunk), { ok: true });
  }

  assertDeliveredBytes(writes, corpus);

  const splitAnsiIngress = [
    'line-1\r\n',
    '\u001b',
    '[1;2;3;4;5;7;8;9;53;38;2;12;34;56;48;5;123',
    'mSTYLE',
    '\u001b[0',
    'm',
    '\r',
    '\nline-3',
    '\u001b[2',
    'D!',
    '\u001b]0;split',
    '-title\u0007',
    '한',
    'e\u0301',
    '🙂',
  ];
  const splitWrites: SchedulerWriteChunk[] = [];
  const splitScheduler = createTerminalOutputScheduler({
    visibleOutputQueueMaxBytes: 4096,
    visibleOutputMaxChunks: 32,
    visibleFlushBudgetBytes: 3,
    write: (data, onWritten) => {
      splitWrites.push(data);
      onWritten();
    },
    schedule: (drain) => drain(),
  });

  for (const chunk of splitAnsiIngress) {
    assert.deepEqual(splitScheduler.enqueue(chunk), { ok: true });
  }
  assertDeliveredBytes(splitWrites, splitAnsiIngress);

  const xtermModule = await import('@xterm/xterm');
  const { Terminal } = (
    'Terminal' in xtermModule
      ? xtermModule
      : xtermModule.default
  ) as typeof import('@xterm/xterm');
  const controlTerminal = new Terminal({ cols: 12, rows: 4, scrollback: 8 });
  const schedulerTerminal = new Terminal({ cols: 12, rows: 4, scrollback: 8 });
  const controlTitleEvents: string[] = [];
  const schedulerTitleEvents: string[] = [];
  const controlTitleSubscription = controlTerminal.onTitleChange(title => controlTitleEvents.push(title));
  const schedulerTitleSubscription = schedulerTerminal.onTitleChange(title => schedulerTitleEvents.push(title));
  try {
    await writeTerminalChunk(controlTerminal, splitAnsiIngress.join(''));
    for (const chunk of splitWrites) {
      await writeTerminalChunk(schedulerTerminal, chunk);
    }

    assert.deepEqual(
      captureTerminalParserSnapshot(schedulerTerminal, schedulerTitleEvents),
      captureTerminalParserSnapshot(controlTerminal, controlTitleEvents),
      'UTF-8 segmented queue RED AC-2: split ANSI/OSC ingress must preserve xterm cells, styles, title events, buffer, and cursor/base state relative to an unsplit control write',
    );
    assert.deepEqual(schedulerTitleEvents, ['split-title']);
  } finally {
    controlTitleSubscription.dispose();
    schedulerTitleSubscription.dispose();
    controlTerminal.dispose();
    schedulerTerminal.dispose();
  }
});

test('UTF-8 segmented queue RED 계약 — AC-3', () => {
  const writes: SchedulerWriteChunk[] = [];
  const ingress = 'A🙂한B';
  const scheduler = createTerminalOutputScheduler({
    visibleOutputQueueMaxBytes: 1024,
    visibleOutputMaxChunks: 16,
    visibleFlushBudgetBytes: 5,
    write: (data, onWritten) => {
      writes.push(data);
      onWritten();
    },
    schedule: (drain) => drain(),
  });

  scheduler.enqueue(ingress);

  assert.equal(
    writes.every(chunk => chunk instanceof Uint8Array),
    true,
    'UTF-8 segmented queue RED AC-3: scheduler writes must use encoded segments/subarrays instead of string prefix copies',
  );
  assert.equal(writes.every(chunk => encodeWriteChunk(chunk).byteLength <= 5), true);
  assertDeliveredBytes(writes, [ingress]);
});

test('UTF-8 segmented queue RED 계약 — AC-4', () => {
  const scheduler = createTerminalOutputScheduler({
    visibleOutputQueueMaxBytes: 1024,
    visibleOutputMaxChunks: 2,
    visibleFlushBudgetBytes: 4,
    write: (_data, onWritten) => onWritten(),
    schedule: () => {},
  });

  assert.deepEqual(scheduler.enqueue('aaa'), { ok: true });
  assert.deepEqual(scheduler.enqueue('bbb'), { ok: true });
  const decision = scheduler.enqueue('ccc');

  assert.deepEqual(
    decision,
    { ok: false, reason: 'visible-output-overflow', droppedBytes: 9 },
    'UTF-8 segmented queue RED AC-4: non-compacting chunk pressure must overflow instead of allocating a full pending join',
  );
  assert.equal(scheduler.pendingBytes(), 0);
  assert.equal(scheduler.isStale(), true);

  const flushBudgetBytes = 4;
  const queueBudgetBytes = 8;
  const writes: Uint8Array[] = [];
  const scheduled: Array<() => void> = [];
  const completions: Array<() => void> = [];
  const callbacks: string[] = [];
  const callbackCounts = new Map<string, number>();
  const compactingScheduler = createTerminalOutputScheduler({
    visibleOutputQueueMaxBytes: queueBudgetBytes,
    visibleOutputMaxChunks: 2,
    visibleFlushBudgetBytes: flushBudgetBytes,
    write: (data, onWritten) => {
      assert.equal(data instanceof Uint8Array, true);
      writes.push(data as Uint8Array);
      completions.push(onWritten);
    },
    schedule: drain => scheduled.push(drain),
  });
  const recordCallback = (label: string): void => {
    callbackCounts.set(label, (callbackCounts.get(label) ?? 0) + 1);
    callbacks.push(label);
  };

  assert.deepEqual(compactingScheduler.enqueue('ab', () => recordCallback('first')), { ok: true });
  assert.equal(compactingScheduler.pendingBytes(), 2);
  assert.deepEqual(compactingScheduler.enqueue('cd', () => recordCallback('second')), { ok: true });
  assert.equal(compactingScheduler.pendingBytes(), 4);
  assert.deepEqual(compactingScheduler.enqueue('e', () => recordCallback('third')), { ok: true });
  assert.equal(compactingScheduler.isStale(), false);
  assert.equal(compactingScheduler.pendingBytes(), 5);
  assert.equal(compactingScheduler.pendingBytes() <= queueBudgetBytes, true);

  scheduled.shift()?.();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].byteLength, 2);
  assert.equal(writes[0].buffer.byteLength <= flushBudgetBytes, true);
  assert.equal(compactingScheduler.pendingBytes(), 3);
  assert.deepEqual(callbacks, []);

  completions.shift()?.();
  assert.deepEqual(callbacks, ['first']);
  assert.equal(writes.length, 2);
  assert.equal(writes[1].byteLength, 2);
  assert.equal(writes[1].buffer.byteLength <= flushBudgetBytes, true);

  completions.shift()?.();
  assert.deepEqual(callbacks, ['first', 'second']);
  assert.equal(writes.length, 3);
  assert.equal(writes[2].byteLength, 1);

  completions.shift()?.();
  assert.deepEqual(callbacks, ['first', 'second', 'third']);
  assert.deepEqual(Object.fromEntries(callbackCounts), { first: 1, second: 1, third: 1 });
  assert.equal(compactingScheduler.pendingBytes(), 0);
  assert.equal(compactingScheduler.isIdle(), true);
});

test('UTF-8 segmented queue RED 계약 — AC-5', () => {
  const writes: SchedulerWriteChunk[] = [];
  const scheduled: Array<() => void> = [];
  const completions: Array<() => void> = [];
  let inputPending = true;
  let activeWrites = 0;
  let maximumActiveWrites = 0;
  const scheduler = createTerminalOutputScheduler({
    visibleOutputQueueMaxBytes: 1024,
    visibleOutputMaxChunks: 16,
    visibleFlushBudgetBytes: 2,
    write: (data, onWritten) => {
      writes.push(data);
      activeWrites += 1;
      maximumActiveWrites = Math.max(maximumActiveWrites, activeWrites);
      completions.push(() => {
        activeWrites -= 1;
        onWritten();
      });
    },
    schedule: drain => scheduled.push(drain),
    shouldYield: () => inputPending,
  });

  scheduler.enqueue('ab');
  scheduler.enqueue('cd');
  scheduled.shift()?.();
  assert.deepEqual(writes, []);

  inputPending = false;
  scheduled.shift()?.();
  assert.equal(writes.length, 1);
  assert.equal(maximumActiveWrites, 1);
  completions.shift()?.();
  assert.equal(writes.length, 2);
  assert.equal(maximumActiveWrites, 1);
  completions.shift()?.();
  assert.equal(scheduler.isIdle(), true);
});

test('UTF-8 segmented queue RED 계약 — AC-6', () => {
  const scheduled: Array<() => void> = [];
  const completions: Array<() => void> = [];
  const callbacks: string[] = [];
  const scheduler = createTerminalOutputScheduler({
    visibleOutputQueueMaxBytes: 8,
    visibleOutputMaxChunks: 8,
    visibleFlushBudgetBytes: 8,
    write: (_data, onWritten) => completions.push(onWritten),
    schedule: drain => scheduled.push(drain),
  });

  scheduler.enqueue('한', () => callbacks.push('old'));
  assert.equal(scheduler.pendingBytes(), 3);
  scheduled.shift()?.();
  scheduler.reset();
  scheduler.enqueue('ok', () => callbacks.push('current'));
  completions.shift()?.();
  scheduled.shift()?.();
  completions.shift()?.();

  assert.deepEqual(callbacks, ['current']);
  assert.equal(scheduler.pendingBytes(), 0);
  assert.equal(scheduler.isIdle(), true);
});

test('UTF-8 segmented queue RED 계약 — AC-7', () => {
  const writes: SchedulerWriteChunk[] = [];
  const scheduler = createTerminalOutputScheduler({
    visibleOutputQueueMaxBytes: 1024,
    visibleOutputMaxChunks: 16,
    visibleFlushBudgetBytes: 64,
    write: (data, onWritten) => {
      writes.push(data);
      onWritten();
    },
    schedule: (drain) => drain(),
  });

  assert.deepEqual(scheduler.enqueue('production ingress remains a string'), { ok: true });
  assert.equal(
    writes[0] instanceof Uint8Array,
    true,
    'UTF-8 segmented queue RED AC-7: scheduler-to-xterm staged writer must accept Uint8Array output',
  );
});

test('UTF-8 segmented queue RED 계약 — AC-10', () => {
  const ingress = 'A🙂B';
  for (const budget of [4, 5, 6]) {
    const writes: SchedulerWriteChunk[] = [];
    const scheduler = createTerminalOutputScheduler({
      visibleOutputQueueMaxBytes: 1024,
      visibleOutputMaxChunks: 16,
      visibleFlushBudgetBytes: budget,
      write: (data, onWritten) => {
        writes.push(data);
        onWritten();
      },
      schedule: (drain) => drain(),
    });

    scheduler.enqueue(ingress);

    assertDeliveredBytes(writes, [ingress]);
    assert.equal(
      writes.every(chunk => encodeWriteChunk(chunk).byteLength <= budget),
      true,
      `UTF-8 segmented queue RED AC-10: N-1/N/N+1 byte budget ${budget} must be respected`,
    );
  }
});

test('FIFO completion barrier is attached to the current boundary, not later output', () => {
  const scheduled: Array<() => void> = [];
  const completions: Array<() => void> = [];
  const events: string[] = [];
  const decoder = new TextDecoder();
  const scheduler = createTerminalOutputScheduler({
    visibleOutputQueueMaxBytes: 1024,
    visibleOutputMaxChunks: 16,
    visibleFlushBudgetBytes: 64,
    write: (data, onWritten) => {
      events.push(`write:${typeof data === 'string' ? data : decoder.decode(data)}`);
      completions.push(onWritten);
    },
    schedule: drain => scheduled.push(drain),
  });

  scheduler.enqueue('before');
  scheduled.shift()?.();
  assert.deepEqual(events, ['write:before']);

  scheduler.enqueueBarrier(() => events.push('barrier'));
  scheduler.enqueue('after');
  completions.shift()?.();

  assert.deepEqual(events, ['write:before', 'barrier', 'write:after']);
  completions.shift()?.();
  assert.equal(scheduler.isIdle(), true);
});

test('chunk compaction never moves a FIFO barrier behind later output', () => {
  const scheduled: Array<() => void> = [];
  const completions: Array<() => void> = [];
  const events: string[] = [];
  const decoder = new TextDecoder();
  const scheduler = createTerminalOutputScheduler({
    visibleOutputQueueMaxBytes: 1024,
    visibleOutputMaxChunks: 2,
    visibleFlushBudgetBytes: 64,
    write: (data, onWritten) => {
      events.push(`write:${typeof data === 'string' ? data : decoder.decode(data)}`);
      completions.push(onWritten);
    },
    schedule: drain => scheduled.push(drain),
  });

  scheduler.enqueue('before');
  scheduler.enqueueBarrier(() => events.push('barrier'));
  scheduler.enqueue('later-1');
  const compacted = scheduler.enqueue('later-2');
  assert.deepEqual(compacted, { ok: true });

  scheduled.shift()?.();
  assert.deepEqual(events, ['write:before']);
  completions.shift()?.();
  assert.deepEqual(events, ['write:before', 'barrier', 'write:later-1']);
  completions.shift()?.();
  assert.deepEqual(events, ['write:before', 'barrier', 'write:later-1', 'write:later-2']);
  completions.shift()?.();
  assert.equal(scheduler.isIdle(), true);
});

test('chunk compaction tracks callback byte offsets even at a one-chunk limit', () => {
  const scheduler = createTerminalOutputScheduler({
    visibleOutputQueueMaxBytes: 1024,
    visibleOutputMaxChunks: 1,
    visibleFlushBudgetBytes: 64,
    write: () => {},
    schedule: () => {},
  });

  scheduler.enqueue('before');
  scheduler.enqueueBarrier(() => {});
  assert.deepEqual(scheduler.enqueue('later'), { ok: true });
  assert.equal(scheduler.pendingBytes(), 11);
  assert.equal(scheduler.isStale(), false);
});

test('PERF-BGSTAB-010 rejects delivery acknowledgement callbacks when the terminal writer rejects a chunk', () => {
  const callbacks: string[] = [];
  const scheduler = createTerminalOutputScheduler({
    visibleOutputQueueMaxBytes: 1024,
    visibleOutputMaxChunks: 16,
    visibleFlushBudgetBytes: 64,
    write: (_data, _onWritten, onRejected) => {
      onRejected();
    },
    schedule: drain => drain(),
  });

  scheduler.enqueue(
    'rejected output',
    () => callbacks.push('written'),
    () => callbacks.push('rejected'),
  );

  assert.deepEqual(callbacks, ['rejected']);
  assert.equal(scheduler.isStale(), true);
});
